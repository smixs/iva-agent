import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  acquireLock,
  atomicWrite,
  isLegacyHistoryReplace,
  mergeCard,
  resolveCard,
  resolveOperation,
} from "../lib/card-store.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { resolveTimeZone } from "../lib/timezone.js";

// Строго типизированная запись карточки памяти. Заменяет «write_file по наитию» для карточек:
// zod-enum на type/status берётся из autograph schema.json (единый источник правды), поэтому
// модель НЕ может выдумать тип или добавить неизвестное поле — вызов упадёт на валидации.
// Ночной enforce.py остаётся backstop'ом для всего, что записалось мимо этого тула.

const VAULT = () => process.env.ASSISTANT_VAULT_DIR || "vault";

// Типы карточек, которые модель создаёт интерактивно (summary-типы пишет ночной rollup, не тул).
const CARD_TYPE_DIR: Record<string, string> = {
  contact: "contacts",
  project: "projects",
  decision: "decisions",
  idea: "ideas",
  note: "notes",
};
const DESC_CAP = 500;

function storedStatus(content: string, fallback: string): string {
  const value = parseFrontmatter(content).fields?.status;
  return typeof value === "string" ? value : fallback;
}

// Границы входа: пробельная пустота даёт карточку без имени/описания, а перевод строки в
// однострочном поле уезжает в frontmatter или в разметку и превращается в новую секцию.
// Оба случая отклоняются на входе, а не «чинятся» молча; нормализация — в execute.
const nonBlank = (label: string) =>
  z
    .string()
    .refine((v) => v.trim().length > 0, `${label} не должен быть пустым`);

const singleLine = (label: string) =>
  nonBlank(label).refine(
    (v) => !/[\r\n]/.test(v),
    `${label} должен быть одной строкой`,
  );

/** lowercase-kebab + дедуп ПОСЛЕ нормализации: «Foo Bar» и « foo-bar » — один тег. */
const normalizeTags = (tags: string[]): string[] => [
  ...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-"))),
];

/**
 * След отброшенного входа: только имена полей, без содержимого карточки — журнал не место
 * для текста, который модель могла нафантазировать. Сбой sink'а (закрытый stderr, EPIPE)
 * гасится: карточка уже записана, и журнал не имеет права превратить успех в отказ.
 */
function logIgnoredHistoryEntry(): void {
  try {
    console.warn(
      JSON.stringify({
        event: "write_card_input_normalized",
        // Вытеснять нечего только у новой карточки, а её создаёт лишь ADD.
        operation: "ADD",
        ignored_field: "history_entry",
      }),
    );
  } catch {
    /* журнал недоступен — на записанную карточку это не влияет */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}

// Схема vault'а: корень vault'а → легаси `.claude`-путь (vault'ы до 0.3.3) → дефолт из репо.
function schemaPath(): string {
  const candidates = [
    join(VAULT(), "schema.json"),
    join(VAULT(), ".claude", "skills", "autograph", "schema.json"),
    join("scripts", "autograph", "schema.example.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

// Читаем схему на старте: валидные статусы per-type + алиасы. Fallback — зашитый минимум,
// чтобы тул не падал, если vault ещё не инициализирован.
function loadSchema(): {
  status: Record<string, string[]>;
  aliases: Record<string, string>;
} {
  const fallback: {
    status: Record<string, string[]>;
    aliases: Record<string, string>;
  } = {
    status: {
      contact: ["active", "inactive"],
      project: ["active", "done", "paused", "cancelled", "draft"],
      decision: ["active", "superseded", "reverted"],
      idea: ["active", "explored", "archived", "draft"],
      note: ["active", "draft", "archived"],
    },
    aliases: {
      person: "contact",
      company: "contact",
      thought: "note",
      proposal: "idea",
    },
  };
  try {
    const raw = readFileSync(schemaPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const nodeTypes = isRecord(parsed.node_types)
      ? parsed.node_types
      : undefined;
    const status: Record<string, string[]> = {};
    for (const t of Object.keys(CARD_TYPE_DIR)) {
      const node = nodeTypes?.[t];
      const configured = isRecord(node)
        ? isStringArray(node.status)
          ? node.status
          : isStringArray(node.statuses)
            ? node.statuses
            : undefined
        : undefined;
      status[t] = configured ?? fallback.status[t] ?? ["active"];
    }
    return {
      status,
      aliases: asStringRecord(parsed.type_aliases) ?? fallback.aliases,
    };
  } catch {
    return fallback;
  }
}

const SCHEMA = loadSchema();
const CARD_TYPES = Object.keys(CARD_TYPE_DIR) as [string, ...string[]];

// Алиасы типов из схемы применяются ДО валидации: описание поля обещает person/company →
// contact, значит z.enum не должен отклонять их раньше execute. Алиасы, ведущие в типы вне
// CARD_TYPE_DIR (daily → daily-summary), не разворачиваются — их пишет ночной rollup.
function normalizeType(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const k = v.trim().toLowerCase();
  if (k in CARD_TYPE_DIR) return k;
  const mapped = SCHEMA.aliases[k];
  return mapped && mapped in CARD_TYPE_DIR ? mapped : k;
}

// Транслитерация не нужна — vault хранит кириллические слаги нормально (см. существующие карточки).
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default defineTool({
  description:
    "Создать или обновить типизированную карточку памяти в vault. Явно выбери " +
    "ADD, UPDATE, SUPERSEDE или NOOP; без operation старые вызовы определяются автоматически. " +
    "Используй ЭТО (не write_file) " +
    "для карточек — гарантирует валидный тип и схему. type строго один из: " +
    Object.keys(CARD_TYPE_DIR).join(", ") +
    ". Поля вне схемы недопустимы. Summary (день/неделя/…) НЕ создавай — их пишет ночной rollup.",
  inputSchema: z.object({
    operation: z
      .enum(["ADD", "UPDATE", "SUPERSEDE", "NOOP"])
      .optional()
      .describe(
        "ADD создаёт новую карточку; UPDATE добавляет непротиворечивый факт в ## Log; " +
          "SUPERSEDE заменяет текущую истину; NOOP ничего не пишет.",
      ),
    type: z
      .preprocess(normalizeType, z.enum(CARD_TYPES))
      .describe(
        "Тип карточки (строго из списка; алиасы вроде person/company → contact применяются автоматически)",
      ),
    title: singleLine("title").describe(
      "Имя/заголовок сущности (пойдёт в имя файла и заголовок)",
    ),
    description: singleLine("description")
      .max(
        DESC_CAP,
        `description слишком длинное: максимум ${DESC_CAP} символов; сократи его и повтори вызов`,
      )
      .describe("Краткая выжимка что/зачем (1–2 фразы, для поиска)"),
    tags: z
      .array(singleLine("tag"))
      .min(1)
      .max(6)
      .describe("2–5 тегов, lowercase-kebab"),
    status: singleLine("status")
      .optional()
      .describe("Статус жизненного цикла (валидируется по типу)"),
    domain: singleLine("domain")
      .optional()
      .describe("Домен (work/personal/…), опционально"),
    related: z
      .array(singleLine("related"))
      .optional()
      .describe("Вики-цели связей [[...]] (vault-пути или слаги), опционально"),
    body: nonBlank("body").describe(
      "Тело карточки в markdown: только факты, без заголовков H1/H2 — заголовок, " +
        "## History, ## Log и ## Related ведёт сам тул и отклоняет их в body",
    ),
    history_entry: z
      .string()
      .optional()
      .describe(
        "ТОЛЬКО для SUPERSEDE: одна строка о прежней истине, переносимая в ## History, " +
          "в формате 'YYYY-MM-DD: факт' (своя дата сохраняется; без неё ставится сегодняшняя). " +
          "На ADD отбрасывается как шум, на UPDATE/NOOP непустое значение — ошибка " +
          "(пустая строка равна отсутствию поля).",
      ),
    confidence: z
      .enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"])
      .optional()
      .describe(
        "EXTRACTED — прямо сказано; INFERRED — выведено; по умолчанию EXTRACTED",
      ),
    replace_body: z
      .boolean()
      .optional()
      .describe(
        "Легаси-путь для вызова БЕЗ operation: заменить body целиком, ## History при этом " +
          "приходит внутри body. С явным operation не нужен — SUPERSEDE и так заменяет body.",
      ),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the established Promise-returning Eve tool contract.
  async execute(input) {
    const {
      operation,
      type,
      body,
      related,
      history_entry,
      confidence,
      replace_body,
    } = input;
    // Схема гарантирует непустоту и однострочность; обрезка — здесь, чтобы в файл не уехали
    // краевые пробелы (они заставили бы квотировать скаляр и сломали бы заголовок).
    // related нормализует mergeRelated, body — mergeCard.
    const title = input.title.trim();
    const description = input.description.trim();
    const status = input.status?.trim();
    const domain = input.domain?.trim();
    const tags = normalizeTags(input.tags);

    // Валидация статуса против схемы типа (жёстко — иначе модель придумает статус).
    const allowed = SCHEMA.status[type] || ["active"];
    if (status && !allowed.includes(status)) {
      return {
        ok: false,
        error: `Недопустимый status "${status}" для type "${type}". Разрешены: ${allowed.join(", ")}.`,
      };
    }

    const dir = join(VAULT(), "cards", CARD_TYPE_DIR[type]);
    // Идентичность: точный слаг → иначе карточка того же типа с таким же H1/name/aliases
    // (легаси-файлы с латинским слагом и кириллическим заголовком).
    const id = resolveCard(dir, title);
    if (id.candidates && id.candidates.length > 1) {
      const list = id.candidates.map((f) =>
        relative(VAULT(), f).split(sep).join("/"),
      );
      return {
        ok: false,
        error:
          `Неоднозначная карточка для "${title}": подходят ${list.length} файлов. ` +
          "Уточни заголовок или обнови нужный файл явно — ничего не записано.",
        candidates: list,
      };
    }
    const file = id.file;
    const rel = relative(VAULT(), file).split(sep).join("/");

    // Пустой/пробельный history_entry ничего не вытесняет и не подделывает архив: для UPDATE
    // и NOOP он равен отсутствующему — так же, как SUPERSEDE читает его через trim(). Модели,
    // заполняющие все поля схемы, шлют "" и без этого зацикливаются на одном отказе.
    const historyEntry = history_entry?.trim() ? history_entry : undefined;

    if (operation === "NOOP") {
      if (replace_body || historyEntry !== undefined) {
        return {
          ok: false,
          error: "NOOP не принимает replace_body или history_entry.",
        };
      }
      if (!existsSync(file)) {
        return {
          ok: false,
          error: `NOOP требует существующую карточку ${rel}.`,
        };
      }
      return {
        ok: true,
        file: rel,
        type,
        status: storedStatus(readFileSync(file, "utf8"), status ?? allowed[0]),
        action: "noop",
        matchedBy: id.matchedBy,
      };
    }
    if (replace_body && operation && operation !== "SUPERSEDE") {
      return {
        ok: false,
        error: "replace_body допустим только для SUPERSEDE.",
      };
    }

    mkdirSync(dir, { recursive: true });

    // Сбои лока/записи — структурированная ошибка, а не исключение: модель должна
    // увидеть внятное «занято/не записалось» и решить, что делать, а не уронить ход.
    let release: (() => void) | null = null;
    try {
      release = acquireLock(file);
      const existing = existsSync(file)
        ? readFileSync(file, "utf8")
        : undefined;
      const effectiveOperation = resolveOperation({
        operation,
        replaceBody: replace_body,
        existing,
      });
      // history_entry несёт вытесненную истину, которой у ADD ещё нет: там он шум и молча
      // отбрасывается (с записью в журнал), а у UPDATE — попытка подделать архив.
      if (historyEntry !== undefined && effectiveOperation === "UPDATE") {
        return {
          ok: false,
          error: "history_entry допустим только для SUPERSEDE.",
        };
      }
      if (effectiveOperation === "ADD" && existing !== undefined) {
        return {
          ok: false,
          error: `ADD отказан: карточка ${rel} уже существует.`,
        };
      }
      if (
        (effectiveOperation === "UPDATE" ||
          effectiveOperation === "SUPERSEDE") &&
        existing === undefined
      ) {
        return {
          ok: false,
          error: `${effectiveOperation} требует существующую карточку ${rel}.`,
        };
      }
      if (
        effectiveOperation === "SUPERSEDE" &&
        !history_entry?.trim() &&
        !isLegacyHistoryReplace(operation, replace_body === true, body)
      ) {
        return {
          ok: false,
          error:
            "SUPERSEDE требует history_entry; legacy replace_body должен содержать ## History.",
        };
      }
      const { content, action, ignoredHistoryEntry } = mergeCard({
        existing,
        title,
        fields: {
          type,
          description,
          tags,
          ...(effectiveOperation === "ADD"
            ? {
                status: status ?? allowed[0],
                confidence: confidence ?? "EXTRACTED",
              }
            : {
                ...(status !== undefined ? { status } : {}),
                ...(confidence !== undefined ? { confidence } : {}),
              }),
          ...(domain ? { domain } : {}),
        },
        initialFields: { created: today(), source: `daily/${today()}.md` },
        body,
        related,
        date: today(),
        replaceBody: replace_body === true,
        // Сырая operation: по её отсутствию mergeCard узнаёт легаси-путь replace_body.
        operation,
        // ADD получает сырое поле: пустую строку он отбрасывает сам и фиксирует это в журнале.
        historyEntry:
          effectiveOperation === "ADD" ? history_entry : historyEntry,
      });
      if (action !== "noop") atomicWrite(file, content);
      if (ignoredHistoryEntry) logIgnoredHistoryEntry();
      return {
        ok: true,
        file: rel,
        type,
        status: storedStatus(content, status ?? allowed[0]),
        action,
        matchedBy: id.matchedBy,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Не удалось записать карточку ${rel}: ${detail}`,
      };
    } finally {
      release?.();
    }
  },
});
