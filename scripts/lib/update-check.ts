import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import { button, escapeRichText, screenPayload } from "./telegram-buttons.ts";
import { resolveReleaseTarget, type GitResult } from "./update-channel.ts";

export { notificationChat };

export type GitCommand = (
  root: string,
  args: string[],
) => Promise<GitResult | string>;
type UpdateOffer = {
  text: string;
  // Кнопки — последний абзац text; отдаются отдельно, чтобы вставить блок между телом и ними.
  actions: string;
};
type TelegramResponse = {
  ok: boolean;
  status: number;
  json(): Promise<{ ok?: boolean; result?: unknown; description?: string }>;
};
type TelegramFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TelegramResponse>;

/** git in a directory, never throwing: the caller decides what a failure means. */
export function gitAt(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: (stdout || "").trim(),
          stderr: (stderr || error?.message || "").trim(),
        });
      },
    );
  });
}

/** A git call whose output is required: a non-zero exit becomes the error it printed. */
export async function requireGit(
  gitImpl: GitCommand,
  root: string,
  args: string[],
) {
  const result = await gitImpl(root, args);
  if (typeof result === "string") return result;
  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return result.stdout ?? "";
}

export function packageVersion(jsonText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : null;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function stableParts(version: unknown): number[] | null {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- preserve the JavaScript helper's public coercion behavior during the TypeScript conversion
  const match = String(version ?? "").match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
  return match ? match.slice(1).map(Number) : null;
}

export function compareStableVersions(
  localVersion: unknown,
  remoteVersion: unknown,
): number | null {
  const local = stableParts(localVersion);
  const remote = stableParts(remoteVersion);
  if (!local || !remote) return null;
  for (let i = 0; i < 3; i++) {
    if (remote[i] > local[i]) return 1;
    if (remote[i] < local[i]) return -1;
  }
  return 0;
}

/** Как compareStableVersions, но установленный пререлиз (бета X.Y.Z-…) — чуть младше
 * своего релиза X.Y.Z: сравнивается его ядро. */
function compareInstalled(
  installed: string | null,
  other: string | null,
): number | null {
  const core = String(installed).replace(/-[0-9A-Za-z.-]+$/u, "");
  const bare = compareStableVersions(core, other);
  return bare === 0 && core !== installed ? 1 : bare;
}

/** The file a release uses to name the oldest CLI that can install it. */
export const UPDATE_COMPAT_FILE = "update-compat.json";

/** What an owner runs when their CLI can no longer update itself. */
export const REPAIR_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash";

export type UpdaterCompat =
  | { readonly status: "ok" }
  | {
      readonly status: "too-old";
      readonly own: string;
      readonly minUpdater: string;
    };

type GitRun = (...args: string[]) => Promise<GitResult>;

/** The release a tree is, from its own package.json; null when there is none to read. */
export function installedVersion(root: string): string | null {
  try {
    return packageVersion(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null; // No readable package.json: nothing to name it with.
  }
}

const UPDATER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The release of the CLI running right now — the one deciding whether it may update. */
export function updaterVersion(root: string = UPDATER_ROOT): string {
  const version = installedVersion(root);
  if (!version)
    throw new Error(`no readable release in ${join(root, "package.json")}`);
  return version;
}

/** `minUpdater` of a marker text; anything else is an error, never a null. */
export function parseMinUpdater(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${UPDATE_COMPAT_FILE} is not JSON`);
  }
  const value =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).minUpdater
      : null;
  if (typeof value !== "string" || !stableParts(value))
    throw new Error(
      `${UPDATE_COMPAT_FILE} has no minUpdater release: ${JSON.stringify(value)}`,
    );
  return value;
}

/**
 * `minUpdater` of the fetched tree, or null where the tree carries no marker at all —
 * a commit from before it existed, or a downgrade. A marker that is there but cannot
 * be read is an error: "no answer" must never read as "go ahead".
 */
export async function readMinUpdater(
  git: GitRun,
  commit: string,
): Promise<string | null> {
  const listed = await git("ls-tree", commit, "--", UPDATE_COMPAT_FILE);
  if (listed.code !== 0)
    throw new Error(
      listed.stderr || `could not list ${UPDATE_COMPAT_FILE} at ${commit}`,
    );
  if (!(listed.stdout ?? "").trim()) return null;
  const shown = await git("show", `${commit}:${UPDATE_COMPAT_FILE}`);
  if (shown.code !== 0)
    throw new Error(
      shown.stderr || `could not read ${UPDATE_COMPAT_FILE} at ${commit}`,
    );
  return parseMinUpdater(shown.stdout ?? "");
}

/**
 * May this CLI install that tree? The tree decides: it names the oldest updater able
 * to put it in place, and an older one stops before it touches the installation.
 */
export async function updaterCompat(
  git: GitRun,
  commit: string,
  own: string = updaterVersion(),
): Promise<UpdaterCompat> {
  const minUpdater = await readMinUpdater(git, commit);
  return minUpdater ? floorCompat(own, minUpdater) : { status: "ok" };
}

/** Is the release `own` at the floor a tree names? One comparison for both halves. */
export function floorCompat(own: string, minUpdater: string): UpdaterCompat {
  const comparison = compareInstalled(own, minUpdater);
  if (comparison === null)
    throw new Error(
      `cannot compare the installed release ${JSON.stringify(own)} with minUpdater ${JSON.stringify(minUpdater)}`,
    );
  return comparison === 1
    ? { status: "too-old", own, minUpdater }
    : { status: "ok" };
}

/** The way out of a too-old install: one text, every place that has to say it. */
export function repairInstructions(locale = "en"): string {
  return locale === "ru"
    ? `Откройте терминал на сервере и выполните:\n${REPAIR_COMMAND}\nДанные и .env остаются на месте.`
    : `Open a terminal on the server and run:\n${REPAIR_COMMAND}\nYour data and .env stay in place.`;
}

/** Why the update stopped, and what to run instead. */
export function updaterTooOldMessage(own: string, locale = "en"): string {
  const lead =
    locale === "ru"
      ? `Ваша Iva (${own}) слишком старая, чтобы обновиться сама.`
      : `Your Iva (${own}) is too old to update itself.`;
  return `${lead} ${repairInstructions(locale)}`;
}

export async function inspectUpstream({
  root,
  remote = "origin",
  // The installed commit. On the immutable layout the repository is a mirror whose
  // own HEAD moves with the remote, so the running version has to be named here.
  head = "HEAD",
  gitImpl = gitAt,
}: {
  root?: string;
  remote?: string;
  head?: string;
  gitImpl?: GitCommand;
} = {}) {
  if (!root) throw new Error("update check requires a repository root");
  const run = async (...args: string[]): Promise<GitResult> => {
    const result = await gitImpl(root, args);
    return typeof result === "string"
      ? { code: 0, stdout: result, stderr: "" }
      : result;
  };
  const local = await requireGit(gitImpl, root, ["rev-parse", head]);
  // Цель: выпуск (метка) или вершина при бета-обновлениях; ниже установленного — никогда.
  const target = await resolveReleaseTarget({
    git: run,
    remote,
    installed: local,
  });
  const remoteHead = target.targetHead;
  const behind = await commitsBehind(gitImpl, root, `${head}..${remoteHead}`);
  const localVersion = packageVersion(
    await requireGit(gitImpl, root, ["show", `${head}:package.json`]),
  );
  const remoteVersion = packageVersion(
    await requireGit(gitImpl, root, ["show", `${remoteHead}:package.json`]),
  );
  const versionComparison = compareInstalled(localVersion, remoteVersion);
  const hasCommitUpdate = behind > 0 && local !== remoteHead;
  const hasVersionUpdate = hasCommitUpdate && versionComparison === 1;
  // The same marker both updaters read, from the ref this call already fetched: an
  // Alert that only says "a new version is available" sends an owner into an update
  // that refuses itself (ADR-0003).
  const compat = await updaterCompat(
    run,
    remoteHead,
    localVersion ?? undefined,
  );
  const common = {
    beta: target.beta,
    branch: target.branch,
    currentBranch: target.currentBranch,
    legacyMigration: target.legacyMigration,
    local,
    remote: remoteHead,
    behind,
    localVersion,
    remoteVersion,
    hasCommitUpdate,
    updaterTooOld: compat.status === "too-old",
  };
  return withVersionUpdate(common, hasVersionUpdate, remoteVersion);
}

/** Сколько коммитов в диапазоне; нечисло — ноль. */
async function commitsBehind(gitImpl: GitCommand, root: string, range: string) {
  return (
    Number(await requireGit(gitImpl, root, ["rev-list", "--count", range])) || 0
  );
}

/** Итог проверки: новая версия есть только с известным номером. */
function withVersionUpdate<T extends object>(
  common: T,
  hasVersionUpdate: boolean,
  remoteVersion: string | null,
) {
  if (hasVersionUpdate && remoteVersion !== null)
    return { ...common, remoteVersion, hasVersionUpdate: true as const };
  return { ...common, hasVersionUpdate: false as const };
}

/**
 * Строки «кнопка — что она делает» для предложения обновления. Одна сборка на оба
 * экрана, которые его показывают: ежедневный Alert (updateOffer) и /update в мосте.
 * `what` — что именно поставит кнопка: «v0.4.2» или «новую сборку», когда номер тот же.
 */
export function updateOfferActionLines(locale: string, what: string): string {
  const ru = locale === "ru";
  const update = ru ? "⬆️ Обновить" : "⬆️ Update";
  const later = ru ? "Позже" : "Later";
  return [
    `${button(update, "iva_update:do", "success")} — ${ru ? `поставить ${what}` : `install ${what}`}`,
    `${button(later, "iva_update:skip")} — ${ru ? "напомню завтра" : "I'll remind you tomorrow"}`,
  ].join("\n\n");
}

/**
 * Что обновление действительно оставляет на месте, одной строкой на оба экрана
 * предложения. Правки в коде Ивы оно не переносит: версия ставится из коммита
 * (решение владельца 13.09.2026), и обещать обратное нельзя.
 */
export function updateKeepsLine(locale: string): string {
  return locale === "ru"
    ? "Настройки, память и ваши скиллы на месте. Правки в коде Ивы не переносятся."
    : "Settings, memory and your skills stay in place. Edits to Iva's own code are not carried over.";
}

export function updateOffer(
  localVersion: string | null | undefined,
  remoteVersion: string | null | undefined,
  locale = "en",
  // Tapping «Update» on such a release only earns the refusal below; the Alert says
  // what to run instead, in the same words the updater uses.
  updaterTooOld = false,
): UpdateOffer {
  const ru = locale === "ru";
  const head = ru
    ? `⬆️ Доступна новая версия Ивы\n\nv${escapeRichText(String(localVersion))} → v${escapeRichText(String(remoteVersion))}`
    : `⬆️ A new Iva version is available\n\nv${escapeRichText(String(localVersion))} → v${escapeRichText(String(remoteVersion))}`;
  const tail = updaterTooOld
    ? repairInstructions(locale)
    : updateKeepsLine(locale);
  // Кнопки — строки самого сообщения: каждая рядом со своим пояснением (контракт rich).
  const actions = updateOfferActionLines(
    locale,
    `v${escapeRichText(String(remoteVersion))}`,
  );
  return {
    text: `${head}\n\n${tail}\n\n${actions}`,
    actions,
  };
}

/** Заголовки строк CHANGELOG `Unreleased` (эмодзи и жирный заголовок), не больше пяти. */
function unreleasedHeadlines(changelog: string): string[] {
  const section =
    changelog.split(/^## /mu).find((part) => part.startsWith("[Unreleased]")) ??
    "";
  return [...section.matchAll(/^- (\S+) \*\*(.+?)\*\*/gmu)]
    .slice(0, 5)
    .map(([, emoji, title]) => `${emoji} ${title}`);
}

/** Alert бета-обновлений: новая сборка ветки — её версия и что в ней из CHANGELOG.
 * Обновлятор установки старше нужного сборке — вместо кнопки инструкция ремонта. */
export function betaOffer(
  version: string,
  changelog: string,
  locale = "en",
  updaterTooOld = false,
): UpdateOffer {
  const ru = locale === "ru";
  const head = `${ru ? "🧪 Новая бета-сборка Ивы" : "🧪 A new Iva beta build"}\n\nv${escapeRichText(version)}`;
  const news = unreleasedHeadlines(changelog)
    .map((line) => `• ${escapeRichText(line)}`)
    .join("\n");
  const actions = updaterTooOld
    ? ""
    : updateOfferActionLines(locale, ru ? "бета-сборку" : "the beta build");
  const tail = updaterTooOld
    ? repairInstructions(locale)
    : updateKeepsLine(locale);
  const parts = [head, news, tail, actions];
  return { text: parts.filter(Boolean).join("\n\n"), actions };
}

export async function sendUpdateOffer({
  token,
  chatId,
  offer,
  fetchImpl = fetch,
}: {
  token?: string;
  chatId?: string | number;
  offer?: UpdateOffer;
  fetchImpl?: TelegramFetch;
} = {}): Promise<unknown> {
  if (!offer) throw new Error("update offer is required");
  // Стиль меню владельца: rich message или обычный текст с клавиатурой (classic).
  const payload = screenPayload(offer.text);
  const method = "rich_message" in payload ? "sendRichMessage" : "sendMessage";
  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    },
  );
  const data: { ok?: boolean; result?: unknown; description?: string } =
    await response
      .json()
      .catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
  if (!response.ok || !data.ok)
    throw new Error(data.description || `Telegram ${response.status}`);
  return data.result;
}

export function updateCheckStatePath(dataDir: string): string {
  return join(dataDir, "update-check.json");
}

export async function readNotifiedVersion(
  dataDir: string,
): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(updateCheckStatePath(dataDir), "utf8"),
    );
    const state =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    return typeof state?.lastNotifiedVersion === "string"
      ? state.lastNotifiedVersion
      : null;
  } catch {
    return null;
  }
}

export async function markVersionNotified(
  dataDir: string,
  version: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = updateCheckStatePath(dataDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temp,
      `${JSON.stringify({ lastNotifiedVersion: version, notifiedAt: new Date().toISOString() })}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
