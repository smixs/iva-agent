/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Перекличка (ADR-0031): что уходит с машины, чем выключается, когда уходит повторно и чем
// отказ сайта не может помешать проверке обновлений. Запрос проверяется на проводе:
// настоящий HTTP-сервер на loopback принимает ровно то, что отправил бы fetch.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { CATALOG } from "./model-catalog.ts";
import {
  dayOf,
  gapSince,
  ROLL_CALL_FILE,
  ROLL_CALL_MAX_GAP,
  ROLL_CALL_SWITCHES,
  ROLL_CALL_TIMEOUT_MS,
  ROLL_CALL_URL,
  rollCallBody,
  rollCallEnabled,
  runRollCall,
  sendRollCall,
  type RollCall,
} from "./roll-call.ts";

const SEED = Number(process.env.FC_SEED ?? 20_261_126);
const OFF_WORDS = ["off", "0", "false", "no"] as const;
const PROVIDERS = Object.keys(CATALOG);
const KEYS = ["gap", "version", "channel", "os", "arch", "provider", "model"];
const PUBLIC_MODEL = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;

type Seen = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
};

/** Сайт на loopback: записывает запрос и отвечает тем, что велел тест. */
async function site(
  answer: { readonly status: number; readonly location?: string } | "silent",
) {
  const seen: Seen[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (answer === "silent") return;
      response.writeHead(
        answer.status,
        answer.location ? { location: answer.location } : {},
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const published = new URL(ROLL_CALL_URL);
  const request: typeof fetch = (input, init) => {
    const asked = new URL(input instanceof Request ? input.url : input);
    assert.equal(asked.origin, published.origin);
    return fetch(`http://127.0.0.1:${port}${asked.pathname}`, init);
  };
  return {
    seen,
    url: `http://127.0.0.1:${port}/`,
    request,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function install(version = "0.5.16") {
  const root = await mkdtemp(join(tmpdir(), "iva-roll-call-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  return { root, storage: join(root, "data") };
}

const anyCase = (word: string) =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((upper) =>
      [...word].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(""),
    );
const padding = fc.constantFrom("", " ", "  ", "\t");

test("where the roll call goes, how long it waits and what turns it off are spelled once", () => {
  // The site, the path, the wait and the switches are promises of the documentation.
  assert.equal(ROLL_CALL_URL, "https://iva-agent.com/api/roll-call");
  assert.equal(ROLL_CALL_TIMEOUT_MS, 2500);
  assert.equal(ROLL_CALL_MAX_GAP, 31);
  assert.deepEqual(ROLL_CALL_SWITCHES, ["IVA_STATS", "DO_NOT_TRACK"]);
  for (const name of ROLL_CALL_SWITCHES)
    assert.equal(
      rollCallEnabled({ [name]: name === "DO_NOT_TRACK" ? "1" : "off" }),
      false,
      name,
    );
});

test(`the roll call is on unless IVA_STATS or DO_NOT_TRACK says otherwise (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...OFF_WORDS).chain(anyCase),
      padding,
      padding,
      fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
      (word, before, after, other) => {
        assert.equal(
          rollCallEnabled({ IVA_STATS: `${before}${word}${after}` }),
          false,
        );
        assert.equal(
          rollCallEnabled({ IVA_STATS: other, DO_NOT_TRACK: " 1 " }),
          false,
        );
        const off = (OFF_WORDS as readonly string[]).includes(
          (other ?? "").trim().toLowerCase(),
        );
        assert.equal(rollCallEnabled({ IVA_STATS: other }), !off);
        // The plugin count's own switch is not this one.
        assert.equal(rollCallEnabled({ IVA_PLUGIN_STATS: "off" }), true);
      },
    ),
    { seed: SEED },
  );
});

test(`the gap: 0 first, nothing twice a day, days since the last one, at most 31 (seed ${SEED})`, () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 0, max: 400 }),
      (offset, days) => {
        const last = dayOf(new Date(start + offset * 86_400_000));
        const today = dayOf(new Date(start + (offset + days) * 86_400_000));
        assert.equal(
          gapSince(last, today),
          days === 0 ? null : Math.min(days, ROLL_CALL_MAX_GAP),
        );
        // A record from the future means the silence is unknown: the longest gap.
        if (days > 0) assert.equal(gapSince(today, last), ROLL_CALL_MAX_GAP);
      },
    ),
    { seed: SEED },
  );
  assert.equal(gapSince(null, "2026-11-26"), 0);
  for (const unreadable of [
    undefined,
    "",
    "yesterday",
    "2026-13-45",
    "26.11.2026",
  ])
    assert.equal(
      gapSince(unreadable, "2026-11-26"),
      ROLL_CALL_MAX_GAP,
      String(unreadable),
    );
});

test(`no value of .env leaves the machine except through the closed lists (seed ${SEED})`, () => {
  const anyText = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.constantFrom(
      "https://my.internal/v1/model",
      "/home/owner/models/secret.gguf",
      "My Fine-Tune",
      "owner@example.com",
      "gpt-5.5",
      "openai/gpt-5.1",
      "gemma4:31b",
      "DeepSeek-V4-Pro",
    ),
  );
  const env = fc.record(
    {
      MODEL_PROVIDER: fc.oneof(
        fc.constantFrom(...PROVIDERS),
        fc.string({ maxLength: 10 }),
      ),
      OLLAMA_MODEL: anyText,
      OPENCODE_MODEL: anyText,
      CODEX_MODEL: anyText,
      CLAUDE_MODEL: anyText,
      OPENROUTER_MODEL: anyText,
      CUSTOM_MODEL: anyText,
      CUSTOM_BASE_URL: anyText,
      TELEGRAM_BOT_TOKEN: anyText,
    },
    { requiredKeys: [] },
  );
  fc.assert(
    fc.property(
      env,
      fc.integer({ min: 0, max: ROLL_CALL_MAX_GAP }),
      fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
      fc.constantFrom("main", "beta", "other"),
      fc.string({ maxLength: 10 }),
      fc.string({ maxLength: 10 }),
      (environment, gap, version, channel, platform, arch) => {
        const body = rollCallBody({
          gap,
          version,
          channel,
          platform,
          arch,
          env: environment,
        });
        assert.deepEqual(Object.keys(body), KEYS);
        assert.equal(body.gap, gap);
        assert.ok(
          body.version === "other" || /^\d+\.\d+\.\d+$/.test(body.version),
        );
        assert.ok(["main", "beta", "other"].includes(body.channel));
        assert.ok(["linux", "darwin", "other"].includes(body.os));
        assert.ok(["x64", "arm64", "other"].includes(body.arch));
        assert.ok([...PROVIDERS, "other"].includes(body.provider));
        assert.ok(
          ["other", "custom"].includes(body.model) ||
            (PUBLIC_MODEL.test(body.model) && !body.model.includes("://")),
          body.model,
        );
        // The custom provider's model and address never leave; neither does anything
        // that is not a model name.
        if (body.provider === "custom") assert.equal(body.model, "custom");
        const wire = JSON.stringify(body);
        for (const secret of [
          environment.CUSTOM_BASE_URL,
          environment.TELEGRAM_BOT_TOKEN,
        ])
          if (
            secret &&
            secret.length > 6 &&
            !PUBLIC_MODEL.test(secret.toLowerCase())
          )
            assert.ok(!wire.includes(secret), secret);
      },
    ),
    { seed: SEED },
  );
});

test("a provider's public model is named, in lower case; the default answers for a blank one", () => {
  const body = (env: Record<string, string>) =>
    rollCallBody({
      gap: 1,
      version: "0.5.16",
      channel: "main",
      platform: "linux",
      arch: "x64",
      env,
    });
  assert.deepEqual(body({ MODEL_PROVIDER: "codex", CODEX_MODEL: "GPT-5.5" }), {
    gap: 1,
    version: "0.5.16",
    channel: "main",
    os: "linux",
    arch: "x64",
    provider: "codex",
    model: "gpt-5.5",
  });
  assert.equal(
    body({ MODEL_PROVIDER: "openrouter", OPENROUTER_MODEL: "openai/gpt-5.1" })
      .model,
    "openai/gpt-5.1",
  );
  assert.equal(
    body({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: " " }).model,
    CATALOG.ollama.def,
  );
  assert.equal(body({}).provider, "ollama");
  assert.equal(
    body({ MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "http://box:11434/llama" })
      .model,
    "other",
  );
  assert.equal(
    body({ MODEL_PROVIDER: "custom", CUSTOM_MODEL: "gpt-5.5" }).model,
    "custom",
  );
  assert.deepEqual(
    [
      body({ MODEL_PROVIDER: "Ollama" }).provider,
      body({ MODEL_PROVIDER: "Ollama" }).model,
    ],
    ["other", "other"],
  );
});

test("the roll call on the wire: one POST, one JSON body, no headers of its own", async () => {
  const at = await site({ status: 204 });
  try {
    const body: RollCall = {
      gap: 0,
      version: "0.5.16",
      channel: "beta",
      os: "darwin",
      arch: "arm64",
      provider: "claude",
      model: "claude-fable-5-2",
    };
    assert.equal(await sendRollCall(body, at.request), true);
    assert.equal(at.seen.length, 1);
    const [seen] = at.seen;
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/api/roll-call");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen.body), body);
    for (const header of [
      "cookie",
      "authorization",
      "x-iva-install",
      "referer",
    ])
      assert.equal(seen.headers[header], undefined, header);
  } finally {
    await at.close();
  }
});

test("a site that refuses, redirects, never answers or is not there takes nothing and throws nothing", async () => {
  const body = rollCallBody({
    gap: 1,
    version: "0.5.16",
    channel: "main",
    platform: "linux",
    arch: "x64",
    env: {},
  });
  const refusing = await site({ status: 500 });
  const elsewhere = await site({ status: 204 });
  const redirecting = await site({ status: 302, location: elsewhere.url });
  const silent = await site("silent");
  try {
    assert.equal(await sendRollCall(body, refusing.request), false);
    assert.equal(await sendRollCall(body, redirecting.request), false);
    assert.equal(elsewhere.seen.length, 0, "the redirect is not followed");
    const started = Date.now();
    assert.equal(await sendRollCall(body, silent.request, 150), false);
    assert.ok(Date.now() - started < 2000);
    const offline: typeof fetch = () =>
      Promise.reject(new TypeError("fetch failed"));
    assert.equal(await sendRollCall(body, offline), false);
  } finally {
    await Promise.all([
      refusing.close(),
      elsewhere.close(),
      redirecting.close(),
      silent.close(),
    ]);
  }
});

test("one roll call a UTC day: the day is kept only after the site took the call", async () => {
  const at = await site({ status: 204 });
  const { root, storage } = await install();
  const env = { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" };
  const run = (now: string, request = at.request) =>
    runRollCall({
      root,
      storage,
      channel: "main",
      env,
      now: new Date(now),
      platform: "linux",
      arch: "x64",
      request,
    });
  try {
    const first = await run("2026-11-26T10:00:00Z");
    assert.equal(first.status, "sent");
    assert.equal(first.status === "sent" && first.body.gap, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(storage, ROLL_CALL_FILE), "utf8")),
      { day: "2026-11-26" },
    );
    // A restart, a second timer run, a run just before midnight: the same day sends nothing.
    assert.deepEqual(await run("2026-11-26T23:59:59Z"), {
      status: "already-today",
    });
    assert.equal(at.seen.length, 1);
    // The site is down tomorrow: nothing is kept, and the day after names the two days.
    const down: typeof fetch = () =>
      Promise.reject(new TypeError("fetch failed"));
    assert.equal((await run("2026-11-27T10:00:00Z", down)).status, "not-taken");
    const later = await run("2026-11-28T10:00:00Z");
    assert.equal(later.status === "sent" && later.body.gap, 2);
    assert.equal(at.seen.length, 2);
    // A month of silence reads as 31.
    const back = await run("2027-03-01T10:00:00Z");
    assert.equal(back.status === "sent" && back.body.gap, ROLL_CALL_MAX_GAP);
  } finally {
    await at.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("switched off, nothing is sent and nothing is written; an unreadable record reads as a long gap", async () => {
  const at = await site({ status: 204 });
  const { root, storage } = await install("not-a-version");
  try {
    for (const env of [{ IVA_STATS: "off" }, { DO_NOT_TRACK: "1" }])
      assert.deepEqual(
        await runRollCall({
          root,
          storage,
          channel: "main",
          env,
          request: at.request,
        }),
        { status: "off" },
      );
    assert.equal(at.seen.length, 0);
    await assert.rejects(readFile(join(storage, ROLL_CALL_FILE)));

    await rm(storage, { recursive: true, force: true });
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(storage, { recursive: true }),
    );
    await writeFile(join(storage, ROLL_CALL_FILE), "{not json");
    const result = await runRollCall({
      root,
      storage,
      channel: "other",
      env: {},
      now: new Date("2026-11-26T10:00:00Z"),
      request: at.request,
    });
    assert.equal(result.status, "sent");
    assert.equal(
      result.status === "sent" && result.body.gap,
      ROLL_CALL_MAX_GAP,
    );
    assert.equal(result.status === "sent" && result.body.version, "other");
  } finally {
    await at.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a roll call that cannot keep its day reports a failure instead of throwing", async () => {
  const at = await site({ status: 204 });
  const { root } = await install();
  // The storage path is a file: the day cannot be written.
  const storage = join(root, "package.json");
  try {
    const result = await runRollCall({
      root,
      storage,
      channel: "main",
      env: {},
      request: at.request,
    });
    assert.equal(result.status, "failed");
  } finally {
    await at.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the daily check hands its data folder and channel to the roll call and logs one line", async (t) => {
  const { rollCall } = await import("../check-update.ts");
  const { root } = await install();
  const logged = t.mock.method(console, "log", () => {});
  const warned = t.mock.method(console, "error", () => {});
  try {
    const asked: Parameters<typeof runRollCall>[0][] = [];
    const body = rollCallBody({
      gap: 1,
      version: "0.5.16",
      channel: "main",
      platform: "linux",
      arch: "x64",
      env: {},
    });
    const env = { ASSISTANT_DATA_DIR: join(root, "elsewhere") };
    await rollCall(root, env, (options) => {
      asked.push(options);
      return Promise.resolve({ status: "sent", body });
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].storage, join(root, "elsewhere"));
    assert.equal(asked[0].env, env);
    assert.ok(["main", "beta", "other"].includes(asked[0].channel));
    assert.deepEqual(
      logged.mock.calls.map((c) => String(c.arguments[0])),
      [`Roll call: ${JSON.stringify(body)}`],
    );
    await rollCall(root, env, () =>
      Promise.resolve({ status: "not-taken", body }),
    );
    await rollCall(root, env, () => Promise.resolve({ status: "off" }));
    assert.equal(
      logged.mock.callCount(),
      1,
      "only a taken roll call is logged as sent",
    );
    assert.equal(warned.mock.callCount(), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
