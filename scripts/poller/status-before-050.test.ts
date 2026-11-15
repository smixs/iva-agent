/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; fetch doubles preserve the wire boundary. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

// UpdateFloor.NoSilentLoss: releases before 0.5.0 kept a status message with a Stop button
// in the chat and its ids in the chat record. The bridge no longer deletes those messages
// and no longer claims that button: nothing is cancelled or removed on its account.
const dataDir = mkdtempSync(join(tmpdir(), "iva-status-before-050-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "424242:status-test";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "status-test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
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
  return Response.json({ ok: true, result: true, status: "accepted" });
};

const { completeScopedResetState, reapStaleRuns } = await import("./queue.ts");
const { handleControl } = await import("./control.ts");
const { getChatStatus } = await import("#lib/run-status.ts");
const statusDir = join(dataDir, "run-status.d");
mkdirSync(statusDir, { recursive: true });

function oldStatus(patch: Record<string, unknown> = {}) {
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
      id: "old-tap",
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

const stale = () => calls.filter((call) => call.method !== "sendMessage");
const reap = () =>
  reapStaleRuns({
    now: () => 10_000_000,
    inFlight: new Map(),
    resetImpl: async () => {},
    sendImpl: async () => {},
  });

beforeEach(() => {
  calls.length = 0;
  oldStatus();
});
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

test("NoSilentLoss: a reset and a reap of a record with status messages of a release before 0.5.0 delete nothing in the chat", async () => {
  await completeScopedResetState("42:");
  assert.deepEqual(calls, []);
  assert.equal(getChatStatus("42:")?.status, "idle");

  oldStatus({ wasCancelled: true });
  assert.equal(await reap(), 1);
  assert.deepEqual(stale(), []);
  assert.equal(getChatStatus("42:")?.status, "idle");
});

test("NoSilentLoss: a tap on a Stop button of a release before 0.5.0 cancels nothing, deletes nothing and is left unclaimed", async () => {
  for (const patch of [
    {},
    { statusMessageId: 99, sessionId: "new-session", turnId: "new-turn" },
  ]) {
    calls.length = 0;
    oldStatus(patch);
    const before = getChatStatus("42:");

    assert.notEqual(await handleControl(stopButton()), true);

    assert.deepEqual(
      calls.filter((call) => ["cancel", "deleteMessage"].includes(call.method)),
      [],
    );
    assert.deepEqual(getChatStatus("42:"), before);
  }
});
