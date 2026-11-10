import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  instructionSlotCollision,
  isAuthoredPath,
  isInstructionSlotPath,
  isLivePath,
} from "./authored-paths.ts";
import { resolveDataDir } from "./data-dir.ts";
import { gitAt, updaterCompat } from "./update-check.ts";
import { loadVaultPair } from "./vault-pair.ts";
import {
  alertResolved,
  CUSTOM_ALERT_KEY,
  PLUGIN_ALERT_KEY,
  pluginsSwitchedOffAlert,
} from "./notice-policy.ts";
import {
  buildPluginExtension,
  codePlugins,
  pluginArtifactsPresent,
  disableCodePlugin,
  removePluginFromVersion,
  type CodePlugin,
  type PluginFailure,
} from "./plugin-build.ts";
import {
  awaitServing,
  probeEnvironment,
  probeVersion,
  servicePort,
} from "./health-probe.ts";
import {
  bindProbe,
  DEFAULT_PORT,
  PortChecker,
  PortSelector,
  procProbe,
  lsofProbe,
} from "./ports.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  KEEP,
  parseVersionName,
  releaseOf,
  versionName,
  writeJson,
} from "./version-store.ts";

export type CommandResult = { readonly code: number; readonly output: string };
export type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

type Say = (message: string) => void;
/** `busy`: the port went, not the version - the same tree on another port may pass. */
type Health = { ok: boolean; log: string; busy?: boolean };
type Probe = (dir: string, port: number) => Promise<Health>;
/** Whether the user's own files are in the version that runs. */
type Custom = "none" | "applied" | "stock";
type Store = ReturnType<typeof createVersionStore>;

export type UpdateOutcome =
  | { status: "busy" }
  | { status: "current"; version: string }
  /** The fetched release names an updater newer than this one; nothing was touched. */
  | { status: "too-old"; own: string; minUpdater: string }
  | { status: "unhealthy"; version: string; log: string }
  | { status: "failed"; message: string }
  | {
      status: "updated";
      version: string;
      previous: string | null;
      custom: Custom;
      migrations: string[];
      removed: string[];
    };

const INSTALL = ["ci", "--no-audit", "--no-fund"];
const BUILD = ["run", "build"];
/** Candidate ports one probe may lose to a neighbour before it gives up. */
const PROBE_PORTS = 4;
const MIGRATION_FILE = /^\d{3}-[a-z0-9-]+\.ts$/;
const MIGRATION_MARKER = "migrations.json";
const OUTPUT_TAIL = 20_000;

export type MigrationContext = Record<string, unknown>;
export type Migration = (context: MigrationContext) => void | Promise<void>;

type FinishOptions = {
  readonly home: string;
  /** The staged version to build, prove and activate. */
  readonly name: string;
  readonly run: Runner;
  readonly probe?: Probe;
  /** Stop every service that can write shared state before migrations start. */
  readonly quiesce?: () => Promise<void>;
  /** Resume the old writers after a pre-activation fault, without changing units. */
  readonly resumeOldWriters?: (root: string) => Promise<void>;
  /** Refresh units and start the candidate only after activation. */
  readonly startCandidate?: (root: string) => Promise<void>;
  /** Whether the restarted service answers on the port the installation runs on. */
  readonly serving?: (port: number) => Promise<Health>;
  /** Layout changes the installation itself needs: the shim, the old checkout. */
  readonly adopt?: () => void;
  readonly notify?: Say;
  readonly log?: Say;
  readonly store?: Store;
  /**
   * `iva plugin add|update|enable`: the plugin is the point of the build, so a plugin
   * that will not build fails it and leaves the running version alone. An `iva update`
   * leaves this off - there a plugin broken by a new eve is switched off instead, and
   * the release still installs (ADR-0003).
   */
  readonly requirePlugins?: boolean;
  /** Tell the owner which plugins are off, at most once a week per set (ADR-0007). */
  readonly alertPlugins?: (failures: readonly PluginFailure[]) => Promise<void>;
  /** The version runs the stock build; the text is the update output's line (ADR-0007). */
  readonly alertCustom?: (text: string) => Promise<void>;
};

type UpdateOptions = Omit<FinishOptions, "name"> & {
  /** Fetches into the mirror and reports what should run next. */
  readonly resolveTarget: () => Promise<{ sha: string; version: string }>;
  /** `--force`: build this release again, even where a build of it already runs. */
  readonly force?: boolean;
  /** Hands the staged version to the updater that version ships. */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
};

/** The files the user authored; the rest of `data/custom` is the layer's bookkeeping. */
function authored(customDir: string): string[] {
  try {
    return (
      readdirSync(customDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(relative(customDir, entry.parentPath), entry.name)
            .split(sep)
            .join("/"),
        )
        .filter(isAuthoredPath)
        // Markdown-правила и скиллы владельца Ива читает с диска на ходу: они не вход
        // сборки и не часть отпечатка версии. Иначе каждое «запиши правило» звало бы
        // `iva update` без нужды, а одна кривая шапка скилла уводила бы версию на
        // заводскую сборку.
        .filter((path) => !isLivePath(path))
        .sort()
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `cannot read Custom layer ${customDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The authored files and a digest of them: an edit to `data/custom` is a version. */
export function customOverlay(customDir: string): {
  files: string[];
  digest: string | null;
} {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const path of authored(customDir)) {
    const file = join(customDir, path);
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Deleted between the listing and the read.
      throw new Error(
        `cannot read Custom layer file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    files.push(path);
    hash.update(`${path}\0${body.length}\0`);
    hash.update(body);
  }
  return {
    files,
    digest: files.length > 0 ? hash.digest("hex").slice(0, 8) : null,
  };
}

/**
 * What a version is built out of, beyond its commit: the files the user authored and
 * the plugins that carry code (ADR-0009). Both go into the digest that names it, so
 * adding, updating, enabling or disabling a code plugin is a new release and a build -
 * and a plugin with only skills changes nothing, because its skills are live.
 */
export async function versionOverlay(
  dataDir: string,
  log: Say = () => {},
): Promise<{
  files: string[];
  digest: string | null;
  plugins: readonly CodePlugin[];
}> {
  const { files, digest } = customOverlay(join(dataDir, "custom"));
  const { plugins, diagnostics } = await codePlugins(dataDir);
  for (const line of diagnostics) log(line);
  if (plugins.length === 0) return { files, digest, plugins };
  // The plugin's content, not the digest recorded for it: a folder edited in place is
  // a different version, and the config beside it is the owner's to change too.
  const hash = createHash("sha256");
  hash.update(`${digest ?? ""}\0`);
  for (const plugin of plugins) {
    hash.update(
      `${plugin.name}\0${plugin.digest}\0${plugin.config.length}\0${plugin.config}\n`,
    );
    // The generated connections too, because they are neither the folder nor the
    // config: trusting a plugin, or a port handed to one, changes what a version
    // contains, and a version that contains something else is a different version.
    for (const connection of plugin.connections)
      hash.update(
        `${connection.file}\0${connection.source.length}\0${connection.source}\n`,
      );
  }
  return { files, digest: hash.digest("hex").slice(0, 8), plugins };
}

function sameFile(one: string, other: string): boolean {
  try {
    return readFileSync(one).equals(readFileSync(other));
  } catch {
    return false;
  }
}

/**
 * What a version was built with, by contents: a stock tree has authored paths too.
 * A plugin counts by the files it generated - the mount, without which eve does not
 * load its code, and its connections, without which eve does not reach its MCP
 * servers - whatever the version is named after.
 */
export function builtWith(
  dir: string,
  name: string,
  customDir: string,
  plugins: readonly CodePlugin[] = [],
): Custom {
  if (!parseVersionName(name)?.overlay) return "none";
  const { files } = customOverlay(customDir);
  const carried = files.length > 0 || plugins.length > 0;
  return carried &&
    files.every((path) => sameFile(join(dir, path), join(customDir, path))) &&
    plugins.every((plugin) => pluginArtifactsPresent(dir, plugin))
    ? "applied"
    : "stock";
}

/**
 * Build a version, prove it starts, flip a symlink, move the installation onto it.
 * Nothing before the flip touches what runs; nothing after it is a one-shot.
 */
export async function runVersionUpdate(
  options: UpdateOptions,
): Promise<UpdateOutcome> {
  const {
    home,
    resolveTarget,
    handoff,
    force = false,
    log = () => {},
    store = createVersionStore(home),
  } = options;
  const lock = acquireUpdateLock(store.layout.data);
  if (!lock) return { status: "busy" };
  try {
    // Safe only under the lock: leftovers are garbage because nobody owns them.
    for (const stale of store.sweep()) log(`removed leftover ${stale}`);
    store.heal();

    const target = await resolveTarget();
    // The tree names the oldest updater able to install it, and this is the last step
    // before the first write (`store.stage` below): an older CLI leaves here having
    // touched nothing (#191).
    const compat = await updaterCompat(
      (...args: string[]) => gitAt(store.layout.repo, args),
      target.sha,
    );
    if (compat.status === "too-old")
      return {
        status: "too-old",
        own: compat.own,
        minUpdater: compat.minUpdater,
      };
    // Half of what gets built, so half of what it is called.
    const { digest, plugins } = await versionOverlay(store.layout.data, log);
    const release = versionName(target.version, target.sha, digest);
    const active = store.currentName();
    /**
     * Is the code of every enabled plugin really in this build? A release name says
     * what a version was built FOR, not what came out of it: a build that refused a
     * plugin, or one made while the plugin was switched off, carries the same name.
     * Handing such a tree back would report a plugin as installed with no code in the
     * version and its skills live - half a plugin, which is worse than none. Same
     * shape as `store.liveFailed`: a build that is not good enough to reuse.
     */
    const carriesPlugins = (name: string): boolean =>
      plugins.length === 0 ||
      builtWith(
        join(store.layout.versions, name),
        name,
        join(store.layout.data, "custom"),
        plugins,
      ) === "applied";
    // Finished, not just flipped: unrun migrations are an update still owed.
    const settled =
      active &&
      releaseOf(active) === release &&
      store.settled() === active &&
      carriesPlugins(active);
    if (settled && !force) {
      if (store.cleanupPending(active))
        return handoff
          ? await handoff(active)
          : await finishVersionUpdate({ ...options, name: active, store });
      store.gc(KEEP);
      return { status: "current", version: active };
    }

    // Reusing a finished build makes dropping a customization a flip, not a build.
    // `--force` refuses it: the build already there is the broken one. So does a
    // release the service has already died on - handing that tree back is how one
    // bad start becomes an update that lays the installation down for good.
    const finished =
      force || store.liveFailed(release)
        ? undefined
        : store
            .list()
            .find(
              (name) => releaseOf(name) === release && carriesPlugins(name),
            );
    const name = finished ?? store.nextBuild(release);
    if (!finished) {
      for (const gone of store.gc(1, { references: "current" }))
        log(`removed ${gone} to make room for the build`);
      const dir = store.stage(name);
      try {
        await store.materialize({ sha: target.sha, dir });
        store.linkState(dir);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    return handoff
      ? await handoff(name)
      : await finishVersionUpdate({ ...options, name, store });
  } finally {
    // A handoff leaves the child owning this lock; release only drops one's own.
    lock.release();
  }
}

/**
 * The half of an update the new version runs about itself, so a fix to any of it
 * ships with the release carrying it. The flip decides what runs, the marker
 * whether the move is finished.
 *//**
 * Всё, что фазы обновления читают о ходе: разрешённые опции с дефолтами плюс пути,
 * пробник и плагины, посчитанные один раз. Одна точка правды: фазы не пересчитывают
 * ни дефолты, ни пути по-своему.
 */
interface UpdateRun {
  readonly active: string | null;
  readonly adopt: () => void;
  readonly alertPlugins?: (failures: readonly PluginFailure[]) => Promise<void>;
  readonly alertCustom: (text: string) => Promise<void>;
  readonly check: Probe;
  readonly customDir: string;
  readonly dir: string;
  readonly env: string;
  readonly home: string;
  readonly log: Say;
  readonly name: string;
  readonly notify: Say;
  readonly plugins: readonly CodePlugin[];
  readonly quiesce: () => Promise<void>;
  readonly requirePlugins: boolean;
  readonly resumeOldWriters: (root: string) => Promise<void>;
  readonly run: Runner;
  readonly serving: (port: number) => Promise<Health>;
  readonly settledBefore: string | null;
  readonly startCandidate: (dir: string) => Promise<void>;
  readonly store: Store;
}

/** Дерево версии, которое строят и оправдывают: с чем оно собрано, какие плагины в нём
 * оказались и почему остальные отпали. */
interface CandidateTree {
  custom: Custom;
  mounted: readonly CodePlugin[];
  readonly refusals: Map<string, string>;
  /** Why the tree went to the stock build; told once the tree is final (settleCustom). */
  stockNotice?: string;
}

/** Опции хода, которых вызывающий вправе не задавать, получают поведение по умолчанию:
 * `undefined` в объекте опций значил бы «замени дефолт на пустоту», поэтому у каждой опции
 * свой ответ, а не общий spread. Разложены по смыслу, чтобы каждая функция осталась
 * простой. */
function writerSteps(options: FinishOptions) {
  return {
    adopt: options.adopt ?? (() => {}),
    quiesce: options.quiesce ?? (async () => {}),
    resumeOldWriters: options.resumeOldWriters ?? (async () => {}),
  };
}

function flipSteps(options: FinishOptions) {
  return {
    serving: options.serving ?? ((port: number) => awaitServing({ port })),
    startCandidate: options.startCandidate ?? (async () => {}),
  };
}

function voiceSteps(options: FinishOptions) {
  const notify = options.notify ?? (() => {});
  return {
    alertCustom:
      options.alertCustom ?? ((text: string) => Promise.resolve(notify(text))),
    log: options.log ?? (() => {}),
    notify,
    requirePlugins: options.requirePlugins ?? false,
  };
}

/** Опции с дефолтами плюс пути, плагины и пробник, посчитанные один раз: одна точка правды
 * на весь ход. Состояние читается до `versionOverlay`: сначала проверка, потом правка. */
async function openUpdate(options: FinishOptions): Promise<UpdateRun> {
  const { home, name, run, probe, store = createVersionStore(home) } = options;
  const env = store.layout.env;
  const active = store.currentName();
  const settledBefore = store.settled();
  const { plugins } = await versionOverlay(
    store.layout.data,
    voiceSteps(options).log,
  );
  return {
    active,
    alertPlugins: options.alertPlugins,
    check:
      probe ??
      ((at, port) =>
        probeVersion({ dir: at, port, env: probeEnvironment(env, port, at) })),
    customDir: join(store.layout.data, "custom"),
    dir: join(store.layout.versions, name),
    env,
    home,
    name,
    plugins,
    run,
    settledBefore,
    store,
    ...writerSteps(options),
    ...flipSteps(options),
    ...voiceSteps(options),
  };
}

/** Дерево версии, которую вот-вот выбросят, - мусор, на который никто не указывает. */
function discardTree(dir: string, error: unknown): never {
  rmSync(dir, { recursive: true, force: true });
  throw error;
}

/**
 * Плагины, которые не доехали в дерево, называются один раз, когда дерево уже
 * окончательное: и свой билд, и билд агента, и старт, и пересборка без кастомизации могут
 * выкинуть плагин - и владельцу не нужна весть на каждую попытку. Выключение идёт до
 * сообщения: услышать, что плагин выключен, значит найти его выключенным.
 */
async function settlePlugins(
  run: UpdateRun,
  tree: CandidateTree,
): Promise<void> {
  const { store, plugins, name, log, notify, alertPlugins } = run;
  const dropped = plugins.filter(
    (plugin) => !tree.mounted.some((one) => one.name === plugin.name),
  );
  if (dropped.length === 0) {
    // Every enabled plugin is in: whatever was refused before is over, and a
    // relapse next week speaks at once instead of waiting out the throttle.
    if (plugins.length > 0) alertResolved(store.layout.data, PLUGIN_ALERT_KEY);
    return;
  }
  const failures = dropped.map((plugin) => ({
    name: plugin.name,
    digest: plugin.digest,
    reason:
      tree.refusals.get(plugin.name) ??
      `${name} was installed without the code of ${plugin.name}`,
  }));
  for (const failure of failures) {
    if (await disableCodePlugin(store.layout.data, failure.name))
      log(`switched the plugin ${failure.name} off`);
  }
  await (
    alertPlugins ?? ((list) => Promise.resolve(notify(pluginsOffNotice(list))))
  )(failures);
}

/**
 * Заводская сборка называется владельцу, когда дерево окончательное и поднялось: Alert о
 * версии, которая не стартовала и выброшена, был бы ложным, и неделя дросселя заглушила бы
 * настоящий. Не поднялось — строка остаётся только в выводе обновления. Файлы владельца снова
 * в версии — прошлый Alert забыт, и рецидив заговорит сразу (ADR-0007).
 */
async function settleCustom(
  run: UpdateRun,
  tree: CandidateTree,
  started: boolean,
): Promise<void> {
  const notice = tree.custom === "stock" ? tree.stockNotice : undefined;
  if (!started) {
    if (notice !== undefined) run.notify(notice);
    return;
  }
  if (tree.custom === "applied")
    alertResolved(run.store.layout.data, CUSTOM_ALERT_KEY);
  if (notice !== undefined) await run.alertCustom(notice);
}

/** Живой старт на песочном состоянии: обновление, которое вот-вот выбросят, не должно
 * успеть тронуть установку. Порт разведён по pid, а между проверкой и стартом порт никто
 * не держит - сосед, занявший его в этом окне, возвращается как busy, и следующему
 * кандидату достаётся тот же шанс. */
async function probeCandidate(run: UpdateRun): Promise<Health> {
  const { store, name, check, dir, log } = run;
  const scratch = store.sandboxState(name);
  const selector = new PortSelector(
    new PortChecker([
      bindProbe,
      process.platform === "darwin" ? lsofProbe : procProbe,
    ]),
  );
  try {
    let from = DEFAULT_PORT + 100 + (process.pid % 100);
    for (let left = PROBE_PORTS; left > 0; left--) {
      const port = await selector.firstFree(from);
      if (port === null) return { ok: false, log: "no free port for a probe" };
      const health = await check(dir, port);
      if (!health.busy) return health;
      log(`the probe port ${port} was taken before the version could bind it`);
      from = port + 1;
    }
    return {
      ok: false,
      log: `no probe port stayed free for ${PROBE_PORTS} tries`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Чем дерево начинает: достроенная прошлым ходом версия, версия, на которой сервис уже
 * умирал, или обычная сборка. `prepared` - состояние ДО этой сборки: по нему ниже видно,
 * был ли путь назад у версии, которую вот-вот перестроят. */
async function buildTree(
  run: UpdateRun,
  tree: CandidateTree,
  prepared: boolean,
): Promise<void> {
  const { store, name, run: command, dir, customDir, plugins, log } = run;
  const refuse = (failures: readonly PluginFailure[]): void => {
    for (const failure of failures)
      tree.refusals.set(failure.name, failure.reason);
  };
  if (prepared) {
    log(`reusing prepared version ${name}`);
    return;
  }
  if (store.liveFailed(name)) {
    // This code has been live once and the service died on it. The overlay is
    // the only part of the tree that is not upstream's, so it is the part that
    // comes out; without one there is nothing to drop and this is a rebuild.
    log(
      "the service died on this version before; building it without data/custom",
    );
    await buildStock(store, name, command).catch((error: unknown) =>
      discardTree(dir, error),
    );
    tree.custom = builtWith(dir, name, customDir, plugins);
    tree.mounted = [];
    if (tree.custom === "stock") tree.stockNotice = deferredNotice();
    return;
  }
  const built = await buildVersion({
    store,
    name,
    run: command,
    log,
    plugins,
    requirePlugins: run.requirePlugins,
  }).catch((error: unknown) => discardTree(dir, error));
  tree.custom = built.custom;
  tree.stockNotice = built.stockNotice;
  // What the build refused is remembered, not announced yet: the start below can
  // still take another plugin out, and the owner gets one message about the tree
  // that ends up installed rather than one per attempt.
  refuse(built.failed);
  tree.mounted = built.mounted;
}

/** Плагины выпадают первыми: они та часть дерева, которую релиз не поставляет, и владелец
 * возвращает их по одному (ADR-0003: один плагин не имеет права держать машину лёгшей). Не
 * под `requirePlugins` - там плагин и есть смысл сборки, и версия, которая с ним не
 * стартует, это отказ. Возврат - здоровье дерева после пересборки. */
async function rebuildWithoutPlugins(
  run: UpdateRun,
  tree: CandidateTree,
  prepared: boolean,
  health: Health,
): Promise<Health> {
  const { name, run: command, dir, customDir, log } = run;
  if (health.ok || tree.mounted.length === 0 || prepared || run.requirePlugins)
    return health;
  log("the version does not start with its plugins; rebuilding without them");
  const broken = health.log;
  const refused = tree.mounted;
  for (const plugin of refused) removePluginFromVersion(dir, plugin);
  const again = await command("npm", BUILD, dir);
  if (again.code !== 0) return health;
  const probed = await probeCandidate(run);
  if (!probed.ok) return probed;
  for (const plugin of refused)
    tree.refusals.set(
      plugin.name,
      `this version does not start with the plugin ${plugin.name}:\n${broken.slice(-OUTPUT_TAIL)}`,
    );
  tree.custom = builtWith(dir, name, customDir, []);
  tree.mounted = [];
  return probed;
}

/** Зелёная сборка - не старт: сервис компилирует authored-часть сам, когда поднимается, и
 * релиз - не тот код, ради которого держат ход пользователя. */
async function rebuildWithoutCustomization(
  run: UpdateRun,
  tree: CandidateTree,
  prepared: boolean,
  health: Health,
): Promise<Health> {
  const { store, name, run: command, dir, log } = run;
  if (health.ok || tree.custom !== "applied" || prepared) return health;
  log("the customized version does not start; rebuilding without it");
  await buildStock(store, name, command).catch((error: unknown) =>
    discardTree(dir, error),
  );
  tree.custom = "stock";
  tree.mounted = [];
  tree.stockNotice = stockNotice("start against", health.log);
  return await probeCandidate(run);
}

/** Проба дерева и пересборки того, что не поднялось: плагины, потом кастомизация. */
async function repairTree(
  run: UpdateRun,
  tree: CandidateTree,
  prepared: boolean,
): Promise<Health> {
  const health = await probeCandidate(run);
  const withoutPlugins = await rebuildWithoutPlugins(
    run,
    tree,
    prepared,
    health,
  );
  return await rebuildWithoutCustomization(run, tree, prepared, withoutPlugins);
}

/** Сборка, проба и замена плагинов - до первого касания того, что запущено. Возврат:
 * либо дерево, которое поднялось и оправдано, либо исход unhealthy. */
async function buildCandidate(
  run: UpdateRun,
): Promise<{ tree: CandidateTree } | UpdateOutcome> {
  const { active, name, store, plugins, dir, customDir, log, notify } = run;
  // Built by a run that never activated it: the tree is there, the rest is owed.
  const prepared = store.list().includes(name);
  const tree: CandidateTree = {
    custom: builtWith(dir, name, customDir, plugins),
    mounted: plugins.filter((plugin) => existsSync(join(dir, plugin.mount))),
    refusals: new Map(),
  };
  if (active === name) {
    // The flip happened, the rest did not: pick the update up where it stopped.
    log(`finishing the move onto ${name}`);
    return { tree };
  }
  await buildTree(run, tree, prepared);
  const health = await repairTree(run, tree, prepared);
  if (!health.ok) {
    // Garbage nothing points at - unless an earlier run finished it, and then
    // it is somebody's way back, which a failed probe never takes.
    if (!prepared) rmSync(dir, { recursive: true, force: true });
    await settleCustom(run, tree, false);
    notify(
      `update to ${name} did not start; staying on ${active ?? "the current version"}`,
    );
    return { status: "unhealthy", version: name, log: health.log };
  }
  // The tree is final and it starts: the state of the plugins is settled against it,
  // so `plugins.json` can never claim a plugin whose code is not in what runs.
  await settlePlugins(run, tree);
  await settleCustom(run, tree, true);
  // Proved and immutable. It remains a candidate until all old writers stop
  // and every state migration finishes against the old active Version.
  store.complete(name);
  return { tree };
}

/** Каким было состояние до этого дерева: на него возвращаются, если сервис после переезда
 * не ответит. */
function rollbackTo(run: UpdateRun): string | null {
  const { store, active, name } = run;
  const storedPrevious = store.previousName();
  if (active !== null && active !== name && store.list().includes(active))
    return active;
  return storedPrevious !== name ? storedPrevious : null;
}

/** Чистка vault правит память пользователя, поэтому оставляет пару коммитов: снимок того,
 * что было незакоммичено до неё (только если было), и результат чистки, названный версией.
 * Ни один из коммитов не может уронить обновление - как и сам errand. */
async function cleanVault(run: UpdateRun): Promise<void> {
  const vault = run.store.layout.vault;
  // Шов достаётся тем же способом, что и в меню: обновлятор обязан грузиться на установке,
  // где агентское дерево отсутствует или переписано наполовину
  // (scripts/authored-tree-guard.test.ts). Нет шва - чистка идёт без коммитов.
  const pair = await loadVaultPair(`update ${run.name}`, vault);
  await pair?.before();
  await errand(run.run, run.log, {
    what: "the vault cleanup",
    failure: "the update continues without it",
    command: process.execPath,
    args: [join(run.dir, "scripts/vault-cleanup.ts"), ".", "--apply"],
    cwd: vault,
  });
  await pair?.after();
}

/** Переезд: остановка старых писателей, миграции состояния, чистка vault и только потом
 * переброс симлинка и старт. Границу задаёт `quiesce`: ни один старый писатель не должен
 * пересечься с миграцией, меняющей общее состояние. */
async function migrateAndFlip(
  run: UpdateRun,
  rollback: string | null,
): Promise<string[]> {
  const { home, name, quiesce, startCandidate, store, log } = run;
  try {
    await quiesce();
    const migrations = await runMigrations({
      dir: join(run.dir, "scripts/migrations"),
      dataDir: store.layout.data,
      context: { home, dataDir: store.layout.data, versionDir: run.dir },
      log,
    });
    await cleanVault(run);
    if (store.currentName() !== name) store.activate(name);
    await startCandidate(store.layout.current);
    return migrations;
  } catch (error) {
    // Every recoverable fault restores the Version that served before this run.
    // The candidate stays complete, so the next update can retry without rebuild.
    if (rollback !== null && rollback !== name && store.currentName() === name)
      store.activate(rollback);
    const recoveryRoot =
      run.active === null && store.currentName() === null
        ? home
        : store.layout.current;
    await run
      .resumeOldWriters(recoveryRoot)
      .catch((restartError: unknown) =>
        log(`service recovery failed: ${String(restartError)}`),
      );
    throw error;
  }
}

/** Порядок важен: провал живого хода записывается до отката, иначе убийство посреди
 * отката оставит следующий ход в вере, что это дерево годится для возврата. */
async function goBack(
  run: UpdateRun,
  failed: {
    readonly tree: CandidateTree;
    readonly rollback: string | null;
    readonly port: number;
    readonly log: string;
  },
): Promise<UpdateOutcome> {
  const { tree, rollback, port, log } = failed;
  const { store, name, notify } = run;
  let recordFailure: unknown;
  try {
    store.recordLive(name, false);
  } catch (error) {
    recordFailure = error;
  }
  if (rollback) {
    store.activate(rollback);
    // A restart that fails here leaves a service the user is without either
    // way, and the flip is what makes the next start the older version's.
    await run
      .resumeOldWriters(store.layout.current)
      .catch((error: unknown) =>
        run.log(`the restart onto ${rollback} failed: ${String(error)}`),
      );
    store.settle(rollback);
  }
  notify(
    `${name} did not answer on port ${port} after the restart; ` +
      (rollback
        ? `going back to ${rollback}`
        : "there is no earlier version to go back to") +
      (tree.custom === "applied"
        ? ". Your files in data/custom are the likeliest cause - they build and" +
          " they start, and the service still did not come up on them. The next" +
          " update installs this version without them."
        : ""),
  );
  if (recordFailure !== undefined)
    throw recordFailure instanceof Error
      ? recordFailure
      : new Error("recording live failure threw a non-Error value", {
          cause: recordFailure,
        });
  return { status: "unhealthy", version: name, log };
}

/** Установка на новой версии: сервис отвечает или возвращается та, что служила. Проба до
 * переезда шла на песочном состоянии и песочном порту, поэтому ломается здесь и только
 * здесь установка, которая цела ровно на своём: стор карточек, который не открыть,
 * занятый порт, окружение юнита. Назад - это переброс симлинка и перезапуск, и это не
 * работа владельца руками через агента, который лежит. */
async function serveAndFinish(
  run: UpdateRun,
  tree: CandidateTree,
  migrations: string[],
  rollback: string | null,
): Promise<UpdateOutcome> {
  const { store, name, env, serving, log } = run;
  const port = servicePort(env);
  const live = await serving(port).catch((error: unknown) => ({
    ok: false,
    log: error instanceof Error ? error.message : String(error),
  }));
  if (!live.ok)
    return await goBack(run, { tree, rollback, port, log: live.log });
  // Served: whatever this code did to the installation before, it does not now.
  store.recordLive(name, true);
  // Service state commits before every optional cleanup. A crash or cleanup
  // fault leaves explicit debt, never a healthy update reported as unfinished.
  store.settle(name, {
    cleanupPending: true,
    previous: run.active !== name ? run.active : rollback,
  });
  // After the service is up: until it runs the new version, the old checkout is
  // what a failed restart falls back to, so it is not ours to remove any earlier.
  const removed = await runPostHealthCleanup({
    name,
    run: run.run,
    adopt: run.adopt,
    log,
    store,
  });
  return {
    status: "updated",
    version: name,
    previous: rollback,
    custom: tree.custom,
    migrations,
    removed,
  };
}

export async function finishVersionUpdate(
  options: FinishOptions,
): Promise<UpdateOutcome> {
  const run = await openUpdate(options);
  if (
    run.active === run.name &&
    run.settledBefore === run.name &&
    run.store.cleanupPending(run.name)
  ) {
    await runPostHealthCleanup({
      name: run.name,
      run: run.run,
      adopt: run.adopt,
      log: run.log,
      store: run.store,
    });
    return { status: "current", version: run.name };
  }
  const built = await buildCandidate(run);
  if ("status" in built) return built;
  const rollback = rollbackTo(run);
  const migrations = await migrateAndFlip(run, rollback);
  return await serveAndFinish(run, built.tree, migrations, rollback);
}

/**
 * Optional installation chores are durable debt after service commit. Version
 * cleanup goes first so every later chore has the disk space it needs.
 */
async function runPostHealthCleanup({
  name,
  run,
  adopt,
  log,
  store,
}: {
  readonly name: string;
  readonly run: Runner;
  readonly adopt: () => void;
  readonly log: Say;
  readonly store: Store;
}): Promise<string[]> {
  let complete = true;
  let removed: string[] = [];
  try {
    removed = store.gc(KEEP);
    for (const gone of removed) log(`removed ${gone}`);
  } catch (error) {
    complete = false;
    log(`version cleanup remains pending: ${String(error)}`);
  }
  try {
    adopt();
  } catch (error) {
    complete = false;
    log(`installation adoption remains pending: ${String(error)}`);
  }
  if (
    !(await errand(run, log, {
      what: "the Google CLI update",
      failure: "cleanup remains pending",
      command: "bash",
      // Reuse install.sh's pinned archive and SHA-256 check under the service user's prefix.
      args: [
        join(store.layout.versions, name, "install.sh"),
        "--update-gws",
        join(homedir(), ".local"),
      ],
      cwd: join(store.layout.versions, name),
    }))
  )
    complete = false;
  if (complete) {
    try {
      store.finishCleanup(name);
    } catch (error) {
      log(`cleanup state remains pending: ${String(error)}`);
    }
  }
  return removed;
}

/**
 * Потолок причины в строке журнала: вывод команды может быть длинным, а строка одна.
 */
const ERRAND_REASON_CHARS = 200;

/**
 * Something an update does for the installation rather than for the version it
 * installs: the vault cleaner, run out of the new version before the service can
 * open what it repairs, and the Google CLI, the one dependency that lives outside
 * a version. Neither has ever been allowed to fail an update - a done update
 * stays done when one of them cannot run.
 */
async function errand(
  run: Runner,
  log: Say,
  {
    what,
    failure,
    command,
    args,
    cwd,
  }: {
    readonly what: string;
    readonly failure: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  },
): Promise<boolean> {
  const done = await run(command, args, cwd).catch(
    (error: unknown): CommandResult => ({ code: 1, output: String(error) }),
  );
  if (done.code === 0) return true;
  // Причина едет в ту же строку: без неё провал необязательного шага («uv не в PATH
  // неинтерактивного ssh») выясняется только руками. Вывод команды — последняя непустая
  // строка, не длиннее 200 знаков; пустой вывод оставляет один код выхода.
  const lastLine =
    done.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? "";
  const reason =
    lastLine === ""
      ? `exit ${done.code}`
      : `exit ${done.code}: ${lastLine.slice(0, ERRAND_REASON_CHARS)}`;
  log(`${what} did not run (${reason}); ${failure}`);
  return false;
}

function stockNotice(verb: string, failure: string): string {
  return `your customization in data/custom does not ${verb} this version, so Iva is running the stock build:\n${failure.slice(-1500)}`;
}

/**
 * Первая строка ошибки из строки журнала о заводской сборке — для Alert в чат, где весь
 * вывод сборки не нужен. Строка с «error» важнее заголовка npm. `null` — у строки нет
 * вывода ошибки: это `deferredNotice`. Разбор живёт рядом с форматом, который разбирает.
 */
export function stockFailureLine(notice: string): string | null {
  const cut = notice.indexOf("\n");
  if (cut < 0) return null;
  const lines = notice
    .slice(cut + 1)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line =
    lines.find((one) => /error/iu.test(one)) ?? lines[0] ?? "(no output)";
  return line.slice(0, ERRAND_REASON_CHARS);
}

/**
 * The customization is held back rather than tried: the last update that carried
 * it left the service down. Only an edit to `data/custom` or a new release makes
 * an update try it again, so the user is told which of the two is theirs to do.
 */
function deferredNotice(): string {
  return (
    "Iva is running the stock build: the version carrying your data/custom files " +
    "did not come up after the restart last time, so this update leaves them out. " +
    "The files are untouched where you wrote them - fix them, and the next update " +
    "installs them again."
  );
}

/**
 * The local half of what a refused plugin costs the owner: the update output says it
 * outright. The Alert that says the same in the chat is the caller's (ADR-0007), and
 * `iva update` from Telegram is exactly the run whose output nobody reads.
 */
export function pluginsOffNotice(failures: readonly PluginFailure[]): string {
  // The same sentence the chat gets, in the language of the terminal, plus the reason
  // the chat does not carry: one text, so the two channels cannot drift apart.
  const text = pluginsSwitchedOffAlert(
    (english) => english,
    failures.map((failure) => failure.name),
  );
  return `${text}\n${failures[0]?.reason.slice(-1500) ?? ""}`;
}

/** One npm step in place; the step's own output is the failure report. */
async function npmStep(
  dir: string,
  run: Runner,
  args: readonly string[],
  what: string,
): Promise<void> {
  const done = await run("npm", args, dir);
  if (done.code !== 0) throw new Error(`${what} failed:\n${done.output}`);
}

/** What a build carried, what it mounted, and every plugin it refused along the way. */
type BuiltVersion = {
  readonly custom: Custom;
  readonly mounted: readonly CodePlugin[];
  readonly failed: readonly PluginFailure[];
  /** The output line about the stock build; said once the tree starts. */
  readonly stockNotice?: string;
};

/** Build a staged version with the user's files in it, or without them if they break it. */
async function buildVersion({
  store,
  name,
  run,
  log,
  plugins,
  requirePlugins,
}: {
  readonly store: Store;
  readonly name: string;
  readonly run: Runner;
  readonly log: Say;
  readonly plugins: readonly CodePlugin[];
  readonly requirePlugins: boolean;
}): Promise<BuiltVersion> {
  const dir = join(store.layout.versions, name);
  const customDir = join(store.layout.data, "custom");
  const { files } = customOverlay(customDir);
  // Падать до установки зависимостей: слот не может занять имя встроенного файла.
  for (const path of files) {
    if (isInstructionSlotPath(path) && existsSync(join(dir, path)))
      throw instructionSlotCollision(path);
  }
  await npmStep(dir, run, INSTALL, "dependency installation");
  for (const path of files) {
    // Confined to the version by `isAuthoredPath`: it rejects anything absolute,
    // anything that climbs out with `..`, and everything outside `agent/`.
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(customDir, path), join(dir, path));
  }
  if (files.length > 0) log(`applied ${files.length} customized file(s)`);
  /**
   * Whether the version carries anything of the owner's. A mounted plugin counts:
   * it is code the release does not ship, so a version that will not start with it
   * has to be rebuilt without it, exactly like a skill that will not start.
   */
  const carried = (withPlugins: number): Custom =>
    files.length > 0 || withPlugins > 0 ? "applied" : "none";

  // One plugin at a time: a plugin whose own extension build fails is named by that
  // step, and its neighbours still get theirs.
  const failed: PluginFailure[] = [];
  const mounted: CodePlugin[] = [];
  for (const plugin of plugins) {
    const staged = await buildPluginExtension({
      versionDir: dir,
      plugin,
      run,
      log,
    });
    if (staged.ok) {
      mounted.push(plugin);
      continue;
    }
    removePluginFromVersion(dir, plugin);
    if (requirePlugins) throw new Error(staged.output);
    log(staged.output);
    failed.push({
      name: plugin.name,
      digest: plugin.digest,
      reason: staged.output,
    });
  }

  const built = await run("npm", BUILD, dir);
  if (built.code === 0)
    return { custom: carried(mounted.length), mounted, failed };

  // The tree will not compile with the plugins in it. Which one of them it is is not
  // worth a search: they are the only part of the tree that is neither upstream's nor
  // the user's, so they all come out in one build, and the owner puts them back one at
  // a time. That answer costs one rebuild; a search costs one per plugin.
  if (mounted.length > 0) {
    for (const plugin of mounted) removePluginFromVersion(dir, plugin);
    const withoutPlugins = await run("npm", BUILD, dir);
    if (withoutPlugins.code === 0) {
      const named = mounted.map((plugin) => plugin.name).join(", ");
      const reason = `this version does not build with ${named}:\n${built.output.slice(-OUTPUT_TAIL)}`;
      if (requirePlugins) throw new Error(reason);
      log(reason);
      return {
        custom: carried(0),
        mounted: [],
        failed: [
          ...failed,
          ...mounted.map((plugin) => ({
            name: plugin.name,
            digest: plugin.digest,
            reason,
          })),
        ],
      };
    }
    // Not the plugins after all. Nothing is put back: what comes next rebuilds the
    // whole tree from the commit, or throws and takes the directory with it.
  }
  if (files.length === 0) throw new Error(`build failed:\n${built.output}`);

  // The user's own code must never keep the service down: rebuild the stock tree
  // in place and say so. The customization stays untouched in data/custom.
  log("the customized build failed; rebuilding this version without it");
  await buildStock(store, name, run);
  return {
    custom: "stock",
    mounted: [],
    failed,
    stockNotice: stockNotice("build against", built.output),
  };
}

/** Rebuild a staged version from its commit alone: a broken customization is tried once. */
async function buildStock(
  store: Store,
  name: string,
  run: Runner,
): Promise<void> {
  const dir = store.reset(name);
  await store.materialize({ sha: parseVersionName(name)?.sha ?? "", dir });
  store.linkState(dir);
  await npmStep(dir, run, INSTALL, "dependency installation");
  await npmStep(dir, run, BUILD, "build");
}

function validMigrationState(
  value: unknown,
): value is { schema: "iva-migrations/v1"; applied: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  return (
    keys.length === 2 &&
    keys.every((key) => key === "schema" || key === "applied") &&
    state.schema === "iva-migrations/v1" &&
    Array.isArray(state.applied) &&
    state.applied.every(
      (name, index, names) =>
        typeof name === "string" &&
        MIGRATION_FILE.test(`${name}.ts`) &&
        names.indexOf(name) === index,
    )
  );
}

/** Names already applied. Missing is valid; every existing invalid marker blocks. */
function appliedMigrations(dataDir: string): string[] {
  const marker = join(dataDir, MIGRATION_MARKER);
  let regularFile: boolean;
  try {
    regularFile = lstatSync(marker).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!regularFile)
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: migration state marker is not a regular file`,
    );
  let bytes: Buffer;
  try {
    bytes = readFileSync(marker);
  } catch (error) {
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isUtf8(bytes))
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: invalid UTF-8`,
    );
  let state: unknown;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!validMigrationState(state))
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: invalid migration state schema`,
    );
  return state.applied;
}

/** Unapplied migrations this version ships. Each is idempotent; the marker only saves work. */
export async function runMigrations({
  dir,
  dataDir,
  context,
  log,
}: {
  readonly dir: string;
  readonly dataDir: string;
  readonly context: MigrationContext;
  readonly log?: Say;
}): Promise<string[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => MIGRATION_FILE.test(name));
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  const applied = appliedMigrations(dataDir);
  const done: string[] = [];
  const marker = join(dataDir, MIGRATION_MARKER);
  for (const name of files.sort().map((file) => file.slice(0, -3))) {
    if (applied.includes(name)) continue;
    log?.(`migration ${name}`);
    try {
      const module = (await import(
        pathToFileURL(join(dir, `${name}.ts`)).href
      )) as { default: Migration };
      await module.default(context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${name} failed: ${detail}`, { cause: error });
    }
    done.push(name);
    writeJson(marker, {
      schema: "iva-migrations/v1",
      applied: [...applied, ...done],
    });
  }
  return done;
}

/** npm as a `Runner`: silent unless it fails, when its output is the report. */
export function commandRunner(verbose: boolean): Runner {
  return (command, args, cwd) =>
    new Promise<CommandResult>((resolve) => {
      const io = verbose ? "inherit" : "pipe";
      const child = spawn(command, [...args], {
        cwd,
        env: {
          ...process.env,
          ASSISTANT_DATA_DIR: resolveDataDir(cwd),
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", io, io],
      });
      let output = "";
      const collect = (chunk: unknown): void => {
        output = `${output}${String(chunk)}`.slice(-OUTPUT_TAIL);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => resolve({ code: 1, output: error.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
}
