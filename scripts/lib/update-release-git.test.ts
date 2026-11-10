// Выпуски и бета-обновления на настоящем git: зеркало установки (bare, как ~/iva/repo), удалённый
// репозиторий с метками vX.Y.Z и коммитами после них. Одна строка таблицы отказов спеки
// выпусков и бета-обновлений — один тест.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveReleaseTarget, setBeta } from "./update-channel.ts";
import { gitAt, inspectUpstream } from "./update-check.ts";
import {
  ensureMirror,
  releaseNote,
  resolveTarget,
} from "../cli/version-update-command.ts";
import { parseVersionName, versionName } from "./version-store.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** seed пушит в remote; mirror — зеркало установки; commit(v) — коммит с версией v. */
function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), "iva-release-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const [remote, seed, mirror] = ["remote.git", "seed", "mirror.git"].map(
    (name) => join(temp, name),
  );
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  git(temp, "init", "-q", "--bare", "-b", "main", remote);
  git(seed, "remote", "add", "origin", remote);
  const commit = (version: string, tag = false) => {
    writeFileSync(join(seed, "package.json"), `{"version":"${version}"}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", version, "--allow-empty");
    if (tag) git(seed, "tag", `v${version}`);
    git(seed, "push", "-q", "--tags", "origin", "HEAD");
    return git(seed, "rev-parse", "HEAD");
  };
  const first = commit("1.0.0", true);
  git(temp, "clone", "-q", "--mirror", remote, mirror);
  /** Beta updates: Update branch `beta`. */
  const beta = () => git(mirror, "config", "iva.updateBranch", "beta");
  /** The flag of beta builds before 0.5.0; nothing reads it. */
  const flag = (value: string) => git(mirror, "config", "iva.beta", value);
  const target = (installed?: string) =>
    resolveReleaseTarget({ git: (...args) => gitAt(mirror, args), installed });
  return { temp, remote, seed, mirror, first, commit, beta, flag, target };
}

/** Выпуск 1.0.0 на main, ветка beta на шаг впереди; зеркало снято после обеих. */
function fx2(t: TestContext) {
  const fx = fixture(t);
  git(fx.seed, "switch", "-q", "-c", "beta");
  const betaTip = fx.commit("1.1.0-beta.1");
  git(fx.seed, "switch", "-q", "main");
  git(fx.mirror, "fetch", "-q", "origin", "+refs/heads/*:refs/heads/*");
  return { ...fx, betaTip };
}

void test("stable, установка на коммите после последней метки: цель — она сама, ничего не ставится, не откат", async (t) => {
  const fx = fixture(t);
  const after = fx.commit("1.0.0");
  const target = await fx.target(after);
  assert.equal(target.beta, false);
  assert.equal(target.targetHead, after);
  const aim = await resolveTarget(fx.mirror, after);
  assert.deepEqual(aim, {
    sha: after,
    version: "1.0.0",
    beta: false,
    release: "v1.0.0",
    newer: true,
  });
  // Установка новее выпуска: не «последняя стабильная», а «новее выпуска v1.0.0».
  assert.equal(
    releaseNote(aim, "ru"),
    "Стоит сборка новее последнего выпуска (v1.0.0). Следующий выпуск поставлю, когда выйдет.",
  );
  assert.equal(
    releaseNote(aim, "en"),
    "This build is newer than the latest release (v1.0.0). I'll install the next release when it's out.",
  );
  const exact = await resolveTarget(fx.mirror, fx.first);
  assert.equal(exact.newer, false);
  assert.equal(releaseNote(exact, "ru"), "Это последняя стабильная версия.");
  assert.equal(releaseNote(exact, "en"), "That is the latest stable release.");
  assert.equal(releaseNote({ ...exact, beta: true }, "ru"), null);
});

void test("stable, вышла новая метка: ставится метка, а не вершина ветки", async (t) => {
  const fx = fixture(t);
  const released = fx.commit("1.1.0", true);
  fx.commit("1.1.0");
  // Метка-пререлиз на вершине сортируется выше выпуска, но выпуском не является.
  fx.commit("1.2.0-beta.1", true);
  assert.equal((await fx.target(fx.first)).targetHead, released);
  assert.equal((await resolveTarget(fx.mirror, fx.first)).sha, released);
});

void test("beta: вершина ветки, а не метка", async (t) => {
  const fx = fixture(t);
  fx.commit("1.1.0", true);
  const tip = fx.commit("1.2.0-beta.1");
  // Бета — ветка beta (ADR-0018).
  git(fx.seed, "push", "-q", "origin", "HEAD:refs/heads/beta");
  fx.beta();
  const target = await fx.target(fx.first);
  assert.equal(target.beta, true);
  assert.equal(target.targetHead, tip);
  assert.equal((await resolveTarget(fx.mirror, fx.first)).sha, tip);
});

void test("меток нет вовсе: stable — отказ с советом iva beta, ни падения, ни вершины ветки", async (t) => {
  const fx = fixture(t);
  git(fx.seed, "push", "-q", "origin", ":refs/tags/v1.0.0");
  git(fx.seed, "tag", "-d", "v1.0.0");
  git(fx.mirror, "tag", "-d", "v1.0.0");
  fx.commit("1.1.0");
  await assert.rejects(fx.target(fx.first), /iva beta/u);
  await assert.rejects(resolveTarget(fx.mirror, fx.first), /iva beta/u);
});

// UpdateFloor.NoSilentLoss: флаг iva.beta писали бета-сборки до 0.5.0. Цель решает Update
// branch; флаг не читается, не переписывается и ветку не меняет.
void test("NoSilentLoss: флаг iva.beta при main, без ветки и при своей ветке — выпуск, флаг и ветка как были", async (t) => {
  for (const value of ["true", "nightly"])
    for (const branch of ["main", "", "dev"]) {
      const fx = fx2(t);
      git(fx.seed, "switch", "-q", "-c", "dev");
      const devTag = fx.commit("1.5.0", true);
      fx.commit("1.6.0-beta.1");
      git(fx.seed, "switch", "-q", "main");
      if (branch) git(fx.mirror, "config", "iva.updateBranch", branch);
      fx.flag(value);
      const config = () =>
        ["iva.updateBranch", "iva.beta"].map(
          (key) =>
            spawnSync("git", ["-C", fx.mirror, "config", "--get", key], {
              encoding: "utf8",
            }).stdout,
        );
      const before = config();
      const warnings: string[] = [];
      t.mock.method(console, "warn", (line: string) => warnings.push(line));

      const target = await fx.target(fx.first);

      assert.equal(target.beta, false, `${value} ${branch}`);
      assert.equal(target.targetHead, branch === "dev" ? devTag : fx.first);
      assert.equal((await resolveTarget(fx.mirror, fx.first)).beta, false);
      assert.deepEqual(config(), before);
      assert.deepEqual(warnings, []);
    }
});

void test("сеть при забирании меток: тот же отказ, что при сети, а не «уже последняя»; бета — как сейчас", async (t) => {
  const fx = fixture(t);
  const tip = fx.commit("1.1.0");
  git(fx.mirror, "fetch", "-q", "origin");
  rmSync(fx.remote, { recursive: true, force: true });
  await assert.rejects(fx.target(tip), /couldn't fetch|fatal/u);
  await assert.rejects(resolveTarget(fx.mirror, tip), /couldn't fetch|fatal/u);
  fx.beta();
  // Бета без сети (QA D2): отказ, а не коммит зеркала — HEAD зеркала может быть main.
  await assert.rejects(
    resolveTarget(fx.mirror, tip),
    /beta branch is unavailable/u,
  );
});

void test("переключение beta → stable на установке новее метки: ничего не ставится до следующей метки", async (t) => {
  const fx = fixture(t);
  fx.beta();
  const installed = fx.commit("1.1.0-beta.1");
  git(fx.seed, "push", "-q", "origin", "HEAD:refs/heads/beta");
  assert.equal((await fx.target(installed)).targetHead, installed);
  // iva stable: ветка main.
  git(fx.mirror, "config", "iva.updateBranch", "main");
  assert.equal((await fx.target(installed)).targetHead, installed);
  const next = fx.commit("1.1.0", true);
  assert.equal((await fx.target(installed)).targetHead, next);
  // Ежедневная проверка предлагает этот релиз: бета 1.1.0-beta.1 младше 1.1.0.
  const info = await inspectUpstream({ root: fx.mirror, head: installed });
  assert.equal(info.hasVersionUpdate, true);
  assert.equal(info.remoteVersion, "1.1.0");
});

void test("ветка обновления не main: выпуск — её метка, а не метка main и не её вершина", async (t) => {
  const fx = fixture(t);
  git(fx.seed, "switch", "-q", "-c", "dev");
  const devTag = fx.commit("1.5.0", true);
  fx.commit("1.6.0-beta.1");
  git(fx.seed, "switch", "-q", "main");
  fx.commit("2.0.0", true);
  git(fx.mirror, "config", "iva.updateBranch", "dev");
  const stable = await fx.target(fx.first);
  assert.equal(stable.branch, "dev");
  assert.equal(stable.targetHead, devTag);
});

// ADR-0018: выпуски в main, бета — ветка beta. iva beta / iva stable переводят и ветку.
void test("iva beta — вершина ветки beta; iva stable — выпуск main, установку новее выпуска не откатывает", async (t) => {
  const fx = fixture(t);
  git(fx.seed, "switch", "-q", "-c", "beta");
  const tip = fx.commit("1.1.0-beta.1");
  git(fx.seed, "switch", "-q", "main");
  const home = join(fx.temp, "home");
  mkdirSync(home);
  const repo = join(home, "repo");
  git(fx.temp, "clone", "-q", "--mirror", fx.remote, repo);
  git(repo, "config", "iva.updateBranch", "main");
  const target = (installed: string) =>
    resolveReleaseTarget({ git: (...args) => gitAt(repo, args), installed });
  assert.equal(setBeta(home, true), "ok");
  const beta = await target(fx.first);
  assert.equal(beta.branch, "beta");
  assert.equal(beta.targetHead, tip);
  assert.equal(setBeta(home, false), "ok");
  const stable = await target(tip);
  assert.equal(stable.branch, "main");
  assert.equal("tag" in stable && stable.tag, "v1.0.0");
  assert.equal(stable.targetHead, tip);
  assert.equal((await target(fx.first)).targetHead, fx.first);
});

// Никакого автоматического отката: вершина беты — предок установленного, цель — он сам.
void test("бета: вершина ветки старше установленного — цель установленный коммит", async (t) => {
  const fx = fx2(t);
  fx.beta();
  const installed = fx.betaTip;
  git(fx.seed, "push", "-q", "-f", "origin", `${fx.first}:refs/heads/beta`);
  assert.equal((await fx.target(installed)).targetHead, installed);
  assert.equal((await resolveTarget(fx.mirror, installed)).sha, installed);
});

void test("бета офлайн: отказ «ветка beta недоступна», не HEAD зеркала (QA D2)", async (t) => {
  const fx = fx2(t);
  git(fx.mirror, "config", "iva.updateBranch", "beta");
  rmSync(fx.remote, { recursive: true, force: true });
  await assert.rejects(
    resolveTarget(fx.mirror, fx.betaTip),
    /beta branch is unavailable/u,
  );
});

void test("бета, у origin нет ветки beta: отказ, а не вершина main (QA D2)", async (t) => {
  const fx = fixture(t);
  const main = fx.commit("1.1.0");
  git(fx.mirror, "config", "iva.updateBranch", "beta");
  await assert.rejects(
    resolveTarget(fx.mirror, main),
    /beta branch is unavailable/u,
  );
});

void test("зеркало ~/iva/repo получает iva.updateBranch установки; прежний флаг остаётся где был", async (t) => {
  const fx = fixture(t);
  const home = join(fx.temp, "home");
  git(fx.temp, "clone", "-q", fx.remote, home);
  git(home, "config", "iva.beta", "true");
  git(home, "config", "iva.updateBranch", "beta");
  const repo = await ensureMirror(home);
  assert.equal(git(repo, "config", "--get", "iva.updateBranch"), "beta");
  assert.equal(
    spawnSync("git", ["-C", repo, "config", "--get", "iva.beta"]).status,
    1,
  );
  assert.equal(git(home, "config", "--get", "iva.beta"), "true");
});

void test("каталог версии беты `0.4.11-beta.1-<sha12>` разбирают и новый код, и v0.4.8", async (t) => {
  const sha = "0123456789ab";
  const name = versionName("0.4.11-beta.1", sha, "89abcdef");
  assert.deepEqual(
    { ...parseVersionName(name) },
    { ...parseVersionName(`0.4.11-beta.1-${sha}+89abcdef`) },
  );
  assert.equal(parseVersionName(name)?.version, "0.4.11-beta.1");
  const dir = mkdtempSync(join(tmpdir(), "iva-v048-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, "data-dir.ts");
  writeFileSync(
    old,
    git(process.cwd(), "show", "v0.4.8:packages/data-dir/index.ts"),
  );
  const { VERSION_DIRECTORY_PATTERN } = (await import(old)) as {
    VERSION_DIRECTORY_PATTERN: RegExp;
  };
  const match = VERSION_DIRECTORY_PATTERN.exec(name);
  assert.equal(match?.[1], "0.4.11-beta.1");
  assert.equal(match?.[2], sha);
});

void test("метка, удалённая из origin, удаляется и из зеркала: отозванный выпуск не ставится", async (t) => {
  const fx = fixture(t);
  const wrong = fx.commit("9.0.0", true);
  assert.equal((await fx.target(fx.first)).targetHead, wrong);
  git(fx.seed, "tag", "-d", "v9.0.0");
  git(fx.seed, "push", "-q", "origin", ":refs/tags/v9.0.0");
  const target = await fx.target(fx.first);
  assert.equal("tag" in target ? target.tag : "", "v1.0.0");
  assert.equal(target.targetHead, fx.first);
});

// ── Круг 3: таблица отказов резолвера обновления ─────────────────────────────────────
// Шаги: rev-parse активного коммита, check-ref-format, fetch ветки, запись миграции
// (config), fetch меток. Отказ ровно на одном шаге (двойник git резолвера). Инвариант:
// отказ или цель не ниже установленного; «ветка beta недоступна» — только сеть и
// отсутствующая ветка, остальное показывается как есть. Отката нет никогда.
void test("resolver failure table: a failed step refuses, never a target below the installed commit", async (t) => {
  const fx = fx2(t);
  const older = fx.first;
  const broken: string[] = [];
  type Row = {
    step: string;
    setup: () => void;
    fail?: RegExp;
    code?: number;
    installed: string;
    expect: "unavailable" | "other";
  };
  const reset = () => {
    for (const key of ["iva.updateBranch", "iva.beta"])
      spawnSync("git", ["-C", fx.mirror, "config", "--unset-all", key]);
    git(fx.mirror, "config", "iva.updateBranch", "beta");
  };
  const rows: Row[] = [
    // Активного коммита нет в зеркале (пересоздано, gc), beta откатили назад.
    {
      step: "rev-parse installed",
      installed: "ab".repeat(20),
      expect: "other",
      setup: () =>
        git(fx.seed, "push", "-q", "-f", "origin", `${older}:refs/heads/beta`),
    },
    {
      step: "fetch branch (network)",
      installed: fx.betaTip,
      expect: "unavailable",
      setup: () => {},
      fail: /^fetch --prune origin refs\/heads\/beta$/u,
    },
    {
      step: "check-ref-format",
      installed: fx.betaTip,
      expect: "other",
      setup: () => git(fx.mirror, "config", "iva.updateBranch", "a..b"),
    },
    // R4: merge-base упал (нет промежуточного объекта), а не ответил «не предок».
    {
      step: "merge-base",
      installed: fx.betaTip,
      expect: "other",
      setup: () =>
        git(fx.seed, "push", "-q", "-f", "origin", `${older}:refs/heads/beta`),
      fail: /^merge-base --is-ancestor/u,
      code: 128,
    },
    // R4: origin отвечает, ветка есть, а fetch падает локально (FETCH_HEAD не пишется).
    {
      step: "fetch (local)",
      installed: fx.betaTip,
      expect: "other",
      setup: () =>
        mkdirSync(join(fx.mirror, "FETCH_HEAD"), { recursive: true }),
    },
    {
      step: "fetch tags",
      installed: fx.first,
      expect: "other",
      setup: () => git(fx.mirror, "config", "iva.updateBranch", "main"),
      fail: /refs\/tags/u,
    },
  ];
  for (const row of rows) {
    git(fx.seed, "push", "-q", "-f", "origin", `${fx.betaTip}:refs/heads/beta`);
    reset();
    row.setup();
    const config = () =>
      ["iva.updateBranch", "iva.beta"].map(
        (key) =>
          spawnSync("git", ["-C", fx.mirror, "config", "--get", key], {
            encoding: "utf8",
          }).stdout,
      );
    const before = JSON.stringify(config());
    const gitDouble = (...args: string[]) =>
      row.fail?.test(args.join(" "))
        ? Promise.resolve({
            code: row.code ?? 1,
            stdout: "",
            stderr: "fatal: injected",
          })
        : gitAt(fx.mirror, args);
    const outcome = await resolveReleaseTarget({
      git: gitDouble,
      installed: row.installed,
    })
      .then((target) => `target ${target.targetHead}`)
      .catch((error: Error) => `refused: ${error.message}`);
    const aim = await resolveTarget(fx.mirror, row.installed)
      .then((target) => `target ${target.sha}`)
      .catch((error: Error) => `refused: ${error.message}`);
    rmSync(join(fx.mirror, "config.lock"), { force: true });
    rmSync(join(fx.mirror, "FETCH_HEAD"), { recursive: true, force: true });
    if (aim.startsWith("refused") && JSON.stringify(config()) !== before)
      broken.push(
        `${row.step}: config changed on refusal ${JSON.stringify(config())}`,
      );
    const unavailable = /beta branch is unavailable/u.test(aim);
    if (outcome.startsWith("target") && outcome !== `target ${row.installed}`)
      if (row.step !== "fetch tags") broken.push(`${row.step}: ${outcome}`);
    if (
      row.fail === undefined &&
      unavailable !== (row.expect === "unavailable")
    )
      broken.push(`${row.step}: ${aim}`);
    if (row.fail !== undefined && !outcome.startsWith("refused"))
      broken.push(`${row.step}: not refused: ${outcome}`);
  }
  // Сеть и отсутствующая ветка у настоящего resolveTarget — «ветка beta недоступна».
  reset();
  git(fx.seed, "push", "-q", "origin", ":refs/heads/beta");
  const missing = await resolveTarget(fx.mirror, fx.betaTip).then(
    (target) => `target ${target.sha}`,
    (error: Error) => error.message,
  );
  if (!/beta branch is unavailable/u.test(missing))
    broken.push(`missing branch: ${missing}`);
  assert.deepEqual(broken, []);
});

// QA круга 3: на стабильных активный коммит, которого нет в зеркале, с полным SHA тоже
// отказ, а не выпуск ниже установленного.
void test("stable: the installed commit missing from the mirror (full SHA) refuses, no release below it", async (t) => {
  const fx = fixture(t);
  fx.commit("1.1.0", true);
  const missing = "ab".repeat(20);
  await assert.rejects(fx.target(missing), /is not in the mirror/u);
  await assert.rejects(
    resolveTarget(fx.mirror, missing),
    /is not in the mirror/u,
  );
});
