import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

/**
 * The installer's decisions, generated rather than enumerated. Each one is taken out of
 * install.sh itself and run - never re-implemented here, or the property would only prove
 * that the copy agrees with itself. The example-based anchors live in
 * install-shell.test.ts, which runs the whole script.
 *
 * A failing run prints the seed and the counterexample; replay it by passing that seed to
 * the property: `fc.assert(property, { numRuns: N, seed: <seed>, path: "<path>" })`.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");

/** The exact node program install.sh uses to decide whether node_modules can be kept. */
function depsDecisionProgram(): string {
  const cut =
    /npm_deps_match_lock\(\) \{[\s\S]*?node -e '([\s\S]*?)'\s*\\/u.exec(
      INSTALLER,
    );
  assert.ok(
    cut,
    "install.sh no longer decides dependencies with an inline node program",
  );
  return cut[1];
}

/** The exact shell function of that name, one-liner or block, and nothing around it. */
function shellFunction(name: string): string {
  const cut =
    new RegExp(`^${name}\\(\\) \\{.*\\}$`, "mu").exec(INSTALLER) ??
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "mu").exec(INSTALLER);
  assert.ok(cut, `install.sh no longer defines ${name}()`);
  // A cut that ran past the end of the function would still execute, and would answer for
  // code the test never meant to ask about.
  assert.equal(
    (cut[0].match(/^\w+\(\) \{/gmu) ?? []).length,
    1,
    `the cut for ${name}() swallowed another function:\n${cut[0]}`,
  );
  return cut[0];
}

function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-install-decisions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── The dependency decision ────────────────────────────────────────────────
// npm records what it installed in node_modules/.package-lock.json. The installer keeps
// node_modules only when that record agrees with package-lock.json about every package
// this platform needs; optional and os/cpu-specific entries are absent by design.

type Entry = {
  readonly path: string;
  readonly version: string;
  readonly platform: boolean;
  readonly flag: "optional" | "devOptional" | "os" | "cpu";
};

const entryArbitrary = fc.record({
  path: fc
    .string({
      minLength: 1,
      maxLength: 12,
      unit: fc.constantFrom(..."abcdefg-._@/"),
    })
    .filter((name) => name.trim().length > 0)
    .map((name) => `node_modules/${name}`),
  version: fc
    .tuple(fc.nat({ max: 9 }), fc.nat({ max: 9 }), fc.nat({ max: 9 }))
    .map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
  platform: fc.boolean(),
  flag: fc.constantFrom(
    "optional" as const,
    "devOptional" as const,
    "os" as const,
    "cpu" as const,
  ),
});

const treeArbitrary = fc
  .uniqueArray(entryArbitrary, {
    minLength: 1,
    maxLength: 8,
    selector: (entry) => entry.path,
  })
  .map((entries) => entries as readonly Entry[]);

function lockOf(entries: readonly Entry[]): string {
  const packages: Record<string, Record<string, unknown>> = {
    "": { name: "iva", version: "0.0.0" },
  };
  for (const entry of entries)
    packages[entry.path] = entry.platform
      ? {
          version: entry.version,
          ...(entry.flag === "os"
            ? { os: ["aix"] }
            : entry.flag === "cpu"
              ? { cpu: ["mips"] }
              : { [entry.flag]: true }),
        }
      : { version: entry.version };
  return `${JSON.stringify({ name: "iva", version: "0.0.0", lockfileVersion: 3, requires: true, packages })}\n`;
}

/** What npm writes down after installing that lockfile on this machine. */
function hiddenOf(
  entries: readonly Entry[],
  skipped: ReadonlySet<string> = new Set(),
): string {
  const packages: Record<string, Record<string, unknown>> = {};
  for (const entry of entries)
    if (!skipped.has(entry.path))
      packages[entry.path] = { version: entry.version };
  return `${JSON.stringify({ name: "iva", version: "0.0.0", lockfileVersion: 3, requires: true, packages })}\n`;
}

/** true = keep node_modules, false = install from scratch. Run out of install.sh. */
function decidesToReuse(
  dir: string,
  lock: string,
  hidden: string | null,
): boolean {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package-lock.json"), lock);
  if (hidden === null)
    rmSync(join(dir, "node_modules/.package-lock.json"), { force: true });
  else writeFileSync(join(dir, "node_modules/.package-lock.json"), hidden);
  return (
    spawnSync(process.execPath, ["-e", depsDecisionProgram()], {
      cwd: dir,
      encoding: "utf8",
    }).status === 0
  );
}

void test("dependencies are kept exactly when npm's own record still matches the lockfile", (t) => {
  const dir = workspace(t);
  fc.assert(
    fc.property(treeArbitrary, (entries) => {
      // An empty record is never agreement: nothing distinguishes "this platform needed
      // none of them" from a truncated file, and reusing an empty node_modules on a
      // truncated file is the expensive mistake.
      fc.pre(entries.some((entry) => !entry.platform));
      // npm installs every entry this platform needs and skips the platform-specific ones.
      const skipped = new Set(
        entries.filter((entry) => entry.platform).map((entry) => entry.path),
      );
      assert.equal(
        decidesToReuse(dir, lockOf(entries), hiddenOf(entries, skipped)),
        true,
      );
      // Keeping the platform-specific ones as well is still agreement.
      assert.equal(
        decidesToReuse(dir, lockOf(entries), hiddenOf(entries)),
        true,
      );
    }),
    { numRuns: 60 },
  );
});

void test("one disagreeing package is enough to reinstall everything", (t) => {
  const dir = workspace(t);
  fc.assert(
    fc.property(
      treeArbitrary,
      fc.nat(),
      fc.constantFrom("drop", "version", "extra", "empty", "missing"),
      (entries, pick, mutation) => {
        const required = entries.filter((entry) => !entry.platform);
        // A tree with nothing required cannot lose a required package.
        fc.pre(required.length > 0 || mutation !== "drop");
        const lock = lockOf(entries);
        const skipped = new Set(
          entries.filter((entry) => entry.platform).map((entry) => entry.path),
        );
        let hidden: string | null = hiddenOf(entries, skipped);
        if (mutation === "drop") {
          const victim = required[pick % required.length];
          hidden = hiddenOf(entries, new Set([...skipped, victim.path]));
        } else if (mutation === "version") {
          const victim = entries[pick % entries.length];
          hidden = hiddenOf(
            entries.map((entry) =>
              entry.path === victim.path
                ? { ...entry, version: `${entry.version}-other` }
                : entry,
            ),
            new Set([...skipped].filter((path) => path !== victim.path)),
          );
        } else if (mutation === "extra") {
          const parsed = JSON.parse(hidden) as {
            packages: Record<string, unknown>;
          };
          parsed.packages["node_modules/never-in-the-lockfile"] = {
            version: "1.0.0",
          };
          hidden = `${JSON.stringify(parsed)}\n`;
        } else if (mutation === "empty") {
          hidden = `${JSON.stringify({ packages: {} })}\n`;
        } else {
          hidden = null; // npm's record is gone: nothing is known about node_modules
        }
        assert.equal(decidesToReuse(dir, lock, hidden), false);
      },
    ),
    { numRuns: 60 },
  );
});

// ── The build decision ─────────────────────────────────────────────────────
// The stamp inside .output has to answer one question: is this output still the one this
// source state produces? Same state, same answer; any change to the state, a different
// answer - otherwise a re-run ships an output that no longer matches the code.

type Source = {
  readonly tracked: string;
  readonly untrackedName: string;
  readonly untracked: string;
  readonly env: string;
  readonly commits: number;
};

const fileText = fc.string({ maxLength: 24 });
const fileName = fc
  .string({
    minLength: 1,
    maxLength: 10,
    unit: fc.constantFrom(..."abc de.-_"),
  })
  .map((name) => name.trim())
  .filter((name) => name.length > 0 && !name.startsWith("."));
const sourceArbitrary: fc.Arbitrary<Source> = fc.record({
  tracked: fileText,
  untrackedName: fileName,
  untracked: fileText,
  env: fileText,
  commits: fc.nat({ max: 2 }),
});

/**
 * One input at a time, so every dimension is really exercised: two independently drawn
 * states almost never share an untracked filename, and a fingerprint that ignored what is
 * inside those files would pass unnoticed.
 */
const deltaArbitrary = fc.oneof(
  fc.record({ field: fc.constant("tracked" as const), value: fileText }),
  fc.record({ field: fc.constant("untrackedName" as const), value: fileName }),
  fc.record({ field: fc.constant("untracked" as const), value: fileText }),
  fc.record({ field: fc.constant("env" as const), value: fileText }),
  fc.record({
    field: fc.constant("commits" as const),
    value: fc.nat({ max: 2 }),
  }),
);

function fingerprintOf(dir: string): string {
  return execFileSync(
    "bash",
    [
      "-c",
      `set -Eeuo pipefail\nPROJECT_DIR="$1"\n${shellFunction("install_build_fingerprint")}\ninstall_build_fingerprint`,
      "fingerprint",
      dir,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  ).trim();
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.invalid",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
}

/** Puts a checkout into exactly the described state and reports what it fingerprints as. */
function stateFingerprint(dir: string, source: Source): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "tracked.ts"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "seed");
  for (let commit = 0; commit < source.commits; commit++)
    git(dir, "commit", "--quiet", "--allow-empty", "-m", `commit-${commit}`);
  writeFileSync(join(dir, "tracked.ts"), source.tracked);
  writeFileSync(join(dir, source.untrackedName), source.untracked);
  writeFileSync(join(dir, ".env"), source.env);
  return fingerprintOf(dir);
}

void test("the build stamp changes with the source state and with nothing else", (t) => {
  const dir = join(workspace(t), "checkout");
  fc.assert(
    fc.property(sourceArbitrary, deltaArbitrary, (base, delta) => {
      const first = stateFingerprint(dir, base);
      // Same state, rebuilt from scratch: an answer that moves on its own would make every
      // re-run repeat the build it was supposed to skip.
      assert.equal(stateFingerprint(dir, base), first);
      const changed = { ...base, [delta.field]: delta.value };
      const second = stateFingerprint(dir, changed);
      assert.equal(
        first !== second,
        base[delta.field] !== delta.value,
        `${delta.field}: ${JSON.stringify(base[delta.field])} → ${JSON.stringify(delta.value)}`,
      );
    }),
    { numRuns: 30 },
  );
});

// ── The two package-manager readings ───────────────────────────────────────
// Both are one-line shell predicates over output nobody controls, so garbage must neither
// break them nor produce a confident wrong answer.

function shellPredicate(name: string, body: string, argument: string): boolean {
  return (
    spawnSync(
      "bash",
      [
        "-c",
        `set -Eeuo pipefail\n${body}\n${name} "$1"`,
        "predicate",
        argument,
      ],
      { encoding: "utf8" },
    ).status === 0
  );
}

void test("dpkg is called broken exactly when it reported something", () => {
  const body = shellFunction("dpkg_state_is_broken");
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), (output) => {
      assert.equal(
        shellPredicate("dpkg_state_is_broken", body, output),
        output.trim().length > 0,
      );
    }),
    { numRuns: 60 },
  );
  // The shapes that matter, pinned: silence and blank lines are a healthy database.
  for (const quiet of ["", "\n", "  \n\t\n"])
    assert.equal(shellPredicate("dpkg_state_is_broken", body, quiet), false);
  assert.equal(
    shellPredicate(
      "dpkg_state_is_broken",
      body,
      "The following packages are only half installed:\n linux-headers-6.8.0-137\n",
    ),
    true,
  );
});

void test("a pending reboot counts as a kernel one exactly when a linux package asks for it", (t) => {
  const dir = workspace(t);
  const body = shellFunction("reboot_needs_kernel");
  const file = join(dir, "reboot-required.pkgs");
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ maxLength: 20 }).filter((line) => !line.includes("\n")),
        {
          maxLength: 6,
        },
      ),
      (lines) => {
        writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
        assert.equal(
          shellPredicate("reboot_needs_kernel", body, file),
          lines.some((line) => line.startsWith("linux-")),
        );
      },
    ),
    { numRuns: 60 },
  );
  // A file that is not there at all is not an answer either.
  assert.equal(
    shellPredicate("reboot_needs_kernel", body, join(dir, "absent.pkgs")),
    false,
  );
});

// ── The copy of .env ───────────────────────────────────────────────────────
// The file holds every key the installation has. What matters is not the mode it ends up
// with but the mode it has while it is being written, and that a copy nobody finished can
// never replace one that was.

/** Runs the real copy against a source that only produces bytes when told to. */
function copyingEnv(dir: string, destination: string) {
  const source = join(dir, ".env");
  execFileSync("mkfifo", [source]);
  chmodSync(source, 0o644);
  const child = spawn(
    "bash",
    [
      "-c",
      `set -Eeuo pipefail\nPROJECT_DIR="$1"\n${shellFunction("copy_env_private")}\ncopy_env_private "$2"`,
      "copy",
      dir,
      destination,
    ],
    { stdio: "ignore" },
  );
  return {
    child,
    /** Unblocks the copy by writing the file's contents into the pipe. */
    write: (text: string) => writeFileSync(source, text),
    done: new Promise<number>((resolve) =>
      child.on("close", (code) => resolve(code ?? 1)),
    ),
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 10000; waited += 20) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

void test("the copy of .env is private before it holds anything", async (t) => {
  const dir = workspace(t);
  const home = join(dir, "backups");
  mkdirSync(home, { recursive: true });
  const destination = join(home, ".env-copy");

  const copy = copyingEnv(dir, destination);
  t.after(() => copy.child.kill("SIGKILL"));

  // The first thing that appears where the copy is being made - whatever the copy calls it
  // - already has to be private, because the secret is written into it next.
  await until(() => readdirSync(home).length > 0, "the copy to appear");
  const [name] = readdirSync(home);
  const early = statSync(join(home, name));
  assert.equal(
    (early.mode & 0o777).toString(8),
    "600",
    `the copy was created as ${(early.mode & 0o777).toString(8)} and only tightened later`,
  );
  assert.equal(early.size, 0, "content was written before the mode was set");

  copy.write("TELEGRAM_BOT_TOKEN=secret\n");
  assert.equal(await copy.done, 0);
  assert.equal(
    readFileSync(destination, "utf8"),
    "TELEGRAM_BOT_TOKEN=secret\n",
  );
  assert.equal((statSync(destination).mode & 0o777).toString(8), "600");
});

void test("a copy of .env that was never finished cannot replace a whole one", async (t) => {
  const dir = workspace(t);
  const home = join(dir, "backups");
  mkdirSync(home, { recursive: true });
  const destination = join(home, ".env-copy");
  // The copy from a run that did finish, which this one must not damage.
  writeFileSync(destination, "TELEGRAM_BOT_TOKEN=whole\n", { mode: 0o600 });

  const copy = copyingEnv(dir, destination);
  // Always killed, whatever the copy did with the pipe: a child still holding it open
  // would keep the whole test process alive.
  t.after(() => copy.child.kill("SIGKILL"));
  await until(
    () => readdirSync(home).length > 1,
    "the copy to start being written",
  );
  copy.child.kill("SIGKILL");
  await copy.done;

  // Killed mid-write, and the good copy is untouched: the name it is under is only ever
  // taken by a file that is complete.
  assert.equal(
    readFileSync(destination, "utf8"),
    "TELEGRAM_BOT_TOKEN=whole\n",
    "an unfinished copy overwrote the copy that was whole",
  );
});

// ── Выпуск новой установки (ADR-0017) ──────────────────────────────────────
// Новейший выпуск vX.Y.Z на ветке, без меток — вершина; IVA_BETA=1 — вершина и
// iva.beta=true. Ветка остаётся той же.
void test("новая установка: новейший выпуск на той же ветке, меток нет — вершина, IVA_BETA=1 — вершина и iva.beta", (t) => {
  const dir = workspace(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (message: string) => {
    git(
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      message,
      "--allow-empty",
    );
    return git("rev-parse", "HEAD");
  };
  const run = (beta = "") =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\n${shellFunction("checkout_release")}\ncheckout_release "$1"`,
        "_",
        dir,
      ],
      { encoding: "utf8", env: { ...process.env, IVA_BETA: beta } },
    );
  const bare = commit("old");
  assert.equal(run().status, 0);
  assert.equal(git("rev-parse", "HEAD"), bare, "no release: the tip");
  git("tag", "v0.4.8");
  commit("after 0.4.8");
  assert.equal(run().status, 0);
  assert.equal(
    git("rev-parse", "HEAD"),
    bare,
    "a release of any age is the release: no version is special",
  );
  git("tag", "v0.4.9", commit("0.4.9"));
  const release = git("rev-parse", "HEAD");
  git("tag", "v0.4.10-beta.1", commit("beta"));
  const tip = commit("tip");
  assert.equal(run().status, 0);
  assert.equal(git("rev-parse", "HEAD"), release);
  assert.equal(git("branch", "--show-current"), "main");
  assert.throws(() => git("config", "--local", "--get", "iva.beta"));
  git("reset", "-q", "--hard", tip);
  assert.equal(run("1").status, 0);
  assert.equal(git("rev-parse", "HEAD"), tip);
  assert.equal(git("config", "--local", "--get", "iva.beta"), "true");
});

void test("repair.sh несёт ту же checkout_release, что install.sh, байт в байт", () => {
  const repair = readFileSync(join(ROOT, "repair.sh"), "utf8");
  assert.ok(repair.includes(shellFunction("checkout_release")));
});

// ADR-0018: IVA_BETA=1 — ветка beta, её вершина, iva.updateBranch=beta и iva.beta=true;
// без неё — main и новейший выпуск. Шаги установщика дословно: шапка, клон, выпуск, ветка.
void test("IVA_BETA=1: вершина ветки beta и ветка beta; без неё — выпуск main", (t) => {
  const dir = workspace(t);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "init", "-q", "-b", "main", seed);
  const commit = (message: string) => {
    git(
      seed,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      message,
      "--allow-empty",
    );
    return git(seed, "rev-parse", "HEAD");
  };
  git(seed, "tag", "v0.4.9", commit("0.4.9"));
  const release = git(seed, "rev-parse", "HEAD");
  commit("after release");
  git(seed, "switch", "-q", "-c", "beta");
  const tip = commit("beta tip");
  git(seed, "push", "-q", "--tags", remote, "main", "beta");
  const header = /^REPO_URL=[\s\S]*?^UPDATE_CHANNEL=.*$/mu.exec(INSTALLER);
  assert.ok(header, "install.sh no longer sets REPO_URL … UPDATE_CHANNEL");
  const install = (name: string, beta: string, branch?: string) => {
    const target = join(dir, name);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BRANCH;
    if (branch) env.BRANCH = branch;
    const run = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\n${header[0]}\n${shellFunction("checkout_release")}\ngit clone -q --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"\ncheckout_release "$INSTALL_DIR"\ngit -C "$INSTALL_DIR" config --local iva.updateBranch "$UPDATE_CHANNEL"`,
      ],
      {
        encoding: "utf8",
        env: { ...env, IVA_BETA: beta, REPO_URL: remote, INSTALL_DIR: target },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const config = (key: string) =>
      spawnSync("git", ["-C", target, "config", "--local", "--get", key], {
        encoding: "utf8",
      }).stdout.trim();
    return {
      head: git(target, "rev-parse", "HEAD"),
      branch: config("iva.updateBranch"),
      beta: config("iva.beta"),
    };
  };
  assert.deepEqual(install("beta", "1"), {
    head: tip,
    branch: "beta",
    beta: "true",
  });
  assert.deepEqual(install("stable", ""), {
    head: release,
    branch: "main",
    beta: "",
  });
});

// Круг 2: IVA_BETA=1 всегда ставит ветку beta; чужой BRANCH — одна строка предупреждения.
void test("IVA_BETA=1 с BRANCH=dev: ветка beta и строка о том, что dev пропущен", (t) => {
  const dir = workspace(t);
  const header = /^REPO_URL=[\s\S]*?^UPDATE_CHANNEL=.*$/mu.exec(INSTALLER);
  assert.ok(header);
  const run = spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${header[0]}\necho "$BRANCH $UPDATE_CHANNEL"`],
    {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, IVA_BETA: "1", BRANCH: "dev" },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "beta beta");
  assert.match(run.stderr, /BRANCH=dev.*beta/u);
});

// Повторный запуск над существующей установкой: выбор беты записан в зеркало и в .git до
// передачи обновлятору — иначе repair.sh на версионной раскладке уходит в current раньше.
void test("IVA_BETA=1 над существующей установкой: ветка beta и флаг в зеркале и .git", (t) => {
  const dir = workspace(t);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", join(dir, "repo")]);
  execFileSync("git", ["init", "-q", dir]);
  git(join(dir, "repo"), "config", "iva.updateBranch", "main");
  const run = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail\n${shellFunction("record_beta_choice")}\nrecord_beta_choice`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, IVA_BETA: "1", INSTALL_DIR: dir },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  for (const repo of [join(dir, "repo"), dir]) {
    assert.equal(git(repo, "config", "--get", "iva.updateBranch"), "beta");
    assert.equal(git(repo, "config", "--get", "iva.beta"), "true");
  }
});
