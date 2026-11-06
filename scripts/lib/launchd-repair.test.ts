import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseLaunchctlPrint, runLaunchd } from "./launchd.ts";
import { unitToPlist, writeLaunchdUnits } from "./launchd-plist.ts";
import { logTail } from "./systemd-control.ts";

const calendar = readFileSync(
  new URL("../fixtures/launchctl-print-calendar.txt", import.meta.url),
  "utf8",
);
const disabledOutput = readFileSync(
  new URL("../fixtures/launchctl-disabled.txt", import.meta.url),
  "utf8",
);
const observed = JSON.parse(
  readFileSync(
    new URL("../fixtures/launchctl-bootout.json", import.meta.url),
    "utf8",
  ),
) as { states: { code: number; state: string | null }[] };
const print = (state = "running", pid: number | null = 123) =>
  `gui/501/app.iva.iva = {\n\tstate = ${state}\n${pid === null ? "" : `\tpid = ${pid}\n`}\tlast exit code = 0\n}\n`;
const ok = { code: 0, out: "" };
function dir(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "iva-launchd-repair-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
function control(t: TestContext, keepAlive = true) {
  const unitDir = dir(t);
  writeFileSync(
    join(unitDir, "app.iva.iva.plist"),
    `<key>ExitTimeOut</key><integer>25</integer>${keepAlive ? "<key>KeepAlive</key><true/>" : ""}`,
  );
  return unitDir;
}

void test("repair 1: real calendar print parses event triggers and ignores nested state", () => {
  const state = parseLaunchctlPrint(calendar);
  assert.equal(state.valid, true);
  assert.equal(state.state, "running");
  assert.ok(state.pid);
});
void test("repair 2: print-disabled uses observed enabled and disabled words", (t) => {
  const unitDir = control(t);
  for (const word of ["enabled", "disabled"]) {
    const r = runLaunchd(["is-enabled", "iva.service"], {
      uid: 501,
      unitDir,
      run: (a) =>
        a[0] === "print-disabled"
          ? {
              code: 0,
              out: disabledOutput
                .replaceAll("app.iva-probe.repair-calendar", "app.iva.iva")
                .replace("=> disabled", `=> ${word}`),
            }
          : ok,
    });
    assert.deepEqual(r, { code: word === "enabled" ? 0 : 1, out: word });
  }
});
for (const action of ["stop", "restart", "disable"] as const)
  void test(`repair 3: ${action} waits for observed asynchronous bootout before success or bootstrap`, (t) => {
    const unitDir = control(t);
    let pending = false;
    let loaded = true;
    let at = 0;
    let disabled = false;
    const run = (a: readonly string[]) => {
      if (a[0] === "print" && a[1] === "gui/501") return ok;
      if (a[0] === "print-disabled")
        return {
          code: 0,
          out: `disabled services = {\n\t"app.iva.iva" => ${disabled ? "disabled" : "enabled"}\n}`,
        };
      if (a[0] === "disable") {
        disabled = true;
        return ok;
      }
      if (a[0] === "bootout") {
        pending = true;
        return ok;
      }
      if (a[0] === "bootstrap") {
        assert.equal(loaded, false, "bootstrap raced bootout");
        loaded = true;
        return ok;
      }
      if (pending) {
        const s = observed.states[at++];
        if (s.code === 113) {
          pending = false;
          loaded = false;
          return { code: 113, out: "" };
        }
        return { code: 0, out: print(s.state!) };
      }
      return loaded ? { code: 0, out: print() } : { code: 113, out: "" };
    };
    const r = runLaunchd(
      [action, ...(action === "disable" ? ["--now"] : []), "iva.service"],
      { unitDir, uid: 501, run, waitMs: 5000 },
    );
    assert.equal(r.code, 0, r.out);
    assert.equal(pending, false, "verb returned during SIGTERMed");
    assert.equal(loaded, action === "restart");
  });
void test("repair 3: oneshot stop waits for pid disappearance and retains its calendar", (t) => {
  const unitDir = control(t, false);
  let stopping = false;
  let polls = 0;
  const run = (a: readonly string[]) => {
    if (a[0] === "print" && a[1] === "gui/501") return ok;
    if (a[0] === "kill") {
      stopping = true;
      return ok;
    }
    assert.notEqual(a[0], "bootout");
    if (stopping) polls++;
    return {
      code: 0,
      out: print("running", stopping && polls >= 3 ? null : 123),
    };
  };
  const r = runLaunchd(["stop", "iva.service"], {
    unitDir,
    uid: 501,
    run,
    waitMs: 1000,
  });
  assert.equal(r.code, 0, r.out);
  assert.ok(polls >= 3);
});
void test("repair 3/16: genuine bootout refusal is reported even if print says unloaded", (t) => {
  const unitDir = control(t);
  const r = runLaunchd(["stop", "iva.service"], {
    unitDir,
    uid: 501,
    waitMs: 0,
    run: (a) =>
      a[0] === "bootout"
        ? { code: 9, out: "permission refused" }
        : a[1] === "gui/501"
          ? ok
          : { code: 113, out: "" },
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /bootout.*permission refused/);
});
void test("repair 3: stop reports timeout while a job remains SIGTERMed", (t) => {
  const unitDir = control(t);
  const r = runLaunchd(["stop", "iva.service"], {
    unitDir,
    uid: 501,
    waitMs: 0,
    run: (a) =>
      a[0] === "print" && a[1] !== "gui/501"
        ? { code: 0, out: print("SIGTERMed") }
        : ok,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /stop|bootout/);
});
void test("repair 3: bootstrap code 5 during SIGTERMed is a failure", (t) => {
  const unitDir = control(t, false);
  let prints = 0;
  const r = runLaunchd(["start", "iva.service"], {
    unitDir,
    uid: 501,
    waitMs: 0,
    run: (a) => {
      if (a[0] === "print" && a[1] !== "gui/501")
        return ++prints === 1
          ? { code: 113, out: "" }
          : { code: 0, out: print("SIGTERMed") };
      return a[0] === "bootstrap" ? { code: 5, out: "I/O error" } : ok;
    },
  });
  assert.equal(r.code, 1, r.out);
});
void test("repair 10: a briefly running launcher that crashes cannot satisfy restart", (t) => {
  const unitDir = control(t);
  let loaded = false;
  let prints = 0;
  const r = runLaunchd(["restart", "iva.service"], {
    unitDir,
    uid: 501,
    waitMs: 1200,
    run: (a) => {
      if (a[0] === "print" && a[1] === "gui/501") return ok;
      if (a[0] === "bootout") {
        loaded = false;
        return ok;
      }
      if (a[0] === "bootstrap") {
        loaded = true;
        return ok;
      }
      return !loaded
        ? { code: 113, out: "" }
        : { code: 0, out: ++prints === 1 ? print() : print("waiting", null) };
    },
  });
  assert.equal(r.code, 1, r.out);
});
void test("repair 10: running must keep the same pid for at least a second", (t) => {
  const unitDir = control(t);
  let boot = false;
  const started = Date.now();
  const r = runLaunchd(["start", "iva.service"], {
    unitDir,
    uid: 501,
    waitMs: 2000,
    run: (a) => {
      if (a[0] === "bootstrap") {
        boot = true;
        return ok;
      }
      if (a[0] === "print" && a[1] !== "gui/501")
        return boot ? { code: 0, out: print() } : { code: 113, out: "" };
      return ok;
    },
  });
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started >= 1000);
});
void test(
  "repair 5/7/9: plist shutdown budget, HOME and Homebrew node paths survive upgrades",
  { skip: process.platform !== "darwin" },
  () => {
    const xml = unitToPlist(
      {
        unit: "iva.service",
        body: "ExecStart=/opt/homebrew/Cellar/node@24/24.21.0/bin/node /fixture/main.ts\nRestart=always\n",
      },
      undefined,
      {
        root: "/fixture/current",
        home: "/fixture/isolated",
        node: "/opt/homebrew/Cellar/node@24/24.21.0/bin/node",
      },
    );
    const p = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      { input: xml, encoding: "utf8" },
    );
    assert.equal(p.status, 0, p.stderr);
    const value = JSON.parse(p.stdout) as {
      EnvironmentVariables: Record<string, string>;
      ExitTimeOut: number;
      ProgramArguments: string[];
    };
    assert.equal(value.EnvironmentVariables.HOME, "/fixture/isolated");
    assert.ok(value.ExitTimeOut > 20);
    assert.equal(
      value.ProgramArguments[0],
      "/opt/homebrew/opt/node@24/bin/node",
    );
    assert.equal(
      value.ProgramArguments.at(-2),
      "/opt/homebrew/opt/node@24/bin/node",
    );
  },
);
void test("repair 6: writing a plist disables implicit login startup and preserves explicit enable", (t) => {
  const home = dir(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "calls");
  writeFileSync(
    join(bin, "launchctl"),
    `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1" = print-disabled ]; then printf 'disabled services = {\\n\\t"app.iva.iva" => enabled\\n}\\n'; fi\n`,
    { mode: 0o755 },
  );
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    writeLaunchdUnits(
      [
        { unit: "iva.service", body: "ExecStart=/bin/true\nRestart=always\n" },
        {
          unit: "iva-userbot.service",
          body: "ExecStart=/bin/true\nRestart=always\n",
        },
      ],
      join(home, "Library/LaunchAgents"),
      { root: home, home },
    );
  } finally {
    process.env.PATH = prior;
  }
  const log = readFileSync(calls, "utf8");
  assert.match(log, /disable gui\/\d+\/app\.iva\.iva-userbot/);
  assert.doesNotMatch(log, /disable gui\/\d+\/app\.iva\.iva(?:\n|$)/);
});
void test(
  "repair 12: logTail reads a bounded suffix of a sparse log",
  { skip: process.platform !== "darwin" },
  (t) => {
    const home = dir(t);
    const priorHome = process.env.HOME;
    const priorPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = "/usr/bin:/bin";
    const folder = join(home, "Library/Logs/Iva");
    mkdirSync(folder, { recursive: true });
    const f = openSync(join(folder, "iva.out.log"), "w");
    writeSync(f, Buffer.from("old\n"), 0, 4, 0);
    writeSync(f, Buffer.from("\nlast line\n"), 0, 11, 600 * 1024 * 1024);
    closeSync(f);
    try {
      assert.equal(logTail("iva.service", 1), "last line");
    } finally {
      process.env.HOME = priorHome;
      process.env.PATH = priorPath;
    }
  },
);
void test("repair 6: plist writing reports override and disable failures", (t) => {
  const home = dir(t);
  const unitDir = join(home, "LaunchAgents");
  const units = [
    { unit: "iva-userbot.service", body: "ExecStart=/bin/true\n" },
  ];
  for (const result of [
    { code: 9, out: "permission refused" },
    { code: 0, out: "corrupt" },
  ])
    assert.throws(
      () =>
        writeLaunchdUnits(units, unitDir, {
          root: home,
          home,
          control: () => result,
        }),
      /print-disabled.*failed/,
    );
  assert.throws(
    () =>
      writeLaunchdUnits(units, unitDir, {
        root: home,
        home,
        control: (args) =>
          args[0] === "print-disabled"
            ? { code: 0, out: "disabled services = {\n}\n" }
            : { code: 9, out: "permission refused" },
      }),
    /disable.*permission refused/,
  );
});
