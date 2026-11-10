import "../fixtures/systemd-env.ts";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVersionStore } from "../lib/version-store.ts";
import { customOverlay } from "../lib/version-update.ts";
import { createCliRuntime } from "./runtime.ts";
import { createServiceCommands } from "./services.ts";
import type { createCliSystemd } from "./systemd.ts";

type Runtime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = Pick<
  ReturnType<typeof createCliSystemd>,
  "activateUnits" | "restartServices"
>;
type Dependencies = NonNullable<Parameters<typeof createServiceCommands>[2]>;

type RuntimeOptions = {
  readonly root?: string;
  readonly dataDir?: string;
  readonly unitDir?: string;
  readonly requireSystemd?: () => void;
  readonly runStatus?: number;
  readonly stop?: (units: readonly string[]) => void;
};

class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function runtimeFixture(
  events: string[],
  {
    root = "/srv/iva",
    dataDir = "/srv/iva/data",
    // Never the real ~/.config/systemd/user: on a machine that still carries a pre-rename
    // nightly timer these tests would otherwise read the developer's own install.
    unitDir = "/nonexistent/systemd/user",
    requireSystemd = () => events.push("runtime.requireSystemd"),
    runStatus = 0,
    stop = (units) => events.push(`systemd.stop:${units.join(",")}`),
  }: RuntimeOptions = {},
): Runtime {
  const base = createCliRuntime(root);
  const run: Runtime["run"] = (command, args) => {
    events.push(`runtime.run:${command}:${args.join("|")}`);
    return { status: runStatus } as ReturnType<Runtime["run"]>;
  };
  return {
    ...base,
    UNIT_DIR: unitDir,
    ok: (message) => events.push(`runtime.ok:${message}`),
    warn: (message) => events.push(`runtime.warn:${message}`),
    bad: (message) => events.push(`runtime.bad:${message}`),
    step: (message) => events.push(`runtime.step:${message}`),
    run,
    systemd: {
      ...base.systemd,
      stop,
    },
    dataDirAbs: () => {
      events.push("runtime.dataDirAbs");
      return dataDir;
    },
    requireSystemd,
  };
}

function lifecycleFixture(
  events: string[],
  {
    activateUnits = () => events.push("lifecycle.activateUnits"),
    restartServices = () => events.push("lifecycle.restartServices"),
  }: Partial<SystemdLifecycle> = {},
): SystemdLifecycle {
  return { activateUnits, restartServices };
}

function dependencyFixture(
  events: string[],
  overrides: Partial<Dependencies> = {},
): Dependencies {
  return {
    now: () => {
      events.push("dependencies.now");
      return new Date("2026-08-06T12:34:56.789Z");
    },
    resetStateTargets: (root, dataDir) => {
      events.push(`dependencies.resetStateTargets:${root}:${dataDir}`);
      return [];
    },
    quarantinePath: (path, stamp) => {
      events.push(`dependencies.quarantinePath:${path}:${stamp}`);
      return null;
    },
    exit: (code): never => {
      events.push(`dependencies.exit:${code}`);
      throw new ExitSignal(code);
    },
    ...overrides,
  };
}

void test("factory evaluation is side-effect free", () => {
  const events: string[] = [];

  createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events),
    dependencyFixture(events),
  );

  assert.deepEqual(events, []);
});

void test("status preserves command order and ignores non-zero command results", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events, { runStatus: 7 }),
    lifecycleFixture(events),
  );

  commands.cmdStatus();

  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "runtime.run:systemctl:--user|status|--no-pager|-n|5|iva.service|iva-telegram-poll.service",
    "runtime.run:systemctl:--user|list-timers|--no-pager|iva-brain.timer|iva-update-check.timer",
  ]);
});

// UpdateFloor.NoSilentLoss: a unit of a release below the floor is not this CLI's to list.
void test("NoSilentLoss: status names only the timers this release installs and leaves an older one as it was", () => {
  const unitDir = mkdtempSync(join(tmpdir(), "iva-services-units-"));
  writeFileSync(join(unitDir, "iva-memory-doctor.timer"), "[Timer]\n");
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events, { unitDir }),
    lifecycleFixture(events),
  );

  try {
    commands.cmdStatus();
    assert.equal(
      readFileSync(join(unitDir, "iva-memory-doctor.timer"), "utf8"),
      "[Timer]\n",
    );
  } finally {
    rmSync(unitDir, { recursive: true, force: true });
  }

  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "runtime.run:systemctl:--user|status|--no-pager|-n|5|iva.service|iva-telegram-poll.service",
    "runtime.run:systemctl:--user|list-timers|--no-pager|iva-brain.timer|iva-update-check.timer",
  ]);
});

void test("restart, start and stop report success only after their lifecycle action", async () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events),
  );

  await commands.cmdRestart();
  commands.cmdStart();
  commands.cmdStop();

  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "lifecycle.restartServices",
    "runtime.ok:Restarted: iva + telegram-poll",
    "runtime.requireSystemd",
    "lifecycle.activateUnits",
    "runtime.ok:Started and enabled at boot",
    "runtime.requireSystemd",
    "systemd.stop:iva.service,iva-telegram-poll.service",
    "runtime.ok:Stopped",
  ]);
});

void test("restart says so when data/custom is not in the version that runs", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-services-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createVersionStore(home);
  const customDir = join(home, "data/custom");
  mkdirSync(join(customDir, "agent/tools"), { recursive: true });
  writeFileSync(
    join(customDir, "agent/tools/mine.ts"),
    "export const m = 1;\n",
  );
  const restart = async (
    name: string,
    installed?: string,
  ): Promise<string[]> => {
    const dir = store.stage(name);
    if (installed !== undefined) {
      mkdirSync(join(dir, "agent/tools"), { recursive: true });
      writeFileSync(join(dir, "agent/tools/mine.ts"), installed);
    }
    store.complete(name);
    store.activate(name);
    const events: string[] = [];
    await createServiceCommands(
      runtimeFixture(events, { root: join(home, "versions", name) }),
      lifecycleFixture(events),
    ).cmdRestart();
    return events;
  };

  // A restart is not a build: the version that runs was made before this file
  // existed, and saying nothing is how a user concludes their skill is broken.
  assert.ok(
    (await restart("0.3.15-aaaaaaaaaaaa")).includes(
      "runtime.warn:data/custom changed since this version was built - run: iva update",
    ),
  );

  // A version whose name carries the digest but whose tree does not carry the
  // file: the customization failed to build or start and the stock tree was
  // installed under that name. This is the case a user is most sure about.
  const digest = customOverlay(customDir).digest;
  assert.ok(
    (await restart(`0.3.15-bbbbbbbbbbbb+${digest}`)).includes(
      "runtime.warn:data/custom is not in the version that runs: it did not build or start - fix it and run: iva update",
    ),
  );

  // The same, where the release ships a file of its own at that path - which
  // half the authored paths are. The file is there and it is not the user's, so
  // the presence of a file says nothing and the contents say everything.
  assert.ok(
    (
      await restart(`0.3.15-dddddddddddd+${digest}`, "export const m = 0;\n")
    ).includes(
      "runtime.warn:data/custom is not in the version that runs: it did not build or start - fix it and run: iva update",
    ),
  );

  // The version that was really built with it has nothing to say.
  const built = await restart(
    `0.3.15-cccccccccccc+${digest}`,
    "export const m = 1;\n",
  );
  assert.equal(
    built.some((event) => event.startsWith("runtime.warn:")),
    false,
    built.join("\n"),
  );
});

void test("service action failures propagate without printing success", () => {
  for (const commandName of ["restart", "start", "stop"] as const) {
    const events: string[] = [];
    const failure = new Error(`${commandName} failed`);
    const commands = createServiceCommands(
      runtimeFixture(events, {
        stop: () => {
          events.push("systemd.stop");
          throw failure;
        },
      }),
      lifecycleFixture(events, {
        activateUnits: () => {
          events.push("lifecycle.activateUnits");
          throw failure;
        },
        restartServices: () => {
          events.push("lifecycle.restartServices");
          throw failure;
        },
      }),
    );

    const invoke = {
      restart: commands.cmdRestart,
      start: commands.cmdStart,
      stop: commands.cmdStop,
    }[commandName];
    assert.throws(invoke, failure);
    assert.equal(
      events.some((event) => event.startsWith("runtime.ok:")),
      false,
    );
  }
});

void test("logs selects only the exact poll token and ignores command results", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events, { runStatus: 9 }),
    lifecycleFixture(events),
  );

  commands.cmdLogs([]);
  commands.cmdLogs(["--poll"]);
  commands.cmdLogs(["anything", "poll"]);

  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "runtime.run:journalctl:--user|-u|iva.service|-f|-n|50",
    "runtime.requireSystemd",
    "runtime.run:journalctl:--user|-u|iva.service|-f|-n|50",
    "runtime.requireSystemd",
    "runtime.run:journalctl:--user|-u|iva-telegram-poll.service|-f|-n|50",
  ]);
});

void test("reset stops first, uses one stamp in target order and restarts last", () => {
  const events: string[] = [];
  const targets = [
    "/srv/iva/.eve/.workflow-data",
    "/srv/iva/data/run-status.json",
    "/srv/iva/data/telegram-queue.json",
  ];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events),
    dependencyFixture(events, {
      resetStateTargets: (root, dataDir) => {
        events.push(`dependencies.resetStateTargets:${root}:${dataDir}`);
        return targets;
      },
      quarantinePath: (path, stamp) => {
        events.push(`dependencies.quarantinePath:${path}:${stamp}`);
        return path.endsWith("run-status.json")
          ? null
          : `${path}.trash-${stamp}`;
      },
    }),
  );

  commands.cmdReset();

  const stamp = "2026-08-06T12-34-56-789Z";
  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "runtime.step:Full reset: stopping services…",
    "systemd.stop:iva.service,iva-telegram-poll.service",
    "dependencies.now",
    "runtime.dataDirAbs",
    "dependencies.resetStateTargets:/srv/iva:/srv/iva/data",
    `dependencies.quarantinePath:${targets[0]}:${stamp}`,
    `runtime.ok:.eve/.workflow-data → .eve/.workflow-data.trash-${stamp} — reset state quarantined`,
    `dependencies.quarantinePath:${targets[1]}:${stamp}`,
    `dependencies.quarantinePath:${targets[2]}:${stamp}`,
    `runtime.ok:data/telegram-queue.json → data/telegram-queue.json.trash-${stamp} — reset state quarantined`,
    "lifecycle.restartServices",
    "runtime.ok:Restarted: iva + telegram-poll",
  ]);
});

void test("empty reset reports empty state before restart success", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events),
    dependencyFixture(events),
  );

  commands.cmdReset();

  assert.deepEqual(events.slice(-3), [
    "runtime.ok:workflow and Telegram control state already empty",
    "lifecycle.restartServices",
    "runtime.ok:Restarted: iva + telegram-poll",
  ]);
});

void test("stop failure exits before reset state is inspected or restarted", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events, {
      stop: () => {
        events.push("systemd.stop");
        throw new Error("stop failed");
      },
    }),
    lifecycleFixture(events),
    dependencyFixture(events),
  );

  assert.throws(() => commands.cmdReset(), ExitSignal);
  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "runtime.step:Full reset: stopping services…",
    "systemd.stop",
    "runtime.bad:stop failed Workflow and Telegram control state left untouched",
    "dependencies.exit:1",
  ]);
});

void test("reset continues after quarantine failure, reports restart first and exits without success", () => {
  const events: string[] = [];
  const targets = ["/srv/iva/first", "/srv/iva/second", "/srv/iva/third"];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events, {
      restartServices: () => {
        events.push("lifecycle.restartServices");
        throw new Error("restart failed");
      },
    }),
    dependencyFixture(events, {
      resetStateTargets: () => targets,
      quarantinePath: (path, stamp) => {
        events.push(`dependencies.quarantinePath:${path}:${stamp}`);
        if (path.endsWith("first")) throw new Error("permission denied");
        if (path.endsWith("second")) return `${path}.trash-${stamp}`;
        return null;
      },
    }),
  );

  assert.throws(() => commands.cmdReset(), ExitSignal);
  const stamp = "2026-08-06T12-34-56-789Z";
  assert.deepEqual(events.slice(-9), [
    `dependencies.quarantinePath:${targets[0]}:${stamp}`,
    "runtime.warn:failed to quarantine first: permission denied",
    `dependencies.quarantinePath:${targets[1]}:${stamp}`,
    `runtime.ok:second → second.trash-${stamp} — reset state quarantined`,
    `dependencies.quarantinePath:${targets[2]}:${stamp}`,
    "lifecycle.restartServices",
    "runtime.bad:restart failed",
    "runtime.bad:Reset INCOMPLETE — old workflow or Telegram control state may still be active",
    "dependencies.exit:1",
  ]);
  assert.equal(
    events.includes("runtime.ok:Restarted: iva + telegram-poll"),
    false,
  );
});

void test("reset preserves direct message access for null stop and quarantine throws", () => {
  const stopEvents: string[] = [];
  const stopCommands = createServiceCommands(
    runtimeFixture(stopEvents, {
      stop: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- preserve the legacy direct error.message behavior
        throw null;
      },
    }),
    lifecycleFixture(stopEvents),
    dependencyFixture(stopEvents),
  );
  assert.throws(() => stopCommands.cmdReset(), TypeError);
  assert.equal(
    stopEvents.some((event) => event.includes("exit")),
    false,
  );

  const quarantineEvents: string[] = [];
  const quarantineCommands = createServiceCommands(
    runtimeFixture(quarantineEvents),
    lifecycleFixture(quarantineEvents),
    dependencyFixture(quarantineEvents, {
      resetStateTargets: () => ["/srv/iva/state"],
      quarantinePath: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- preserve the legacy direct error.message behavior
        throw null;
      },
    }),
  );
  assert.throws(() => quarantineCommands.cmdReset(), TypeError);
  assert.equal(quarantineEvents.includes("lifecycle.restartServices"), false);
});

void test("a Symbol-valued stop error message preserves legacy interpolation failure", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events, {
      stop: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- preserve the legacy template interpolation boundary
        throw { message: Symbol("stop failure") };
      },
    }),
    lifecycleFixture(events),
    dependencyFixture(events),
  );

  assert.throws(() => commands.cmdReset(), TypeError);
  assert.equal(
    events.some((event) => event.includes("exit")),
    false,
  );
});

void test("a falsy null restart throw retains the legacy success path", () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events, {
      restartServices: () => {
        events.push("lifecycle.restartServices:null");
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- characterize the legacy truthiness check
        throw null;
      },
    }),
    dependencyFixture(events),
  );

  commands.cmdReset();

  assert.deepEqual(events.slice(-3), [
    "runtime.ok:workflow and Telegram control state already empty",
    "lifecycle.restartServices:null",
    "runtime.ok:Restarted: iva + telegram-poll",
  ]);
  assert.equal(
    events.some((event) => event.includes("exit")),
    false,
  );
});

void test("the health wait reports the unit, its port and success only when it serves", async () => {
  const events: string[] = [];
  const runtime = runtimeFixture(events);
  const commands = createServiceCommands(
    {
      ...runtime,
      // The .env of /srv/iva does not exist here, so the port is the default one.
      systemd: {
        ...runtime.systemd,
        query: (...args: string[]) => {
          events.push(`systemd.query:${args.join("|")}`);
          return { code: 0, out: "active" };
        },
      },
    },
    lifecycleFixture(events),
    dependencyFixture(events, {
      awaitHealthy: ({ unit, port, state }) => {
        events.push(`dependencies.awaitHealthy:${unit}:${port}:${state()}`);
        return Promise.resolve({ ok: true, log: "" });
      },
    }),
  );

  await commands.cmdAwaitHealthy();

  assert.deepEqual(events, [
    "runtime.requireSystemd",
    "systemd.query:is-active|iva.service",
    "dependencies.awaitHealthy:iva.service:8723:active",
    "runtime.ok:iva.service is active and answering on port 8723",
  ]);
});

void test("a service that never comes up fails the wait and names the journal", async () => {
  const events: string[] = [];
  const commands = createServiceCommands(
    runtimeFixture(events),
    lifecycleFixture(events),
    dependencyFixture(events, {
      awaitHealthy: () =>
        Promise.resolve({ ok: false, log: "iva.service is failed" }),
    }),
  );

  await assert.rejects(commands.cmdAwaitHealthy(), (error: Error) => {
    assert.equal(
      error.message,
      "iva.service did not come up: iva.service is failed." +
        " Check: journalctl --user -u iva.service -n 100 --no-pager",
    );
    return true;
  });
  // Nothing said it was up.
  assert.deepEqual(events, ["runtime.requireSystemd"]);
});

void test("every command requires systemd before its own side effects", () => {
  for (const commandName of [
    "status",
    "restart",
    "reset",
    "start",
    "stop",
    "logs",
    "awaitHealthy",
  ] as const) {
    const events: string[] = [];
    const unavailable = new Error("systemd unavailable");
    const commands = createServiceCommands(
      runtimeFixture(events, {
        requireSystemd: () => {
          events.push("runtime.requireSystemd");
          throw unavailable;
        },
      }),
      lifecycleFixture(events),
      dependencyFixture(events),
    );
    const invoke = {
      status: commands.cmdStatus,
      restart: commands.cmdRestart,
      reset: commands.cmdReset,
      start: commands.cmdStart,
      stop: commands.cmdStop,
      logs: () => commands.cmdLogs([]),
      awaitHealthy: commands.cmdAwaitHealthy,
    }[commandName];

    assert.throws(invoke, unavailable);
    assert.deepEqual(events, ["runtime.requireSystemd"]);
  }
});
