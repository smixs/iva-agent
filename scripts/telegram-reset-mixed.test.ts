/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns registrations; doubles preserve asynchronous reset boundaries. */
import assert from "node:assert/strict";
import test from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";
import { resetTargetForControl } from "./lib/telegram-reset.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

process.env.ASSISTANT_DATA_DIR = tempDir("iva-reset-mixed-");
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
const queue = await import("./poller/main.ts");
const status = await import("#lib/run-status.ts");

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// R1-M: resolveSession A awaits; B resets a fixed session id; delivery creates a new
// session; A resolves that replacement. ExactCut must retain the delivered message.
for (const bridge of [false, true]) {
  test(`ResetIntent ExactCut: ${bridge ? "Bridge timeout and group reply" : "address before sessionId"} preserves the post-cut message`, async (t) => {
    const gate = deferred();
    const entered = deferred();
    t.after(() => gate.resolve());
    let current = { id: "old", messages: [100] };
    const sessions = new Map([[current.id, current]]);
    const fixed = (stored: typeof current): Session =>
      ({
        id: stored.id,
        reset: async () => {
          stored.messages.length = 0;
          return { status: "reset", previousSessionId: stored.id };
        },
      }) as Session;
    let first = true;
    const chatId = bridge ? "-42" : "85001";
    const chatKey = `${chatId}:`;
    const operations: Pick<
      RouteHandlerArgs,
      "attachSession" | "resolveSession"
    > = {
      attachSession: (id) => {
        const stored = sessions.get(id);
        assert.ok(stored);
        return fixed(stored);
      },
      resolveSession: async (address) => {
        assert.equal(address, bridge ? "-42::501" : "85001::");
        if (first) {
          first = false;
          entered.resolve();
          await gate.promise;
        }
        return fixed(current);
      },
    };
    const request = (target: unknown) =>
      handleTelegramResetRequest(
        new Request("http://local/reset", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "test-secret" },
          body: JSON.stringify(target),
        }),
        operations,
        "test-secret",
      );
    const message = {
      chat: { id: Number(chatId), type: bridge ? "group" : "private" },
    };
    const storedStatus = { sessionId: current.id };
    const firstTarget = bridge
      ? resetTargetForControl(
          {
            message: {
              ...message,
              message_id: 101,
              reply_to_message: {
                from: { is_bot: true, id: 7 },
                message_id: 501,
              },
            },
          },
          storedStatus,
          7,
        )
      : { address: { chatId } };
    assert.ok(firstTarget);
    let late: Promise<Response>;
    if (bridge) {
      status.setChatStatus(chatKey, {
        status: "running",
        sessionId: "old",
        turnId: "turn-old",
      });
      let pending: Promise<Response> | undefined;
      await assert.rejects(
        queue.performScopedReset(chatKey, firstTarget, {
          clearQueue: false,
          requestResetImpl: async ({ target }) => {
            pending = request(target);
            await entered.promise;
            throw new Error("HTTP timeout after route accepted");
          },
          logImpl: () => {},
        }),
        /HTTP timeout/,
      );
      assert.ok(pending);
      late = pending;
    } else {
      late = request(firstTarget);
      await entered.promise;
    }
    const nextTarget = resetTargetForControl(
      { message },
      bridge ? status.getChatStatus(chatKey) : storedStatus,
      7,
    );
    assert.ok(nextTarget);
    assert.equal(nextTarget.sessionId, "old");
    if (bridge) {
      await queue.performScopedReset(chatKey, nextTarget, {
        clearQueue: false,
        requestResetImpl: async ({ target }) =>
          (await (await request(target)).json()) as { status: "reset" },
        logImpl: () => {},
      });
    } else {
      assert.equal((await request(nextTarget)).status, 200);
    }
    const delivered = bridge ? 103 : 102;
    current = { id: "new", messages: [delivered] };
    sessions.set(current.id, current);
    gate.resolve();
    const result = await late;
    assert.deepEqual(
      current.messages,
      [delivered],
      "ExactCut preserves post-cut delivery",
    );
    assert.equal(
      ((await result.json()) as { status: string }).status,
      "no_active_session",
    );
    if (bridge) assert.deepEqual(await queue.loadPrivateResetIntents(), []);
  });
}

test("ResetIntent ExactCut: a sessionId reset of another chat leaves the waiting address reset effective", async (t) => {
  const gate = deferred();
  const entered = deferred();
  t.after(() => gate.resolve());
  const resetIds: string[] = [];
  const fixed = (id: string): Session =>
    ({
      id,
      reset: async () => {
        resetIds.push(id);
        return { status: "reset", previousSessionId: id };
      },
    }) as Session;
  const operations: Pick<RouteHandlerArgs, "attachSession" | "resolveSession"> =
    {
      attachSession: fixed,
      resolveSession: async () => {
        entered.resolve();
        await gate.promise;
        return fixed("waiting");
      },
    };
  const request = (target: unknown) =>
    handleTelegramResetRequest(
      new Request("http://local/reset", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: JSON.stringify(target),
      }),
      operations,
      "test-secret",
    );
  const waiting = request({ address: { chatId: "85002", messageThreadId: 1 } });
  await entered.promise;
  await request({ sessionId: "other", chatKey: "85002:2" });
  await request({ sessionId: "other", chatKey: "85003:1" });
  gate.resolve();
  assert.equal(
    ((await (await waiting).json()) as { status: string }).status,
    "reset",
  );
  assert.deepEqual(resetIds, ["other", "other", "waiting"]);
});
