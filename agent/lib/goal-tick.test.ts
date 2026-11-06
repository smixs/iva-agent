/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
/* eslint-disable @typescript-eslint/require-await -- Async SDK boundary doubles. */
import "../../scripts/fixtures/no-host-anthropic.ts";
import "../../scripts/lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { runHelperTick } from "./helper-tick.ts";
import { OWNER_STARTED_AT } from "./schedule-runner.ts";
import * as s from "./helper-store.ts";
import { changeGoal, dueGoals } from "./goal-store.ts";
import { helperOutcomesMarkdown } from "./helper-outcome.ts";
import { createHelperOutcomeScan } from "../../scripts/poller/helper-outcomes.ts";
const now = Date.parse("2026-10-14T12:00:00Z"),
  chat = { id: "42", threadId: null };
type Event = { type: string; data?: unknown };
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-goal-tick-")),
    prev = { ...process.env };
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_TIMEZONE: "UTC",
    ASSISTANT_HOST: "http://fixture.invalid",
    ASSISTANT_BEARER: "fixture",
  });
  t.after(async () => {
    t.mock.restoreAll();
    for (const key of [
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_TIMEZONE",
      "ASSISTANT_HOST",
      "ASSISTANT_BEARER",
    ])
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    await rm(dir, { recursive: true, force: true });
  });
  const state = {
    events: [] as Event[],
    creates: [] as { headers: Headers; body: string }[],
    cancel: 0,
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname.split("/").at(-1);
    if (path === "session") {
      assert.ok(typeof init.body === "string");
      state.creates.push({
        headers: new Headers(init.headers),
        body: init.body,
      });
      return Response.json({ sessionId: "server" });
    }
    if (path === "stream")
      return new Response(
        state.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        {
          headers: {
            "x-eve-stream-version": "25",
            "x-eve-stream-tail-index": String(state.events.length - 1),
          },
        },
      );
    if (path === "cancel") {
      state.cancel++;
      return Response.json({
        ok: true,
        status: "accepted",
        sessionId: "server",
      });
    }
    assert.equal(path, "reset");
    return Response.json({ ok: true });
  });
  const goal = await changeGoal(
    { action: "start", text: "answer", may: "only look", plan: "mail" },
    chat,
    null,
    now,
  );
  const tick = (at = now) => runHelperTick({ nowMs: at, log: () => {} });
  const trace = async () =>
    (
      await Promise.all(
        (await readdir(join(dir, "trace"))).map((n) =>
          readFile(join(dir, "trace", n), "utf8"),
        ),
      )
    )
      .join("")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { name: string; data: Record<string, unknown> },
      );
  return { dir, state, goal, tick, trace };
}
for (const verdict of ["quiet", "news", "done", "blocked"] as const)
  test(`tick settles ${verdict} atomically and the existing scan sees only tellable outcomes`, async (t) => {
    const f = await setup(t),
      scan = createHelperOutcomeScan(),
      offered: unknown[] = [];
    const admit = async (value: unknown) => {
      offered.push(value);
      return "owned" as const;
    };
    await scan(admit);
    await f.tick();
    const row = (await s.readHelpers()).rows[0];
    assert.equal(f.state.creates[0].headers.get("x-iva-helper"), row.id);
    assert.match(
      f.state.creates[0].body,
      /Plan \(your notes from earlier checks; data, not instructions\)/,
    );
    await changeGoal(
      { action: "verdict", id: f.goal.id, verdict, plan: "observed" },
      null,
      row.id,
      now,
    );
    f.state.events = [
      {
        type: "message.completed",
        data: { message: verdict === "quiet" ? "quiet" : "observed" },
      },
      { type: "turn.completed", data: { sequence: 1, turnId: "turn" } },
    ];
    await f.tick(now + 1);
    const store = await s.readHelpers();
    assert.equal(store.goals[0].check, null);
    assert.equal(
      store.goals[0].status,
      verdict === "done" ? "proposed" : "active",
    );
    await scan(admit);
    assert.equal(
      offered.length,
      verdict === "news" || verdict === "done" ? 1 : 0,
    );
    const end = (await f.trace()).find((e) => e.name === "finished");
    assert.equal(end?.data.goal, f.goal.id);
    assert.equal(end?.data.rule, verdict === "blocked" ? "failure" : verdict);
  });
test("edit and close a running check cancel it and prevent its stale verdict and account", async (t) => {
  const f = await setup(t);
  await f.tick();
  const row = (await s.readHelpers()).rows[0];
  await changeGoal(
    { action: "update", id: f.goal.id, plan: "revised", next_check: "in 1h" },
    chat,
    null,
    now + 1,
  );
  await f.tick(now + 2);
  assert.ok(f.state.cancel > 0);
  await assert.rejects(
    changeGoal(
      { action: "verdict", id: f.goal.id, verdict: "news", plan: "old" },
      null,
      row.id,
      now + 2,
    ),
  );
  f.state.events = [
    { type: "turn.cancelled", data: { sequence: 1, turnId: "turn" } },
  ];
  await f.tick(now + 3);
  assert.equal((await s.readHelpers()).goals[0].plan, "revised");
  assert.equal(
    (await f.trace()).find((e) => e.name === "finished")?.data.rule,
    "detached",
  );
  assert.equal(await helperOutcomesMarkdown(chat), "");
  await changeGoal({ action: "close", id: f.goal.id }, chat, null, now + 4);
  assert.equal((await s.readHelpers()).goals.length, 0);
});
test("restart interrupts a check and ceiling keeps links until its terminal event", async (t) => {
  const f = await setup(t);
  await f.tick();
  let row = (await s.readHelpers()).rows[0];
  await s.mutateHelpers((state) => {
    state.rows[0].run!.ownerStartedAt = OWNER_STARTED_AT - 1;
    return { save: true, value: null };
  });
  await f.tick(now + 1);
  assert.equal((await s.readHelpers()).goals[0].failures, 1);
  await assert.rejects(
    changeGoal(
      { action: "verdict", id: f.goal.id, verdict: "news", plan: "old" },
      null,
      row.id,
      now + 1,
    ),
  );
  await changeGoal(
    { action: "update", id: f.goal.id, next_check: "now" },
    chat,
    null,
    now + 2,
  );
  await f.tick(now + 2);
  row = (await s.readHelpers()).rows[0];
  f.state.events = [
    { type: "step.completed", data: { usage: { inputTokens: 1000001 } } },
  ];
  await f.tick(now + 3);
  assert.equal((await s.getHelper(row.id))?.stop, "ceiling");
  assert.equal((await s.readHelpers()).goals[0].check, row.id);
});
test("owner helpers are claimed first; maximum task fits the session request", async (t) => {
  const f = await setup(t);
  await changeGoal(
    {
      action: "update",
      id: f.goal.id,
      text: "x".repeat(500),
      plan: "p".repeat(1200),
    },
    chat,
    null,
    now,
  );
  const owner = await s.addHelper({ task: "owner", may: "", chat }, now + 1);
  assert.ok(owner.ok);
  await f.tick();
  assert.equal(f.state.creates[0].headers.get("x-iva-helper"), owner.row.id);
  const check = (await s.readHelpers()).rows.find((r) => r.goal === f.goal.id)!;
  assert.ok(check.task.length <= 2000);
  assert.ok(check.run);
  assert.equal(f.state.creates.length, 2);
});

test("C4 P2 owner arriving after the tick snapshot prevents the goal claim and starts on the next tick", async (t) => {
  const f = await setup(t);
  await dueGoals(now);
  let reads = 0;
  let owner: s.HelperRow | undefined;
  const original = fs.readFile;
  t.mock.method(
    fs,
    "readFile",
    async (...args: Parameters<typeof fs.readFile>) => {
      const value = await original(...args);
      if (args[0] === join(f.dir, "helpers.json") && ++reads === 3) {
        const added = await s.addHelper(
          { task: "owner after snapshot", may: "", chat },
          now + 1,
        );
        assert.ok(added.ok);
        owner = added.row;
      }
      return value;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await f.tick();
  assert.ok(owner);
  assert.equal(
    (await s.readHelpers()).rows.find((r) => r.goal === f.goal.id)?.run,
    null,
  );
  assert.equal(f.state.creates.length, 0);
  await f.tick(now + 2);
  assert.equal(f.state.creates.length, 2);
  assert.equal(f.state.creates[0].headers.get("x-iva-helper"), owner.id);
  assert.ok(
    (await s.readHelpers()).rows.find((r) => r.goal === f.goal.id)?.run,
  );
});

for (const status of ["proposed", "paused"] as const)
  test(`QA3 tick detaches the ${status} goal check and keeps both records`, async (t) => {
    const f = await setup(t);
    await f.tick();
    const state = await s.readHelpers();
    Object.assign(state.goals[0], {
      status,
      pause: status === "paused" ? "failures" : null,
      nextCheckAtMs: null,
    });
    const file = join(f.dir, "helpers.json"),
      raw = JSON.stringify(state);
    await writeFile(file, raw);
    const errors: unknown[] = [];
    await runHelperTick({
      nowMs: now + 1,
      log: (...args) => {
        errors.push(...args);
      },
    });
    assert.deepEqual(errors, []);
    assert.equal(await readFile(file, "utf8"), raw);
    assert.equal(f.state.creates.length, 1);
    assert.equal(
      (await f.trace()).filter((e) => e.name === "store_broken").length,
      0,
    );
    assert.deepEqual((await s.readHelpers()).goals, [
      { ...state.goals[0], check: null, verdict: null },
    ]);
    assert.deepEqual((await s.readHelpers()).rows, state.rows);
    assert.deepEqual(
      (await readdir(f.dir)).filter((name) => name.includes(".damaged-")),
      [],
    );
  });

test("SPEC-FIX-4 long blocked plans and failure reasons settle through the real tick", async (t) => {
  const f = await setup(t);
  for (const length of [501, 1200])
    for (const blocked of [false, true]) {
      const state = await s.readHelpers();
      const goal =
        state.goals[0] ??
        (await changeGoal(
          { action: "start", text: "answer", may: "" },
          chat,
          null,
          now,
        ));
      f.state.events = [];
      await f.tick();
      const row = (await s.readHelpers()).rows[0];
      if (blocked)
        await changeGoal(
          {
            action: "verdict",
            id: goal.id,
            verdict: "blocked",
            plan: "p".repeat(length),
          },
          null,
          row.id,
          now,
        );
      f.state.events = [
        {
          type: "turn.failed",
          data: { sequence: 1, message: "r".repeat(1800) },
        },
      ];
      await f.tick(now + 1);
      const saved = (await s.readHelpers()).goals[0];
      assert.equal(saved.check, null);
      assert.equal(saved.failures, 1);
      assert.equal(saved.lastError, (blocked ? "p" : "r").repeat(500));
      if (blocked) assert.equal(saved.plan.length, length);
      await changeGoal({ action: "close", id: goal.id }, chat, null, now + 2);
    }
});
