/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  requestTelegramReset,
  resetTargetForControl,
  telegramAddressFromChatKey,
} from "./telegram-reset.ts";
import {
  handleTelegramResetRequest,
  parseTelegramResetTarget,
} from "#lib/telegram-reset-route.ts";

type FetchCall = { url: string; init: RequestInit };
type ResetOperations = Pick<
  RouteHandlerArgs,
  "attachSession" | "resolveSession"
>;

function session(id: string, reasons: unknown[]): Session {
  return {
    id,
    reset: async (options?: { reason?: string }) => {
      reasons.push(options?.reason);
      return { status: "reset" as const, previousSessionId: id };
    },
  } as Session;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("stored session wins for groups and forum topics", () => {
  const update = {
    message: {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 77,
      message_id: 91,
    },
  };
  assert.deepEqual(
    resetTargetForControl(update, { sessionId: "session-42" }, "777"),
    {
      sessionId: "session-42",
      chatKey: "-1001:77",
    },
  );
});

test("private-chat upgrade fallback builds a channel address", () => {
  const update = {
    message: { chat: { id: 123, type: "private" }, message_id: 10 },
  };
  assert.deepEqual(resetTargetForControl(update, null), {
    address: { chatId: "123" },
  });
});

test("group fallback requires an explicit reply to Iva", () => {
  const base = {
    chat: { id: -1001, type: "supergroup" },
    message_thread_id: 7,
    message_id: 10,
  };
  assert.equal(resetTargetForControl({ message: base }, null, "777"), null);
  assert.deepEqual(
    resetTargetForControl(
      {
        message: {
          ...base,
          reply_to_message: {
            message_id: 55,
            from: { id: 777, is_bot: true },
          },
        },
      },
      null,
      "777",
    ),
    {
      address: { chatId: "-1001", messageThreadId: 7, conversationId: "55" },
    },
  );
});

test("explicit Iva reply wins, but another bot cannot select stored state", () => {
  const message = {
    chat: { id: -1001, type: "supergroup" },
    message_thread_id: 7,
    message_id: 91,
    reply_to_message: {
      message_id: 55,
      from: { id: 777, is_bot: true },
    },
  };
  assert.deepEqual(
    resetTargetForControl({ message }, { sessionId: "session-old" }, "777"),
    {
      address: { chatId: "-1001", messageThreadId: 7, conversationId: "55" },
    },
  );
  assert.equal(
    resetTargetForControl(
      {
        message: {
          ...message,
          reply_to_message: {
            message_id: 55,
            from: { id: 888, is_bot: true },
          },
        },
      },
      { sessionId: "session-old" },
      "777",
    ),
    null,
  );
});

test("chat-key address resolver roundtrips private and topic keys", () => {
  fc.assert(
    fc.property(
      fc
        .integer({ min: -9_007_199_254_740_991, max: 9_007_199_254_740_991 })
        .filter((id) => id !== 0),
      fc.option(fc.integer({ min: 1, max: 2_147_483_647 }), { nil: undefined }),
      (chatId, threadId) => {
        const key = `${chatId}:${threadId ?? ""}`;
        assert.deepEqual(telegramAddressFromChatKey(key), {
          chatId: String(chatId),
          ...(threadId === undefined ? {} : { messageThreadId: threadId }),
        });
      },
    ),
    { seed: 47_003, numRuns: 1_000 },
  );
});

test("chat-key address resolver rejects junk without throwing", () => {
  for (const key of ["", ":", "abc:", "1:0", "1:-1", "1:1.5", "1:2:3"]) {
    assert.equal(telegramAddressFromChatKey(key), null, key);
  }
});

test("reset client sends the exact target and accepts duplicate reset", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramReset({
    url: "http://127.0.0.1/eve/v1/telegram/reset",
    secret: "secret",
    target: { sessionId: "session-55", chatKey: "123:7" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "no_active_session" });
    },
  });
  assert.equal(result.status, "no_active_session");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)[
      "X-Telegram-Bot-Api-Secret-Token"
    ],
    "secret",
  );
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), {
    sessionId: "session-55",
    chatKey: "123:7",
  });
});

test("reset client rejects HTTP and malformed success responses", async () => {
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      target: { address: { chatId: "1" } },
      fetchImpl: async () => new Response("failed", { status: 500 }),
    }),
    /HTTP 500/u,
  );
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      target: { address: { chatId: "1" } },
      fetchImpl: async () => Response.json({ ok: true, status: "surprise" }),
    }),
    /invalid response/u,
  );
});

test("reset route attaches an exact session", async () => {
  const attached: string[] = [];
  const reasons: unknown[] = [];
  const operations: ResetOperations = {
    attachSession: (sessionId) => {
      attached.push(sessionId);
      return session(sessionId, reasons);
    },
    resolveSession: async () => undefined,
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/eve/v1/telegram/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ sessionId: "session-55" }),
    }),
    operations,
    "secret",
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    status: "reset",
    previousSessionId: "session-55",
  });
  assert.deepEqual(attached, ["session-55"]);
  assert.deepEqual(reasons, ["Telegram recovery command"]);
});

test("reset route resolves the exact Telegram address", async () => {
  const resolved: string[] = [];
  const reasons: unknown[] = [];
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async (address) => {
      resolved.push(address);
      return session("session-55", reasons);
    },
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/eve/v1/telegram/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({
        address: { chatId: -1001, messageThreadId: 7, conversationId: 55 },
      }),
    }),
    operations,
    "secret",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(resolved, ["-1001:7:55"]);
  assert.deepEqual(reasons, ["Telegram recovery command"]);
});

test("reset route returns no_active_session for an unowned address", async () => {
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async () => undefined,
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ address: { chatId: "1" } }),
    }),
    operations,
    "secret",
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "no_active_session",
  });
});

test("ResetIntent ExactCut: finishing an older reset cannot forget a newer completed reset", async (t) => {
  const firstReset = deferred();
  const firstEntered = deferred();
  const lateResolve = deferred();
  const lateEntered = deferred();
  t.after(() => {
    firstReset.resolve();
    lateResolve.resolve();
  });
  let current = { id: "old", messages: [100] };
  let resolves = 0;
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async () => {
      const index = ++resolves;
      if (index === 2) {
        lateEntered.resolve();
        await lateResolve.promise;
      }
      // A Session handle owns a fixed id even if its reset completes later.
      const stored = current;
      return {
        id: stored.id,
        reset: async () => {
          if (index === 1) {
            firstEntered.resolve();
            await firstReset.promise;
          }
          stored.messages.length = 0;
          return { status: "reset", previousSessionId: stored.id };
        },
      } as Session;
    },
  };
  const request = () =>
    handleTelegramResetRequest(
      new Request("http://local/reset", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify({ address: { chatId: "7001" } }),
      }),
      operations,
      "secret",
    );

  const first = request();
  await firstEntered.promise;
  const late = request();
  await lateEntered.promise;
  await request();
  current = { id: "new", messages: [102] };
  firstReset.resolve();
  await first;
  assert.deepEqual(current.messages, [102]);
  lateResolve.resolve();
  const response = await late;
  assert.deepEqual(
    current.messages,
    [102],
    "ExactCut keeps the delivered message",
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "no_active_session",
  });
});

test("reset route keeps pending requests to different addresses independent", async (t) => {
  const gate = deferred();
  const entered = deferred();
  t.after(() => gate.resolve());
  const reasons: unknown[] = [];
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async (address) => {
      if (address === "7002::") {
        entered.resolve();
        await gate.promise;
      }
      return session(address, reasons);
    },
  };
  const request = (chatId: string) =>
    handleTelegramResetRequest(
      new Request("http://local/reset", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify({ address: { chatId } }),
      }),
      operations,
      "secret",
    );
  const waiting = request("7002");
  await entered.promise;
  await request("7003");
  gate.resolve();
  assert.equal(
    ((await (await waiting).json()) as { status: string }).status,
    "reset",
  );
  assert.equal(reasons.length, 2);
});

test("ResetIntent ExactCut: a late reset by sessionId keeps the session created after address recovery", async (t) => {
  const gate = deferred();
  const entered = deferred();
  t.after(() => gate.resolve());
  const old = { id: "fixed-old", messages: [100] };
  const current = { id: "fixed-new", messages: [102] };
  const operations: ResetOperations = {
    attachSession: (id) => {
      assert.equal(id, old.id);
      return {
        id,
        reset: async () => {
          entered.resolve();
          await gate.promise;
          old.messages.length = 0;
          return { status: "reset", previousSessionId: id };
        },
      } as Session;
    },
    resolveSession: async () => session(old.id, []),
  };
  const request = (target: unknown) =>
    handleTelegramResetRequest(
      new Request("http://local/reset", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
        body: JSON.stringify(target),
      }),
      operations,
      "secret",
    );
  const waiting = request({ sessionId: old.id });
  await entered.promise;
  await request({ address: { chatId: "7004" } });
  gate.resolve();
  await waiting;
  assert.deepEqual(old.messages, []);
  assert.deepEqual(current.messages, [102]);
});

test("reset route rejects auth, malformed targets and conflicting targets", async () => {
  let called = false;
  const operations: ResetOperations = {
    attachSession: () => {
      called = true;
      return session("unexpected", []);
    },
    resolveSession: async () => {
      called = true;
      return undefined;
    },
  };
  const request = (body: string, secret = "secret") =>
    new Request("http://local/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body,
    });
  const cases = [
    request('{"sessionId":"s"}', "bad"),
    request("{ not json"),
    request("{}"),
    request('{"sessionId":"s","chatKey":null}'),
    request('{"sessionId":"s","chatKey":"1:0"}'),
    request('{"sessionId":"s","chatKey":"1:9007199254740992"}'),
    request('{"sessionId":"s","chatKey":"1::2"}'),
    request('{"address":{"chatId":"1"},"chatKey":"1:"}'),
    request('{"sessionId":""}'),
    request('{"address":{"chatId":"junk"}}'),
    request('{"sessionId":"s","address":{"chatId":"1"}}'),
    request('{"sessionId":"","address":{"chatId":"1"}}'),
  ];

  for (const [index, req] of cases.entries()) {
    const response = await handleTelegramResetRequest(
      req,
      operations,
      "secret",
    );
    assert.equal(response.status, index === 0 ? 401 : 400);
  }
  assert.equal(called, false);
});

test("reset route parses valid chat keys and rejects malformed metadata (seed 47004)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.option(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), {
        nil: undefined,
      }),
      (id, thread) => {
        const target = { sessionId: "fixed", chatKey: `${id}:${thread ?? ""}` };
        assert.deepEqual(parseTelegramResetTarget(target), target);
      },
    ),
    { seed: 47004, numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc
        .anything()
        .filter(
          (key) =>
            typeof key !== "string" || !/^-?\d+:(?:[1-9]\d*)?$/u.test(key),
        ),
      (chatKey) => {
        assert.equal(
          parseTelegramResetTarget({ sessionId: "fixed", chatKey }),
          null,
        );
      },
    ),
    { seed: 47005, numRuns: 500 },
  );
});
