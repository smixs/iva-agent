import { sendModelAuthAlert } from "./model-auth-alert.ts";
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns registrations. */
import "./fixtures/no-host-anthropic.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeModelAuth, tickModelAuth } from "#lib/model-auth-alert.ts";
import {
  modelAuthFailure,
  modelAuthText,
  MODEL_AUTH_REPEAT_MS,
} from "#lib/model-auth.ts";
import { authKey, pendingModelAuth } from "#lib/model-auth-state.ts";
import { readAlertState } from "./lib/notice-policy.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";

const START = Date.parse("2026-10-21T10:00:00Z");
function fixture(t: TestContext, hour = START) {
  const dir = mkdtempSync(join(tmpdir(), "iva-auth-alert-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = hour;
  t.mock.method(Date, "now", () => now);
  const sent: string[] = [];
  const env = { MODEL_PROVIDER: "claude", ASSISTANT_TIMEZONE: "UTC" };
  const send = (text: string) => {
    sent.push(text);
    return Promise.resolve(true);
  };
  const tick = (extra = {}) =>
    tickModelAuth({ dir, env, lang: "ru", send, ...extra });
  const fail = (provider = "claude", at = now) =>
    observeModelAuth(dir, { provider, at, failed: true, answers: true });
  const success = () =>
    observeModelAuth(dir, { provider: "claude", at: now, failed: false });
  const job = (
    name = "memory-night",
    tail = "ClaudeCliError: Failed to authenticate: OAuth session expired",
  ) => {
    const fact = {
      name,
      startedAt: now - 1000,
      finishedAt: now,
      ok: false,
      error: "exit 1",
      exitCode: 1,
      tail,
      acked: false,
      wake: null,
    };
    writeFileSync(join(dir, "jobs.json"), JSON.stringify([fact]));
  };
  return {
    dir,
    env,
    sent,
    tick,
    fail,
    success,
    job,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("failed Claude turns and memory-night share one daily Alert and retain factual effects", async (t) => {
  const f = fixture(t);
  f.job();
  f.fail();
  await f.tick();
  f.fail();
  await f.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /claude auth login/u);
  assert.match(f.sent[0], /ответы на сообщения, ночная память/u);
  assert.match(f.sent[0], /21 октября/u);
  assert.equal(readAlertState(f.dir)[authKey("claude")]?.lastSentAt, START);
  f.setNow(START + MODEL_AUTH_REPEAT_MS);
  await f.tick();
  await f.tick();
  assert.equal(f.sent.length, 2);
});

test("Codex refresh and OpenRouter 401 carry their repair commands", async (t) => {
  const f = fixture(t);
  for (const [message, provider, command] of [
    ["token refresh failed: 400 invalid_grant", "codex", "iva login"],
    ["HTTP 401", "openrouter", "замените ключ в /menu"],
  ]) {
    f.env.MODEL_PROVIDER = provider;
    f.fail(modelAuthFailure(message, provider)!);
    await f.tick();
    assert.ok(f.sent.at(-1)!.includes(command));
  }
  assert.equal(f.sent.length, 2);
});

test("non-auth schedule tails do not create Alerts", async (t) => {
  const f = fixture(t);
  for (const tail of [
    "HTTP 429",
    "HTTP 500",
    "HTTP 503",
    "ECONNRESET",
    "timeout",
  ]) {
    f.job("memory-night", tail);
    await f.tick();
  }
  assert.deepEqual(f.sent, []);
});

test("quiet hours defer persisted failure until the first 08:00 tick after restart", async (t) => {
  const two = Date.parse("2026-10-21T02:00:00Z");
  const f = fixture(t, two);
  f.fail();
  await f.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(pendingModelAuth(f.dir).length, 1);
  f.setNow(Date.parse("2026-10-21T08:00:00Z"));
  // A fresh tick uses only files. No in-memory observation survives this boundary.
  await tickModelAuth({
    dir: f.dir,
    env: f.env,
    lang: "ru",
    send: (text) => {
      f.sent.push(text);
      return Promise.resolve(true);
    },
  });
  assert.equal(f.sent.length, 1);
});

test("Telegram failure leaves throttle untouched and the next tick retries on the wire", async (t) => {
  const f = fixture(t);
  f.fail();
  const calls: Record<string, unknown>[] = [];
  let ok = false;
  const send = async (text: string) =>
    (
      await sendTelegramHtml("test-token", "owner", text, {
        fetchImpl: (_url, init) => {
          calls.push(
            JSON.parse(init?.body as string) as Record<string, unknown>,
          );
          return Promise.resolve(
            Response.json(
              ok
                ? { ok: true, result: { message_id: 1 } }
                : { ok: false, description: "unavailable" },
              { status: ok ? 200 : 503 },
            ),
          );
        },
      })
    ).ok;
  await f.tick({ send });
  assert.equal(readAlertState(f.dir)[authKey("claude")], undefined);
  ok = true;
  await f.tick({ send });
  assert.ok(readAlertState(f.dir)[authKey("claude")]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].chat_id, "owner");
  assert.match(String(calls[1].text), /claude auth login/u);
});

test("one recovery after Alert, old schedule failures cannot reopen it; night catches up", async (t) => {
  const f = fixture(t);
  f.job();
  await f.tick();
  f.setNow(START + 1000);
  f.success();
  await f.tick();
  f.success();
  await f.tick();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1], /^Вход в Claude восстановлен, я снова на связи\./u);
  assert.match(f.sent[1], /пропущенные дни при следующем запуске/u);
  assert.deepEqual(pendingModelAuth(f.dir), []);
  assert.equal(readAlertState(f.dir)[authKey("claude")], undefined);
});

test("successful call without a delivered Alert stays silent", async (t) => {
  const f = fixture(t);
  f.success();
  await f.tick();
  f.fail();
  f.setNow(START + 1000);
  f.success();
  await f.tick();
  assert.deepEqual(f.sent, []);
});

test("recovery delivery failure retries and remaining jobs get safe ack commands", async (t) => {
  const f = fixture(t);
  f.job("memory-digest");
  await f.tick();
  f.setNow(START + 1000);
  f.success();
  await f.tick({ send: () => Promise.resolve(false) });
  assert.ok(readAlertState(f.dir)[authKey("claude")]);
  await f.tick();
  assert.match(f.sent[1], /iva jobs ack memory-digest/u);
});

test("empty or damaged throttle is fail-open", async (t) => {
  const f = fixture(t);
  f.job();
  for (const raw of [
    "",
    "{",
    "[]",
    '{"model-auth:claude":{"lastSentAt":"wrong"}}',
  ]) {
    writeFileSync(join(f.dir, "alert-state.json"), raw);
    await f.tick();
  }
  assert.equal(f.sent.length, 4);
});

test("English Alert and recovery are entirely English and use the shared text", async (t) => {
  const f = fixture(t);
  f.fail();
  await f.tick({ lang: "en" });
  assert.equal(
    f.sent[0],
    modelAuthText("claude", "en", { since: START, answers: true }),
  );
  f.setNow(START + 1000);
  f.success();
  await f.tick({ lang: "en" });
  assert.doesNotMatch(f.sent.join("\n"), /[а-яё]/iu);
  assert.equal(f.sent[1], "Login to Claude is restored, I am available again.");
});

test("auth facts keep the existing alert-state shape for rollback", (t) => {
  const f = fixture(t);
  f.fail();
  const state = JSON.parse(
    readFileSync(join(f.dir, "alert-state.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  for (const value of Object.values(state))
    assert.deepEqual(Object.keys(value).sort(), ["essence", "lastSentAt"]);
});

test("broken jobs table cannot silence a pending turn authentication Alert", async (t) => {
  const f = fixture(t);
  f.fail();
  writeFileSync(join(f.dir, "jobs.json"), "{");
  await f.tick();
  assert.equal(f.sent.length, 1);
});

test("relapse after recovery speaks immediately within the previous daily period", async (t) => {
  const f = fixture(t);
  f.fail();
  await f.tick();
  f.setNow(START + 1000);
  f.success();
  await f.tick();
  f.setNow(START + 2000);
  f.fail();
  await f.tick();
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2], /Вход Ивы в Claude истёк/u);
});

test("a successful schedule restores login only with proof of an actual model call", async (t) => {
  const f = fixture(t);
  f.fail();
  await f.tick();
  const fact = {
    name: "memory-night",
    startedAt: START,
    finishedAt: START + 2000,
    ok: true,
    error: null,
    exitCode: 0,
    tail: "",
    acked: false,
    wake: null,
  };
  writeFileSync(join(f.dir, "jobs.json"), JSON.stringify([fact]));
  await f.tick();
  assert.equal(f.sent.length, 1);
  fact.tail = `iva-model-auth-success claude ${START + 1000}`;
  writeFileSync(join(f.dir, "jobs.json"), JSON.stringify([fact]));
  await f.tick();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1], /восстановлен/u);
});

test("stateless child transport leaves alert state to the agent", async () => {
  assert.equal(await sendModelAuthAlert("test", {}), false);
});

test("REPAIR1: unchanged schedule evidence does not rewrite inode or mtime", async (t) => {
  const { statSync } = await import("node:fs");
  const f = fixture(t);
  f.job();
  await f.tick();
  const path = join(f.dir, "alert-state.json");
  const before = statSync(path, { bigint: true });
  f.setNow(START + 60_000);
  await f.tick();
  const after = statSync(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});
test("REPAIR1: provider switch silently removes old outage and throttle", async (t) => {
  const f = fixture(t);
  f.job();
  f.fail();
  await f.tick();
  f.env.MODEL_PROVIDER = "codex";
  observeModelAuth(f.dir, {
    provider: "codex",
    at: START + 1000,
    failed: false,
  });
  await f.tick();
  f.setNow(START + MODEL_AUTH_REPEAT_MS);
  await f.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(readAlertState(f.dir)[authKey("claude")], undefined);
  assert.deepEqual(pendingModelAuth(f.dir), []);
});
test("REPAIR1: owner replies at 23:30 and 00:30 count toward the morning Alert", async (t) => {
  const { notifyTelegramFailure } =
    await import("#lib/telegram-failure-notice.ts");
  const { noticeSender } = await import("#lib/outbox.ts");
  const { createAuthDispatcher } = await import("#lib/model-auth-dispatch.ts");
  const { runAuthAlert } = await import("#lib/model-auth-alert.ts");
  const night = Date.parse("2026-10-21T23:30:00Z");
  const f = fixture(t, night);
  const modelBefore = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = "claude";
  t.after(() => {
    if (modelBefore === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = modelBefore;
  });
  const before = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "owner";
  t.after(() => {
    if (before === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = before;
  });
  const dispatch = createAuthDispatcher((obs) =>
    runAuthAlert(obs, {
      dir: f.dir,
      env: f.env,
      lang: "ru",
      send: (text) => {
        f.sent.push(`ALERT ${text}`);
        return Promise.resolve(true);
      },
    }),
  );
  const direct: string[] = [];
  for (const [i, at] of [night, night + 60 * 60 * 1000].entries()) {
    f.setNow(at);
    await notifyTelegramFailure(
      "repair-owner",
      `turn-${i}`,
      {
        message: "OAuth session expired",
        ...{ chatId: "owner", group: false },
      },
      noticeSender((text) => {
        direct.push(text);
        return Promise.resolve();
      }),
      { now: at, authDispatch: dispatch },
    );
    await dispatch();
    assert.equal(direct.length, i + 1);
    assert.match(direct[i], /claude auth login/u);
  }
  f.setNow(Date.parse("2026-10-22T08:00:00Z"));
  await dispatch();
  assert.deepEqual(f.sent, []);
});

test("REPAIR2: read-only data still delivers the originating-chat reply", async (t) => {
  const { chmodSync } = await import("node:fs");
  const { notifyTelegramFailure } =
    await import("#lib/telegram-failure-notice.ts");
  const { noticeSender } = await import("#lib/outbox.ts");
  const { createAuthDispatcher } = await import("#lib/model-auth-dispatch.ts");
  const { runAuthAlert } = await import("#lib/model-auth-alert.ts");
  const f = fixture(t);
  const direct: string[] = [];
  const dispatch = createAuthDispatcher((obs) =>
    runAuthAlert(obs, {
      dir: f.dir,
      env: f.env,
      send: () => Promise.resolve(true),
    }),
  );
  chmodSync(f.dir, 0o500);
  try {
    await notifyTelegramFailure(
      "read-only-auth",
      "turn",
      { message: "OAuth session expired" },
      noticeSender((text) => {
        direct.push(text);
        return Promise.resolve();
      }),
      { now: START, authDispatch: dispatch },
    );
    await dispatch();
    assert.equal(direct.length, 1);
    assert.match(direct[0], /\/menu|claude auth login|iva login/u);
    assert.deepEqual(readAlertState(f.dir), {});
  } finally {
    chmodSync(f.dir, 0o700);
  }
});
