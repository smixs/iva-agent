import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalProgress } from "../lib/progress.ts";
import {
  loadTelegramJob,
  removeTelegramJob,
  reporterFor,
} from "../lib/telegram-status.ts";
import {
  betaChannel,
  BranchUnavailableError,
  resolveReleaseTarget,
  syncUpdateBranch,
} from "../lib/update-channel.ts";
import {
  gitAt,
  installedVersion,
  packageVersion,
  requireGit,
  updaterTooOldMessage,
} from "../lib/update-check.ts";
import { CATALOG, catalogProvider } from "../lib/model-catalog.ts";
import { classifyRoot, isManagedInstall } from "../lib/version-layout.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  parseVersionName,
  writeJson,
} from "../lib/version-store.ts";
import { pluginsMissingArtifacts } from "../lib/plugin-build.ts";
import {
  commandRunner,
  runVersionUpdate,
  versionOverlay,
  type UpdateOutcome,
} from "../lib/version-update.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type UpdateCopy = Record<"fetch" | "build", readonly [string, string]> & {
  readonly current: string;
  readonly busy: string;
  readonly badProvider: string;
  readonly devCheckout: string;
  readonly failed: string;
  readonly stock: string;
};

/** What the terminal says; the chat has its own words in telegram-status.ts. */
const COPY: Record<"en" | "ru", UpdateCopy> = {
  ru: {
    fetch: ["Получаю обновление", "Обновление получено"],
    build: ["Собираю Iva", "Iva собрана"],
    current: "Iva уже обновлена",
    busy: "Обновление уже идёт",
    badProvider:
      "Сначала почини MODEL_PROVIDER в .env (iva config) — на этом значении Iva не стартует",
    devCheckout:
      "это чекаут разработчика (.iva-dev): обновляйся через git, собирай `npm run build`",
    failed: "Не удалось завершить обновление",
    stock: "ваша доработка в data/custom не входит в эту версию",
  },
  en: {
    fetch: ["Getting the update", "Update received"],
    build: ["Building Iva", "Iva built"],
    current: "Iva is already up to date",
    busy: "An update is already running",
    badProvider:
      "Fix MODEL_PROVIDER in .env first (iva config) — Iva won't start on this value",
    devCheckout:
      "this is a development checkout (.iva-dev): update it with git, build it with `npm run build`",
    failed: "Couldn't complete the update",
    stock: "your customization in data/custom is not in this version",
  },
};

/** Имена, которые примет рантайм, — для сообщения об отказе. */
const ACCEPTED_PROVIDERS = Object.keys(CATALOG).join(", ");

/**
 * Отказ апдейта на невалидном MODEL_PROVIDER. В терминал он идёт на языке CLI
 * (AGENT_LANGUAGE), в чат — из copy репортера (job.locale).
 */
function invalidProviderRefusal(text: UpdateCopy, value: string): string {
  return `${text.badProvider}: ${JSON.stringify(value)} (${ACCEPTED_PROVIDERS})`;
}

/**
 * What `iva plugin` learns from a build it asked for (ADR-0009). `skipped` is a
 * development checkout, which has no versions to build: the plugin is installed, its
 * code is not, and the owner is told which of the two happened.
 */
export type PluginVersionBuild =
  | { readonly status: "built"; readonly version: string }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** What the bridge says in the chat once this process is gone. */
type UpdateOutcomeRecord = {
  readonly schema: "iva-update-outcome/v1";
  readonly status: "updated";
  readonly before: string;
  readonly after: string;
  readonly custom: string;
  readonly finishedAt: string;
};

/**
 * Leave the final word in the job file. This process is the old version's: the
 * restart it just ordered kills it, and an edit it starts can still be in flight
 * when it goes - which is how a stale phase edit landed after the final one and
 * left "Building Iva" in the chat for good. The bridge that comes up after the
 * restart is the process that outlives the update, so the last screen is its to
 * say. False means the file is not there to hand over, and the caller reports
 * the result itself.
 *
 * Through the store's own writer: `writeJson` is the rename this side already
 * trusts with the markers an interrupted update is replayed from, and the CLI
 * carries no import into the authored tree.
 */
function handOutcome(
  job: { path: string } | null,
  outcome: UpdateOutcomeRecord,
): boolean {
  if (!job) return false;
  try {
    const stored: unknown = JSON.parse(readFileSync(job.path, "utf8"));
    if (typeof stored !== "object" || stored === null) return false;
    writeJson(job.path, { ...(stored as Record<string, unknown>), outcome });
    return true;
  } catch {
    return false; // No readable job file: nobody is waiting on one.
  }
}

/** A bare mirror of the checkout: nothing runs from it, so it is free to rewrite. */
export async function ensureMirror(home: string): Promise<string> {
  const repo = join(home, "repo");
  if (existsSync(repo)) return repo;
  const staging = `${repo}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  const git = (root: string, args: string[]): Promise<string> =>
    requireGit(gitAt, root, args);
  // What the installation follows, not the clone: its Update branch.
  const keys = ["iva.updateBranch"];
  try {
    await git(home, ["clone", "--mirror", join(home, ".git"), staging]);
    const origin = await git(home, ["remote", "get-url", "origin"]);
    await git(staging, ["remote", "set-url", "origin", origin]);
    for (const key of keys) {
      const value = (await gitAt(home, ["config", "--local", "--get", key]))
        .stdout;
      if (value) await git(staging, ["config", key, value]);
    }
    renameSync(staging, repo);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return repo;
}

/**
 * What the next version is built from: the newest release, or the tip with beta updates
 * on (ADR-0017, ADR-0018). Neither guesses: offline, with no beta branch or with no
 * release tag it refuses. `installed` is the commit that runs; no update goes below it.
 */
export async function resolveTarget(
  repo: string,
  installed?: string,
): Promise<ReleaseAim> {
  const git = (...args: string[]) => gitAt(repo, args);
  let target: Awaited<ReturnType<typeof resolveReleaseTarget>>;
  try {
    target = await resolveReleaseTarget({ git, installed });
  } catch (error) {
    // Бета без ветки (нет сети или ветки): HEAD зеркала — это main, то есть откат.
    if (!(error instanceof BranchUnavailableError)) throw error;
    if (!(await betaChannel(git))) throw error;
    throw new Error(
      "the beta branch is unavailable (no network or no such branch); nothing was installed",
      { cause: error },
    );
  }
  const [sha, beta] = [target.targetHead, target.beta];
  const [release, newer] =
    "tag" in target ? [target.tag, target.newer] : [undefined, false];
  const version = packageVersion(
    await requireGit(gitAt, repo, ["show", `${sha}:package.json`]),
  );
  if (!version) throw new Error(`no package version at ${sha}`);
  return { sha, version, beta, release, newer };
}

/** Цель `iva update`: `release` — новейший выпуск, `newer` — установка новее него. */
type ReleaseAim = {
  sha: string;
  version: string;
  beta: boolean;
  release?: string;
  newer?: boolean;
};

/** Строка под «уже обновлена» без бета-обновлений: стоит выпуск или сборка новее него. */
export function releaseNote(aim: ReleaseAim, locale: string): string | null {
  if (aim.beta) return null;
  const ru = locale === "ru";
  if (!aim.newer)
    return ru
      ? "Это последняя стабильная версия."
      : "That is the latest stable release.";
  return ru
    ? `Стоит сборка новее последнего выпуска (${aim.release}). Следующий выпуск поставлю, когда выйдет.`
    : `This build is newer than the latest release (${aim.release}). I'll install the next release when it's out.`;
}

/** The commit that runs: the active version's, else the checkout's own HEAD. */
async function installedCommit(home: string): Promise<string | undefined> {
  const active = createVersionStore(home).currentName();
  const at = active ? parseVersionName(active)?.sha : undefined;
  return at ?? ((await gitAt(home, ["rev-parse", "HEAD"])).stdout || undefined);
}

/**
 * `iva update` by release: the target is resolved from the commit that runs, and one
 * already on its newest release says so under the "up to date" line.
 */
function releaseUpdate(home: string) {
  let aim: ReleaseAim | undefined;
  return {
    target: async (repo: string) => {
      // Зеркало - кэш записи владельца: расхождение, оставленное оборванной записью
      // `iva beta`/`iva stable`, чинится до чтения ветки (specs/UpdateBranch.tla).
      await syncUpdateBranch(
        (...args: string[]) => gitAt(repo, args),
        (...args: string[]) => gitAt(home, args),
      );
      aim = await resolveTarget(repo, await installedCommit(home));
      return aim;
    },
    said: (outcome: UpdateOutcome | null, env: Record<string, string>) => {
      const language = env.AGENT_LANGUAGE || process.env.AGENT_LANGUAGE;
      const note = aim && releaseNote(aim, language === "ru" ? "ru" : "en");
      if (outcome?.status === "current" && note) console.log(`   ${note}`);
    },
  };
}

/** The job file of a `/update --force` from the chat carries the flag. */
function jobAsksForce(job: unknown): boolean {
  return (
    typeof job === "object" &&
    job !== null &&
    (job as { force?: unknown }).force === true
  );
}

/**
 * `iva update` on the immutable layout. This half only fetches and unpacks the new
 * version; it continues inside that version's own `scripts/update-finish.ts`, so
 * an updater fix arrives with the release carrying it and not the one after.
 */
export function createVersionUpdateCommand(
  runtime: CliRuntime,
  systemdLifecycle: { restartServices: () => void },
) {
  const install = classifyRoot(runtime.ROOT);

  /**
   * One `iva update`, from the fetch to the report. The target is a parameter because
   * a plugin is installed on exactly these rails: same lock, same probe, same flip,
   * same restart - only the commit it aims at is the one already running (ADR-0009).
   */
  async function pipeline(
    args: readonly string[],
    target: (repo: string) => Promise<{ sha: string; version: string }>,
    { requirePlugins = false }: { readonly requirePlugins?: boolean } = {},
  ): Promise<UpdateOutcome | null> {
    const verbose = args.includes("--verbose");
    const jobAt = args.indexOf("--telegram-job");
    const env = runtime.readEnv();
    const language = env.AGENT_LANGUAGE || process.env.AGENT_LANGUAGE;
    const text = COPY[language === "ru" ? "ru" : "en"];
    const terminal = createTerminalProgress({ verbose });
    const job = await loadTelegramJob(
      runtime.dataDirAbs(env),
      jobAt >= 0 ? (args[jobAt + 1] ?? "") : "",
    );
    // Decided here and never travelling: a build of this release already on disk
    // may not be reused. `/update --force` from the chat writes the flag into its
    // job, so the retry of an interrupted run rebuilds too.
    const force = args.includes("--force") || jobAsksForce(job?.job);
    const reporter = job
      ? reporterFor(job.job, env.TELEGRAM_BOT_TOKEN, env)
      : null;
    /**
     * Отказ до зеркала, до лока и до первой записи: установка остаётся нетронутой
     * (ADR-0003). Причина уходит и в терминал, и в чат, а job закрывается: /update
     * из Telegram отказывал только в терминал systemd-run, которого никто не видит,
     * и мост, не найдя ни лока, ни outcome, оставлял «Запускаю обновление»
     * висеть в чате до шестичасового TTL.
     */
    const refuse = async (
      line: string,
      chat?: Promise<void>,
    ): Promise<null> => {
      terminal.fail(line);
      await chat;
      terminal.dispose();
      reporter?.dispose();
      await removeTelegramJob(job?.path);
      process.exitCode = 1;
      return null;
    };

    // Обновляется всё, кроме дерева, которое владелец сам помеченным `.iva-dev`
    // объявил своим рабочим: его оставляют как есть.
    if (!isManagedInstall(install))
      return refuse(text.devCheckout, reporter?.devCheckout());

    // Без этого префлайта опечатка в MODEL_PROVIDER прогоняла fetch → build → restart →
    // health-fail и возвращала «Couldn't build Iva … Retry: /update» по кругу, ни разу
    // не назвав причину.
    const configuredProvider = env.MODEL_PROVIDER ?? "ollama";
    if (!catalogProvider(configuredProvider))
      return refuse(
        invalidProviderRefusal(text, configuredProvider),
        reporter?.badProvider(configuredProvider, ACCEPTED_PROVIDERS),
      );

    const store = createVersionStore(install.home);
    // The last version the installation actually settled on: after an interrupted
    // update `current` already names the new one, which would report as "X → X".
    // On the first conversion there is no version yet, and the checkout being
    // retired knows its own release - the user is told a number, not a pronoun.
    const before =
      store.settled() ??
      store.currentName() ??
      installedVersion(install.root) ??
      "the previous version";
    let handedToBridge = false;
    const reportDir = mkdtempSync(join(tmpdir(), "iva-update-"));
    const report = join(reportDir, "outcome.json");
    const finished = async (from: string, to: string): Promise<void> => {
      await reporter?.complete({ beforeVersion: from, afterVersion: to });
    };
    const failed = async (detail: string): Promise<void> => {
      terminal.fail(text.failed);
      terminal.info(detail);
      // Причина едет в чат вместе с отказом: без неё остаётся «Retry: /update» по кругу.
      await reporter?.fail("build", before, detail);
      process.exitCode = 1;
    };

    let result: UpdateOutcome | null;
    try {
      terminal.start(text.fetch[0]);
      await reporter?.start("fetch");
      const outcome = await runVersionUpdate({
        home: install.home,
        store,
        // Зеркало клонируется под локом, а не до него: пока лок чужой, клон истории -
        // работа впустую и второй rename рядом с чужим обновлением.
        resolveTarget: async () => target(await ensureMirror(install.home)),
        run: commandRunner(verbose),
        force,
        requirePlugins,
        log: (message) => terminal.info(message),
        handoff: async (name) => {
          terminal.done(text.fetch[1]);
          await reporter?.done("fetch");
          terminal.start(text.build[0]);
          // Awaited, not fired off: the build below blocks this event loop for
          // minutes, and an edit still in flight when it does lands whenever the
          // loop comes back - after the final screen, overwriting it.
          await reporter?.start("build");
          // The spinner and the new version's own output must not share a line.
          terminal.dispose();
          return handoff(name, report, { verbose, requirePlugins });
        },
      });
      result = outcome;

      if (outcome.status === "busy") {
        terminal.fail(text.busy);
        // Or the Telegram message stays on the phase it never got past.
        await reporter?.busy();
        process.exitCode = 1;
      } else if (outcome.status === "too-old") {
        // Не отказ сборки, а отказ ставить: повторять /update бессмысленно, и сообщение
        // говорит ровно то, чем эту установку чинят.
        terminal.fail(
          updaterTooOldMessage(outcome.own, language === "ru" ? "ru" : "en"),
        );
        await reporter?.updaterTooOld(outcome.own);
        process.exitCode = 1;
      } else if (outcome.status === "unhealthy") await failed(outcome.log);
      else if (outcome.status === "failed") await failed(outcome.message);
      else if (outcome.status === "current") {
        terminal.done(text.fetch[1]);
        terminal.info(`✅ ${text.current} (${outcome.version})`);
        await finished(outcome.version, outcome.version);
      } else {
        terminal.done(text.build[1]);
        terminal.info(`✅ ${outcome.previous ?? before} → ${outcome.version}`);
        // Or the user goes on believing a skill of theirs is live.
        if (outcome.custom === "stock") terminal.info(`⚠️ ${text.stock}`);
        handedToBridge = handOutcome(job, {
          schema: "iva-update-outcome/v1",
          status: "updated",
          before: outcome.previous ?? before,
          after: outcome.version,
          custom: outcome.custom,
          finishedAt: new Date().toISOString(),
        });
        if (!handedToBridge)
          await finished(outcome.previous ?? before, outcome.version);
      }
    } catch (error) {
      const message = (error as { message?: string }).message ?? String(error);
      await failed(message);
      result = { status: "failed", message };
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
      terminal.dispose();
      reporter?.dispose();
      // A handed-over job belongs to the bridge now; deleting it here would take
      // the only record of what to say with it.
      if (!handedToBridge) await removeTelegramJob(job?.path);
    }
    return result;
  }

  async function run(args: readonly string[]): Promise<void> {
    const update = releaseUpdate(install.home);
    update.said(await pipeline(args, update.target), runtime.readEnv());
  }

  /**
   * What a version of THIS release is built from: its own commit. `iva plugin` builds
   * with the plugins the store holds now, and nothing else is allowed to change - an
   * install of a plugin that also dragged in a new release would be two updates in one,
   * and only one of them was asked for.
   */
  async function currentTarget(
    repo: string,
  ): Promise<{ sha: string; version: string }> {
    const active = createVersionStore(install.home).currentName();
    const at = active ? parseVersionName(active) : null;
    if (!at) throw new Error("no version is installed yet - run: iva update");
    // The directory name carries the short sha; the mirror turns it back into the
    // commit the archive is unpacked from, without touching the network.
    return {
      sha: await requireGit(gitAt, repo, ["rev-parse", at.sha]),
      version: at.version,
    };
  }

  /**
   * Which enabled plugins have no artifacts in the version that is active now. The
   * end state is the only honest answer to "is the plugin installed": every earlier
   * step reports on a tree that a later one may have rebuilt without it.
   */
  async function missingPluginArtifacts(): Promise<string[]> {
    const store = createVersionStore(install.home);
    const active = store.currentName();
    const { plugins } = await versionOverlay(store.layout.data);
    if (!active || plugins.length === 0) return [];
    const dir = join(store.layout.versions, active);
    return pluginsMissingArtifacts(dir, plugins);
  }

  /**
   * Build and install a version of the running release again, so that the plugins in
   * `data/custom/plugins/` are in it. Same rails as `iva update` (ADR-0009): a failed
   * build leaves the running version alone, and the caller undoes what it did to the
   * store.
   */
  async function rebuild({
    requirePlugins,
  }: {
    /** Whether a plugin that will not build fails the build or is switched off. */
    readonly requirePlugins: boolean;
  }): Promise<PluginVersionBuild> {
    if (!isManagedInstall(install))
      return {
        status: "skipped",
        reason:
          "plugin code is built into a version, and this tree is a development checkout (.iva-dev) - build it yourself: npm run build",
      };
    const outcome = await pipeline([], currentTarget, { requirePlugins });
    if (!outcome)
      return {
        status: "failed",
        reason: "fix MODEL_PROVIDER first: iva config",
      };
    if (outcome.status === "updated" || outcome.status === "current") {
      // What the installation ended up with, not what the build reported about
      // itself: a version whose name carries a plugin may still have been built
      // without it, and "installed" is a promise about the artifacts that are there.
      const missing = await missingPluginArtifacts();
      if (missing.length > 0)
        return {
          status: "failed",
          reason: `${outcome.version} is missing artifacts of ${missing.join(", ")}`,
        };
      return { status: "built", version: outcome.version };
    }
    if (outcome.status === "busy")
      return {
        status: "failed",
        reason:
          "an update is running - try again when it finishes (iva status)",
      };
    if (outcome.status === "too-old")
      return {
        status: "failed",
        reason: updaterTooOldMessage(outcome.own),
      };
    return {
      status: "failed",
      reason:
        outcome.status === "unhealthy"
          ? `${outcome.version} did not start: ${outcome.log}`
          : outcome.message,
    };
  }

  /** Run the new version's updater, in its own process, from its own directory. */
  function handoff(
    name: string,
    report: string,
    {
      verbose,
      requirePlugins,
    }: { readonly verbose: boolean; readonly requirePlugins: boolean },
  ): UpdateOutcome {
    const dir = join(install.home, "versions", name);
    const args = [
      join(dir, "scripts/update-finish.ts"),
      install.home,
      name,
      ...(verbose ? ["--verbose"] : []),
      ...(requirePlugins ? ["--require-plugins"] : []),
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: dir,
      stdio: "inherit",
      env: { ...runtime.childEnv, IVA_UPDATE_OUTCOME: report },
    });
    if (result.error) throw result.error;
    try {
      return JSON.parse(readFileSync(report, "utf8")) as UpdateOutcome;
    } catch {
      const code = result.status ?? "unknown";
      throw new Error(`the new version's updater exited with code ${code}`);
    }
  }

  /** Back to the version that ran before: no git, no build, no network. */
  function rollback(): void {
    const store = createVersionStore(install.home);
    const previous = store.previousName();
    const lock = previous ? acquireUpdateLock(store.layout.data) : null;
    if (!previous || !lock) {
      runtime.bad(
        previous
          ? "an update is already running"
          : "no previous version to go back to",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const from = store.currentName();
      // Activation aims this version's state back at the installation: a way back
      // that comes up on a deleted scratch directory is not a way back.
      store.activate(previous);
      systemdLifecycle.restartServices();
      // Or the next update believes it still owes the move this just undid.
      store.settle(previous);
      runtime.ok(`${from ?? "the broken version"} → ${previous}`);
      // Nothing pins a version: upstream still resolves to the one left behind,
      // and with two builds on disk another rollback is a way back onto it too.
      runtime.warn(
        "another `iva rollback`, like the next `iva update`, can bring that version back",
      );
    } finally {
      lock.release();
    }
  }

  return {
    run,
    rebuild,
    rollback,
  };
}
