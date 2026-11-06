import "../../scripts/fixtures/no-host-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import secretKeyInventory from "../skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import { scanOutbound } from "./security-gate.ts";
import {
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";

const env = {
  ASSISTANT_BEARER: "fixtureBearerValueWithoutPrefix",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "fixtureWebhookValueWithoutPrefix",
  OLLAMA_API_KEY: "fixtureOllamaValueWithoutPrefix",
  DEEPGRAM_API_KEY: "fixtureDeepgramValueWithoutPrefix",
  TELEGRAM_API_HASH: "fixtureTelegramHashWithoutPrefix",
  TELEGRAM_WATCH_TOKEN: "fixtureWatchValueWithoutPrefix",
};

await test("secret-like .env.example keys, including commented keys, are inventoried", () => {
  const example = readFileSync(
    new URL("../../.env.example", import.meta.url),
    "utf8",
  );
  const settings = new Map([
    ["CLAUDE_SESSION_CWD", "CLI working directory for prompt caching"],
    ["DEEPGRAM_KEYTERMS", "speech-recognition vocabulary"],
  ]);
  const keys = [
    ...example.matchAll(/^\s*(?:#\s*)?([A-Za-z_][A-Za-z\d_]*)\s*=/gmu),
  ].map((match) => match[1]);
  assert.ok(keys.length > 30, "read the installation keys");
  const missing = keys.filter(
    (key) =>
      /TOKEN|KEY|SECRET|PASSWORD|BEARER|SESSION|HASH/u.test(key) &&
      !settings.has(key) &&
      !secretKeyInventory.includes(key),
  );
  assert.deepEqual(
    missing,
    [],
    `missing outbound secrets: ${missing.join(", ")}`,
  );
});

function fixture(t: test.TestContext) {
  for (const name of new Set([...secretKeyInventory, ...Object.keys(env)])) {
    const before = process.env[name];
    const value = env[name as keyof typeof env];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}
await test("installation secrets are gated bare, in code and Markdown tables", async (t) => {
  fixture(t);
  for (const [name, value] of Object.entries(env)) {
    for (const [index, input] of [
      value,
      `\`\`\`\n${value}\n\`\`\``,
      `| ${name} | ${value} |`,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
    ].entries()) {
      await t.test(`${name} carrier ${index}`, () => {
        assert.notEqual(redact(input, secretValuesFromEnv(env)), input);
        const output = scanOutbound(input);
        assert.equal(output.clean, false, `${name}: secret passed`);
        assert.equal(output.text.includes(value), false);
        assert.equal(scanOutbound(input, false).text, input);
      });
    }
  }
});
await test("installation secrets inside Spark deep links are redacted", (t) => {
  fixture(t);
  for (const value of Object.values(env)) {
    const input = `https://sparkmailapp.com/dpl/bl?token=${value}`;
    const result = scanOutbound(input);
    assert.equal(result.clean, false);
    assert.equal(
      result.text,
      "https://sparkmailapp.com/dpl/bl?token=[REDACTED]",
    );
    assert.ok(
      result.findings.some((finding) => finding.name === "installation_secret"),
    );
  }
});

await test("ordinary replies survive installation-secret checks (seed 101301)", (t) => {
  fixture(t);
  const before = process.env.IVA_QA_ORDINARY_OUTPUT;
  process.env.IVA_QA_ORDINARY_OUTPUT =
    "ordinaryOutputValueFromNonCredentialEnv";
  t.after(() => {
    if (before === undefined) delete process.env.IVA_QA_ORDINARY_OUTPUT;
    else process.env.IVA_QA_ORDINARY_OUTPUT = before;
  });
  const ordinaryText = fc
    .string({ unit: "grapheme", maxLength: 200 })
    .map((text) => JSON.stringify({ text }));
  fc.assert(
    fc.property(
      ordinaryText,
      fc.uuid(),
      fc.uint8Array({ minLength: 20, maxLength: 80 }),
      (prose, uuid, bytes) => {
        const text = `${prose}\nconst id = '${uuid}';\n${Buffer.from(bytes).toString("hex")}\ndata:image/png;base64,${Buffer.from(bytes).toString("base64")}\nhttps://example.com/${uuid}\nordinaryOutputValueFromNonCredentialEnv\n<redacted>`;
        assert.equal(scanOutbound(text).clean, true);
        assert.equal(scanOutbound(text).text, text);
      },
    ),
    { seed: 101301, numRuns: 300 },
  );
});

await test("installation placeholders leave ordinary words and numbers intact", (t) => {
  fixture(t);
  const before = process.env.CUSTOM_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.CUSTOM_API_KEY;
    else process.env.CUSTOM_API_KEY = before;
  });
  const text =
    "EMPTY NONEMPTY none 1 файл, версия 1.2; npm test, latest; https://ollama.com/library " +
    "x".repeat(20);
  for (const value of [
    "EMPTY",
    "none",
    "1",
    "ollama",
    "test",
    "x".repeat(20),
  ]) {
    process.env.CUSTOM_API_KEY = value;
    assert.equal(scanOutbound(text).text, text);
  }
});

await test("full installation value is removed before partial shape matches", (t) => {
  fixture(t);
  const before = process.env.ASSISTANT_BEARER;
  t.after(() => {
    if (before === undefined) delete process.env.ASSISTANT_BEARER;
    else process.env.ASSISTANT_BEARER = before;
  });
  for (const value of [
    "fixture!en#with$chars%20long",
    "sk-" + "a".repeat(24) + ".tail-part-of-key",
  ]) {
    process.env.ASSISTANT_BEARER = value;
    const input = `Bearer ${value}`;
    assert.equal(scanOutbound(input, false).text, input);
    assert.equal(scanOutbound(input).text, "Bearer [REDACTED]");
  }
});

await test("secret length boundaries 11, 12 and 13 apply to the outbound gate", (t) => {
  fixture(t);
  for (const length of [11, 12, 13]) {
    const value = "a" + "b".repeat(length - 1);
    process.env.CUSTOM_API_KEY = value;
    const text = `plain ${value}`;
    const answer = scanOutbound(text);
    assert.equal(answer.clean, length === 11, `length ${length}`);
    assert.equal(answer.text, length === 11 ? text : "plain [REDACTED]");
  }
});
