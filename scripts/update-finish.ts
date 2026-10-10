import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG, catalogProvider } from "./lib/model-catalog.ts";
import { notificationChat } from "./lib/notification-chat.ts";
import { redactNotice } from "./lib/notice.ts";
import {
  alertOnce,
  CUSTOM_ALERT_KEY,
  customStockAlert,
  noticeTranslator,
  PLUGIN_ALERT_KEY,
  pluginsSwitchedOffAlert,
  type Translate,
  USERBOT_ALERT_KEY,
  userbotOffAlert,
  userbotOffReason,
} from "./lib/notice-policy.ts";
import {
  isEntrypoint,
  refreshOwnedShim,
  shimIsForeign,
  SHIM_PATH,
} from "./lib/version-layout.ts";
import { throughLink } from "./lib/link-target.ts";
import {
  quarantinePath,
  rewriteRunStatusesForUpdate,
  sessionStateTargets,
} from "./lib/wf-store.ts";
import {
  adoptUpdateLock,
  layoutFor,
  LEGACY_STATE_DIRS,
  readJson,
  STATE_DIRS,
} from "./lib/version-store.ts";
import {
  LEGACY_BRAIN_UNITS,
  LEGACY_MEMORY_UNITS,
} from "./lib/legacy-memory-units.ts";
import {
  commandRunner,
  customOverlay,
  finishVersionUpdate,
  pluginsOffNotice,
  stockFailureLine,
  type UpdateOutcome,
} from "./lib/version-update.ts";
import type { PluginFailure } from "./lib/plugin-build.ts";
import { tryLoadPluginCore } from "./lib/plugin-core.ts";
import { pluginUnitNames, runningPluginUnits } from "./lib/plugin-units.ts";
import type { createCliRuntime } from "./cli/runtime.ts";
import type { createCliSystemd } from "./cli/systemd.ts";
import type { reinstallUserbot } from "./cli/userbot.ts";

type Say = (message: string) => void;
type CliRuntime = ReturnType<typeof createCliRuntime>;
type WriterRuntime = Pick<
  CliRuntime,
  "BRAIN_TIMER" | "BRAIN_SERVICE" | "SERVICES" | "SVC_USERBOT" | "systemd"
>;

export type UpdateQuarantine = {
  readonly path: string;
  readonly trash: string;
};

/** Retire open session state as one reversible update step. */
export function quarantineUpdateState(
  root: string,
  dataDir: string,
  notify: Say,
  stamp = new Date().toISOString().replace(/[:.]/gu, "-"),
): UpdateQuarantine[] {
  const quarantined: UpdateQuarantine[] = [];
  try {
    for (const target of sessionStateTargets(root, dataDir)) {
      const path = throughLink(target);
      const trash = quarantinePath(target, stamp);
      if (trash) quarantined.push({ path, trash });
    }
    return quarantined;
  } catch (error) {
    try {
      restoreUpdateStateOrNotify(
        quarantined,
        notify,
        "update state quarantine and recovery both failed",
      );
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "update state quarantine and restoration both failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

/** Put quarantined state back before the previous version starts. */
export function restoreUpdateState(
  quarantined: readonly UpdateQuarantine[],
): void {
  for (const entry of [...quarantined].reverse()) {
    rmSync(entry.path, { recursive: true, force: true });
    renameSync(entry.trash, entry.path);
  }
}

/** Restore update state and tell the owner where manual recovery data remains. */
export function restoreUpdateStateOrNotify(
  quarantined: readonly UpdateQuarantine[],
  notify: Say,
  failure: string,
): void {
  try {
    restoreUpdateState(quarantined);
  } catch (error) {
    notify(
      `${failure}; state is in ${quarantined.map(({ trash }) => trash).join(", ")}; manual help is needed`,
    );
    throw error;
  }
}

export type OptionalWriterState = {
  readonly unit: string;
  readonly loadState: string;
  readonly active: boolean;
  readonly enabled: boolean;
};

function unitLoadState(runtime: WriterRuntime, unit: string): string {
  const result = runtime.systemd.query(
    "show",
    unit,
    "--property=LoadState",
    "--value",
  );
  if (
    result.code === 0 &&
    ["loaded", "not-found", "error", "masked", "stub", "merged"].includes(
      result.out,
    )
  )
    return result.out;
  throw new Error(`could not read load state for ${unit}: ${result.out}`);
}

function present(loadState: string): boolean {
  return loadState !== "not-found";
}

function unitActive(runtime: WriterRuntime, unit: string): boolean {
  const result = runtime.systemd.query("is-active", unit);
  if (
    ["active", "activating", "deactivating", "reloading"].includes(result.out)
  )
    return true;
  if (["inactive", "failed", "unknown"].includes(result.out)) return false;
  throw new Error(`could not read active state for ${unit}: ${result.out}`);
}

function unitEnabled(runtime: WriterRuntime, unit: string): boolean {
  const result = runtime.systemd.query("is-enabled", unit);
  if (result.out === "enabled") return true;
  if (
    [
      "disabled",
      "static",
      "masked",
      "indirect",
      "generated",
      "transient",
      "not-found",
    ].includes(result.out)
  )
    return false;
  throw new Error(`could not read enabled state for ${unit}: ${result.out}`);
}

/** Snapshot optional writers before any stop can change their runtime state. */
export function captureOptionalWriterState(
  runtime: WriterRuntime,
): OptionalWriterState[] {
  return [
    ...new Set([
      runtime.BRAIN_TIMER,
      runtime.BRAIN_SERVICE,
      runtime.SVC_USERBOT,
      ...LEGACY_BRAIN_UNITS,
      ...LEGACY_MEMORY_UNITS,
    ]),
  ].map((unit) => {
    const loadState = unitLoadState(runtime, unit);
    return {
      unit,
      loadState,
      active: present(loadState) && unitActive(runtime, unit),
      enabled: present(loadState) && unitEnabled(runtime, unit),
    };
  });
}

/** Stop every present writer. Missing optional units remain a valid legacy state. */
export function stopWriterUnits(
  runtime: WriterRuntime,
  optional = captureOptionalWriterState(runtime),
): void {
  const optionalTimers = optional
    .filter(
      (state) => present(state.loadState) && state.unit.endsWith(".timer"),
    )
    .map((state) => state.unit);
  const optionalServices = optional
    .filter(
      (state) => present(state.loadState) && state.unit.endsWith(".service"),
    )
    .map((state) => state.unit);
  for (const writers of [optionalTimers, optionalServices, runtime.SERVICES]) {
    if (writers.length === 0) continue;
    runtime.systemd.stop(writers);
    for (const unit of writers) {
      if (unitActive(runtime, unit))
        throw new Error(`writer ${unit} remained active after stop`);
    }
  }
}

function checkedUnitAction(
  runtime: WriterRuntime,
  action: "enable" | "start",
  unit: string,
): void {
  const result = runtime.systemd.query(action, unit);
  if (result.code !== 0)
    throw new Error(`systemctl --user ${action} ${unit} failed: ${result.out}`);
}

/** Restore exact optional active/enabled flags without starting a disabled unit. */
export function restoreOptionalWriterState(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
): void {
  for (const state of states) {
    if (!present(state.loadState)) continue;
    if (!present(unitLoadState(runtime, state.unit)))
      throw new Error(`captured writer ${state.unit} disappeared`);
    if (state.enabled !== unitEnabled(runtime, state.unit)) {
      if (state.enabled) checkedUnitAction(runtime, "enable", state.unit);
      else runtime.systemd.disableNow([state.unit]);
    }
    if (state.active !== unitActive(runtime, state.unit)) {
      if (state.active) checkedUnitAction(runtime, "start", state.unit);
      else runtime.systemd.stop([state.unit]);
    }
    if (
      state.enabled !== unitEnabled(runtime, state.unit) ||
      state.active !== unitActive(runtime, state.unit)
    )
      throw new Error(`could not restore ${state.unit} state`);
  }
}

function mergedState(
  states: readonly OptionalWriterState[],
  units: ReadonlySet<string>,
): Pick<OptionalWriterState, "active" | "enabled"> {
  return states
    .filter((state) => present(state.loadState) && units.has(state.unit))
    .reduce<{ active: boolean; enabled: boolean }>(
      (merged, state) => ({
        active: merged.active || state.active,
        enabled: merged.enabled || state.enabled,
      }),
      { active: false, enabled: false },
    );
}

function restoreUnitState(
  runtime: WriterRuntime,
  state: OptionalWriterState,
): void {
  restoreOptionalWriterState(runtime, [state]);
}

/** Restore captured writer semantics after writeUnits retires legacy names. */
export function restoreMigratedWriterState(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
  { legacyMemoryOwnerProven = false } = {},
): void {
  restoreOptionalWriterState(
    runtime,
    states.filter((state) => state.unit === runtime.SVC_USERBOT),
  );
  const brainTimers = new Set([
    runtime.BRAIN_TIMER,
    ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".timer")),
  ]);
  const brainServices = new Set([
    runtime.BRAIN_SERVICE,
    ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".service")),
  ]);
  restoreUnitState(runtime, {
    unit: runtime.BRAIN_TIMER,
    loadState: "loaded",
    ...mergedState(states, brainTimers),
  });
  restoreUnitState(runtime, {
    unit: runtime.BRAIN_SERVICE,
    loadState: "loaded",
    ...mergedState(states, brainServices),
  });

  const legacyMemory = states.filter(
    (state) =>
      LEGACY_MEMORY_UNITS.includes(state.unit) && present(state.loadState),
  );
  const remaining = new Map(
    legacyMemory.map((state) => [
      state.unit,
      present(unitLoadState(runtime, state.unit)),
    ]),
  );
  restoreOptionalWriterState(
    runtime,
    legacyMemory.filter((state) => remaining.get(state.unit)),
  );
  const hadLegacyMemorySchedule = legacyMemory.some(
    (state) => state.active || state.enabled,
  );
  const completeLegacySchedule = legacyMemory.every((state) => {
    if (!state.active && !state.enabled) return true;
    if (!remaining.get(state.unit)) return false;
    if (!state.unit.endsWith(".timer")) return true;
    return remaining.get(state.unit.replace(/\.timer$/u, ".service")) === true;
  });
  const owner = runtime.SERVICES[0];
  if (hadLegacyMemorySchedule && !completeLegacySchedule) {
    if (!legacyMemoryOwnerProven)
      throw new Error(
        "legacy memory schedule owner was not proven by writeUnits",
      );
    if (!owner || !unitActive(runtime, owner))
      throw new Error("legacy memory schedule has no active service owner");
  }
}

export function restoreWriterOwnership(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
  phase: {
    readonly unitMigrationStarted: boolean;
    readonly legacyMemoryOwnerProven: boolean;
    readonly userbotReady: boolean;
  },
): void {
  if (phase.userbotReady !== true)
    states = states.map((state) =>
      state.unit === runtime.SVC_USERBOT && state.active
        ? { ...state, active: false, enabled: false }
        : state,
    );
  if (!phase.unitMigrationStarted) {
    restoreOptionalWriterState(runtime, states);
    return;
  }
  restoreMigratedWriterState(runtime, states, {
    legacyMemoryOwnerProven: phase.legacyMemoryOwnerProven,
  });
}

/** Build leftovers of a checkout: not tracked, not state, never worth keeping. */
const ARTIFACTS =
  ".git .iva-build .iva-update .output .worktrees node_modules".split(" ");

/**
 * Метка незавершённого вывода. Ставится после первого состоявшегося удаления и снимается
 * в конце удачного прохода: если вывод упал до первого удаления (например, на чужих
 * правах), метки не остаётся вовсе.
 *
 * Метка несёт идентичность выводимого дерева (путь, inode каталога `.git`, HEAD) и
 * проверяется перед сносом. Без неё и без git вывод не трогает ничего: залипшая метка
 * на живом дереве не имеет права санкционировать снос.
 */
export const RETIRE_MARKER = ".iva-retiring";

/** Артефакты чекаута без `.git`: сам репозиторий уходит последним. */
const RETIRE_ARTIFACTS = ARTIFACTS.filter((path) => path !== ".git");

export interface RetireIdentity {
  readonly home: string;
  /** dev+inode каталога: вторая ветка сверки, когда `.git` уже снесён обрывом. */
  readonly homeDev: string | null;
  readonly homeIno: string | null;
  readonly gitDev: string | null;
  readonly gitIno: string | null;
  readonly headSha: string | null;
  readonly at: number;
}

/** Идентичность дерева: путь, `.git` (dev+inode) и HEAD, если они читаются. */
export function retireIdentity(home: string): RetireIdentity | null {
  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch {
    return null;
  }
  let homeDev: string | null = null;
  let homeIno: string | null = null;
  try {
    const stat = lstatSync(realHome, { bigint: true });
    homeDev = String(stat.dev);
    homeIno = String(stat.ino);
  } catch {
    // Каталог исчез между realpath и stat - сверять будет нечем, поля остаются пустыми.
  }
  let gitDev: string | null = null;
  let gitIno: string | null = null;
  try {
    const stat = lstatSync(join(realHome, ".git"), { bigint: true });
    gitDev = String(stat.dev);
    gitIno = String(stat.ino);
  } catch {
    // `.git` уже нет или не читается - идентичность держится на каталоге и пути.
  }
  let headSha: string | null = null;
  try {
    headSha = git(realHome, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    // Покалеченный или недоступный git: HEAD неизвестен.
  }
  return {
    home: realHome,
    homeDev,
    homeIno,
    gitDev,
    gitIno,
    headSha,
    at: Date.now(),
  };
}

/** Метка с диска; нет файла или мусор - null (чужую метку не толкуем как свою). */
export function readRetireMarker(marker: string): RetireIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(marker, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.home !== "string") return null;
  const optional = (field: unknown): string | null =>
    typeof field === "string" && field.length > 0 ? field : null;
  return {
    home: value.home,
    homeDev: optional(value.homeDev),
    homeIno: optional(value.homeIno),
    gitDev: optional(value.gitDev),
    gitIno: optional(value.gitIno),
    headSha: optional(value.headSha),
    at:
      typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
  };
}

/** Метка принадлежит этому дереву: путь совпал и `.git` тот же самый (dev+inode). */
export function sameRetireTree(
  marker: RetireIdentity,
  current: RetireIdentity,
): boolean {
  if (marker.home !== current.home) return false;
  // Если в метке записан `.git`, он обязан совпасть: пересозданный репозиторий на том же
  // пути - уже другое дерево.
  if (marker.gitDev !== null || marker.gitIno !== null) {
    if (current.gitDev !== null || current.gitIno !== null)
      return (
        marker.gitDev === current.gitDev && marker.gitIno === current.gitIno
      );
    // `.git` уже снесён обрывом: сверять репозиторий нечем, вторая ветка - сам каталог
    // (dev+inode). Без неё повтор после обрыва сразу за удалением `.git` не дочищал
    // вывод никогда: метка оставалась, а идентичность давала null/null.
    if (marker.homeDev !== null && current.homeDev !== null)
      return (
        marker.homeDev === current.homeDev && marker.homeIno === current.homeIno
      );
  }
  return true;
}

/**
 * Есть ли что-то по пути - хоть битый симлинк. `existsSync` идёт по ссылке и на
 * симлинке в никуда отвечает «нет», а tracked-файл, подменённый такой ссылкой, вывод
 * чекаута обязан снести наравне с обычным.
 */
function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Убрать опустевшие родители пути до home; каталог с любым содержимым остаётся. */
function pruneEmptyParents(home: string, path: string): void {
  for (let at = dirname(path); at !== home; at = dirname(at)) {
    try {
      rmdirSync(at);
    } catch {
      return; // Не пусто (или уже нет) - выше содержимое есть точно.
    }
  }
}

/** First path segment, for both `agent/tools/x.ts` and a bare `install.sh`. */
function topLevel(path: string): string {
  return path.split("/", 1)[0] ?? "";
}

/** Never removed, whatever git says about them. */
const KEEP = new Set([
  ...[...STATE_DIRS, ...LEGACY_STATE_DIRS].map(topLevel),
  ...".env current repo versions".split(" "),
]);

function errorCode(error: unknown): unknown {
  return (error as { readonly code?: unknown } | null | undefined)?.code;
}

function git(home: string, args: string[]): string {
  return execFileSync("git", ["-C", home, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
}

/**
 * Install the shim that outlives every version; refresh only an owned stale snapshot.
 *
 * Чужой файл на том же пути не трогаем - но и молчать нельзя: `bin/iva.mjs` чекаута
 * при переводе на версии уходит, и команда `iva` через чужой файл в установку уже не
 * ведёт. Одна строка владельцу говорит, чем запускать, пока файл на месте.
 */
export function writeShim(
  home: string,
  log: Say,
  notify: Say = () => {},
): void {
  if (
    refreshOwnedShim(SHIM_PATH, home, process.execPath, layoutFor(home).data)
  ) {
    log(`rewrote ${SHIM_PATH}`);
    return;
  }
  if (shimIsForeign(SHIM_PATH, home))
    notify(
      `${SHIM_PATH} is not a shim of ours, so the update left it alone; until you move it away run \`node ${join(home, "current/bin/iva.mjs")}\` instead of \`iva\``,
    );
}

/**
 * Remove the working tree the installation ran from, now that a version runs
 * instead. Every file git accounts for goes, an edited one too - the version is
 * built from the commit, and an edit to Iva's own code the update does not carry
 * over. What git does not account for stays: a file the owner put next to ours,
 * the userbot's venv, a skill's credentials are theirs, and a layout change is no
 * right to them.
 *
 * Судится каждый файл, не каталог: чужой файл в нашем каталоге спасает себя, а не
 * правленые исходники рядом с собой - иначе один `scripts/mine.txt` оставлял бы весь
 * `scripts/` от старой установки. Каталоги-артефакты (`node_modules`, `.git`) уходят
 * целиком, как и раньше; опустевшие наши каталоги подчищаются проходом ниже.
 *
 * Прерываемость: до первого удаления ставится метка (RETIRE_MARKER), `.git` идёт
 * последним, а пустые родители подчищаются отдельным проходом в конце. Поэтому
 * повтор после обрыва на любом шаге доводит вывод до конца.
 */
export function retireCheckout(home: string, notify: Say = () => {}): string[] {
  const marker = join(home, RETIRE_MARKER);
  const previous = readRetireMarker(marker);
  let tracked: string[] | null;
  try {
    // -z: without it git escapes and quotes every path outside ASCII, and a quoted
    // name matches no file, retiring the checkout only in part.
    tracked = git(home, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    // Git как команда недоступен (нет в PATH): не сносим ничего. Метка санкционирует
    // снос только покалеченного репозитория (git есть, но не отвечает), и только если
    // она принадлежит этому дереву.
    if (errorCode(error) === "ENOENT") {
      notify(
        `git is not available - the checkout at ${home} was not retired, nothing was removed`,
      );
      return [];
    }
    tracked = null;
  }
  if (tracked === null) {
    // Git есть, но репозиторий не отвечает (покалечен обрывом).
    if (!previous) {
      notify(
        `the checkout at ${home} has a broken .git and no retire marker - nothing was removed, clean it up by hand`,
      );
      return [];
    }
    const current = retireIdentity(home);
    if (!current || !sameRetireTree(previous, current)) {
      notify(
        `the retire marker at ${marker} does not belong to this tree - nothing was removed`,
      );
      return [];
    }
    const removed = new Set<string>();
    for (const path of [...RETIRE_ARTIFACTS, ".git"]) {
      const full = join(home, path);
      if (!pathPresent(full)) continue;
      rmSync(full, { recursive: true, force: true });
      removed.add(path);
    }
    for (const path of [...RETIRE_ARTIFACTS, ".git"])
      pruneEmptyParents(home, join(home, path));
    rmSync(marker, { force: true });
    return [...removed].sort();
  }
  if (!tracked.includes("package.json")) return [];

  let identity: RetireIdentity | null = null;
  let marked = false;

  const removed = new Set<string>();
  // Артефакты пересобираются, их не жалко; `.git` последним: обрыв оставляет повтору
  // работающий git, а не дерево без истории.
  for (const path of [...tracked, ...RETIRE_ARTIFACTS, ".git"]) {
    const name = topLevel(path);
    if (KEEP.has(name)) continue;
    const full = join(home, path);
    if (!pathPresent(full)) continue;
    // Идентичность снимается до удалений (`.git` уходит последним, так что он ещё цел)
    // и ложится в метку только после первого состоявшегося удаления: упавший на первом
    // файле вывод не оставляет метки вовсе.
    identity ??= retireIdentity(home);
    rmSync(full, { recursive: true, force: true });
    removed.add(name);
    if (!marked && identity) {
      try {
        writeFileSync(marker, JSON.stringify(identity), { mode: 0o600 });
        marked = true;
      } catch {
        // Не смогли пометить - вывод всё равно продолжится; окно обрыва остаётся прежним.
      }
    }
  }
  // Пустые каталоги - после файлов: обрыв мог случиться уже после удаления последнего
  // файла, и тогда подчищать нечего, кроме самих каталогов.
  for (const path of [...tracked, ...RETIRE_ARTIFACTS, ".git"])
    pruneEmptyParents(home, join(home, path));
  rmSync(marker, { force: true });
  return [...removed].sort();
}

/**
 * Files the custom layer of the checkout era recorded as deleted. The overlay that
 * replaces it only adds, so a deletion comes undone and has to be reported.
 */
export function tombstoned(
  home: string,
  dataDir = layoutFor(home).data,
): string[] {
  const entries = (readJson(join(dataDir, "custom/manifest.json")).entries ??
    {}) as Record<string, { tombstone?: boolean } | undefined>;
  return Object.keys(entries)
    .filter((path) => entries[path]?.tombstone)
    .sort();
}

/**
 * One plain message to the owner's chat. A direct Bot API call, like the update offer
 * this Alert stands beside (scripts/check-update.ts): the marked-up sender lives in the
 * authored tree, and this process runs in a version directory that may not have a
 * `node_modules` yet - a dependency reached on any path through it is a crash with no
 * update (scripts/lib/version-update.test.ts pins that). The text reaches it through the
 * outbound Gate (alertOwnerOnce): the stock-build Alert carries a line of build output.
 */
function sendToChat(
  token: string,
  chat: string,
): (text: string) => Promise<boolean> {
  return async (text) => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text }),
        },
      );
      return response.ok;
    } catch (error) {
      console.error("[alert] could not send the alert:", error);
      return false;
    }
  };
}

/**
 * A plugin was switched off because its code will not build with this version. The
 * update output carries the reason for whoever is watching it; this is the half that
 * reaches an owner who ordered the update from Telegram and never sees a terminal.
 *
 * An Alert, so it obeys ADR-0007: it says what broke, what it costs and what to do,
 * and it repeats at most once a week for the same set of plugins. The essence is what
 * each of them contained - a plugin the owner has changed since is a different problem
 * and speaks at once.
 */
export async function alertOwnerAboutPlugins(
  layout: ReturnType<typeof layoutFor>,
  failures: readonly PluginFailure[],
  notify: Say,
  /** The chat, or a stand-in for it in tests; absent means the installation's own. */
  send?: (text: string) => Promise<boolean>,
): Promise<void> {
  notify(pluginsOffNotice(failures));
  const names = failures.map((failure) => failure.name);
  await alertOwnerOnce(
    layout,
    {
      key: PLUGIN_ALERT_KEY,
      // The essence is which content failed: a plugin the owner has since changed is a
      // different problem and speaks at once instead of waiting out the week.
      essence: failures
        .map((failure) => `${failure.name}@${failure.digest}`)
        .join(" "),
      text: (tr) => pluginsSwitchedOffAlert(tr, names),
      about: names.join(", "),
    },
    notify,
    send,
  );
}

/**
 * The version runs the stock build: the owner's files in data/custom did not build or
 * did not come up with it. The update output keeps the whole line; the chat gets the
 * first line of the error, at most once a week for the same files (ADR-0007). Changed
 * files are a different problem and speak at once.
 */
export async function alertOwnerAboutCustom(
  layout: ReturnType<typeof layoutFor>,
  notice: string,
  notify: Say,
  send?: (text: string) => Promise<boolean>,
): Promise<void> {
  notify(notice);
  await alertOwnerOnce(
    layout,
    {
      key: CUSTOM_ALERT_KEY,
      essence: customEssence(layout.data),
      text: (tr) => customStockAlert(tr, stockFailureLine(notice)),
      about: "the stock build",
    },
    notify,
    send,
  );
}

/** What the update output names when an Alert about the userbot did not reach the chat. */
const USERBOT = "the userbot";

/** The one output line for an Alert the chat did not get. */
function untold(about: string): string {
  return `could not tell you in Telegram about ${about}`;
}

/**
 * Tell the owner the userbot is off, if it is and there is someone to tell. Telling never
 * fails the update it reports on: a throw is one output line.
 */
async function tellAboutUserbot(
  alert: ((reason: string) => Promise<void>) | undefined,
  reason: string | undefined,
  notify: Say,
): Promise<void> {
  if (alert === undefined || reason === undefined) return;
  try {
    await alert(reason);
  } catch (error) {
    console.error("[alert] could not tell about the userbot:", error);
    notify(untold(USERBOT));
  }
}

/**
 * The update switched the userbot off: its environment did not prepare or its proxy did
 * not answer (#273). The update output already carries the reason and `iva userbot setup`
 * (reinstallUserbot); this is the half that reaches an owner who pressed «Update» in
 * Telegram. ADR-0007: once a week for the same reason, at once for another one - and at
 * once after the fix: a userbot that answers again forgets this Alert (scripts/cli/userbot.ts).
 */
export async function alertOwnerAboutUserbot(
  layout: ReturnType<typeof layoutFor>,
  reason: string,
  notify: Say,
  send?: (text: string) => Promise<boolean>,
): Promise<void> {
  await alertOwnerOnce(
    layout,
    {
      key: USERBOT_ALERT_KEY,
      essence: userbotOffReason(reason),
      text: (tr) => userbotOffAlert(tr, reason),
      about: USERBOT,
    },
    notify,
    send,
  );
}

/**
 * The userbot Alert of a whole update: `reason` is the flip's, and it is told only once the
 * version is served. A rollback brings the userbot back on the version it ran on, and a
 * message that it is off would be false - and would hush the true one for a week.
 */
export async function alertOwnerWhenServed(
  outcome: UpdateOutcome,
  reason: string | undefined,
  alert: (reason: string) => Promise<void>,
  notify: Say,
): Promise<void> {
  if (outcome.status !== "updated") return;
  await tellAboutUserbot(alert, reason, notify);
}

/** What the owner's files contain; an Alert must not fail the update it reports on. */
function customEssence(dataDir: string): string {
  try {
    return customOverlay(join(dataDir, "custom")).digest ?? "none";
  } catch {
    return "unreadable";
  }
}

/** One Alert through the installation's chat, throttled by its key and essence. */
async function alertOwnerOnce(
  layout: ReturnType<typeof layoutFor>,
  alert: {
    readonly key: string;
    readonly essence: string;
    readonly text: (tr: Translate) => string;
    /** What the update output names when the chat could not be told. */
    readonly about: string;
  },
  notify: Say,
  send?: (text: string) => Promise<boolean>,
): Promise<void> {
  const token = String(layout.values.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(layout.values);
  const deliver = send ?? (token && chat ? sendToChat(token, chat) : null);
  if (!deliver) return; // Nowhere to say it; the output above is all there is.
  // Через outbound-Gate: строка ошибки сборки — вывод файлов владельца, данные рантайма.
  const text = await redactNotice(
    alert.text(await noticeTranslator(layout.values)),
  );
  const outcome = await alertOnce(layout.data, alert.key, alert.essence, () =>
    deliver(text),
  );
  if (outcome === "failed") notify(untold(alert.about));
}

/**
 * After the flip: an MCP proxy and a plugin service run code out of the version that
 * `current` points at, so the flip alone does not move them - a restart does.
 *
 * Only what is running is restarted, and a unit that refuses is one line in the log: an
 * update that is otherwise finished must not fail over a plugin, and `iva doctor` says
 * which unit is down.
 */
export async function restartPluginUnits(
  runtime: Pick<CliRuntime, "systemd" | "UNIT_DIR">,
  dataDir: string,
  log: Say,
): Promise<void> {
  const core = await tryLoadPluginCore();
  if (!core) return;
  const { state, damaged } = await core.store.readPluginsStateSafe(dataDir);
  if (damaged) return;
  const units: string[] = [];
  for (const entry of state.plugins) {
    if (!entry.enabled || !entry.trusted) continue;
    units.push(...pluginUnitNames(entry));
  }
  const live = runningPluginUnits({
    units,
    unitDir: runtime.UNIT_DIR,
    isActive: (unit) => runtime.systemd.isActive(unit),
  });
  if (live.length === 0) return;
  try {
    runtime.systemd.restart(live);
    log(`restarted ${live.length} plugin unit(s) onto the new version`);
  } catch (error) {
    log(
      `some plugin units did not restart: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The flip's restart: the version `current` now names starts its services, and every
 * optional writer quiesce stopped is handed back as it was found - except a userbot that
 * was running. That one comes back only when its environment was rebuilt and its proxy
 * answered; a failed recovery, or a restart that threw before recovery ran, leaves it
 * stopped and disabled, so systemd cannot loop it on a broken environment (#273).
 *
 * A userbot this step switched off is handed to `alertUserbot` with its reason, once the
 * writers are restored. Telling the owner is never a reason for the step to fail: a throw
 * there is one line in the output.
 */
export async function startCandidateServices(
  runtime: CliRuntime,
  services: Pick<
    ReturnType<typeof createCliSystemd>,
    "restartServices" | "retireDeferredBrainUnits" | "writeUnits"
  >,
  {
    states,
    dataDir,
    log,
    notify,
    migration,
    reinstall,
    alertUserbot,
  }: {
    readonly states: readonly OptionalWriterState[] | undefined;
    readonly dataDir: string;
    readonly log: Say;
    readonly notify: Say;
    /** Shared with the rollback: it must know whether units were rewritten. */
    readonly migration: { started: boolean };
    readonly reinstall: typeof reinstallUserbot;
    /** The userbot was running and is off now; `reason` is the recovery's. */
    readonly alertUserbot?: (reason: string) => Promise<void>;
  },
): Promise<void> {
  const capturedUserbot = states?.find(
    (state) => state.unit === runtime.SVC_USERBOT,
  );
  let userbotReady = capturedUserbot?.active !== true;
  let userbotOff: string | undefined;
  try {
    services.restartServices({
      afterUnitWrite: () => {
        migration.started = true;
      },
      ...(capturedUserbot?.loadState === "not-found"
        ? { skipUnits: [runtime.SVC_USERBOT] }
        : {}),
      deferBrainMigration: true,
      deferMemoryMigration: true,
    });
    runtime.systemd.activate([runtime.UPDATE_TIMER]);
    // The code of every plugin proxy is in the version this flip just made
    // current; nothing else brings them onto it.
    await restartPluginUnits(runtime, dataDir, log);
    if (capturedUserbot?.active === true) {
      const recovery = await reinstall(runtime, services, notify, {
        knownActive: true,
      });
      userbotReady = recovery.status === "ready";
      if (recovery.status === "failed") userbotOff = recovery.reason;
    }
  } finally {
    if (states) {
      restoreWriterOwnership(runtime, states, {
        unitMigrationStarted: migration.started,
        legacyMemoryOwnerProven: false,
        userbotReady,
      });
      if (migration.started) services.retireDeferredBrainUnits();
    }
  }
  await tellAboutUserbot(alertUserbot, userbotOff, notify);
}

/**
 * The second half of an update, run by the version being installed: install,
 * build, probe, flip, migrate, restart and retire the old checkout all belong to
 * the new code, so a fix to any of them ships in the release carrying it.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [home, name, ...flags] = argv;
  if (!home || !name) throw new Error("usage: update-finish <home> <version>");
  const verbose = flags.includes("--verbose");
  // `iva plugin add|update|enable`: the plugin is what this build is for, so a plugin
  // that will not build fails the build instead of being switched off (ADR-0009).
  const requirePlugins = flags.includes("--require-plugins");
  const layout = layoutFor(home);

  // The same MODEL_PROVIDER check the CLI does before it starts an update — repeated here
  // because on a managed installation the first half of every update is run by the version
  // already on disk. A check that only exists in the new version can therefore never run
  // while the value is broken: the old CLI fetches, this half builds, the probe fails, the
  // update rolls back, and the next attempt repeats it. Forever, not once.
  //
  // This function is the first code of the new version to execute on the machine, and it
  // runs before the build, so refusing here costs the user one fetch instead of a build and
  // a health cycle - and finally names the value. `iva update` on the release after this one
  // refuses before even that (scripts/cli/version-update-command.ts).
  const configured = layout.values.MODEL_PROVIDER ?? "ollama";
  if (!catalogProvider(configured)) {
    const outcome: UpdateOutcome = {
      status: "failed",
      message: `Invalid MODEL_PROVIDER ${JSON.stringify(configured)}; expected one of: ${Object.keys(CATALOG).join(", ")} — run: iva config`,
    };
    const report = process.env.IVA_UPDATE_OUTCOME;
    if (report) writeFileSync(report, JSON.stringify(outcome));
    else console.log(JSON.stringify(outcome));
    return 1;
  }

  const lock = adoptUpdateLock(layout.data);
  const log: Say = (message) => console.log(`  ${message}`);
  const notify: Say = (message) => console.log(`! ${message}`);
  let optionalWriterState: OptionalWriterState[] | undefined;
  // The flip's reason for switching the userbot off; told once the version is served.
  let userbotOff: string | undefined;
  const migration = { started: false };
  let quarantinedState: UpdateQuarantine[] = [];
  let outcome: UpdateOutcome;
  try {
    outcome = await finishVersionUpdate({
      home,
      name,
      run: commandRunner(verbose),
      log,
      notify,
      requirePlugins,
      alertPlugins: (failures) =>
        alertOwnerAboutPlugins(layout, failures, notify),
      alertCustom: (text) => alertOwnerAboutCustom(layout, text, notify),
      quiesce: async () => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        // Before the first conversion there is no current symlink: the checkout
        // itself is the old writer root and must remain usable until activation.
        const writerRoot = existsSync(layout.current) ? layout.current : home;
        const runtime = createCliRuntime(writerRoot);
        optionalWriterState = captureOptionalWriterState(runtime);
        stopWriterUnits(runtime, optionalWriterState);
        quarantinedState = quarantineUpdateState(
          writerRoot,
          layout.data,
          notify,
        );
        rewriteRunStatusesForUpdate(layout.data);
        await Promise.resolve();
      },
      resumeOldWriters: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const runtime = createCliRuntime(root);
        let stateReady = true;
        try {
          if (quarantinedState.length > 0) {
            stopWriterUnits(runtime, optionalWriterState);
            try {
              restoreUpdateStateOrNotify(
                quarantinedState,
                notify,
                "recovery after rollback failed",
              );
              quarantinedState = [];
            } catch (error) {
              stateReady = false;
              throw error;
            }
          }
          // Recovery before activation must not rewrite or retire old unit files.
          runtime.systemd.restart(runtime.SERVICES);
        } finally {
          if (stateReady && optionalWriterState)
            restoreWriterOwnership(runtime, optionalWriterState, {
              unitMigrationStarted: migration.started,
              legacyMemoryOwnerProven: false,
              userbotReady: true,
            });
        }
        await Promise.resolve();
      },
      startCandidate: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        const { reinstallUserbot } = await import("./cli/userbot.ts");
        // Units name `current`: they survive every later flip unrewritten.
        const runtime = createCliRuntime(root);
        await startCandidateServices(runtime, createCliSystemd(runtime), {
          states: optionalWriterState,
          dataDir: layout.data,
          log,
          notify,
          migration,
          reinstall: reinstallUserbot,
          alertUserbot: (reason) => {
            userbotOff = reason;
            return Promise.resolve();
          },
        });
      },
      retireCommittedWriters: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        const runtime = createCliRuntime(root);
        const services = createCliSystemd(runtime);
        services.retireLegacyMemoryUnits();
        await Promise.resolve();
      },
      adopt: () => {
        writeShim(home, log, notify);
        // Метка прерванного вывода - тот же повод дочистить, что и живого `.git`.
        if (
          !existsSync(join(home, ".git")) &&
          !existsSync(join(home, RETIRE_MARKER))
        )
          return;
        const back = tombstoned(home, layout.data);
        if (back.length > 0)
          notify(
            `a version cannot have a file of Iva's own deleted from it, so ${back.length} you had removed are back: ${back.join(", ")}`,
          );
        for (const removed of retireCheckout(home, notify))
          log(`retired ${removed}`);
      },
    });
  } catch (error) {
    // The caller is another process: a stack trace explains nothing there, and
    // the update stays where the next run can pick it up.
    outcome = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lock.release();
  }
  await alertOwnerWhenServed(
    outcome,
    userbotOff,
    (reason) => alertOwnerAboutUserbot(layout, reason, notify),
    notify,
  );
  const report = process.env.IVA_UPDATE_OUTCOME;
  if (report) writeFileSync(report, JSON.stringify(outcome));
  else console.log(JSON.stringify(outcome));
  return outcome.status === "updated" ? 0 : 1;
}

if (isEntrypoint(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
