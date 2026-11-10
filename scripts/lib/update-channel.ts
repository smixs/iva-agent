import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyRoot, gitRootFor } from "./version-layout.ts";

export const DEFAULT_UPDATE_BRANCH = "main";
/** Ветка бета-обновлений: в main только выпуски (ADR-0018). */
const BETA_BRANCH = "beta";
export const UPDATE_BRANCH_CONFIG = "iva.updateBranch";

export type GitResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type Git = (...args: string[]) => Promise<GitResult>;

type ResolveUpdateTargetOptions = {
  git?: Git;
  remote?: string;
  defaultBranch?: string;
};

function output(result: GitResult): string {
  return String(result?.stdout ?? "").trim();
}

async function requireGit(git: Git, ...args: string[]): Promise<string> {
  const result = await git(...args);
  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return output(result);
}

/** Ветку не получить: нет сети или такой ветки у origin. Единственная ошибка, при которой
 * бета молчит (daily) или отказывает строкой «ветка beta недоступна» (iva update). */
export class BranchUnavailableError extends Error {}

async function fetchBranch(
  git: Git,
  remote: string,
  branch: string,
): Promise<string> {
  const valid = await git("check-ref-format", "--branch", branch);
  if (valid.code !== 0) throw new Error(`invalid update branch: ${branch}`);
  const fetched = await git("fetch", "--prune", remote, `refs/heads/${branch}`);
  if (fetched.code !== 0) {
    // Недоступна — только если origin не ответил или ветки у него нет; иначе сбой здесь.
    const listed = await git("ls-remote", remote, `refs/heads/${branch}`);
    const reason = fetched.stderr || `couldn't fetch ${remote}/${branch}`;
    throw listed.code !== 0 || !output(listed)
      ? new BranchUnavailableError(reason)
      : new Error(reason);
  }
  return requireGit(git, "rev-parse", "FETCH_HEAD");
}

export async function resolveUpdateTarget({
  git,
  remote = "origin",
  defaultBranch = DEFAULT_UPDATE_BRANCH,
}: ResolveUpdateTargetOptions = {}) {
  if (typeof git !== "function")
    throw new Error("update target resolver requires git");
  const currentBranch = await requireGit(
    git,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  );
  if (!currentBranch || currentBranch === "HEAD")
    throw new Error("detached HEAD: switch to the update branch first");

  const configured = await git(
    "config",
    "--local",
    "--get",
    UPDATE_BRANCH_CONFIG,
  );
  const configuredBranch = configured.code === 0 ? output(configured) : "";
  if (configuredBranch) {
    return {
      branch: configuredBranch,
      currentBranch,
      configured: true,
      legacyMigration: false,
      targetHead: await fetchBranch(git, remote, configuredBranch),
    };
  }

  if (currentBranch !== defaultBranch) {
    const defaultHead = await fetchBranch(git, remote, defaultBranch);
    const merged = await git(
      "merge-base",
      "--is-ancestor",
      "HEAD",
      defaultHead,
    );
    if (merged.code === 0) {
      return {
        branch: defaultBranch,
        currentBranch,
        configured: false,
        legacyMigration: true,
        targetHead: defaultHead,
      };
    }
  }

  return {
    branch: currentBranch,
    currentBranch,
    configured: false,
    legacyMigration: false,
    targetHead: await fetchBranch(git, remote, currentBranch),
  };
}

/**
 * Одна запись решает, какую версию ставит обновление (specs/UpdateBranch.tla): выбор
 * владельца живёт в репозитории установки, зеркало - его кэш, из которого обновление
 * берёт ветку. Оборванная или неудавшаяся запись `iva beta`/`iva stable` оставляла кэш на
 * прежней ветке, и установка получала не то, что выбрал владелец; поэтому чтение сверяет
 * кэш с записью и чинит расхождение.
 */
export async function syncUpdateBranch(
  git: Git,
  record: Git,
): Promise<"same" | "repaired" | "no-record"> {
  const read = async (at: Git): Promise<string> => {
    const result = await at("config", "--local", "--get", UPDATE_BRANCH_CONFIG);
    return result.code === 0 ? output(result) : "";
  };
  const wanted = await read(record);
  if (!wanted) return "no-record"; // Ничего не выбрано: ветка остаётся той, что в кэше.
  if ((await read(git)) === wanted) return "same";
  await persistUpdateBranch(git, wanted);
  return "repaired";
}

export async function persistUpdateBranch(
  git: Git,
  branch: string,
): Promise<void> {
  await requireGit(git, "config", "--local", UPDATE_BRANCH_CONFIG, branch);
}

/** Флаг бета-сборок до 0.5.0. Beta updates — Update branch `beta` (ADR-0018): флаг не
 * читается, `iva beta` и `iva stable` его снимают, чтобы откат на прежнюю сборку не
 * увёл установку обратно на бету. */
const RETIRED_BETA_FLAG = "iva.beta";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Ставится ли вершина ветки: Update branch `beta`. */
export async function betaChannel(git: Git): Promise<boolean> {
  const branch = output(
    await git("config", "--local", "--get", UPDATE_BRANCH_CONFIG),
  );
  return branch === BETA_BRANCH;
}

/** Активный коммит в зеркале. Нет его — безопасность перехода не доказать: отказ. */
async function installedIn(git: Git, installed: string): Promise<string> {
  const found = await git(
    "rev-parse",
    "--verify",
    "-q",
    `${installed}^{commit}`,
  );
  if (found.code !== 0)
    throw new Error(
      `the installed commit ${installed} is not in the mirror; nothing was installed`,
    );
  return output(found);
}

/** Цель не ниже установленного: назад обновление не ходит нигде; откат — только явный. */
async function notBelow(git: Git, target: string, installed?: string) {
  if (!installed || !target) return target;
  const at = await installedIn(git, installed);
  if (at === target) return target;
  return (await isAncestor(git, target, at)) ? at : target;
}

/** Предок ли: код 0 — да, 1 — нет, любой другой — не проверено, отказ. */
async function isAncestor(git: Git, older: string, newer: string) {
  const { code } = await git("merge-base", "--is-ancestor", older, newer);
  if (code !== 0 && code !== 1)
    throw new Error(
      "can't check whether the target is older than the installed commit (git merge-base failed); nothing was installed",
    );
  return code === 0;
}

type UpdateTarget = Awaited<ReturnType<typeof resolveUpdateTarget>>;

/** Бета-цель — вершина Update branch `beta` — или null. */
async function betaTarget(git: Git, target: UpdateTarget, installed?: string) {
  if (target.branch !== BETA_BRANCH) return null;
  const head = await notBelow(git, target.targetHead, installed);
  return { ...target, beta: true, targetHead: head };
}

/**
 * Цель обновления. Бета — вершина ветки обновления. Иначе — новейший выпуск: метка
 * vX.Y.Z, достижимая из вершины; установленный коммит (`installed`), который сам этот
 * выпуск или его потомок, — сама установка: назад обновление не ходит.
 */
export async function resolveReleaseTarget(
  options: ResolveUpdateTargetOptions & { installed?: string },
) {
  const git = options.git!;
  const remote = options.remote ?? "origin";
  const target = await resolveUpdateTarget(options);
  const beta = await betaTarget(git, target, options.installed);
  if (beta) return beta;
  // --prune: метка, удалённая из origin (отозванный выпуск), уходит и отсюда.
  await requireGit(git, "fetch", "--prune", remote, "+refs/tags/*:refs/tags/*");
  const tags = await requireGit(
    git,
    "tag",
    "--list",
    "v*",
    "--merged",
    target.targetHead,
    "--sort=-v:refname",
  );
  const tag = tags.split("\n").find((name) => RELEASE_TAG.test(name));
  if (!tag)
    throw new Error(
      `no release on ${target.branch} yet; for the newest build run: iva beta`,
    );
  const release = await requireGit(git, "rev-parse", `${tag}^{commit}`);
  const installed = options.installed
    ? await installedIn(git, options.installed)
    : "";
  const ahead = installed && (await isAncestor(git, release, installed));
  return {
    ...target,
    beta: false,
    tag,
    // Установка новее выпуска (его потомок), а не он сам.
    newer: Boolean(ahead) && installed !== release,
    targetHead: ahead ? installed : release,
  };
}

/** Где лежит выбор: git установки и её зеркало (обновление читает зеркало). */
function betaRepos(root: string): string[] {
  const install = classifyRoot(root);
  const repos = new Set([install.home, gitRootFor(install)]);
  const isRepo = (dir: string) =>
    existsSync(join(dir, ".git")) || existsSync(join(dir, "HEAD"));
  return [...repos].filter(isRepo);
}

/** Ветка из репозитория: пусто - ключа нет. */
function branchAt(repo: string): string {
  return (
    spawnSync(
      "git",
      ["-C", repo, "config", "--local", "--get", UPDATE_BRANCH_CONFIG],
      { encoding: "utf8" },
    ).stdout?.trim() ?? ""
  );
}

/**
 * Бета для показа (iva version, status, меню): Update branch `beta`. Отвечает запись
 * владельца - тот же репозиторий установки, из которого обновление берёт ветку
 * (specs/UpdateBranch.tla, OneRecord); кэш зеркала спрашивается, только если в записи
 * ключа нет.
 */
export function betaOf(root: string): boolean {
  const install = classifyRoot(root);
  const branch = branchAt(install.home) || branchAt(gitRootFor(install));
  return branch === BETA_BRANCH;
}

/** iva beta / stable и меню: ветка во всех репозиториях установки, прежний флаг снят. Любая
 * запись не прошла — прежние значения возвращаются везде, false. */
export function setBeta(
  root: string,
  on: boolean,
): "ok" | "unchanged" | "partial" | "no-repo" {
  const git = (repo: string, args: string[]) =>
    spawnSync("git", ["-C", repo, "config", "--local", ...args], {
      encoding: "utf8",
    });
  const keys = [UPDATE_BRANCH_CONFIG, RETIRED_BETA_FLAG];
  const want = [on ? BETA_BRANCH : DEFAULT_UPDATE_BRANCH, ""];
  const repos = betaRepos(root);
  const before = repos.map((repo) =>
    keys.map((key) => git(repo, ["--get", key]).stdout.trim()),
  );
  // Пусто — ключа нет: снять (код 5 — его и так не было).
  const put = (repo: string, key: string, value: string) =>
    [0, value ? 0 : 5].includes(
      git(repo, value ? [key, value] : ["--unset-all", key]).status!,
    );
  if (!repos.length) return "no-repo";
  // Возвращается только то, что записалось: неудачная запись файл не трогала.
  const written: Array<[number, number]> = [];
  const ok = repos.every((repo, r) =>
    keys.every((key, k) => put(repo, key, want[k]) && written.push([r, k])),
  );
  if (ok) return "ok";
  const back = written.map(([r, k]) => put(repos[r], keys[k], before[r][k]));
  return back.every(Boolean) ? "unchanged" : "partial";
}
