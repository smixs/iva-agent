import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Статус живёт в run-status, а язык — в settings: оба читают ASSISTANT_DATA_DIR
// на загрузке модуля, поэтому окружение выставляем до импорта.
const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.AGENT_LANGUAGE = "en";
const load = <T>(name: string): Promise<T> =>
  import(
    pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href
  ) as Promise<T>;
const status = await load<typeof import("./telegram-draft.ts")>(
  "./telegram-draft.ts",
);
const runStatus =
  await load<typeof import("./run-status.ts")>("./run-status.ts");

type Call = { method: string; body: Record<string, unknown> };

function handle(
  reply: (
    call: Call,
    index: number,
  ) => { ok: boolean; body: unknown } = () => ({
    ok: true,
    body: { result: { message_id: 500 } },
  }),
) {
  const calls: Call[] = [];
  return {
    calls,
    tg: {
      chatId: "77",
      request: (method: string, body?: Record<string, unknown>) => {
        const call = { method, body: body ?? {} };
        calls.push(call);
        return Promise.resolve(reply(call, calls.length - 1));
      },
    },
  };
}

await test("обычный финал освобождает запись хода без сообщений, повтор — no-op", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-1",
    draftId: 500,
  });
  const { calls, tg } = handle();
  const channel = { telegram: tg };

  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");

  // Позднее терминальное событие того же хода не должно трогать чужой статус.
  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    false,
  );
  assert.equal(calls.length, 0);
});

await test("отмена освобождает статус без пометки кнопки Стоп", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-2",
    draftId: 501,
  });
  const { tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-2", "cancelled"),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.wasCancelled, undefined);
  assert.equal(runStatus.getChatStatus(key)?.stopPressed, undefined);
});

await test("освобождение записи после сбоя хода обходится без Bot API", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-3",
    draftId: 502,
  });
  const failing = {
    chatId: "77",
    request: () => Promise.reject(new Error("Telegram 502")),
  };

  assert.equal(
    await status.finishTelegramStatus({ telegram: failing }, "s-3", "failed"),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("чужая живая сессия не трогается поздним финишем", async () => {
  // Поздний terminal освобождает только запись своей сессии.
  const key = runStatus.chatKeyOf("77", undefined);
  // Живая чужая сессия — поздний terminal от старой сессии должен быть no-op.
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-live",
    draftId: 777,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus(
      { telegram: tg },
      "s-old-finished",
      "completed",
    ),
    false,
  );
  assert.equal(calls.length, 0);
  const live = runStatus.getChatStatus(key);
  assert.equal(live?.status, "running");
  assert.equal(live?.sessionId, "s-live");
  assert.equal(live?.draftId, 777);
});

await test("своя сессия освобождает запись хода без Bot API", async () => {
  // Поздний terminal освобождает только запись своей сессии.
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-own",
    draftId: 801,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus({ telegram: tg }, "s-own", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});

await test("вход очереди переживает любой финал хода: его заберёт следующий ход", async () => {
  // eve хранит буфер входа и после отмены (steer отменяет ход ради нового сообщения), и
  // после сбоя хода: сохранённый вход начнёт следующий ход.
  const key = runStatus.chatKeyOf("77", undefined);
  const queued = {
    queuedIngressId: "ingress-Q",
    queuedIngressAt: 1_000,

    queuedSessionId: "s-q",
  };
  for (const mode of ["completed", "cancelled", "failed"] as const) {
    runStatus.setChatStatus(key, {
      status: "running",
      sessionId: "s-q",
      draftId: 900,
      ...queued,
    });
    const { calls, tg } = handle();
    assert.equal(
      await status.finishTelegramStatus({ telegram: tg }, "s-q", mode),
      true,
    );
    assert.deepEqual(
      calls.map((call) => call.body.message_id),
      [],
      mode,
    );
    const after = runStatus.getChatStatus(key);
    for (const [field, value] of Object.entries(queued))
      assert.equal(after?.[field], value, `${mode}: ${field}`);
  }
  runStatus.setChatStatus(key, {
    queuedIngressId: null,
    queuedIngressAt: null,
    queuedSessionId: null,
  });
});

process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

await test("принятое сообщение видит typing в течение 20 секунд до turn.started; CAS передаёт поток ходу", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 100_000,
  });
  t.after(() => t.mock.timers.reset());
  const { publishTelegramEarlyStatus, publishTelegramTurnStarted } =
    await import("./telegram-turn-start.ts");
  const { startTelegramAcceptedTyping, telegramDraftTurn } = status;
  const { calls, tg } = handle();
  const key = runStatus.chatKeyOf(tg.chatId);
  runStatus.setChatStatus(key, {
    status: "idle",
    sessionId: null,
    turnId: null,
    resetAt: null,
  });
  const ingressId = await publishTelegramEarlyStatus({
    chatKey: key,
    ingressId: "accepted-20s",
    getStatusImpl: runStatus.getChatStatus,
    setStatusIfImpl: runStatus.setChatStatusIf,
  });
  assert.equal(ingressId, "accepted-20s");
  startTelegramAcceptedTyping(tg, ingressId);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(4500);
    await flush();
  }
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.method === "sendChatAction"));
  assert.equal(
    await publishTelegramTurnStarted({
      chatKey: key,
      sessionId: "accepted-session",
      turnId: "accepted-turn",
      draftId: 21,
      getStatusImpl: runStatus.getChatStatus,
      setStatusIfImpl: runStatus.setChatStatusIf,
    }),
    true,
  );
  telegramDraftTurn(tg, "accepted-session", "accepted-turn", true, {
    sessionId: "accepted-session",
    turnId: "accepted-turn",
    draftId: 21,
  });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(
    calls.filter((c) => c.method === "sendRichMessageDraft").length,
    1,
  );
  await status.finishTelegramStatus(
    { telegram: tg },
    "accepted-session",
    "completed",
    "accepted-turn",
  );
  const count = calls.length;
  t.mock.timers.tick(40_000);
  await flush();
  assert.equal(calls.length, count);
});

await test("PBT смешивает ходы, шаги, инструменты, итог, старый стоп, свёртку и reset (seed 101416)", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 100_000,
  });
  t.after(() => t.mock.timers.reset());
  const fc = await import("fast-check");
  const {
    publishTelegramEarlyStatus,
    publishTelegramTurnStarted,
    chatTakeOverPatch,
  } = await import("./telegram-turn-start.ts");
  const { handleTelegramDraftStop } = await import("./telegram-stop.ts");
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  let round = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom(
          "start",
          "delta",
          "step",
          "call",
          "result",
          "final",
          "own-stop",
          "old-stop",
          "compact",
          "end",
          "reset",
        ),
        { maxLength: 40 },
      ),
      async (ops) => {
        const { calls, tg } = handle();
        const handle777 = { ...tg, chatId: "777" };
        const key = "777:";
        const sessionId = `pbt-${++round}`;
        let turn = 0;
        let draftId = 0;
        let step = 0;
        let words: string[] = [];
        let tool = false;
        let phase: "idle" | "running" | "final" | "compacting" = "idle";
        let flow: InstanceType<typeof status.TelegramDraftStream> | undefined;
        const frames = () =>
          calls.filter((c) => c.method === "sendRichMessageDraft");
        const advance = async (ms: number) => {
          t.mock.timers.tick(ms);
          await flush();
        };
        runStatus.setChatStatus(key, {
          status: "idle",
          sessionId: null,
          turnId: null,
          draftId: null,
          compacting: null,
          resetAt: null,
        });
        try {
          for (const op of ops) {
            let count = frames().length;
            if (op === "start") {
              await status.finishTelegramStatus(
                { telegram: handle777 },
                sessionId,
                "completed",
              );
              const ingress = await publishTelegramEarlyStatus({
                chatKey: key,
                ingressId: `${sessionId}-${turn}`,
                getStatusImpl: runStatus.getChatStatus,
                setStatusIfImpl: runStatus.setChatStatusIf,
              });
              assert.ok(ingress);
              turn++;
              draftId = 100 + turn;
              step = 0;
              words = [];
              tool = false;
              assert.equal(
                await publishTelegramTurnStarted({
                  chatKey: key,
                  sessionId,
                  turnId: `turn-${turn}`,
                  draftId,
                  getStatusImpl: runStatus.getChatStatus,
                  setStatusIfImpl: runStatus.setChatStatusIf,
                }),
                true,
              );
              flow = status.telegramDraftTurn(
                handle777,
                sessionId,
                `turn-${turn}`,
                true,
                { sessionId, turnId: `turn-${turn}`, draftId },
              );
              phase = "running";
            }
            if (op === "delta" && phase === "running") {
              flow?.append(step, "word ");
              words.push("word");
            }
            if (op === "step" && phase === "running") {
              step++;
              flow?.append(step, "next ");
              words = ["next"];
            }
            if (op === "call" && phase === "running") {
              flow?.requested(step, [
                { callId: "call", toolName: "bash", input: { command: "go" } },
              ]);
              tool = true;
            }
            if (op === "result" && phase === "running") {
              flow?.result("call");
              tool = false;
            }
            if (op === "final" && phase === "running") {
              await status.closeTelegramDraftTurn(sessionId, `turn-${turn}`);
              phase = "final";
            }
            if (op === "own-stop" || op === "old-stop") {
              const cancelled: Array<{ sessionId: string; turnId?: string }> =
                [];
              const own: boolean =
                op === "own-stop" && (phase === "running" || phase === "final");
              await handleTelegramDraftStop(
                {
                  chat: { id: 777, type: "private" },
                  draft_id: op === "own-stop" ? draftId : draftId - 1,
                },
                {
                  allowedImpl: () => new Set(["777"]),
                  getStatusImpl: runStatus.getChatStatus,
                  secret: "test-secret",
                  urlImpl: () => "http://localhost/cancel",
                  logImpl: () => {},
                  cancelImpl: (req) => {
                    cancelled.push(req);
                    return Promise.resolve({ status: "accepted" });
                  },
                },
              );
              assert.equal(cancelled.length, own ? 1 : 0);
              if (own) {
                assert.deepEqual(
                  cancelled.map((c) => [c.sessionId, c.turnId]),
                  [[sessionId, `turn-${turn}`]],
                );
                await status.finishTelegramStatus(
                  { telegram: handle777 },
                  sessionId,
                  "cancelled",
                  `turn-${turn}`,
                );
                phase = "idle";
              }
            }
            if (op === "compact") {
              await status.finishTelegramStatus(
                { telegram: handle777 },
                sessionId,
                "completed",
              );
              runStatus.setChatStatus(
                key,
                chatTakeOverPatch({ sessionId, compacting: true }),
              );
              phase = "compacting";
            }
            if (op === "end") {
              await status.finishTelegramStatus(
                { telegram: handle777 },
                sessionId,
                "completed",
              );
              phase = "idle";
            }
            if (op === "reset") {
              runStatus.setChatStatus(key, {
                status: "idle",
                sessionId: null,
                turnId: null,
                draftId: null,
                compacting: null,
                resetAt: Date.now(),
              });
              await advance(4500);
              phase = "idle";
              count = frames().length;
              const afterReset = status.telegramDraftTurn(
                handle777,
                sessionId,
                `turn-${turn}`,
                true,
              );
              assert.ok(afterReset === undefined || afterReset.closed);
            }
            await advance(1000);
            if (phase !== "running") {
              assert.equal(frames().length, count, `frame after ${op}`);
              continue;
            }
            const markdown = (
              frames().at(-1)?.body.rich_message as { markdown: string }
            ).markdown;
            const expected: string =
              [words.join(" "), tool ? "⚙ <code>bash: go</code>" : ""]
                .filter(Boolean)
                .join("\n\n") || "<tg-thinking>Thinking…</tg-thinking>";
            assert.equal(markdown, expected);
            assert.equal(frames().at(-1)?.body.draft_id, draftId);
          }
        } finally {
          await status.finishTelegramStatus(
            { telegram: handle777 },
            sessionId,
            "completed",
          );
        }
      },
    ),
    { seed: 101416, numRuns: 60 },
  );
});
