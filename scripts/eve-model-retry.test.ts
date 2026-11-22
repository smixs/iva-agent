/* eslint-disable @typescript-eslint/require-await -- Async model doubles implement the SDK Promise interface, including rejected calls. */
// Real Eve boundary: one owner of repeated model requests, for any break before finish.
// Random cases print their seed in the test name; FC_SEED repeats a run.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { createToolLoopHarness } from "../node_modules/eve/dist/src/harness/tool-loop.js";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../node_modules/eve/dist/src/harness/types.js";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

const session = (): HarnessSession => ({
  agent: {
    system: "Reply once.",
    tools: [],
    modelReference: { id: "test/model" },
  },
  compaction: { threshold: 100_000, recentWindowTokens: 100, summaryMaxOutputTokens: 400 },
  continuationToken: "test",
  sessionId: "test",
  history: [],
});
const error = (status = 503, responseHeaders?: Record<string, string>) =>
  new APICallError({
    message: "provider unavailable",
    url: "http://test.invalid",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders,
  });
const success = (): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "ok" },
  { type: "text-end", id: "text" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  },
];
function fixture(
  model: LanguageModel,
  signal?: AbortSignal,
  tools: HarnessToolMap = new Map(),
  onEvent?: (event: { type: string; data?: unknown }) => void,
) {
  const events: Array<{ type: string; data?: unknown }> = [];
  const step = createToolLoopHarness({
    mode: "conversation",
    tools,
    resolveModel: () => Promise.resolve(model),
    abortSignal: signal,
    handleEvent: (event) => {
      events.push(event);
      onEvent?.(event);
      return Promise.resolve();
    },
  });
  const initial = session();
  const prepared = {
    ...initial,
    agent: {
      ...initial.agent,
      tools: [...tools.values()].map(({ name, description }) => ({
        name,
        description,
        inputSchema: { type: "object", properties: {} },
      })),
    },
  };
  return { events, run: () => step(prepared, { message: "hello" }), step };
}
function mute(t: TestContext) {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
}
/** Keep the production delay contract visible while advancing waits immediately. */
function fastWaits(t: TestContext) {
  const original = globalThis.setTimeout;
  const waits: number[] = [];
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...rest] = args;
      if (delay !== undefined && delay >= 500 && delay <= 60_000) {
        waits.push(delay);
        return original(callback, 0, ...rest);
      }
      return original(...args);
    },
  );
  return waits;
}
async function wire(t: TestContext, failures: number, disconnect = false) {
  let calls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      assert.equal((JSON.parse(raw) as { stream: boolean }).stream, true);
      calls++;
      if (calls <= failures) {
        if (disconnect) {
          request.socket.destroy();
          return;
        }
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":{"message":"provider unavailable"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const provider = createOpenAICompatible({
    name: "test",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  return { model: provider.chatModel("model"), calls: () => calls };
}

void test("Eve owns all three pre-opening requests instead of AI SDK default retries", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const provider = await wire(t, 99);
  const fx = fixture(provider.model);
  const result = await fx.run();
  assert.equal(result.settledTurn?.isError, true);
  assert.equal(provider.calls(), 3);
  assert.deepEqual(
    waits.filter((delay) => delay === 5_000 || delay === 15_000),
    [5_000, 15_000],
  );
  assert.equal(
    fx.events.filter((event) => event.type === "step.started").length,
    1,
  );
});

void test("two pre-opening HTTP failures recover on the third call", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const provider = await wire(t, 2);
  const fx = fixture(provider.model);
  const result = await fx.run();
  assert.equal(result.settledTurn?.output, "ok");
  assert.equal(provider.calls(), 3);
  assert.deepEqual(
    waits.filter((delay) => delay === 5_000 || delay === 15_000),
    [5_000, 15_000],
  );
  assert.equal(
    fx.events.filter((event) => event.type === "step.started").length,
    1,
  );
});

void test("exhausted HTTP retries park one recoverable turn and permit the next user message", async (t) => {
  mute(t);
  fastWaits(t);
  const provider = await wire(t, 3);
  const fx = fixture(provider.model);
  const failed = await fx.run();
  assert.equal(provider.calls(), 3);
  assert.equal(failed.next, null);
  assert.equal(failed.settledTurn?.isError, true);
  assert.equal(
    fx.events.filter((event) => event.type === "turn.failed").length,
    1,
  );
  assert.equal(fx.events.at(-1)?.type, "session.waiting");
  const resumed = await fx.step(failed.session, { message: "try again" });
  assert.equal(resumed.settledTurn?.output, "ok");
  assert.equal(provider.calls(), 4);
});

void test("a reset before the stream opens uses the same bounded owner", async (t) => {
  mute(t);
  fastWaits(t);
  const provider = await wire(t, 2, true);
  assert.equal((await fixture(provider.model).run()).settledTurn?.output, "ok");
  assert.equal(provider.calls(), 3);
});

void test(`failure sequences never exceed three requests and permanent errors are not retried (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        400,
        401,
        403,
        404,
        408,
        409,
        422,
        429,
        500,
        502,
        503,
        504,
      ),
      fc.integer({ min: 0, max: 6 }),
      async (status, failures) => {
        let calls = 0;
        const model = new MockLanguageModelV4({
          doStream: async () => {
            if (++calls <= failures) throw error(status);
            return { stream: convertArrayToReadableStream(success()) };
          },
        });
        await fixture(model).run();
        const transient = [408, 409, 429, 500, 502, 503, 504].includes(status);
        assert.equal(
          calls,
          failures === 0 ? 1 : transient ? Math.min(failures + 1, 3) : 1,
        );
      },
    ),
    { numRuns: 100, seed: SEED },
  );
});

/** A body that delivered some parts and then lost its connection. */
function broken(
  parts: LanguageModelV4StreamPart[],
  failure: unknown = reset(),
): ReadableStream<LanguageModelV4StreamPart> {
  const queue = [...parts];
  // Pull, not start: error() in start would drop the parts still queued.
  return new ReadableStream({
    pull(controller) {
      const part = queue.shift();
      if (part === undefined) controller.error(failure);
      else controller.enqueue(part);
    },
  });
}
/** What undici says when a body breaks off: eve reads it as a network failure. */
const reset = () =>
  Object.assign(new Error("terminated"), { name: "TypeError" });
/** A provider error that names itself repeatable (ClaudeCliError on a broken relay stream). */
const flagged = () =>
  Object.assign(new Error("api.anthropic.com did not finish the response"), {
    isRetryable: true,
  });
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
// A bare tool call that arrived before the break is held until finish and never reaches
// eve: for eve nothing of the answer arrived, and the request is simply made again.
// Outcomes the rule repeats: every break before finish and every transient HTTP status.
// What stops it: a refusal (401), a finished answer, or three requests.
const BREAKS = [
  "pre",
  "thinking",
  "503",
  "call",
  "text",
  "args",
  "argsCall",
] as const;
type Outcome = (typeof BREAKS)[number] | "401" | "okText" | "okCall";
const OUTCOMES: readonly Outcome[] = [...BREAKS, "401", "okText", "okCall"];
const ANSWER_BREAKS: ReadonlySet<Outcome> = new Set([
  "text",
  "args",
  "argsCall",
]);

const toolCallOf = (call: number): LanguageModelV4StreamPart => ({
  type: "tool-call",
  toolCallId: `call-${call}`,
  toolName: "change",
  input: "{}",
});
const inputOf = (call: number, delta: string): LanguageModelV4StreamPart[] => [
  { type: "tool-input-start", id: `call-${call}`, toolName: "change" },
  { type: "tool-input-delta", id: `call-${call}`, delta },
];
/** Parts before the break of each breaking outcome; tool call ids differ per request. */
const BEFORE_BREAK: Record<
  "pre" | "thinking" | "call" | "text" | "args" | "argsCall",
  (call: number) => LanguageModelV4StreamPart[]
> = {
  pre: () => [],
  thinking: () => [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "hm" },
  ],
  call: (call) => [toolCallOf(call)],
  text: () => [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "half an ans" },
  ],
  args: (call) => inputOf(call, "{"),
  argsCall: (call) => [
    ...inputOf(call, "{}"),
    { type: "tool-input-end", id: `call-${call}` },
    toolCallOf(call),
  ],
};

/** One model request with the given outcome. */
function attempt(
  outcome: Outcome,
  call: number,
  failure: unknown,
): LanguageModelV4StreamPart[] | ReadableStream<LanguageModelV4StreamPart> {
  if (outcome === "503") throw error(503);
  if (outcome === "401") throw error(401);
  if (outcome === "okText") return success();
  if (outcome === "okCall")
    return [
      toolCallOf(call),
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
      },
    ];
  return broken(BEFORE_BREAK[outcome](call), failure);
}

function changeTool(onRun: () => void): HarnessToolMap {
  return new Map([
    [
      "change",
      {
        name: "change",
        description: "Change state once.",
        inputSchema: z.object({}),
        execute: () => {
          onRun();
          return "changed";
        },
      },
    ],
  ]);
}

function scripted(outcomes: readonly Outcome[], failure: () => unknown) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
      calls++;
      const body = attempt(outcome, calls, failure());
      return {
        stream: Array.isArray(body) ? convertArrayToReadableStream(body) : body,
      };
    },
  });
  return { model, calls: () => calls };
}

/** Requests the owner's rule allows: any break before finish is repeated, three in all. */
function expectedCalls(outcomes: readonly Outcome[]): number {
  let calls = 0;
  for (;;) {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls++;
    if (!(BREAKS as readonly Outcome[]).includes(outcome) || calls === 3)
      return calls;
  }
}

const ownerTexts = (events: ReadonlyArray<{ type: string; data?: unknown }>) =>
  events.filter((event) => {
    const data = event.data as
      { finishReason?: string; message?: string | null } | undefined;
    return (
      event.type === "message.completed" &&
      data?.finishReason !== "tool-calls" &&
      typeof data?.message === "string" &&
      data.message.length > 0
    );
  }).length;

void test("a stream broken before the first answer part is requested again, reasoning included", async (t) => {
  mute(t);
  for (const first of ["pre", "thinking"] as const) {
    const waits = fastWaits(t);
    const provider = scripted([first, "okText"], reset);
    const fx = fixture(provider.model);
    const result = await fx.run();
    assert.equal(result.settledTurn?.output, "ok", first);
    assert.equal(provider.calls(), 2, first);
    assert.deepEqual(waits, [5_000], first);
    assert.equal(ownerTexts(fx.events), 1, first);
    assert.equal(
      fx.events.filter((event) => event.type === "step.started").length,
      1,
    );
    t.mock.restoreAll();
    mute(t);
  }
});

// HTTP providers (codex, openrouter, custom, ollama, opencode) send a tool call before the
// end of the stream, and the AI SDK starts the tool at once. A break after it used to leave a
// side effect that the next request could repeat. The call is now held until finish.
void test("a tool call before a break never runs; the request is made again and runs it once", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let effects = 0;
  const provider = scripted(["call", "okCall"], reset);
  const fx = fixture(
    provider.model,
    undefined,
    changeTool(() => effects++),
  );
  const result = await fx.run();
  assert.equal(provider.calls(), 2);
  assert.deepEqual(waits, [5_000]);
  assert.equal(effects, 1);
  assert.equal(
    typeof result.next,
    "function",
    "the tool step continues the turn",
  );
  const requested = fx.events.filter(
    (event) => event.type === "actions.requested",
  );
  assert.equal(requested.length, 1, "the owner sees one tool call");
});

// Правило лида 07.10.2026: обрыв в любой момент до finish повторяется. Владельцу во время
// потока ничего не уходит, частичный ответ в историю не попадает, вызов инструмента
// придержан до finish — повтор ничего не дублирует.
void test(`a stream broken in the middle of the answer is requested again and leaves one answer (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("text", "args", "argsCall"),
      fc.constantFrom(reset, flagged),
      async (outcome, failure) => {
        let effects = 0;
        const provider = scripted([outcome, "okText"], failure);
        const fx = fixture(
          provider.model,
          undefined,
          changeTool(() => effects++),
        );
        const result = await fx.run();
        assert.equal(provider.calls(), 2);
        assert.equal(result.settledTurn?.output, "ok");
        assert.equal(effects, 0, "a tool call before finish never runs");
        assert.equal(ownerTexts(fx.events), 1);
        const assistants = result.session.history.filter(
          (message) => message.role === "assistant",
        );
        assert.equal(assistants.length, 1, "one assistant answer in history");
        assert.doesNotMatch(
          JSON.stringify(result.session.history),
          /half an ans/u,
        );
      },
    ),
    { numRuns: 30, seed: SEED },
  );
});

void test(`three mid-answer breaks close the turn with answerStarted and three attempts (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("text", "args", "argsCall"),
      fc.constantFrom(reset, flagged),
      async (outcome, failure) => {
        let effects = 0;
        const provider = scripted([outcome], failure);
        const fx = fixture(
          provider.model,
          undefined,
          changeTool(() => effects++),
        );
        const result = await fx.run();
        assert.equal(provider.calls(), 3);
        assert.equal(result.next, null);
        assert.equal(result.settledTurn?.isError, true);
        assert.equal(effects, 0);
        assert.equal(ownerTexts(fx.events), 0);
        const failed = fx.events.filter(
          (event) => event.type === "turn.failed",
        );
        assert.equal(failed.length, 1);
        const details = (
          failed[0]?.data as { details?: Record<string, unknown> }
        ).details;
        assert.equal(details?.answerStarted, true);
        assert.equal(details?.attempts, 3);
        assert.equal(typeof details?.errorId, "string");
      },
    ),
    { numRuns: 20, seed: SEED },
  );
});

// Случай c1 07.10.2026: шаги с инструментами прошли, следующий запрос трижды оборвался
// посреди ответа. Ход закрыт, сессия принимает «Повторить» (тап кнопки), и модель видит
// вопрос и результаты инструментов из истории: сами инструменты второй раз не выполняются.
void test("after three mid-answer breaks the Try again turn sees the question and the tool results", async (t) => {
  mute(t);
  fastWaits(t);
  let effects = 0;
  const prompts: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      calls++;
      const outcome = calls === 1 ? "okCall" : calls <= 4 ? "text" : "okText";
      const body = attempt(outcome, calls, reset());
      return {
        stream: Array.isArray(body) ? convertArrayToReadableStream(body) : body,
      };
    },
  });
  const fx = fixture(
    model,
    undefined,
    changeTool(() => effects++),
  );
  const toolStep = await fx.run();
  assert.equal(
    typeof toolStep.next,
    "function",
    "the tool step continues the turn",
  );
  const broke = await fx.step(toolStep.session, undefined);
  assert.equal(broke.settledTurn?.isError, true);
  assert.equal(calls, 4, "the broken answer is requested three times");
  const again = await fx.step(broke.session, { message: "Повторить" });
  assert.equal(again.settledTurn?.output, "ok");
  assert.equal(effects, 1);
  const seen = JSON.stringify(prompts.at(-1));
  assert.match(seen, /hello/u);
  assert.match(seen, /changed/u);
  assert.match(seen, /Повторить/u);
});

void test(`for any sequence of outcomes no tool runs twice and the owner gets at most one text (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(...OUTCOMES), { minLength: 1, maxLength: 5 }),
      fc.constantFrom(reset, flagged),
      async (outcomes, failure) => {
        const runs = new Map<number, number>();
        let effects = 0;
        const provider = scripted(outcomes, failure);
        const fx = fixture(
          provider.model,
          undefined,
          changeTool(() => {
            effects++;
            runs.set(provider.calls(), (runs.get(provider.calls()) ?? 0) + 1);
          }),
        );
        await fx.run();
        assert.equal(provider.calls(), expectedCalls(outcomes));
        assert.ok(effects <= 1, `tool ran ${effects} times`);
        for (const count of runs.values()) assert.ok(count <= 1);
        const final = outcomes[Math.min(provider.calls(), outcomes.length) - 1];
        // A tool runs only from a request that reached finish.
        assert.equal(effects, final === "okCall" ? 1 : 0);
        assert.ok(ownerTexts(fx.events) <= 1);
        const last = outcomes[Math.min(provider.calls(), outcomes.length) - 1];
        if (ANSWER_BREAKS.has(last)) {
          const failed = fx.events.find(
            (event) => event.type === "turn.failed",
          );
          const details = (
            failed?.data as { details?: Record<string, unknown> }
          ).details;
          assert.equal(details?.answerStarted, true);
          assert.equal(details?.attempts, provider.calls());
        }
      },
    ),
    { numRuns: 150, seed: SEED },
  );
});

void test("a channel failure after a tool side effect never replays its generation", async (t) => {
  mute(t);
  fastWaits(t);
  let effects = 0;
  const tools: HarnessToolMap = new Map([
    [
      "change",
      {
        name: "change",
        description: "Change state once.",
        inputSchema: z.object({}),
        execute: () => {
          effects++;
          return "changed";
        },
      },
    ],
  ]);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return {
        stream: convertArrayToReadableStream([
          {
            type: "tool-call",
            toolCallId: `call-${calls}`,
            toolName: "change",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
  const result = await fixture(model, undefined, tools, (event) => {
    if (event.type === "step.completed" && effects > 0) throw error();
  }).run();
  assert.equal(effects, 1);
  assert.equal(calls, 1);
  assert.equal(result.settledTurn?.isError, true);
});

void test("cancellation during backoff clears its listener and starts no next attempt", async (t) => {
  mute(t);
  const abort = new AbortController();
  let calls = 0;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const timer = original(...args);
      if (args[1] === 5_000) reached();
      return timer;
    },
  );
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error();
    },
  });
  const result = fixture(model, abort.signal).run();
  await waiting;
  abort.abort(new Error("owner stopped"));
  await assert.rejects(result, { name: "TurnCancelledError" });
  assert.equal(calls, 1);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

void test("cancellation aborts an in-flight pre-opening call without another attempt", async (t) => {
  mute(t);
  const abort = new AbortController();
  let calls = 0;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let providerSignal: AbortSignal | undefined;
  const model = new MockLanguageModelV4({
    doStream: ({ abortSignal }) => {
      calls++;
      providerSignal = abortSignal;
      return new Promise((_, reject) => {
        abortSignal!.addEventListener("abort", () => reject(error()), {
          once: true,
        });
        reached();
      });
    },
  });
  const result = fixture(model, abort.signal).run();
  await started;
  abort.abort();
  await assert.rejects(result, { name: "TurnCancelledError" });
  assert.equal(providerSignal?.aborted, true);
  assert.equal(calls, 1);
});

// A provider wait raises the pause; the next pause keeps its own floor (5 s, then 15 s):
// the third request never goes without a pause (review 07.10.2026).
void test("a provider wait raises one pause and the next pause keeps its floor", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls <= 2)
        throw error(429, calls === 1 ? { "Retry-After": "12" } : {});
      return { stream: convertArrayToReadableStream(success()) };
    },
  });
  assert.equal((await fixture(model).run()).settledTurn?.output, "ok");
  assert.deepEqual(waits, [12_000, 15_000]);
});

void test("HTTP dates and retry-after-ms preserve provider minimums", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const now = Date.parse("2026-10-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls <= 2)
        throw error(
          429,
          calls === 1
            ? {
                "rEtRy-AfTeR": new Date(now + 9_000).toUTCString(),
                "Retry-After-MS": "12000",
              }
            : {},
        );
      return { stream: convertArrayToReadableStream(success()) };
    },
  });
  await fixture(model).run();
  assert.deepEqual(waits, [12_000, 15_000]);
});

void test("a provider wait over a minute closes the turn at once and names the wait", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error(503, { "RETRY-AFTER": "120" });
    },
  });
  const fx = fixture(model);
  const result = await fx.run();
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(result.next, null);
  assert.equal(result.settledTurn?.isError, true);
  const failed = fx.events.find((event) => event.type === "turn.failed");
  const details = (failed?.data as { details?: Record<string, unknown> })
    .details;
  assert.equal(details?.providerWaitMs, 120_000);
  assert.equal(details?.attempts, 1);
});

void test(`numeric and date Retry-After never dispatch early, every pause is 5 s to 60 s (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const now = Date.parse("2026-10-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 90 }),
      fc.boolean(),
      fc.constantFrom("Retry-After", "RETRY-AFTER", "retry-after"),
      async (seconds, date, key) => {
        waits.length = 0;
        let calls = 0;
        const header = date
          ? new Date(now + seconds * 1000).toUTCString()
          : String(seconds);
        const model = new MockLanguageModelV4({
          doStream: async () => {
            calls++;
            throw error(429, { [key]: header });
          },
        });
        await fixture(model).run();
        assert.equal(calls, seconds > 60 ? 1 : 3);
        assert.ok(waits.every((wait) => wait >= seconds * 1000));
        assert.ok(waits.every((wait) => wait >= 5_000 && wait <= 60_000));
      },
    ),
    { numRuns: 100, seed: SEED },
  );
});

void test(`malformed and oversized header values keep every pause within 5 s to 60 s (fast-check seed ${SEED})`, async (t) => {
  mute(t);
  const waits = fastWaits(t);
  await fc.assert(
    fc.asyncProperty(fc.string(), async (header) => {
      waits.length = 0;
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          throw error(503, { "Retry-After": header });
        },
      });
      await fixture(model).run();
      assert.ok(calls >= 1 && calls <= 3);
      assert.ok(
        waits.every(
          (wait) => Number.isFinite(wait) && wait >= 5_000 && wait <= 60_000,
        ),
      );
    }),
    { numRuns: 100, seed: SEED },
  );
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw error(503, { "Retry-After": "9".repeat(400) });
    },
  });
  waits.length = 0;
  await fixture(model).run();
  assert.deepEqual(waits, []);
});

void test("a turn cancelled before dispatch makes no model request", async (t) => {
  mute(t);
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error();
    },
  });
  await assert.rejects(fixture(model, abort.signal).run(), {
    name: "TurnCancelledError",
  });
  assert.equal(calls, 0);
});

// ── Пробы рецензента 07.10.2026 ─────────────────────────────────────────────────────────────

const call = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): LanguageModelV4StreamPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: "{}",
  ...extra,
});
const toolsFinish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: "tool-calls" },
  usage,
};
function twoTools(runs: Record<string, number>): HarnessToolMap {
  return new Map(
    ["a", "b"].map((name) => [
      name,
      {
        name,
        description: name,
        inputSchema: z.object({}),
        execute: () => {
          runs[name] = (runs[name] ?? 0) + 1;
          return `done ${name}`;
        },
      },
    ]),
  );
}
function streamed(
  bodies: Array<() => ReadableStream<LanguageModelV4StreamPart>>,
) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const body = bodies[Math.min(calls, bodies.length - 1)];
      calls++;
      return { stream: body() };
    },
  });
  return { model, calls: () => calls };
}

void test("parallel calls broken before finish: requested again, each tool runs once", async (t) => {
  mute(t);
  fastWaits(t);
  const runs: Record<string, number> = {};
  const provider = streamed([
    () => broken([call("1a", "a"), call("1b", "b")]),
    () =>
      convertArrayToReadableStream([
        call("2a", "a"),
        call("2b", "b"),
        toolsFinish,
      ]),
  ]);
  await fixture(provider.model, undefined, twoTools(runs)).run();
  assert.equal(provider.calls(), 2);
  assert.deepEqual(runs, { a: 1, b: 1 });
});

void test("an error part after a tool call never runs the tool; nothing reached eve, so it is asked again", async (t) => {
  mute(t);
  fastWaits(t);
  const runs: Record<string, number> = {};
  const provider = streamed([
    () =>
      convertArrayToReadableStream([
        call("x", "a"),
        { type: "error", error: reset() },
        toolsFinish,
      ]),
  ]);
  const result = await fixture(provider.model, undefined, twoTools(runs)).run();
  assert.equal(runs.a ?? 0, 0);
  assert.equal(provider.calls(), 3);
  assert.equal(result.settledTurn?.isError, true);
});

void test("an error part before any content, then finish, is asked again", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const provider = streamed([
    () =>
      convertArrayToReadableStream([
        { type: "error", error: reset() },
        { ...toolsFinish, finishReason: { unified: "error", raw: "error" } },
      ]),
    () => convertArrayToReadableStream(success()),
  ]);
  const result = await fixture(provider.model).run();
  assert.equal(provider.calls(), 2);
  assert.deepEqual(waits, [5_000]);
  assert.equal(result.settledTurn?.output, "ok");
});

void test("a provider-executed call, then a break: the answer has started, no second request", async (t) => {
  mute(t);
  fastWaits(t);
  const provider = streamed([
    () => broken([call("p", "web_search", { providerExecuted: true })]),
  ]);
  const fx = fixture(provider.model);
  await fx.run();
  assert.equal(provider.calls(), 1);
  const failed = fx.events.find((event) => event.type === "turn.failed");
  assert.equal(
    (failed?.data as { details?: Record<string, unknown> }).details
      ?.answerStarted,
    true,
  );
});

void test("a call, then text, then a break: requested again, the tool never ran", async (t) => {
  mute(t);
  fastWaits(t);
  const runs: Record<string, number> = {};
  const provider = streamed([
    () =>
      broken([
        call("x", "a"),
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
      ]),
  ]);
  await fixture(provider.model, undefined, twoTools(runs)).run();
  assert.equal(provider.calls(), 3);
  assert.equal(runs.a ?? 0, 0);
});

// HTTP-провайдер отвечает 200 и кладёт ошибку в поток до первой части ответа (OpenRouter,
// OpenCode): это тот же сбой до ответа, и он просится ещё раз.
void test("200 with an error chunk before any content is requested again on the wire", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let calls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      for await (const chunk of request) void chunk;
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        response.end(
          'data: {"error":{"message":"Provider returned error","code":502}}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      response.end(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const model = createOpenAICompatible({
    name: "test",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }).chatModel("m");
  const result = await fixture(model).run();
  assert.equal(calls, 2);
  // Другие таймеры клиента (3 с) — не пауза между запросами.
  assert.deepEqual(
    waits.filter((delay) => delay === 5_000 || delay === 15_000),
    [5_000],
  );
  assert.equal(result.settledTurn?.output, "ok");
});
