// Сбой хода словами для владельца: что случилось и что делать. Ни стека, ни кода, ни
// Error id — они остаются в журнале сервиса и в Trace (agent/hooks/trace.ts). Текст
// провайдера в чат не идёт вовсе: им некому читать, а секрет в нём — лишний риск.
//
// Попытки и «ответ уже начался» приходят из eve в details (patches/eve:
// runModelCallWithRetries кладёт attempts и answerStarted). Обрыв в любой момент до конца
// ответа eve уже повторила сама, до трёх запросов (правило лида 07.10.2026). Если и третий
// запрос оборвался посреди ответа, решает владелец кнопкой «Повторить».
//
// Текст выбирается только по сообщению, кодам статуса и текстам ответа API (statusCode,
// upstreamStatusCode, upstreamMessage, apiErrorMessage). Остальное в details — стек, тело
// ответа, errorId — не читается: номер строки `:429:` в стеке не значит лимит (рецензия
// 07.10.2026).

export interface ProviderErrorText {
  readonly en: string;
  readonly ru: string;
}

interface ProviderErrorInput {
  readonly message: string;
  readonly details?: unknown;
  /** MODEL_PROVIDER установки: по нему сообщение называет, с кем пропала связь. */
  readonly provider?: string | undefined;
  /** Текст сообщения владельца, на который шёл ответ: цитата при обрыве посреди ответа. */
  readonly question?: string | undefined;
  /** В сообщении было вложение: кнопка его не вернёт, владелец присылает его сам. */
  readonly media?: boolean | undefined;
  /** Групповой чат: цитата не показывается, её видят все участники. */
  readonly group?: boolean | undefined;
}

/** Имя провайдера в трёх падежах: «Anthropic не принял», «до Anthropic», «с Anthropic». */
interface ProviderName {
  readonly en: string;
  readonly nom: string;
  readonly gen: string;
  readonly ins: string;
}

const NAMED: Readonly<Record<string, string>> = {
  claude: "Anthropic",
  codex: "OpenAI",
  ollama: "Ollama",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

// Только свои ключи: MODEL_PROVIDER «valueOf» или «__proto__» достал бы метод Object, и
// сообщение о сбое упало бы, не дойдя до владельца.
function providerName(provider: string | undefined): ProviderName {
  const name =
    provider !== undefined && Object.hasOwn(NAMED, provider)
      ? NAMED[provider]
      : undefined;
  return name === undefined
    ? {
        en: "the provider",
        nom: "провайдер",
        gen: "провайдера",
        ins: "провайдером",
      }
    : { en: name, nom: name, gen: name, ins: name };
}

/** Заглавная буква в начале фразы: «провайдер» посреди фразы, «Провайдер» в начале. */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const RETRY_WRAPPER =
  /^\s*AI_RetryError:\s*Failed after \d+ attempts?\.\s*Last error:\s*/iu;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** details объектом; строку с JSON-объектом читаем так же (старые события eve). */
function detailsRecord(details: unknown): Record<string, unknown> {
  if (typeof details !== "string") return asRecord(details);
  try {
    return asRecord(JSON.parse(details));
  } catch {
    return {};
  }
}

/** Поля details, по которым выбирается текст. Коды — словом `status`, чтобы \b429\b ловил их. */
const EVIDENCE_FIELDS = [
  "statusCode",
  "upstreamStatusCode",
  "upstreamMessage",
  "apiErrorMessage",
] as const;

function evidenceOf(message: string, details: Record<string, unknown>): string {
  const lines = [message.replace(RETRY_WRAPPER, "")];
  for (const field of EVIDENCE_FIELDS) {
    const value = details[field];
    if (typeof value === "number") lines.push(`status ${String(value)}`);
    else if (typeof value === "string") lines.push(value);
  }
  return lines.join("\n");
}

function resetAfter(text: string): string | undefined {
  const match = /resets\s+in\s+([^.;\n"'}`\]]+)/iu.exec(text);
  const reset = match?.[1]?.trim();
  return reset ? reset : undefined;
}

/** Сколько раз eve спросила ещё раз: попыток минус первая. */
function repeatsOf(details: Record<string, unknown>): number {
  const attempts = details.attempts;
  return typeof attempts === "number" &&
    Number.isInteger(attempts) &&
    attempts > 1
    ? attempts - 1
    : 0;
}

function timesRu(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "раза";
  return "раз";
}

/** «повторила 2 раза, не получилось» — только если повторы были. */
function repeated(count: number): ProviderErrorText {
  if (count === 0) return { en: "", ru: "" };
  return {
    en: ` I tried again ${String(count)} ${count === 1 ? "time" : "times"}, it did not work.`,
    ru: `, повторила ${String(count)} ${timesRu(count)}, не получилось`,
  };
}

/** Подпись и data кнопки «Повторить» под сообщением об обрыве посреди ответа. */
export const RETRY_LABEL = { en: "Try again", ru: "Повторить" } as const;

/** Текст хода по нажатию «Повторить»: первой строкой идёт data кнопки (мост). */
export function isRetryTap(text: string): boolean {
  const head = text.split("\n", 1)[0]?.trim() ?? "";
  return head === RETRY_LABEL.en || head === RETRY_LABEL.ru;
}

/** Сообщение об обрыве посреди ответа на любом языке: по нему мост узнаёт свою кнопку. */
export function isBreakNotice(text: string): boolean {
  return /оборвалась на середине ответа|broke off in the middle of the answer/u.test(
    text,
  );
}

/** Кнопка под сообщением: нажатие приходит ходу текстом data и текстом сообщения. */
function retryButton(label: string): string {
  return `<tg-button-row><tg-button type="callback_data" data="${label}">${label}</tg-button></tg-button-row>`;
}

const LIMIT = /usage\s+limit\s+reached|rate[ _-]?limit|\b429\b/iu;
const TOOL_SCHEMA = /invalid[ _-]?json[ _-]?schema/iu;
const BILLING = /insufficient[ _-]?credits|billing|\b402\b/iu;
const AUTH =
  /invalid[ _-]?api[ _-]?key|unauthorized|authentication|\b(?:401|403)\b/iu;
const CONTEXT = /context\s+length|too\s+many\s+tokens|maximum\s+context/iu;
const SILENT = /produced no output for|produced nothing for/iu;
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/u;
const PROVIDER_SIDE =
  /upstream\s+request\s+failed|\b5(?:\d{2}|xx)\b|overloaded|internal\s+server\s+error/iu;
const CONNECTION =
  /did not finish the response|broke off|StreamTruncated|connection .{0,40}lost|terminated|socket hang up|other side closed|ECONNRESET|EPIPE|UND_ERR|network request failed|fetch\s+failed|timeout|ETIMEDOUT|stream(?:\s+was)?\s+aborted|no answer reached/iu;

type Situation = {
  readonly evidence: string;
  readonly details: Record<string, unknown>;
  readonly name: ProviderName;
  readonly question: string;
  readonly media: boolean;
  readonly group: boolean;
};
type Rule = {
  readonly when: (situation: Situation) => boolean;
  readonly say: (situation: Situation) => ProviderErrorText;
};

function limitText({ evidence }: Situation): ProviderErrorText {
  const reset = resetAfter(evidence);
  return reset
    ? {
        en: `Provider limit exhausted - resets in ${reset}; wait or switch models: /model`,
        ru: `Лимит провайдера исчерпан - сброс через ${reset}; подожди или смени модель: /model`,
      }
    : {
        en: "Provider limit exhausted - wait or switch models: /model",
        ru: "Лимит провайдера исчерпан - подожди или смени модель: /model",
      };
}

// OpenAI отвергает весь запрос из-за схемы одного инструмента (`param: tools`, в тексте
// путь до поля). Инструмент может быть свой (data/custom/agent/tools), из плагина или из
// подключения. Пользователю нужно место и действие, не текст ошибки.
function toolSchemaText({ evidence }: Situation): ProviderErrorText {
  const at = /found at\s+(\$[^\s.]*(?:\.[^\s]+)*)/iu.exec(evidence)?.[1];
  const where = at ? ` (${at})` : "";
  return {
    en: `The provider rejected a tool description${where} - remove that tool from data/custom/agent/tools or switch its plugin off (iva plugin list, iva plugin disable <name>), then /update`,
    ru: `Провайдер не принял описание инструмента${where} - убери этот инструмент из data/custom/agent/tools или выключи его плагин (iva plugin list, iva plugin disable <имя>), затем /update`,
  };
}

const QUOTE_LIMIT = 120;

/**
 * Вопрос владельца для цитаты в rich-сообщении: одна строка, до 120 знаков с «…». Это его же
 * текст, уже прошедший Gate на входе, и обратно он едет через outbound-Gate шва. Разметкой
 * он стать не может: `<` и `>` заменены угловыми кавычками (тег не откроется), знаки
 * разметки `*_#|` экранированы, как в escapeRichText (scripts/lib/telegram-buttons.ts), а
 * с ними `` ` ``, `[`, `]`, `(`, `)`, `~`, `$` и обратная косая: иначе `\*` владельца стал бы
 * экранированной косой и голой звёздочкой.
 */
function quoteOf(question: string): string {
  const line = question.replace(/\s+/gu, " ").trim();
  const chars = Array.from(line);
  const cut =
    chars.length <= QUOTE_LIMIT
      ? line
      : `${chars
          .slice(0, QUOTE_LIMIT - 1)
          .join("")
          .trimEnd()}…`;
  return cut
    .replace(/</gu, "‹")
    .replace(/>/gu, "›")
    .replace(/([\\*_#|`[\]()~$])/gu, "\\$1");
}

// На что шёл ответ: цитата в личном чате; в группе её видят все, поэтому только «твоё
// сообщение». Полный вопрос модели по нажатию «Повторить» подставляет мост из run-status.
function answerTarget({
  question,
  media,
  group,
}: Situation): ProviderErrorText {
  const quote = group ? "" : quoteOf(question);
  if (quote !== "") return { en: ` to «${quote}»`, ru: ` на «${quote}»` };
  return media
    ? {
        en: " to your message with an attachment",
        ru: " на твоё сообщение с вложением",
      }
    : { en: " to your message", ru: " на твоё сообщение" };
}

// Вложение кнопка не вернёт: модель получила бы текст без файла. Тогда — «пришли ещё раз».
function midAnswerAsk({
  media,
  question,
  group,
}: Situation): ProviderErrorText {
  if (!media)
    return {
      en: ` ${RETRY_LABEL.en}?\n\n${retryButton(RETRY_LABEL.en)}`,
      ru: ` ${RETRY_LABEL.ru}?\n\n${retryButton(RETRY_LABEL.ru)}`,
    };
  return question !== "" && !group
    ? {
        en: " Send the message with the attachment again.",
        ru: " Пришли сообщение с вложением ещё раз.",
      }
    : { en: " Send it again.", ru: " Пришли его ещё раз." };
}

function midAnswerText(situation: Situation): ProviderErrorText {
  const to = answerTarget(situation);
  const again = repeated(repeatsOf(situation.details));
  const ask = midAnswerAsk(situation);
  return {
    en: `The connection to ${situation.name.en} broke off in the middle of the answer${to.en}.${again.en}${ask.en}`,
    ru: `Связь с ${situation.name.ins} оборвалась на середине ответа${to.ru}${again.ru}.${ask.ru}`,
  };
}

function silentText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `${capital(name.en)} takes too long to answer.${again.en} Write again in a couple of minutes or switch models: /model.`,
    ru: `${capital(name.nom)} долго не отвечает${again.ru}. Напиши ещё раз через пару минут или смени модель: /model.`,
  };
}

function waitText({ name }: Situation): ProviderErrorText {
  return {
    en: `${capital(name.en)} asks to wait longer than a minute. Try again in a couple of minutes.`,
    ru: `${capital(name.nom)} просит подождать дольше минуты. Попробуй через пару минут.`,
  };
}

function unreachableText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `I cannot reach ${name.en}: the server has no connection to it.${again.en} Check the server's internet and write again.`,
    ru: `Не могу достучаться до ${name.gen}: у сервера нет связи с ним${again.ru}. Проверь интернет на сервере и напиши ещё раз.`,
  };
}

function providerSideText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `${capital(name.en)} has a failure on its side.${again.en} Write again in a couple of minutes.`,
    ru: `У ${name.gen} сбой${again.ru}. Напиши ещё раз через пару минут.`,
  };
}

function connectionText({ name, details }: Situation): ProviderErrorText {
  const again = repeated(repeatsOf(details));
  return {
    en: `The connection to ${name.en} broke off.${again.en} Write again.`,
    ru: `Связь с ${name.ins} оборвалась${again.ru}. Напиши ещё раз.`,
  };
}

// Порядок — по смыслу для владельца: сначала то, что повтором не лечится (лимит, деньги,
// ключ, схема, переполнение), потом обрыв посреди ответа (кнопка), потом связь.
const RULES: readonly Rule[] = [
  { when: ({ evidence }) => LIMIT.test(evidence), say: limitText },
  { when: ({ evidence }) => TOOL_SCHEMA.test(evidence), say: toolSchemaText },
  {
    when: ({ evidence }) => BILLING.test(evidence),
    say: () => ({
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    }),
  },
  {
    when: ({ evidence }) => AUTH.test(evidence),
    say: ({ name }) => ({
      en: `${capital(name.en)} did not accept the key or login. Check it in /menu and write again.`,
      ru: `${capital(name.nom)} не принял ключ или вход. Проверь его в /menu и напиши ещё раз.`,
    }),
  },
  {
    when: ({ evidence }) => CONTEXT.test(evidence),
    say: () => ({
      en: "The conversation got too long for the model. /new starts over.",
      ru: "Разговор стал слишком длинным для модели. /new начнёт заново.",
    }),
  },
  { when: ({ details }) => details.answerStarted === true, say: midAnswerText },
  { when: ({ evidence }) => SILENT.test(evidence), say: silentText },
  {
    when: ({ details }) => typeof details.providerWaitMs === "number",
    say: waitText,
  },
  { when: ({ evidence }) => UNREACHABLE.test(evidence), say: unreachableText },
  {
    when: ({ evidence }) => PROVIDER_SIDE.test(evidence),
    say: providerSideText,
  },
  { when: ({ evidence }) => CONNECTION.test(evidence), say: connectionText },
];

function unknownText({ name }: Situation): ProviderErrorText {
  return {
    en: `I could not answer: ${name.en} returned something I could not read. Write again; if it repeats, /new starts over.`,
    ru: `Не получилось ответить: ${name.nom} вернул ответ, который я не разобрала. Напиши ещё раз; если повторится, /new начнёт заново.`,
  };
}

export function humanizeProviderError(
  input: ProviderErrorInput,
): ProviderErrorText {
  const details = detailsRecord(input.details);
  const situation: Situation = {
    evidence: evidenceOf(input.message, details),
    details,
    name: providerName(input.provider),
    question: input.question ?? "",
    media: input.media === true,
    group: input.group === true,
  };
  const rule = RULES.find((candidate) => candidate.when(situation));
  return (rule?.say ?? unknownText)(situation);
}
