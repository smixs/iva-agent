import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import bash from "../agent/tools/bash.ts";
const previousData = process.env.ASSISTANT_DATA_DIR;
const testData = mkdtempSync(join(tmpdir(), "iva-deferred-scope-"));
process.env.ASSISTANT_DATA_DIR = testData;
after(() => {
  rmSync(testData, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousData;
});
const { createCliMain } = await import("./cli/main.ts");

void test("bash writes owner timers and marks commands as an agent turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-deferred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await bash.execute(
    {
      command: `mkdir -p '${dir}/.config/systemd/user'; printf '%s' "$IVA_AGENT_TURN" > '${dir}/.config/systemd/user/own.timer'`,
    },
    {} as Parameters<typeof bash.execute>[1],
  );
  assert.ok("exitCode" in result);
  assert.equal(result.exitCode, 0);
  assert.equal(
    readFileSync(join(dir, ".config/systemd/user/own.timer"), "utf8"),
    "1",
  );
});

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fc from "fast-check";
import {
  deferCommand,
  deferrable,
  executeDeferred as executeClaimed,
  reconcileDeferred,
} from "./lib/deferred-command.ts";

async function executeDeferred(dir: string, root: string, id: string) {
  await reconcileDeferred(dir, {
    busy: () => false,
    launch: () => Promise.resolve({ ok: true, msg: "reserved" }),
    report: () => Promise.resolve(),
  });
  return executeClaimed(dir, root, id);
}

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iva-deferred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, ".env"), `ASSISTANT_DATA_DIR=${dir}\n`);
  writeFileSync(
    join(dir, "bin/iva.mjs"),
    `import {appendFileSync} from 'node:fs'; if(process.argv[2]==='notify'){if(!process.env.NOTIFY_OK)process.exitCode=1;else appendFileSync(process.env.ASSISTANT_DATA_DIR+'/reports',process.argv[3]);}else {appendFileSync(process.env.ASSISTANT_DATA_DIR+'/calls', JSON.stringify(process.argv.slice(2))+'\\n'); if(process.argv.includes('--fail')) process.exitCode=1;}`,
  );
  return dir;
}
const pending = (dir: string) => join(dir, "deferred-command.json");
const markRunnerExited = (dir: string) => {
  const f = active(dir);
  const state = JSON.parse(readFileSync(f, "utf8")) as { pid: number };
  writeFileSync(f, JSON.stringify({ ...state, pid: 1073741824 }));
};
const active = (dir: string) => join(dir, "deferred-command.active.json");
const activeState = (dir: string) =>
  JSON.parse(readFileSync(active(dir), "utf8")) as {
    pid: number;
    result?: boolean;
  };
const request = (dir: string) =>
  JSON.parse(readFileSync(pending(dir), "utf8")) as {
    id: string;
    argv: string[];
    createdAt: string;
  };

void test("agent CLI persists every disruptive verb without touching services", async (t) => {
  const dir = fixture(t);
  const before = process.env.IVA_AGENT_TURN;
  const dataBefore = process.env.ASSISTANT_DATA_DIR;
  process.env.IVA_AGENT_TURN = "1";
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.IVA_AGENT_TURN;
    else process.env.IVA_AGENT_TURN = before;
    if (dataBefore === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = dataBefore;
  });
  const cli = createCliMain(dir);
  for (const argv of [
    ...["restart", "stop", "update", "rollback", "reset", "config"].map((x) => [
      x,
    ]),
  ]) {
    await cli.dispatch(argv);
    assert.deepEqual(request(dir).argv, argv);
    assert.ok(Date.parse(request(dir).createdAt));
    assert.equal(statSync(pending(dir)).mode & 0o777, 0o600);
    assert.equal(existsSync(join(dir, "calls")), false);
    rmSync(pending(dir));
  }
});

void test("terminal dispatch and help keep the ordinary CLI path", async (t) => {
  const dir = fixture(t);
  const cli = createCliMain(dir);
  let calls = 0;
  // The composed command is the same function terminal dispatch selects.
  (
    cli.commands as Record<string, (args: readonly string[]) => unknown>
  ).restart = () => {
    calls++;
  };
  await cli.dispatch(["restart"]);
  assert.equal(calls, 1);
  assert.equal(existsSync(pending(dir)), false);
  assert.equal(deferrable(["restart", "--help"]), false);
});

void test("idle gate, repeated requests, concurrent launches and Bridge restart preserve one execution", async (t) => {
  const dir = fixture(t);
  await deferCommand(dir, ["restart", "space value", "$(touch untouched)"]);
  await deferCommand(dir, ["restart", "space value", "$(touch untouched)"]);
  let busy = true;
  let launches = 0;
  const reports: string[] = [];
  const io = {
    busy: () => busy,
    launch: async (argv: readonly string[]) => {
      launches++;
      await Promise.all([
        executeDeferred(dir, dir, argv[1]),
        executeDeferred(dir, dir, argv[1]),
      ]);
      markRunnerExited(dir);
      return { ok: true, msg: "" };
    },
    report: (text: string) => {
      reports.push(text);
      return Promise.resolve();
    },
  };
  assert.equal(await reconcileDeferred(dir, io), true);
  assert.equal(launches, 0);
  // A fresh Bridge uses only disk state, including messages queued during this turn.
  busy = false;
  await reconcileDeferred(dir, { ...io });
  await reconcileDeferred(dir, { ...io });
  await reconcileDeferred(dir, { ...io });
  assert.equal(launches, 1);
  assert.deepEqual(
    readFileSync(join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x) as unknown),
    [["restart", "space value", "$(touch untouched)"]],
  );
  assert.deepEqual(reports, [
    "restart space value $(touch untouched): выполнено.",
  ]);
  assert.equal(existsSync(pending(dir)), false);
  assert.equal(existsSync(active(dir)), false);
});

void test("detached runner survives an actual Bridge process exit before executing", async (t) => {
  const dir = fixture(t);
  await deferCommand(dir, ["restart"]);
  const id = request(dir).id;
  await reconcileDeferred(dir, {
    busy: () => false,
    launch: () => Promise.resolve({ ok: true, msg: "reserved" }),
    report: () => Promise.resolve(),
  });
  const moduleUrl = new URL("./lib/deferred-command.ts", import.meta.url).href;
  const bridge = `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(`await new Promise(r=>setTimeout(r,100)); const {executeDeferred}=await import(${JSON.stringify(moduleUrl)}); await executeDeferred(${JSON.stringify(dir)},${JSON.stringify(dir)},${JSON.stringify(id)});`)}],{detached:true,stdio:'ignore'}); child.unref();`;
  execFileSync(process.execPath, ["--input-type=module", "-e", bridge]);
  for (
    let i = 0;
    i < 200 &&
    (!existsSync(active(dir)) || activeState(dir).result === undefined);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(activeState(dir).result, true);
  const reports: string[] = [];
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(activeState(dir).pid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await reconcileDeferred(dir, {
    busy: () => false,
    launch: () => Promise.reject(new Error("already launched")),
    report: (text: string) => {
      reports.push(text);
      return Promise.resolve();
    },
  });
  assert.equal(reports.length, 1);
  assert.equal(readFileSync(join(dir, "calls"), "utf8").trim(), '["restart"]');
});

void test("failed and interrupted executors are reported once without replay", async (t) => {
  const dir = fixture(t);
  await deferCommand(dir, ["update", "--fail"]);
  await executeDeferred(dir, dir, request(dir).id);
  markRunnerExited(dir);
  const reports: string[] = [];
  const io = {
    busy: () => false,
    launch: () => Promise.reject(new Error("claimed request")),
    report: (text: string) => {
      reports.push(text);
      return Promise.resolve();
    },
  };
  await reconcileDeferred(dir, io);
  assert.match(reports[0], /ошибка выполнения/);
  writeFileSync(
    active(dir),
    JSON.stringify({
      id: "0c09bc69-ff64-4f42-a1fe-925e6952b5c4",
      argv: ["restart"],
      createdAt: new Date().toISOString(),
      pid: 1073741824,
    }),
  );
  await reconcileDeferred(dir, io);
  await reconcileDeferred(dir, io);
  assert.equal(reports.length, 2);
  assert.match(reports[1], /исполнение не подтверждено/);
});

void test("command selection preserves arbitrary argument tails and excludes read commands", () => {
  const seed = 20261019;
  console.error(`deferred command property seed=${seed}`);
  fc.assert(
    fc.property(
      fc.array(fc.string().filter((x) => x !== "--help" && x !== "-h")),
      (tail) => {
        assert.equal(deferrable(["restart", ...tail]), true);
        assert.equal(deferrable(["plugin", "trust", ...tail]), false);
        for (const verb of ["version", "status", "trace", "post"])
          assert.equal(deferrable([verb, ...tail]), false);
      },
    ),
    { seed, numRuns: 100 },
  );
});

void test("restart requested through bash lets the reply finish before service execution", async (t) => {
  const dir = fixture(t);
  const cliUrl = new URL("./cli/main.ts", import.meta.url).href;
  const expression = `const {createCliMain}=await import(${JSON.stringify(cliUrl)}); await createCliMain(${JSON.stringify(dir)}).dispatch(['restart']);`;
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const output = await bash.execute(
    {
      command: `${quote(process.execPath)} --input-type=module -e ${quote(expression)} && printf 'reply finished'`,
    },
    {} as Parameters<typeof bash.execute>[1],
  );
  assert.ok("exitCode" in output);
  assert.equal(output.exitCode, 0);
  assert.match(
    output.stdout,
    /restart выполнится сразу после конца этого хода\nreply finished/,
  );
  assert.equal(existsSync(join(dir, "calls")), false);
  await executeDeferred(dir, dir, request(dir).id);
  assert.equal(readFileSync(join(dir, "calls"), "utf8").trim(), '["restart"]');
});

void test("stop reports through the ordinary notify command while the Bridge is down", async (t) => {
  const dir = fixture(t);
  const before = process.env.NOTIFY_OK;
  process.env.NOTIFY_OK = "1";
  t.after(() => {
    if (before === undefined) delete process.env.NOTIFY_OK;
    else process.env.NOTIFY_OK = before;
  });
  await deferCommand(dir, ["stop"]);
  await executeDeferred(dir, dir, request(dir).id);
  assert.equal(readFileSync(join(dir, "calls"), "utf8").trim(), '["stop"]');
  assert.equal(readFileSync(join(dir, "reports"), "utf8"), "stop: выполнено.");
  assert.equal(existsSync(active(dir)), false);
});

void test("persistent requests obey the idle and at-most-once invariants across Bridge scans", async () => {
  const seed = 681910;
  console.error(`deferred state property seed=${seed}`);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("request", "busy", "idle", "scan"), {
        minLength: 1,
        maxLength: 20,
      }),
      async (events) => {
        const dir = mkdtempSync(join(tmpdir(), "iva-deferred-state-"));
        mkdirSync(join(dir, "bin"));
        writeFileSync(
          join(dir, "bin/iva.mjs"),
          "if(process.argv[2]==='notify')process.exitCode=1;",
        );
        let busy = true;
        const executed = new Set<string>();
        const io = {
          busy: () => busy,
          report: async () => {},
          launch: async (argv: readonly string[]) => {
            assert.equal(busy, false);
            assert.equal(executed.has(argv[1]), false);
            executed.add(argv[1]);
            await executeDeferred(dir, dir, argv[1]);
            markRunnerExited(dir);
            return { ok: true, msg: "" };
          },
        };
        try {
          for (const event of events) {
            if (event === "request") await deferCommand(dir, ["restart"]);
            else if (event === "busy") busy = true;
            else if (event === "idle") busy = false;
            else await reconcileDeferred(dir, { ...io });
          }
          busy = false;
          await reconcileDeferred(dir, { ...io });
          await reconcileDeferred(dir, { ...io });
          await reconcileDeferred(dir, { ...io });
          assert.equal(existsSync(pending(dir)), false);
          assert.equal(existsSync(active(dir)), false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    { seed, numRuns: 20 },
  );
});
