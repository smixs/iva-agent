/* eslint-disable @typescript-eslint/require-await -- async test doubles retain the transport contract. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StopCancelRequest } from "./telegram-stop.ts";
const root = mkdtempSync(join(tmpdir(), "iva-stop-"));
process.env.ASSISTANT_DATA_DIR = root;
test.after(() => rmSync(root, { recursive: true, force: true }));
const {
  handleTelegramDraftStop,
  requestTurnCancel,
  handleTelegramDraftStopRequest,
} = await import("./telegram-stop.ts");

const native = { chat: { id: 7, type: "private" }, draft_id: 41 };
function options(snapshot: Record<string, unknown> | null) {
  const calls: StopCancelRequest[] = [];
  return {
    calls,
    deps: {
      allowedImpl: () => new Set(["7"]),
      urlImpl: () => "http://localhost/cancel",
      secret: "secret",
      getStatusImpl: () => snapshot,
      cancelImpl: async (req: StopCancelRequest) => {
        calls.push(req);
        return { status: "accepted" };
      },
      logImpl: () => {},
    },
  };
}
void test("native stop cancels the snapshot pair even if the next turn replaces it during the request", async () => {
  const f = options({
    status: "running",
    sessionId: "s",
    turnId: "old",
    draftId: 41,
  });
  let reads = 0;
  assert.equal(
    await handleTelegramDraftStop(native, {
      ...f.deps,
      getStatusImpl: () => {
        reads++;
        return reads === 1
          ? { sessionId: "s", turnId: "old", draftId: 41 }
          : { sessionId: "s", turnId: "new", draftId: 42 };
      },
    }),
    "requested",
  );
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, [
    {
      url: "http://localhost/cancel",
      secret: "secret",
      sessionId: "s",
      turnId: "old",
    },
  ]);
});
void test("repeated stop after cancellation or a newer draft is harmless; an already cancelled exact turn is idle", async () => {
  let st: Record<string, unknown> = {
    sessionId: "s",
    turnId: "old",
    draftId: 41,
  };
  let actualCancels = 0;
  let cancelled = false;
  const f = options(st);
  const deps = {
    ...f.deps,
    getStatusImpl: () => st,
    cancelImpl: async () => {
      if (cancelled) return { status: "no_active_turn" };
      cancelled = true;
      actualCancels++;
      return { status: "accepted" };
    },
  };
  assert.equal(await handleTelegramDraftStop(native, deps), "requested");
  assert.equal(await handleTelegramDraftStop(native, deps), "idle");
  assert.equal(actualCancels, 1);
  st = { sessionId: "s", turnId: "new", draftId: 42 };
  assert.equal(await handleTelegramDraftStop(native, deps), "ignored");
  st = { sessionId: "s", turnId: null, draftId: 41, compacting: true };
  assert.equal(await handleTelegramDraftStop(native, deps), "ignored");
  st = { status: "idle" };
  assert.equal(await handleTelegramDraftStop(native, deps), "ignored");
  assert.equal(actualCancels, 1);
});
void test("strangers and non-private chats produce a journal entry and zero cancellation", async () => {
  const f = options({ sessionId: "s", turnId: "t", draftId: 41 });
  const logs: unknown[][] = [];
  for (const event of [
    { ...native, chat: { id: 99, type: "private" } },
    { ...native, chat: { id: 7, type: "group" } },
  ])
    assert.equal(
      await handleTelegramDraftStop(event, {
        ...f.deps,
        logImpl: (...args) => {
          logs.push(args);
        },
      }),
      "ignored",
    );
  assert.equal(f.calls.length, 0);
  assert.equal(logs.length, 2);
});
void test("secret absence and network failure remain explicit stop outcomes", async () => {
  const f = options({ sessionId: "s", turnId: "t", draftId: 41 });
  assert.equal(
    await handleTelegramDraftStop(native, { ...f.deps, secret: "" }),
    "failed",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    await handleTelegramDraftStop(native, {
      ...f.deps,
      cancelImpl: async () => {
        throw new Error("network");
      },
    }),
    "unresponsive",
  );
});
void test("/stop still cancels a stale record and handles pre-turn or no_active_turn", async () => {
  const f = options({
    status: "idle",
    updatedAt: 0,
    sessionId: "s",
    turnId: "old",
  });
  assert.equal(
    await requestTurnCancel("7:", {
      ...f.deps,
      url: "http://localhost/cancel",
    }),
    "requested",
  );
  assert.equal(f.calls[0].turnId, "old");
  assert.equal(
    await requestTurnCancel("7:", {
      ...f.deps,
      url: "http://localhost/cancel",
      getStatusImpl: () => ({ status: "running" }),
    }),
    "idle",
  );
  assert.equal(
    await requestTurnCancel("7:", {
      ...f.deps,
      url: "http://localhost/cancel",
      cancelImpl: async () => ({ status: "no_active_turn" }),
    }),
    "idle",
  );
});
void test("webhook authentication rejects before stop or original dispatch; clone preserves the ordinary update body", async () => {
  let originalCalls = 0;
  const original = async (req: Request) => {
    originalCalls++;
    assert.deepEqual(await req.json(), {
      update_id: 1,
      message: { text: "hi" },
    });
    return new Response("original");
  };
  const request = (secret: string) =>
    new Request("http://localhost/eve/v1/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    });
  assert.equal(
    (await handleTelegramDraftStopRequest(request("wrong"), original, "secret"))
      .status,
    401,
  );
  assert.equal(originalCalls, 0);
  assert.equal(
    await (
      await handleTelegramDraftStopRequest(
        request("secret"),
        original,
        "secret",
      )
    ).text(),
    "original",
  );
  assert.equal(originalCalls, 1);
});
void test("PBT draft identity, compaction and foreign stops never cancel another pair (seed 101415)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          draft: fc.integer({ min: 1, max: 4 }),
          turn: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
          stop: fc.integer({ min: 1, max: 4 }),
          allowed: fc.boolean(),
          private: fc.boolean(),
        }),
        { maxLength: 50 },
      ),
      async (events) => {
        for (const e of events) {
          const f = options({
            sessionId: "s",
            turnId: e.turn === null ? null : `t${e.turn}`,
            draftId: e.draft,
          });
          await handleTelegramDraftStop(
            {
              chat: {
                id: e.allowed ? 7 : 99,
                type: e.private ? "private" : "group",
              },
              draft_id: e.stop,
            },
            f.deps,
          );
          assert.equal(
            f.calls.length,
            e.allowed && e.private && e.turn !== null && e.stop === e.draft
              ? 1
              : 0,
          );
          if (f.calls.length) assert.equal(f.calls[0].turnId, `t${e.turn}`);
        }
      },
    ),
    { seed: 101415, numRuns: 100 },
  );
});

void test("malformed native stop cannot use an absent draft id to cancel a running turn", async () => {
  const f = options({ sessionId: "s", turnId: "t" });
  for (const draft_id of [0, -1, NaN, 1.5, undefined])
    assert.equal(
      await handleTelegramDraftStop(
        { chat: native.chat, draft_id: draft_id as number },
        f.deps,
      ),
      "ignored",
    );
  assert.equal(f.calls.length, 0);
});

void test("no_active_turn clears the Stop fact only for the requested session and turn", async () => {
  const { getChatStatus, setChatStatus } = await import("./run-status.ts");
  for (const replacement of [
    null,
    { sessionId: "s", turnId: "next" },
    { sessionId: "new", turnId: "t" },
  ]) {
    setChatStatus("7:", {
      status: "running",
      sessionId: "s",
      turnId: "t",
      wasCancelled: null,
    });
    assert.equal(
      await requestTurnCancel("7:", {
        url: "http://localhost/cancel",
        secret: "secret",
        cancelImpl: async () => {
          assert.equal(getChatStatus("7:")?.wasCancelled, true);
          if (replacement)
            setChatStatus("7:", { ...replacement, wasCancelled: true });
          return { status: "no_active_turn" };
        },
      }),
      "idle",
    );
    assert.equal(
      getChatStatus("7:")?.wasCancelled,
      replacement ? true : undefined,
    );
  }
});
