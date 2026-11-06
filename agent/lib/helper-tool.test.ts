/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { helperExecute } from "./helper-tool.ts";
import { readHelpers } from "./helper-store.ts";
const auth = () => ({
  authenticator: "telegram-webhook",
  principalType: "user",
  attributes: { chat_id: "42", chat_type: "private" },
});
const ctx = () => ({
  session: {
    id: "s",
    turn: { id: "turn_0" },
    auth: { initiator: auth(), current: auth() },
  },
});
test("R5 corrupt helper table tells the model it is damaged for every operation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-tool-broken-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "helpers.json"), "{");
  for (const action of ["start", "list", "close", "outcome"]) {
    const reply = await helperExecute(
      { action, task: "task", may: "", id: "h-abcdef" },
      ctx(),
      {
        now: 1000,
        tick: () => Promise.resolve(),
      },
    );
    assert.match(reply, /таблица помощников повреждена/iu);
    assert.doesNotMatch(reply, /повтори/iu);
  }
  assert.equal(await readFile(join(dir, "helpers.json"), "utf8"), "{");
});
test("helper start may/type guards preserve table, list reads; seed 20261013", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-tool-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  const deps = {
    now: 1000,
    tick: () => Promise.resolve(),
  };
  assert.match(
    await helperExecute({ action: "start", task: "task" }, ctx(), deps),
    /границ/,
  );
  assert.equal((await readHelpers()).rows.length, 0);
  assert.match(
    await helperExecute(
      { action: "start", task: "task", may: "" },
      ctx(),
      deps,
    ),
    /h-/,
  );
  assert.equal((await readHelpers()).rows.length, 1);
  const id = (await readHelpers()).rows[0].id;
  assert.match(
    await helperExecute({ action: "list" }, ctx(), deps),
    new RegExp(id),
  );
  assert.doesNotMatch(
    await helperExecute({ action: "list" }, ctx(), deps),
    /summary/,
  );
  assert.match(
    await helperExecute({ action: "close", id }, ctx(), deps),
    /до запуска/,
  );
  const bad = {
    ...ctx(),
    session: {
      ...ctx().session,
      auth: {
        initiator: {
          authenticator: "iva-bearer",
          principalType: "service",
          attributes: { iva_turn: "helper" },
        },
        current: auth(),
      },
    },
  };
  assert.match(await helperExecute({ action: "list" }, bad, deps), /личного/);
});
test("real tool: flat schema, hostile operation/input/auth and foreign chat leave rows unchanged; seed 20261013", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-tool-")),
    prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const { z } = await import("zod");
  const { helperInputSchema } = await import("./helper-tool.ts");
  const s = await import("./helper-store.ts");
  const json = z.toJSONSchema(helperInputSchema);
  assert.equal(json.type, "object");
  assert.ok(json.properties);
  for (const k of ["oneOf", "anyOf", "allOf"]) assert.ok(!(k in json));
  const deps = {
    now: 1000,
    tick: () => Promise.resolve(),
  };
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.jsonValue(),
        fc
          .string({ minLength: 2001, maxLength: 2200 })
          .map((task) => ({ action: "start", task, may: "" })),
        fc
          .string({ minLength: 501, maxLength: 550 })
          .map((may) => ({ action: "start", task: "t", may })),
      ),
      async (input) => {
        const parsed = helperInputSchema.safeParse(input);
        if (
          parsed.success &&
          parsed.data.action === "start" &&
          parsed.data.may !== undefined &&
          parsed.data.may.length <= 500 &&
          (parsed.data.task?.trim().length ?? 0) >= 1 &&
          (parsed.data.task?.trim().length ?? 0) <= 2000
        )
          return;
        const before = JSON.stringify(await readHelpers());
        const result = await helperExecute(input, ctx(), deps);
        assert.equal(typeof result, "string");
        assert.equal(JSON.stringify(await readHelpers()), before);
      },
    ),
    { seed: 20261013, numRuns: 80 },
  );
  for (const side of ["initiator", "current"])
    for (const mode of ["helper", "group", "service", "unknown", "missing"]) {
      const a = auth();
      const evil = {
        ...a,
        authenticator:
          mode === "helper"
            ? "iva-bearer"
            : mode === "unknown"
              ? "unknown"
              : a.authenticator,
        principalType: mode === "service" ? "service" : "user",
        attributes: {
          ...a.attributes,
          chat_type: mode === "group" ? "group" : "private",
          iva_turn: mode === "helper" ? "helper" : "chat",
        },
      };
      const c = {
        session: {
          ...ctx().session,
          auth: {
            ...ctx().session.auth,
            [side]: mode === "missing" ? null : evil,
          },
        },
      };
      for (const action of ["start", "list", "close", "outcome"]) {
        const before = JSON.stringify(await readHelpers());
        assert.match(
          await helperExecute(
            { action, task: "t", may: "", id: "h-123abc" },
            c,
            deps,
          ),
          /личного/,
        );
        assert.equal(JSON.stringify(await readHelpers()), before);
      }
    }
  for (let i = 0; i < 3; i++) {
    const r = await s.addHelper(
      { task: "t", may: "", chat: { id: "42", threadId: null } },
      1000,
    );
    assert.ok(r.ok);
    await s.claimHelper(r.row.id, { ownerStartedAt: 1 }, 2000);
    await s.finalizeHelper(
      r.row.id,
      { kind: "running", firedAt: 2000 },
      {
        outcome: "done",
        summary: "ready",
        reason: null,
        model: null,
        steps: 1,
        tokens: 1,
      },
      3000,
    );
  }
  assert.match(
    await helperExecute({ action: "start", task: "t", may: "" }, ctx(), deps),
    /background/,
  );
  const logs = await Promise.all(
    (await readdir(join(dir, "trace"))).map((f) =>
      readFile(join(dir, "trace", f), "utf8"),
    ),
  );
  assert.match(logs.join(""), /"name":"refused"/);
  assert.doesNotMatch(
    logs.join(""),
    /"name":"(?:added|claimed|started|delivered|closed|stopping)"/,
  );
  const pending = (await readHelpers()).rows.find((r) => !r.outcome)!;
  assert.match(
    await helperExecute(
      { action: "close", id: pending.id },
      {
        session: {
          ...ctx().session,
          auth: {
            initiator: {
              ...auth(),
              attributes: { ...auth().attributes, chat_id: "other" },
            },
            current: auth(),
          },
        },
      },
      deps,
    ),
    /another chat/,
  );
  await s.claimHelper(pending.id, { ownerStartedAt: 1 }, 2000);
  assert.match(
    await helperExecute({ action: "close", id: pending.id }, ctx(), deps),
    /частичный итог/,
  );
  const ready = (await readHelpers()).rows.find((r) => r.outcome === "done")!;
  assert.match(
    await helperExecute({ action: "close", id: ready.id }, ctx(), deps),
    /автоматический пересказ/,
  );
});

test("v7 close preserves existing stop and tells the truth; immediately requests a tick", async (t) => {
  const s = await import("./helper-store.ts");
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-close-v7-"));
  const prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const added = await s.addHelper(
    { task: "task", may: "", chat: { id: "42", threadId: null } },
    1000,
  );
  assert.ok(added.ok);
  await s.claimHelper(added.row.id, { ownerStartedAt: 1 }, 2000);
  await s.stopHelper(added.row.id, 2000, "ceiling");
  let ticks = 0;
  const reply = await helperExecute(
    { action: "close", id: added.row.id },
    ctx(),
    {
      tick: () => {
        ticks++;
        return Promise.resolve();
      },
    },
  );
  assert.match(reply, /уже останавливается/iu);
  assert.equal(ticks, 1);
  assert.equal((await s.getHelper(added.row.id))?.stop, "ceiling");
});

test("delivered close tells the model it is closed and removes the row", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-tool-delivered-"));
  const prev = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const s = await import("./helper-store.ts");
  const deps = { now: 1000, tick: () => Promise.resolve() };
  const chat = { id: "42", threadId: null };
  for (let i = 0; i < 20; i++) {
    assert.match(
      await helperExecute(
        { action: "start", task: "task", may: "" },
        ctx(),
        deps,
      ),
      /background/,
    );
    const row = (await readHelpers()).rows.find((r) => r.status === "pending")!;
    await s.finalizeHelper(
      row.id,
      { kind: "pending", createdAt: 1000 },
      {
        outcome: "done",
        summary: "result",
        reason: null,
        model: null,
        steps: 1,
        tokens: 1,
      },
      1001,
    );
    await s.markHelperDelivered(row.id, chat, 1002 + i);
  }
  const row = (await readHelpers()).rows[0];
  assert.match(
    await helperExecute(
      { action: "start", task: "next", may: "" },
      ctx(),
      deps,
    ),
    /background/,
  );
  assert.equal(await s.getHelper(row.id), null);
  const delivered = (await readHelpers()).rows.find(
    (r) => r.deliveredAt !== null,
  )!;
  assert.match(
    await helperExecute({ action: "close", id: delivered.id }, ctx(), deps),
    /закрыто/iu,
  );
  assert.equal(await s.getHelper(delivered.id), null);
  assert.equal((await readHelpers()).rows.length, 19);
});
