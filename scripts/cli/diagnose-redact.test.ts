// Правила вырезания: сырое значение, формы, в которых секрет попадает в журнал
// (percent-encoded, JSON-экранированное, base64/base64url), шаблонные правила (ключ
// известного формата в любом месте строки, личный id рядом с меткой, e-mail), порядок «от длинного к
// короткому» и сверка списка настроечных ключей с `.env.example` и с описью
// `outbound-sensitive-keys.json`. Тесты пакета целиком — в diagnose.test.ts, здесь правила.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; при провале подставь ещё и path:
// fc.assert(prop, { seed: SEED, path }).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { parseEnv } from "node:util";
import fc from "fast-check";
import { REDACTED, redact, secretValuesFromEnv } from "./diagnose.ts";

const SEED = 20_260_919;

/** Формы секрета, которые обязаны умереть в пакете. */
function secretForms(secret: string): string[] {
  return [
    // Многострочное значение приезжает в журнал и по строчкам: каждая строка — тоже форма.
    ...secret
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    secret,
    encodeURIComponent(secret),
    // Percent-encoding регистронезависим: escape мог приехать строчными буквами.
    encodeURIComponent(secret).replace(
      /%([0-9A-F]{2})/gu,
      (_match, hex: string) => `%${hex.toLowerCase()}`,
    ),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ].filter((form) => form.length > 0);
}

await test("ни одна форма секрета не выживает в тексте (seed 20260919)", () => {
  // Алфавит — вся печатная ASCII (0x21..0x7E), а не только буквы-цифры: base64 обычного
  // текста даёт `+` и `/` лишь тогда, когда третий байт тройки — `>`, `?` или `~`, и на
  // узком алфавите правило base64 невозможно было проверить вовсе (слепая приёмка T21,
  // мутация F: правило удалялось, все тесты оставались зелёными).
  const secretChars = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
    String.fromCharCode(0x21 + i),
  );
  const secretArb = fc.string({
    unit: fc.constantFrom(...secretChars),
    minLength: 4,
    maxLength: 24,
  });

  fc.assert(
    fc.property(
      fc.array(secretArb, { minLength: 1, maxLength: 3 }),
      fc.array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 6 }),
      fc.string({ maxLength: 40 }),
      (secrets, picks, junk) => {
        // Секрет, целиком помещающийся внутрь пометки, неотличим от неё by construction
        // (пометка — тоже текст); тест оговаривает это, а не прячет.
        const real = secrets.filter(
          (secret) =>
            !secretForms(secret).some((form) => REDACTED.includes(form)),
        );
        // Текст СОБИРАЕТСЯ из форм: случайная строка почти никогда не содержит ни
        // base64, ни percent-формы секрета, и проверка держала бы ноль.
        const pieces = real.flatMap((secret) =>
          picks.map(
            (kind) => secretForms(secret)[kind % secretForms(secret).length],
          ),
        );
        const text = `${pieces
          .map((piece, index) => `${junk.slice(index, index + 3)}${piece}`)
          .join(" ")} ${junk}`;

        const out = redact(text, real);
        for (const secret of real) {
          for (const form of secretForms(secret)) {
            assert.ok(
              !out.includes(form),
              `форма ${JSON.stringify(form)} секрета ${JSON.stringify(secret)} выжила в пакете`,
            );
          }
        }
        assert.equal(
          redact(out, real),
          out,
          "повторное вырезание ничего не меняет",
        );
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

await test("токен бота режется и внутри URL, а не только отдельным словом (seed 20260919)", () => {
  const token = "444555666:BBForeignTokenJJJabcdefghijklmnopqrs";
  const text = `GET https://api.telegram.org/bot${token}/sendMessage failed`;

  const out = redact(text, []);
  assert.ok(!out.includes(token), `токен уехал в пакет: ${out}`);
  assert.match(out, /bot<redacted>\/sendMessage/u);
});

await test("нижний регистр percent-escape режется так же, как верхний", () => {
  // Percent-encoding регистронезависим: escape мог приехать строчными буквами, а буквы
  // самого секрета — нет. Форма обязана ловить оба написания каждого %XX.
  const secret = "Alpha/Beta+9090";
  const encoded = encodeURIComponent(secret);
  assert.equal(encoded, "Alpha%2FBeta%2B9090", "контроль: верхний hex");
  const lowered = encoded.replace(
    /%([0-9A-F]{2})/gu,
    (_match, hex: string) => `%${hex.toLowerCase()}`,
  );
  assert.equal(lowered, "Alpha%2fBeta%2b9090", "контроль: строчный hex");

  const out = redact(`q=${lowered} end`, [secret]);
  assert.ok(!out.includes(lowered), `нижняя percent-форма выжила: ${out}`);
  assert.ok(!out.includes(secret), `сырая форма выжила: ${out}`);

  // Вторая половина контракта: регистр значим вне escape. Строчная форма чужого секрета
  // не имеет права резаться — иначе регистронезависимый флаг на всю форму (мутация
  // критика) проходил бы все тесты.
  const foreign = "h: alpha%2fbeta";
  assert.equal(redact(foreign, ["Alpha%2FBeta"]), foreign);
});

await test("строка без @ не тормозит: 100 КБ режутся быстрее 100 мс", () => {
  // Квадратичный `EMAIL_RE` без `@` откатывается на каждой позиции: 64 КБ stderr
  // вешали главный процесс на секунды (verify-ocr-v7 №3). Порог с запасом в десятки
  // раз: линейной форме на 100 КБ нужны миллисекунды.
  const text = "a.".repeat(50_000);
  const started = performance.now();
  redact(text, []);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `100 КБ без @ резались ${elapsed.toFixed(1)} мс`);
});

await test("секрет режется в percent-encoded, JSON-экранированной и base64 формах", () => {
  const token = "url/LLL+enc=9012";
  const json = 'jsonKKK"quoted"5678secret';
  const b64 = "base64MMM3456secret";

  const out = redact(
    [
      `url=${encodeURIComponent(token)}`,
      `escaped=${JSON.stringify(json).slice(1, -1)}`,
      `blob=${Buffer.from(b64, "utf8").toString("base64")}`,
      `blob-url=${Buffer.from(b64, "utf8").toString("base64url")}`,
    ].join("\n"),
    [token, json, b64],
  );

  for (const form of [
    ...secretForms(token),
    ...secretForms(json),
    ...secretForms(b64),
  ])
    assert.ok(!out.includes(form), `форма выжила: ${form}`);
});

await test("base64-форма с `+` и `/` режется: секрет с `>` и `?`", () => {
  // Секрет, у которого base64 отличается от base64url — тот самый случай, на котором
  // правило base64 нельзя было проверить узким алфавитом (слепая приёмка T21).
  const secret = "B6>4P?USMARKxyz";
  assert.equal(
    Buffer.from(secret, "utf8").toString("base64"),
    "QjY+NFA/VVNNQVJLeHl6",
    "контроль: base64 этой строки содержит `+` и `/`",
  );
  const out = redact(
    [
      `raw ${secret} end`,
      `b64 ${Buffer.from(secret, "utf8").toString("base64")} end`,
      `b64url ${Buffer.from(secret, "utf8").toString("base64url")} end`,
      `url ${encodeURIComponent(secret)} end`,
      `json ${JSON.stringify(secret).slice(1, -1)} end`,
    ].join("\n"),
    [secret],
  );

  for (const form of secretForms(secret))
    assert.ok(!out.includes(form), `форма выжила: ${form}`);
});

await test("строки многострочного значения режутся по отдельности", () => {
  const secret = "multiEEE7890\nmultiFFF1234";
  const out = redact(
    `whole ${secret} | line1 multiEEE7890 | line2 multiFFF1234`,
    [secret],
  );

  assert.ok(!out.includes("multiEEE7890"), out);
  assert.ok(!out.includes("multiFFF1234"), out);
});

await test("chat id рядом с percent-encoded меткой режется без .env", () => {
  const out = redact("https://api.telegram.org/x?chat_id%3D987654321&x=1", []);

  assert.ok(!out.includes("987654321"), out);
});

await test("длинная форма режется раньше короткой (иначе хвост секрета остаётся)", () => {
  // Контрпример слепой приёмки T21: при обратной сортировке от короткого к длинному
  // остаётся хвост `def67890tail` — короткий секрет съедает начало длинного.
  const out = redact("log abc12345def67890tail end", [
    "abc12345",
    "abc12345def67890tail",
  ]);

  assert.equal(out, `log ${REDACTED} end`);
});

await test("шаблонные правила работают без .env: id рядом с меткой и e-mail", () => {
  const out = redact(
    "turn tg:555000111222:43 chat_id=987654321 from=123456789 owner+iva@example.com",
    [],
  );

  assert.ok(!out.includes("555000111222"), out);
  assert.ok(!out.includes("987654321"), out);
  assert.ok(!out.includes("123456789"), out);
  assert.ok(!out.includes("owner+iva@example.com"), out);
  assert.match(out, /tg:<redacted>:43/u);
  assert.match(out, /chat_id=<redacted>/u);
});

await test("режется значение любого ключа, кроме настроечных", () => {
  const values = secretValuesFromEnv({
    TINY_KEY: "xq7",
    TINY_TOKEN: "a1",
    PIN_ID: "42",
    DB_PASSWORD: "p",
    SMTP_PASS: "pp",
    AUTH_SECRET: "s",
    ASSISTANT_BEARER: "b",
    TELEGRAM_API_HASH: "h",
    // Ключи без слова-приметы в имени: словарь слов оставлял их значения открытыми.
    PROXY: "socks5://puser:ppass5432@proxy.example.com:1080",
    CUSTOM_ENDPOINT: "https://endpoint.example.com/v1",
    SUPPORT_CHAT_URL: "https://t.me/+iva-support",
    SALT: "sss",
    OTP: "77",
    // Хост с владельцем и паролем — не настройка, как бы ни звалось имя.
    DB_HOST: "user:pw@db.example.com",
    AGENT_LANGUAGE: "ru",
    CUSTOM_REASONING: "1",
    MODEL_PROVIDER: "codex",
    ASSISTANT_DATA_DIR: "data",
    ASSISTANT_VAULT_DIR: "vault",
    ASSISTANT_TIMEZONE: "Asia/Almaty",
    ASSISTANT_HOST: "127.0.0.1",
    IVA_PORT: "8787",
    EMPTY_KEY: "   ",
    TELEGRAM_ALLOWED_USER_IDS: "555, 987654321",
    OLLAMA_API_KEY: "k".repeat(20),
  });

  for (const secret of [
    "xq7",
    "a1",
    "42",
    "p",
    "pp",
    "s",
    "b",
    "h",
    "socks5://puser:ppass5432@proxy.example.com:1080",
    // Пароль из URL — отдельной формой: в журнале он стоит словом, без URL вокруг.
    "ppass5432",
    "https://endpoint.example.com/v1",
    "https://t.me/+iva-support",
    "sss",
    "77",
    "user:pw@db.example.com",
    "pw",
    "k".repeat(20),
    "555",
    "987654321",
  ])
    assert.ok(
      values.includes(secret),
      `значение ключа не попало в список вырезания: ${secret}`,
    );
  for (const config of [
    "ru",
    "1",
    "codex",
    "data",
    "vault",
    "Asia/Almaty",
    "127.0.0.1",
    "8787",
    "",
    "   ",
  ])
    assert.ok(
      !values.includes(config),
      `настройка вырезается как секрет: ${JSON.stringify(config)}`,
    );
});

await test("служебные переменные systemd не режутся как секреты", () => {
  // Их нет в `.env`, но systemd кладёт их в окружение сервиса всегда: значение — не
  // секрет, а провал запуска расписания печатает pid и stream в хвост факта.
  const env = {
    MANAGERPID: "1234",
    SYSTEMD_EXEC_PID: "5678",
    JOURNAL_STREAM: "8:24680",
    INVOCATION_ID: "abcd0123456789abcd0123456789ab",
  } as const;
  const values = secretValuesFromEnv(env);
  for (const [name, value] of Object.entries(env))
    assert.ok(
      !values.includes(value),
      `служебная переменная вырезается как секрет: ${name}=${value}`,
    );
  const line = "rollup daily: 1234 cards written in 5678 ms, stream 8:24680";
  assert.equal(
    redact(line, values),
    line,
    "хвост запуска порезан служебными pid",
  );
});

/** Значение-проба: ни одного знака, по которому правило могло бы решить само. */
const PROBE = "ProbeValueQ9876";

await test("каждый ключ описи outbound-sensitive-keys.json режется", () => {
  const inventory: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../agent/skills/security-defense/outbound-sensitive-keys.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(
    Array.isArray(inventory) && inventory.length > 15,
    "опись не прочитана",
  );

  const missed = (inventory as string[]).filter(
    (key) => !secretValuesFromEnv({ [key]: PROBE }).includes(PROBE),
  );

  assert.deepEqual(missed, [], `ключ описи не режется: ${missed.join(", ")}`);
});

/**
 * Ключи `.env.example`, значения которых — настройка, а не секрет. Список пишется здесь
 * ЯВНО, а не считается тем же правилом: новый ключ в `.env.example` обязан либо попасть
 * сюда руками, либо резаться, и тест называет тот, который выпал из обоих случаев.
 */
const CONFIG_KEYS_IN_EXAMPLE = new Set([
  "AGENT_LANGUAGE",
  "MODEL_PROVIDER",
  "OLLAMA_MODEL",
  "OLLAMA_VISION_MODEL",
  "OLLAMA_CONTEXT_WINDOW",
  "OPENCODE_MODEL",
  "OPENCODE_VISION_MODEL",
  "OPENCODE_CONTEXT_WINDOW",
  "OPENROUTER_MODEL",
  "OPENROUTER_VISION_MODEL",
  "OPENROUTER_CONTEXT_WINDOW",
  "CODEX_MODEL",
  "CODEX_CONTEXT_WINDOW",
  "CLAUDE_MODEL",
  "CLAUDE_CONTEXT_WINDOW",
  "CLAUDE_COMMAND",
  "DEVIN_MODEL",
  "DEVIN_CONTEXT_WINDOW",
  "CUSTOM_MODEL",
  "CUSTOM_VISION_MODEL",
  "CUSTOM_CONTEXT_WINDOW",
  "CUSTOM_REASONING",
  "THINKING_EFFORT",
  "AGENT_BROWSER_MAX_OUTPUT",
  "TELEGRAM_BOT_USERNAME",
  "DEEPGRAM_LANGUAGE",
  "SEARCH_PROVIDER",
  "MEMORY_SEARCH_MODE",
  "ASSISTANT_TIMEZONE",
  "ASSISTANT_VAULT_DIR",
  "ASSISTANT_DATA_DIR",
  "IVA_PORT",
  "ASSISTANT_HOST",
]);

await test("каждый ключ .env.example либо назван настройкой, либо режется", () => {
  const example = readFileSync(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  const keys = [...example.matchAll(/^([A-Za-z_][A-Za-z\d_]*)=/gmu)].map(
    (match) => match[1],
  );
  assert.ok(
    keys.length > 30,
    `ключи .env.example не прочитаны: ${keys.length}`,
  );
  // Значения — настоящие из файла (тем же парсером, что читает живой `.env`):
  // синтетическая проба слепа к классам вроде `ASSISTANT_HOST=http://…` (T26).
  // Пустое/отсутствующее значение — проба: нейтральна к правилу по построению.
  const real = parseEnv(example);
  const valueOf = (key: string): string => {
    const raw = (real[key] ?? "").trim();
    return raw.length > 0 ? raw : PROBE;
  };

  const fell = keys.filter(
    (key) =>
      secretValuesFromEnv({ [key]: valueOf(key) }).includes(valueOf(key)) ===
      CONFIG_KEYS_IN_EXAMPLE.has(key),
  );

  assert.deepEqual(
    fell,
    [],
    `ключ .env.example выпал из правила (режется, хотя назван настройкой, либо наоборот): ${fell.join(", ")}`,
  );
});

await test("*_HOST со схемой и без userinfo — настройка, с userinfo — секрет", () => {
  const values = secretValuesFromEnv({
    ASSISTANT_HOST: "http://127.0.0.1:8723",
    SECURE_HOST: "https://example.com:8443",
    BARE_HOST: "example.com:8080",
    CREDS_HOST: "https://user:pass@example.com",
  });

  for (const setting of [
    "http://127.0.0.1:8723",
    "https://example.com:8443",
    "example.com:8080",
  ])
    assert.ok(
      !values.includes(setting),
      `настройка вырезается как секрет: ${setting}`,
    );
  assert.ok(
    values.includes("https://user:pass@example.com"),
    "userinfo в хосте не режется",
  );
  assert.ok(values.includes("pass"), "пароль из userinfo не вырезан отдельно");
});

await test("короткая форма режется только на границе слова", () => {
  const out = redact(
    "password p end and :p@ pair, but package and output stay",
    ["p"],
  );

  assert.match(out, /password <redacted> end/u);
  assert.match(out, /:<redacted>@/u);
  assert.ok(out.includes("package"), `слово разорвано: ${out}`);
  assert.ok(out.includes("output"), `слово разорвано: ${out}`);
});

// --- Ключи известных форматов (находка Q4 волны Trace) ----------------------------------------
// Ключа может не быть ни в `.env`, ни в `.env` плагина: модель вставила его в команду,
// инструмент напечатал чужой ключ. Он режется по виду, без списка секретов.

// Образцы хранятся задом наперёд и собираются при запуске: иначе защита GitHub от утечки
// секретов отвергает push с «ключами» в тексте теста.
const rev = (s: string): string => [...s].reverse().join("");

/** Каждый формат таблицы KEY_SHAPES: пример ключа и строка, в которой он едет в журнал. */
const KEY_EXAMPLES: ReadonlyArray<readonly [format: string, key: string]> = [
  ["OpenAI", rev("76543210fEdCbA9876543210fEdCbA9876543210fEdCbA-ks")],
  ["OpenAI project", rev("87RQ65po43NM21lk09JI87hg65FE-43dc_21bA-jorp-ks")],
  ["Anthropic", rev("eF0gH1iJ2kL3mN4oP5qR6sT7uV-8wY_9xZ-30ipa-tna-ks")],
  ["OpenRouter", rev("fedcba9876543210fedcba9876543210-1v-ro-ks")],
  ["GitHub ghp_", rev("8r7Q6p5O4n3M2l1K0j9I8h7G6f5E4d3C2b1A_phg")],
  ["GitHub gho_", rev("8r7Q6p5O4n3M2l1K0j9I8h7G6f5E4d3C2b1A_ohg")],
  ["GitHub ghu_", rev("8r7Q6p5O4n3M2l1K0j9I8h7G6f5E4d3C2b1A_uhg")],
  ["GitHub ghs_", rev("8r7Q6p5O4n3M2l1K0j9I8h7G6f5E4d3C2b1A_shg")],
  ["GitHub ghr_", rev("8r7Q6p5O4n3M2l1K0j9I8h7G6f5E4d3C2b1A_rhg")],
  [
    "GitHub fine-grained",
    rev("JIHGFEDCBAzyxwvutsrqponmlkjihgfedcba_9876543210GFEDCBA11_tap_buhtig"),
  ],
  ["Slack xoxb", rev("xWvUtSrQpOnMlKjIhGfEdCbA-3210987654321-0987654321-bxox")],
  ["Slack xoxp", rev("lKjIhGfEdCbA-3210987654321-0987654321-pxox")],
  ["Slack xoxa", rev("lKjIhGfEdCbA-0987654321-2-axox")],
  ["Slack xoxr", rev("lKjIhGfEdCbA-0987654321-rxox")],
  ["Slack xoxs", rev("lKjIhGfEdCbA-0987654321-sxox")],
  ["AWS", rev("ELPMAXE7NNDOFSOIAIKA")],
  ["Telegram bot", rev("QwasDLAP5K0sASfoeSfxJWGv1HCvcTqdHAA:987654321")],
  ["Google", rev("YWBMFkj0WSZe7a-XMnMQuoP27ekrSt9-DySazIA")],
  [
    "JWT",
    rev(
      "U8RsHT0PUFlP9I3n0LgX_N5w0lHNmVj3J4PyrNgjzod.0nIwkDO3YTN0MjMxIiOiIWdzJye.9JiN1IzUIJiOicGbhJye",
    ),
  ],
  ["Bearer", rev("==v-w/z+y~x.AM5gzN2UDNzITMtUkQBJURGF0Q")],
];

await test("каждый формат ключа режется без .env: отдельным словом, в URL, в JSON и в заголовке", () => {
  for (const [format, key] of KEY_EXAMPLES) {
    const bearer = format === "Bearer";
    for (const line of bearer
      ? [`Authorization: Bearer ${key}`, `{"authorization":"bearer ${key}"}`]
      : [
          `curl: (22) 401 ${key} rejected`,
          `GET https://api.example.com/v1/x?key=${key}&q=1`,
          `{"token":"${key}","ok":false}`,
          `export TOKEN=${key}`,
        ]) {
      const out = redact(line, []);
      assert.ok(!out.includes(key), `${format}: ключ выжил в «${out}»`);
      assert.ok(out.includes(REDACTED), `${format}: нет пометки в «${out}»`);
    }
  }
  assert.equal(
    redact(`Authorization: Bearer ${KEY_EXAMPLES[0][1]}`, []),
    `Authorization: Bearer ${REDACTED}`,
    "примета Bearer остаётся перед пометкой",
  );
  assert.equal(
    redact(`url ${KEY_EXAMPLES[16][1]}/sendMessage`, []),
    `url ${REDACTED}/sendMessage`,
  );
});

/** Строки, похожие на ключ, но не ключ: обязаны остаться целыми. */
const NOT_KEYS: readonly string[] = [
  "9f27c3a6d1e5b2c4a8f0e3d7b6c5a4f3e2d1c0b9",
  "commit 61470125 docs(skills): only under a one-item message",
  "https://github.com/smixs/iva-agent/issues/new?title=x&body=y",
  "load the skills folder",
  "skills",
  "sk-learn",
  "risk-adjusted-return-for-the-whole-portfolio-of-assets",
  "task-scheduler-component-with-a-very-long-name",
  "Bearer token is missing",
  "the bearer of this note",
  "AKIA123",
  "ghp_short",
  "xoxb-123",
  "eyJhbGciOiJIUzI1NiJ9",
  "550e8400-e29b-41d4-a716-446655440000",
  "2026-10-06T09:36:00.000Z 12:30:45",
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
];

await test("похожее на ключ, но не ключ, остаётся целым: хеш коммита, адрес без ключа, слово skills", () => {
  for (const text of NOT_KEYS) assert.equal(redact(text, []), text);
});

const base64url = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
];
const alnum = base64url.slice(0, 62);
function chars(
  alphabet: readonly string[],
  minLength: number,
  maxLength = minLength,
) {
  return fc.string({
    unit: fc.constantFrom(...alphabet),
    minLength,
    maxLength,
  });
}
function prefixed(
  prefixes: readonly string[],
  body: fc.Arbitrary<string>,
): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...prefixes), body)
    .map(([prefix, rest]) => `${prefix}${rest}`);
}
const digits = [..."0123456789"];

/** Ключ каждого формата и то, что после вырезания стоит на его месте. */
const keyArb: fc.Arbitrary<{ readonly key: string; readonly cut: string }> =
  fc.oneof(
    ...[
      prefixed(
        ["sk-", "sk-proj-", "sk-ant-api03-", "sk-or-v1-"],
        chars(base64url, 20, 60),
      ),
      prefixed(["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], chars(alnum, 20, 40)),
      prefixed(["github_pat_"], chars([...alnum, "_"], 22, 82)),
      prefixed(
        ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"],
        chars([...alnum, "-"], 10, 50),
      ),
      prefixed(
        ["AKIA"],
        chars([...digits, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"], 16),
      ),
      fc
        .tuple(chars(digits, 8, 10), chars(base64url, 35))
        .map(([id, secret]) => `${id}:${secret}`),
      prefixed(["AIza"], chars(base64url, 35)),
      fc
        .tuple(
          chars(base64url, 5, 40),
          chars(base64url, 5, 40),
          chars(base64url, 1, 43),
        )
        .map(([head, body, sign]) => `eyJ${head}.eyJ${body}.${sign}`),
    ].map((arb) => arb.map((key) => ({ key, cut: REDACTED }))),
    fc
      .tuple(
        chars([...alnum, ..."._~+/-"], 16, 40),
        fc.constantFrom("", "=", "=="),
      )
      .map(([value, pad]) => ({
        key: `${value}${pad}`,
        cut: `Bearer ${REDACTED}`,
      })),
  );

/** Текст без ключей: слова, хеши коммитов, uuid, короткие числа и строки-обманки. */
const fillerArb = fc.oneof(
  chars([..."abcdefghijklmnopqrstuvwxyz"], 1, 12).filter(
    (word) => word !== "bearer",
  ),
  chars([..."0123456789abcdef"], 40),
  fc.uuid(),
  fc.nat({ max: 9999 }).map(String),
  fc.constantFrom(...NOT_KEYS),
);
const separatorArb = fc.constantFrom(" ", "\n", ", ", '"', " | ");

await test(`PBT: ни один сгенерированный ключ не выживает, текст вокруг не меняется (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.oneof(
            keyArb.map((piece) => ({
              ...piece,
              bearer: piece.cut !== REDACTED,
            })),
            fillerArb.map((text) => ({ key: text, cut: text, bearer: false })),
          ),
          separatorArb,
        ),
        { minLength: 1, maxLength: 12 },
      ),
      (pieces) => {
        const text = pieces
          .map(
            ([{ key, bearer }, sep]) =>
              `${bearer ? "Bearer " : ""}${key}${sep}`,
          )
          .join("");
        const expected = pieces
          .map(([{ cut }, sep]) => `${cut}${sep}`)
          .join("");
        const out = redact(text, []);
        for (const [{ key, cut }] of pieces)
          if (cut !== key)
            assert.ok(!out.includes(key), `ключ ${key} выжил в «${out}»`);
        assert.equal(out, expected);
        assert.equal(
          redact(out, []),
          out,
          "второй проход вырезания ничего не меняет",
        );
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});

await test(`PBT: текст без ключей не меняется (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(fillerArb, fc.constantFrom(" ", "\n", "/", "=", "&", ", ")),
        {
          maxLength: 30,
        },
      ),
      (pieces) => {
        const text = pieces.map(([word, sep]) => `${word}${sep}`).join("");
        assert.equal(redact(text, []), text);
      },
    ),
    { seed: SEED, numRuns: 500 },
  );
});

await test("враждебный ввод без ключа не тормозит: 100 КБ каждой заготовки быстрее 100 мс", () => {
  for (const unit of [
    "eyJ",
    "eyJa.",
    "sk-",
    "ghp_",
    "xoxb-",
    "AKIA",
    "Bearer  ",
    "1",
  ]) {
    const text = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = performance.now();
    redact(text, []);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${unit}×: ${elapsed.toFixed(1)} мс`);
  }
});
