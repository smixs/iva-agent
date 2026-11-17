/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; model doubles implement the SDK Promise interface. */
// Граница с eve: пометка ручной свёртки и один проход свёртки перед шагом модели.
// /compact не сворачивает сам — compactOnly ставит сессии пометку manualRequested, которую
// забирает тот же проход свёртки перед следующим шагом. Модель у Ивы динамическая —
// step.started обычного шага её разрешает, отдельного резолвера для свёртки не нужно.
import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { createToolLoopHarness } from "../node_modules/eve/dist/src/harness/tool-loop.js";
import type { HarnessSession } from "../node_modules/eve/dist/src/harness/types.js";
import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";

const SUMMARY = "Checkpoint: the owner asked about the weather twice.";

const model = (summary = SUMMARY) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: summary }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "answer" });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          });
          c.close();
        },
      }),
    }),
  });

// Старшая часть заведомо длиннее пересказа: гейт «короче заменённого» детерминирован.
const OLDER = [
  { role: "user", content: `What is the weather? ${"context ".repeat(600)}` },
  { role: "assistant", content: `Sunny. ${"detail ".repeat(600)}` },
  { role: "user", content: `And the day after? ${"context ".repeat(600)}` },
  { role: "assistant", content: `Wind. ${"detail ".repeat(600)}` },
] as const;
const TAIL = [
  { role: "user", content: "And tomorrow?" },
  { role: "assistant", content: "Rain." },
] as const;
const HISTORY: HarnessSession["history"] = [...OLDER, ...TAIL] as never;

const session = (
  history: HarnessSession["history"] = HISTORY,
  compaction: Record<string, unknown> = {},
): HarnessSession =>
  ({
    agent: {
      system: "Reply once.",
      tools: [],
      modelReference: { id: "iva/step-model" },
    },
    compaction: {
      threshold: 100_000,
      recentWindowTokens: 20_000,
      summaryMaxOutputTokens: 4_000,
      ...compaction,
    },
    continuationToken: "test",
    sessionId: "test",
    history: [...history],
  });

test("compactOnly ставит пометку и ждёт: без вызова модели и без усечения истории", async () => {
  const events: string[] = [];
  const used = model();
  const harness = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    compactOnly: true,
    resolveModel: () => Promise.resolve(used),
    handleEvent: (event: { type: string }) => {
      events.push(event.type);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const start = session();
  const result = await contextStorage.run(new ContextContainer(), () =>
    harness(start, undefined),
  );
  assert.equal(used.doGenerateCalls.length, 0);
  assert.deepEqual(events, ["session.waiting"]);
  assert.deepEqual(result.session.history, HISTORY);
  assert.equal(result.session.compaction.manualRequested, true);
});

test("помеченная сессия: следующий шаг делает один вызов пересказа и снимает пометку", async (t) => {
  t.mock.method(console, "error", () => {});
  const events: string[] = [];
  const used = model();
  const marked = session(HISTORY, { manualRequested: true, threshold: 1_000 });
  const harness = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    resolveModel: () => Promise.resolve(used),
    handleEvent: (event: { type: string }) => {
      events.push(event.type);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const result = await contextStorage.run(new ContextContainer(), () =>
    harness(marked, { message: "hi" }),
  );
  const compactionCall = used.doGenerateCalls[0];
  assert.equal(used.doGenerateCalls.length, 1, "пересказ");
  assert.equal(used.doStreamCalls.length, 1, "ответ шага");
  assert.ok(
    JSON.stringify(compactionCall?.prompt).includes("CHECKPOINT"),
    "первый вызов — пересказ",
  );
  assert.ok(events.includes("compaction.requested"));
  assert.ok(events.includes("compaction.completed"));
  const history = result.session.history as Array<{ content: unknown }>;
  assert.ok(history.some((message) => message.content === SUMMARY));
  // ~20 тыс. токенов хвоста дословно: последняя пара сообщений цела.
  assert.ok(history.some((message) => message.content === "And tomorrow?"));
  assert.ok(history.some((message) => message.content === "Rain."));
  assert.equal(result.session.compaction.manualRequested, undefined);
});

test("две пометки подряд — один проход: пометка идемпотентна до следующего шага", async (t) => {
  t.mock.method(console, "error", () => {});
  const events: string[] = [];
  const used = model();
  const mark = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    compactOnly: true,
    resolveModel: () => Promise.resolve(used),
    handleEvent: () => Promise.resolve(),
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const markedOnce = await contextStorage.run(new ContextContainer(), () =>
    mark(session(HISTORY, { threshold: 1_000 }), undefined),
  );
  const markedTwice = await contextStorage.run(new ContextContainer(), () =>
    mark(markedOnce.session, undefined),
  );
  const harness = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    resolveModel: () => Promise.resolve(used),
    handleEvent: (event: { type: string }) => {
      events.push(event.type);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const result = await contextStorage.run(new ContextContainer(), () =>
    harness(markedTwice.session, { message: "hi" }),
  );
  assert.equal(
    used.doGenerateCalls.filter((call) =>
      JSON.stringify(call.prompt).includes("CHECKPOINT"),
    ).length,
    1,
    "один вызов пересказа на одну пометку",
  );
  assert.equal(result.session.compaction.manualRequested, undefined);
});

test("отклонённый пересказ: история цела, повтор только после роста входа, ручная пометка ворота обходит", async (t) => {
  t.mock.method(console, "error", () => {});
  const events: string[] = [];
  // Пересказ длиннее заменяемого — eve его отклоняет.
  const longSummary = "not shorter. ".repeat(4_000);
  const used = model(longSummary);
  const smallThreshold = session(HISTORY, {
    manualRequested: true,
    threshold: 1,
  });
  const harness = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    resolveModel: () => Promise.resolve(used),
    handleEvent: (event: { type: string }) => {
      events.push(event.type);
      return Promise.resolve();
    },
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const first = await contextStorage.run(new ContextContainer(), () =>
    harness(smallThreshold, { message: "hi" }),
  );
  const summaryCalls = () =>
    used.doGenerateCalls.filter((call) =>
      JSON.stringify(call.prompt).includes("CHECKPOINT"),
    ).length;
  assert.equal(summaryCalls(), 1);
  const history = first.session.history as Array<{ content: unknown }>;
  assert.ok(
    history.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.startsWith("What is the weather?"),
    ),
    "история осталась как была",
  );
  assert.ok(
    !history.some((message) => message.content === longSummary),
    "отклонённый пересказ в историю не попал",
  );
  const failedAt = first.session.compaction.failedAttemptInputTokens;
  assert.ok(typeof failedAt === "number" && failedAt > 0);
  assert.equal(first.session.compaction.manualRequested, undefined);

  // Ворота: вход не вырос за записанный размер — автоматическая попытка не зовёт модель.
  const gated = await contextStorage.run(new ContextContainer(), () =>
    harness(
      {
        ...first.session,
        compaction: {
          ...first.session.compaction,
          threshold: 1,
          failedAttemptInputTokens: 10_000_000,
        },
      },
      { message: "hi again" },
    ),
  );
  assert.equal(summaryCalls(), 1, "вход не вырос за записанный размер — повтора нет");
  assert.equal(gated.session.compaction.failedAttemptInputTokens, 10_000_000);

  // Рост за записанный размер — попытка снова разрешена.
  await contextStorage.run(new ContextContainer(), () =>
    harness(
      {
        ...first.session,
        compaction: {
          ...first.session.compaction,
          threshold: 1,
          failedAttemptInputTokens: 1,
        },
      },
      { message: "hi again" },
    ),
  );
  assert.equal(summaryCalls(), 2, "вход вырос — попытка разрешена");

  // Ручная пометка обходит ворота: владелец попросил явно.
  const manual = await contextStorage.run(new ContextContainer(), () =>
    harness(
      {
        ...gated.session,
        compaction: { ...gated.session.compaction, manualRequested: true },
      },
      { message: "once more" },
    ),
  );
  assert.equal(summaryCalls(), 3, "ручная пометка обходит ворота роста");
  assert.equal(manual.session.compaction.manualRequested, undefined);
});
