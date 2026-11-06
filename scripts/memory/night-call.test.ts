import "../fixtures/no-host-anthropic.ts";
// Настоящий ночной шов через SDK и codexFetch, без сетевого доступа и живых токенов.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import fc from "fast-check";
import { z } from "zod";
import "../lib/ts-esm-hooks.ts";

const data = mkdtempSync(join(tmpdir(), "iva-night-codex-"));
process.env.ASSISTANT_DATA_DIR = data;
process.env.MODEL_PROVIDER = "codex";
process.env.CODEX_MODEL = "gpt-6-sol";
process.env.THINKING_EFFORT = "medium";
const { writeAuth } = await import("../../agent/lib/codex-auth.ts");
writeAuth({
  access_token: `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`,
  accountId: "test-account",
  planType: "test",
});
const {
  callBySchema,
  ceiling,
  NightCeilingError,
  NightSchemaError,
  NightTransientError,
  nightCeiling,
  estimateInputTokens,
} = await import("./night-call.ts");
const { NIGHT_DEFAULTS } =
  await import("../../agent/lib/memory-night-constants.ts");
const { acquireFileLockSync, releaseFileLock } =
  await import("../../agent/lib/fs-atomic.ts");
const { codexProviderOptions } = await import("../../agent/provider.ts");
const { MockLanguageModelV4 } = await import("ai/test");

after(() => rmSync(data, { recursive: true, force: true }));
beforeEach(() => {
  Object.assign(nightCeiling.limits, NIGHT_DEFAULTS, { raisesPerNight: 0 });
  nightCeiling.raises = 0;
  nightCeiling.notices.length = 0;
  nightCeiling.blocked.clear();
  writeFileSync(join(data, "settings.json"), "{}");
  Object.assign(ceiling, {
    calls: 0,
    inputTokens: 0,
    unknownUsage: false,
    usageLost: "",
  });
  rmSync(join(data, "usage.jsonl"), { force: true });
});

const schema = z.object({ text: z.string() });
const ask = (signal = new AbortController().signal) => ({
  skill: 'Верни {"text":"ответ"}',
  input: { day: "2026-09-26" },
  schema,
  signal,
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encoder = new TextEncoder();
const item = { type: "message", id: "msg_test" };
const start = event({
  type: "response.output_item.added",
  output_index: 0,
  item,
});
function response(parts: string[], usage = true): Response {
  const events = [
    start,
    ...parts.map((delta) =>
      event({ type: "response.output_text.delta", item_id: item.id, delta }),
    ),
    event({ type: "response.output_item.done", output_index: 0, item }),
    ...(usage
      ? [
          event({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 123,
                input_tokens_details: { cached_tokens: 17 },
                output_tokens: 9,
              },
            },
          }),
        ]
      : []),
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const value of events) controller.enqueue(encoder.encode(value));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

void test("night subscription call requires streaming, honors low effort, records final usage", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_input: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.equal(body.model, "gpt-6-sol");
    assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.tools, undefined);
    return Promise.resolve(response(['```json\n{"text":', '"ночь"}\n```']));
  });
  assert.deepEqual(await callBySchema(ask()), { text: "ночь" });
  assert.equal(calls, 1);
  assert.equal(ceiling.inputTokens, 123);
  const { modelSuccessAt } = await import("./night-call.ts");
  assert.ok(typeof modelSuccessAt === "number" && modelSuccessAt > 0);
  const row = JSON.parse(
    readFileSync(join(data, "usage.jsonl"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(row.source, "memory-night");
  assert.equal(row.model, "gpt-6-sol");
  assert.equal(row.in, 123);
  assert.equal(row.out, 9);
  assert.equal(row.cacheRead, 17);
});

void test("stream partition never changes the structured answer or usage", async (t) => {
  let parts: string[] = [];
  t.mock.method(globalThis, "fetch", () => Promise.resolve(response(parts)));
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.array(fc.nat()), async (text, cuts) => {
      const json = JSON.stringify({ text });
      const boundaries = [
        ...new Set([0, json.length, ...cuts.map((n) => n % (json.length + 1))]),
      ].sort((a, b) => a - b);
      parts = boundaries
        .slice(1)
        .map((end, index) => json.slice(boundaries[index], end));
      ceiling.calls = 0;
      ceiling.inputTokens = 0;
      assert.deepEqual(await callBySchema(ask()), { text });
      assert.equal(ceiling.calls, 1);
      assert.equal(ceiling.inputTokens, 123);
    }),
    { numRuns: 100 },
  );
});

void test("only schema repair makes a second call, both calls count final usage", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_input: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2)
      assert.match(init.body as string, /Ошибка прошлого ответа/u);
    return Promise.resolve(
      response([calls === 1 ? '{"text":1}' : '{"text":"fixed"}']),
    );
  });
  assert.deepEqual(await callBySchema(ask()), { text: "fixed" });
  assert.equal(calls, 2);
  assert.equal(ceiling.inputTokens, 246);
});

void test("second schema failure stops with NightSchemaError", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response(['{"text":1}'])),
  );
  await assert.rejects(callBySchema(ask()), NightSchemaError);
  assert.equal(ceiling.calls, 2);
});

void test("HTTP failure has no transport or schema retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(
      new Response('{"error":{"message":"failed"}}', { status: 503 }),
    );
  });
  await assert.rejects(callBySchema(ask()), NightTransientError);
  assert.equal(calls, 1);
});

void test("a failed stream rejects a partial answer without retry or usage row", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(start));
            controller.enqueue(
              encoder.encode(
                event({
                  type: "response.output_text.delta",
                  item_id: item.id,
                  delta: '{"text":',
                }),
              ),
            );
            setImmediate(() => controller.error(new Error("connection lost")));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  await assert.rejects(callBySchema(ask()), NightTransientError);
  assert.equal(calls, 1);
  assert.equal(ceiling.calls, 1);
  assert.ok(ceiling.inputTokens > 0);
  assert.throws(() => readFileSync(join(data, "usage.jsonl")));
});

void test("missing final usage closes the next call at Ceiling", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(response(['{"text":"done"}'], false));
  });
  assert.deepEqual(await callBySchema(ask()), { text: "done" });
  assert.equal(ceiling.unknownUsage, true);
  await assert.rejects(callBySchema(ask()), NightCeilingError);
  assert.equal(calls, 1);
});

void test("abort cancels the provider stream and never repairs a partial answer", async (t) => {
  const abort = new AbortController();
  let cancelled = false;
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_input: unknown, init: RequestInit) => {
    calls++;
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(start));
            controller.enqueue(
              encoder.encode(
                event({
                  type: "response.output_text.delta",
                  item_id: item.id,
                  delta: '{"text":',
                }),
              ),
            );
            init.signal!.addEventListener(
              "abort",
              () => {
                cancelled = true;
                controller.error(init.signal!.reason);
              },
              { once: true },
            );
            setImmediate(() => abort.abort(new Error("night stopped")));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  await assert.rejects(callBySchema(ask(abort.signal)));
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.equal(ceiling.calls, 1);
});

void test("Codex defaults preserve configured effort; explicit call options take precedence", async () => {
  const transform = codexProviderOptions().transformParams!;
  const defaults = await transform({
    type: "stream",
    model: new MockLanguageModelV4(),
    params: { prompt: [] },
  });
  assert.equal(defaults.providerOptions?.openai?.reasoningEffort, "medium");
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("minimal", "low", "medium", "high", "xhigh", "max"),
      fc.option(fc.constantFrom("auto", "concise", "detailed"), { nil: null }),
      async (effort, summary) => {
        const out = await transform({
          type: "stream",
          model: new MockLanguageModelV4(),
          params: {
            prompt: [],
            providerOptions: {
              openai: {
                reasoningEffort: effort,
                reasoningSummary: summary,
                store: true,
              },
            },
          },
        });
        assert.equal(out.providerOptions?.openai?.reasoningEffort, effort);
        assert.equal(out.providerOptions?.openai?.reasoningSummary, summary);
        assert.equal(out.providerOptions?.openai?.store, false);
      },
    ),
  );
});

void test("HTTP status classification preserves key/quota stops (seed 20261020)", async (t) => {
  const seed = 20261020;
  t.diagnostic(`fast-check seed=${seed}`);
  let status = 503;
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return Promise.resolve(
      new Response('{"error":{"message":"provider refusal"}}', { status }),
    );
  });
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 400, max: 599 }), async (value) => {
      status = value;
      calls = 0;
      ceiling.calls = 0;
      ceiling.inputTokens = 0;
      await assert.rejects(callBySchema(ask()), (error: unknown) => {
        assert.equal(
          error instanceof NightTransientError,
          value === 408 || value >= 500,
        );
        return true;
      });
      assert.equal(calls, 1);
    }),
    { seed, numRuns: 100 },
  );
});

void test("#341: classify every cause level and keep account refusals permanent (seed 20261020)", async (t) => {
  const seed = 20261020;
  t.diagnostic(`fast-check seed=${seed}`);
  const cases: Array<[Error, boolean]> = [
    [
      new TypeError("terminated", { cause: new Error("other side closed") }),
      true,
    ],
    [
      new TypeError("fetch failed", { cause: new Error("other side closed") }),
      true,
    ],
    [new TypeError("terminated"), true],
    [new Error("Connect Timeout Error"), true],
    [new Error("Body Timeout Error"), true],
    [new Error("Model produced no output. Check the stream for errors."), true],
    [Object.assign(new Error("HTTP 529"), { name: "ClaudeCliError" }), true],
    [
      Object.assign(new Error("no answer reached the relay"), {
        name: "ClaudeCliError",
        isRetryable: true,
      }),
      true,
    ],
    [Object.assign(new Error("provider busy"), { isRetryable: true }), true],
    [Object.assign(new Error("opaque"), { code: "UND_ERR_SOCKET" }), true],
    [Object.assign(new Error("opaque"), { status: 503 }), true],
    [Object.assign(new Error("opaque"), { statusCode: 408 }), true],
    [new Error("Your account has been terminated"), false],
    [
      Object.assign(new Error("Your account has been terminated"), {
        isRetryable: true,
      }),
      false,
    ],
    [new Error("Invalid API key"), false],
    [new Error("insufficient_quota"), false],
    [new Error("You exceeded your current quota"), false],
    [new Error("HTTP 429"), false],
    [
      Object.assign(new Error("fetch failed"), { cause: { status: 401 } }),
      false,
    ],
    [
      Object.assign(new Error("fetch failed"), { cause: { statusCode: 429 } }),
      false,
    ],
    [
      Object.assign(new Error("HTTP 529"), {
        cause: new Error("account suspended"),
      }),
      false,
    ],
    [new Error("invalid request format"), false],
  ];
  let failure = new Error("initial failure");
  t.mock.method(globalThis, "fetch", () => Promise.reject(failure));
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 4 }), async (depth) => {
      for (const [cause, expected] of cases) {
        failure = cause;
        for (let level = 0; level < depth; level++)
          failure = new Error("wrapper", { cause: failure });
        ceiling.calls = 0;
        ceiling.inputTokens = 0;
        await assert.rejects(callBySchema(ask()), (error: unknown) => {
          assert.equal(
            error instanceof NightTransientError,
            expected,
            `depth=${depth}, ${String(cause)}`,
          );
          return true;
        });
      }
    }),
    { seed, numRuns: 5 },
  );
});

void test("UTF-8 token estimate covers Russian text and preserves ASCII", () => {
  const n = 10_000;
  const estimate = estimateInputTokens("я".repeat(n));
  assert.ok(estimate >= n / 2 && estimate <= n);
  assert.equal(estimateInputTokens("a".repeat(n)), Math.ceil(n / 3));
});

void test("ceiling raises calls and input tokens, persists only soft limits and keeps neighbours", async (t) => {
  nightCeiling.limits.raisesPerNight = 3;
  ceiling.calls = 40;
  ceiling.inputTokens = 300_000;
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ language: "en", night: { maxCalls: 160 } }),
  );
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response(['{"text":"done"}'])),
  );
  assert.deepEqual(await callBySchema(ask()), { text: "done" });
  assert.equal(nightCeiling.raises, 2);
  assert.equal(nightCeiling.limits.calls, 80);
  assert.equal(nightCeiling.limits.inputTokens, 600_000);
  assert.deepEqual(
    JSON.parse(readFileSync(join(data, "settings.json"), "utf8")),
    {
      language: "en",
      night: { maxCalls: 160, calls: 80, inputTokens: 600_000 },
    },
  );
});

void test("ceiling clamps a raise to the hard limit and stops when raises run out", async (t) => {
  Object.assign(nightCeiling.limits, {
    raisesPerNight: 1,
    maxInputTokens: 350_000,
  });
  ceiling.inputTokens = 300_000;
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response(['{"text":"done"}'])),
  );
  await callBySchema(ask());
  assert.equal(nightCeiling.limits.inputTokens, 350_000);
  assert.equal(nightCeiling.raises, 1);
  ceiling.calls = 40;
  await assert.rejects(callBySchema(ask()), NightCeilingError);
  assert.equal(nightCeiling.raises, 1);
  assert.ok(nightCeiling.blocked.has("calls"));
});

void test("busy and corrupt settings keep the raised ceiling in memory without stopping the call", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response(['{"text":"done"}'])),
  );
  for (const corrupt of [false, true]) {
    Object.assign(nightCeiling.limits, NIGHT_DEFAULTS);
    nightCeiling.raises = 0;
    nightCeiling.notices.length = 0;
    ceiling.calls = 0;
    ceiling.inputTokens = 300_000;
    writeFileSync(join(data, "settings.json"), corrupt ? "{broken" : "{}");
    const lock = corrupt
      ? null
      : acquireFileLockSync(join(data, "settings.json.lock"));
    try {
      await callBySchema(ask());
    } finally {
      if (lock) releaseFileLock(lock);
    }
    assert.equal(nightCeiling.limits.inputTokens, 600_000);
    assert.equal(nightCeiling.raises, 1);
    assert.equal(
      readFileSync(join(data, "settings.json"), "utf8"),
      corrupt ? "{broken" : "{}",
    );
    assert.ok(
      nightCeiling.notices.some((pair) =>
        pair[0].includes("could not be saved"),
      ),
    );
  }
});

void test("unknown usage stays latched even when raising is enabled", async (t) => {
  nightCeiling.limits.raisesPerNight = 3;
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(response(['{"text":"done"}'], false)),
  );
  await callBySchema(ask());
  await assert.rejects(callBySchema(ask()), NightCeilingError);
  assert.equal(nightCeiling.raises, 0);
});
