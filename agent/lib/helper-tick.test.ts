/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHelperTick } from "./helper-tick.ts";
import { OWNER_STARTED_AT } from "./schedule-runner.ts";
import * as s from "./helper-store.ts";
const chat = { id: "42", threadId: null };

for (const cause of [
  "localized upstream failure",
  "The model did not return a response",
])
  test(`empty-response turn.failed becomes an ordinary failed helper: ${cause}`, async (t) => {
    const f = await setup(t),
      a = await f.running();
    f.state.events = [
      {
        type: "turn.failed",
        data: {
          sequence: 1,
          message: cause,
          details: { semanticErrorId: "empty-model-response" },
        },
      },
    ];
    await f.tick();
    await f.flush();
    const row = await s.getHelper(a.id);
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.reason, "модель не дала ответа");
    assert.equal(row?.deliveredAt, null);
    const { readHelperOutcome, helperOutcomesMarkdown, discardHelperOutcomes } =
      await import("./helper-outcome.ts");
    const key = { sessionId: "owner", turnId: "turn" };
    const body = JSON.parse(await readHelperOutcome(a.id, chat, key)) as {
      outcome: unknown;
      reason: unknown;
    };
    assert.equal(body.outcome, "failed");
    assert.equal(body.reason, "модель не дала ответа");
    assert.match(
      await helperOutcomesMarkdown(chat),
      /прочитай helper outcome и расскажи/,
    );
    const skill = await readFile(
      new URL("../skills/helper/SKILL.md", import.meta.url),
      "utf8",
    );
    assert.match(
      skill,
      /For failed, interrupted, deadline or ceiling outcomes, say what was completed and ask whether to repeat\./,
    );
    discardHelperOutcomes(key.sessionId);
  });
type Event = { type: string; data?: unknown };
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-v7-")),
    prev = { ...process.env };
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_HOST: "http://fixture.invalid",
    ASSISTANT_BEARER: "fixture",
    ASSISTANT_TIMEZONE: "UTC",
  });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const k of [
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_HOST",
      "ASSISTANT_BEARER",
      "ASSISTANT_TIMEZONE",
    ])
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    await rm(dir, { recursive: true, force: true });
  });
  const state = {
    events: [] as Event[],
    snapshot: "ok",
    cancel: "accepted",
    create: "ok",
    uniqueSessions: false,
    onCreate: async () => {},
    calls: [] as string[],
    signals: [] as AbortSignal[],
    requests: [] as RequestInit[],
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const u = new URL(String(url)),
      path = u.pathname.split("/").at(-1)!;
    state.calls.push(path);
    state.requests.push(init);
    if (init.signal) state.signals.push(init.signal);
    if (path === "session") {
      if (state.create === "network") throw Error("network lost after send");
      if (state.create.startsWith("empty-")) {
        const status = Number(state.create.slice(6));
        state.create = "ok";
        return new Response(null, { status });
      }
      if (state.create === "server-error")
        return Response.json({ error: "Unavailable" }, { status: 503 });
      if (state.create === "error")
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      await state.onCreate();
      return Response.json({
        sessionId: state.uniqueSessions
          ? new Headers(init.headers).get("x-iva-helper")
          : "server",
      });
    }
    if (path === "stream") {
      assert.equal(u.searchParams.get("includeTailIndex"), "1");
      assert.equal(u.searchParams.get("startIndex"), null);
      if (state.snapshot === "error")
        return Response.json({ error: "not found" }, { status: 404 });
      if (state.snapshot === "hang")
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "TimeoutError")),
            { once: true },
          ),
        );
      return new Response(
        state.snapshot === "garbage"
          ? "broken\n"
          : state.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        {
          headers: {
            "x-eve-stream-version": "25",
            "x-eve-stream-tail-index": String(
              state.snapshot === "garbage" ? 0 : state.events.length - 1,
            ),
          },
        },
      );
    }
    if (path === "cancel") {
      if (state.cancel === "error") throw Error("cancel failed");
      return Response.json({
        ok: true,
        status: state.cancel,
        ...(state.cancel === "accepted" ? { sessionId: "server" } : {}),
      });
    }
    assert.equal(path, "reset");
    throw Error("reset cleanup failed");
  });
  const add = async () => {
    const a = await s.addHelper({ task: "task", may: "draft", chat }, 1000);
    assert.ok(a.ok);
    return a.row;
  };
  const running = async (old = false, known = true) => {
    const a = await add();
    await s.claimHelper(
      a.id,
      { ownerStartedAt: OWNER_STARTED_AT - Number(old) },
      2000,
    );
    if (known) await s.recordHelperSession(a.id, 2000, "server");
    return a;
  };
  // The old implementation must not spawn a real helper while the new contracts are red.
  const tick = (nowMs = 3000) =>
    runHelperTick({
      nowMs,
      log: () => {},
      ...{ start: () => new Promise<never>(() => {}) },
    });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { dir, state, add, running, tick, flush };
}
for (const quarantined of [false, true])
  test(`v7 restart: ${quarantined ? "quarantine" : "live inbox"}, delivered cancel frees slot even when reset fails`, async (t) => {
    const f = await setup(t),
      a = await f.running(true);
    if (quarantined) {
      f.state.snapshot = "error";
      f.state.cancel = "no_active_turn";
    }
    await f.tick();
    await f.flush();
    assert.equal((await s.getHelper(a.id))?.outcome, "interrupted");
    assert.ok(f.state.calls.includes("stream"));
    assert.ok(f.state.calls.includes("cancel"));
  });
test("v7 restart: undelivered cancel holds slot; hard ceiling ends it despite all errors", async (t) => {
  const f = await setup(t),
    a = await f.running(true);
  f.state.cancel = "error";
  await f.tick();
  assert.ok((await s.getHelper(a.id))?.run);
  await f.tick(2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
  assert.equal((await s.getHelper(a.id))?.outcome, "deadline");
});
test("v7 accepted forever without terminal events holds run until the hard ceiling", async (t) => {
  const f = await setup(t),
    a = await f.running();
  await s.closeHelper(a.id, chat, 2100);
  await f.tick();
  await f.tick(2000 + s.HELPER_DEADLINE_MS);
  assert.ok((await s.getHelper(a.id))?.run);
  assert.equal(f.state.calls.filter((x) => x === "cancel").length, 2);
  await f.tick(2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
  assert.equal((await s.getHelper(a.id))?.outcome, "stopped");
});
test("v7 close: cancel leaves durable snapshot unchanged; terminal event preserves last completed partial", async (t) => {
  const f = await setup(t),
    a = await f.running();
  await s.closeHelper(a.id, chat, 2100);
  f.state.events = [
    { type: "message.completed", data: { message: "saved" } },
    {
      type: "step.completed",
      data: {
        usage: { inputTokens: 10, outputTokens: 2 },
        providerModelId: "helper-model",
      },
    },
  ];
  await f.tick();
  assert.ok((await s.getHelper(a.id))?.run);
  f.state.events.push(
    { type: "message.completed", data: { message: null } },
    { type: "turn.cancelled", data: { sequence: 1, turnId: "turn" } },
  );
  await f.tick();
  const row = await s.getHelper(a.id);
  assert.equal(row?.outcome, "stopped");
  assert.equal(row?.summary, "saved");
  assert.equal(row?.steps, 1);
  assert.equal(row?.tokens, 12);
  assert.equal(await readFile(s.helperResultPath(a.id), "utf8"), "saved");
});
for (const failure of ["error", "garbage", "bad-usage"])
  test(`v7 ${failure} snapshot with current owner holds unchanged row until ceiling`, async (t) => {
    const f = await setup(t),
      a = await f.running(),
      before = await s.getHelper(a.id);
    f.state.snapshot = failure;
    if (failure === "bad-usage")
      f.state.events = [
        { type: "step.completed", data: { usage: { inputTokens: "broken" } } },
      ];
    await f.tick(2000 + s.HELPER_DEADLINE_MS);
    assert.deepEqual(await s.getHelper(a.id), before);
    await f.tick(2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
    assert.equal((await s.getHelper(a.id))?.outcome, "deadline");
  });
for (const mode of ["false", "throw"])
  test(`v7 T3 ${mode}: cleanup known id, failed by claim CAS`, async (t) => {
    const f = await setup(t),
      a = await f.add();
    if (mode === "false")
      f.state.onCreate = async () => {
        await s.recordHelperSession(a.id, 3000, "other");
      };
    else {
      const rename = fs.rename.bind(fs);
      let fail = false;
      f.state.onCreate = () => {
        fail = true;
        return Promise.resolve();
      };
      t.mock.method(fs, "rename", (from: string, to: string) => {
        if (fail && to.endsWith("helpers.json")) {
          fail = false;
          return Promise.reject(Error("T3 disk failed"));
        }
        return rename(from, to);
      });
      syncBuiltinESMExports();
    }
    await f.tick();
    await f.flush();
    const row = await s.getHelper(a.id);
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.reason, "ход не записан");
    assert.ok(f.state.calls.includes("cancel"));
    assert.ok(f.state.calls.includes("reset"));
  });
test("v7 every core call has 15s bound: stalled snapshot returns; ceiling still wins", async (t) => {
  const f = await setup(t),
    a = await f.running();
  f.state.snapshot = "hang";
  const timeout = AbortSignal.timeout.bind(AbortSignal),
    bounds: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    bounds.push(ms);
    return timeout(10);
  });
  // Native timeout signals are unref'ed; keep this isolated test alive until the request rejects.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  await f.tick(2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
  await f.flush();
  assert.equal((await s.getHelper(a.id))?.outcome, "deadline");
  assert.ok(bounds.length >= 3);
  assert.ok(bounds.every((ms) => ms === 15000));
});
for (const failure of ["error", "network"])
  test(`v7 create ${failure}: final HTTP error fails; uncertain id holds until ceiling`, async (t) => {
    const f = await setup(t),
      a = await f.add();
    f.state.create = failure;
    await f.tick();
    assert.equal(f.state.calls[0], "session");
    if (failure === "error")
      assert.equal((await s.getHelper(a.id))?.outcome, "failed");
    else {
      assert.ok((await s.getHelper(a.id))?.run);
      await f.tick(3000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS);
      assert.equal((await s.getHelper(a.id))?.outcome, "deadline");
    }
  });
test("v7 create is not a stream subscription; core headers and 15s signal are preserved", async (t) => {
  const f = await setup(t),
    a = await f.add();
  await f.tick();
  assert.equal((await s.getHelper(a.id))?.run?.sessionId, "server");
  assert.deepEqual(f.state.calls, ["session"]);
  const headers = new Headers(f.state.requests[0].headers);
  assert.equal(headers.get("x-iva-turn"), "helper");
  assert.equal(headers.get("x-iva-helper"), a.id);
  assert.equal(f.state.signals.length, 1);
});
test("overlapping ticks start three distinct helpers once and retain their sessions", async (t) => {
  const f = await setup(t);
  const rows = await Promise.all([f.add(), f.add(), f.add()]);
  f.state.uniqueSessions = true;
  await Promise.all([f.tick(), f.tick(), f.tick()]);
  const creates = f.state.requests.filter(
    (_, i) => f.state.calls[i] === "session",
  );
  assert.equal(creates.length, 3);
  assert.deepEqual(
    creates.map((r) => new Headers(r.headers).get("x-iva-helper")).sort(),
    rows.map((r) => r.id).sort(),
  );
  const stored = await s.readHelpers();
  assert.equal(stored.rows.filter((r) => r.run?.sessionId === r.id).length, 3);
  assert.equal(
    (await s.addHelper({ task: "fourth", may: "", chat }, 4000)).ok,
    false,
  );
});
for (const hasGoal of [false, true])
  test(`v7 overlapping ticks${hasGoal ? " with goal" : ""}: one claim, one result writer and one finished trace; reset does not hold next admission`, async (t) => {
    const f = await setup(t),
      a = await f.add();
    if (hasGoal) {
      const { changeGoal } = await import("./goal-store.ts");
      await changeGoal(
        {
          action: "start",
          text: "wait for answer",
          may: "",
          next_check: "in 1h",
        },
        chat,
        null,
        1000,
      );
    }
    await Promise.all([f.tick(), f.tick()]);
    assert.equal(f.state.calls.filter((x) => x === "session").length, 1);
    f.state.events = [
      { type: "message.completed", data: { message: "result" } },
      { type: "turn.completed", data: { sequence: 1, turnId: "turn" } },
    ];
    f.state.onCreate = () => {
      f.state.events = [];
      return Promise.resolve();
    };
    const writes: string[] = [],
      rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", (from: string, to: string) => {
      if (to.endsWith("result.md")) writes.push(to);
      return rename(from, to);
    });
    syncBuiltinESMExports();
    await Promise.all([f.tick(4000), f.tick(4000)]);
    await f.flush();
    assert.equal((await s.getHelper(a.id))?.outcome, "done");
    const b = await f.add();
    await f.tick(5000);
    assert.ok((await s.getHelper(b.id))?.run);
    assert.equal(writes.length, 1);
    const logs = (
      await Promise.all(
        (await readdir(join(f.dir, "trace"))).map((n) =>
          readFile(join(f.dir, "trace", n), "utf8"),
        ),
      )
    ).join("");
    assert.equal(logs.split('"name":"finished"').length - 1, 1);
  });
test("v7 volume and deadline request stop on the next tick; first reason survives", async (t) => {
  const f = await setup(t),
    a = await f.running();
  f.state.events = [
    {
      type: "step.completed",
      data: { usage: { inputTokens: s.HELPER_CEILING_TOKENS + 1 } },
    },
  ];
  await f.tick();
  assert.equal((await s.getHelper(a.id))?.stop, "ceiling");
  await f.tick(2000 + s.HELPER_DEADLINE_MS);
  assert.equal((await s.getHelper(a.id))?.stop, "ceiling");
  f.state.events.push({
    type: "turn.completed",
    data: { sequence: 1, turnId: "turn" },
  });
  await f.tick();
  assert.equal((await s.getHelper(a.id))?.outcome, "ceiling");
});
test("v7 corrupt table preserves bytes and emits store_broken", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.dir, "helpers.json"), "{");
  await f.tick();
  assert.equal(await readFile(join(f.dir, "helpers.json"), "utf8"), "{");
  assert.deepEqual(f.state.calls, []);
  const files = await readdir(join(f.dir, "trace"));
  assert.match(
    await readFile(join(f.dir, "trace", files[0]), "utf8"),
    /store_broken/,
  );
});

test("v7 K1: valid JSON with malformed turn.completed keeps run", async (t) => {
  const f = await setup(t),
    a = await f.running();
  f.state.events = [{ type: "turn.completed", data: 7 }];
  const before = await s.getHelper(a.id);
  await f.tick();
  assert.deepEqual(await s.getHelper(a.id), before);
  assert.deepEqual(f.state.calls, ["stream"]);
});

for (const event of [
  { type: "session.completed", data: 7 },
  { type: "session.completed", data: "x" },
  { type: "message.completed", data: 7 },
  { type: "message.completed", data: { message: 7 } },
])
  test(`snapshot shape: ${JSON.stringify(event)} keeps its run while another slot starts`, async (t) => {
    const f = await setup(t),
      a = await f.running(),
      b = await f.add(),
      before = await s.getHelper(a.id);
    f.state.events = [
      event,
      { type: "turn.completed", data: { sequence: 1, turnId: "turn" } },
    ];
    await f.tick();
    await f.flush();
    assert.deepEqual(await s.getHelper(a.id), before);
    assert.equal((await s.getHelper(b.id))?.run?.sessionId, "server");
    assert.deepEqual(f.state.calls, ["stream", "session"]);
  });

for (const status of [401, 403, 429, 503])
  test(`v7 K2: empty HTTP ${status} is definitive only for 4xx`, async (t) => {
    const f = await setup(t),
      a = await f.add(),
      b = await f.add();
    f.state.create = `empty-${status}`;
    await f.tick();
    const row = await s.getHelper(a.id);
    if (status < 500) {
      assert.equal(row?.outcome, "failed");
      assert.equal(row?.reason, "помощник не смог начать");
      assert.equal(row?.run, null);
      assert.equal((await s.getHelper(b.id))?.run?.sessionId, "server");
    } else {
      assert.ok(row?.run);
      assert.equal(row?.outcome, null);
      assert.equal(row.run.sessionId, null);
      assert.equal((await s.getHelper(b.id))?.run?.sessionId, "server");
    }
  });
test("v7 K2: HTTP 503 with a body is definitive", async (t) => {
  const f = await setup(t),
    a = await f.add();
  f.state.create = "server-error";
  await f.tick();
  assert.equal((await s.getHelper(a.id))?.outcome, "failed");
});
for (const snapshot of ["error", "garbage"])
  test(`v7 K3: closed stop sends cancel despite ${snapshot} snapshot`, async (t) => {
    const f = await setup(t),
      a = await f.running();
    await s.closeHelper(a.id, chat, 2100);
    const before = await s.getHelper(a.id);
    f.state.snapshot = snapshot;
    await f.tick();
    assert.deepEqual(await s.getHelper(a.id), before);
    assert.equal(f.state.calls.filter((x) => x === "cancel").length, 1);
    await f.tick();
    assert.deepEqual(await s.getHelper(a.id), before);
    assert.equal(f.state.calls.filter((x) => x === "cancel").length, 2);
  });

test("r339 helper step ceiling records a localized failure outcome", async (t) => {
  const { failedModelEvents } =
    await import("../../scripts/fixtures/reminder-events.test-fixture.ts");
  const f = await setup(t),
    row = await f.running();
  f.state.events = failedModelEvents();
  await f.tick();
  await f.flush();
  const result = await s.getHelper(row.id);
  assert.equal(result?.outcome, "failed");
  assert.equal(
    result?.reason,
    process.env.AGENT_LANGUAGE === "en"
      ? "Stopped after 40 steps without a final summary."
      : "Остановилась на 40 шагах и не успела подвести итог.",
  );
  assert.equal(result?.deliveredAt, null);
});
