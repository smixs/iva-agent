import "./fixtures/no-host-env.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { execFileSync } from "node:child_process";
import type { ToolContext } from "eve/tools";
import inventory from "../agent/skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };

const root = mkdtempSync(join(tmpdir(), "iva-send-file-repair-"));
mkdirSync(join(root, "attachments"));
const saved = { ...process.env };
for (const name of inventory) delete process.env[name];
process.env.TELEGRAM_BOT_TOKEN = "fixtureTransportTokenForQA";
process.env.ASSISTANT_BEARER = "fixtureFileSecretWithPunctuation!#$";
process.env.ASSISTANT_VAULT_DIR = root;
after(() => {
  for (const name of [...inventory, "ASSISTANT_VAULT_DIR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});
const { sendFile, default: sendFileTool } =
  await import("../agent/tools/send_file.ts");
const secret = process.env.ASSISTANT_BEARER;
const chat = { id: "1", threadId: null };

void test("file value check rejects binary and encoded copies and names the variable (seed 101313)", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(new Response('{"ok":true}'));
  });
  const carriers = [
    Buffer.from(`ASSISTANT_BEARER=${secret}\n\0`),
    Buffer.concat([
      Buffer.from(`ASSISTANT_BEARER=${secret}`),
      Buffer.from([255]),
    ]),
    Buffer.concat([
      Buffer.from([207, 240, 232, 226, 229, 242]),
      Buffer.from(`\nASSISTANT_BEARER=${secret}`),
    ]),
    Buffer.from(`ASSISTANT_BEARER=${secret}`, "utf16le"),
  ];
  // Offset crosses the search chunk boundary; arbitrary binary prefixes exercise every alignment.
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 100 }),
      fc.integer({ min: 0, max: carriers.length - 1 }),
      async (prefix, carrier) => {
        const bytes = Buffer.concat([
          Buffer.from(prefix),
          Buffer.alloc(65500, 255),
          carriers[carrier],
        ]);
        const path = join(root, "attachments", "copy.bin");
        writeFileSync(path, bytes);
        const result = await sendFile({ path }, chat);
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.error, /ASSISTANT_BEARER/u);
        assert.equal(JSON.stringify(result).includes(secret), false);
      },
    ),
    {
      seed: 101313,
      numRuns: 30,
      examples: carriers.map((_, index): [Uint8Array, number] => [
        new Uint8Array(),
        index,
      ]),
    },
  );
  assert.equal(calls, 0);
});

void test("honest documents and unknown key shapes preserve their bytes", async (t) => {
  let document: File | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    (_url: string, init: { body: FormData }) => {
      const value = init.body.get("document");
      assert.ok(value instanceof File);
      document = value;
      return Promise.resolve(new Response('{"ok":true}'));
    },
  );
  const repo = join(import.meta.dirname, "..");
  const sources: [string, Buffer][] = [
    ...["CHANGELOG.md", ".env.example", "docs/security.md"].map(
      (path): [string, Buffer] => [
        path.split("/").at(-1)!,
        readFileSync(join(repo, path)),
      ],
    ),
    [
      "notes.txt",
      Buffer.from(
        "He was the bearer of bad news.\nPassword: ********\nOLLAMA_API_KEY=\nOLLAMA_MODEL=glm-5",
      ),
    ],
    ["unknown.bin", Buffer.from(`\0sk-${"x".repeat(30)}`)],
    [
      "links.json",
      Buffer.from(
        JSON.stringify(
          Array.from(
            { length: 20000 },
            (_, i) => `https://example.com/items/${i}/photo.jpg`,
          ),
        ),
      ),
    ],
  ];
  for (const [name, bytes] of sources) {
    const path = join(root, "attachments", name);
    writeFileSync(path, bytes);
    const started = performance.now();
    assert.equal((await sendFile({ path }, chat)).ok, true, name);
    if (name === "links.json") {
      const ms = performance.now() - started;
      t.diagnostic(`20000 URLs: ${bytes.length} bytes, ${ms.toFixed(2)} ms`);
      assert.ok(ms < 1000);
    }
    assert.ok(document);
    assert.deepEqual(Buffer.from(await document.arrayBuffer()), bytes);
  }
});

void test("50 MiB file check returns the right result and yields within 50 ms", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const path = join(root, "attachments", "large.bin");
  writeFileSync(path, Buffer.alloc(50 * 1024 * 1024, 97));
  const start = performance.now();
  let last = start;
  let gap = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
    ticks++;
  }, 1);
  let answer;
  try {
    answer = await sendFile({ path }, chat);
  } finally {
    gap = Math.max(gap, performance.now() - last);
    clearInterval(timer);
  }
  const elapsed = performance.now() - start;
  t.diagnostic(
    `50 MiB: ${elapsed.toFixed(2)} ms, max pause ${gap.toFixed(2)} ms, ticks ${ticks}`,
  );
  assert.deepEqual(answer, {
    ok: true,
    name: "large.bin",
    bytes: 50 * 1024 * 1024,
    message_id: null,
  });
  assert.ok(ticks > 0);
  assert.ok(gap < 50, `event-loop pause ${gap}ms`);
});

void test("installation settings preserve documents while listed credentials refuse delivery", async (t) => {
  const settings = {
    OPENCODE_PROTOCOL: "chat-completions",
    CUSTOM_BASE_URL: "http://localhost:11434/v1",
    TELEGRAM_DIGEST_CHAT_ID: "-100123456789012",
    DEEPGRAM_KEYTERMS: "Ordinary Project Names",
    ASSISTANT_GRAPH_PATH: "/home/user/iva/graph.json",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    MY_PLUGIN_TOKEN: "fixtureValueOutsideTheInventory",
  };
  const before = { ...process.env };
  Object.assign(process.env, settings);
  t.after(() => {
    for (const name of Object.keys(settings)) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
  const sent: Buffer[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: { body: FormData }) => {
      const document = init.body.get("document");
      assert.ok(document instanceof File);
      sent.push(Buffer.from(await document.arrayBuffer()));
      return new Response('{"ok":true}');
    },
  );
  for (const source of [
    ".env.example",
    "docs/providers.md",
    "docs/configuration.md",
  ]) {
    const bytes = readFileSync(join(import.meta.dirname, "..", source));
    const path = join(root, "attachments", source.split("/").at(-1)!);
    writeFileSync(path, bytes);
    assert.equal((await sendFile({ path }, chat)).ok, true, source);
    assert.deepEqual(sent.at(-1), bytes);
  }
  const path = join(root, "attachments", "settings.txt");
  const bytes = Buffer.from(Object.values(settings).join("\n"));
  writeFileSync(path, bytes);
  assert.equal((await sendFile({ path }, chat)).ok, true);
  assert.deepEqual(sent.at(-1), bytes);
  writeFileSync(path, secret);
  const refused = await sendFile({ path }, chat);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /ASSISTANT_BEARER/u);
  assert.equal(sent.length, 4);
});

void test("Watch proxy credentials refuse file delivery", async (t) => {
  const before = process.env.TELEGRAM_WATCH_TOKEN;
  const token = "fixtureWatchValueWithoutPrefix";
  process.env.TELEGRAM_WATCH_TOKEN = token;
  t.after(() => {
    if (before === undefined) delete process.env.TELEGRAM_WATCH_TOKEN;
    else process.env.TELEGRAM_WATCH_TOKEN = before;
  });
  const fetch = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const path = join(root, "attachments", "watch.txt");
  writeFileSync(path, token);
  const result = await sendFile({ path }, chat);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /TELEGRAM_WATCH_TOKEN/u);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(fetch.mock.callCount(), 0);
});

void test("secret length boundaries 11, 12 and 13 apply to actual file delivery", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const before = process.env.CUSTOM_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.CUSTOM_API_KEY;
    else process.env.CUSTOM_API_KEY = before;
  });
  const path = join(root, "attachments", "boundary.txt");
  for (const length of [11, 12, 13]) {
    const value = "a" + "b".repeat(length - 1);
    process.env.CUSTOM_API_KEY = value;
    writeFileSync(path, value);
    const answer = await sendFile({ path }, chat);
    assert.equal(answer.ok, length === 11, `length ${length}`);
    if (!answer.ok) assert.match(answer.error, /CUSTOM_API_KEY/u);
  }
});

void test("file verification hears cancellation at its first chunk yield before fetch", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(new Response('{"ok":true}'));
  });
  const path = join(root, "attachments", "cancel.bin");
  writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 97));
  const controller = new AbortController();
  let yields = 0;
  const immediate = globalThis.setImmediate;
  t.mock.method(globalThis, "setImmediate", (callback: () => void) =>
    immediate(() => {
      yields++;
      controller.abort();
      callback();
    }),
  );
  const answer = await sendFileTool.execute({ path }, {
    abortSignal: controller.signal,
    session: { auth: { current: { attributes: { chat_id: "1" } } } },
  } as unknown as ToolContext);
  assert.ok(yields > 0);
  assert.ok("ok" in answer);
  assert.equal(answer.ok, false);
  assert.match(answer.ok ? "" : answer.error, /отправка отменена/u);
  assert.equal(calls, 0);
});

void test("environment fixture removes inherited settings and arbitrary variables", () => {
  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      join(import.meta.dirname, "fixtures", "no-host-env.ts"),
      "--input-type=module",
      "-e",
      'console.log(JSON.stringify(Object.keys(process.env).filter(k => !["PATH","HOME","TMPDIR","TMP","TEMP","SystemRoot","NODE_TEST_CONTEXT"].includes(k))))',
    ],
    {
      env: {
        ...process.env,
        OPENCODE_PROTOCOL: "chat-completions",
        ARBITRARY_HOST_VALUE: "ordinaryOutputFromTheMachine",
        ANTHROPIC_API_KEY: "fixtureInheritedKey",
      },
      encoding: "utf8",
    },
  );
  assert.deepEqual(JSON.parse(stdout), []);
});

void test("placeholder credentials do not reject an ordinary file", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response('{"ok":true}')),
  );
  const before = process.env.CUSTOM_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.CUSTOM_API_KEY;
    else process.env.CUSTOM_API_KEY = before;
  });
  const path = join(root, "attachments", "placeholders.txt");
  writeFileSync(
    path,
    "EMPTY NONEMPTY none 1 файл; npm test; https://ollama.com/library " +
      "x".repeat(20),
  );
  for (const value of [
    "EMPTY",
    "none",
    "1",
    "ollama",
    "test",
    "x".repeat(20),
  ]) {
    process.env.CUSTOM_API_KEY = value;
    assert.equal((await sendFile({ path }, chat)).ok, true, value);
  }
});
