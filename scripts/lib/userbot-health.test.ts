import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  probeUserbotHealth,
  awaitUserbotHealth,
  USERBOT_HEALTH_TIMEOUT_MS,
} from "./userbot-health.ts";

const activeSystemd = (args: string[]) => {
  if (args[0] === "is-active")
    return Promise.resolve({ code: 0, out: "active" });
  return Promise.resolve({ code: 0, out: "enabled" });
};

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: () => Promise.resolve(body),
});

void test("userbot health uses the required 1.5 second production budget", () => {
  assert.equal(USERBOT_HEALTH_TIMEOUT_MS, 1500);
});

void test("userbot health reports off and does not contact the proxy", async () => {
  let fetched = false;
  const health = await probeUserbotHealth({
    runSystemctl: (args) =>
      Promise.resolve(
        args[0] === "is-active"
          ? { code: 3, out: "inactive" }
          : { code: 1, out: "disabled" },
      ),
    readToken: () => Promise.resolve("unused"),
    fetchImpl: () => {
      fetched = true;
      return Promise.reject(new Error("must not fetch"));
    },
  });

  assert.equal(health.state, "off");
  assert.equal(fetched, false);
});

void test("userbot health reports starting for an enabled inactive service", async () => {
  let fetched = false;
  const health = await probeUserbotHealth({
    runSystemctl: (args) =>
      Promise.resolve(
        args[0] === "is-active"
          ? { code: 3, out: "activating" }
          : { code: 0, out: "enabled" },
      ),
    readToken: () => Promise.resolve("unused"),
    fetchImpl: () => {
      fetched = true;
      return Promise.reject(new Error("must not fetch"));
    },
  });

  assert.equal(health.state, "starting");
  assert.equal(fetched, false);
});

void test("userbot health reports unreachable when the proxy is down", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () =>
      Promise.reject(new Error("connect ECONNREFUSED secret-local-token")),
  });

  assert.deepEqual(health, {
    state: "unreachable",
    reason: "proxy_unreachable",
  });
  assert.doesNotMatch(JSON.stringify(health), /local-token|ECONNREFUSED/);
});

void test("userbot health reports unreachable on bearer mismatch and redacts the token", async () => {
  const token = "bearer-mismatch-secret";
  let authorization = "";
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve(token),
    fetchImpl: (_url, init) => {
      authorization = init.headers.authorization;
      return Promise.resolve(
        response(401, { error: "unauthorized", reflected: token }),
      );
    },
  });

  assert.equal(authorization, `Bearer ${token}`);
  assert.deepEqual(health, {
    state: "unreachable",
    reason: "proxy_auth_rejected",
  });
  assert.doesNotMatch(JSON.stringify(health), new RegExp(token));
});

void test("userbot health bounds a hanging proxy probe to its timeout", async () => {
  const started = Date.now();
  const health = await probeUserbotHealth({
    timeoutMs: 25,
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(String(signal.reason)),
            ),
          { once: true },
        );
      }),
  });

  assert.deepEqual(health, { state: "unreachable", reason: "probe_timeout" });
  assert.ok(
    Date.now() - started < 250,
    "probe exceeded the bounded test budget",
  );
});

void test("userbot health distinguishes an unauthorized Telethon session", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () => Promise.resolve(response(200, { state: "unauthorized" })),
  });

  assert.deepEqual(health, {
    state: "unauthorized",
    reason: "telegram_login_required",
  });
});

void test("userbot health reports ready from the existing proxy session", async () => {
  const health = await probeUserbotHealth({
    runSystemctl: activeSystemd,
    readToken: () => Promise.resolve("local-token"),
    fetchImpl: () => Promise.resolve(response(200, { state: "ready" })),
  });

  assert.deepEqual(health, { state: "ready", reason: "ok" });
});

void test("userbot health reads the token from the canonical data directory", async () => {
  let readFrom = "";
  const health = await probeUserbotHealth({
    dataDir: "/synthetic/iva/runtime",
    runSystemctl: activeSystemd,
    readToken: (dataDir) => {
      readFrom = dataDir;
      return Promise.resolve("local-token");
    },
    fetchImpl: () => Promise.resolve(response(200, { state: "ready" })),
  });

  assert.equal(readFrom, "/synthetic/iva/runtime");
  assert.deepEqual(health, { state: "ready", reason: "ok" });
});

void test("readiness waits through a cold proxy and preserves unauthorized QR-login state", async () => {
  let calls = 0;
  const result = await awaitUserbotHealth(
    () =>
      Promise.resolve(
        ++calls === 1
          ? { state: "unreachable", reason: "proxy_unreachable" }
          : { state: "unauthorized", reason: "telegram_login_required" },
      ),
    500,
  );
  assert.equal(result.state, "unauthorized");
  assert.equal(calls, 2);
});

void test("readiness retries an authenticated HTTP 503 before the cold proxy accepts QR login", async (t) => {
  let calls = 0;
  const server = createServer((request, reply) => {
    assert.equal(request.headers.authorization, "Bearer readiness-token");
    reply.writeHead(++calls === 1 ? 503 : 200, {
      "content-type": "application/json",
    });
    reply.end('{"state":"unauthorized"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const health = await awaitUserbotHealth(
    (signal) =>
      probeUserbotHealth({
        port: address.port,
        signal,
        runSystemctl: activeSystemd,
        readToken: () => Promise.resolve("readiness-token"),
      }),
    1000,
  );
  assert.deepEqual(health, {
    state: "unauthorized",
    reason: "telegram_login_required",
  });
  assert.equal(calls, 2);
});

void test("readiness aborts a hung probe and does not probe again after returning", async () => {
  let calls = 0,
    aborted = false;
  const result = await awaitUserbotHealth((signal) => {
    calls++;
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("cancelled"));
        },
        { once: true },
      ),
    );
  }, 20);
  assert.match(result.reason, /^readiness_timeout:/);
  assert.equal(aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

void test("readiness reports a thrown probe and clears its retry pause on expiry", async () => {
  let calls = 0;
  const result = await awaitUserbotHealth(() => {
    calls++;
    return Promise.reject(new Error("network failed"));
  }, 20);
  assert.deepEqual(result, {
    state: "unreachable",
    reason: "readiness_timeout:proxy_unreachable",
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(calls, 1);
});
