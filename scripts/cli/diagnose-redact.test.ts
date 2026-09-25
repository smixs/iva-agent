// Правила вырезания: сырое значение, формы, в которых секрет попадает в журнал
// (percent-encoded, JSON-экранированное, base64/base64url), шаблонные правила (токен бота
// в любом месте строки, личный id рядом с меткой, e-mail), порядок «от длинного к
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
  "CUSTOM_MODEL",
  "CUSTOM_VISION_MODEL",
  "CUSTOM_CONTEXT_WINDOW",
  "CUSTOM_REASONING",
  "REQUESTY_MODEL",
  "REQUESTY_VISION_MODEL",
  "REQUESTY_CONTEXT_WINDOW",
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
