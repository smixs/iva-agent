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
import { parseFrontmatterOrSkip } from "../lib/frontmatter.js";
import { resolveTimeZone } from "../lib/timezone.js";
import { resolveVaultDir } from "@iva/vault-dir";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import {
  brokenLinksError,
  relatedTarget,
  unresolvedLinkTargets,
  wikilinkTargets,
} from "../lib/vault-links.ts";

// Строго типизированная запись карточки памяти. Заменяет «write_file по наитию» для карточек:
// zod-enum на type/status берётся из autograph schema.json (единый источник правды), поэтому
// модель НЕ может выдумать тип или добавить неизвестное поле — вызов упадёт на валидации.
// Ночной enforce.py остаётся backstop'ом для всего, что записалось мимо этого тула.

// Типы карточек, которые модель создаёт интерактивно (summary-типы пишет ночной rollup, не тул).
const CARD_TYPE_DIR: Record<string, string> = {
  contact: "contacts",
  project: "projects",
  decision: "decisions",
  idea: "ideas",
  note: "notes",
};
const DESC_CAP = 500;

// Статус уже лежащей карточки. Её frontmatter мог сломать владелец руками, и до
// обёртки такая карточка вылетала исключением из тула: "посмотри карточку"
// превращалось в ошибку хода. Нечитаемый frontmatter = статуса нет, берём запасной.
function storedStatus(content: string, path: string, fallback: string): string {
  const value = parseFrontmatterOrSkip(content, path)?.fields?.status;
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
    join(resolveVaultDir(process.cwd()), "schema.json"),
    join(
      resolveVaultDir(process.cwd()),
      ".claude",
      "skills",
      "autograph",
      "schema.json",
    ),
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
    "Создать или обновить карточку памяти в vault; для карточек — ЭТО, не write_file. " +
    "Поля вне схемы недопустимы. Без operation операция — по карточке. " +
    "Summary (день/неделя/…) НЕ создавай — их пишет rollup.",
  inputSchema: z.object({
    operation: z
      .enum(["ADD", "UPDATE", "SUPERSEDE", "NOOP"])
      .optional()
      .describe(
        "ADD — новая; UPDATE — факт в ## Log; SUPERSEDE — замена истины; NOOP — ничего.",
      ),
    type: z
      .preprocess(normalizeType, z.enum(CARD_TYPES))
      .describe("Тип; алиасы person/company → contact"),
    title: singleLine("title").describe("Заголовок сущности"),
    description: singleLine("description")
      .max(
        DESC_CAP,
        `description слишком длинное: максимум ${DESC_CAP} символов; сократи его и повтори вызов`,
      )
      .describe("Выжимка что/зачем, 1–2 фразы"),
    tags: z
      .array(singleLine("tag"))
      .min(1)
      .max(6)
      .describe("2–5 тегов, lowercase-kebab"),
    status: singleLine("status").optional().describe("Валидируется по типу"),
    domain: singleLine("domain").optional().describe("Домен (work/personal/…)"),
    related: z
      .array(singleLine("related"))
      .optional()
      .describe("Связи [[…]]: пути/слаги"),
    body: nonBlank("body").describe(
      "Тело в markdown: только факты, без H1/H2 и ## History/Log/Related — их ведёт тул",
    ),
    history_entry: z
      .string()
      .optional()
      .describe(
        "ТОЛЬКО SUPERSEDE: строка в ## History, формат 'YYYY-MM-DD: факт' " +
          "(без даты — сегодня; пусто = нет поля). ADD отбрасывает, UPDATE/NOOP с текстом — ошибка.",
      ),
    confidence: z
      .enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"])
      .optional()
      .describe("EXTRACTED — прямо; INFERRED — вывод (default EXTRACTED)"),
    replace_body: z
      .boolean()
      .optional()
      .describe(
        "Легаси-путь без operation: body целиком, ## History — внутри body.",
      ),
  }),
  // eslint-disable-next-line @typescript-eslint/require-await -- Preserve the established Promise-returning Eve tool contract.
  async execute(input) {
    try {
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

      const dir = join(
        resolveVaultDir(process.cwd()),
        "cards",
        CARD_TYPE_DIR[type],
      );
      // Идентичность: точный слаг → иначе карточка того же типа с таким же H1/name/aliases
      // (легаси-файлы с латинским слагом и кириллическим заголовком).
      const id = resolveCard(dir, title);
      if (id.candidates && id.candidates.length > 1) {
        const list = id.candidates.map((f) =>
          relative(resolveVaultDir(process.cwd()), f).split(sep).join("/"),
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
      const rel = relative(resolveVaultDir(process.cwd()), file)
        .split(sep)
        .join("/");

      // Пробельная пустота history_entry (value.trim() === "") ничего не вытесняет и не
      // подделывает History: для UPDATE и NOOP она равна отсутствующему полю — так же, как
      // SUPERSEDE читает его через trim(). Модели, заполняющие все поля схемы, шлют "" и
      // без этого зацикливаются на одном отказе.
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
          status: storedStatus(
            readFileSync(file, "utf8"),
            rel,
            status ?? allowed[0],
          ),
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
        // отбрасывается (с записью в журнал), а у UPDATE — попытка подделать History.
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
        // Ссылка в никуда роняет health score графа, а ночной graph.fix её не чинит:
        // резолвится она ничем. Проверяется ВХОД (тело и related), а не слитая карточка:
        // за старые битые ссылки в ней отвечает не этот вызов. Место — перед записью,
        // после структурных отказов: их текст точнее, и он должен доходить первым.
        const broken = unresolvedLinkTargets(
          [...wikilinkTargets(body), ...(related ?? []).map(relatedTarget)],
          {
            vaultDir: resolveVaultDir(process.cwd()),
            source: rel.replace(/\.md$/, ""),
          },
        );
        if (broken.length)
          return { ok: false, error: brokenLinksError(broken) };
        if (action !== "noop") atomicWrite(file, content);
        if (ignoredHistoryEntry) logIgnoredHistoryEntry();
        return {
          ok: true,
          file: rel,
          type,
          status: storedStatus(content, rel, status ?? allowed[0]),
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
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, error: text };
      throw error;
    }
  },
});
