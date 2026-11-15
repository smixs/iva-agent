/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
// The unit writer and the .env migrations, in-process against a temp project: the runtime
// is the real one with UNIT_DIR, hasSystemd and the systemctl runner replaced, so nothing
// here reaches ~/.config/systemd or a real systemctl.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { servicePath } from "../../packages/claude-command/index.ts";
import { parseEnv } from "node:util";
import fc from "fast-check";
import { isAssistantBearer } from "../lib/assistant-auth.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };
const BEARER = "b".repeat(43);

const TEMPLATES: Readonly<Record<string, string>> = {
  "iva-brain.service":
    "ExecStart=/usr/bin/env __DATA_DIR_ENV__ __NODE_BIN__ __PROJECT_DIR__/scripts/memory/brain.ts\n",
  "iva-brain.timer": "OnCalendar=*-*-* 05:00:00 __TIMEZONE__\n",
  "iva-telegram-userbot.service": "ExecStart=__PYTHON_BIN__ -m userbot\n",
  "iva-tree.ans": "__PROJECT_DIR__ is not a unit\n",
};

const LEGACY_BRAIN_BODY =
  "ExecStart=/usr/bin/node __PROJECT__/scripts/memory/doctor.ts\n";

type Fixture = {
  readonly project: string;
  readonly unitDir: string;
  readonly envPath: string;
  readonly calls: string[];
  readonly reports: string[];
  readonly warnings: string[];
  cleanup(): void;
};

type SystemdSetup = {
  readonly hasSystemd?: boolean;
  /** systemctl arguments (joined by a space) that exit 1. */
  readonly failing?: readonly string[];
  /** Units `is-active` reports as inactive. */
  readonly inactive?: readonly string[];
  /** Replaces the runtime's data-dir resolver, e.g. to make it throw. */
  readonly dataDirAbs?: () => string;
};

function fixture(env: string | null): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "iva-systemd-cli-"));
  const project = join(dir, "iva");
  const unitDir = join(dir, "home/.config/systemd/user");
  mkdirSync(join(project, "deploy"), { recursive: true });
  for (const [file, body] of Object.entries(TEMPLATES))
    writeFileSync(join(project, "deploy", file), body);
  const envPath = join(project, ".env");
  if (env !== null) writeFileSync(envPath, env, { mode: 0o644 });
  return {
    project,
    unitDir,
    envPath,
    calls: [],
    reports: [],
    warnings: [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function cli(fx: Fixture, setup: SystemdSetup = {}) {
  const failing = new Set(setup.failing ?? []);
  const inactive = new Set(setup.inactive ?? []);
  const run = (args: readonly string[]) => {
    const line = args.join(" ");
    fx.calls.push(line);
    if (failing.has(line)) return { code: 1, out: "" };
    if (args[0] === "is-enabled") return { code: 0, out: "enabled" };
    if (args[0] === "is-active")
      return inactive.has(args[1] ?? "")
        ? { code: 3, out: "inactive" }
        : { code: 0, out: "active" };
    return { code: 0, out: "" };
  };
  const runtime = createCliRuntime(fx.project);
  return createCliSystemd({
    ...runtime,
    dataDirAbs: setup.dataDirAbs ?? runtime.dataDirAbs,
    C: NO_COLOR,
    UNIT_DIR: fx.unitDir,
    hasSystemd: () => setup.hasSystemd ?? true,
    systemd: createSystemdControl({ run }),
    ok: (message: string) => fx.reports.push(message),
    warn: (message: string) => fx.warnings.push(message),
  });
}

function withFixture(env: string | null, body: (fx: Fixture) => void): void {
  const fx = fixture(env);
  try {
    body(fx);
  } finally {
    fx.cleanup();
  }
}

const unit = (fx: Fixture, name: string): string =>
  readFileSync(join(fx.unitDir, name), "utf8");
const envOf = (fx: Fixture): Record<string, string | undefined> =>
  parseEnv(readFileSync(fx.envPath, "utf8"));
const mode = (path: string): number => statSync(path).mode & 0o777;

function snapshot(fx: Fixture): Record<string, string> {
  const files: Record<string, string> = {
    ".env": readFileSync(fx.envPath, "utf8"),
  };
  for (const name of readdirSync(fx.unitDir)) files[name] = unit(fx, name);
  return files;
}

/** Every unit file of a release below the floor, by name. */
function unitBodies(fx: Fixture): Record<string, string> {
  return Object.fromEntries(
    readdirSync(fx.unitDir)
      .filter((name) => name.startsWith("iva-memory-"))
      .sort()
      .map((name) => [name, unit(fx, name)]),
  );
}

function seedLegacyBrain(fx: Fixture): void {
  mkdirSync(fx.unitDir, { recursive: true });
  for (const name of ["iva-memory-doctor.service", "iva-memory-doctor.timer"])
    writeFileSync(join(fx.unitDir, name), LEGACY_BRAIN_BODY);
}

function seedLegacyMemory(fx: Fixture): void {
  mkdirSync(fx.unitDir, { recursive: true });
  writeFileSync(join(fx.unitDir, "iva-memory-daily.timer"), "[Timer]\n");
}

function seedSchedules(fx: Fixture, extension = "mjs"): void {
  const dir = join(fx.project, ".output/server/_virtual");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `eve-night.schedule.${extension}`),
    'description: "schedules/memory-night.ts"\n',
  );
}

// ── writeUnits ──────────────────────────────────────────────────────────────

test("writeUnits writes every unit with its placeholders filled and closes the secrets", () => {
  withFixture("ASSISTANT_TIMEZONE=Europe/Moscow\nIVA_PORT=9001\n", (fx) => {
    mkdirSync(join(fx.project, "data"), { mode: 0o755 });
    chmodSync(join(fx.project, "data"), 0o755);

    const written = cli(fx).writeUnits({
      skipUnits: ["iva-telegram-userbot.service"],
    });

    assert.deepEqual(written.sort(), [
      "iva-brain.service",
      "iva-brain.timer",
      "iva.service",
    ]);
    assert.deepEqual(readdirSync(fx.unitDir).sort(), written);
    const service = unit(fx, "iva.service");
    assert.match(service, /^Environment=PORT=9001$/m);
    assert.match(service, /^Environment=TZ=Europe\/Moscow$/m);
    assert.match(service, new RegExp(`^WorkingDirectory=${fx.project}$`, "m"));
    assert.ok(
      service
        .split("\n")
        .includes(
          `ExecStartPre=-/usr/bin/env "ASSISTANT_DATA_DIR=${join(fx.project, "data")}" ${process.execPath} ${fx.project}/scripts/recover-interrupted-turns.ts`,
        ),
      service,
    );
    assert.match(service, /--host 127\.0\.0\.1$/m);
    // PATH юнита — тот, по которому доктор ищет claude (packages/claude-command).
    const nodeBin = createCliRuntime(fx.project).NODE_BIN_DIR;
    assert.ok(
      service
        .split("\n")
        .includes(`Environment=PATH=${servicePath(nodeBin, "%h")}`),
      service,
    );
    assert.equal(
      unit(fx, "iva-brain.timer"),
      "OnCalendar=*-*-* 05:00:00 Europe/Moscow\n",
    );
    assert.equal(
      unit(fx, "iva-brain.service"),
      `ExecStart=/usr/bin/env "ASSISTANT_DATA_DIR=${join(fx.project, "data")}" ${process.execPath} ${fx.project}/scripts/memory/brain.ts\n`,
    );
    assert.equal(mode(fx.envPath), 0o600);
    assert.equal(mode(join(fx.project, "data")), 0o700);
    assert.ok(isAssistantBearer(envOf(fx).ASSISTANT_BEARER));
    assert.deepEqual(fx.calls, ["daemon-reload"]);
  });
});

test("writeUnits run twice leaves units, bearer and .env exactly as the first run did", () => {
  withFixture("IVA_PORT=9001\n", (fx) => {
    const systemd = cli(fx);
    systemd.writeUnits();
    const first = snapshot(fx);

    systemd.writeUnits();

    assert.deepEqual(snapshot(fx), first);
    assert.deepEqual(fx.warnings, []);
  });
});

test("writeUnits falls back to UTC for an invalid timezone and says so", () => {
  withFixture('ASSISTANT_TIMEZONE="Mars/Base; rm"\n', (fx) => {
    cli(fx, { hasSystemd: false }).writeUnits({ ensureBearer: false });

    assert.match(unit(fx, "iva.service"), /^Environment=TZ=UTC$/m);
    assert.equal(
      unit(fx, "iva-brain.timer"),
      "OnCalendar=*-*-* 05:00:00 UTC\n",
    );
    assert.ok(
      fx.warnings.some((w) => w.includes("invalid ASSISTANT_TIMEZONE")),
    );
    assert.equal(envOf(fx).ASSISTANT_BEARER, undefined);
    assert.deepEqual(fx.calls, []);
  });
});

test("writeUnits canonicalises an alias timezone and keeps the default port", () => {
  withFixture("ASSISTANT_TIMEZONE=US/Pacific\n", (fx) => {
    cli(fx).writeUnits();

    const service = unit(fx, "iva.service");
    assert.match(service, /^Environment=TZ=America\/Los_Angeles$/m);
    assert.match(service, /^Environment=PORT=8723$/m);
    assert.deepEqual(fx.warnings, []);
  });
});

test("a perms target that fails is reported and the other targets are still closed", () => {
  withFixture("", (fx) => {
    mkdirSync(join(fx.project, ".eve"), { mode: 0o755 });
    chmodSync(join(fx.project, ".eve"), 0o755);
    // Only the perms pass fails: the unit templates resolve the same dir afterwards.
    let calls = 0;
    const systemd = cli(fx, {
      dataDirAbs: () => {
        if (calls++ === 0) throw new Error("data dir unreadable");
        return join(fx.project, "data");
      },
    });

    systemd.writeUnits({ ensureBearer: false });

    assert.deepEqual(fx.warnings, [
      "perms migration (data/) failed: data dir unreadable",
    ]);
    assert.equal(mode(fx.envPath), 0o600);
    assert.equal(mode(join(fx.project, ".eve")), 0o700);
    assert.ok(existsSync(join(fx.unitDir, "iva.service")));
  });
});

test("a failing daemon-reload surfaces with the systemctl exit code", () => {
  withFixture("", (fx) => {
    assert.throws(
      () => cli(fx, { failing: ["daemon-reload"] }).writeUnits(),
      /systemctl --user daemon-reload failed \(exit 1\)/,
    );
  });
});

// ── ensureAssistantBearer ──────────────────────────────────────────────────

test("the bearer is created once and reused on every later run", () => {
  withFixture("TELEGRAM_BOT_TOKEN=123:abc\n", (fx) => {
    const systemd = cli(fx);

    assert.equal(systemd.ensureAssistantBearer(), true);
    const bearer = envOf(fx).ASSISTANT_BEARER;
    assert.equal(systemd.ensureAssistantBearer(), false);

    assert.ok(isAssistantBearer(bearer));
    assert.equal(envOf(fx).ASSISTANT_BEARER, bearer);
    assert.equal(envOf(fx).TELEGRAM_BOT_TOKEN, "123:abc");
    assert.equal(mode(fx.envPath), 0o600);
    assert.deepEqual(fx.reports, [
      ".env protected and internal bearer configured",
    ]);
  });
});

test("a world-readable .env with a valid bearer is closed and keeps the bearer", () => {
  withFixture(`ASSISTANT_BEARER=${BEARER}\nA=1\n`, (fx) => {
    chmodSync(fx.envPath, 0o644);

    assert.equal(cli(fx).ensureAssistantBearer(), true);

    assert.equal(mode(fx.envPath), 0o600);
    assert.equal(
      readFileSync(fx.envPath, "utf8"),
      `ASSISTANT_BEARER=${BEARER}\nA=1\n`,
    );
    assert.deepEqual(fx.reports, [
      ".env protected and internal bearer configured",
    ]);
  });
});

test("a duplicated valid bearer collapses to one line with the same value", () => {
  withFixture(
    `ASSISTANT_BEARER=${BEARER}\nA=1\nASSISTANT_BEARER=${BEARER}\n`,
    (fx) => {
      chmodSync(fx.envPath, 0o600);

      assert.equal(cli(fx).ensureAssistantBearer({ quiet: true }), true);

      const raw = readFileSync(fx.envPath, "utf8");
      assert.equal(raw.match(/^ASSISTANT_BEARER=/gm)?.length, 1);
      assert.equal(envOf(fx).ASSISTANT_BEARER, BEARER);
      assert.equal(envOf(fx).A, "1");
      assert.deepEqual(fx.reports, []);
    },
  );
});

test("an invalid bearer is replaced and a missing .env is left missing", () => {
  withFixture("ASSISTANT_BEARER=short\n", (fx) => {
    assert.equal(cli(fx).ensureAssistantBearer({ quiet: true }), true);
    assert.notEqual(envOf(fx).ASSISTANT_BEARER, "short");
    assert.ok(isAssistantBearer(envOf(fx).ASSISTANT_BEARER));
  });
  withFixture(null, (fx) => {
    assert.equal(cli(fx).ensureAssistantBearer(), false);
    assert.equal(existsSync(fx.envPath), false);
  });
});

// ── a .env without IVA_PORT ────────────────────────────────────────────────

const envKey = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,11}$/);
const envValue = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_./:@+-]{0,24}$/),
  // quoted: spaces, # and = only survive inside quotes
  fc
    .stringMatching(/^[A-Za-z0-9 #=_./:-]{0,24}$/)
    .chain((body) => fc.constantFrom(`"${body}"`, `'${body}'`)),
);
const envHost = fc.oneof(
  fc.constant("http://127.0.0.1:3000"),
  fc.integer({ min: 1, max: 65535 }).map((port) => `http://localhost:${port}`),
  fc
    .integer({ min: 1, max: 65535 })
    .map((port) => `https://127.0.0.1:${port}/`),
  fc.constant("https://iva.example.com"),
);
const envFile = fc
  .record({
    entries: fc.uniqueArray(fc.tuple(envKey, envValue), {
      selector: ([key]) => key,
      maxLength: 12,
    }),
    host: fc.option(envHost, { nil: undefined }),
    hostIndent: fc.constantFrom("", "  ", "\t"),
    port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    comments: fc.array(fc.constantFrom("# note", "", "   "), { maxLength: 4 }),
    eol: fc.constantFrom("\n", "\r\n"),
    trailingNewlines: fc.integer({ min: 0, max: 3 }),
  })
  .map(
    ({ entries, host, hostIndent, port, comments, eol, trailingNewlines }) => {
      const lines = entries
        .filter(([key]) => key !== "IVA_PORT" && key !== "ASSISTANT_HOST")
        .map(([key, value]) => `${key}=${value}`);
      if (host !== undefined)
        lines.splice(
          lines.length >> 1,
          0,
          `${hostIndent}ASSISTANT_HOST=${host}`,
        );
      if (port !== undefined) lines.push(`IVA_PORT=${port}`);
      lines.splice(1, 0, ...comments);
      return lines.join(eol) + eol.repeat(trailingNewlines);
    },
  );

// UpdateFloor.NoSilentLoss: a .env written before 0.3.15 names no port. Writing units
// never rewrites it: the bytes stay, and the unit carries the port the file names or the
// default one.
test("PROPERTY NoSilentLoss: writeUnits leaves a .env byte for byte, with or without IVA_PORT", () => {
  const seed = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
  console.log(`env property seed=${seed} (rerun with FC_SEED=${seed})`);
  fc.assert(
    fc.property(envFile, (raw) => {
      withFixture(raw, (fx) => {
        cli(fx).writeUnits({ ensureBearer: false });

        assert.equal(readFileSync(fx.envPath, "utf8"), raw);
        const port = parseEnv(raw).IVA_PORT ?? "8723";
        assert.ok(
          unit(fx, "iva.service").includes(`Environment=PORT=${port}\n`),
          `PORT=${port}`,
        );
      });
    }),
    { seed, numRuns: 60 },
  );
});

// ── units of a release below the floor, restart ────────────────────────────

// UpdateFloor.NoSilentLoss: the iva-memory-* units are not this CLI's to rewrite, disable
// or remove.
test("NoSilentLoss: writeUnits and restartServices leave the units of a release below the floor as they were", () => {
  for (const hasSystemd of [true, false])
    withFixture("", (fx) => {
      seedLegacyMemory(fx);
      seedLegacyBrain(fx);
      seedSchedules(fx);
      const before = unitBodies(fx);
      const systemd = cli(fx, { hasSystemd });

      systemd.writeUnits();
      if (hasSystemd) systemd.restartServices();

      assert.deepEqual(unitBodies(fx), before);
      assert.deepEqual(
        fx.calls.filter((call) => call.includes("iva-memory-")),
        [],
      );
      assert.deepEqual(fx.warnings, []);
    });
});

test("restartServices rewrites units, runs the hook and restarts", () => {
  withFixture("", (fx) => {
    const order: string[] = [];

    cli(fx).restartServices({
      afterUnitWrite: () =>
        order.push(`hook:${existsSync(join(fx.unitDir, "iva.service"))}`),
    });

    assert.deepEqual(order, ["hook:true"]);
    assert.ok(fx.calls.includes("restart iva.service"));
    assert.ok(fx.calls.includes("restart iva-telegram-poll.service"));
  });
});

test("restartServices reports a failed restart with its cause", () => {
  withFixture("", (fx) => {
    assert.throws(
      () => cli(fx, { failing: ["restart iva.service"] }).restartServices(),
      /systemctl --user restart iva\.service failed \(exit 1\)/,
    );
  });
});

test("restartServices fails when the first service is not active after the restart", () => {
  withFixture("", (fx) => {
    assert.throws(
      () => cli(fx, { inactive: ["iva.service"] }).restartServices(),
      /iva\.service did not become active after restart/,
    );
  });
});

test("activateUnits enables every service and timer", () => {
  withFixture("", (fx) => {
    cli(fx).activateUnits();

    for (const name of [
      "iva.service",
      "iva-telegram-poll.service",
      "iva-brain.timer",
      "iva-update-check.timer",
    ])
      assert.ok(fx.calls.includes(`enable --now ${name}`), name);
  });
});

test("removeUnits removes only Iva units and reports a failed disable with its cause", () => {
  withFixture("", (fx) => {
    const systemd = cli(fx);
    assert.deepEqual(systemd.removeUnits(), []);
    systemd.writeUnits({ ensureBearer: false });
    writeFileSync(join(fx.unitDir, "other.service"), "[Unit]\n");

    assert.deepEqual(systemd.removeUnits().sort(), [
      "iva-brain.service",
      "iva-brain.timer",
      "iva-telegram-userbot.service",
      "iva.service",
    ]);
    assert.deepEqual(readdirSync(fx.unitDir), ["other.service"]);
  });
  withFixture("", (fx) => {
    const systemd = cli(fx, { failing: ["disable --now iva.service"] });
    systemd.writeUnits({ ensureBearer: false });

    assert.throws(
      () => systemd.removeUnits(),
      /disable iva\.service: systemctl --user disable --now iva\.service failed \(exit 1\)/,
    );
  });
});
