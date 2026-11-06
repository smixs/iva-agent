import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TelegramQueueUpdate as TelegramUpdate } from "./lib/telegram-queue.ts";

const dir = mkdtempSync(join(tmpdir(), "iva-restart-button-"));
process.env.ASSISTANT_DATA_DIR = dir;
process.env.TELEGRAM_BOT_TOKEN = "424242:test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.AGENT_LANGUAGE = "ru";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const status = await import("../agent/lib/run-status.ts");
const queue = await import("./poller/queue.ts");
const { handleControl } = await import("./poller/control.ts");
const { chatTakeOverPatch } =
  await import("../agent/lib/telegram-turn-start.ts");

let nextChat = 9000;
async function interrupted(
  text = "Вопрос <tg-button> **текст**",
  media = false,
  group = false,
  en = false,
  thread = "",
) {
  const id = ++nextChat * (group ? -1 : 1);
  const key = `${id}:${thread}`;
  status.setChatStatus(key, {
    status: "running",
    sessionId: "interrupted",
    turnId: `t-${id}`,
    turnQuestion: text,
    turnQuestionMedia: media,
  });
  const sent: string[] = [];
  const deps = {
    listStatusesImpl: () => [
      { chatKey: key, status: status.getChatStatus(key) },
    ],
    now: () => Date.now() + 100_000,
    staleMs: 1,
    resetImpl: async () => {},
    sendImpl: (_key: string, message: string) => {
      sent.push(message);
      return Promise.resolve();
    },
    deleteMessageImpl: async () => {},
    logImpl: () => {},
    trImpl: (english: string, russian: string) => (en ? english : russian),
  };
  assert.equal(await queue.reapStaleRuns(deps), 1);
  assert.equal(await queue.reapStaleRuns(deps), 0);
  assert.equal(sent.length, 1);
  const data = /data="([^"]+)"/u.exec(sent[0])?.[1];
  return { id, key, notice: sent[0], data };
}
function tap(
  fx: Awaited<ReturnType<typeof interrupted>>,
  updateId: number,
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Owner" },
      data: fx.data!,
      message: {
        message_id: fx.id,
        date: 1,
        chat: { id: fx.id, type: "private" },
        text: fx.notice.replace(/<tg-button-row>[\s\S]*<\/tg-button-row>/u, ""),
      },
    },
  };
}
const io = {
  ackImpl: async () => {},
  editTapImpl: () => Promise.resolve(true),
  scheduleImpl: () => false,
};

void test("double restart emits one escaped question and rich button, RU/EN", async () => {
  for (const en of [false, true]) {
    const fx = await interrupted(undefined, false, false, en);
    assert.match(fx.notice, /<tg-button-row>/u);
    assert.ok(fx.data?.startsWith(en ? "Try again:" : "Повторить:"));
    assert.ok(Buffer.byteLength(fx.data!) <= 64);
    assert.ok(!fx.notice.includes("Вопрос <tg-button>"));
    assert.match(
      fx.notice,
      en ? /previous turn was interrupted/u : /Предыдущий ход оборвался/u,
    );
  }
});
void test("tap resubmits the full accepted question once, including after Bridge reload", async () => {
  const question = "Составь письмо ".repeat(70);
  const fx = await interrupted(question);
  assert.ok(fx.data);
  const first = tap(fx, 100);
  assert.equal(await handleControl(first, io), false);
  assert.ok(first.message?.text?.includes(question));
  assert.ok(!first.message?.text?.includes(fx.data.split(":")[1]));
  const { handleControl: reloaded } = (await import(
    `./poller/control.ts?restarted=${fx.id}`
  )) as typeof import("./poller/control.ts");
  assert.equal(await reloaded(tap(fx, 101), io), true);
  // A redelivery of the same update can still reach durable inbox deduplication.
  assert.equal(await reloaded(tap(fx, 100), io), false);
});
void test("a tap after /new or a newer accepted turn is stale", async () => {
  for (const reset of [true, false]) {
    const fx = await interrupted();
    if (reset)
      await queue.completeScopedResetState(fx.key, {
        clearQueue: false,
        deleteMessageImpl: async () => {},
      });
    else status.setChatStatus(fx.key, chatTakeOverPatch({ status: "idle" }));
    assert.equal(await handleControl(tap(fx, reset ? 200 : 201), io), true);
  }
});
void test("an old notification cannot submit the next interrupted question", async () => {
  const fx = await interrupted("старый вопрос");
  status.setChatStatus(fx.key, {
    status: "running",
    turnQuestion: "новый вопрос",
  });
  await queue.reapStaleRuns({
    now: () => Date.now() + 100_000,
    staleMs: 1,
    resetImpl: async () => {},
    sendImpl: async () => {},
    deleteMessageImpl: async () => {},
    logImpl: () => {},
  });
  assert.equal(await handleControl(tap(fx, 300), io), true);
});
void test("missing question, attachment and group use the existing break-notice rules", async () => {
  const empty = await interrupted("");
  assert.match(empty.notice, /<tg-button/u);
  const media = await interrupted("файл", true);
  assert.match(media.notice, /Пришли сообщение с вложением ещё раз/u);
  assert.equal(media.data, undefined);
  for (const en of [false, true]) {
    const group = await interrupted("ЛИЧНЫЙ ВОПРОС", false, true, en);
    assert.ok(!group.notice.includes("ЛИЧНЫЙ ВОПРОС"));
    assert.equal(group.data, undefined);
    const topic = await interrupted(
      "PRIVATE TOPIC QUESTION",
      false,
      false,
      en,
      "45",
    );
    assert.ok(!topic.notice.includes("PRIVATE TOPIC QUESTION"));
    assert.equal(topic.data, undefined);
  }
});

void test("Outbox sends the escaped quote and button on the Telegram wire, including a topic", async () => {
  const fx = await interrupted(
    'Вопрос <tg-button type="callback_data" data="bad">bad</tg-button>',
  );
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assert.equal(typeof init?.body, "string");
    calls.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        status: 200,
      }),
    );
  };
  try {
    await queue.sendInterruptedTurnNotice("900:17", fx.notice);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/sendRichMessage"));
  assert.equal(calls[0].body.chat_id, "900");
  assert.equal(calls[0].body.message_thread_id, "17");
  const markdown = (calls[0].body.rich_message as { markdown: string })
    .markdown;
  assert.equal((markdown.match(/<tg-button type=/gu) ?? []).length, 1);
  assert.ok(!markdown.includes('<tg-button type="callback_data" data="bad"'));
  assert.ok(markdown.includes(fx.data!));
});
void test("a Telegram refusal is logged once and the interrupted turn stays closed", async () => {
  const fx = await interrupted();
  status.setChatStatus(fx.key, { status: "running", sessionId: "failed-send" });
  let sends = 0;
  const errors: unknown[][] = [];
  const deps = {
    listStatusesImpl: () => [
      { chatKey: fx.key, status: status.getChatStatus(fx.key) },
    ],
    now: () => Date.now() + 100_000,
    staleMs: 1,
    resetImpl: async () => {},
    deleteMessageImpl: async () => {},
    sendImpl: () => {
      sends++;
      return Promise.reject(new Error("Telegram 403"));
    },
    logImpl: (...parts: unknown[]) => {
      errors.push(parts);
    },
  };
  assert.equal(await queue.reapStaleRuns(deps), 1);
  assert.equal(await queue.reapStaleRuns(deps), 0);
  assert.equal(sends, 1);
  assert.equal(errors.length, 1);
  assert.equal(status.getChatStatus(fx.key)?.status, "idle");
});

void test("an English notification still submits its original question after a language change", async () => {
  const fx = await interrupted("Send my question", false, false, true);
  const update = tap(fx, 401);
  assert.equal(await handleControl(update, io), false);
  assert.ok(update.message?.text?.includes("Send my question"));
});
void test("group and untrusted taps keep the question out of the model", async () => {
  const fx = await interrupted("private question");
  const foreign = tap(fx, 501);
  foreign.callback_query!.from!.id = 999;
  await handleControl(foreign, io);
  assert.equal(foreign.message, undefined);
  assert.equal(status.getChatStatus(fx.key)?.restartRetryUpdate, undefined);
  const group = tap(fx, 502);
  group.callback_query!.message!.chat = { id: -100, type: "supergroup" };
  assert.equal(await handleControl(group, io), true);
  assert.equal(group.message, undefined);
});

void test("restart notice has a shared 30s deadline and leaves the reaped turn idle", async (t) => {
  const fx = await interrupted("network stall");
  status.setChatStatus(fx.key, { status: "running", sessionId: "hung-send" });
  const errors: unknown[][] = [];
  const timeouts: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return timeout(25);
  });
  t.mock.method(
    globalThis,
    "fetch",
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason)),
          );
        else
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error(String(signal.reason)),
              ),
            {
              once: true,
            },
          );
      }),
  );
  const started = performance.now();
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      queue.reapStaleRuns({
        listStatusesImpl: () => [
          { chatKey: fx.key, status: status.getChatStatus(fx.key) },
        ],
        now: () => Date.now() + 100_000,
        staleMs: 1,
        resetImpl: async () => {},
        deleteMessageImpl: async () => {},
        logImpl: (...parts: unknown[]) => {
          errors.push(parts);
        },
      }),
      new Promise<string>((resolve) => {
        guard = setTimeout(() => resolve("hung"), 500);
      }),
    ]);
    assert.equal(result, 1);
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(timeouts, [30_000]);
    assert.equal(status.getChatStatus(fx.key)?.status, "idle");
    assert.equal(errors.length, 1);
    assert.match(
      String(errors[0]),
      /stale run notification failed.*(timeout|aborted)/iu,
    );
  } finally {
    clearTimeout(guard);
  }
});

void test("a tap keeps its snapshotted question after a literal old-version takeover and return", async () => {
  const fx = await interrupted("original question");
  const prev = status.getChatStatus(fx.key);
  // chatTakeOverPatch from 16bd1b7d, with the old caller carrying ...prev.
  status.setChatStatus(fx.key, {
    status: "running",
    ingressId: null,
    ingressAt: null,
    turnAt: null,
    firstOutputAt: null,
    sessionId: null,
    turnId: null,
    compacting: null,
    draftId: null,
    latencyLogged: null,
    resetAt: null,
    ...prev,
  });
  const { rememberTurnQuestion } =
    await import("../agent/lib/turn-question.ts");
  rememberTurnQuestion(fx.key, {
    text: "new question after rollback",
    media: true,
  });
  const update = tap(fx, 601);
  assert.equal(await handleControl(update, io), false);
  assert.ok(update.message?.text?.includes("original question"));
  assert.ok(!update.message?.text?.includes("new question after rollback"));
});

void test("restart notification trace carries its own source", () => {
  const traceDir = join(dir, "trace");
  const events = readdirSync(traceDir).flatMap((file) =>
    readFileSync(join(traceDir, file), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { source: string; kind: string; name: string },
      ),
  );
  const deliveries = events.filter(
    (event) => event.kind === "outbox" && event.name === "delivered",
  );
  assert.ok(deliveries.length > 0);
  assert.ok(deliveries.every((event) => event.source === "restart-notice"));
});
