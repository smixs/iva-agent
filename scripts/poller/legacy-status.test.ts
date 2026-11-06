/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; fetch doubles preserve the wire boundary. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import fc from "fast-check";

const dataDir = mkdtempSync(join(tmpdir(), "iva-legacy-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "424242:legacy-test";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "legacy-test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let respond: (call: Call) => void = () => {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const body = init?.body;
  assert.ok(typeof body === "string");
  const call = {
    method: url.slice(url.lastIndexOf("/") + 1),
    body: JSON.parse(body) as Record<string, unknown>,
  };
  calls.push(call);
  respond(call);
  return Response.json({ ok: true, result: true, status: "accepted" });
};

const { completeScopedResetState, reapStaleRuns } = await import("./queue.ts");
const { handleControl } = await import("./control.ts");
const { getChatStatus, setChatStatus } = await import("#lib/run-status.ts");
const statusDir = join(dataDir, "run-status.d");
mkdirSync(statusDir, { recursive: true });

function legacyStatus(patch: Record<string, unknown> = {}) {
  writeFileSync(
    join(statusDir, `${Buffer.from("42:").toString("base64url")}.json`),
    JSON.stringify({
      status: "running",
      generation: 4,
      updatedAt: 100,
      sessionId: "old-session",
      turnId: "old-turn",
      statusMessageId: 42,
      statusAt: 1,
      queuedStatusMessageId: 43,
      queuedStatusAt: 2,
      ...patch,
    }),
  );
}

function stopButton(messageId = 42) {
  return {
    update_id: 1,
    callback_query: {
      id: "legacy-tap",
      data: "iva_cancel",
      from: { id: 42 },
      message: {
        message_id: messageId,
        date: 1,
        chat: { id: 42, type: "private" },
      },
    },
  };
}

const deletions = () => calls.filter((call) => call.method === "deleteMessage");
const expectedDeletes: Call[] = [42, 43].map((id) => ({
  method: "deleteMessage",
  body: { chat_id: "42", message_id: id },
}));
const reap = () =>
  reapStaleRuns({
    now: () => 10_000_000,
    inFlight: new Map(),
    resetImpl: async () => {},
    sendImpl: async () => {},
  });

beforeEach(() => {
  calls.length = 0;
  respond = () => {};
  legacyStatus();
});
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

test("reaping an interrupted 0.4.17 turn deletes both messages at the Bot API boundary", async () => {
  legacyStatus({ wasCancelled: true });
  assert.equal(await reap(), 1);
  assert.deepEqual(deletions(), expectedDeletes);
  assert.equal(getChatStatus("42:")?.stopPressed, undefined);
  assert.equal(getChatStatus("42:")?.wasCancelled, undefined);
  assert.equal(getChatStatus("42:")?.statusMessageId, undefined);
  assert.equal(getChatStatus("42:")?.queuedStatusMessageId, undefined);
});

test("a heartbeat retains inherited message IDs until the interrupted turn is reaped", async () => {
  setChatStatus("42:", { ingressId: "queued-input" });
  assert.equal(getChatStatus("42:")?.statusMessageId, 42);
  assert.equal(getChatStatus("42:")?.queuedStatusMessageId, 43);
  assert.equal(
    await reapStaleRuns({
      now: () => (getChatStatus("42:")?.updatedAt ?? 0) + 10_000_000,
      resetImpl: async () => {},
      sendImpl: async () => {},
    }),
    1,
  );
  assert.deepEqual(deletions(), expectedDeletes);
  assert.equal(getChatStatus("42:")?.stopPressed, undefined);
  assert.equal(getChatStatus("42:")?.wasCancelled, undefined);
});

test("scoped reset deletes both inherited messages and clears their fields", async () => {
  legacyStatus({ wasCancelled: true });
  await completeScopedResetState("42:");
  assert.equal(getChatStatus("42:")?.stopPressed, undefined);
  assert.equal(getChatStatus("42:")?.wasCancelled, undefined);
  assert.deepEqual(deletions(), expectedDeletes);
  assert.equal(getChatStatus("42:")?.status, "idle");
  assert.equal(getChatStatus("42:")?.statusMessageId, undefined);
  assert.equal(getChatStatus("42:")?.queuedStatusMessageId, undefined);
});

test("a failed deletion still attempts the queue message and completes reset", async () => {
  respond = (call) => {
    if (call.method === "deleteMessage" && call.body.message_id === 42)
      throw new Error("Telegram unavailable");
  };
  await completeScopedResetState("42:");
  assert.deepEqual(deletions(), expectedDeletes);
  assert.equal(getChatStatus("42:")?.status, "idle");
});

test("failed queue cleanup and rejected stale CAS preserve inherited messages", async () => {
  await assert.rejects(
    completeScopedResetState("42:", {
      clearQueue: true,
      clearQueueImpl: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(
    await reapStaleRuns({ now: () => 10_000_000, setStatusIfImpl: () => null }),
    0,
  );
  assert.deepEqual(calls, []);
  assert.equal(getChatStatus("42:")?.statusMessageId, 42);
});

test("an old Stop button only acknowledges and deletes its message during a new turn", async () => {
  legacyStatus({
    statusMessageId: 99,
    sessionId: "new-session",
    turnId: "new-turn",
  });
  assert.equal(await handleControl(stopButton()), true);
  assert.deepEqual(calls, [
    {
      method: "answerCallbackQuery",
      body: { callback_query_id: "legacy-tap" },
    },
    { method: "deleteMessage", body: { chat_id: 42, message_id: 42 } },
  ]);
  assert.equal(getChatStatus("42:")?.turnId, "new-turn");
});

test("a matching inherited Stop button cancels the captured pair even if ack starts a new turn", async () => {
  respond = (call) => {
    if (call.method === "answerCallbackQuery")
      setChatStatus("42:", {
        sessionId: "new-session",
        turnId: "new-turn",
        draftId: 99,
      });
  };
  assert.equal(await handleControl(stopButton()), true);
  assert.deepEqual(
    calls.filter((call) => call.method === "cancel"),
    [
      {
        method: "cancel",
        body: { sessionId: "old-session", turnId: "old-turn" },
      },
    ],
  );
  assert.equal(getChatStatus("42:")?.turnId, "new-turn");
});

test("Stop on a new draft without inherited status and on compaction never cancels", async () => {
  for (const patch of [
    { statusMessageId: null },
    { turnId: null, compacting: true },
  ]) {
    legacyStatus(patch);
    assert.equal(await handleControl(stopButton()), true);
  }
  assert.equal(calls.filter((call) => call.method === "cancel").length, 0);
  assert.equal(deletions().length, 2);
});

test("legacy Stop identity is scoped to its running turn and message ID", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      async (messageId, matches, running, hasTurn) => {
        calls.length = 0;
        legacyStatus({
          status: running ? "running" : "idle",
          statusMessageId: matches ? messageId : messageId + 1,
          turnId: hasTurn ? "old-turn" : null,
        });
        assert.equal(await handleControl(stopButton(messageId)), true);
        const cancels = calls.filter((call) => call.method === "cancel");
        assert.equal(cancels.length, Number(matches && running && hasTurn));
        if (cancels.length > 0)
          assert.deepEqual(cancels[0].body, {
            sessionId: "old-session",
            turnId: "old-turn",
          });
        else assert.equal(deletions()[0].body.message_id, messageId);
      },
    ),
    { seed: 20261015, numRuns: 48, verbose: true },
  );
});
