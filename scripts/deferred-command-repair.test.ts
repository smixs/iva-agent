import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import * as deferred from "./lib/deferred-command.ts";
const previousData = process.env.ASSISTANT_DATA_DIR;
const testData = mkdtempSync(join(tmpdir(), "iva-r327-scope-"));
process.env.ASSISTANT_DATA_DIR = testData;
after(() => {
  rmSync(testData, { recursive: true, force: true });
  if (previousData === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousData;
});
const { createCliMain } = await import("./cli/main.ts");
const pending = (d: string) => join(d, "deferred-command.json");
const active = (d: string) => join(d, "deferred-command.active.json");
const value = (f: string) =>
  JSON.parse(readFileSync(f, "utf8")) as {
    id: string;
    argv: string[];
    result?: boolean;
    pid?: number;
  };
function fx(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "iva-r327-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "bin"));
  writeFileSync(join(d, ".env"), `ASSISTANT_DATA_DIR=${d}\n`);
  writeFileSync(
    join(d, "bin/iva.mjs"),
    `import{appendFileSync,writeFileSync}from'node:fs';const d=process.env.ASSISTANT_DATA_DIR;if(process.argv[2]==='notify'){appendFileSync(d+'/reports',process.argv.slice(3).join(' '));}else{appendFileSync(d+'/calls',JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('--verbose'))process.stdout.write('x'.repeat(1200000));if(process.argv[2]==='doctor')console.log('complete diagnostic report');writeFileSync(d+'/finished','yes');}`,
  );
  return d;
}
const io = () => ({
  busy: () => false,
  launch: () => Promise.resolve({ ok: true, msg: "" }),
  report: () => Promise.resolve(),
  log: () => {},
});
function putActive(d: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    active(d),
    JSON.stringify({
      id: "0c09bc69-ff64-4f42-a1fe-925e6952b5c4",
      argv: ["restart"],
      createdAt: new Date().toISOString(),
      pid: 1073741824,
      ...extra,
    }),
  );
}

void test("R1: pending requests preserve Telegram input, Stop and steering", () => {
  const source = readFileSync(
    new URL("./poller/main.ts", import.meta.url),
    "utf8",
  );
  const from = source.indexOf("await reconcileDeferred(DATA_DIR");
  const to = source.indexOf("const pendingInboxCount", from);
  assert.ok(from >= 0);
  assert.doesNotMatch(source.slice(from, to), /continue;/);
});
void test("R2B: malformed JSON and malformed request are quarantined once and scans survive", async (t) => {
  const d = fx(t);
  for (const content of ["{", '{"id":"x","argv":[]}']) {
    writeFileSync(pending(d), content);
    await assert.doesNotReject(deferred.reconcileDeferred(d, io()));
    assert.equal(existsSync(pending(d)), false);
  }
  assert.equal(readdirSync(d).filter((x) => x.includes(".damaged-")).length, 2);
});
void test("R2C: failed report and missing notification chat leave an outcome for a later scan", async (t) => {
  const d = fx(t);
  putActive(d, { result: true });
  for (const reason of ["report failed", "owner chat is missing"])
    await assert.doesNotReject(
      deferred.reconcileDeferred(d, {
        ...io(),
        report: () => Promise.reject(Error(reason)),
      }),
    );
  assert.ok(existsSync(active(d)));
  await deferred.reconcileDeferred(d, io());
  assert.equal(existsSync(active(d)), false);
});
void test("R2C: permanent report failure quarantines one outcome after ten attempts and releases capacity", async (t) => {
  const d = fx(t);
  putActive(d, { result: true });
  const original = value(active(d));
  const logs: string[] = [];
  let attempts = 0;
  const deps = {
    ...io(),
    report: () => {
      attempts++;
      return Promise.reject(Error("403: bot was removed from the chat"));
    },
    log: (...parts: unknown[]) => {
      logs.push(parts.join(" "));
    },
  };
  for (let i = 0; i < 9; i++) {
    await assert.doesNotReject(deferred.reconcileDeferred(d, deps));
    assert.ok(existsSync(active(d)));
  }
  assert.equal(await deferred.deferCommand(d, ["reset"]), false);
  await assert.doesNotReject(deferred.reconcileDeferred(d, deps));
  assert.equal(attempts, 10);
  assert.equal(existsSync(active(d)), false);
  const quarantined = readdirSync(d).filter((name) =>
    name.includes(".damaged-"),
  );
  assert.equal(quarantined.length, 1);
  const entry = JSON.parse(readFileSync(join(d, quarantined[0]), "utf8")) as {
    record: { id: string; result: boolean; reportAttempts: number };
  };
  assert.equal(entry.record.id, original.id);
  assert.equal(entry.record.result, true);
  assert.equal(entry.record.reportAttempts, 10);
  assert.ok(
    logs.some((line) => /report failed after 10 attempts.*403/.test(line)),
  );
  assert.equal(await deferred.deferCommand(d, ["restart"]), true);
  assert.notEqual(value(pending(d)).id, original.id);
});
void test("R2E: EPERM checking a pid is logged and cannot kill the Bridge", async (t) => {
  const d = fx(t);
  putActive(d, { pid: 1 });
  const logs: unknown[] = [];
  t.mock.method(process, "kill", () => {
    throw Object.assign(Error("EPERM"), { code: "EPERM" });
  });
  await assert.doesNotReject(
    deferred.reconcileDeferred(d, {
      ...io(),
      log: (...v: unknown[]) => {
        logs.push(v);
      },
    }),
  );
  assert.ok(logs.length);
});
void test("R2F: launcher rejection and throw are logged while polling survives", async (t) => {
  for (const launch of [
    () => Promise.resolve({ ok: false, msg: "systemd-run failed" }),
    () => Promise.reject(Error("systemd-run missing")),
  ]) {
    const d = fx(t);
    await deferred.deferCommand(d, ["restart"]);
    const logs: unknown[] = [];
    await assert.doesNotReject(
      deferred.reconcileDeferred(d, {
        ...io(),
        launch,
        log: (...parts: unknown[]) => {
          logs.push(parts);
        },
      }),
    );
    assert.ok(logs.length);
    assert.ok(existsSync(active(d)));
  }
});
void test("R3A: another command is explicitly refused and cannot replace the accepted request", async (t) => {
  const d = fx(t);
  await deferred.deferCommand(d, ["reset"]);
  const first = value(pending(d));
  assert.equal(await deferred.deferCommand(d, ["restart"]), false);
  assert.deepEqual(value(pending(d)), first);
  await deferred.deferCommand(d, ["reset"]);
  assert.deepEqual(value(pending(d)), first);
});
void test("R4: model plugin lifecycle commands require the owner tap, exit one", (t) => {
  const d = fx(t);
  const url = new URL("./cli/main.ts", import.meta.url).href;
  for (const verb of [
    "trust",
    "enable",
    "update",
    "sync",
    "install-proposal",
  ]) {
    let output = "";
    try {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const{createCliMain}=await import(${JSON.stringify(url)});await createCliMain(${JSON.stringify(d)}).dispatch(['plugin',${JSON.stringify(verb)},'fixture']);`,
        ],
        {
          env: { ...process.env, IVA_AGENT_TURN: "1" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      assert.fail("plugin operation accepted");
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      assert.equal(err.status, 1);
      output = String(err.stdout) + String(err.stderr);
    }
    assert.match(output, /iva plugin propose/);
    assert.equal(existsSync(pending(d)), false);
  }
});
void test("R5: helper/goal running state holds the lifecycle request", async (t) => {
  const d = fx(t);
  const helperUrl = new URL("../agent/lib/helper-store.ts", import.meta.url)
    .href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const h=await import(${JSON.stringify(helperUrl)});
    const r=await h.addHelper({task:'working',may:'',chat:{id:'42',threadId:null}},1000);
    if(!r.ok)throw Error('fixture'); await h.claimHelper(r.row.id,{ownerStartedAt:1000},1001);
  `,
    ],
    { env: { ...process.env, ASSISTANT_DATA_DIR: d } },
  );
  await deferred.deferCommand(d, ["restart"]);
  let launches = 0;
  await deferred.reconcileDeferred(d, {
    ...io(),
    launch: () => {
      launches++;
      return Promise.resolve({ ok: true, msg: "" });
    },
  });
  assert.equal(launches, 0);
});
void test("R5: compaction transition keeps the chat busy before session.waiting", (t) => {
  const d = fx(t);
  const draftUrl = new URL("../agent/lib/telegram-draft.ts", import.meta.url)
    .href;
  const statusUrl = new URL("../agent/lib/run-status.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const status=await import(${JSON.stringify(statusUrl)});
    const draft=await import(${JSON.stringify(draftUrl)});
    status.setChatStatus('42:',{status:'running',sessionId:'s',turnId:'t'});
    await draft.finishTelegramStatus({telegram:{chatId:42}},'s','completed','t',true);
    if(status.getChatStatus('42:')?.status!=='running')throw Error('compaction gap');
  `,
    ],
    { env: { ...process.env, ASSISTANT_DATA_DIR: d } },
  );
});
void test("R6D: completed outcome wins over a recycled live foreign pid", async (t) => {
  const d = fx(t);
  putActive(d, { pid: process.pid, result: true });
  let reports = 0;
  await deferred.reconcileDeferred(d, {
    ...io(),
    report: () => {
      reports++;
      return Promise.resolve();
    },
  });
  assert.equal(reports, 1);
});
void test("R6: live foreign pid without matching start identity cannot reserve the request forever", async (t) => {
  const d = fx(t);
  putActive(d, { pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" });
  await deferred.reconcileDeferred(d, io());
  assert.equal(existsSync(active(d)), false);
});
void test("R7: doctor uses its existing read-only dependency in an agent turn", () => {
  assert.equal(deferred.deferrable(["doctor"]), false);
  const s = readFileSync(new URL("./cli/main.ts", import.meta.url), "utf8");
  assert.match(s, /readOnly:\s*process\.env\.IVA_AGENT_TURN\s*===\s*"1"/);
});
void test("R8: config is deferred before its restart side effect", async (t) => {
  const d = fx(t);
  const before = process.env.IVA_AGENT_TURN;
  process.env.IVA_AGENT_TURN = "1";
  t.after(() => {
    if (before === undefined) delete process.env.IVA_AGENT_TURN;
    else process.env.IVA_AGENT_TURN = before;
  });
  const cli = createCliMain(d);
  let calls = 0;
  (cli.commands as Record<string, () => unknown>).config = () => {
    calls++;
  };
  await cli.dispatch(["config"]);
  assert.equal(calls, 0);
  assert.deepEqual(value(pending(d)).argv, ["config"]);
});
void test("R9F: delayed runner claim is launched once across Bridge scans", async (t) => {
  const d = fx(t);
  await deferred.deferCommand(d, ["restart"]);
  let launches = 0;
  const dep = {
    ...io(),
    launch: () => {
      launches++;
      return Promise.resolve({ ok: true, msg: "" });
    },
  };
  for (let i = 0; i < 3; i++) await deferred.reconcileDeferred(d, dep);
  assert.equal(launches, 1);
});
void test("R9: verbose update output cannot kill the updater at maxBuffer", async (t) => {
  const d = fx(t);
  await deferred.deferCommand(d, ["update", "--verbose"]);
  const id = value(pending(d)).id;
  await deferred.reconcileDeferred(d, io());
  await deferred.executeDeferred(d, d, id);
  assert.equal(readFileSync(join(d, "finished"), "utf8"), "yes");
  assert.match(readFileSync(join(d, "reports"), "utf8"), /выполнено/);
});
void test("R10: instructions and command inventory match the supported paths", () => {
  const s = readFileSync(
    new URL("../agent/instructions.md", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(s, /Перезапуск, обновление/);
  assert.equal(
    Object.hasOwn(
      createCliMain("/tmp/iva-r327-inventory").commands,
      "full-reset",
    ),
    false,
  );
  assert.doesNotMatch(
    readFileSync(new URL("../docs/reminders.md", import.meta.url), "utf8"),
    /## What Iva no longer does/,
  );
});

void test("R6: process identity is stable across different Bridge and runner timezones", async (t) => {
  const d = fx(t);
  const startedAt = execFileSync(
    "/bin/ps",
    ["-o", "lstart=", "-p", String(process.pid)],
    { encoding: "utf8", env: { TZ: "UTC", LC_ALL: "C" } },
  ).trim();
  putActive(d, { pid: process.pid, startedAt });
  const before = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  t.after(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
  let reports = 0;
  await deferred.reconcileDeferred(d, {
    ...io(),
    report: () => {
      reports++;
      return Promise.resolve();
    },
  });
  assert.equal(reports, 0);
  assert.ok(existsSync(active(d)));
});

void test("R1: a stalled launcher leaves Stop, callbacks and new input available", async (t) => {
  const d = fx(t);
  await deferred.deferCommand(d, ["restart"]);
  const { scheduleBridgeTask } = await import("./poller/background.ts");
  const { processTelegramUpdate } = await import("./poller/main.ts");
  let started = () => {};
  const began = new Promise<void>((r) => {
    started = r;
  });
  let release: (value: { ok: boolean; msg: string }) => void = () => {};
  const launch = new Promise<{ ok: boolean; msg: string }>((r) => {
    release = r;
  });
  let complete = () => {};
  const completed = new Promise<void>((r) => {
    complete = r;
  });
  scheduleBridgeTask("r327-launch", async () => {
    try {
      await deferred.reconcileDeferred(d, {
        ...io(),
        launch: () => {
          started();
          return launch;
        },
      });
    } finally {
      complete();
    }
  });
  await began;
  const handled: number[] = [];
  const admitted: number[] = [];
  try {
    const message = (id: number, text: string) => ({
      message_id: id,
      date: 1,
      chat: { id: 42, type: "private" as const },
      from: { id: 42, is_bot: false, first_name: "owner" },
      text,
    });
    const updates = [
      { update_id: 101, message: message(101, "/stop") },
      {
        update_id: 102,
        callback_query: {
          id: "button",
          from: { id: 42, is_bot: false, first_name: "owner" },
          data: "button",
          message: message(102, "choice"),
        },
      },
      { update_id: 103, message: message(103, "steering input") },
    ];
    for (const update of updates) {
      const id = update.update_id;
      const result = await processTelegramUpdate(update, id, null, {
        handleControlImpl: (update) => {
          handled.push(update.update_id);
          return Promise.resolve(update.update_id !== 103);
        },
        admitImpl: (update) => {
          admitted.push(update.update_id);
          return Promise.resolve("owned");
        },
        saveOffsetImpl: () => Promise.resolve(),
        logImpl: () => {},
      });
      assert.equal(result.offset, id + 1);
    }
    assert.deepEqual(handled, [101, 102, 103]);
    assert.deepEqual(admitted, [103]);
  } finally {
    release({ ok: true, msg: "" });
    await completed;
  }
});

void test("R7: agent doctor prints its entire diagnosis and leaves repair boundaries untouched", (t) => {
  const d = fx(t),
    url = new URL("./cli/main.ts", import.meta.url).href;
  const before = readFileSync(join(d, ".env"), "utf8");
  const commands = join(d, "service-calls");
  writeFileSync(
    join(d, "bin/systemctl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commands}'\nexit 0\n`,
    { mode: 0o755 },
  );
  const script = `const {createCliMain}=await import(${JSON.stringify(url)}); await createCliMain(${JSON.stringify(d)}).dispatch(['doctor']);`;
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          IVA_AGENT_TURN: "1",
          HOME: d,
          PATH: join(d, "bin") + ":" + process.env.PATH,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    const error = e as { status?: number; stdout?: string; stderr?: string };
    assert.equal(error.status, 1);
    output = String(error.stdout) + String(error.stderr);
  }
  assert.match(output, /read-only|would/i);
  assert.match(output, /Summary:/);
  assert.equal(readFileSync(join(d, ".env"), "utf8"), before);
  assert.equal(existsSync(pending(d)), false);
  if (existsSync(commands))
    assert.doesNotMatch(
      readFileSync(commands, "utf8"),
      /restart|start |stop |enable |daemon-reload/,
    );
});

void test("R3: every accepted command remains durable until it executes", async (t) => {
  const { default: fc } = await import("fast-check");
  const seed = 3272026;
  console.error(`deferred durable acceptance property seed=${seed}`);
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom("restart", "reset", "config", "busy", "idle", "scan"),
        { minLength: 1, maxLength: 25 },
      ),
      async (events) => {
        const d = fx(t),
          expected: string[][] = [];
        let busy = true;
        const deps = {
          ...io(),
          busy: () => busy,
          launch: async (argv: readonly string[]) => {
            assert.equal(busy, false);
            await deferred.executeDeferred(d, d, argv[1]);
            return { ok: true, msg: "" };
          },
        };
        for (const event of events) {
          if (["restart", "reset", "config"].includes(event)) {
            const previous = existsSync(pending(d)) ? value(pending(d)) : null;
            const accepted = await deferred.deferCommand(d, [event]);
            if (accepted && !previous) expected.push([event]);
            if (!accepted) {
              assert.ok(previous);
              assert.deepEqual(value(pending(d)), previous);
            }
          } else if (event === "busy") busy = true;
          else if (event === "idle") busy = false;
          else await deferred.reconcileDeferred(d, deps);
        }
        busy = false;
        await deferred.reconcileDeferred(d, deps);
        const actual = existsSync(join(d, "calls"))
          ? readFileSync(join(d, "calls"), "utf8")
              .trim()
              .split("\n")
              .map((x) => JSON.parse(x) as unknown)
          : [];
        assert.deepEqual(actual, expected);
      },
    ),
    { seed, numRuns: 25 },
  );
});
