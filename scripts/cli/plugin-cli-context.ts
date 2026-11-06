// The shared middle of `iva plugin`: the update lock, the sweep of an interrupted install,
// the version build, and the few answers every command group needs. No command lives here -
// only what they do the same way, so that `add` and `sync` describe a plugin in one voice
// and `trust` and `remove` reach the updater through one door.
//
// The context is built for one invocation: it carries the parsed arguments and the already
// loaded core (`loadPluginCore()`), so a command group takes one parameter and nothing else.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginReport } from "#lib/plugin-reader.ts";
import type { PluginEntry, PluginsState } from "#lib/plugin-store.ts";
import type { Translate } from "../lib/cli-translate.ts";
import type { PluginCore } from "../lib/plugin-core.ts";
import type { GitRunner } from "../lib/plugin-install.ts";
import type { PluginSource } from "../lib/plugin-source.ts";
import { acquireUpdateLock } from "../lib/version-store.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { PluginVersionBuild } from "./version-update-command.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

// Префиксы наших временных папок. Обе начинаются с точки, а имя плагина по спеке
// начинается с буквы или цифры (§5.5) — значит уборка не может задеть плагин.
export const STAGING_PREFIX = ".staging-";
const REPLACED_PREFIX = ".replaced-";
/**
 * Сколько недоделка считается живой. Столько времени идёт сборка версии, ради которой
 * смещённая копия и держится: лок на это время у апдейтера, и уборка чужой команды —
 * единственный, кто может её унести.
 */
const LEFTOVER_GRACE_MS = 60 * 60 * 1000;

/** Чем кончилась сборка версии, ради которой команду и позвали. */
type CodeBuild = {
  /** Причина отказа, из-за которой команда обязана отменить сделанное; иначе null. */
  readonly failure: string | null;
  /**
   * Собралась ли версия на самом деле. На development checkout собирать нечем, и тогда
   * это `false` при пустом `failure`: плагин поставлен, а его кода в работающей версии
   * нет — говорить про «код собран» там было бы неправдой.
   */
  readonly built: boolean;
};

/** Наши недоделанные папки: их оставляет только прерванная установка. */
export function leftoverPluginDirs(pluginsDirectory: string): string[] {
  if (!existsSync(pluginsDirectory)) return [];
  return readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith(STAGING_PREFIX) ||
          entry.name.startsWith(REPLACED_PREFIX)),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Почему плагин не годится — последней строкой диагностики: её и пишет читатель манифеста
 * (agent/lib/plugin-reader.ts), когда отказывается собрать отчёт. Одна фраза на все три
 * места, где это спрашивают: `trust`, `sync` и `iva doctor`.
 */
export function pluginReadProblem(report: PluginReport): string {
  return report.diagnostics.at(-1) ?? "not a usable plugin folder";
}

type PluginCliOptions = {
  readonly runtime: CliRuntime;
  /** Всё из authored tree приходит уже загруженным: команда стартует и без него. */
  readonly core: PluginCore;
  /** Аргументы подкоманды, как их набрал владелец. */
  readonly argv: readonly string[];
  readonly git: GitRunner;
  readonly translate: Translate;
  readonly now: () => Date;
  /** Откуда разрешается относительный локальный источник: shell владельца, не ROOT. */
  readonly cwd: () => string;
  readonly log: (...args: unknown[]) => void;
  /** Человек ли у терминала: без него `add` не ставит плагин с кодом или MCP. */
  readonly interactive: () => boolean;
  readonly buildVersion?: (options: {
    readonly requirePlugins: boolean;
  }) => Promise<PluginVersionBuild>;
};

export function createPluginCliContext(options: PluginCliOptions) {
  const {
    runtime,
    core,
    argv,
    git,
    translate,
    now,
    cwd,
    log,
    interactive,
    buildVersion,
  } = options;
  const { warn, step } = runtime;
  const { findPlugin, pluginsDir } = core.store;

  const force = argv.includes("--force");
  const trustAsked = argv.includes("--trust");
  const args = argv.filter((value) => !value.startsWith("--"));

  /** Что плагин несёт — одной строкой, до установки и в `list`. */
  function components(report: PluginReport): string {
    const parts: string[] = [];
    if (report.skills.length)
      parts.push(
        `skills: ${report.skills.map((skill) => skill.name).join(", ")}`,
      );
    if (report.code) parts.push("code: sh.iva");
    const servers = Object.keys(report.mcp);
    if (servers.length) parts.push(`mcp: ${servers.join(", ")}`);
    const services = Object.keys(report.services);
    if (services.length) parts.push(`services: ${services.join(", ")}`);
    return parts.length
      ? parts.join("; ")
      : translate("no components", "компонент нет");
  }

  function expandHome(path: string): string {
    if (path === "~") return homedir();
    return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  }

  /**
   * Локальный источник записывается абсолютным путём: `plugins.json` читает потом
   * `iva plugin sync`, а он запускается из другого каталога, и `./my-plugin` там
   * означал бы совсем другую папку.
   */
  function absolute(source: PluginSource): PluginSource {
    return source.kind === "local"
      ? { kind: "local", path: resolve(cwd(), expandHome(source.path)) }
      : source;
  }

  /**
   * Недоделки прерванной установки; чистятся под локом, до работы.
   *
   * Со смещённой копией (`.replaced-`) есть оговорка: она живёт, пока идёт сборка
   * версии, а сборка идёт БЕЗ нашего лока — лок на это время у апдейтера. Свежую
   * такую копию не трогаем: снести её значит отобрать у команды единственный способ
   * вернуть плагин на место, если версия с ним не соберётся. Staging (`.staging-`)
   * оговорки не требует: его создают и убирают под тем же локом, что держим мы,
   * поэтому чужой staging здесь — всегда след прерванного процесса.
   */
  function sweepLeftovers(data: string): number {
    const directory = pluginsDir(data);
    const swept = leftoverPluginDirs(directory).filter((name) => {
      const path = join(directory, name);
      if (name.startsWith(REPLACED_PREFIX) && inUse(path)) return false;
      rmSync(path, { recursive: true, force: true });
      return true;
    });
    return swept.length;
  }

  /** Достаточно свежая, чтобы принадлежать идущей прямо сейчас установке. */
  function inUse(path: string): boolean {
    try {
      return now().getTime() - statSync(path).mtimeMs < LEFTOVER_GRACE_MS;
    } catch {
      return false; // Папки уже нет — держать нечего.
    }
  }

  /**
   * Меняющие команды идут через тот же лок, что `iva update`: установка плагина
   * трогает те же каталоги, и вторая копия команды посреди первой оставила бы
   * ровно те недоделки, которые здесь же и подметаются.
   */
  async function locked<T>(data: string, body: () => Promise<T>): Promise<T> {
    const lock = acquireUpdateLock(data);
    if (!lock)
      throw new Error(
        "an update is running — try again when it finishes (iva status)",
      );
    try {
      const swept = sweepLeftovers(data);
      if (swept)
        warn(`cleaned ${swept} leftover folder(s) from an interrupted install`);
      return await body();
    } finally {
      lock.release();
    }
  }

  /**
   * Собрать версию с кодом плагинов, как это делает `iva update`: тот же лок, тот же
   * probe, тот же flip и рестарт (ADR-0009).
   *
   * `keeps` — остаётся ли плагин в составе версии. Он же `requirePlugins` апдейтера: у
   * команд, ради которых сборка и затевается (`add`, `update`, `enable`, `trust`),
   * плагин, который не собрался, валит сборку, а не выключается молча. `disable`,
   * `untrust` и `remove` идут без него — их дело сделано записью в plugins.json, — и
   * шаг там говорит, что версия пересобирается БЕЗ этого плагина.
   *
   * Печатать прогресс не нужно: его печатает сам апдейтер, теми же строками.
   */
  async function buildCode(what: string, keeps: boolean): Promise<CodeBuild> {
    if (!buildVersion) {
      warn(
        translate(
          `the code of ${what} is not built here: this Iva has no versions to build`,
          `код ${what} здесь не собирается: у этой Ивы нет версий для сборки`,
        ),
      );
      return { failure: null, built: false };
    }
    step(
      keeps
        ? translate(
            `Building Iva with ${what}`,
            `Собираю Иву с плагином: ${what}`,
          )
        : translate(
            `Rebuilding Iva without ${what}`,
            `Пересобираю Иву без плагина: ${what}`,
          ),
    );
    const built = await buildVersion({ requirePlugins: keeps });
    if (built.status === "failed")
      return { failure: built.reason, built: false };
    if (built.status === "skipped") {
      warn(built.reason);
      return { failure: null, built: false };
    }
    return { failure: null, built: true };
  }

  function mustFind(
    state: PluginsState,
    name: string | undefined,
  ): PluginEntry {
    if (!name) throw new Error("which plugin? — iva plugin list");
    const entry = findPlugin(state, name);
    if (!entry) throw new Error(`${name} is not installed — iva plugin list`);
    return entry;
  }

  async function checkDescriptions(report: PluginReport) {
    for (const { name, dir } of report.skills) {
      const { truncatedFrom } = core.skills.describeSkill(
        name,
        await readFile(join(dir, "SKILL.md"), "utf8"),
      );
      if (truncatedFrom === null) continue;
      const problem = `описание скилла ${name} — ${truncatedFrom} знаков, предел ${core.skills.DESCRIPTION_CAP}; сократи до триггера "Use when…"`;
      warn(problem);
    }
  }

  return {
    checkDescriptions,
    runtime,
    core,
    argv,
    args,
    force,
    trustAsked,
    git,
    translate,
    now,
    cwd,
    log,
    interactive,
    components,
    absolute,
    locked,
    buildCode,
    mustFind,
  };
}

export type PluginCliContext = ReturnType<typeof createPluginCliContext>;
