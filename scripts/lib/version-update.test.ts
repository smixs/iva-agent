/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureProbe,
  fixtureRunner,
} from "../fixtures/version-update-harness.ts";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { createVersionStore, layoutFor, releaseOf } from "./version-store.ts";
import {
  runVersionUpdate,
  stockFailureLine,
  versionOverlay,
  type Runner,
  type UpdateOutcome,
} from "./version-update.ts";

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/version-update-harness.ts",
);

/**
 * A migration that records that it ran - and, in the interruption harness, hangs
 * before doing so, which is the only moment where a killed update has already
 * flipped the symlink.
 */
const migration = (
  id: string,
) => `import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default async function up(context) {
  if (process.env.IVA_TEST_STALL === "migrate") {
    writeFileSync(process.env.IVA_TEST_MARKER, "migrate");
    await new Promise(() => {});
  }
  appendFileSync(join(context.dataDir, "migrated.log"), "${id}\\n");
}
`;

type World = {
  home: string;
  repo: string;
  git(...args: string[]): string;
  /** Commit the current repo state and report it as the next release. */
  release(version: string): { sha: string; version: string };
  target: { sha: string; version: string };
  update(
    overrides?: Partial<Parameters<typeof runVersionUpdate>[0]>,
  ): Promise<UpdateOutcome>;
  notices: string[];
  restarts: string[];
};

function world(t: { after(fn: () => void): void }): World {
  const home = mkdtempSync(join(tmpdir(), "iva-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(repo, "scripts/migrations"), { recursive: true });
  mkdirSync(join(repo, "agent"), { recursive: true });
  writeFileSync(join(repo, "agent/agent.ts"), "export const agent = 1;\n");
  writeFileSync(join(repo, "scripts/migrations/001-note.ts"), migration("001"));

  const state: World = {
    home,
    repo,
    git,
    target: { sha: "", version: "" },
    notices: [],
    restarts: [],
    release(version) {
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "iva", version }),
      );
      git("add", "-A");
      git("commit", "-m", `release ${version}`);
      state.target = { sha: git("rev-parse", "HEAD"), version };
      return state.target;
    },
    update: (overrides = {}) =>
      runVersionUpdate({
        home,
        resolveTarget: () => Promise.resolve(state.target),
        run: fixtureRunner(),
        probe: fixtureProbe(),
        notify: (message) => state.notices.push(message),
        resumeOldWriters: (dir) => {
          state.restarts.push(dir);
          return Promise.resolve();
        },
        startCandidate: (dir) => {
          state.restarts.push(dir);
          return Promise.resolve();
        },
        // No unit and no service: a test about what happens when the restarted
        // service does not answer says so itself.
        serving: () => Promise.resolve({ ok: true, log: "" }),
        ...overrides,
      }),
  };
  state.release("0.3.14");
  return state;
}

function customFile(home: string, path: string, body: string): void {
  const target = join(layoutFor(home).data, "custom", path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

/** Leave a complete version ready for a later update to reuse. */
async function prepareVersion(
  store: ReturnType<typeof createVersionStore>,
  target: { readonly sha: string; readonly version: string },
): Promise<string> {
  const name = `${target.version}-${target.sha.slice(0, 12)}`;
  const dir = store.stage(name);
  await store.materialize({ sha: target.sha, dir });
  store.linkState(dir);
  await fixtureRunner()("npm", ["run", "build"], dir);
  store.complete(name);
  return name;
}

type Updated = Extract<UpdateOutcome, { status: "updated" }>;

/** Narrow to a successful update, failing the test with the real status otherwise. */
function updated(outcome: UpdateOutcome): Updated {
  assert.equal(outcome.status, "updated", JSON.stringify(outcome));
  return outcome;
}

const healthyProbe = () => Promise.resolve({ ok: true, log: "" });

/** Run the harness until it stalls at `step`, then SIGKILL it there. */
async function killAt(
  home: string,
  step: string,
  target: unknown,
): Promise<void> {
  const marker = join(home, `killed-at-${step}`);
  const targetFile = join(home, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const child = spawn(process.execPath, [HARNESS], {
    env: {
      ...process.env,
      IVA_TEST_HOME: home,
      IVA_TEST_STALL: step,
      IVA_TEST_MARKER: marker,
      IVA_TEST_TARGET: targetFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("close", resolve));
  let output = "";
  const collect = (chunk: unknown) => {
    output += String(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = Date.now() + 20_000;
  while (!existsSync(marker) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(existsSync(marker), `the harness never reached ${step}: ${output}`);
  child.kill("SIGKILL");
  await exited;
}

/**
 * The file a `#`-alias names, read from package.json's `imports` map, or null when the
 * specifier is not one. The map points inside the tree, so an alias is a file the
 * unpacked version already carries - unlike a bare package, which needs node_modules.
 */
function aliasTarget(specifier: string, repository: string): string | null {
  if (!specifier.startsWith("#")) return null;
  const manifest: unknown = JSON.parse(
    readFileSync(join(repository, "package.json"), "utf8"),
  );
  const patterns =
    typeof manifest === "object" && manifest !== null && "imports" in manifest
      ? Object.entries(manifest.imports as Record<string, string>)
      : [];
  // Node picks the most specific pattern; longest prefix first reproduces that.
  patterns.sort(([left], [right]) => right.indexOf("*") - left.indexOf("*"));
  for (const [pattern, mapped] of patterns) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) return join(repository, mapped);
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (
      specifier.length >= head.length + tail.length &&
      specifier.startsWith(head) &&
      specifier.endsWith(tail)
    ) {
      const filled = specifier.slice(
        head.length,
        specifier.length - tail.length,
      );
      return join(repository, mapped.replace("*", filled));
    }
  }
  return null;
}

test("the new version's updater runs before there is a node_modules to run with", () => {
  // It is started in a version directory that has just been unpacked, so the
  // whole graph it reaches on the way to `npm ci` has to be built-ins and files
  // from the tree itself. One import of a package is a crash with no update.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repository = join(root, "..");
  const seen = new Set<string>();
  const queue = [join(root, "update-finish.ts")];
  const foreign: string[] = [];
  // The outbound Gate is loaded by a call inside try/catch and fails open when the tree
  // cannot load it (scripts/lib/notice.test.ts: «a notice still goes out when the authored
  // tree is not there»); the updater reaches it only for an Alert, after `npm ci`. Its
  // static imports are still walked.
  const failOpen = new Set([join(root, "lib/notice.ts")]);
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)[^"]*?from\s*"([^"]+)"/gmu),
      ...source.matchAll(/^\s*import\s+"([^"]+)"/gmu),
      ...(failOpen.has(file) ? [] : source.matchAll(/\bimport\("([^"]+)"\)/gu)),
    ];
    for (const [, specifier] of specifiers) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        queue.push(join(dirname(file), specifier));
        continue;
      }
      const aliased = aliasTarget(specifier, repository);
      if (aliased === null) {
        foreign.push(`${relative(root, file)} -> ${specifier}`);
        continue;
      }
      queue.push(aliased);
    }
  }
  assert.deepEqual(foreign, []);
  assert.ok(seen.size > 5, "the import graph was not walked");
});

test("a package outside the tree is still what the updater's walk refuses", () => {
  const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");
  // The alias resolves into the tree the version was unpacked from, through the map
  // rather than by trusting the prefix; a package name stays foreign, which is what the
  // walk reports.
  assert.equal(
    aliasTarget("#lib/schedule-table.ts", repository),
    join(repository, "agent/lib/schedule-table.ts"),
  );
  assert.equal(aliasTarget("eve/channels", repository), null);
  assert.equal(aliasTarget("just-bash", repository), null);
});

test("a first update builds a version, proves it starts and activates it", async (t) => {
  const iva = world(t);

  const outcome = updated(await iva.update());
  assert.deepEqual(outcome, {
    status: "updated",
    version: `0.3.14-${iva.target.sha.slice(0, 12)}`,
    previous: null,
    custom: "none",
    migrations: ["001-note"],
    removed: [],
  });

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
  // The restart targets `current`, never the version directory a later flip replaces.
  assert.deepEqual(iva.restarts, [layoutFor(iva.home).current]);
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migrated.log"), "utf8"),
    "001\n",
  );
});

test("re-running an update with nothing new changes nothing and re-runs no migration", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());

  const again = await iva.update();
  assert.deepEqual(again, { status: "current", version: first.version });
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migrated.log"), "utf8"),
    "001\n",
  );
  assert.deepEqual(iva.restarts.length, 1);
});

test("a second release is built beside the running one and both survive for rollback", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");

  const second = updated(await iva.update());
  assert.equal(second.previous, first.version);
  const store = createVersionStore(iva.home);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 2;\n",
  );

  // Rollback is a symlink flip: no git, no rebuild, one restart.
  store.activate(first.version);
  assert.equal(store.currentName(), first.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
});

test("a build starts with only the running version on disk", async (t) => {
  const iva = world(t);
  await iva.update({ probe: healthyProbe });
  iva.release("0.3.15");
  const running = updated(await iva.update({ probe: healthyProbe })).version;
  const store = createVersionStore(iva.home);
  const stale = "0.3.12-121212121212";
  store.stage(stale);
  store.complete(stale);
  const target = iva.release("0.3.16");
  const staged = `${target.version}-${target.sha.slice(0, 12)}`;
  let inspected = false;

  const outcome = updated(
    await iva.update({
      probe: healthyProbe,
      run: fixtureRunner((step) => {
        if (step === "install") {
          inspected = true;
          assert.deepEqual(
            readdirSync(store.layout.versions).sort(),
            [running, staged].sort(),
          );
        }
        return Promise.resolve();
      }),
    }),
  );

  assert.equal(inspected, true);
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [outcome.version, running].sort(),
  );
  assert.equal(store.previousName(), running);
});

test("a version that does not start is discarded and the running one stays live", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "UNHEALTHY"), "the new build crash-loops\n");
  const broken = iva.release("0.3.15");

  const outcome = await iva.update();
  assert.equal(outcome.status, "unhealthy");
  assert.match(outcome.status === "unhealthy" ? outcome.log : "", /boom/);

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.equal(
    existsSync(
      join(store.layout.versions, `0.3.15-${broken.sha.slice(0, 12)}`),
    ),
    false,
  );
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
  assert.match(iva.notices.join("\n"), /did not start/);
  assert.equal(iva.restarts.length, 1);
});

test("a customization that builds is layered into the new version", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "applied");
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  assert.deepEqual(iva.notices, []);
});

test("a markdown rule file in the slot is live, not built", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/instructions/rules.md", "- mine\n");

  const stock = updated(await iva.update());
  assert.equal(stock.custom, "none");
  assert.equal(
    existsSync(join(iva.home, "current/agent/instructions/rules.md")),
    false,
  );
  assert.deepEqual(iva.notices, []);

  // Правка живого правила не рождает новую Version: дайджест слоя её не видит.
  customFile(iva.home, "agent/instructions/rules.md", "- mine\n- also mine\n");
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: stock.version,
  });

  // Файл слота с кодом по-прежнему проходит через сборку.
  customFile(iva.home, "agent/instructions/30-mine.ts", "export default 1;\n");
  const applied = updated(await iva.update());
  assert.equal(applied.custom, "applied");
  assert.equal(
    readFileSync(
      join(iva.home, "current/agent/instructions/30-mine.ts"),
      "utf8",
    ),
    "export default 1;\n",
  );
});

// Шапка скилла с c1: metadata.hermes объектом. eve-build её отвергает; фальшивая сборка
// отвергает файл по слову BREAK — так же, как eve отвергла бы эту шапку в дереве.
const CROOKED_SKILL = `---
name: zz-crooked
description: Checks the crooked header
metadata:
  hermes:
    emoji: "🧪"
    requires: [git]
---
# Crooked
The build refuses this header: BREAK
`;

test("an owner's skill is not a build input: a crooked header leaves the rest applied", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/skills/zz-crooked/SKILL.md", CROOKED_SKILL);
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "applied");
  assert.equal(
    existsSync(join(iva.home, "current/agent/skills/zz-crooked")),
    false,
  );
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  assert.deepEqual(iva.notices, []);

  // Правка скилла не новая версия: резолвер читает его с диска на ходу.
  customFile(
    iva.home,
    "agent/skills/zz-crooked/SKILL.md",
    `${CROOKED_SKILL}more\n`,
  );
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: outcome.version,
  });
});

/** Alert о заводской сборке, пойманный вместо отправки. */
function alerts(): {
  texts: string[];
  alertCustom: (text: string) => Promise<void>;
} {
  const texts: string[] = [];
  return {
    texts,
    alertCustom: (text) => {
      texts.push(text);
      return Promise.resolve();
    },
  };
}

test("a customization that does not build tells the owner with the first line of the error", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "BREAK this build\n");
  const said = alerts();

  const outcome = updated(await iva.update({ alertCustom: said.alertCustom }));
  assert.equal(outcome.custom, "stock");
  assert.equal(said.texts.length, 1, said.texts.join("\n---\n"));
  assert.equal(
    stockFailureLine(said.texts[0]),
    "cannot compile agent/connections/mine.ts",
  );
});

test("a customization that does not start tells the owner with the first line of the error", async (t) => {
  const iva = world(t);
  updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const said = alerts();

  const outcome = updated(
    await iva.update({
      alertCustom: said.alertCustom,
      probe: (dir, port) =>
        existsSync(join(dir, "agent/connections/mine.ts"))
          ? Promise.resolve({
              ok: false,
              log: "\nError: Cannot find module x\n",
            })
          : fixtureProbe()(dir, port),
    }),
  );
  assert.equal(outcome.custom, "stock");
  assert.equal(said.texts.length, 1, said.texts.join("\n---\n"));
  assert.equal(stockFailureLine(said.texts[0]), "Error: Cannot find module x");
});

test("a held-back customization tells the owner the version did not come up", async (t) => {
  const iva = world(t);
  updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const serving = () =>
    Promise.resolve(
      existsSync(join(iva.home, "current/agent/connections/mine.ts"))
        ? { ok: false, log: "the card store did not open" }
        : { ok: true, log: "" },
    );
  assert.equal((await iva.update({ serving })).status, "unhealthy");
  const said = alerts();

  const back = updated(
    await iva.update({ serving, alertCustom: said.alertCustom }),
  );
  assert.equal(back.custom, "stock");
  assert.equal(said.texts.length, 1, said.texts.join("\n---\n"));
  assert.match(said.texts[0], /did not come up/u);
  assert.equal(stockFailureLine(said.texts[0]), null);
});

// Alert говорит о версии, на которой Ива работает: если заводская сборка не прошла пробу,
// обновление уходит в unhealthy, работает прежняя версия с файлами владельца, и Alert был бы
// ложным, а неделя дросселя заглушила бы настоящий.
test("a stock build whose candidate does not start sends no Alert; the output keeps the line", async (t) => {
  const iva = world(t);
  updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "BREAK this build\n");
  iva.release("0.3.15");
  const said = alerts();

  const outcome = await iva.update({
    alertCustom: said.alertCustom,
    probe: () =>
      Promise.resolve({ ok: false, log: "no probe port stayed free" }),
  });
  assert.equal(outcome.status, "unhealthy");
  assert.deepEqual(said.texts, []);
  assert.match(iva.notices.join("\n"), /does not build against this version/u);
});

test("files that build again forgive the stock-build Alert, so a relapse speaks at once", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const alertState = join(layoutFor(iva.home).data, "alert-state.json");
  writeFileSync(
    alertState,
    JSON.stringify({
      "custom-build": { essence: "x", lastSentAt: Date.now() },
    }),
  );

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "applied");
  assert.deepEqual(JSON.parse(readFileSync(alertState, "utf8")), {});
});

test("a slot file with a bundled name refuses the version and keeps the running one", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  mkdirSync(join(iva.repo, "agent/instructions"), { recursive: true });
  writeFileSync(
    join(iva.repo, "agent/instructions/20-core.ts"),
    "export default 1;\n",
  );
  iva.release("0.3.15");
  customFile(iva.home, "agent/instructions/20-core.ts", "export default 2;\n");

  await assert.rejects(
    iva.update(),
    /collides with a bundled file: agent\/instructions\/20-core\.ts/u,
  );
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
});

test("the custom layer's own bookkeeping is not mistaken for the user's code", async (t) => {
  const iva = world(t);
  const data = layoutFor(iva.home).data;
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  // What PR #169 keeps next to the authored files, plus the shape that used to
  // reach the running installation: `data/` in a version is a link to this one.
  customFile(iva.home, "manifest.json", '{"schema":"iva-custom/v1"}\n');
  customFile(iva.home, "bases/abc", "old\n");
  customFile(iva.home, "data/planted.txt", "planted\n");
  const logged: string[] = [];

  const outcome = updated(await iva.update({ log: (m) => logged.push(m) }));
  assert.equal(outcome.custom, "applied");
  assert.ok(logged.includes("applied 1 customized file(s)"), logged.join("\n"));
  for (const path of ["manifest.json", "bases/abc"])
    assert.equal(existsSync(join(iva.home, "current", path)), false, path);
  assert.equal(existsSync(join(data, "planted.txt")), false);
});

test("a customization added after a release is a version of its own", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  assert.equal(stock.custom, "none");

  // No new commit and no --force: the only thing that changed is the user's file.
  // Without an identity of its own it would resolve to the version already running
  // and never reach the service.
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const applied = updated(await iva.update());
  assert.equal(applied.custom, "applied");
  assert.equal(applied.previous, stock.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  // The same tree twice is not a rebuild.
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: applied.version,
  });

  // An edit to the same file is another version again.
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 2;\n");
  const edited = updated(await iva.update());
  assert.notEqual(edited.version, applied.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/connections/mine.ts"), "utf8"),
    "export const mine = 2;\n",
  );
});

test("removing a customization goes back to the stock version already on disk", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  assert.notEqual(updated(await iva.update()).version, stock.version);

  rmSync(join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"), {
    force: true,
  });
  let builds = 0;
  const back = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(back.version, stock.version);
  assert.equal(back.custom, "none");
  assert.equal(builds, 0, "the stock version was still on disk");
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
});

test("a failed probe never removes a finished version the installation can go back to", async (t) => {
  const iva = world(t);
  const stock = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const customized = updated(await iva.update());

  // Taking the customization back out resolves to the stock version still on
  // disk. It is finished, it ran before, and it is the one thing a rollback has
  // to go back to - so a probe that fails against it says the probe went wrong,
  // not that the version may be deleted.
  rmSync(join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"), {
    force: true,
  });
  const outcome = await iva.update({
    probe: () => Promise.resolve({ ok: false, log: "boom" }),
  });

  assert.equal(outcome.status, "unhealthy");
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), customized.version);
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [customized.version, stock.version].sort(),
  );
  assert.equal(store.previousName(), stock.version);
  // And it is still a version, not a directory left behind: it activates.
  store.activate(stock.version);
  assert.equal(store.currentName(), stock.version);
});

test("a customization that builds but does not start leaves the service on the stock build", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");

  // The build accepts it and the start refuses it: the shape of every custom-layer
  // incident, because the service compiles the authored sources again on start.
  const outcome = updated(
    await iva.update({
      probe: (dir, port) =>
        existsSync(join(dir, "agent/connections/mine.ts"))
          ? Promise.resolve({
              ok: false,
              log: "Cannot find module '../scripts/lib/provider.ts'",
            })
          : fixtureProbe()(dir, port),
    }),
  );

  assert.equal(outcome.custom, "stock");
  assert.equal(outcome.previous, first.version);
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
  assert.match(iva.notices.join("\n"), /does not start[\s\S]*stock build/u);
  // The file is still the user's, and the version that failed with it is not
  // rebuilt on every update until they change it.
  assert.equal(
    readFileSync(
      join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"),
      "utf8",
    ),
    "export const mine = 1;\n",
  );
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: outcome.version,
  });
});

test("a customization that does not build never keeps the service down", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/connections/mine.ts", "BREAK this build\n");

  const outcome = updated(await iva.update());
  assert.equal(outcome.custom, "stock");
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  // The stock tree runs; the user's file is untouched where they wrote it.
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
  assert.equal(
    readFileSync(
      join(layoutFor(iva.home).data, "custom/agent/connections/mine.ts"),
      "utf8",
    ),
    "BREAK this build\n",
  );
  assert.match(iva.notices.join("\n"), /does not build|stock build/);
  assert.equal(iva.restarts.length, 1);
});

test("an update with no network changes nothing and leaves no half-built version", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());

  await assert.rejects(
    iva.update({
      resolveTarget: () => Promise.reject(new Error("could not resolve host")),
    }),
    /could not resolve host/,
  );
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
});

test("a build failure keeps the running version and removes the candidate", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "BREAK\n");
  iva.release("0.3.15");

  await assert.rejects(iva.update(), /build failed/);
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
});

test("a build that fills the disk gives the space back and says what happened", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  iva.release("0.3.15");

  // A small VPS runs out of room mid-build. The half-written version is the one
  // thing on the box that is safe to delete, and the reason has to reach the user
  // or they will just run the update again into the same wall.
  await assert.rejects(
    iva.update({
      run: (command, args, cwd) =>
        args[1] === "build"
          ? Promise.resolve({
              code: 1,
              output:
                "ENOSPC: no space left on device, write '.output/server.mjs'",
            })
          : fixtureRunner()(command, args, cwd),
    }),
    /ENOSPC/,
  );
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);

  // With room again, the same update goes through - nothing was left claiming it.
  assert.equal(updated(await iva.update()).previous, first.version);
});

test("a second update refuses to run while the first one holds the lock", async (t) => {
  const iva = world(t);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const slow = iva.update({
    run: fixtureRunner(async (step) => {
      if (step === "build") await held;
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(await iva.update(), { status: "busy" });
  release();
  assert.equal((await slow).status, "updated");
});

test("an update killed while building is cleaned up by the next run", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);

  for (const step of ["install", "build", "probe"]) {
    await killAt(iva.home, step, iva.target);
    // The running version is untouched and still the one the link points at.
    assert.equal(store.currentName(), first.version, `after kill at ${step}`);
    assert.equal(
      readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
      "export const agent = 1;\n",
    );
    // The dead update left a claimed directory and a lock; neither blocks the retry.
    assert.ok(
      existsSync(
        join(store.layout.versions, `0.3.15-${iva.target.sha.slice(0, 12)}`),
      ),
      `expected leftovers after kill at ${step}`,
    );
  }

  const outcome = updated(await iva.update());
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 2;\n",
  );
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [first.version, outcome.version].sort(),
  );
});

test("an install interrupted after rollback removal keeps current and retries cleanly", async (t) => {
  const iva = world(t);
  const rollback = updated(await iva.update({ probe: healthyProbe }));
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const running = updated(await iva.update({ probe: healthyProbe }));
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 3;\n");
  iva.release("0.3.16");
  const store = createVersionStore(iva.home);

  await killAt(iva.home, "install", iva.target);

  assert.equal(store.currentName(), running.version);
  assert.equal(store.previousName(), null);
  assert.equal(
    existsSync(join(store.layout.versions, rollback.version)),
    false,
  );

  const outcome = updated(await iva.update({ probe: healthyProbe }));
  assert.equal(store.currentName(), outcome.version);
  assert.equal(store.previousName(), running.version);
  assert.deepEqual(
    store.list().sort(),
    [outcome.version, running.version].sort(),
  );
});

test("an update killed after the flip is finished by the next run", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-note.ts"),
    migration("002"),
  );
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  const { current, data } = layoutFor(iva.home);
  const name = `0.3.15-${iva.target.sha.slice(0, 12)}`;
  const log = (): string => readFileSync(join(data, "migrated.log"), "utf8");

  // Killed while stopping old writers: the old Version stays active.
  await killAt(iva.home, "quiesce", iva.target);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
  assert.equal(log(), "001\n");

  // Killed while migrating: activation still has not happened.
  await killAt(iva.home, "migrate", iva.target);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version, "the move is not finished");
  assert.equal(log(), "001\n");

  // Killed again, at the restart, with the migration now applied.
  await killAt(iva.home, "restart", iva.target);
  assert.equal(store.settled(), first.version);
  assert.equal(log(), "001\n002\n");
  assert.equal(existsSync(join(iva.home, "adopted")), false);

  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
      adopt: () => writeFileSync(join(iva.home, "adopted"), ""),
    }),
  );
  assert.equal(outcome.version, name);
  assert.equal(builds, 0, "the version that already runs is not rebuilt");
  assert.equal(log(), "001\n002\n", "an applied migration is not replayed");
  assert.ok(existsSync(join(iva.home, "adopted")));
  assert.deepEqual(iva.restarts, [current, current]);
  assert.equal(store.settled(), name);
  // Only now is the update over.
  assert.deepEqual(await iva.update(), { status: "current", version: name });
});

test("a state migration runs only after the old writer is quiesced", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-no-old-writer.ts"),
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function up(context) {
  if (existsSync(join(context.dataDir, "old-writer"))) {
    throw new Error("old writer is still live");
  }
  writeFileSync(join(context.dataDir, "migration-safe"), "safe");
}
`,
  );
  iva.release("0.3.15");
  const oldWriter = join(layoutFor(iva.home).data, "old-writer");
  writeFileSync(oldWriter, "live");
  const order: string[] = [];

  const outcome = updated(
    await iva.update({
      quiesce: () => {
        order.push("quiesce");
        assert.equal(
          createVersionStore(iva.home).currentName(),
          first.version,
          "activation must follow quiesce and migration",
        );
        rmSync(oldWriter);
        return Promise.resolve();
      },
      run: async (command, args, cwd) => {
        if (
          command === process.execPath &&
          args[0]?.endsWith("scripts/vault-cleanup.ts")
        ) {
          order.push("cleanup");
          assert.equal(
            createVersionStore(iva.home).currentName(),
            first.version,
            "activation must follow migration and cleanup",
          );
        }
        return fixtureRunner()(command, args, cwd);
      },
      startCandidate: (dir) => {
        order.push(`restart @${dir}`);
        assert.notEqual(
          createVersionStore(iva.home).currentName(),
          first.version,
          "activation must precede restart",
        );
        return Promise.resolve();
      },
    }),
  );

  assert.deepEqual(order, [
    "quiesce",
    "cleanup",
    `restart @${layoutFor(iva.home).current}`,
  ]);
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migration-safe"), "utf8"),
    "safe",
  );
  assert.equal(createVersionStore(iva.home).settled(), outcome.version);
});

test("a quiesce fault blocks migrations and attempts service recovery", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-must-not-run.ts"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function up(context) {
  writeFileSync(join(context.dataDir, "unsafe-migration"), "ran");
}
`,
  );
  iva.release("0.3.15");
  let recoveries = 0;

  await assert.rejects(
    iva.update({
      quiesce: () => Promise.reject(new Error("cannot stop old writer")),
      resumeOldWriters: () => {
        recoveries += 1;
        return Promise.resolve();
      },
    }),
    /cannot stop old writer/u,
  );

  const store = createVersionStore(iva.home);
  assert.equal(recoveries, 1);
  assert.equal(existsSync(join(store.layout.data, "unsafe-migration")), false);
  assert.equal(store.settled(), first.version);
  assert.equal(store.currentName(), first.version);
});

test("a migration fault keeps the old Version active and restarts old writers", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-fail.ts"),
    `export default function up() { throw new Error("migration exploded"); }\n`,
  );
  iva.release("0.3.15");
  const currentAtRestart: Array<string | null> = [];

  await assert.rejects(
    iva.update({
      resumeOldWriters: () => {
        currentAtRestart.push(createVersionStore(iva.home).currentName());
        return Promise.resolve();
      },
    }),
    /migration 002-fail failed: migration exploded/u,
  );

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
  assert.deepEqual(currentAtRestart, [first.version]);
});

test("an activation fault keeps the old Version active and restarts old writers", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  let recoveries = 0;

  await assert.rejects(
    iva.update({
      store: {
        ...store,
        activate() {
          throw new Error("activation exploded");
        },
      },
      resumeOldWriters: () => {
        recoveries += 1;
        assert.equal(store.currentName(), first.version);
        return Promise.resolve();
      },
    }),
    /activation exploded/u,
  );

  assert.equal(recoveries, 1);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
});

test("a restart fault rolls back and leaves a prepared update the next run can finish", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  const name = `0.3.15-${iva.target.sha.slice(0, 12)}`;

  await assert.rejects(
    iva.update({
      startCandidate: () =>
        Promise.reject(new Error("Failed to connect to bus")),
    }),
    /Failed to connect to bus/,
  );
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
  assert.ok(
    store.list().includes(name),
    "the prepared candidate remains retryable",
  );

  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(outcome.version, name);
  assert.equal(builds, 0);
  assert.equal(store.settled(), name);
  assert.deepEqual(iva.restarts, [
    layoutFor(iva.home).current,
    layoutFor(iva.home).current,
    layoutFor(iva.home).current,
  ]);
});

test("a version the service does not come up on is put back on the one that ran", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const name = `0.3.15-${iva.target.sha.slice(0, 12)}`;
  const store = createVersionStore(iva.home);
  const current = layoutFor(iva.home).current;

  // Proved before the flip on scratch state and dead on the installation's own -
  // its cards, its port, its unit's environment. Nothing earlier can see this.
  const outcome = await iva.update({
    serving: () => Promise.resolve({ ok: false, log: "nothing answered" }),
  });

  assert.deepEqual(outcome, {
    status: "unhealthy",
    version: name,
    log: "nothing answered",
  });
  // Back on the version that was serving, restarted onto it, and finished there:
  // the way back is not the user's to find by hand through an agent that is down.
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
  assert.deepEqual(iva.restarts, [current, current, current]);
  assert.ok(
    iva.notices.some((notice) =>
      notice.includes(`going back to ${first.version}`),
    ),
    iva.notices.join("\n"),
  );
  // Both versions are still on disk, and the older one really runs from there.
  assert.deepEqual(
    readdirSync(store.layout.versions).sort(),
    [first.version, name].sort(),
  );
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
});

test("a customization the service dies on is left out of the version installed next", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  const mine = "custom/agent/connections/mine.ts";
  customFile(iva.home, "agent/connections/mine.ts", "export const mine = 1;\n");
  const store = createVersionStore(iva.home);
  // Builds, and starts on the scratch state the probe gives it, and kills the
  // service against the installation's own: the shape nothing before the flip
  // can see. Whatever is under `current` when the restart happens is what runs.
  const serving = () =>
    Promise.resolve(
      existsSync(join(iva.home, "current/agent/connections/mine.ts"))
        ? { ok: false, log: "the card store did not open" }
        : { ok: true, log: "" },
    );

  const down = await iva.update({ serving });

  assert.equal(down.status, "unhealthy");
  const dead = down.status === "unhealthy" ? down.version : "";
  assert.equal(store.currentName(), first.version);
  assert.match(iva.notices.join("\n"), /data\/custom are the likeliest cause/u);

  // The next update must not hand that tree back: it builds and it probes green,
  // so nothing but the record of what it did to the service tells it apart from a
  // good version - and reusing it lays the installation down for another deadline.
  let builds = 0;
  const back = updated(
    await iva.update({
      serving,
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(back.custom, "stock");
  assert.notEqual(back.version, dead);
  assert.ok(builds > 0, "the version the service died on was reused");
  assert.equal(store.currentName(), back.version);
  assert.equal(store.settled(), back.version);
  assert.equal(
    existsSync(join(iva.home, "current/agent/connections/mine.ts")),
    false,
  );
  assert.match(iva.notices.join("\n"), /stock build[\s\S]*data\/custom/u);
  // Held back, never taken: the file is still the user's to fix.
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, mine), "utf8"),
    "export const mine = 1;\n",
  );
  // And the update is over: the next one has nothing to do, rather than trying
  // the same customization into the same rollback again.
  assert.deepEqual(await iva.update({ serving }), {
    status: "current",
    version: back.version,
  });

  // Taking the customization out is an ordinary update again.
  rmSync(join(layoutFor(iva.home).data, mine), { force: true });
  const stock = updated(await iva.update({ serving }));
  assert.equal(stock.custom, "none");
  assert.equal(store.currentName(), stock.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 1;\n",
  );
  assert.equal(
    readFileSync(join(layoutFor(iva.home).data, "migrated.log"), "utf8"),
    "001\n",
    "an applied migration is not replayed by any of this",
  );
});

test("a version the service died on is rebuilt by the next update, never reused", async (t) => {
  const iva = world(t);
  updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  const next = iva.release("0.3.15");
  const name = `0.3.15-${next.sha.slice(0, 12)}`;
  const store = createVersionStore(iva.home);
  // Nothing of the user's in it: upstream code that dies against the state of
  // this installation alone. The tree stays on disk as the way back's neighbour,
  // and it is exactly the tree the next update must not reuse.
  let dead = true;

  const down = await iva.update({
    serving: () =>
      Promise.resolve(
        dead ? { ok: false, log: "nothing answered" } : { ok: true, log: "" },
      ),
  });
  assert.equal(down.status, "unhealthy");
  assert.ok(store.list().includes(name), "the version is still on disk");

  dead = false;
  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
    }),
  );
  assert.equal(outcome.version, `${name}~2`);
  assert.ok(builds > 0, "the version the service died on was handed back");
  assert.equal(store.currentName(), outcome.version);
  assert.equal(
    readFileSync(join(iva.home, "current/agent/agent.ts"), "utf8"),
    "export const agent = 2;\n",
  );
  // Served once, so the record of the failure is gone with it.
  assert.equal(store.liveFailed(outcome.version), false);
});

test("a live-health fault rolls back to the Version that served", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");

  const outcome = await iva.update({
    serving: () => Promise.reject(new Error("health transport failed")),
  });

  assert.equal(outcome.status, "unhealthy");
  if (outcome.status === "unhealthy")
    assert.equal(outcome.log, "health transport failed");
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
});

test("a live-health rollback does not retire recovery writers", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  let retirements = 0;
  let recoveries = 0;

  const outcome = await iva.update({
    serving: () => Promise.resolve({ ok: false, log: "nothing answered" }),
    retireCommittedWriters: () => {
      retirements += 1;
      return Promise.resolve();
    },
    resumeOldWriters: () => {
      recoveries += 1;
      assert.equal(retirements, 0);
      return Promise.resolve();
    },
  });

  assert.equal(outcome.status, "unhealthy");
  assert.equal(retirements, 0);
  assert.equal(recoveries, 1);
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
});

test("a live-failure marker fault cannot block rollback", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);

  await assert.rejects(
    iva.update({
      store: {
        ...store,
        recordLive() {
          throw new Error("failure marker write failed");
        },
      },
      serving: () => Promise.resolve({ ok: false, log: "nothing answered" }),
    }),
    /failure marker write failed/u,
  );

  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
});

test("a first version that does not answer has nowhere to go back to", async (t) => {
  const iva = world(t);
  const current = layoutFor(iva.home).current;

  const outcome = await iva.update({
    serving: () => Promise.resolve({ ok: false, log: "nothing answered" }),
  });

  const name = `0.3.14-${iva.target.sha.slice(0, 12)}`;
  assert.equal(outcome.status, "unhealthy");
  const store = createVersionStore(iva.home);
  // Nothing is flipped away from: this version is all the installation has, and
  // the move stays unfinished, for the next run to pick up.
  assert.equal(store.currentName(), name);
  assert.equal(store.settled(), null);
  assert.deepEqual(iva.restarts, [current]);
  assert.ok(
    iva.notices.some((notice) =>
      notice.includes("no earlier version to go back to"),
    ),
    iva.notices.join("\n"),
  );
});

test("a rollback the restart refuses still leaves the older version current", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const store = createVersionStore(iva.home);
  const logged: string[] = [];
  let restarts = 0;

  // The box that lost its user session: the flip back is what decides which
  // version the next start runs, so a restart nobody can do does not undo it.
  const outcome = await iva.update({
    log: (message) => logged.push(message),
    serving: () => Promise.resolve({ ok: false, log: "nothing answered" }),
    startCandidate: (dir) => {
      iva.restarts.push(dir);
      return Promise.resolve();
    },
    resumeOldWriters: (dir) => {
      iva.restarts.push(dir);
      restarts += 1;
      return Promise.reject(new Error("Failed to connect to bus"));
    },
  });

  assert.equal(outcome.status, "unhealthy");
  assert.equal(store.currentName(), first.version);
  assert.equal(store.settled(), first.version);
  assert.ok(
    logged.some((message) => /Failed to connect to bus/.test(message)),
    logged.join("\n"),
  );
  assert.equal(restarts, 1);
});

test("the chores of the installation are run around the restart, out of the version installed", async (t) => {
  const iva = world(t);
  const calls: string[] = [];
  const logged: string[] = [];
  const build = fixtureRunner();
  const outcome = updated(
    await iva.update({
      log: (message) => logged.push(message),
      startCandidate: (dir) => {
        calls.push(`restart @${dir}`);
        return Promise.resolve();
      },
      run: (command, args, cwd) => {
        calls.push(`${command} ${args.join(" ")} @${cwd}`);
        // No registry here, which is the ordinary state of a box behind a proxy:
        // a chore that cannot run is not an update that failed.
        return command === "bash" && args[1] === "--update-gws"
          ? Promise.resolve({ code: 1, output: "no registry" })
          : build(command, args, cwd);
      },
    }),
  );
  const layout = layoutFor(iva.home);
  const dir = join(layout.versions, outcome.version);
  // The vault cleaner runs against the vault, out of the version that has just
  // become current, and before the restart: it repairs cards that an older
  // frontmatter writer grew to gigabytes, and once the agent has them open the
  // repair is too late. The Google CLI is refreshed after everything else.
  assert.deepEqual(calls.slice(-3), [
    `${process.execPath} ${join(dir, "scripts/vault-cleanup.ts")} . --apply @${layout.vault}`,
    `restart @${layout.current}`,
    `bash ${join(dir, "install.sh")} --update-gws ${join(homedir(), ".local")} @${dir}`,
  ]);
  assert.equal(createVersionStore(iva.home).settled(), outcome.version);
  assert.ok(
    logged.some((message) =>
      /Google CLI update did not run \(exit 1: no registry\)/.test(message),
    ),
    logged.join("\n"),
  );
});

test("Google update uses the service user's prefix and preserves existing authorization", async (t) => {
  const iva = world(t);
  const previousHome = process.env.HOME;
  const serviceHome = join(iva.home, "user with spaces");
  const config = join(serviceHome, ".config/gws/credentials.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "synthetic-authorization\n");
  process.env.HOME = serviceHome;
  t.after(() => {
    process.env.HOME = previousHome;
  });
  const build = fixtureRunner();
  const seen: string[][] = [];
  updated(
    await iva.update({
      run: (command, args, cwd) => {
        if (command === "bash" && args[1] === "--update-gws") {
          seen.push([...args]);
          return Promise.resolve({ code: 0, output: "" });
        }
        return build(command, args, cwd);
      },
    }),
  );
  assert.deepEqual(seen, [
    [
      join(
        layoutFor(iva.home).versions,
        createVersionStore(iva.home).currentName()!,
        "install.sh",
      ),
      "--update-gws",
      join(serviceHome, ".local"),
    ],
  ]);
  assert.equal(readFileSync(config, "utf8"), "synthetic-authorization\n");
});

test("an errand without output names the exit code alone", async (t) => {
  const iva = world(t);
  const logged: string[] = [];
  const build = fixtureRunner();
  updated(
    await iva.update({
      log: (message) => logged.push(message),
      run: (command, args, cwd) =>
        command === process.execPath &&
        args[0]?.endsWith("scripts/vault-cleanup.ts")
          ? Promise.resolve({ code: 127, output: "\n  \n" })
          : build(command, args, cwd),
    }),
  );
  assert.ok(
    logged.some((message) =>
      /the vault cleanup did not run \(exit 127\); the update continues without it/.test(
        message,
      ),
    ),
    logged.join("\n"),
  );
});

test("the vault cleanup leaves a commit pair named after the version, and git cannot fail the update", async (t) => {
  const iva = world(t);
  const layout = layoutFor(iva.home);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: layout.vault,
      encoding: "utf8",
    }).trim();
  const vaultGit = (...args: string[]) => {
    mkdirSync(layout.vault, { recursive: true });
    return git(...args);
  };
  vaultGit("init", "-q", "-b", "main");
  vaultGit("config", "user.email", "vault@example.com");
  vaultGit("config", "user.name", "Vault");
  writeFileSync(join(layout.vault, "CORE.md"), "# CORE\n");
  vaultGit("add", "-A");
  vaultGit("commit", "-q", "-m", "vault");
  // Правка владельца в Obsidian, ещё не в истории: она уезжает в снимок «до», а не теряется.
  writeFileSync(join(layout.vault, "CORE.md"), "# CORE\n\nправка владельца\n");

  const build = fixtureRunner();
  const outcome = updated(
    await iva.update({
      run: (command, args, cwd) => {
        if (
          command !== process.execPath ||
          !args[0]?.endsWith("scripts/vault-cleanup.ts")
        )
          return build(command, args, cwd);
        // Чистка чинит карточку, раздутое старшее описание: правка vault мимо инструментов.
        writeFileSync(join(layout.vault, "карточка.md"), "# Починено\n");
        return Promise.resolve({ code: 0, output: "" });
      },
    }),
  );
  assert.deepEqual(git("log", "--pretty=%s").split("\n").slice(0, 2), [
    `update ${outcome.version}: vault cleanup`,
    `update ${outcome.version}: vault snapshot`,
  ]);
  // Снимок «до» держит чужую правку, коммит чистки - результат чистки.
  assert.match(git("show", "--name-only", "--pretty=", "HEAD~1"), /CORE\.md/u);
  assert.match(
    git("show", "--name-only", "--pretty=", "HEAD"),
    /карточка\.md/u,
  );
  assert.equal(git("status", "--porcelain"), "");
});

test("a vault that is not a repository does not fail the update", async (t) => {
  const iva = world(t);
  const outcome = updated(await iva.update());
  assert.ok(outcome.version.startsWith(iva.target.version));
  assert.equal(createVersionStore(iva.home).settled(), outcome.version);
});

test("миграции получают каталог data, а не vault", async (t) => {
  const iva = world(t);
  writeFileSync(
    join(iva.repo, "scripts/migrations/002-context.ts"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default async function up(context) {
  writeFileSync(join(context.dataDir, "migration-context.json"), JSON.stringify(context));
}
`,
  );
  iva.release("0.3.15");
  const outcome = updated(await iva.update());
  const layout = layoutFor(iva.home);
  const context = JSON.parse(
    readFileSync(join(layout.data, "migration-context.json"), "utf8"),
  ) as Record<string, string>;
  // Миграция — код обновления, а память — чужие данные: ключи ровно эти три, и
  // каталог vault в них не назван ни одним способом.
  assert.deepEqual(Object.keys(context).sort(), [
    "dataDir",
    "home",
    "versionDir",
  ]);
  assert.equal(context.dataDir, layout.data);
  for (const value of Object.values(context))
    assert.ok(
      !value.includes(layout.vault),
      `миграция получила путь vault: ${value}`,
    );
  assert.equal(existsSync(join(layout.vault, "migration-context.json")), false);
  assert.ok(outcome.version.startsWith(iva.target.version));
});

test("a healthy service stays committed when post-health cleanup fails", async (t) => {
  const iva = world(t);
  const logged: string[] = [];
  const outcome = updated(
    await iva.update({
      adopt: () => {
        throw new Error("retiring the old checkout failed");
      },
      log: (message) => logged.push(message),
    }),
  );

  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(store.settled(), outcome.version);
  assert.match(logged.join("\n"), /retiring the old checkout failed/u);
  assert.equal(store.cleanupPending(outcome.version), true);

  let retries = 0;
  assert.deepEqual(
    await iva.update({
      adopt: () => {
        retries += 1;
      },
    }),
    { status: "current", version: outcome.version },
  );
  assert.equal(retries, 1);
  assert.equal(store.cleanupPending(outcome.version), false);
  assert.equal(
    iva.restarts.length,
    1,
    "cleanup retry must not restart service",
  );
});

test("writer retirement runs only after live health and service commit", async (t) => {
  const iva = world(t);
  const calls: string[] = [];
  const expected = `0.3.14-${iva.target.sha.slice(0, 12)}`;

  const outcome = updated(
    await iva.update({
      serving: () => {
        calls.push("live-health");
        return Promise.resolve({ ok: true, log: "" });
      },
      retireCommittedWriters: (root) => {
        const store = createVersionStore(iva.home);
        assert.equal(root, store.layout.current);
        assert.equal(store.currentName(), expected);
        assert.equal(store.settled(), expected);
        calls.push("writer-retirement");
        return Promise.resolve();
      },
      adopt: () => calls.push("adopt"),
    }),
  );

  assert.equal(outcome.version, expected);
  assert.deepEqual(calls, ["live-health", "writer-retirement", "adopt"]);
});

test("old versions go before the Google CLI errand", async (t) => {
  const iva = world(t);
  await iva.update({ probe: healthyProbe });
  iva.release("0.3.15");
  await iva.update({ probe: healthyProbe });
  const store = createVersionStore(iva.home);
  const stale = "0.3.12-121212121212";
  store.stage(stale);
  store.complete(stale);
  const target = iva.release("0.3.16");
  await prepareVersion(store, target);
  const base = fixtureRunner();
  let inspected = false;

  await iva.update({
    probe: healthyProbe,
    run: (command, args, cwd) => {
      if (command === "bash" && args[1] === "--update-gws") {
        inspected = true;
        assert.ok(store.list().length <= 2, store.list().join(", "));
      }
      return base(command, args, cwd);
    },
  });

  assert.equal(inspected, true);
});

test("a failing cleanup step does not skip version garbage collection", async (t) => {
  const iva = world(t);
  await iva.update({ probe: healthyProbe });
  iva.release("0.3.15");
  await iva.update({ probe: healthyProbe });
  const store = createVersionStore(iva.home);
  const stale = "0.3.12-121212121212";
  store.stage(stale);
  store.complete(stale);
  const target = iva.release("0.3.16");
  const next = await prepareVersion(store, target);
  const base = fixtureRunner();

  const outcome = updated(
    await iva.update({
      probe: healthyProbe,
      retireCommittedWriters: () =>
        Promise.reject(new Error("writer retirement failed")),
      adopt: () => {
        throw new Error("adoption failed");
      },
      run: (command, args, cwd) =>
        command === "bash" && args[1] === "--update-gws"
          ? Promise.resolve({ code: 1, output: "registry unavailable" })
          : base(command, args, cwd),
    }),
  );

  assert.ok(outcome.removed.length > 0);
  assert.equal(store.list().length, 2);
  assert.equal(store.cleanupPending(next), true);
  assert.equal(store.settled(), next);
});

test("writer-retirement fault leaves cleanup debt without rolling back", async (t) => {
  const iva = world(t);
  let attempts = 0;
  let fail = true;
  const retireCommittedWriters = () => {
    attempts += 1;
    if (fail) return Promise.reject(new Error("retirement failed"));
    return Promise.resolve();
  };

  const outcome = updated(await iva.update({ retireCommittedWriters }));
  const store = createVersionStore(iva.home);
  assert.equal(attempts, 1);
  assert.equal(store.currentName(), outcome.version);
  assert.equal(store.settled(), outcome.version);
  assert.equal(store.cleanupPending(outcome.version), true);

  fail = false;
  assert.deepEqual(await iva.update({ retireCommittedWriters }), {
    status: "current",
    version: outcome.version,
  });
  assert.equal(attempts, 2);
  assert.equal(store.cleanupPending(outcome.version), false);
  assert.equal(iva.restarts.length, 1);
});

test("a crash after service commit leaves cleanup debt for the next run", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  await killAt(iva.home, "cleanup", iva.target);

  const store = createVersionStore(iva.home);
  const moved = store.currentName();
  assert.notEqual(moved, first.version);
  assert.equal(store.settled(), moved);
  assert.equal(store.cleanupPending(moved!), true);

  let cleanupRuns = 0;
  assert.deepEqual(
    await iva.update({
      adopt: () => {
        cleanupRuns += 1;
      },
    }),
    { status: "current", version: moved },
  );
  assert.equal(cleanupRuns, 1);
  assert.equal(store.cleanupPending(moved!), false);
  assert.equal(iva.restarts.length, 1, "cleanup recovery must not restart");
});

test("the probe is started once when its port is nobody else's", async (t) => {
  const iva = world(t);
  const ports: number[] = [];
  const outcome = updated(
    await iva.update({
      probe: (_dir, port) => {
        ports.push(port);
        return Promise.resolve({ ok: true, log: "" });
      },
    }),
  );
  assert.deepEqual(ports.length, 1, "the version is started once, not retried");
  assert.equal(createVersionStore(iva.home).currentName(), outcome.version);
});

test("a probe port lost between the check and the start is traded for the next", async (t) => {
  const iva = world(t);
  // Nothing reserves the port the check found free, so the second updater on the
  // box can bind it first; the start that arrives after it says so and is owed
  // another candidate, not a failed update.
  const ports: number[] = [];
  const outcome = updated(
    await iva.update({
      probe: (_dir, port) => {
        ports.push(port);
        return Promise.resolve(
          ports.length === 1
            ? {
                ok: false,
                busy: true,
                log: `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
              }
            : { ok: true, log: "" },
        );
      },
    }),
  );
  assert.equal(ports.length, 2, ports.join(", "));
  assert.ok(ports[1] > ports[0], ports.join(", "));
  assert.equal(createVersionStore(iva.home).currentName(), outcome.version);
});

test("a box where every candidate port is taken ends the update instead of spinning", async (t) => {
  const iva = world(t);
  const ports: number[] = [];
  const outcome = await iva.update({
    probe: (_dir, port) => {
      ports.push(port);
      return Promise.resolve({ ok: false, busy: true, log: "EADDRINUSE" });
    },
  });

  assert.equal(outcome.status, "unhealthy", JSON.stringify(outcome));
  // Bounded and increasing: an update that keeps losing the race still stops.
  assert.ok(ports.length > 1 && ports.length < 10, ports.join(", "));
  assert.deepEqual(
    [...ports].sort((a, b) => a - b),
    ports,
    ports.join(", "),
  );
  assert.equal(createVersionStore(iva.home).currentName(), null);
});

test("a version prepared but never activated is reused instead of rebuilt", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update({ probe: healthyProbe }));
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 2;\n");
  iva.release("0.3.15");
  const second = updated(await iva.update({ probe: healthyProbe }));
  writeFileSync(join(iva.repo, "agent/agent.ts"), "export const agent = 3;\n");
  const next = iva.release("0.3.16");
  const store = createVersionStore(iva.home);

  // Exactly the state a kill between "finished" and "activated" leaves behind.
  const name = await prepareVersion(store, next);
  assert.equal(store.currentName(), second.version);

  let builds = 0;
  const outcome = updated(
    await iva.update({
      run: fixtureRunner(() => {
        builds += 1;
        return Promise.resolve();
      }),
      probe: (dir, port) => {
        assert.equal(store.currentName(), second.version);
        assert.deepEqual(
          store.list().sort(),
          [first.version, second.version, name].sort(),
        );
        assert.equal(dir, join(store.layout.versions, name));
        assert.equal(typeof port, "number");
        return healthyProbe();
      },
    }),
  );
  assert.equal(store.currentName(), name);
  assert.equal(builds, 0, "a finished version must not be built twice");
  assert.deepEqual(store.list().sort(), [name, second.version].sort());
  assert.equal(outcome.previous, second.version);
  assert.equal(store.previousName(), second.version);
});

test("--force rebuilds the running release beside it, never inside it", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  const store = createVersionStore(iva.home);
  const live = join(store.layout.versions, first.version);
  // What `--force` is for: the commit and data/custom are unchanged, so an
  // ordinary update has nothing to offer, and the version that runs is broken.
  rmSync(join(live, ".output"), { recursive: true, force: true });

  const probed: string[] = [];
  const forced = updated(
    await iva.update({
      force: true,
      probe: (dir, port) => {
        probed.push(dir);
        return fixtureProbe()(dir, port);
      },
    }),
  );

  assert.equal(forced.version, `${first.version}~2`);
  assert.equal(forced.previous, first.version);
  // Proved before the flip, like every other version - and proved somewhere the
  // service was not running from.
  assert.deepEqual(probed, [join(store.layout.versions, forced.version)]);
  assert.equal(store.currentName(), forced.version);
  assert.ok(
    existsSync(
      join(store.layout.versions, forced.version, ".output/server.mjs"),
    ),
  );
  // The directory the service was running from was not rebuilt, emptied or
  // touched: it is still there, exactly as broken as it was, as the way back.
  assert.equal(existsSync(join(live, ".output")), false);
  assert.ok(existsSync(join(live, "node_modules")));
  assert.equal(store.previousName(), first.version);
  // A rebuild is the same release, so the next ordinary update has nothing to do.
  assert.deepEqual(await iva.update(), {
    status: "current",
    version: forced.version,
  });
});

test("a forced rebuild that does not start leaves the running version live", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  const store = createVersionStore(iva.home);
  const live = join(store.layout.versions, first.version);

  const outcome = await iva.update({
    force: true,
    probe: () => Promise.resolve({ ok: false, log: "boom" }),
  });

  assert.equal(outcome.status, "unhealthy");
  assert.equal(store.currentName(), first.version);
  // The candidate was garbage nothing pointed at; the running version keeps its
  // tree, its dependencies and its build, and nothing was restarted over it.
  assert.deepEqual(readdirSync(store.layout.versions), [first.version]);
  for (const path of ["node_modules", ".output/server.mjs", "agent/agent.ts"])
    assert.ok(existsSync(join(live, path)), path);
  assert.equal(iva.restarts.length, 1, "only the first update restarted");
});

test("a broken current link is healed before the update decides what to do", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  rmSync(join(iva.home, "current"), { force: true });

  const outcome = await iva.update();
  assert.deepEqual(outcome, { status: "current", version: first.version });
  assert.equal(createVersionStore(iva.home).currentName(), first.version);
});

test("corrupt active state blocks update before leftover cleanup", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  const store = createVersionStore(iva.home);
  const leftover = store.stage("0.3.99-999999999999");
  writeFileSync(join(leftover, "partial"), "keep");
  const marker = join(store.layout.data, "active.json");
  const corrupt = Buffer.from([0xff, 0x00, 0x7b]);
  writeFileSync(marker, corrupt);

  await assert.rejects(
    iva.update(),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );

  assert.equal(store.currentName(), first.version);
  assert.equal(existsSync(leftover), true);
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("old versions are collected while the running one and its rollback stay", async (t) => {
  const iva = world(t);
  const releases: string[] = [];
  for (const version of ["0.3.15", "0.3.16", "0.3.17"]) {
    writeFileSync(
      join(iva.repo, "agent/agent.ts"),
      `export const agent = "${version}";\n`,
    );
    iva.release(version);
    releases.push(updated(await iva.update()).version);
  }

  const store = createVersionStore(iva.home);
  const kept = readdirSync(store.layout.versions).sort();
  assert.equal(kept.length, 2);
  assert.ok(kept.includes(store.currentName()!));
  assert.ok(kept.includes(releases.at(-2)!));
});

// Вторая половина апдейта — ПЕРВЫЙ код новой версии, который исполняется на машине, и он
// бежит до сборки. Проверка только в новом CLI до битого значения не доезжает никогда:
// первую половину гоняет версия, которая уже стоит, поэтому цикл fetch → build → health-fail
// → rollback повторялся бы бесконечно. Здесь он обрывается на входе, назвав значение.
test("the new version refuses to build on an invalid MODEL_PROVIDER", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-finish-provider-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const report = join(home, "outcome.json");
  const { main } = (await import("../update-finish.ts")) as {
    main: (argv: readonly string[]) => Promise<number>;
  };
  const previousReport = process.env.IVA_UPDATE_OUTCOME;
  t.after(() => {
    if (previousReport === undefined) delete process.env.IVA_UPDATE_OUTCOME;
    else process.env.IVA_UPDATE_OUTCOME = previousReport;
  });
  process.env.IVA_UPDATE_OUTCOME = report;

  for (const value of ["ollmaa", "OLLAMA", ""]) {
    writeFileSync(join(home, ".env"), `MODEL_PROVIDER=${value}\n`);
    rmSync(report, { force: true });

    const code = await main([home, "0.3.20-abcdefabcdef"]);

    assert.equal(code, 1, value);
    const outcome = JSON.parse(
      readFileSync(report, "utf8"),
    ) as UpdateOutcome & {
      message?: string;
    };
    assert.equal(outcome.status, "failed", value);
    assert.match(
      outcome.message ?? "",
      new RegExp(`Invalid MODEL_PROVIDER "${value}"`),
      value,
    );
    // Список имён берётся у рантайма: вписанный сюда рукой устаревает на первом вендоре.
    assert.ok(
      (outcome.message ?? "").includes(MODEL_PROVIDER_NAMES.join(", ")),
      value,
    );
    assert.match(outcome.message ?? "", /iva config/u);
    // Ни замка, ни установки версии: до сборки дело не дошло.
    assert.equal(existsSync(join(home, "versions")), false, value);
  }
});

// ── Плагины с кодом в сборке версии (ADR-0009) ───────────────────────────────────────────
// Плагин — eve Extension под `sh.iva/`, и собирается он ровно там, где собирается версия.
// Тот же харнес: фейковый раннер вместо npm и eve, временный home, реальный стор.

/** Запись о плагине в `plugins.json` — то, чем сборка узнаёт, что он включён. */
function pluginsState(
  home: string,
  entries: readonly {
    name: string;
    enabled?: boolean;
    trusted?: boolean;
    mcp?: Record<string, { port: number }>;
  }[],
): void {
  const file = join(layoutFor(home).data, "custom/plugins.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      marketplaces: [],
      plugins: entries.map((entry) => ({
        name: entry.name,
        source: `/tmp/${entry.name}`,
        ref: "",
        sha: "",
        digest: "",
        enabled: entry.enabled ?? true,
        trusted: entry.trusted ?? false,
        ...(entry.mcp ? { mcp: entry.mcp } : {}),
        installedAt: "2026-08-17T00:00:00.000Z",
      })),
    }),
  );
}

/** Папка плагина в Custom layer: скилл всегда, код — по умолчанию. */
function plantPlugin(
  home: string,
  name: string,
  {
    code = true,
    body = "export default { name: 'x' };\n",
    config,
    files = {},
    mcp,
  }: {
    code?: boolean;
    body?: string;
    config?: string;
    files?: Record<string, string>;
    mcp?: Record<string, unknown>;
  } = {},
): void {
  const store = join(layoutFor(home).data, "custom/plugins");
  const root = join(store, name);
  mkdirSync(join(root, "skills/demo"), { recursive: true });
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      version: "1.0.0",
      // Наш namespace объявлен: без ключа `sh.iva/` не читается вовсе (ADR-0009).
      ...(code ? { extensions: { "sh.iva": {} } } : {}),
    }),
  );
  writeFileSync(
    join(root, "skills/demo/SKILL.md"),
    "---\nname: demo\ndescription: Do the demo work.\n---\n\nBody.\n",
  );
  if (code) {
    mkdirSync(join(root, "sh.iva/extension"), { recursive: true });
    writeFileSync(
      join(root, "sh.iva/package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        eve: { extension: { source: "./extension", dist: "./dist/extension" } },
      }),
    );
    writeFileSync(join(root, "sh.iva/extension/extension.ts"), body);
    // Автор обязан положить свой tsconfig: без него eve не собирает расширение внутри
    // дерева версии, и плагин отклоняется ещё на `add`.
    writeFileSync(
      join(root, "sh.iva/tsconfig.json"),
      '{ "include": ["extension/**/*.ts"] }\n',
    );
  }
  if (mcp)
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: mcp,
      }),
    );
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  if (config !== undefined)
    writeFileSync(join(store, `${name}.config.json`), config);
}

/**
 * Тот же фейковый раннер, но со списком шагов: команда, аргументы и cwd. Команда — как
 * её позвали, без basename: «собирал eve этой версии» и «собирал eve с машины» — это
 * разные вещи, и различает их только полный путь.
 */
function recorded(home: string): { runner: Runner; steps: string[] } {
  const base = fixtureRunner();
  const steps: string[] = [];
  return {
    steps,
    runner: (command, args, cwd) => {
      steps.push(
        `${command.startsWith("/") ? relative(home, command) : command} ${args.join(" ")} @ ${relative(home, cwd)}`,
      );
      return base(command, args, cwd);
    },
  };
}

function pluginEntries(home: string): Record<string, boolean> {
  const state = JSON.parse(
    readFileSync(join(layoutFor(home).data, "custom/plugins.json"), "utf8"),
  ) as { plugins: { name: string; enabled: boolean }[] };
  return Object.fromEntries(
    state.plugins.map((entry) => [entry.name, entry.enabled]),
  );
}

test("a plugin with code is copied into the version, built and mounted", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace", { config: '{"level":"debug"}\n' });
  pluginsState(iva.home, [{ name: "trace" }]);
  const { runner, steps } = recorded(iva.home);

  const outcome = updated(await iva.update({ run: runner }));

  const dir = join(iva.home, "versions", outcome.version);
  assert.ok(existsSync(join(dir, "plugins/trace/plugin.json")));
  assert.ok(existsSync(join(dir, "plugins/trace/sh.iva/dist/extension")));
  // The mount is generated, names the plugin by a relative specifier eve resolves,
  // and reads the owner's config at load time instead of baking it into the bundle.
  const mount = readFileSync(join(dir, "agent/extensions/trace.ts"), "utf8");
  assert.match(mount, /Generated by Iva/u);
  assert.match(
    mount,
    /^import extension from "\.\.\/\.\.\/plugins\/trace\/sh\.iva\/\.";$/mu,
  );
  assert.match(
    mount,
    /export default extension\(readPluginConfig\("trace"\)\);/u,
  );
  // Its own dependencies and its own extension build, in that order, in its folder;
  // the agent build comes after both.
  const version = `versions/${outcome.version}`;
  // The eve that builds the plugin is the version's OWN binary, by its full path: a
  // machine-wide `eve` would build the plugin against a different eve than runs it.
  const eve = `${version}/node_modules/.bin/eve`;
  assert.deepEqual(
    steps.filter((step) => step.includes("plugins/trace")),
    [
      `npm install --omit=dev --omit=peer --no-audit --no-fund @ ${version}/plugins/trace/sh.iva`,
      `${eve} extension build @ ${version}/plugins/trace/sh.iva`,
    ],
  );
  assert.ok(
    steps.indexOf(`npm run build @ ${version}`) >
      steps.indexOf(`${eve} extension build @ ${version}/plugins/trace/sh.iva`),
    steps.join("\n"),
  );
  // A plugin is part of what a version is named after, and part of what it carries.
  assert.match(outcome.version, /\+[0-9a-f]{8}$/u);
  assert.equal(outcome.custom, "applied");
});

test("a trusted plugin with only MCP servers is carried as generated connections", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace", {
    code: false,
    mcp: {
      viewer: { type: "stdio", command: "node", args: ["serve.mjs"] },
      api: { type: "streamable-http", url: "https://api.test/mcp" },
    },
  });
  pluginsState(iva.home, [
    { name: "trace", trusted: true, mcp: { viewer: { port: 8731 } } },
  ]);
  const { runner, steps } = recorded(iva.home);

  const outcome = updated(await iva.update({ run: runner }));
  const dir = join(iva.home, "versions", outcome.version);

  // Один файл на сервер, и ничего больше: ни копии плагина, ни mount'а, ни шагов сборки.
  const proxied = readFileSync(
    join(dir, "agent/connections/mcp-trace--viewer.ts"),
    "utf8",
  );
  assert.match(proxied, /url: "http:\/\/127\.0\.0\.1:8731\/mcp"/u);
  assert.match(proxied, /pluginTokenFile\(dataDir\(\), "trace", "viewer"\)/u);
  const remote = readFileSync(
    join(dir, "agent/connections/mcp-trace--api.ts"),
    "utf8",
  );
  assert.match(remote, /url: "https:\/\/api\.test\/mcp"/u);
  assert.equal(existsSync(join(dir, "plugins/trace")), false);
  assert.equal(existsSync(join(dir, "agent/extensions/trace.ts")), false);
  assert.deepEqual(
    steps.filter((step) => step.includes("plugins/trace")),
    [],
  );
  // Плагин без кода, но с MCP — тоже часть того, чем названа версия.
  assert.match(outcome.version, /\+[0-9a-f]{8}$/u);
  assert.equal(outcome.custom, "applied");

  // Снятое доверие убирает connection из версии, и это другая версия.
  pluginsState(iva.home, [{ name: "trace", trusted: false }]);
  const untrusted = updated(await iva.update({ run: runner }));
  assert.notEqual(untrusted.version, outcome.version);
  const after = join(iva.home, "versions", untrusted.version);
  assert.equal(
    existsSync(join(after, "agent/connections/mcp-trace--viewer.ts")),
    false,
  );
});

test("a lockfile in the plugin pins its dependencies instead of resolving them", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace", {
    files: { "sh.iva/package-lock.json": '{"lockfileVersion":3}\n' },
  });
  pluginsState(iva.home, [{ name: "trace" }]);
  const { runner, steps } = recorded(iva.home);

  const outcome = updated(await iva.update({ run: runner }));

  assert.ok(
    steps.includes(
      `npm ci --omit=dev --omit=peer --no-audit --no-fund @ versions/${outcome.version}/plugins/trace/sh.iva`,
    ),
    steps.join("\n"),
  );
});

test("the plugins with code are what a release is named after, their skills are not", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "skills-only", { code: false });
  pluginsState(iva.home, [{ name: "skills-only" }]);
  const bare = updated(await iva.update()).version;
  // A plugin with skills alone changes no version: its skills are live already.
  assert.equal(bare, `0.3.14-${iva.target.sha.slice(0, 12)}`);

  const digests: string[] = [];
  const digest = async (): Promise<string> => {
    const overlay = await versionOverlay(layoutFor(iva.home).data);
    return overlay.digest ?? "";
  };

  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "skills-only" }, { name: "trace" }]);
  digests.push(await digest());
  // The content of the plugin, not the digest recorded for it: an edit in place is a
  // different version, and so is a change to the config beside it.
  plantPlugin(iva.home, "trace", { body: "export default { name: 'y' };\n" });
  digests.push(await digest());
  plantPlugin(iva.home, "trace", {
    body: "export default { name: 'y' };\n",
    config: '{"level":"debug"}\n',
  });
  digests.push(await digest());
  // Switched off, the plugin is out of the build and out of the name.
  pluginsState(iva.home, [
    { name: "skills-only" },
    { name: "trace", enabled: false },
  ]);
  digests.push(await digest());

  assert.equal(new Set(digests).size, 4, digests.join(" "));
  assert.equal(digests[3], "");
});

test("a plugin whose own build fails is switched off and the release still installs", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace", { body: "export const BREAK = 1;\n" });
  plantPlugin(iva.home, "good");
  pluginsState(iva.home, [{ name: "good" }, { name: "trace" }]);
  const alerted: string[][] = [];

  const outcome = updated(
    await iva.update({
      alertPlugins: (failures) => {
        alerted.push(failures.map((failure) => failure.name));
        return Promise.resolve();
      },
    }),
  );

  const dir = join(iva.home, "versions", outcome.version);
  // The box is installed, without the plugin that would not build.
  assert.equal(existsSync(join(dir, "agent/extensions/trace.ts")), false);
  assert.equal(existsSync(join(dir, "plugins/trace")), false);
  assert.ok(existsSync(join(dir, "agent/extensions/good.ts")));
  assert.deepEqual(pluginEntries(iva.home), { good: true, trace: false });
  // One Alert for the build, naming what went off, and the failing step names itself.
  assert.deepEqual(alerted, [["trace"]]);
});

test("a plugin the agent build refuses takes every plugin out with it, once", async (t) => {
  const iva = world(t);
  // The extension itself builds; what the agent build chokes on is beside it, so only
  // the whole-tree build can tell - and then no plugin is above suspicion.
  plantPlugin(iva.home, "trace", {
    files: { "skills/demo/notes.md": "BREAK\n" },
  });
  plantPlugin(iva.home, "good");
  pluginsState(iva.home, [{ name: "good" }, { name: "trace" }]);
  const { runner, steps } = recorded(iva.home);
  const alerted: string[][] = [];

  const outcome = updated(
    await iva.update({
      run: runner,
      alertPlugins: (failures) => {
        alerted.push(failures.map((failure) => failure.name));
        return Promise.resolve();
      },
    }),
  );

  const dir = join(iva.home, "versions", outcome.version);
  assert.equal(existsSync(join(dir, "plugins/trace")), false);
  assert.equal(existsSync(join(dir, "plugins/good")), false);
  assert.deepEqual(pluginEntries(iva.home), { good: false, trace: false });
  assert.deepEqual(alerted, [["good", "trace"]]);
  // Exactly two agent builds: the one that failed and the one without any plugin.
  assert.equal(
    steps.filter(
      (step) => step === `npm run build @ versions/${outcome.version}`,
    ).length,
    2,
    steps.join("\n"),
  );
});

test("with the plugins required, a plugin that will not build fails the whole update", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  plantPlugin(iva.home, "trace", { body: "export const BREAK = 1;\n" });
  pluginsState(iva.home, [{ name: "trace" }]);

  // The throw is what the update's own second half turns into a failed outcome; here
  // it is the seam itself, so the refusal arrives as the rejection.
  await assert.rejects(
    iva.update({ requirePlugins: true }),
    /building the extension of trace/u,
  );

  // Nothing of the installation moved: the version that ran still runs, the plugin is
  // still enabled, and the half-built candidate is gone.
  const store = createVersionStore(iva.home);
  assert.equal(store.currentName(), first.version);
  assert.deepEqual(store.list(), [first.version]);
  assert.deepEqual(pluginEntries(iva.home), { trace: true });
});

test("a plugin the agent build refuses fails a required build without disabling it", async (t) => {
  const iva = world(t);
  const first = updated(await iva.update());
  plantPlugin(iva.home, "trace", {
    files: { "skills/demo/notes.md": "BREAK\n" },
  });
  pluginsState(iva.home, [{ name: "trace" }]);

  await assert.rejects(
    iva.update({ requirePlugins: true }),
    /does not build with trace/u,
  );

  assert.equal(createVersionStore(iva.home).currentName(), first.version);
  assert.deepEqual(createVersionStore(iva.home).list(), [first.version]);
  assert.deepEqual(pluginEntries(iva.home), { trace: true });
});

test("a plugin nothing can read is left out of the build and named", async (t) => {
  const iva = world(t);
  pluginsState(iva.home, [{ name: "ghost" }]);
  const logged: string[] = [];

  const outcome = updated(
    await iva.update({ log: (line) => logged.push(line) }),
  );

  // No folder, no code, no build - and the digest of a version with nothing in it.
  assert.equal(outcome.version, `0.3.14-${iva.target.sha.slice(0, 12)}`);
  assert.ok(
    logged.some((line) => /plugin ghost is left out of this build/u.test(line)),
    logged.join("\n"),
  );
});

test("two plugins that want one mount file are both left out and both named", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "my.tool");
  plantPlugin(iva.home, "my-tool");
  pluginsState(iva.home, [{ name: "my.tool" }, { name: "my-tool" }]);
  const logged: string[] = [];

  const outcome = updated(
    await iva.update({ log: (line) => logged.push(line) }),
  );

  const dir = join(iva.home, "versions", outcome.version);
  assert.equal(existsSync(join(dir, "agent/extensions/my_tool.ts")), false);
  assert.ok(
    logged.some((line) =>
      /my-tool and my\.tool want the same extension mount my_tool\.ts/u.test(
        line,
      ),
    ),
    logged.join("\n"),
  );
});

test("a version that will not start with its plugins is installed without them", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/tools/mine.ts", "export const mine = 1;\n");
  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "trace" }]);
  const notices: string[] = [];
  const alerted: string[][] = [];

  const outcome = updated(
    await iva.update({
      notify: (message) => notices.push(message),
      alertPlugins: (failures) => {
        alerted.push(failures.map((failure) => failure.name));
        return Promise.resolve();
      },
      // The build is green; the start is not - until the plugin is out of the tree.
      probe: (dir, port) =>
        existsSync(join(dir, "agent/extensions/trace.ts"))
          ? Promise.resolve({
              ok: false,
              log: "boom: the plugin took the server down",
            })
          : fixtureProbe()(dir, port),
    }),
  );

  const dir = join(iva.home, "versions", outcome.version);
  // The plugin is out and the owner's own file is still in: a plugin that will not
  // start costs the plugin, not the customization (ADR-0003).
  assert.equal(existsSync(join(dir, "agent/extensions/trace.ts")), false);
  assert.equal(existsSync(join(dir, "plugins/trace")), false);
  assert.equal(
    readFileSync(join(dir, "agent/tools/mine.ts"), "utf8"),
    "export const mine = 1;\n",
  );
  assert.equal(outcome.custom, "applied");
  assert.deepEqual(pluginEntries(iva.home), { trace: false });
  assert.deepEqual(alerted, [["trace"]]);
  // And nothing blames data/custom for what the plugin did.
  assert.deepEqual(
    notices.filter((notice) => /data\/custom/u.test(notice)),
    [],
  );
});

test("a customization that will not start gives way only after the plugins do", async (t) => {
  const iva = world(t);
  customFile(iva.home, "agent/tools/mine.ts", "export const mine = 1;\n");
  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "trace" }]);
  const notices: string[] = [];
  const alerted: string[][] = [];

  const outcome = updated(
    await iva.update({
      notify: (message) => notices.push(message),
      alertPlugins: (failures) => {
        alerted.push(failures.map((failure) => failure.name));
        return Promise.resolve();
      },
      // Nothing of the owner's starts: first the plugin comes out, then the files.
      probe: (dir, port) =>
        existsSync(join(dir, "agent/tools/mine.ts"))
          ? Promise.resolve({ ok: false, log: "boom: nothing of yours starts" })
          : fixtureProbe()(dir, port),
    }),
  );

  const dir = join(iva.home, "versions", outcome.version);
  assert.equal(outcome.custom, "stock");
  assert.equal(existsSync(join(dir, "agent/tools/mine.ts")), false);
  assert.equal(existsSync(join(dir, "plugins/trace")), false);
  assert.deepEqual(pluginEntries(iva.home), { trace: false });
  assert.deepEqual(alerted, [["trace"]]);
  assert.ok(
    notices.some((notice) =>
      /does not start against this version/u.test(notice),
    ),
    notices.join("\n"),
  );
});

test("a plugin that came back is forgiven, so a relapse next week speaks at once", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace", { body: "export const BREAK = 1;\n" });
  pluginsState(iva.home, [{ name: "trace" }]);
  const alertState = join(layoutFor(iva.home).data, "alert-state.json");

  updated(await iva.update());
  // The throttle records only what was really sent, so the test writes the record the
  // real sender would have left and watches the next good build clear it.
  writeFileSync(
    alertState,
    JSON.stringify({
      "plugin-build": { essence: "trace@x", lastSentAt: Date.now() },
    }),
  );

  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "trace" }]);
  const outcome = updated(await iva.update());

  assert.ok(
    existsSync(
      join(iva.home, "versions", outcome.version, "agent/extensions/trace.ts"),
    ),
  );
  assert.deepEqual(JSON.parse(readFileSync(alertState, "utf8")), {});
});

test("a build the plugin was refused in is never handed back as current", async (t) => {
  const iva = world(t);
  // The plugin breaks its own build, so the release installs without it and switches
  // it off - exactly the state `iva update` leaves behind (ADR-0009).
  plantPlugin(iva.home, "trace", { body: "export const BREAK = 1;\n" });
  pluginsState(iva.home, [{ name: "trace" }]);
  const refused = updated(await iva.update()).version;
  assert.deepEqual(pluginEntries(iva.home), { trace: false });

  // The owner fixes the plugin and turns it back on. The release name is the same as
  // the version that runs, and the settled marker names it - but its tree has no code
  // of the plugin, so handing it back would report "enabled" over live skills and no
  // tools. It has to be built again.
  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "trace" }]);
  const outcome = updated(await iva.update());

  assert.notEqual(outcome.version, refused);
  const dir = join(iva.home, "versions", outcome.version);
  assert.ok(existsSync(join(dir, "agent/extensions/trace.ts")));
  assert.equal(createVersionStore(iva.home).currentName(), outcome.version);
  assert.deepEqual(pluginEntries(iva.home), { trace: true });
});

test("a finished build without the plugin code is not reused for one that needs it", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace");
  pluginsState(iva.home, [{ name: "trace" }]);
  const withPlugin = updated(await iva.update()).version;

  // A build of the same release made while the plugin was off: same name, no code.
  // Rolling back onto it and turning the plugin on again must not reuse it - that flip
  // would drop the plugin's code and report success.
  const store = createVersionStore(iva.home);
  const stale = store.nextBuild(releaseOf(withPlugin));
  const dir = store.stage(stale);
  await store.materialize({ sha: iva.target.sha, dir });
  store.linkState(dir);
  mkdirSync(join(dir, ".output"), { recursive: true });
  writeFileSync(
    join(dir, ".output/server.mjs"),
    readFileSync(join(iva.home, "versions", withPlugin, ".output/server.mjs")),
  );
  store.complete(stale);
  store.activate(stale);
  store.settle(stale);

  const outcome = updated(await iva.update());

  assert.notEqual(outcome.version, stale);
  assert.ok(
    existsSync(
      join(iva.home, "versions", outcome.version, "agent/extensions/trace.ts"),
    ),
  );
  assert.deepEqual(pluginEntries(iva.home), { trace: true });
});

test("a plugin without a tsconfig of its own is left out of the build and named", async (t) => {
  const iva = world(t);
  plantPlugin(iva.home, "trace");
  rmSync(
    join(layoutFor(iva.home).data, "custom/plugins/trace/sh.iva/tsconfig.json"),
  );
  pluginsState(iva.home, [{ name: "trace" }]);
  const logged: string[] = [];

  const outcome = updated(
    await iva.update({ log: (line) => logged.push(line) }),
  );

  assert.equal(
    existsSync(
      join(iva.home, "versions", outcome.version, "agent/extensions/trace.ts"),
    ),
    false,
  );
  assert.ok(
    logged.some((line) => /tsconfig\.json/u.test(line)),
    logged.join("\n"),
  );
});

test("a release that names a newer updater is refused before anything is staged", async (t) => {
  const iva = world(t);
  writeFileSync(
    join(iva.repo, "update-compat.json"),
    '{"minUpdater":"99.0.0"}\n',
  );
  iva.release("0.3.15");

  const outcome = await iva.update();

  assert.equal(outcome.status, "too-old", JSON.stringify(outcome));
  assert.equal(
    outcome.status === "too-old" ? outcome.minUpdater : null,
    "99.0.0",
  );
  const store = createVersionStore(iva.home);
  assert.deepEqual(store.list(), []);
  assert.equal(store.currentName(), null);
  assert.deepEqual(iva.restarts, []);
});

test("a marker this updater satisfies leaves the update alone", async (t) => {
  const iva = world(t);
  writeFileSync(
    join(iva.repo, "update-compat.json"),
    '{"minUpdater":"0.0.1"}\n',
  );
  iva.release("0.3.15");

  const outcome = updated(await iva.update());

  assert.equal(outcome.version.startsWith("0.3.15-"), true, outcome.version);
});

test("Google cleanup delegates to the installer's pinned checksum path", async (t) => {
  const iva = world(t);
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const build = fixtureRunner();
  const outcome = updated(
    await iva.update({
      run: (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return build(command, args, cwd);
      },
    }),
  );
  const directory = join(layoutFor(iva.home).versions, outcome.version);
  assert.ok(
    calls.some(
      ({ command, args, cwd }) =>
        command === "bash" &&
        cwd === directory &&
        JSON.stringify(args) ===
          JSON.stringify([
            join(directory, "install.sh"),
            "--update-gws",
            join(homedir(), ".local"),
          ]),
    ),
  );
  assert.ok(
    calls.every(({ args }) => !args.includes("@googleworkspace/cli@latest")),
  );
});
