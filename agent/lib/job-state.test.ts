// Соответствие specs/JobRun.tla: имя теста называет инвариант модели. Допуск раннера читает
// бронь через jobState; дифференциальная проба держит прежнее условие допуска дословно.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";
import { readFacts } from "./job-facts.ts";
import {
  JOB_STATES,
  jobReservation,
  jobState,
  OWNER_STARTED_AT,
} from "./job-state.ts";
import { runScheduledJob } from "./schedule-runner.ts";

const SEED = 20_261_110;

// Условие «уже идёт» из admitUnderLock до v5 (schedule-runner.ts), с pid через заглушку.
function legacyBlocks(
  prior: Record<string, unknown> | undefined,
  now: number,
  deadline: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  const ownerDead = () => {
    const ownerPid = prior?.ownerPid;
    if (
      !Number.isSafeInteger(ownerPid) ||
      (ownerPid as number) <= 0 ||
      typeof prior?.ownerStartedAt !== "number"
    )
      return false;
    return !pidAlive(ownerPid as number);
  };
  return (
    typeof prior?.inProgressSince === "number" &&
    now - prior.inProgressSince < deadline &&
    !ownerDead()
  );
}

const field = fc.oneof(
  fc.integer({ min: -5, max: 2_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constant(Number.MAX_SAFE_INTEGER + 2),
  fc.string({ maxLength: 3 }),
  fc.constant(null),
  fc.boolean(),
);
const entry = fc.option(
  fc.record(
    {
      inProgressSince: field,
      ownerPid: field,
      ownerStartedAt: field,
      lastSuccessAt: field,
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

void test(`JobRun OneLive and DeadFreed: jobState admits exactly what the runner admitted before (fast-check seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      entry,
      fc.integer({ min: 0, max: 3_000 }),
      fc.oneof(fc.integer({ min: 1, max: 2_000 }), fc.constant(Infinity)),
      fc.func(fc.boolean()),
      (prior, now, deadline, alive) => {
        const pidAlive = (pid: number) => alive(pid);
        const job = jobState("memory-night", {
          entry: prior,
          now,
          deadlineMs: deadline,
          ownerDead: (reservation) => !pidAlive(reservation.ownerPid),
        });
        assert.ok(JOB_STATES.includes(job.state));
        assert.equal(
          job.state === "running",
          legacyBlocks(prior, now, deadline, pidAlive),
        );
        assert.equal(
          job.reservation.kind === "none",
          typeof prior?.inProgressSince !== "number",
        );
      },
    ),
    { seed: SEED, numRuns: 2_000 },
  );
});

void test("JobRun states: free, running, expired and owner-dead read from one record", () => {
  const owned = { inProgressSince: 100, ownerPid: 7, ownerStartedAt: 1 };
  const alive = () => false;
  const dead = () => true;
  assert.equal(jobState("x", { entry: { lastSuccessAt: 5 } }).state, "free");
  assert.equal(
    jobState("x", { entry: owned, now: 150, deadlineMs: 100, ownerDead: alive })
      .state,
    "running",
  );
  assert.equal(
    jobState("x", { entry: owned, now: 200, deadlineMs: 100, ownerDead: alive })
      .state,
    "expired",
  );
  assert.equal(
    jobState("x", { entry: owned, now: 150, deadlineMs: 100, ownerDead: dead })
      .state,
    "owner-dead",
  );
  assert.deepEqual(jobReservation({ inProgressSince: 3 }), {
    kind: "unowned",
    since: 3,
  });
  assert.equal(
    jobState("x", { entry: { inProgressSince: 3 }, now: 4, ownerDead: dead })
      .state,
    "running",
    "a reservation without an owner holds until its deadline",
  );
});

async function scaffold() {
  const root = tempDir("iva-job-state-");
  await mkdir(join(root, "data"), { recursive: true });
  return {
    root,
    statusPath: join(root, "data/rollup-status.json"),
    factsPath: join(root, "data/jobs.json"),
  };
}

void test("JobRun NoForeignClear: completion leaves a reservation that changed owner during the run", async () => {
  const { root, statusPath, factsPath } = await scaffold();
  const foreign = {
    inProgressSince: Date.now(),
    ownerPid: process.ppid,
    ownerStartedAt: 1,
  };
  await writeFile(
    join(root, "steal.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(statusPath)}, ${JSON.stringify(JSON.stringify({ "memory-night": foreign }))});`,
      "process.exit(0);",
    ].join("\n"),
  );
  const lines: string[] = [];
  const result = await runScheduledJob({
    name: "memory-night",
    argv: ["steal.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wake: false,
    log: (...args: unknown[]) => lines.push(args.join(" ")),
  });
  assert.equal(result.skipped, false);
  const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(
    jobReservation(status["memory-night"]),
    {
      kind: "owned",
      since: foreign.inProgressSince,
      ownerPid: foreign.ownerPid,
      ownerStartedAt: foreign.ownerStartedAt,
    },
    "another run's reservation must survive this run's completion and cleanup",
  );
  assert.ok(lines.some((line) => /changed owner/u.test(line)));
});

void test("JobRun FactKept: a completed run leaves its fact, a failed fact write rejects the run", async () => {
  const { root, statusPath, factsPath } = await scaffold();
  await writeFile(join(root, "fail.ts"), "process.exit(3);\n");
  const result = await runScheduledJob({
    name: "memory-night",
    argv: ["fail.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    factsPath,
    wake: false,
    log: () => {},
  });
  assert.equal(result.ok, false);
  const facts = await readFacts(factsPath);
  const job = jobState("memory-night", {
    entry: (
      JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>
    )["memory-night"],
    facts,
  });
  assert.equal(job.state, "free");
  assert.equal(job.last?.ok, false);
  assert.equal(job.last?.exitCode, 3);

  await mkdir(join(root, "data/facts-dir.json"), { recursive: true });
  await assert.rejects(
    runScheduledJob({
      name: "proactive",
      argv: ["fail.ts"],
      root,
      nodeBin: process.execPath,
      statusPath,
      factsPath: join(root, "data/facts-dir.json"),
      wake: false,
      log: () => {},
    }),
  );
});

void test("JobRun OneLive: a reservation of this very process blocks a second admission", async () => {
  const { root, statusPath } = await scaffold();
  await writeFile(join(root, "ok.ts"), "process.exit(0);\n");
  await writeFile(
    statusPath,
    JSON.stringify({
      "memory-night": {
        inProgressSince: Date.now(),
        ownerPid: process.pid,
        ownerStartedAt: OWNER_STARTED_AT,
      },
    }),
  );
  const result = await runScheduledJob({
    name: "memory-night",
    argv: ["ok.ts"],
    root,
    nodeBin: process.execPath,
    statusPath,
    timeoutMs: null,
    log: () => {},
  });
  assert.equal(result.skipped, true);
});
