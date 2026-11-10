/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createVersionStore, versionName } from "./lib/version-store.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPAIR = join(ROOT, "repair.sh");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      // Чужая среда (агентная сессия) может подменять адреса через GIT_CONFIG_*.
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.invalid",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.invalid",
    },
  }).trim();
}

/**
 * A checkout with an origin of its own and no network anywhere near it: the remote is a
 * bare repository beside it, which is all `git fetch origin <branch>` needs. `iva update`
 * itself is a stub on PATH, because what this script decides is which command runs and
 * with what left on disk - not what an update then does.
 */
function checkout(t: TestContext): {
  install: string;
  remote: string;
  handoff: string;
  run: (env?: Record<string, string>) => string;
} {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "iva-repair-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote.git");
  const source = join(fixture, "source");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  const handoff = join(fixture, "handoff.log");

  git(fixture, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), '{ "name": "iva" }\n');
  mkdirSync(join(source, "bin"), { recursive: true });
  writeFileSync(join(source, "bin/iva.mjs"), "// released updater\n");
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "release");
  git(source, "push", "--quiet", remote, "main");
  git(fixture, "clone", "--quiet", remote, install);

  // `node` the script calls is the real one; the tree's entry point writes down that it
  // was handed the update and stops.
  mkdirSync(fakeBin, { recursive: true });
  const runner = join(fakeBin, "node");
  writeFileSync(
    runner,
    `#!/bin/sh\nif [ "\${2:-}" = "update" ]; then printf '%s\\n' "$1" >> "$IVA_TEST_HANDOFF"; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
  );
  chmodSync(runner, 0o755);

  return {
    install,
    remote,
    handoff,
    run: (env = {}) =>
      execFileSync("bash", [REPAIR], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          // Чужая среда (агентная сессия) может подменять адреса через GIT_CONFIG_*.
          GIT_CONFIG_COUNT: "0",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          IVA_INSTALL_DIR: install,
          IVA_TEST_HANDOFF: handoff,
          AGENT_LANGUAGE: "en",
          ...env,
        },
      }),
  };
}

test("repair puts a dirty checkout back on its branch and hands the update over", (t) => {
  const { install, handoff, run } = checkout(t);
  const released = readFileSync(join(install, "bin/iva.mjs"), "utf8");
  writeFileSync(join(install, "bin/iva.mjs"), "// my own updater\n");
  writeFileSync(join(install, "notes.md"), "# mine\n");
  mkdirSync(join(install, "data"), { recursive: true });
  writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');
  writeFileSync(join(install, ".env"), "IVA_PORT=8723\n");

  const output = run();

  // Правки в коде затёрты - это решение владельца, и оно сказано вслух.
  assert.equal(readFileSync(join(install, "bin/iva.mjs"), "utf8"), released);
  assert.match(output, /Local changes to Iva's code were removed\./u);
  // Данные и неотслеживаемое - пользователя, их не трогает никто.
  assert.equal(
    readFileSync(join(install, "data/settings.json"), "utf8"),
    '{"saved":true}\n',
  );
  assert.equal(readFileSync(join(install, ".env"), "utf8"), "IVA_PORT=8723\n");
  assert.equal(readFileSync(join(install, "notes.md"), "utf8"), "# mine\n");
  // И весь ремонт дальше - один обновлятор, из дерева, которое только что обновили.
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "bin/iva.mjs")}\n`,
  );
});

test("repair follows the branch the installation was rolled back onto", (t) => {
  const { install, remote, handoff, run } = checkout(t);
  // `iva rollback` записывает канал сюда: ремонт, вернувший человека на main, отменил бы
  // откат, которым он и спасся.
  git(install, "config", "iva.updateBranch", "release/0.4.0");
  const pinned = git(install, "rev-parse", "HEAD");
  git(install, "push", "--quiet", remote, `${pinned}:refs/heads/release/0.4.0`);
  writeFileSync(join(install, "bin/iva.mjs"), "// my own updater\n");

  const output = run();

  assert.match(output, /release\/0\.4\.0/u);
  assert.equal(git(install, "rev-parse", "HEAD"), pinned);
  assert.equal(
    readFileSync(join(install, "bin/iva.mjs"), "utf8"),
    "// released updater\n",
  );
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "bin/iva.mjs")}\n`,
  );
});

test("repair on the version layout only starts the updater that is already there", (t) => {
  const { install, handoff, run } = checkout(t);
  // Конвертированная установка: чекаута нет, есть `current` - и ремонт ему и отдаёт работу.
  rmSync(join(install, ".git"), { recursive: true, force: true });
  mkdirSync(join(install, "versions/0.4.2-abcdefabcdef/bin"), {
    recursive: true,
  });
  mkdirSync(join(install, "current/bin"), { recursive: true });
  writeFileSync(join(install, "current/bin/iva.mjs"), "// version entry\n");

  run();

  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "current/bin/iva.mjs")}\n`,
  );
});

test("repair refuses a directory that is not an Iva installation", (t) => {
  const { install, run } = checkout(t);
  writeFileSync(join(install, "package.json"), '{ "name": "not-iva" }\n');
  git(install, "commit", "--quiet", "-am", "someone else's tree");

  const failure = (() => {
    try {
      return { output: run(), status: 0 };
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      return { output: String(failed.stderr), status: failed.status };
    }
  })();

  assert.equal(failure.status, 1);
  assert.match(failure.output, /this is not an Iva installation/u);
});

/**
 * Дерево, которое владелец сам помеченным `.iva-dev`: ремонт к нему не прикасается.
 * `git reset --hard` стёр бы незакоммиченную работу, а обновление такому дереву всё равно
 * отказывает - тогда правки потеряны, а обновление не сделано.
 */
test("repair refuses a development checkout and leaves the work on disk", (t) => {
  const { install, handoff, run } = checkout(t);
  writeFileSync(join(install, "bin/iva.mjs"), "// work in progress\n");
  // Маркер в любой форме, как его читает предикат маршрута: каталог - тоже маркер, и
  // раньше `-f` его не видел, а `reset --hard` ниже стирал незакоммиченную работу.
  mkdirSync(join(install, ".iva-dev"));
  const head = git(install, "rev-parse", "HEAD");

  const failure = (() => {
    try {
      return { output: run(), status: 0 };
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      return { output: String(failed.stderr), status: failed.status };
    }
  })();

  assert.equal(failure.status, 1);
  assert.match(failure.output, /development checkout \(\.iva-dev\)/u);
  // Работа на месте, история не двинулась, обновление никому не передано.
  assert.equal(
    readFileSync(join(install, "bin/iva.mjs"), "utf8"),
    "// work in progress\n",
  );
  assert.equal(git(install, "rev-parse", "HEAD"), head);
  assert.throws(() => readFileSync(handoff, "utf8"));
});

/**
 * Маркер судит только чекаут: версионную раскладку обновляют всегда, как и решает
 * `isManagedInstall`. Иначе файл, оставшийся в корне установки от чекаутной эпохи,
 * запирал бы ремонт навсегда.
 */
test("repair updates the version layout whatever lies in its root", (t) => {
  const { install, handoff, run } = checkout(t);
  rmSync(join(install, ".git"), { recursive: true, force: true });
  mkdirSync(join(install, "current/bin"), { recursive: true });
  writeFileSync(join(install, "current/bin/iva.mjs"), "// version entry\n");
  writeFileSync(join(install, ".iva-dev"), "");

  run();

  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "current/bin/iva.mjs")}\n`,
  );
});

/**
 * Обрыв на переключении версий: `versions/` есть, `current` потерян, чекаута уже нет.
 * Ремонт обязан запустить обновлятор из версии на диске - он переключение и доводит.
 */
test("repair starts the update from the version on disk when current is lost", (t) => {
  const { install, handoff, run } = checkout(t);
  rmSync(join(install, ".git"), { recursive: true, force: true });
  mkdirSync(join(install, "versions/0.4.1-aaaaaaaaaaaa/bin"), {
    recursive: true,
  });
  writeFileSync(
    join(install, "versions/0.4.1-aaaaaaaaaaaa/bin/iva.mjs"),
    "// older version\n",
  );
  mkdirSync(join(install, "versions/0.4.2-bbbbbbbbbbbb/bin"), {
    recursive: true,
  });
  writeFileSync(
    join(install, "versions/0.4.2-bbbbbbbbbbbb/bin/iva.mjs"),
    "// newest version\n",
  );
  // Свежесть версии ремонт судит по времени файла; часы ядра Linux идут шагом в несколько
  // миллисекунд, и два файла, записанные подряд, получают одно время.
  utimesSync(
    join(install, "versions/0.4.1-aaaaaaaaaaaa/bin/iva.mjs"),
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:00Z"),
  );
  utimesSync(
    join(install, "versions/0.4.2-bbbbbbbbbbbb/bin/iva.mjs"),
    new Date("2026-01-02T00:00:00Z"),
    new Date("2026-01-02T00:00:00Z"),
  );

  const output = run();

  assert.match(output, /stopped while switching versions/u);
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "versions/0.4.2-bbbbbbbbbbbb/bin/iva.mjs")}\n`,
  );
});

/**
 * У установки может не быть remote-tracking ref на канал (клон без него, свёрнутый
 * refspec): `git fetch origin <ветка>` пишет тогда только FETCH_HEAD, и ремонт обязан
 * работать по нему, а не падать на `origin/<ветка>`.
 */
test("repair resets onto what it fetched, with no remote-tracking ref to read", (t) => {
  const { install, remote, handoff, run } = checkout(t);
  const released = readFileSync(join(install, "bin/iva.mjs"), "utf8");
  git(install, "config", "--unset-all", "remote.origin.fetch");
  git(install, "update-ref", "-d", "refs/remotes/origin/main");
  writeFileSync(join(install, "bin/iva.mjs"), "// my own updater\n");
  const released_head = git(remote, "rev-parse", "main");

  run();

  assert.equal(git(install, "rev-parse", "HEAD"), released_head);
  assert.equal(readFileSync(join(install, "bin/iva.mjs"), "utf8"), released);
  assert.equal(
    readFileSync(handoff, "utf8"),
    `${join(install, "bin/iva.mjs")}\n`,
  );
});

/**
 * Ремонт тянет код и сразу его запускает: из чужого origin - никогда.
 */
test("repair refuses an installation whose origin is not the project", (t) => {
  const { install, run } = checkout(t);
  git(
    install,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/iva.git",
  );

  const failure = (() => {
    try {
      return { output: run(), status: 0 };
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      return { output: String(failed.stderr), status: failed.status };
    }
  })();

  assert.equal(failure.status, 1);
  assert.match(failure.output, /origin is not github\.com\/smixs\/iva-agent/u);
});

// Выпуски (ADR-0017): ремонт чекаута ставит новейший выпуск vX.Y.Z, без меток — вершину;
// при бета-обновлениях — вершину.
function publish(remote: string, tag: string | null, fixture: string): string {
  const work = join(fixture, `work-${Date.now()}-${Math.random()}`);
  git(fixture, "clone", "--quiet", remote, work);
  writeFileSync(join(work, "bin/iva.mjs"), `// ${tag ?? "tip"}\n`);
  git(work, "commit", "--quiet", "-am", tag ?? "tip");
  if (tag) git(work, "tag", tag);
  git(work, "push", "--quiet", "--tags", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

test("repair puts a checkout on the newest release, without one on the tip; beta updates — the tip", (t) => {
  const { install, remote, run } = checkout(t);
  const fixture = join(install, "..");
  const untagged = publish(remote, null, fixture);
  run();
  assert.equal(git(install, "rev-parse", "HEAD"), untagged, "no release");

  const release = publish(remote, "v0.4.9", fixture);
  publish(remote, "v0.4.10-beta.1", fixture);
  const tip = publish(remote, null, fixture);
  run();
  assert.equal(git(install, "rev-parse", "HEAD"), release);
  assert.equal(git(install, "branch", "--show-current"), "main");

  // Прежний флаг при main ремонт переводит на ветку beta (ADR-0018), как обновлятор.
  git(remote, "update-ref", "refs/heads/beta", tip);
  git(install, "config", "iva.beta", "true");
  run();
  assert.equal(git(install, "rev-parse", "HEAD"), tip);
  assert.equal(git(install, "config", "--get", "iva.updateBranch"), "beta");
});

// ADR-0018: бета — ветка beta; ремонт на beta ставит её вершину, на main — выпуск, но
// установку новее выпуска не откатывает (ADR-0017: обновление назад не ходит).
test("repair on beta takes the beta tip; on main it keeps an installation newer than the release", (t) => {
  const { install, remote, run } = checkout(t);
  const fixture = join(install, "..");
  const release = publish(remote, "v0.4.9", fixture);
  const newer = publish(remote, null, fixture);
  const betaTip = (() => {
    const work = join(fixture, "work-beta");
    git(fixture, "clone", "--quiet", remote, work);
    git(work, "switch", "--quiet", "-c", "beta");
    writeFileSync(join(work, "bin/iva.mjs"), "// beta\n");
    git(work, "commit", "--quiet", "-am", "beta");
    git(work, "push", "--quiet", "origin", "beta");
    return git(work, "rev-parse", "HEAD");
  })();

  git(install, "fetch", "--quiet", "origin", "main");
  git(install, "reset", "--quiet", "--hard", newer);
  run();
  assert.equal(
    git(install, "rev-parse", "HEAD"),
    newer,
    "newer than v0.4.9: stays",
  );
  git(install, "reset", "--quiet", "--hard", `${release}~1`);
  run();
  assert.equal(
    git(install, "rev-parse", "HEAD"),
    release,
    "older: the release",
  );
  // Бета-сборка после iva stable (ветка main, iva.beta нет): новее выпуска, остаётся.
  git(install, "fetch", "--quiet", "origin", "beta");
  git(install, "reset", "--quiet", "--hard", betaTip);
  run();
  assert.equal(
    git(install, "rev-parse", "HEAD"),
    betaTip,
    "a beta build: stays",
  );

  run({ IVA_BETA: "1" });
  assert.equal(git(install, "rev-parse", "HEAD"), betaTip);
  assert.equal(git(install, "config", "--get", "iva.updateBranch"), "beta");
  assert.equal(git(install, "config", "--get", "iva.beta"), "true");
  run();
  assert.equal(
    git(install, "rev-parse", "HEAD"),
    betaTip,
    "beta: the tip of beta",
  );
});

/** Ветка beta в origin на шаг впереди main: коммит бета-сборки. */
function betaBuild(remote: string, fixture: string): string {
  const work = join(fixture, `work-beta-${Math.random()}`);
  git(fixture, "clone", "--quiet", remote, work);
  git(work, "switch", "--quiet", "-c", "beta");
  writeFileSync(join(work, "bin/iva.mjs"), "// beta build\n");
  git(work, "commit", "--quiet", "-am", "beta build");
  git(work, "push", "--quiet", "--force", "origin", "beta");
  return git(work, "rev-parse", "HEAD");
}

// Круг 2 (QA D1): настоящая картина после перевода — main = v0.4.8, бета-сборка в beta.
// Checkout на бета-сборке с веткой main ремонт не откатывает на v0.4.8.
test("repair on main keeps a beta build when main is still v0.4.8", (t) => {
  const { install, remote, run } = checkout(t);
  const fixture = join(install, "..");
  publish(remote, "v0.4.8", fixture);
  const build = betaBuild(remote, fixture);
  git(install, "fetch", "--quiet", "origin", "beta");
  git(install, "reset", "--quiet", "--hard", build);

  run();

  assert.equal(git(install, "rev-parse", "HEAD"), build);
});

// Своя ветка (iva rollback → release/<v>): ремонт идёт только за ней, бета-сборка в
// посторонней ветке beta ничего для неё не доказывает.
test("repair on a pinned release branch goes to that branch, not to a beta build", (t) => {
  const { install, remote, run } = checkout(t);
  const fixture = join(install, "..");
  const release = publish(remote, "v0.4.9", fixture);
  git(remote, "update-ref", "refs/heads/release/0.4.9", release);
  const build = betaBuild(remote, fixture);
  git(install, "config", "iva.updateBranch", "release/0.4.9");
  git(install, "fetch", "--quiet", "origin", "beta");
  git(install, "reset", "--quiet", "--hard", build);

  run();

  assert.equal(git(install, "rev-parse", "HEAD"), release);
});

// origin не отвечает: ремонт ничего не сбрасывает, одна строка и ненулевой код.
test("repair with origin unreachable changes nothing and says so", (t) => {
  const { install, run } = checkout(t);
  writeFileSync(join(install, "bin/iva.mjs"), "// my own updater\n");
  const head = git(install, "rev-parse", "HEAD");
  git(
    install,
    "remote",
    "set-url",
    "origin",
    "git@github.com:smixs/iva-agent.git",
  );

  const failure = (() => {
    try {
      return { output: run({ GIT_SSH_COMMAND: "false" }), status: 0 };
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      return { output: String(failed.stderr), status: failed.status };
    }
  })();

  assert.notEqual(failure.status, 0);
  assert.match(failure.output, /can't check origin/u);
  assert.equal(git(install, "rev-parse", "HEAD"), head);
  assert.equal(
    readFileSync(join(install, "bin/iva.mjs"), "utf8"),
    "// my own updater\n",
  );
});

// ── Круг 3: таблица отказов repair.sh ────────────────────────────────────────────────
// Шаги, которые меняют состояние или ходят в сеть: ls-remote, fetch голов, fetch ветки,
// fetch меток, reset, запись iva.updateBranch (миграция прежнего флага). Двойник git на PATH
// роняет ровно один шаг (IVA_FAIL_GIT — регулярное выражение по аргументам). Инвариант:
// состояние (HEAD, рабочее дерево, ветка и флаг) не изменилось, либо доведено до конца —
// вершина beta и бета по ветке или флагу. Отказ никогда не даёт отката.
function failureTable(t: TestContext) {
  const fx = checkout(t);
  const fixture = join(fx.install, "..");
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(fixture, "bin", "git"),
    `#!/bin/sh\nif [ -n "$IVA_FAIL_GIT" ] && printf '%s' "$*" | grep -Eq -e "$IVA_FAIL_GIT"; then echo "fatal: injected" >&2; exit 128; fi\nexec ${real} "$@"\n`,
  );
  chmodSync(join(fixture, "bin", "git"), 0o755);
  const release = publish(fx.remote, "v0.4.9", fixture);
  const work = join(fixture, "work-table");
  git(fixture, "clone", "--quiet", fx.remote, work);
  git(work, "switch", "--quiet", "-c", "beta", release);
  const commitBeta = (text: string) => {
    writeFileSync(join(work, "bin/iva.mjs"), `// ${text}\n`);
    git(work, "commit", "--quiet", "-am", text);
    git(work, "push", "--quiet", "--force", "origin", "beta");
    return git(work, "rev-parse", "HEAD");
  };
  const build = commitBeta("beta build");
  const tip = commitBeta("beta tip");
  const config = (key: string) =>
    spawnSync("git", ["-C", fx.install, "config", "--local", "--get", key], {
      encoding: "utf8",
    }).stdout.trim();
  const state = () => ({
    head: git(fx.install, "rev-parse", "HEAD"),
    tree: readFileSync(join(fx.install, "bin/iva.mjs"), "utf8"),
    branch: config("iva.updateBranch"),
    flag: config("iva.beta"),
  });
  /** Установка на бета-сборке: legacy — флаг при main, иначе ветка beta без флага. */
  const seed = (legacy: boolean) => {
    git(fx.install, "fetch", "--quiet", "origin", "beta");
    git(fx.install, "reset", "--quiet", "--hard", build);
    writeFileSync(join(fx.install, "bin/iva.mjs"), "// owner's edit\n");
    for (const key of ["iva.updateBranch", "iva.beta"])
      spawnSync("git", ["-C", fx.install, "config", "--unset-all", key]);
    git(fx.install, "config", "iva.updateBranch", legacy ? "main" : "beta");
    if (legacy) git(fx.install, "config", "iva.beta", "true");
    return state();
  };
  const attempt = (fail: string) => {
    try {
      fx.run({ IVA_FAIL_GIT: fail });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  };
  return { tip, state, seed, attempt };
}

const REPAIR_STEPS = [
  "ls-remote",
  "fetch --quiet origin [0-9a-f]{40}",
  "fetch --quiet origin (main|beta)$",
  "refs/tags",
  "reset (-q|--quiet) --hard",
  "config --local iva.updateBranch beta",
];

test("repair failure table: every step fails alone, nothing is left half-done or rolled back", (t) => {
  const fx = failureTable(t);
  const same = (a: object, b: object) =>
    JSON.stringify(a) === JSON.stringify(b);
  // Доведено: код 0, вершина beta и ветка beta. Не доведено: ненулевой код, HEAD и
  // рабочее дерево как были; ветка может быть уже переписана (запись идёт до сброса,
  // следующий ремонт доводит), флаг — как был.
  const done = (after: ReturnType<typeof fx.state>, code: number) =>
    code === 0 && after.head === fx.tip && after.branch === "beta";
  const kept = (
    after: ReturnType<typeof fx.state>,
    before: ReturnType<typeof fx.state>,
    code: number,
  ) =>
    code !== 0 &&
    same(
      [after.head, after.tree, after.flag],
      [before.head, before.tree, before.flag],
    ) &&
    [before.branch, "beta"].includes(after.branch);
  const broken: string[] = [];
  // Без отказа: бета по ветке без флага и прежний opt-in (флаг при main) — вершина beta.
  for (const legacy of [false, true]) {
    fx.seed(legacy);
    const code = fx.attempt("^$");
    const after = fx.state();
    if (code !== 0 || after.head !== fx.tip || after.branch !== "beta")
      broken.push(
        `no failure, legacy=${legacy}: ${code} ${JSON.stringify(after)}`,
      );
  }
  for (const step of REPAIR_STEPS) {
    const before = fx.seed(true);
    const code = fx.attempt(step);
    const after = fx.state();
    if (!done(after, code) && !kept(after, before, code))
      broken.push(`${step}: exit ${code}, ${JSON.stringify(after)}`);
  }
  assert.deepEqual(broken, []);
});

// --- An installation below the floor: repair takes it up through the step release. -------
// The shipped CLI of the installed release and the shipped CLI of the step release run as
// they are. What stands in for a build is the new half of each tree: it flips the version
// in, and the one of this tree asks the floor question first with the tree's own code.

const FINISH = `import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVersionStore } from "./lib/version-store.ts";
import * as check from "./lib/update-check.ts";
const [home, name] = process.argv.slice(2);
const report = (outcome) =>
  writeFileSync(process.env.IVA_UPDATE_OUTCOME, JSON.stringify(outcome));
const refusal = check.belowFloor?.(home, join(import.meta.dirname, ".."));
if (refusal) {
  report({ status: "failed", message: refusal });
  process.exit(1);
}
const store = createVersionStore(home);
const dir = join(home, "versions", name);
if (!existsSync(join(dir, "node_modules")))
  symlinkSync(process.env.IVA_TEST_NODE_MODULES, join(dir, "node_modules"));
const previous = store.currentName();
store.linkState(dir);
store.complete(name);
store.activate(name);
store.settle(name);
report({ status: "updated", version: name, previous, custom: "none", migrations: [], removed: [] });
`;
const STEP = /^STEP_BRANCH="release\/(.+)"$/mu.exec(
  readFileSync(REPAIR, "utf8"),
)![1];
const NEWEST = "0.5.12";
const SHIPPED = ["scripts", "agent", "packages", "bin", "package.json"];

/** The files of a shipped release, as they were, into `dir`. */
function unpackShipped(tag: string, dir: string): void {
  const paths = [...SHIPPED, "update-compat.json"].filter(
    (path) =>
      spawnSync("git", ["cat-file", "-e", `${tag}:${path}`], { cwd: ROOT })
        .status === 0,
  );
  execFileSync("tar", ["-xf", "-", "-C", dir], {
    input: execFileSync("git", ["archive", tag, ...paths], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }),
  });
}

/**
 * origin: the installed release, the step release on `release/<step>` with its tag, and
 * this tree as the newest release on main and on beta.
 */
function floorRemote(fixture: string, from: string) {
  const source = join(fixture, "source");
  mkdirSync(source);
  git(source, "init", "--quiet", "--initial-branch=main");
  const commit = (message: string) => {
    git(source, "add", "-A");
    git(source, "commit", "--quiet", "-m", message);
    return git(source, "rev-parse", "HEAD");
  };
  unpackShipped(`v${from}`, source);
  const installed = commit(from);
  git(source, "tag", `v${from}`);
  for (const path of SHIPPED)
    rmSync(join(source, path), { recursive: true, force: true });
  unpackShipped(`v${STEP}`, source);
  writeFileSync(join(source, "scripts/update-finish.ts"), FINISH);
  const step = commit(STEP);
  git(source, "tag", `v${STEP}`);
  git(source, "branch", `release/${STEP}`);
  for (const path of SHIPPED.slice(0, 4)) {
    rmSync(join(source, path), { recursive: true, force: true });
    cpSync(join(ROOT, path), join(source, path), { recursive: true });
  }
  cpSync(join(ROOT, "update-compat.json"), join(source, "update-compat.json"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      ...(JSON.parse(
        readFileSync(join(ROOT, "package.json"), "utf8"),
      ) as object),
      version: NEWEST,
    }),
  );
  writeFileSync(join(source, "scripts/update-finish.ts"), FINISH);
  const newest = commit(NEWEST);
  git(source, "tag", `v${NEWEST}`);
  git(source, "branch", "beta");
  const remote = join(fixture, "remote.git");
  git(fixture, "clone", "--quiet", "--bare", source, remote);
  return { remote, installed, step, newest };
}

function belowFloorWorld(t: TestContext, from: string) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "iva-repair-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const origin = floorRemote(fixture, from);
  const home = join(fixture, "iva");
  const userHome = join(fixture, "user");
  const fakeBin = join(fixture, "bin");
  mkdirSync(userHome);
  mkdirSync(fakeBin);
  // Nothing here may reach the machine's services.
  for (const name of ["systemctl", "launchctl", "loginctl"]) {
    writeFileSync(join(fakeBin, name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeBin, name), 0o755);
  }
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    HOME: userHome,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    IVA_INSTALL_DIR: home,
    IVA_TEST_NODE_MODULES: join(ROOT, "node_modules"),
    AGENT_LANGUAGE: "en",
    IVA_BETA: "",
  };
  const seed = (dir: string) => {
    writeFileSync(join(dir, ".env"), "MODEL_PROVIDER=ollama\nIVA_PORT=8723\n");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data/sentinel"), "user data\n");
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault/note.md"), "# mine\n");
  };
  const kept = () =>
    [".env", "data/sentinel", "vault/note.md"].map((path) =>
      readFileSync(join(home, path), "utf8"),
    );
  const name = (version: string, sha: string) => versionName(version, sha);
  return {
    ...origin,
    fixture,
    home,
    fakeBin,
    env,
    seed,
    kept,
    name,
    store: () => createVersionStore(home),
    branch: (dir: string) =>
      spawnSync(
        "git",
        ["--git-dir", dir, "config", "--local", "--get", "iva.updateBranch"],
        { encoding: "utf8", env },
      ).stdout.trim(),
    repair: () =>
      spawnSync("bash", [REPAIR], { encoding: "utf8", env, timeout: 120_000 }),
  };
}

/** The versions layout serving the shipped `from`, as its own updater left it. */
function versionsInstallation(
  world: ReturnType<typeof belowFloorWorld>,
  from: string,
  branch: string,
): string {
  const { home, remote, installed } = world;
  mkdirSync(home);
  git(home, "clone", "--quiet", "--mirror", remote, join(home, "repo"));
  if (branch)
    git(join(home, "repo"), "config", "--local", "iva.updateBranch", branch);
  world.seed(home);
  const store = world.store();
  const name = world.name(from, installed);
  const dir = store.stage(name);
  unpackShipped(`v${from}`, dir);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  store.linkState(dir);
  store.complete(name);
  store.activate(name);
  store.settle(name);
  return name;
}

// specs/UpdateFloor.tla: Repaired, BranchKept.
for (const [from, branch] of [
  ["0.3.29", "main"],
  ["0.4.8", ""],
  ["0.4.17", "beta"],
] as const) {
  test(`Repaired, BranchKept: repair takes a shipped v${from} through the step release onto the newest, Update branch ${branch || "unset"} is back`, (t) => {
    const world = belowFloorWorld(t, from);
    versionsInstallation(world, from, branch);
    const before = world.kept();

    const ran = world.repair();

    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, new RegExp(`updating to ${STEP} first`, "u"));
    const store = world.store();
    assert.equal(store.currentName(), world.name(NEWEST, world.newest));
    assert.equal(store.settled(), world.name(NEWEST, world.newest));
    assert.equal(store.previousName(), world.name(STEP, world.step));
    assert.deepEqual(world.kept(), before);
    assert.equal(world.branch(join(world.home, "repo")), branch);
    assert.equal(existsSync(join(world.home, ".iva-repair-branch")), false);
  });
}

test("Repaired, BranchKept: repair killed after the first update leaves Iva on the step release, and the next run puts the branch back and finishes", (t) => {
  const world = belowFloorWorld(t, "0.4.17");
  versionsInstallation(world, "0.4.17", "main");
  const before = world.kept();
  // `node … update` runs as it is, then kills the shell that called it: repair.sh dies
  // with no chance to put the branch back.
  writeFileSync(
    join(world.fakeBin, "node"),
    `#!/bin/sh\nif [ "\${2:-}" = update ] && [ ! -e "${world.fixture}/killed" ]; then\n  "${process.execPath}" "$@"\n  : > "${world.fixture}/killed"\n  kill -9 "$PPID"\n  exit 0\nfi\nexec "${process.execPath}" "$@"\n`,
  );
  chmodSync(join(world.fakeBin, "node"), 0o755);

  const killed = world.repair();

  assert.equal(killed.signal, "SIGKILL", `${killed.stdout}\n${killed.stderr}`);
  const step = world.name(STEP, world.step);
  assert.equal(world.store().currentName(), step);
  assert.equal(world.store().settled(), step);
  assert.deepEqual(world.kept(), before);
  assert.equal(world.branch(join(world.home, "repo")), `release/${STEP}`);
  assert.equal(
    readFileSync(join(world.home, ".iva-repair-branch"), "utf8"),
    "main",
  );

  const again = world.repair();

  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(world.store().currentName(), world.name(NEWEST, world.newest));
  assert.deepEqual(world.kept(), before);
  assert.equal(world.branch(join(world.home, "repo")), "main");
  assert.equal(existsSync(join(world.home, ".iva-repair-branch")), false);
});

test("Repaired, BranchKept: repair takes a checkout of v0.3.14 onto the step release, its updater moves it to versions, then onto the newest", (t) => {
  const world = belowFloorWorld(t, "0.3.14");
  const { home } = world;
  git(world.fixture, "clone", "--quiet", world.remote, home);
  git(home, "reset", "--quiet", "--hard", world.installed);
  git(home, "config", "--local", "iva.updateBranch", "main");
  world.seed(home);
  symlinkSync(join(ROOT, "node_modules"), join(home, "node_modules"));
  const before = world.kept();

  const ran = world.repair();

  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  assert.match(ran.stdout, new RegExp(`updating to ${STEP} first`, "u"));
  const store = world.store();
  assert.equal(store.currentName(), world.name(NEWEST, world.newest));
  assert.equal(store.previousName(), world.name(STEP, world.step));
  assert.deepEqual(world.kept(), before);
  assert.equal(world.branch(join(home, "repo")), "main");
  assert.equal(world.branch(join(home, ".git")), "main");
  assert.equal(existsSync(join(home, ".iva-repair-branch")), false);
});

test("repair leaves an installation below the floor on its rollback branch to its own updater", (t) => {
  const world = belowFloorWorld(t, "0.4.17");
  const installed = versionsInstallation(world, "0.4.17", "release/0.4.17");
  git(
    join(world.home, "repo"),
    "push",
    "--quiet",
    world.remote,
    `${world.installed}:refs/heads/release/0.4.17`,
  );

  const ran = world.repair();

  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  assert.doesNotMatch(ran.stdout, /first, then/u);
  assert.equal(world.store().currentName(), installed);
  assert.equal(world.branch(join(world.home, "repo")), "release/0.4.17");
});

test("the floor repair steps over is the floor of this tree", () => {
  assert.equal(
    /^FLOOR="(.+)"$/mu.exec(readFileSync(REPAIR, "utf8"))?.[1],
    (
      JSON.parse(readFileSync(join(ROOT, "update-compat.json"), "utf8")) as {
        minUpdater: string;
      }
    ).minUpdater,
  );
});
