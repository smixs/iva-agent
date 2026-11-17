/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { QuestionState } from "../agent/lib/telegram-question.ts";

const dataDir = mkdtempSync(join(tmpdir(), "iva-question-events-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "question-test-token";
process.env.TELEGRAM_RICH_REPLIES = "auto";
process.env.ASSISTANT_BEARER = "question-test-bearer";
after(() => rmSync(dataDir, { recursive: true, force: true }));

const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let failEdits = false;
let onPreviewEdit: (() => void) | undefined;
globalThis.fetch = (url, init) => {
  const address =
    url instanceof Request ? url.url : url instanceof URL ? url.href : url;
  const method = new URL(address).pathname.split("/").at(-1)!;
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  calls.push({ method, body });
  if (method === "compact")
    return Promise.resolve(
      Response.json(
        { ok: true, sessionId: "question-compaction", status: "accepted" },
        { status: 202 },
      ),
    );
  if (method === "editMessageText") onPreviewEdit?.();
  if (failEdits && method.startsWith("edit"))
    return Promise.resolve(
      Response.json(
        { ok: false, description: "cannot edit now" },
        { status: 503 },
      ),
    );
  return Promise.resolve(
    Response.json({
      ok: true,
      result: {
        message_id: calls.length + 100,
        chat: { id: 7, type: "private" },
      },
    }),
  );
};

const [
  { default: channel },
  { ContextContainer, contextStorage },
  { SessionKey },
] = await Promise.all([
  import("../agent/channels/telegram.ts"),
  import("../node_modules/eve/dist/src/context/container.js"),
  import("../node_modules/eve/dist/src/context/keys.js"),
]);
type Adapter = {
  state: QuestionState;
  createAdapterContext: (base: {
    ctx: unknown;
    session: unknown;
    state: QuestionState;
  }) => unknown;
  [name: `input.${string}` | `turn.${string}` | `session.${string}`]: (
    data: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<void>;
};
const adapter = (channel as unknown as { adapter: Adapter }).adapter;
function context(
  state: QuestionState = {
    ...adapter.state,
    chatId: "7",
    chatType: "private",
    messageThreadId: null,
  },
  rekeys: string[] = [],
  sessionId = "questions",
) {
  const ctx = new ContextContainer();
  ctx.set(SessionKey, {
    sessionId,
    auth: { current: null, initiator: null },
    turn: { id: "turn_0", sequence: 0 },
  });
  const value = adapter.createAdapterContext({
    ctx,
    state,
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      continuation: {
        token: "7::",
        rekey(token: string) {
          rekeys.push(token);
        },
      },
    },
  });
  return {
    state,
    rekeys,
    emit: (name: EventName, data: Record<string, unknown>) =>
      contextStorage.run(ctx, () => adapter[name](data, value)),
  };
}
type EventName =
  | "input.requested"
  | "input.resolved"
  | "turn.started"
  | "turn.completed"
  | "turn.cancelled"
  | "session.waiting";
const request = {
  requestId: "q",
  kind: "question",
  prompt: "Confirm operation?",
  action: {
    callId: "c",
    kind: "tool-call",
    toolName: "ask_question",
    input: {},
  },
  options: [
    { id: "yes", label: "Confirm" },
    { id: "no", label: "Cancel" },
  ],
};

test("authored Telegram channel settles rich choices only after Eve input.resolved", async () => {
  const harness = context();
  const before = calls.length;
  await harness.emit("input.requested", { requests: [request] });
  const sent = calls.at(-1)!;
  assert.equal(sent.method, "sendRichMessage");
  assert.match(JSON.stringify(sent.body), /tg-button/u);
  await harness.emit("turn.cancelled", { turnId: "turn_0" });
  assert.equal(calls.length, before + 1);
  assert.equal(harness.state.questionPreviews?.q.settledStatus, undefined);
  await harness.emit("input.resolved", {
    resolutions: [
      {
        requestId: "q",
        kind: "question",
        outcome: "answered",
        response: { optionId: "no" },
      },
    ],
  });
  const edited = calls.at(-1)!;
  assert.equal(edited.method, "editMessageText");
  assert.match(JSON.stringify(edited.body), /Selected: Cancel/u);
  assert.doesNotMatch(JSON.stringify(edited.body), /tg-button|succeeded/u);
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(harness.state.hitlCallbacks, {});
  assert.deepEqual(harness.state.questionPreviews, {});
  const completed = calls.length;
  await harness.emit("input.resolved", {
    resolutions: [
      { requestId: "q", outcome: "answered", response: { optionId: "yes" } },
    ],
  });
  assert.equal(calls.length, completed);
});

test("accepted preview status recovers from durable channel state through session.waiting", async (t) => {
  t.mock.method(console, "error", () => {});
  const harness = context();
  await harness.emit("input.requested", { requests: [request] });
  failEdits = true;
  await harness.emit("input.resolved", {
    resolutions: [
      { requestId: "q", outcome: "approved", response: { optionId: "yes" } },
    ],
  });
  assert.ok(harness.state.questionPreviews?.q.settledStatus);
  assert.deepEqual(harness.state.hitlCallbacks, {});
  const recovered = context(
    JSON.parse(JSON.stringify(harness.state)) as QuestionState,
  );
  const before = calls.length;
  failEdits = false;
  await recovered.emit("session.waiting", {});
  assert.deepEqual(
    calls.slice(before).map(({ method }) => method),
    ["editMessageText"],
  );
  assert.deepEqual(recovered.state.questionPreviews, {});
});

test("freeform question keeps native ForceReply; accepted private text is not echoed", async () => {
  const harness = context();
  await harness.emit("input.requested", {
    requests: [{ ...request, options: undefined }],
  });
  const sent = calls.at(-1)!;
  assert.equal(sent.method, "sendMessage");
  assert.equal(
    (sent.body.reply_markup as { force_reply: boolean }).force_reply,
    true,
  );
  assert.equal(
    Object.values(harness.state.pendingFreeformReplies ?? {})[0],
    "q",
  );
  await harness.emit("input.resolved", {
    resolutions: [
      {
        requestId: "q",
        outcome: "answered",
        response: { text: "private-answer-marker" },
      },
    ],
  });
  const edited = calls.at(-1)!;
  assert.equal(edited.method, "editMessageText");
  assert.match(String(edited.body.text), /Answer received/u);
  assert.doesNotMatch(JSON.stringify(edited.body), /private-answer-marker/u);
  assert.deepEqual(harness.state.pendingFreeformReplies, {});
});

test("authored rich question rekeys a group session through public Eve continuation ops", async () => {
  const harness = context({
    ...adapter.state,
    chatId: "-7",
    chatType: "supergroup",
    conversationId: "123",
    messageThreadId: 42,
  });
  await harness.emit("input.requested", { requests: [request] });
  const preview = harness.state.questionPreviews!.q;
  assert.equal(calls.at(-1)!.method, "sendRichMessage");
  assert.equal(calls.at(-1)!.body.message_thread_id, 42);
  assert.equal(harness.state.conversationId, String(preview.messageId));
  assert.deepEqual(harness.rekeys, [`-7:42:${String(preview.messageId)}`]);
});

test("preview delivery survives a duplicate resolution: it retries only the accepted preview", async (t) => {
  t.mock.method(console, "error", () => {});
  t.after(() => {
    failEdits = false;
    onPreviewEdit = undefined;
  });
  const sessionId = "question-compaction";
  const harness = context(
    {
      ...adapter.state,
      chatId: "977",
      chatType: "private",
      conversationId: null,
      messageThreadId: null,
    },
    [],
    sessionId,
  );
  await harness.emit("turn.started", { turnId: "turn_0" });
  await harness.emit("input.requested", { requests: [request] });
  failEdits = true;
  await harness.emit("input.resolved", {
    resolutions: [
      { requestId: "q", outcome: "answered", response: { optionId: "yes" } },
    ],
  });
  await harness.emit("turn.completed", { turnId: "turn_0" });
  assert.ok(harness.state.questionPreviews?.q.settledStatus);
  await harness.emit("session.waiting", {});
  // Duplicate resolution retries only the accepted preview.
  await harness.emit("input.resolved", {
    resolutions: [
      { requestId: "q", outcome: "answered", response: { optionId: "yes" } },
    ],
  });
  failEdits = false;
  await harness.emit("input.resolved", {
    resolutions: [
      { requestId: "q", outcome: "answered", response: { optionId: "yes" } },
    ],
  });
  assert.deepEqual(harness.state.questionPreviews, {});
  assert.deepEqual(harness.state.hitlCallbacks, {});
});
