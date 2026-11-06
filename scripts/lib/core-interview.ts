// Контент-слот интервью core memory для экрана «Память» (scripts/lib/menu/core.ts).
// Три вещи: список вопросов (двуязычно), запись сырых ответов в vault и сборка
// синтетического сообщения, которым мост отдаёт ответы иве на дистилляцию.
//
// РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ: тут НЕТ никакой «дистилляции» и НЕ трогаем vault/CORE.md.
// saveInterview кладёт только сырой архив (полные ответы никогда не теряются), а ужать
// их в ядро (лимит CORE_CAP симв. из agent/lib/core-cap.ts) должна сама
// ива своими write-инструментами, получив buildDistillMessage. Так лимит и «не выдумывай»
// остаются заботой модели, а мост не знает про формат ядра.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_CAP } from "#lib/core-cap.ts";
import { writeFileAtomic } from "#lib/fs-atomic.ts";

const RECOVERY_PREFIX = "<!-- iva-core-distillation:v1:";
const RECOVERY_SUFFIX = " -->";

// Шесть тем ядра памяти (см. план: обращение · занятие · город/ритм · люди/контекст ·
// приоритеты · антипаттерны). Вопросы-приглашения к свободному тексту, оба языка рядом —
// экран берёт нужный по getLang(). id стабильны: попадают в архив и удобны для тестов.
export const INTERVIEW = [
  {
    id: "address",
    text: {
      en: "How should I address you — your name, and would you prefer a casual or a more formal tone?",
      ru: "Как к тебе обращаться? Имя и на «ты» или на «вы».",
    },
  },
  {
    id: "occupation",
    text: {
      en: "What do you do? Your work, projects, the role you play.",
      ru: "Чем ты занимаешься? Работа, проекты, роль.",
    },
  },
  {
    id: "location",
    text: {
      en: "Where are you and how is your day shaped — city, timezone, when you're usually around?",
      ru: "Где ты и как устроен день? Город, часовой пояс, ритм — когда обычно на связи.",
    },
  },
  {
    id: "people",
    text: {
      en: "Who and what matters in your world — close people, colleagues, companies, topics that keep coming up?",
      ru: "Кто и что важно в твоём контексте? Близкие, коллеги, компании, темы, что всплывают часто.",
    },
  },
  {
    id: "priorities",
    text: {
      en: "What are your priorities right now — what matters most to move forward on soon?",
      ru: "Какие у тебя сейчас приоритеты? Над чем важнее всего продвигаться в ближайшее время.",
    },
  },
  {
    id: "dislikes",
    text: {
      en: "What annoys you about assistants, and what should I never do — style, habits, boundaries?",
      ru: "Что бесит в ассистентах и чего точно не делать? Стиль, привычки, границы.",
    },
  },
];

type InterviewAnswer = { q?: unknown; a?: unknown };

function asInterviewAnswer(value: unknown): InterviewAnswer {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return {};
  }
  return { q: Reflect.get(value, "q"), a: Reflect.get(value, "a") };
}

// Пусто/скип показываем прочерком, чтобы архив читался и не рвал разметку.
const orDash = (v: unknown): string => {
  if (typeof v === "string") return v.trim() || "—";
  if (v == null) return "—";
  // Interview archives historically preserve JavaScript coercion for malformed scalar answers.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v).trim();
  return s === "" ? "—" : s;
};

// Сырой архив интервью в <vaultDir>/core-interview.md: полная копия ответов с датой,
// ПЕРЕЗАПИСЬ (одно интервью на юзера, прошлое не копим — актуально то, что сказали сейчас).
// vaultDir приходит явным параметром (ASSISTANT_VAULT_DIR ?? "vault" считает вызывающий),
// поэтому в тестах сюда легко подсунуть tmp-каталог. Возвращает путь записанного файла.
export async function saveInterview(
  vaultDir: string,
  qa: unknown,
  recovery?: unknown,
): Promise<string> {
  const items = Array.isArray(qa) ? qa : [];
  const stamp = new Date().toISOString(); // машинная дата в UTC — архив не для глаз, для ивы
  const body = items
    .map((item) => {
      const { q, a } = asInterviewAnswer(item);
      return `## ${orDash(q)}\n\n${orDash(a)}`;
    })
    .join("\n\n");
  const recoveryLine =
    recovery === undefined
      ? ""
      : `\n${RECOVERY_PREFIX}${Buffer.from(JSON.stringify(recovery)).toString("base64url")}${RECOVERY_SUFFIX}\n`;
  const md = `# Core interview — ${stamp}\n\n${body}\n${recoveryLine}`;
  const file = join(vaultDir, "core-interview.md");
  await writeFileAtomic(file, md);
  return file;
}

export async function readInterviewRecovery(
  vaultDir: string,
): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(vaultDir, "core-interview.md"), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  const line = raw.trimEnd().split("\n").at(-1) ?? "";
  if (!line.startsWith(RECOVERY_PREFIX) || !line.endsWith(RECOVERY_SUFFIX)) {
    return null;
  }
  const encoded = line.slice(RECOVERY_PREFIX.length, -RECOVERY_SUFFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    return JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    return null;
  }
}

// Синтетическое сообщение «от имени юзера»: мост шлёт его иве вместо реального текста,
// чтобы она сама сжала ответы в ядро. Вежливо, коротко, с ЯВНЫМ «ничего не выдумывай»
// и упоминанием лимита CORE_CAP (тот же, что режет 20-core.ts). lang: "ru"|"en",
// незнакомое значение → русский (дефолт канала).
export function buildDistillMessage(qa: unknown, lang: unknown): string {
  const items = Array.isArray(qa) ? qa : [];
  const ru = lang !== "en";
  const block = items
    .map((item, i) => {
      const { q, a } = asInterviewAnswer(item);
      return `${i + 1}. ${orDash(q)}\n— ${orDash(a)}`;
    })
    .join("\n\n");
  if (ru) {
    return [
      "[Настройка core memory]",
      "",
      `Ниже мои ответы о себе. Сожми их в ядро памяти и обнови файл vault/CORE.md своими инструментами (лимит ${CORE_CAP} символов).`,
      "Опирайся только на мои ответы — ничего не выдумывай и не додумывай. Когда обновишь ядро, кратко подтверди.",
      "",
      block,
    ].join("\n");
  }
  return [
    "[Core memory setup]",
    "",
    `Below are my answers about myself. Distill them into the memory core and update the file vault/CORE.md with your own tools (${CORE_CAP}-character limit).`,
    "Rely only on my answers — don't make anything up or add extra. Once the core is updated, confirm briefly.",
    "",
    block,
  ].join("\n");
}
