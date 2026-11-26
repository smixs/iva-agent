// Одно правило вырезания секретов для всей установки: им режет пакет улик `iva diagnose`
// (scripts/cli/diagnose.ts) и хвост журнала расписания, который агент читает ходом
// пробуждения (agent/lib/job-facts.ts). Второй копии правила в репозитории быть не должно:
// слепая приёмка T20 нашла ровно это — свой шаблон в authored tree пропускал токен внутри
// `bot<token>` и значение ключа без слова-приметы, пока diagnose уже резал и то и другое.
//
// Пакет, а не модуль одного из деревьев: `agent/` не импортирует `scripts/`, а `iva
// diagnose` обязан работать на установке без `agent/` (ADR-0003,
// scripts/authored-tree-guard.test.ts). `packages/` видят оба и его целиком несёт с собой
// собранный рантайм (RUNTIME_SOURCE_TREES в scripts/lib/custom-layer.ts).
//
// Правило не угадывает секрет по виду значения: секрет — значение ЛЮБОГО ключа, кроме
// закрытого списка настроек, плюс пароль из userinfo URL, ключ известного формата в любом
// месте строки (таблица KEY_SHAPES: токен бота, `sk-…`, `ghp_…`, `xox…-`, `AKIA…`, JWT,
// `Bearer …`), личный id рядом с меткой и e-mail.

/** Пометка вырезанного. Тот же вид, что в правилах про evidence (AGENTS.md). */
export const REDACTED = "<redacted>";

/** Installation credentials: placeholders and a single repeated character are ordinary values. */
export function isSecretValue(value: string): boolean {
  const characters = [...value];
  return characters.length >= 12 && new Set(characters).size > 1;
}

/** Eligible credentials selected from the shared inventory supplied by the caller. */
export function secretEntriesFromEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): Array<{ name: string; value: string }> {
  return names.flatMap((name) => {
    const value = env[name];
    return value === undefined
      ? []
      : secretValuesFromEnv({ [name]: value })
          .filter(isSecretValue)
          .map((value) => ({ name, value }));
  });
}

/**
 * Имя ключа `.env`, значение которого НЕ секрет: каталог, модель, провайдер, зона, язык,
 * порт, хост, окно контекста, усилие, режим, ник бота. Режется значение любого другого
 * ключа файла, какой бы длины оно ни было, — список секретов не словарь английских слов, а
 * дополнение к этому списку настроек. Иначе секрет в ключе без слова-приметы уезжает в
 * issue: пароль внутри `CUSTOM_BASE_URL=https://user:pass@host` (ключ из `.env.example`),
 * `CUSTOM_ENDPOINT`, `PROXY`, `*_DSN`, `*_COOKIE`, `SALT`, `PIN`, `OTP` и инвайт-ссылка
 * `SUPPORT_CHAT_URL` в чат владельца (слепая приёмка T21, раунд 3). Настройки остаются
 * целыми не для красоты: `ASSISTANT_DATA_DIR=data` и `ASSISTANT_VAULT_DIR=vault` — слова
 * внутри путей самого пакета, и вырезание съедало их из каждой строки (раунд 2). Список
 * сверяется тестом с `.env.example` и с описью
 * `agent/skills/security-defense/outbound-sensitive-keys.json`.
 */
const CONFIG_KEY =
  /(?:^|_)(?:DIR|MODEL|PROVIDER|TIMEZONE|LANGUAGE|LANG|PORT|WINDOW|EFFORT|MODE|USERNAME|REASONING|MAX_OUTPUT)$|^(?:NODE_ENV|TZ)$/iu;
/** `*_HOST`: настройка, только пока в значении нет ни владельца (`@`), ни пароля после `:`. Со схемой — тоже настройка (`http://host[:port]`), но не с путём и не с userinfo. */
const HOST_KEY = /(?:^|_)HOST$/iu;
const PLAIN_HOST = /^[^\s@:]+(?::\d+)?$/u;
const SCHEME_HOST = /^https?:\/\/[^\s/@:]+(?::\d+)?$/u;
/**
 * Пароль внутри значения с владельцем: `https://user:pass@host`, `user:pass@host`. Значение
 * режется целиком, но в журнал пароль попадает и отдельным словом — строкой апстрима или
 * текстом ошибки, — а целого URL там нет, и по одному полному значению он оставался
 * открытым (слепая приёмка T21, раунд 3).
 */
const URL_PASSWORD = /^(?:[A-Za-z][A-Za-z\d+.-]*:\/\/)?[^\s/@:]*:([^\s/@]+)@/u;
/**
 * Настройки САМОГО ПРОЦЕССА, а не установки: в `.env` таких ключей нет, а в `process.env`
 * они есть всегда — и их значения не секреты. Без этого списка хвост журнала расписания
 * терял смысл: `HOME=/Users/user` вырезал начало каждого пути, `USER=user` — слог внутри
 * слов, `SHLVL=1` — каждую единицу (слепая приёмка T20, раунды 2-3). Переменные systemd
 * (`MANAGERPID`, `SYSTEMD_EXEC_PID`, `INVOCATION_ID`, `JOURNAL_STREAM`) — той же природы:
 * их пишет systemd в окружение сервиса, и pid со stream попадают в хвост провала (T30 v2).
 */
const PROCESS_SETTING_KEY =
  /^(?:HOME|PATH|PWD|OLDPWD|SHLVL|SHELL|USER|LOGNAME|TERM|COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|EDITOR|VISUAL|PAGER|HOSTNAME|DISPLAY|XPC_[A-Z_]+|__CF[A-Z_]+|MANAGERPID|SYSTEMD_EXEC_PID|INVOCATION_ID|JOURNAL_STREAM|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|COMMAND_MODE|INFOPATH|MANPATH|_)$/u;
/** Ключи со списком личных id: их значения делятся по запятой и пробелам. */
const CHAT_ID_KEY = /(?:_CHAT_ID|_USER_IDS|_API_ID)$/u;
/**
 * Ключи известных форматов: их режем по виду, потому что такого ключа может не быть ни в
 * `.env`, ни в `.env` плагина — модель вставила его в команду, инструмент напечатал чужой
 * ключ, и тот уезжал в пакет и в адрес issue (находка Q4 волны Trace). Строка — формат и
 * его шаблон; первая группа шаблона, если она есть, — слово-примета, которое остаётся
 * перед пометкой (`Bearer <redacted>`).
 *
 * Границы слова у большинства форматов не ставим: ключ стоит и внутри URL, и токен бота
 * терялся ровно на этом — lookbehind срывался на букве `t` из `bot<token>` (T21). Граница
 * слева есть только там, где без неё режется обычный текст или проход становится
 * квадратичным: `sk-` — хвост слов `risk-…`, `task-…`, `desk-…`; JWT — начало `eyJ`
 * внутри длинной цепочки знаков. Короткое не режется: у каждого формата не меньше 10 знаков
 * после приметы, поэтому слово `skills`, хеш коммита (40 hex без приметы) и адрес без ключа
 * остаются целыми. Похожая таблица есть у outbound Gate (agent/lib/security-gate.ts), но у
 * неё другая задача — назвать находку в ответе модели, а не вырезать её из пакета улик.
 */
const KEY_SHAPES: ReadonlyArray<readonly [format: string, shape: RegExp]> = [
  // `<5+ цифр>:<25+ знаков>` шире формата Bot API (8-10 цифр, 35 знаков) и ложных
  // срабатываний не даёт. `(?<!\d)` смысла не меняет — старт внутри той же цепочки цифр
  // кончается там же, — но без него 100 КБ цифр без `:` резались 10 секунд: каждая
  // позиция заново проходила цепочку до конца.
  ["Telegram bot token", /(?<!\d)\d{5,}:[A-Za-z0-9_-]{25,}/gu],
  // `sk-…`, `sk-proj-…`, `sk-ant-api03-…`, `sk-or-v1-…`: тело ключа несёт `-` и `_`.
  ["OpenAI, Anthropic, OpenRouter", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/gu],
  ["GitHub token ghp_ gho_ ghu_ ghs_ ghr_", /gh[pousr]_[A-Za-z0-9]{20,}/gu],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/gu],
  [
    "Slack token xoxa- xoxb- xoxp- xoxr- xoxs-",
    /xox[abprs]-[A-Za-z0-9-]{10,}/gu,
  ],
  ["AWS access key id", /AKIA[0-9A-Z]{16}/gu],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/gu],
  [
    "JWT",
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu,
  ],
  ["Authorization: Bearer", /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/giu],
];
/**
 * Личный id рядом с меткой: `tg:555000111222:43`, `chat_id=…`, `chatId: …`, `from=…`.
 * Работает БЕЗ `.env` — иначе chat id из журнала хода уезжает в пакет (личные данные).
 * Голые длинные числа не трогаем: тогда пакет превратился бы в кашу из времён и размеров.
 */
const TELEGRAM_ID_RE =
  /((?:tg|chat|chatId|chat_id|userId|user_id|from|to)(?::|=|%3A|%3D)\s*)\d{5,}/giu;
/**
 * E-mail: адрес начинается на границе локальной части — якорь и есть то, что делает проход
 * линейным. Без него `+` на строке без `@` откатывался на каждой позиции: 64 КБ stderr
 * занимали секунды в главном процессе (verify-ocr-v7 №3); с якорем внутри длинной цепочки
 * знаков проверка отваливается за один знак, а не за всю цепочку. Потолков длин нет: они
 * давали не скорость, а потерю адресов с локальной частью 65+ и доменом 260+.
 */
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Формы, в которых один и тот же секрет попадает в журнал: сырая, percent-encoded
 * (Basic-строки и куски запросов), JSON-экранированная (тело запроса уехало в лог целиком)
 * и base64/base64url (заголовки авторизации). Список — функция от секрета, поэтому режется
 * всё, чем секрет может приехать, а не только то, как он лежит в `.env`.
 */
function secretForms(secret: string): string[] {
  return [
    secret,
    // Многострочное значение (кавычка в `.env`) приезжает в журнал и построчно: каждая
    // непустая строка — такая же форма секрета, как целое значение (слепая приёмка T21).
    ...secret
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ];
}

/**
 * Чистая: каждая форма секрета, ключ известного формата в любом месте строки, личный id
 * рядом с меткой и e-mail становятся пометкой. Формы режутся ОДНИМ проходом и от длинной к короткой: иначе
 * второй проход резал бы буквы внутри только что вставленной пометки, а короткая форма
 * съедала бы начало длинной (короткий секрет-префикс оставлял хвост длинного — T21).
 * Форма короче 4 знаков режется только на границе слова: однобуквенный пароль `p` внутри
 * `https://u:p@host` выделяется и так (`:p@`), а `package` и `output` остаются целыми (T26).
 * Порог — строго ниже минимальной длины секрета в property-тесте (4): четырёхзначные
 * формы обязаны резаться везде, даже приклеенными к мусору, иначе тест «ни одна форма
 * не выживает» краснеет контрпримером вида `0!!!!` (проверено: при пороге 5 он красный).
 */
const SHORT_FORM = 4;
/**
 * Знак hex внутри percent-escape: регистр роли не играет (`%2f` = `%2F`), поэтому каждая
 * буква становится классом. Буквы самого секрета — не знаки escape, их регистр значим.
 */
function percentEscapePattern(char: string): string {
  return /[0-9]/u.test(char)
    ? char
    : `[${char.toLowerCase()}${char.toUpperCase()}]`;
}
function formPattern(form: string): string {
  // Percent-форма приезжает и со строчными буквами hex (`%2f`): заменяем знаки escape на
  // регистронезависимые классы после экранирования формы (а не регистронезависимым флагом
  // на всю форму — тогда строчная форма секрета вроде `alpha%2fbeta` съедала бы чужой текст).
  const raw = escapeRegExp(form).replace(
    /%([0-9A-Fa-f]{2})/gu,
    (_match, hex: string) => `%${[...hex].map(percentEscapePattern).join("")}`,
  );
  return form.length < SHORT_FORM
    ? `(?<![\\p{L}\\p{N}])${raw}(?![\\p{L}\\p{N}])`
    : raw;
}
export function redactSecretValues(
  text: string,
  secrets: readonly string[],
): string {
  const forms = new Set<string>();
  for (const secret of secrets)
    for (const form of secretForms(secret))
      if (form.length > 0) forms.add(form);
  const ordered = [...forms].sort((left, right) => right.length - left.length);
  let out = text;
  if (ordered.length > 0) {
    out = out.replace(
      new RegExp(ordered.map(formPattern).join("|"), "gu"),
      REDACTED,
    );
  }
  return out;
}

export function redact(text: string, secrets: readonly string[]): string {
  return cutKeyShapes(redactSecretValues(text, secrets))
    .replace(TELEGRAM_ID_RE, `$1${REDACTED}`)
    .replace(EMAIL_RE, REDACTED);
}

/** Каждый ключ известного формата — пометка; слово-примета из первой группы остаётся. */
function cutKeyShapes(text: string): string {
  return KEY_SHAPES.reduce(
    (out, [, shape]) =>
      out.replace(
        shape,
        (_match, kept: unknown) =>
          `${typeof kept === "string" ? kept : ""}${REDACTED}`,
      ),
    text,
  );
}

/**
 * Какие значения `.env` считать секретами. Имена ключей берутся из самого файла: список
 * не угадывается по виду значения. Секрет — значение ЛЮБОГО ключа, кроме настроечных
 * (CONFIG_KEY, `*_HOST` без владельца и пароля): неизвестный и пользовательский ключ по
 * умолчанию режется, потому что задача тут — утечка, а не полнота пакета. Пустое значение
 * не режется (пометка вместо пустоты выглядела бы как найденный секрет). Ветвь CHAT_ID_KEY
 * делит значение на части: личные id пишут через запятую.
 */
export function secretValuesFromEnv(env: Record<string, string>): string[] {
  const values: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (CHAT_ID_KEY.test(key)) {
      values.push(
        ...value
          .split(/[,\s]+/u)
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      );
      continue;
    }
    if (CONFIG_KEY.test(key) || PROCESS_SETTING_KEY.test(key)) continue;
    if (
      HOST_KEY.test(key) &&
      (PLAIN_HOST.test(value) || SCHEME_HOST.test(value))
    )
      continue;
    values.push(value);
    if (key === "TELEGRAM_COLLEAGUE_BOT_TOKENS") {
      for (const part of value.split(/[,\s]+/u)) {
        const entry = part.trim();
        if (entry.length === 0) continue;
        const eq = entry.indexOf("=");
        const token = (eq >= 0 ? entry.slice(eq + 1) : entry).trim();
        if (token.length > 0) values.push(token);
      }
    }
    const password = URL_PASSWORD.exec(value)?.[1];
    if (password) values.push(password);
  }
  return values;
}
