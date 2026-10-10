/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { createCliRuntime } from "./cli/runtime.ts";
import { createUserbotCommands, reinstallUserbot } from "./cli/userbot.ts";
import { layoutFor } from "./lib/version-store.ts";
import {
  alertOwnerAboutUserbot,
  startCandidateServices,
} from "./update-finish.ts";

const UNIT = "iva-telegram-userbot.service";
const SEED = 20261005;
type Failure = "none" | "missing" | "sync" | "import" | "readiness";

async function installation(
  t: { after(fn: () => unknown): void },
  failure: Failure,
  active = true,
  enabled = true,
  present = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "iva-userbot-recovery-"));
  const home = join(dir, "owner with spaces");
  const root = join(dir, "versions/0.4.12-123456789abc");
  const data = join(dir, "data");
  const bin = join(dir, "commands");
  const userbot = join(root, "services/telegram-userbot");
  for (const path of [home, userbot, data, bin])
    mkdirSync(path, { recursive: true });
  const calls = join(dir, "calls.log");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ active, enabled, present }));
  // Read by the fake uv on every run: a box can break and heal between two updates.
  const broken = join(dir, "failure");
  writeFileSync(broken, failure);
  const token = join(data, "telegram-userbot.token");
  const session = join(data, "telegram-userbot.session");
  writeFileSync(token, "synthetic-owner-token\n", { mode: 0o600 });
  writeFileSync(session, "synthetic-telethon-session\n", { mode: 0o600 });
  writeFileSync(
    join(userbot, "requirements.lock"),
    "telethon==1 --hash=sha256:synthetic\n",
  );
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-owner-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ state: failure === "readiness" ? "broken" : "ready" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    join(root, ".env"),
    "ASSISTANT_DATA_DIR=" +
      data +
      "\nTELEGRAM_MCP_PORT=" +
      address.port +
      "\nTELEGRAM_API_ID=123\nTELEGRAM_API_HASH=synthetic-config\n",
  );
  const originalEnv = readFileSync(join(root, ".env"));
  const executable = (file: string, source: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  };
  executable(
    join(bin, "systemctl"),
    [
      "#!" + process.execPath,
      'const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");',
      'const args = process.argv.slice(2).filter(value => value !== "--user" && value !== "--now");',
      "appendFileSync(" +
        JSON.stringify(calls) +
        ', "systemctl " + args.join(" ") + "\\n");',
      "const file = " + JSON.stringify(state) + ";",
      'const state = JSON.parse(readFileSync(file, "utf8"));',
      "const [action, unit] = args;",
      "if (unit !== " + JSON.stringify(UNIT) + ") {",
      'if (action === "show") console.log("loaded");',
      'const running = ["iva.service", "iva-telegram-poll.service", "iva-update-check.timer"];',
      'if (action === "is-active") console.log(running.includes(unit) ? "active" : "inactive");',
      'if (action === "is-enabled") console.log(unit === "iva-update-check.timer" ? "enabled" : "disabled");',
      "process.exit(0);",
      "}",
      'if (action === "show") { console.log(state.present ? "loaded" : "not-found"); process.exit(0); }',
      'if (action === "is-active") { console.log(state.active ? "active" : "inactive"); process.exit(state.active ? 0 : 3); }',
      'if (action === "is-enabled") { console.log(state.enabled ? "enabled" : "disabled"); process.exit(state.enabled ? 0 : 1); }',
      'if (action === "stop" || action === "disable") state.active = false;',
      'if (action === "disable") state.enabled = false;',
      'if (action === "start" || action === "restart") state.active = true;',
      'if (action === "enable") state.enabled = true;',
      "writeFileSync(file, JSON.stringify(state));",
    ].join("\n"),
  );
  if (failure !== "missing") {
    executable(
      join(home, ".local/bin/uv"),
      [
        "#!" + process.execPath,
        'const { mkdirSync, writeFileSync, chmodSync, appendFileSync, readFileSync } = require("node:fs");',
        "const args = process.argv.slice(2);",
        "appendFileSync(" +
          JSON.stringify(calls) +
          ', "uv " + args.join(" ") + "\\n");',
        "if (JSON.parse(readFileSync(" +
          JSON.stringify(state) +
          ', "utf8")).active) throw new Error("session owner must stop before dependency mutation");',
        'if (args[0] === "venv") {',
        "const file = " +
          JSON.stringify(join(userbot, ".venv/bin/python")) +
          ";",
        "mkdirSync(" +
          JSON.stringify(join(userbot, ".venv/bin")) +
          ", {recursive: true});",
        "writeFileSync(file, " +
          JSON.stringify(
            "#!/bin/sh\n" +
              (failure === "import"
                ? "echo 'ModuleNotFoundError: telegram_mcp' >&2\nexit 1"
                : "exit 0") +
              "\n",
          ) +
          ");",
        "chmodSync(file, 0o755);",
        "}",
        'if (args[0] === "pip" && readFileSync(' +
          JSON.stringify(broken) +
          ', "utf8") === "sync") process.exit(17);',
      ].join("\n"),
    );
  }
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = bin + ":/usr/bin:/bin";
  t.after(async () => {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const runtime = createCliRuntime(root);
  return {
    runtime,
    root,
    data,
    userbot,
    /** The dependency sync fails ("sync") or passes ("none") from the next run on. */
    sync: (mode: "sync" | "none") => writeFileSync(broken, mode),
    state: () =>
      JSON.parse(readFileSync(state, "utf8")) as {
        active: boolean;
        enabled: boolean;
        present: boolean;
      },
    /** The owner acts on the unit outside Iva, as `systemctl --user` would. */
    unit: (next: { active: boolean; enabled: boolean; present: boolean }) =>
      writeFileSync(state, JSON.stringify(next)),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : ""),
    intact: () => {
      assert.equal(readFileSync(token, "utf8"), "synthetic-owner-token\n");
      assert.equal(
        readFileSync(session, "utf8"),
        "synthetic-telethon-session\n",
      );
      assert.deepEqual(readFileSync(join(root, ".env")), originalEnv);
    },
  };
}

/**
 * The updater's own flip step on the fake installation: the core restart is a stub
 * (it writes no units), everything after it - plugin restart, userbot recovery and the
 * writer-state restoration - is the code `update-finish` runs.
 */
async function flip(
  box: Awaited<ReturnType<typeof installation>>,
  state: { loadState: string; active: boolean; enabled: boolean },
  {
    reports = [],
    readinessTimeoutMs,
    alerts = [],
    alertUserbot = (reason: string) => {
      alerts.push(reason);
      return Promise.resolve();
    },
  }: {
    reports?: string[];
    readinessTimeoutMs?: number;
    alerts?: string[];
    alertUserbot?: (reason: string) => Promise<void>;
  } = {},
) {
  const recoveries: Array<Awaited<ReturnType<typeof reinstallUserbot>>> = [];
  await startCandidateServices(
    box.runtime,
    {
      restartServices: (options) => options?.afterUnitWrite?.(),
      retireDeferredBrainUnits: () => [],
      writeUnits: () => [],
    },
    {
      states: [{ unit: UNIT, ...state }],
      dataDir: box.data,
      log: () => {},
      notify: (message) => reports.push(message),
      migration: { started: false },
      alertUserbot,
      reinstall: async (runtime, services, report, options) => {
        const recovery = await reinstallUserbot(
          runtime,
          services,
          report,
          options,
          { readinessTimeoutMs },
        );
        recoveries.push(recovery);
        return recovery;
      },
    },
  );
  return recoveries;
}

test("a new version prepares with the installed home uv outside non-login PATH", async (t) => {
  const box = await installation(t, "none", false);
  createUserbotCommands(box.runtime, {
    writeUnits: () => [],
  }).ensureUserbotVenv({ quiet: true });
  assert.ok(existsSync(join(box.userbot, ".venv/bin/python")));
  assert.match(box.calls(), /uv venv --python 3\.12 \.venv/);
  assert.match(
    box.calls(),
    /uv pip sync .*--require-hashes --strict .*requirements\.lock/,
  );
  box.intact();
});

test("recovery failures remain stopped through updater writer-state restoration", async (t) => {
  for (const failure of ["missing", "sync", "import", "readiness"] as const) {
    await t.test(failure, async (sub) => {
      const box = await installation(sub, failure);
      const reports: string[] = [];
      const alerts: string[] = [];
      const [result] = await flip(
        box,
        { loadState: "loaded", active: true, enabled: true },
        { reports, readinessTimeoutMs: 120, alerts },
      );
      assert.equal(
        box.state().active,
        false,
        "failed preparation must not start a captured active writer",
      );
      assert.equal(
        box.state().enabled,
        false,
        "failed preparation must not restart on boot",
      );
      assert.equal(result?.status, "failed");
      assert.equal(
        box.runtime.systemd.query("is-active", "iva.service").out,
        "active",
      );
      assert.match(reports.join("\n"), /iva userbot setup/);
      // Кто обновлялся кнопкой в боте, вывода не видит: владельцу уходит одно Alert
      // с той же причиной, что в выводе.
      assert.ok(result?.status === "failed");
      assert.deepEqual(alerts, [result.reason]);
      box.intact();
    });
  }
});

test("an Alert that throws does not fail the flip and the userbot stays off", async (t) => {
  for (const thrown of ["rejects", "throws"] as const) {
    await t.test(thrown, async (sub) => {
      sub.mock.method(console, "error", () => undefined);
      const box = await installation(sub, "import");
      const reports: string[] = [];
      let asked = 0;
      const recoveries = await flip(
        box,
        { loadState: "loaded", active: true, enabled: true },
        {
          reports,
          readinessTimeoutMs: 120,
          alertUserbot: (): Promise<void> => {
            asked += 1;
            if (thrown === "throws") throw new Error("chat unreachable");
            return Promise.reject(new Error("chat unreachable"));
          },
        },
      );
      assert.equal(asked, 1);
      assert.deepEqual(
        recoveries.map((recovery) => recovery.status),
        ["failed"],
      );
      assert.deepEqual(box.state(), {
        active: false,
        enabled: false,
        present: true,
      });
      assert.equal(
        reports.filter(
          (line) => line === "could not tell you in Telegram about the userbot",
        ).length,
        1,
      );
      box.intact();
    });
  }
});

// ADR-0007: a relapse after the fix speaks at once. Day 1 update A cannot prepare the
// userbot and the owner hears it; the owner turns it back on; day 3 update B fails the same
// way. Without forgetting the first Alert, B would be throttled for a week and the userbot
// would go off in silence - the very complaint the Alert answers.
test("a userbot turned back on forgets its Alert: the same failure on the next update speaks at once", async (t) => {
  for (const back of ["setup", "update"] as const) {
    await t.test(back, async (sub) => {
      sub.mock.method(console, "log", () => undefined);
      const box = await installation(sub, "sync");
      // The box's .env names its data directory: the throttle is the real one.
      const layout = layoutFor(box.root);
      assert.equal(layout.data, box.data);
      const sent: string[] = [];
      const alertUserbot = (reason: string) =>
        alertOwnerAboutUserbot(
          layout,
          reason,
          () => {},
          (text) => {
            sent.push(text);
            return Promise.resolve(true);
          },
        );
      const on = { loadState: "loaded", active: true, enabled: true };

      const [first] = await flip(box, on, {
        readinessTimeoutMs: 120,
        alertUserbot,
      });
      assert.equal(first?.status, "failed");
      assert.equal(sent.length, 1);
      assert.deepEqual(box.state(), {
        active: false,
        enabled: false,
        present: true,
      });

      box.sync("none");
      if (back === "setup") {
        // /menu → 📡 Userbot → «Включить» runs exactly this command.
        await createUserbotCommands(
          box.runtime,
          { writeUnits: () => [] },
          { readinessTimeoutMs: 1_000 },
        ).cmdUserbot(["setup"]);
      } else {
        // Turned on by hand; the next update finds it running and it comes up.
        box.unit({ active: true, enabled: true, present: true });
        const [middle] = await flip(box, on, {
          readinessTimeoutMs: 1_000,
          alertUserbot,
        });
        assert.equal(middle?.status, "ready");
      }
      assert.deepEqual(box.state(), {
        active: true,
        enabled: true,
        present: true,
      });
      assert.equal(sent.length, 1);

      box.sync("sync");
      const [relapse] = await flip(box, on, {
        readinessTimeoutMs: 120,
        alertUserbot,
      });
      assert.ok(relapse?.status === "failed" && first?.status === "failed");
      assert.equal(relapse.reason, first.reason);
      assert.equal(sent.length, 2, "a relapse after the fix is not a repeat");
      box.intact();
    });
  }
});

test("recovery preserves owner files and inactive/absent flags (seed 20261005)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      async (active, enabled, present) => {
        const cleanup: Array<() => unknown> = [];
        const box = await installation(
          {
            after: (fn) => {
              cleanup.push(fn);
            },
          },
          "none",
          present && active,
          present && enabled,
          present,
        );
        try {
          const alerts: string[] = [];
          const recoveries = await flip(
            box,
            {
              loadState: present ? "loaded" : "not-found",
              active: present && active,
              enabled: present && enabled,
            },
            { alerts },
          );
          // Юзербот поднялся или его и не было: говорить владельцу не о чем.
          assert.deepEqual(alerts, []);
          assert.deepEqual(box.state(), {
            active: present && active,
            enabled: present && enabled,
            present,
          });
          assert.deepEqual(
            recoveries.map((recovery) => recovery.status),
            present && active ? ["ready"] : [],
          );
          if (!present || !active)
            assert.doesNotMatch(
              box.calls(),
              /uv |systemctl (start|restart|enable|disable|stop) iva-telegram-userbot/,
            );
          box.intact();
        } finally {
          for (const cleanupStep of cleanup.reverse()) await cleanupStep();
        }
      },
    ),
    { seed: SEED, numRuns: 12 },
  );
});
