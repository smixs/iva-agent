/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; model doubles implement the SDK Promise interface. */
// Граница с eve: ручная свёртка сессии (compactOnly) при динамической модели.
//
// Контракт собственного eve 0.51.1: ручная свёртка
// берёт модель без события step.started, а у агента, чей единственный резолвер модели —
// step.started (Ива: объект модели не сериализуется в журнал сессии), активного выбора в этот
// момент нет. Свёртка падала с «Dynamic model selection is required before model-dependent
// work begins», и история оставалась как была (c1, 05.10.2026). Хунк зовёт резолвер шага
// перед свёрткой. Точка удаления: eve сам диспатчит step.started для compactOnly.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { createToolLoopHarness } from "../node_modules/eve/dist/src/harness/tool-loop.js";
import type { HarnessSession } from "../node_modules/eve/dist/src/harness/types.js";
import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import { LiveStepDynamicModelSelectionKey } from "../node_modules/eve/dist/src/context/keys.js";

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
  });

const HISTORY: HarnessSession["history"] = [
  { role: "user", content: "What is the weather?" },
  { role: "assistant", content: "Sunny." },
  { role: "user", content: "And tomorrow?" },
  { role: "assistant", content: "Rain." },
];
// Агент Ивы: модель динамическая, сохранённой ссылки на модель у сессии нет.
const session = (history = HISTORY): HarnessSession =>
  ({
    agent: { system: "Reply once.", tools: [], dynamicModel: true },
    compaction: { threshold: 100_000, recentWindowSize: 1 },
    continuationToken: "test",
    sessionId: "test",
    history: [...history],
  }) as unknown as HarnessSession;

type Dispatched = { type: string; messages: number };

async function compact(
  t: TestContext,
  withResolver: boolean,
  history = HISTORY,
  summary = SUMMARY,
) {
  t.mock.method(console, "error", () => {});
  const events: string[] = [];
  const dispatched: Dispatched[] = [];
  const used = model(summary);
  const step = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    compactOnly: true,
    resolveModel: () => Promise.reject(new Error("no static model")),
    handleEvent: (event: { type: string }) => {
      events.push(event.type);
      return Promise.resolve();
    },
    ...(withResolver
      ? {
          // Двойник рантайма eve: резолвер шага кладёт живую модель в контекст.
          dispatchDynamicModelEvent: async (input: {
            ctx: ContextContainer;
            event: { type: string };
            messages: readonly unknown[];
          }) => {
            dispatched.push({
              type: input.event.type,
              messages: input.messages.length,
            });
            input.ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
              model: used,
              reference: { id: "iva/step-model" },
            });
          },
        }
      : {}),
  } as unknown as Parameters<typeof createToolLoopHarness>[0]);
  const result = await contextStorage.run(new ContextContainer(), () =>
    step(session(history), undefined),
  );
  return { events, dispatched, used, history: result.session.history };
}

test("ручная свёртка зовёт резолвер шага и пересказывает историю его моделью", async (t) => {
  const { events, dispatched, used, history } = await compact(t, true);
  assert.deepEqual(dispatched, [
    { type: "step.started", messages: HISTORY.length },
  ]);
  assert.equal(used.doGenerateCalls.length, 1, "пересказ ушёл в модель шага");
  assert.deepEqual(events, [
    "compaction.requested",
    "compaction.completed",
    "session.waiting",
  ]);
  assert.ok(history.length < HISTORY.length + 2);
  assert.ok(
    history.some(
      (message) => message.role === "assistant" && message.content === SUMMARY,
    ),
    JSON.stringify(history),
  );
});

test("без резолвера шага свёртка не падает наружу: история цела, сессия снова ждёт", async (t) => {
  const { events, used, history } = await compact(t, false);
  assert.equal(used.doGenerateCalls.length, 0);
  assert.deepEqual(events, ["session.waiting"]);
  assert.deepEqual(history, HISTORY);
});

test("ручной пересказ eve сохраняет последний текст и компактную выжимку далеко под 110 тыс. с базой 23 тыс.", async (t) => {
  const history: HarnessSession["history"] = [
    { role: "user", content: "old context ".repeat(44_000) },
    { role: "assistant", content: "old answer" },
    {
      role: "user",
      content: "Keep the unfinished goal and promised next step.",
    },
  ];
  const summary = "Outstanding goal and next step. ".repeat(750);
  const result = await compact(t, true, history, summary);
  assert.equal(result.used.doGenerateCalls.length, 1);
  assert.ok(result.history.some((message) => message.content === summary));
  assert.ok(
    result.history.some(
      (message) => message.content === history.at(-1)?.content,
    ),
  );
  const estimatedInput =
    23_000 + Math.ceil(JSON.stringify(result.history).length / 4);
  t.diagnostic(
    `estimated input after compaction including 23000 base: ${estimatedInput}`,
  );
  assert.ok(estimatedInput < 30_000, String(estimatedInput));
  assert.ok(
    estimatedInput < 110_000,
    "такой пересказ сохраняет автосвёртку включённой",
  );
});
