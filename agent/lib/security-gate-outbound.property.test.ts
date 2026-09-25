// Свойства outbound-гейта: любой ключ любого класса, посаженный в произвольный
// текст ответа, обязан уехать из чата вымаранным, а сам ответ — уцелеть.
//
// Ключи собираются здесь по форме, которую выдаёт провайдер (префикс, алфавит,
// длина), а не по регуляркам гейта: генератор описывает ключ, гейт его ищет. Текст
// вокруг — случайный, потому что утечка приходит не в стерильной строке, а посреди
// абзаца, лога или кода.
//
// Seed фиксирован и печатается в имени теста: падение воспроизводится запуском с
// IVA_TEST_SEED=<seed>.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import secretKeyInventory from "../skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import { scanOutbound } from "./security-gate.ts";

const SEED = Number(process.env.IVA_TEST_SEED ?? 20260814) >>> 0 || 1;
const ROUNDS = 5; // × число классов ключей — сколько всего случаев

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIGITS = "0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${DIGITS}${LOWER}${UPPER}`;

function chars(random: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++)
    out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

function between(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// Формы ключей всех провайдеров, с которыми эта инсталляция разговаривает, плюс
// безымянные носители секрета: имя рядом, Bearer и креды в адресе.
const KEY_SHAPES: ReadonlyArray<{
  name: string;
  make: (random: () => number) => string;
}> = [
  { name: "openai", make: (r) => `sk-${chars(r, ALNUM, between(r, 20, 40))}` },
  {
    name: "openrouter",
    make: (r) => `sk-or-v1-${chars(r, `${ALNUM}_-`, between(r, 24, 48))}`,
  },
  {
    name: "requesty",
    make: (r) => `rqsty-${chars(r, `${ALNUM}+/=_-`, between(r, 24, 60))}`,
  },
  {
    name: "anthropic",
    make: (r) => `sk-ant-api03-${chars(r, `${ALNUM}_-`, between(r, 24, 60))}`,
  },
  { name: "groq", make: (r) => `gsk_${chars(r, ALNUM, between(r, 20, 40))}` },
  {
    name: "jina",
    make: (r) => `jina_${chars(r, `${ALNUM}_-`, between(r, 20, 40))}`,
  },
  {
    name: "jwt",
    make: (r) =>
      `eyJ${chars(r, `${ALNUM}_-`, between(r, 12, 30))}.${chars(r, `${ALNUM}_-`, between(r, 12, 40))}.${chars(r, `${ALNUM}_-`, between(r, 12, 40))}`,
  },
  { name: "google_api", make: (r) => `AIza${chars(r, `${ALNUM}-_`, 35)}` },
  { name: "github_pat", make: (r) => `ghp_${chars(r, ALNUM, 36)}` },
  {
    name: "github_fine",
    make: (r) => `github_pat_${chars(r, `${ALNUM}_`, 82)}`,
  },
  {
    name: "slack_bot",
    make: (r) =>
      `xoxb-${chars(r, DIGITS, between(r, 10, 13))}-${chars(r, ALNUM, between(r, 20, 32))}`,
  },
  {
    name: "slack_user",
    make: (r) =>
      `xoxp-${chars(r, DIGITS, between(r, 10, 13))}-${chars(r, ALNUM, between(r, 20, 32))}`,
  },
  {
    name: "telegram_bot",
    make: (r) =>
      `${chars(r, DIGITS, between(r, 8, 10))}:${chars(r, `${ALNUM}_-`, 35)}`,
  },
  {
    name: "aws_access",
    make: (r) => `AKIA${chars(r, `${UPPER}${DIGITS}`, 16)}`,
  },
  {
    name: "stripe",
    make: (r) =>
      `sk_${r() < 0.5 ? "live" : "test"}_${chars(r, ALNUM, between(r, 24, 40))}`,
  },
  {
    name: "sendgrid",
    make: (r) =>
      `SG.${chars(r, `${ALNUM}_-`, 22)}.${chars(r, `${ALNUM}_-`, 43)}`,
  },
  {
    name: "vercel",
    make: (r) => `vercel_${chars(r, `${ALNUM}_`, between(r, 20, 40))}`,
  },
  {
    name: "supabase",
    make: (r) => `sbp_${chars(r, ALNUM, between(r, 40, 56))}`,
  },
  {
    name: "fal_key",
    make: (r) => `fal_${chars(r, `${ALNUM}_`, between(r, 20, 40))}`,
  },
  {
    name: "bearer_token",
    make: (r) => `Bearer ${chars(r, `${ALNUM}-._~+/`, between(r, 20, 48))}`,
  },
  {
    name: "generic_key",
    make: (r) =>
      `${r() < 0.5 ? "OLLAMA_API_KEY" : "api key"}${r() < 0.5 ? "=" : ": "}${chars(r, `${ALNUM}-._`, between(r, 20, 40))}`,
  },
  {
    name: "generic_secret",
    make: (r) =>
      `${r() < 0.5 ? "password" : "secret"}=${chars(r, ALNUM, between(r, 8, 24))}`,
  },
];

// Текст вокруг ключа: обычные слова, перевод строки, скобки, кавычки. Разделитель
// перед ключом всегда не буквенно-цифровой — так секрет и приезжает в реальном
// сообщении (после «: », пробела, перевода строки), и так его не склеивает с
// соседним словом.
const WORDS = [
  "деплой",
  "лог",
  "config",
  "ответ",
  "value",
  "env",
  "смотри",
  "output",
  "строка",
  "check",
];
const SEPARATORS = [" ", "\n", ": ", " = ", ' "', " (", "\n> ", ", "];
const SENTINEL = "ostalnoy-tekst-otveta";

const namedSecretValue = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 12, maxLength: 48 })
  .map((chars) => `synthetic${chars.join("")}`);
const namedSecretCarrier = fc.constantFrom(
  (name: string, value: string) => `${name}=${value}`,
  (name: string, value: string) => `${name}: '${value}'`,
  (name: string, value: string) => JSON.stringify({ [name]: value }),
);

function wrap(random: () => number, secret: string): string {
  const before: string[] = [SENTINEL];
  for (let i = 0; i < between(random, 0, 6); i++)
    before.push(WORDS[Math.floor(random() * WORDS.length)]);
  const after: string[] = [];
  for (let i = 0; i < between(random, 0, 6); i++)
    after.push(WORDS[Math.floor(random() * WORDS.length)]);
  const separator = SEPARATORS[Math.floor(random() * SEPARATORS.length)];
  // Справа всегда пробельный разделитель: иначе хвост текста попадает внутрь
  // самого совпадения и вымарывается вместе с ключом — это поведение гейта, а не
  // свойство, которое здесь проверяется.
  return `${before.join(" ")}${separator}${secret} ${after.join(" ")} ${SENTINEL}`;
}

await test("every canonical secret key redacts every generated synthetic value", () => {
  for (const name of secretKeyInventory) {
    fc.assert(
      fc.property(namedSecretValue, namedSecretCarrier, (value, carrier) => {
        const input = carrier(name, value);
        const scanned = scanOutbound(input);
        assert.equal(scanned.clean, false, `${name}: no finding for ${input}`);
        assert.ok(
          scanned.findings.some((finding) => finding.name === "named_secret"),
          `${name}: canonical named_secret rule did not match`,
        );
        assert.equal(
          scanned.text.includes(value),
          false,
          `${name}: value leaked`,
        );
        assert.match(scanned.text, /\[REDACTED\]/u, `${name}: no redaction`);
      }),
      { numRuns: 30, seed: SEED },
    );
  }
});

await test(`ключ любого класса не уезжает в чат целым (seed=${SEED})`, () => {
  const random = makeRandom(SEED);
  for (let round = 0; round < ROUNDS; round++) {
    for (const shape of KEY_SHAPES) {
      const secret = shape.make(random);
      const message = wrap(random, secret);
      const scanned = scanOutbound(message);
      const where = `${shape.name} round ${round} (seed=${SEED})`;

      assert.ok(!scanned.clean, `${where}: гейт не увидел ключ`);
      assert.ok(
        scanned.findings.length > 0,
        `${where}: нет ни одной находки в логе`,
      );
      assert.ok(
        !scanned.text.includes(secret),
        `${where}: ключ уехал целым: ${scanned.text}`,
      );
      assert.ok(
        scanned.text.includes("[REDACTED]"),
        `${where}: нет пометки о замене`,
      );
      // Ответ не проглатывается целиком: владелец обязан получить свой текст.
      assert.ok(
        scanned.text.includes(SENTINEL),
        `${where}: вместе с ключом вымарало весь ответ`,
      );
    }
  }
});

// Контроль: без посаженного ключа тот же генератор обёрток обязан давать чистый
// ответ. Без этого свойства выше держались бы и на гейте, который вымарывает всё
// подряд, — а такой гейт съедал бы обычные ответы владельца.
await test(`обычный ответ без ключей гейт не трогает (seed=${SEED})`, () => {
  const random = makeRandom(SEED ^ 0x27d4eb2f);
  for (let i = 0; i < 60; i++) {
    const filler = chars(random, `${LOWER}${UPPER}`, between(random, 3, 12));
    const message = wrap(random, filler);
    const scanned = scanOutbound(message);
    assert.ok(
      scanned.clean,
      `case ${i} (seed=${SEED}): ложная находка ${JSON.stringify(scanned.findings)} в «${message}»`,
    );
    assert.equal(
      scanned.text,
      message,
      `case ${i} (seed=${SEED}): текст изменён`,
    );
  }
});

// Секрет в адресе: userinfo вымарывается, а хост остаётся — иначе сообщение о
// сбойном вызове перестаёт говорить, какой вызов сбоил.
await test(`креды в адресе вымарываются, хост остаётся (seed=${SEED})`, () => {
  const random = makeRandom(SEED ^ 0xc2b2ae35);
  for (let i = 0; i < 40; i++) {
    const password = chars(random, `${ALNUM}-_`, between(random, 8, 32));
    const user =
      random() < 0.3 ? "" : chars(random, LOWER, between(random, 3, 9));
    const host = `${chars(random, LOWER, between(random, 3, 10))}.example.com`;
    const message = wrap(
      random,
      `https://${user}:${password}@${host}/v1/embeddings`,
    );
    const scanned = scanOutbound(message);
    const where = `case ${i} (seed=${SEED})`;

    assert.ok(!scanned.clean, `${where}: гейт не увидел креды в адресе`);
    assert.ok(
      !scanned.text.includes(password),
      `${where}: пароль уехал целым: ${scanned.text}`,
    );
    assert.ok(scanned.text.includes(host), `${where}: пропал хост`);
    assert.ok(scanned.text.includes(SENTINEL), `${where}: вымарало весь ответ`);
  }
});
