/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "../../scripts/fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  readdir,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "./helper-store.ts";
import * as store from "./goal-store.ts";
const g = {
  ...store,
  startGoal: (
    v: {
      text: string;
      may: string;
      plan: string;
      chat: s.HelperChat;
      nextCheckAtMs: number;
    },
    now: number,
  ) =>
    store.changeGoal(
      {
        action: "start",
        text: v.text,
        may: v.may,
        plan: v.plan,
        next_check:
          new Date(v.nextCheckAtMs).toISOString().replace(/\.000Z$/, "Z") ===
          new Date(now).toISOString().replace(/\.000Z$/, "Z")
            ? "now"
            : new Date(v.nextCheckAtMs).toISOString().replace(/\.000Z$/, "Z"),
      },
      v.chat,
      null,
      now,
    ),
  editGoal: (
    id: string,
    chat: s.HelperChat,
    patch: Partial<
      Pick<import("./goal-rules.ts").Goal, "text" | "may" | "plan">
    > & { nextCheckAtMs?: number },
    now: number,
  ) =>
    store.changeGoal(
      {
        action: "update",
        id,
        text: patch.text,
        may: patch.may,
        plan: patch.plan,
        next_check:
          patch.nextCheckAtMs === undefined
            ? undefined
            : new Date(patch.nextCheckAtMs)
                .toISOString()
                .replace(/\.000Z$/, "Z"),
      },
      chat,
      null,
      now,
    ),
  closeGoal: (id: string, chat: s.HelperChat, now: number) =>
    store.changeGoal({ action: "close", id }, chat, null, now),
  verdictGoal: (
    id: string,
    helper: string,
    verdict: import("./goal-rules.ts").GoalVerdict,
  ) =>
    store.changeGoal(
      {
        action: "verdict",
        id,
        verdict: verdict.verdict,
        plan: verdict.plan,
        next_check:
          verdict.nextCheckAtMs === null
            ? undefined
            : new Date(verdict.nextCheckAtMs)
                .toISOString()
                .replace(/\.000Z$/, "Z"),
      },
      null,
      helper,
      now,
    ),
};
const chat = { id: "42", threadId: null };
const now = Date.parse("2026-10-14T12:00:00Z");
const finish = {
  outcome: "done" as const,
  summary: "answer",
  reason: null,
  model: "fixture",
  steps: 1,
  tokens: 1,
};
async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-goal-"));
  const prev = { ...process.env };
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_TIMEZONE: "UTC",
  });
  t.after(async () => {
    for (const key of ["ASSISTANT_DATA_DIR", "ASSISTANT_TIMEZONE"])
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, file: join(dir, "helpers.json") };
}
const start = (at = now) =>
  g.startGoal(
    { text: "answer", may: "", plan: "mail", chat, nextCheckAtMs: at },
    at,
  );
async function check(at = now) {
  const goal = await start(at);
  await g.dueGoals(at);
  const row = (await s.readHelpers()).rows.find((r) => r.goal === goal.id)!;
  assert.ok(row);
  return { goal, row };
}

test("S1 owner, Watch and Brief can distinguish a live check from a quiet settled check", async (t) => {
  await setup(t);
  const { goal, row } = await check();
  for (const reader of [chat, null])
    assert.equal((await g.listGoals(reader, now))[0].check, row.id);
  await s.claimHelper(row.id, { ownerStartedAt: now }, now);
  await store.changeGoal(
    { action: "verdict", id: goal.id, verdict: "quiet", plan: "mail" },
    null,
    row.id,
    now,
  );
  await s.finalizeHelper(
    row.id,
    { kind: "running", firedAt: now },
    finish,
    now,
  );
  for (const reader of [chat, null])
    assert.equal((await g.listGoals(reader, now))[0].check, null);
});

test("P1 delivered rows block the next due check until swept, preserving the saved row bound", async (t) => {
  await setup(t);
  await start();
  await start();
  await g.dueGoals(now);
  for (const row of (await s.readHelpers()).rows) {
    await s.claimHelper(row.id, { ownerStartedAt: now }, now);
    await store.changeGoal(
      { action: "verdict", id: row.goal!, verdict: "news", plan: "observed" },
      null,
      row.id,
      now,
    );
    await s.finalizeHelper(
      row.id,
      { kind: "running", firedAt: now },
      finish,
      now,
    );
    await s.markHelperDelivered(row.id, chat, now + 1);
  }
  await g.dueGoals(now + 7200000);
  const saved = await s.readHelpers();
  assert.ok(
    saved.rows.filter((r) => r.goal !== null && r.status !== "closed").length <=
      saved.goals.length + 1,
  );
  assert.equal(saved.rows.filter((r) => r.status === "pending").length, 0);
  assert.equal((await s.sweepHelpers(now + 7200000)).length, 2);
  await g.dueGoals(now + 7200000);
  assert.equal(
    (await s.readHelpers()).rows.filter((r) => r.status === "pending").length,
    2,
  );
});

for (const status of ["proposed", "paused"] as const)
  test(`QA3 ${status} with a live check detaches the check and keeps both records`, async (t) => {
    const { file } = await setup(t);
    const { row } = await check();
    await s.claimHelper(row.id, { ownerStartedAt: now }, now);
    const state = await s.readHelpers();
    Object.assign(state.goals[0], {
      status,
      pause: status === "paused" ? "failures" : null,
      nextCheckAtMs: null,
    });
    const raw = JSON.stringify(state);
    await writeFile(file, raw);
    const loaded = await s.readHelpers();
    const expected = [{ ...state.goals[0], check: null, verdict: null }];
    assert.deepEqual(loaded.goals, expected);
    assert.deepEqual(loaded.rows, state.rows);
    assert.equal(await readFile(file, "utf8"), raw);
    const copies = (await readdir(join(file, ".."))).filter((name) =>
      name.includes(".damaged-"),
    );
    assert.deepEqual(copies, []);
    await s.finalizeHelper(
      row.id,
      { kind: "running", firedAt: now },
      finish,
      now,
    );
    assert.equal((await s.getHelper(row.id))?.status, "closed");
    assert.deepEqual((await s.readHelpers()).goals, expected);
  });
test("legacy defaults, corruption and cross-links preserve stored bytes", async (t) => {
  const { file } = await setup(t);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, rows: [] }));
  assert.deepEqual(await s.readHelpers(), {
    schemaVersion: 1,
    rows: [],
    goals: [],
  });
  const { goal, row } = await check();
  const base = await s.readHelpers();
  const cases = [
    { value: { ...base, schemaVersion: 2 }, rows: [], goals: [], damaged: [] },
    {
      value: { ...base, goals: [goal, goal] },
      rows: [row],
      goals: [goal],
      damaged: [goal],
    },
    {
      value: { ...base, goals: [{ ...base.goals[0], check: "h-ffffff" }] },
      rows: [row],
      goals: [{ ...base.goals[0], check: null }],
      damaged: [],
    },
    {
      value: { ...base, goals: [{ ...base.goals[0], status: "paused" }] },
      rows: [{ ...row, goal: null }],
      goals: [],
      damaged: [{ ...base.goals[0], status: "paused" }],
    },
    {
      value: { ...base, rows: [{ ...row, goal: "g-ffffff" }] },
      rows: [{ ...row, goal: null }],
      goals: [{ ...base.goals[0], check: null }],
      damaged: [],
    },
    {
      value: { ...base, goals: [{ ...base.goals[0], nextCheckAtMs: null }] },
      rows: [{ ...row, goal: null }],
      goals: [],
      damaged: [{ ...base.goals[0], nextCheckAtMs: null }],
    },
  ];
  for (const { value, rows, goals, damaged } of cases) {
    const raw = JSON.stringify(value);
    await writeFile(file, raw);
    if (value.schemaVersion === 2)
      await assert.rejects(s.readHelpers(), s.HelperStoreError);
    else {
      const loaded = await s.readHelpers();
      assert.deepEqual(loaded.rows, rows);
      assert.deepEqual(loaded.goals, goals);
      const copies = (await readdir(join(file, ".."))).filter((name) =>
        name.includes(".damaged-"),
      );
      const records = await Promise.all(
        copies.map(
          async (name) =>
            (
              JSON.parse(await readFile(join(file, "..", name), "utf8")) as {
                record: unknown;
              }
            ).record,
        ),
      );
      for (const bad of damaged)
        assert.ok(
          records.some(
            (record) => JSON.stringify(record) === JSON.stringify(bad),
          ),
        );
    }
    assert.equal(await readFile(file, "utf8"), raw);
  }
  await fc.assert(
    fc.asyncProperty(fc.jsonValue(), async (value) => {
      const raw = JSON.stringify({ ...base, goals: value });
      await writeFile(file, raw);
      if (Array.isArray(value)) {
        assert.deepEqual((await s.readHelpers()).goals, []);
        const copies = (await readdir(join(file, ".."))).filter((name) =>
          name.includes(".damaged-"),
        );
        const records = await Promise.all(
          copies.map(
            async (name) =>
              (
                JSON.parse(await readFile(join(file, "..", name), "utf8")) as {
                  record: unknown;
                }
              ).record,
          ),
        );
        for (const record of value)
          assert.ok(
            records.some(
              (copy) => JSON.stringify(copy) === JSON.stringify(record),
            ),
          );
      } else await assert.rejects(s.readHelpers(), s.HelperStoreError);
      assert.equal(await readFile(file, "utf8"), raw);
    }),
    { seed: 20261014, numRuns: 50 },
  );
});
test("overlapping due passes create one check; unchanged due does not write", async (t) => {
  const { file } = await setup(t);
  const goal = await start();
  await Promise.all([g.dueGoals(now), g.dueGoals(now)]);
  const state = await s.readHelpers();
  assert.equal(state.rows.length, 1);
  assert.equal(state.goals[0].checks.count, 1);
  assert.equal(state.goals[0].check, state.rows[0].id);
  assert.equal(state.rows[0].goal, goal.id);
  const before = await stat(file, { bigint: true });
  await g.dueGoals(now);
  assert.equal((await stat(file, { bigint: true })).mtimeNs, before.mtimeNs);
});
test("daily count, quiet hours, expiry and untold outcomes gate due", async (t) => {
  await setup(t);
  const goal = await start();
  await g.dueGoals(Date.parse("2026-10-14T23:00:00Z"));
  assert.equal((await s.readHelpers()).rows.length, 0);
  await g.dueGoals(now);
  let state = await s.readHelpers();
  const row = state.rows[0];
  await g.verdictGoal(goal.id, row.id, {
    verdict: "news",
    plan: "new",
    nextCheckAtMs: null,
  });
  await s.finalizeHelper(
    row.id,
    { kind: "pending", createdAt: now },
    finish,
    now + 1,
  );
  await g.dueGoals(now + 7200000);
  assert.equal((await s.readHelpers()).rows.length, 1);
  await s.markHelperDelivered(row.id, chat, now + 2);
  await s.sweepHelpers(now + 3);
  assert.equal((await s.readHelpers()).rows.length, 0);
  await s.mutateHelpers((state) => {
    state.goals[0].checks.count = 8;
    return { save: true, value: null };
  });
  await g.dueGoals(now + 7200000);
  assert.equal((await s.readHelpers()).rows.length, 0);
  await g.dueGoals(now + 86400000);
  state = await s.readHelpers();
  assert.equal(state.goals[0].checks.count, 1);
  const r = state.rows[0];
  await s.closeHelper(r.id, chat, now + 86400001);
  await s.sweepHelpers(now + 86400002);
  await g.dueGoals(now + 2592000000);
  assert.equal((await s.readHelpers()).goals[0].pause, "expired");
});
test("SPEC-FIX-5 reserves a row and a pending slot for the owner", async (t) => {
  await setup(t);
  for (let i = 0; i < 5; i++) await start();
  for (let i = 0; i < 18; i++) {
    const result = await s.addHelper({ task: "owner", may: "", chat }, now);
    assert.ok(result.ok);
    await s.finalizeHelper(
      result.row.id,
      { kind: "pending", createdAt: now },
      finish,
      now,
    );
  }
  await g.dueGoals(now);
  assert.equal((await s.readHelpers()).rows.length, 19);
  assert.equal((await s.readHelpers()).goals.filter((v) => v.check).length, 1);
  assert.ok((await s.addHelper({ task: "owner", may: "", chat }, now)).ok);
  assert.equal((await s.readHelpers()).rows.length, 20);
});
test("five due goals queue at most two; an owner with two pending gets the third", async (t) => {
  await setup(t);
  for (let i = 0; i < 5; i++) await start();
  await g.dueGoals(now);
  assert.equal((await s.readHelpers()).rows.length, 2);
  const owner = await s.addHelper({ task: "owner", may: "", chat }, now);
  assert.ok(owner.ok);
  for (const r of (await s.readHelpers()).rows)
    await s.closeHelper(r.id, chat, now);
  await s.sweepHelpers(now);
  await s.addHelper({ task: "owner2", may: "", chat }, now);
  await s.addHelper({ task: "owner3", may: "", chat }, now);
  await g.dueGoals(now + 7200000);
  assert.equal(
    (await s.readHelpers()).rows.filter((r) => r.goal !== null).length,
    0,
  );
});
test("edit detaches running checks, owner time survives settlement, close hides untold", async (t) => {
  await setup(t);
  const { goal, row } = await check();
  await s.claimHelper(row.id, { ownerStartedAt: now }, now);
  await s.stopHelper(row.id, now, "deadline");
  await g.editGoal(goal.id, chat, { plan: "new brief" }, now);
  await assert.rejects(
    g.verdictGoal(goal.id, row.id, {
      verdict: "done",
      plan: "stale",
      nextCheckAtMs: null,
    }),
  );
  const ended = await s.finalizeHelper(
    row.id,
    { kind: "running", firedAt: now },
    finish,
    now + 1,
  );
  assert.equal(ended?.rule, "detached");
  assert.equal((await s.readHelpers()).goals[0].plan, "new brief");
  await s.sweepHelpers(now + 2);
  await g.dueGoals(now + 2);
  const next = (await s.readHelpers()).rows[0];
  await g.editGoal(goal.id, chat, { nextCheckAtMs: now + 3600000 }, now + 2);
  await g.verdictGoal(goal.id, next.id, {
    verdict: "news",
    plan: "found",
    nextCheckAtMs: now + 6000000,
  });
  await s.finalizeHelper(
    next.id,
    { kind: "pending", createdAt: now + 2 },
    finish,
    now + 3,
  );
  assert.equal((await s.readHelpers()).goals[0].nextCheckAtMs, now + 3600000);
  await g.closeGoal(goal.id, chat, now + 4);
  assert.equal((await s.readHelpers()).goals.length, 0);
  assert.equal((await s.readHelpers()).rows[0].status, "closed");
});
test("long blocked plan and reason persist atomically, helper stop keeps links until finish", async (t) => {
  await setup(t);
  for (const blocked of [true, false]) {
    const { goal, row } = await check();
    await s.claimHelper(row.id, { ownerStartedAt: now }, now);
    await s.stopHelper(row.id, now, "ceiling");
    if (blocked)
      await g.verdictGoal(goal.id, row.id, {
        verdict: "blocked",
        plan: "p".repeat(1200),
        nextCheckAtMs: null,
      });
    await s.finalizeHelper(
      row.id,
      { kind: "running", firedAt: now },
      { ...finish, reason: "r".repeat(1800) },
      now + 1,
    );
    const state = await s.readHelpers();
    assert.equal(
      state.goals.find((v) => v.id === goal.id)?.lastError?.length,
      500,
    );
    await s.sweepHelpers(now + 2);
  }
});
test("quiet day stays bounded through forty checks, own helpers keep normal retention", async (t) => {
  await setup(t);
  const morning = Date.parse("2026-10-14T08:00:00Z");
  for (let i = 0; i < 5; i++) await start(morning);
  let completed = 0;
  for (let i = 0; i < 8; i++)
    for (let pass = 0; pass < 3; pass++) {
      const at = morning + i * 7200000;
      await g.dueGoals(at);
      for (const row of (await s.readHelpers()).rows.filter(
        (r) => r.status === "pending",
      )) {
        await g.verdictGoal(row.goal!, row.id, {
          verdict: "quiet",
          plan: "read",
          nextCheckAtMs: null,
        });
        await s.finalizeHelper(
          row.id,
          { kind: "pending", createdAt: row.createdAt },
          finish,
          at + 1,
        );
        completed++;
      }
      await s.sweepHelpers(at + 2);
      assert.equal((await s.readHelpers()).rows.length, 0);
    }
  assert.equal(completed, 40);
  assert.ok(
    (await s.readHelpers()).goals.every(
      (g) => g.checks.count === 8 && g.checks.day === "2026-10-14",
    ),
  );
  const owner = await s.addHelper({ task: "owner", may: "", chat }, now);
  assert.ok(owner.ok);
  await s.closeHelper(owner.row.id, chat, now);
  await s.sweepHelpers(now + 1);
  assert.equal((await s.readHelpers()).rows.length, 1);
});

test("fc.commands mixes goal and owner transitions while preserving links and untold outcomes", async (t) => {
  const { file } = await setup(t);
  type Model = { ids: string[] };
  class Command implements fc.AsyncCommand<Model, Record<string, never>> {
    readonly op: string;
    readonly index: number;
    constructor(op: string, index: number) {
      this.op = op;
      this.index = index;
    }
    check = () => true;
    toString = () => `${this.op}(${this.index})`;
    async run(model: Model) {
      const before = await s.readHelpers(),
        goal = before.goals[this.index % Math.max(1, before.goals.length)];
      const row = before.rows[this.index % Math.max(1, before.rows.length)];
      const at = now + this.index * 1000;
      if (this.op === "start" && model.ids.length < 5) {
        const result = await store.changeGoal(
          { action: "start", text: "observe", may: "" },
          chat,
          null,
          at,
        );
        model.ids.push(result.id);
      } else if (this.op === "due") await store.dueGoals(at);
      else if (
        this.op === "owner" &&
        before.rows.length < 20 &&
        before.rows.filter((r) => r.status === "pending").length < 3
      )
        assert.ok((await s.addHelper({ task: "owner", may: "", chat }, at)).ok);
      else if (this.op === "close" && goal) {
        await store.changeGoal(
          { action: "close", id: goal.id },
          chat,
          null,
          at,
        );
        model.ids = model.ids.filter((id) => id !== goal.id);
      } else if (this.op === "edit" && goal)
        await store.changeGoal(
          { action: "update", id: goal.id, plan: "edited" },
          chat,
          null,
          at,
        );
      else if (this.op === "verdict" && goal?.check)
        await store.changeGoal(
          { action: "verdict", id: goal.id, verdict: "news", plan: "observed" },
          null,
          goal.check,
          at,
        );
      else if (this.op === "claim" && row)
        await s.claimHelper(row.id, { ownerStartedAt: now }, at);
      else if (this.op === "stop" && row?.run)
        await s.stopHelper(
          row.id,
          row.run.firedAt,
          this.index % 2 ? "ceiling" : "deadline",
        );
      else if (this.op === "helper-close" && row && row.deliveredAt === null)
        await s.closeHelper(row.id, chat, at);
      else if (this.op === "finish" && row)
        await s.finalizeHelper(
          row.id,
          row.run
            ? { kind: "running", firedAt: row.run.firedAt }
            : { kind: "pending", createdAt: row.createdAt },
          finish,
          at,
        );
      else if (this.op === "deliver" && row)
        await s.markHelperDelivered(row.id, chat, at);
      else if (this.op === "sweep") {
        await s.sweepHelpers(at);
        const after = await s.readHelpers();
        for (const r of before.rows.filter(
          (r) =>
            r.goal !== null &&
            r.status === "finished" &&
            r.deliveredAt === null,
        ))
          assert.ok(after.rows.some((x) => x.id === r.id));
      }
      const after = await s.readHelpers();
      assert.deepEqual(
        after.goals.map((g) => g.id).sort(),
        [...model.ids].sort(),
      );
      assert.ok(after.rows.filter((r) => r.run).length <= 3);
      assert.ok(after.rows.filter((r) => r.status === "pending").length <= 3);
      assert.ok(
        after.rows.filter((r) => r.goal !== null && r.status !== "closed")
          .length <=
          after.goals.length + 1,
      );
      for (const goal of after.goals) {
        if (goal.check)
          assert.equal(
            after.rows.find((r) => r.id === goal.check)?.goal,
            goal.id,
          );
        assert.ok(
          after.rows.filter(
            (r) =>
              r.goal === goal.id &&
              r.status === "finished" &&
              r.deliveredAt === null,
          ).length <= 1,
        );
      }
    }
  }
  const commands = fc.commands(
    [
      fc
        .tuple(
          fc.constantFrom(
            "start",
            "due",
            "owner",
            "close",
            "edit",
            "verdict",
            "claim",
            "stop",
            "helper-close",
            "finish",
            "deliver",
            "sweep",
          ),
          fc.nat(20),
        )
        .map(([op, index]) => new Command(op, index)),
    ],
    { maxCommands: 40 },
  );
  await fc.assert(
    fc.asyncProperty(commands, async (commands) => {
      await rm(file, { force: true });
      await fc.asyncModelRun(
        () => ({ model: { ids: [] }, real: {} }),
        commands,
      );
    }),
    { seed: 20261014, numRuns: 40 },
  );
});

test("due Goal and owner helper both start behind 20 delivered rows", async (t) => {
  const { dir } = await setup(t);
  const goal = await start();
  const old: string[] = [];
  for (let i = 0; i < 20; i++) {
    const added = await s.addHelper({ task: "old", may: "", chat }, now + i);
    assert.ok(added.ok);
    await s.finalizeHelper(
      added.row.id,
      { kind: "pending", createdAt: now + i },
      finish,
      now + i + 1,
    );
    await s.markHelperDelivered(added.row.id, chat, now + 100 + i);
    await mkdir(join(dir, "helpers", added.row.id), { recursive: true });
    old.push(added.row.id);
  }
  const owner = await s.addHelper({ task: "owner", may: "", chat }, now + 200);
  assert.ok(owner.ok);
  await g.dueGoals(now + 201);
  const state = await s.readHelpers();
  assert.ok(state.goals[0].check);
  assert.equal(state.goals[0].id, goal.id);
  assert.equal(state.goals[0].checks.count, 1);
  assert.equal(state.rows.length, 19);
  assert.ok(state.rows.some((r) => r.id === owner.row.id));
  assert.ok(
    state.rows.some((r) => r.id === state.goals[0].check && r.goal === goal.id),
  );
  for (const id of old.slice(0, 3)) {
    assert.equal(await s.getHelper(id), null);
    await assert.rejects(stat(join(dir, "helpers", id)), { code: "ENOENT" });
  }
  assert.deepEqual(
    state.rows.filter((r) => old.includes(r.id)).map((r) => r.id),
    old.slice(3),
  );
});

test("blocked Goal logs refusal and preserves all unread outcomes", async (t) => {
  const { file } = await setup(t);
  const goal = await start();
  for (let i = 0; i < 20; i++) {
    const added = await s.addHelper({ task: "unread", may: "", chat }, now + i);
    assert.ok(added.ok);
    await s.finalizeHelper(
      added.row.id,
      { kind: "pending", createdAt: now + i },
      finish,
      now + i + 1,
    );
  }
  const before = await readFile(file, "utf8");
  const logs: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" ")),
  );
  await g.dueGoals(now + 100);
  assert.equal(await readFile(file, "utf8"), before);
  assert.ok(
    logs.some((line) => line.includes(goal.id) && /max-rows/.test(line)),
  );
  const refused = await s.addHelper(
    { task: "owner", may: "", chat },
    now + 200,
  );
  assert.ok(!refused.ok);
  assert.match(refused.text, /running tasks or unread outcomes/);
  assert.doesNotMatch(refused.text, /Wait for completion and delivery/);
});

test("Goal admission preserves protected rows and its owner reserve; seed 20261020", async (t) => {
  await setup(t);
  const goal = await start();
  const added = await s.addHelper({ task: "template", may: "", chat }, now);
  assert.ok(added.ok);
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom("delivered", "closed", "unread", "goal", "pending"),
        { minLength: 20, maxLength: 20 },
      ),
      async (kinds) => {
        const state = await s.readHelpers();
        state.rows = kinds.map((kind, i) => ({
          ...added.row,
          id: `h-${i.toString(16).padStart(6, "0")}`,
          goal: kind === "goal" ? goal.id : null,
          status:
            kind === "pending"
              ? "pending"
              : kind === "closed"
                ? "closed"
                : "finished",
          outcome: kind === "pending" ? null : "done",
          finishedAt: kind === "pending" ? null : now + i,
          deliveredAt:
            kind === "delivered" || kind === "goal" ? now + 100 + i : null,
        }));
        const before = structuredClone(state);
        const eligible = state.rows
          .filter(
            (r) =>
              r.goal === null &&
              (r.status === "closed" || r.deliveredAt !== null),
          )
          .sort(
            (a, b) =>
              (a.deliveredAt ?? a.finishedAt!) -
              (b.deliveredAt ?? b.finishedAt!),
          );
        const result = s.insertRow(
          state,
          { task: "check", may: "", chat, goal: goal.id },
          now + 300,
        );
        const allowed =
          eligible.length >= 2 &&
          before.rows.filter((r) => r.status === "pending").length < 2;
        assert.equal(result.ok, allowed);
        if (!allowed) assert.deepEqual(state, before);
        else {
          assert.equal(state.rows.length, 19);
          assert.deepEqual(
            state.rows.slice(0, -1),
            before.rows.filter(
              (r) => !eligible.slice(0, 2).some((e) => e.id === r.id),
            ),
          );
          assert.deepEqual(state.goals, before.goals);
        }
      },
    ),
    {
      seed: 20261020,
      numRuns: 30,
      examples: [
        [Array.from({ length: 20 }, () => "closed" as const)],
        [Array.from({ length: 20 }, () => "delivered" as const)],
        [["delivered", ...Array.from({ length: 19 }, () => "unread" as const)]],
        [
          [
            "pending",
            "pending",
            ...Array.from({ length: 18 }, () => "delivered" as const),
          ],
        ],
      ],
    },
  );
});
