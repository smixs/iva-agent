/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "#lib/eve-compact.ts";

type FetchCall = { url: string; init: RequestInit };
const ask = (reply: () => Response, log: unknown[][] = []) =>
  requestSessionCompact({
    url: "http://local/eve/v1/session/s/compact",
    bearer: "token",
    fetchImpl: async () => reply(),
    logImpl: (...parts) => log.push(parts),
  });

test("the compact request goes to eve's session route with the shared bearer and an empty body", async () => {
  const calls: FetchCall[] = [];
  const accepted = await requestSessionCompact({
    url: localSessionCompactUrl("wrun_55", {}),
    bearer: "token-55",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(
        { ok: true, sessionId: "wrun_55", status: "accepted" },
        { status: 202 },
      );
    },
  });

  assert.equal(accepted, true);
  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:8723/eve/v1/session/wrun_55/compact",
  );
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer token-55",
  );
  assert.equal(calls[0]?.init.body, "{}");
});

test("202 is acceptance whatever the body says", async () => {
  for (const reply of [
    () => Response.json({ ok: true, status: "accepted" }, { status: 202 }),
    () => new Response(null, { status: 202 }),
    () => new Response("<html>", { status: 202 }),
  ])
    assert.equal(await ask(reply), true);
});

test("a retired session is a quiet refusal", async () => {
  const log: unknown[][] = [];
  assert.equal(
    await ask(
      () => Response.json({ ok: true, status: "no_active_session" }),
      log,
    ),
    false,
  );
  assert.deepEqual(log, []);
});

test("a rejected request (4xx) is a logged refusal", async () => {
  for (const status of [400, 401, 403, 404]) {
    const log: unknown[][] = [];
    assert.equal(await ask(() => new Response("no", { status }), log), false);
    assert.equal(log.length, 1);
    assert.match(
      String(log[0]?.[0]),
      new RegExp(`HTTP ${String(status)}`, "u"),
    );
  }
});

test("a dispatcher failure (5xx) and no answer at all throw: eve may still hold the request", async () => {
  for (const status of [500, 502, 503])
    await assert.rejects(
      ask(() => new Response("boom", { status })),
      new RegExp(`HTTP ${String(status)}`, "u"),
    );
  await assert.rejects(
    requestSessionCompact({
      url: "http://local/compact",
      bearer: "token",
      fetchImpl: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    }),
    /timeout/u,
  );
});

test("a route that never answers is abandoned at the timeout: the wait inside the parking handler is bounded", async () => {
  const started = Date.now();
  await assert.rejects(
    requestSessionCompact({
      url: "http://local/compact",
      bearer: "token",
      timeoutMs: 40,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason as Error),
          );
        }),
    }),
  );
  assert.ok(Date.now() - started < 2_000);
});

test("the session id is path-encoded and the host follows the channel rule", () => {
  assert.equal(
    localSessionCompactUrl("a/b c", {
      ASSISTANT_HOST: "https://poll.example.test:9443/",
    }),
    "https://poll.example.test:9443/eve/v1/session/a%2Fb%20c/compact",
  );
  assert.equal(
    localSessionCompactUrl("s", { IVA_PORT: "9001" }),
    "http://127.0.0.1:9001/eve/v1/session/s/compact",
  );
});
