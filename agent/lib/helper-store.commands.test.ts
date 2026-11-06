/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as s from "./helper-store.ts";
type Row = {
  id: string;
  createdAt: number;
  status: s.HelperStatus;
  fired: number | null;
  session: string | null;
  stop: s.HelperStop | null;
  outcome: s.HelperOutcome | null;
  delivered: number | null;
  finished: number | null;
};
type Model = { now: number; rows: Row[] };
const chat = { id: "42", threadId: null };
const end = {
  outcome: "done" as const,
  summary: "result",
  reason: null,
  model: "fixture",
  steps: 1,
  tokens: 12,
};
const ops = [
  "add",
  "claim",
  "client-session",
  "stop",
  "finish",
  "stale-finish",
  "close",
  "show",
  "deliver",
  "sweep",
] as const;
class Command implements fc.AsyncCommand<Model, typeof s> {
  readonly op: (typeof ops)[number];
  readonly index: number;
  constructor(op: (typeof ops)[number], index: number) {
    this.op = op;
    this.index = index;
  }
  check() {
    return true;
  }
  toString() {
    return `${this.op}(${this.index})`;
  }
  async run(m: Model, r: typeof s) {
    m.now += 4000000;
    const now = m.now;
    const row = m.rows[this.index % m.rows.length];
    if (this.op === "add") {
      const a = await r.addHelper({ task: "task", may: "opaque", chat }, now);
      const oldest = m.rows
        .filter((x) => x.delivered !== null)
        .sort((a, b) => a.delivered! - b.delivered!)[0];
      const allowed =
        (m.rows.length < 20 || oldest !== undefined) &&
        m.rows.filter((x) => x.status === "pending").length < 3;
      assert.equal(a.ok, allowed);
      if (a.ok) {
        if (m.rows.length === 20)
          m.rows = m.rows.filter((x) => x.id !== oldest.id);
        m.rows.push({
          id: a.row.id,
          createdAt: now,
          status: "pending",
          fired: null,
          session: null,
          stop: null,
          outcome: null,
          delivered: null,
          finished: null,
        });
      }
    } else if (row) {
      switch (this.op) {
        case "claim": {
          const allowed =
            row.status === "pending" &&
            row.fired === null &&
            row.stop === null &&
            m.rows.filter((x) => x.fired !== null).length < 3;
          const a = await r.claimHelper(row.id, { ownerStartedAt: 10 }, now);
          assert.equal(a !== null, allowed);
          if (allowed) row.fired = now;
          break;
        }
        case "client-session": {
          const allowed = row.fired !== null && row.outcome === null;
          assert.equal(
            await r.recordHelperSession(row.id, row.fired ?? 0, "server"),
            allowed,
          );
          if (allowed) row.session = "server";
          break;
        }
        case "stop": {
          const allowed = row.fired !== null && row.outcome === null;
          const a = await r.stopHelper(row.id, row.fired ?? 0, "deadline");
          assert.equal(a !== null, allowed);
          if (allowed) row.stop ??= "deadline";
          break;
        }
        case "finish":
        case "stale-finish": {
          const allowed =
            this.op === "finish" &&
            row.status === "pending" &&
            row.outcome === null;
          const a = await r.finalizeHelper(
            row.id,
            row.fired !== null
              ? {
                  kind: "running",
                  firedAt:
                    this.op === "stale-finish" ? row.fired - 1 : row.fired,
                }
              : {
                  kind: "pending",
                  createdAt:
                    this.op === "stale-finish"
                      ? row.createdAt - 1
                      : row.createdAt,
                },
            end,
            now,
          );
          assert.equal(a !== null, allowed);
          if (allowed) {
            row.outcome =
              row.stop === "closed" ? "stopped" : (row.stop ?? "done");
            row.status = row.stop === "closed" ? "closed" : "finished";
            row.finished = now;
            row.fired = null;
            row.session = null;
          }
          break;
        }
        case "close": {
          const a = await r.closeHelper(row.id, chat, now);
          assert.equal(a.ok, true);
          if (row.delivered !== null)
            m.rows = m.rows.filter((x) => x.id !== row.id);
          else if (a.ok) {
            if (row.fired !== null) row.stop ??= "closed";
            else {
              row.status = "closed";
              if (row.outcome === null) {
                row.outcome = "stopped";
                row.stop = "closed";
                row.finished = now;
              }
            }
          }
          break;
        }
        case "show": {
          const allowed = row.outcome !== null || row.stop === "closed";
          const a = await r.showHelper(row.id, chat);
          assert.equal(a.ok, allowed);
          break;
        }
        case "deliver": {
          const allowed = row.status === "finished" && row.delivered === null;
          const a = await r.markHelperDelivered(row.id, chat, now);
          assert.equal(a !== null, allowed);
          if (allowed) row.delivered = now;
          break;
        }
        case "sweep": {
          const removed = await r.sweepHelpers(now);
          const expected = m.rows
            .filter(
              (x) =>
                (x.status === "closed" &&
                  x.finished !== null &&
                  x.finished + 86400000 <= now) ||
                (x.delivered !== null && x.delivered + 86400000 <= now),
            )
            .map((x) => x.id);
          assert.deepEqual(removed, expected);
          m.rows = m.rows.filter((x) => !expected.includes(x.id));
          break;
        }
      }
    }
    const actual = await r.readHelpers();
    assert.equal(actual.rows.length, m.rows.length);
    for (const x of m.rows) {
      const a = actual.rows.find((a) => a.id === x.id)!;
      assert.equal(a.status, x.status);
      assert.equal(a.run?.firedAt ?? null, x.fired);
      assert.equal(a.run?.sessionId ?? null, x.session);
      assert.equal(a.stop, x.stop);
      assert.equal(a.outcome, x.outcome);
      assert.equal(a.may, "opaque");
      assert.equal(a.finishedAt, x.finished);
      assert.equal(a.deliveredAt, x.delivered);
    }
  }
}
test("fc.commands: lifecycle, client T3, stale CAS, close, pure reads, delivery and sweep; seed 20261013", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-commands-"));
  const prior = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prior;
    await rm(dir, { force: true, recursive: true });
  });
  const commands = fc.commands(
    [
      fc
        .tuple(fc.constantFrom(...ops), fc.nat(5))
        .map(([op, index]) => new Command(op, index)),
    ],
    { maxCommands: 35 },
  );
  await fc.assert(
    fc.asyncProperty(commands, async (cs) => {
      await rm(join(dir, "helpers"), { recursive: true, force: true });
      await rm(join(dir, "helpers.json"), { force: true });
      await fc.asyncModelRun(
        () => ({ model: { now: 1000, rows: [] }, real: s }),
        cs,
      );
    }),
    { seed: 20261013, numRuns: 60 },
  );
});
