// Getting a plugin into the store and taking it back out: `add`, `update`, `remove`, `sync`.
//
// Every install stages first and swaps last (the primitives are in
// `scripts/lib/plugin-install.ts`), and the swap keeps the folder it displaced until the
// version carrying the plugin is built. That copy is the only way back: a build that fails
// undoes the install rather than the box (ADR-0003, ADR-0009).
//
// `sync` is the repair door of the same machinery: it rebuilds `plugins.json` from the
// folders on disk and fetches back what a record names and the store lacks.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PluginManifest, PluginReport } from "#lib/plugin-reader.ts";
import type { PluginEntry, PluginsState } from "#lib/plugin-store.ts";
import { parseMarketplaceRequest } from "../lib/marketplace.ts";
import {
  namespaceTaken,
  pluginCodeProblem,
  pluginNamespace,
} from "../lib/plugin-build.ts";
import { carriesCodeOrMcp, staleReason } from "../lib/plugin-proposal.ts";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "../lib/plugin-source.ts";
import {
  pluginReadProblem,
  STAGING_PREFIX,
  type PluginCliContext,
} from "./plugin-cli-context.ts";
import type {
  createPluginMarketplaceCommands,
  Provenance,
} from "./plugin-cli-marketplace.ts";
import type { createPluginTrustCommands } from "./plugin-cli-trust.ts";

/** Пришло из ADR-0008 «Принятый риск»: показывается один раз, перед первой установкой. */
const RISK_EN =
  "A plugin runs with the agent's environment: bash inside its skill sees every key of this installation " +
  "(Telegram, the model provider, everything else). Installing someone else's plugin means handing it those keys. " +
  "The manifest does not help: plugin.json describes what is inside, not what it does. Install what you trust.";
const RISK_RU =
  "Плагин работает в окружении агента: bash внутри его скилла видит все ключи этой инсталляции " +
  "(Telegram, провайдер модели, всё остальное). Поставить чужой плагин — отдать ему эти ключи. " +
  "Манифест от этого не спасает: plugin.json описывает состав, а не поведение. Ставь то, чему доверяешь.";

/** What an install has to put back if the version carrying it will not build. */
type Undo = {
  readonly name: string;
  /** The entry `plugins.json` had before, or null when there was none. */
  readonly previous: PluginEntry | null;
  /** The folder the install displaced, kept so an update can be taken back. */
  readonly displaced: string | null;
};

type AddOptions = {
  /** Зовёт `install-proposal` по тапу владельца: гвард `add` не нужен. */
  readonly fromProposal?: boolean;
  /**
   * Хеш дерева (12 знаков) из кнопки владельца. Сверяется у копии, уже лежащей в staging
   * установщика: ставятся ровно эти байты, а не папка, которую мог тронуть второй писатель.
   */
  readonly expectDigest12?: string;
  /** Что записать в `source` вместо пути копии предложения: папка черновика. */
  readonly source?: string;
};

type Staged = {
  readonly root: string;
  readonly sha: string;
  readonly ref: string;
};

export function createPluginInstallCommands(
  context: PluginCliContext,
  groups: {
    readonly marketplace: ReturnType<typeof createPluginMarketplaceCommands>;
    readonly trust: ReturnType<typeof createPluginTrustCommands>;
  },
) {
  const {
    runtime,
    core,
    args,
    force,
    trustAsked,
    git,
    translate,
    now,
    log,
    interactive,
    components,
    absolute,
    locked,
    buildCode,
    mustFind,
  } = context;
  const { marketplace, trust } = groups;
  const {
    grantPorts,
    grantPortsToTrusted,
    inVersion,
    processCommands,
    reconcileUnits,
    restartMoved,
  } = trust;
  const { ok, warn, bad, step, confirm, dataDirAbs } = runtime;
  const { pluginTreeDigest, readPlugin } = core.reader;
  const {
    findPlugin,
    pluginDataDir,
    pluginRoot,
    pluginsDir,
    pluginsStateFile,
    readPluginsState,
    readPluginsStateSafe,
    salvagePluginsStateFile,
    removePlugin,
    upsertPlugin,
    writePluginsState,
  } = core.store;
  const {
    copyPluginTree,
    fetchGitPlugin,
    resolveRemoteSha,
    restoreDisplaced,
    swapIntoStore,
  } = core.install;

  /** Плагин во временной папке: git-источник — fetch, локальный — копия. */
  async function stage(source: PluginSource, staging: string): Promise<Staged> {
    if (source.kind === "local") {
      await copyPluginTree(source.path, staging);
      return { root: staging, sha: "", ref: "" };
    }
    const { sha, ref } = resolveRemoteSha(git, source.url, source.ref);
    return {
      root: fetchGitPlugin(git, staging, source.url, sha, source.subdir),
      sha,
      ref,
    };
  }

  /** Staged-копия `install-proposal` расходится с хешем из кнопки — «предложение устарело». */
  async function sameAsButton(
    root: string,
    expectDigest12: string | null,
  ): Promise<void> {
    if (expectDigest12 === null) return;
    if ((await pluginTreeDigest(root)).slice(0, 12) !== expectDigest12)
      throw new Error(staleReason(translate));
  }

  /**
   * Читает плагин или отказывает, назвав все причины. `proposalOnly` — `add` без человека
   * у терминала и не из `install-proposal`: тогда плагин с кодом или MCP не ставится.
   */
  async function accept(
    root: string,
    label: string,
    proposalOnly: boolean,
  ): Promise<{
    readonly report: PluginReport;
    readonly manifest: PluginManifest;
  }> {
    const report = await readPlugin(root);
    if (!report.manifest) {
      for (const line of report.diagnostics) bad(line);
      throw new Error(`${label} is not a usable Agent Plugins folder`);
    }
    // Проверка согласия владельца, а не граница безопасности: модель с `bash` ставит плагин с кодом
    // или MCP только через предложение и тап владельца; терминал владельца — как раньше.
    if (proposalOnly && carriesCodeOrMcp(root))
      throw new Error(
        translate(
          "a plugin with code or MCP installs through iva plugin propose",
          "плагин с кодом или MCP ставится через iva plugin propose",
        ),
      );
    for (const line of report.diagnostics) warn(line);
    return { report, manifest: report.manifest };
  }

  /**
   * Кто из уже стоящих плагинов чем владеет. Одноимённый скилл у двух плагинов —
   * отказ на add: две папки претендуют на одно имя в промпте, и молча выбрать одну
   * значило бы отключить другую втихую. Так же и с кодом: mount у плагинов с кодом
   * один файл на namespace (ADR-0009), и вторая папка на то же имя перезаписала бы
   * первую.
   */
  async function owners(
    data: string,
    state: PluginsState,
    except: string,
  ): Promise<{
    readonly skills: Map<string, string>;
    readonly code: string[];
  }> {
    const skills = new Map<string, string>();
    const code: string[] = [];
    for (const entry of state.plugins) {
      if (entry.name === except) continue;
      const report = await readPlugin(pluginRoot(data, entry.name));
      for (const skill of report.skills)
        if (!skills.has(skill.name)) skills.set(skill.name, entry.name);
      if (report.code) code.push(entry.name);
    }
    return { skills, code };
  }

  async function install(
    data: string,
    state: PluginsState,
    raw: PluginSource,
    previous: PluginEntry | null,
    provenance: Provenance | null = null,
    /** `add` без человека у терминала и не из `install-proposal` (ADR-0009). */
    proposalOnly = false,
    /** Хеш дерева из кнопки: staged-копия обязана с ним совпасть (`install-proposal`). */
    expectDigest12: string | null = null,
  ): Promise<{
    readonly entry: PluginEntry;
    readonly report: PluginReport;
    readonly undo: Undo;
  }> {
    const source = absolute(raw);
    mkdirSync(pluginsDir(data), { recursive: true });
    // Staging живёт рядом с плагинами: переезд к ним обязан быть переименованием,
    // а переименование работает только в пределах одной файловой системы.
    const staging = mkdtempSync(join(pluginsDir(data), STAGING_PREFIX));
    try {
      const staged = await stage(source, staging);
      await sameAsButton(staged.root, expectDigest12);
      const { report, manifest } = await accept(
        staged.root,
        formatPluginSource(source),
        proposalOnly,
      );
      const name = manifest.name;
      await context.checkDescriptions(report);
      if (previous && previous.name !== name)
        throw new Error(
          `${formatPluginSource(source)} now calls itself ${JSON.stringify(name)}, not ${JSON.stringify(previous.name)} — remove the old one first`,
        );
      // Marketplace — непроверенный файл: он обещает имя, а имя объявляет манифест.
      // Разошлись — ставится не то, что просили: отказ до переезда в data/custom/plugins/.
      if (provenance && provenance.expect !== name)
        throw new Error(
          `${provenance.marketplace} offers ${provenance.expect}, but this plugin calls itself ${JSON.stringify(name)} — refusing to install it`,
        );
      // Запись БЕЗ источника — не заявка на имя, а след починки (`sync` подобрал
      // папку, из которой она пришла, узнать неоткуда). Такую перекрываем, иначе
      // владельцу некуда идти: `add` упирался бы в неё, а `update` — в пустой
      // источник.
      const recorded = previous ? null : findPlugin(state, name);
      if (recorded?.source)
        throw new Error(
          `${name} is already installed — use: iva plugin update ${name}`,
        );

      const owned = await owners(data, state, name);
      for (const skill of report.skills) {
        const owner = owned.skills.get(skill.name);
        if (owner)
          throw new Error(
            `skill ${JSON.stringify(skill.name)} is already provided by the plugin ${owner} — remove one of them first`,
          );
      }
      if (report.code) {
        // Оба отказа — до переезда в стор: mount пишется во время сборки версии,
        // и коллизия, найденная там, стала бы отказом сборки вместо ответа команде.
        const problem = pluginCodeProblem(staged.root, name);
        if (problem) throw new Error(problem);
        const taken = namespaceTaken(name, owned.code);
        if (taken)
          throw new Error(
            `${name} and ${taken} both need the extension mount ${pluginNamespace(name)}.ts — remove one of them first`,
          );
      }

      // Владелец видит состав ДО того, как что-то встало на место.
      log(
        `  ${name}${manifest.version ? ` ${manifest.version}` : ""} — ${components(report)}`,
      );
      if (!previous && existsSync(pluginRoot(data, name)))
        warn(
          recorded
            ? `${name} was recorded without a source — replacing it and writing the source down`
            : `a folder named ${name} was there without an entry in plugins.json — replacing it`,
        );

      // Папку, которую установка сместила, держим до конца сборки версии: только
      // ею можно вернуть плагин на место, если версия с ним не собралась.
      const displaced = swapIntoStore(staged.root, pluginRoot(data, name), {
        retain: report.code,
      });
      // PLUGIN_DATA переживает и обновление, и удаление плагина (спека §9.1).
      await mkdir(pluginDataDir(data, name), { recursive: true });
      const marketplace =
        provenance?.marketplace ?? (previous ?? recorded)?.marketplace;
      return {
        undo: { name, previous: previous ?? recorded ?? null, displaced },
        entry: {
          name,
          source: formatPluginSource(source),
          ref: staged.ref,
          sha: staged.sha,
          digest: await pluginTreeDigest(pluginRoot(data, name)),
          enabled: (previous ?? recorded)?.enabled ?? true,
          trusted: (previous ?? recorded)?.trusted ?? false,
          installedAt: now().toISOString(),
          ...(marketplace ? { marketplace } : {}),
        },
        report,
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Вернуть стор и plugins.json в то состояние, из которого вышли установки, чью
   * версию не удалось собрать.
   *
   * Папки возвращаются ДО лока, а не под ним: `locked` первым делом подметает
   * недоделки прерванной установки, а смещённая копия выглядит ровно как они — она
   * бы её и снесла. Состояние пишется одной записью под локом.
   */
  async function undoInstalls(
    data: string,
    undos: readonly Undo[],
  ): Promise<void> {
    for (const undo of undos) {
      const target = pluginRoot(data, undo.name);
      if (undo.displaced) restoreDisplaced(undo.displaced, target);
      else rmSync(target, { recursive: true, force: true });
    }
    await locked(data, async () => {
      let state = await readPluginsState(data);
      for (const undo of undos)
        state = undo.previous
          ? upsertPlugin(state, undo.previous)
          : removePlugin(state, undo.name);
      await writePluginsState(data, state);
    });
  }

  /** Сборка прошла — смещённая папка больше не нужна. */
  function dropDisplaced(undo: Undo): void {
    if (undo.displaced)
      rmSync(undo.displaced, { recursive: true, force: true });
  }

  /**
   * Вопрос доверия при `add`. Печатаются команды, а ответ по умолчанию — «нет»:
   * не-TTY (скрипт, ansible) без `--trust` доверия не получает, потому что никто
   * не ответил.
   *
   * Вопрос задаётся ровно про процессы (`stdio`-серверы и сервисы). У плагина, чей
   * `mcp.json` весь удалённый, процессов нет — там доверие даёт только `--trust`
   * или отдельная команда потом: спрашивать про «запускать процессы» было бы
   * неправдой, а решать за владельца, чей токен уйдёт на чужой сервер, — тем более.
   */
  async function askTrust(report: PluginReport): Promise<boolean> {
    const lines = processCommands(report);
    const anything = lines.length > 0 || Object.keys(report.mcp).length > 0;
    if (!anything) return false;
    if (lines.length > 0) {
      log(
        translate(
          "  This plugin wants to run processes on this machine:",
          "  Этот плагин хочет запускать процессы на этой машине:",
        ),
      );
      for (const line of lines) log(`    ${line}`);
    }
    if (trustAsked) return true;
    if (lines.length === 0) return false;
    return confirm(
      translate(
        "Start these processes on this machine?",
        "Запускать эти процессы на этой машине?",
      ),
      false,
    );
  }

  /** Указывает ли локальный источник на этот каталог; одного из путей нет — нет. */
  function pointsAt(source: PluginSource, dir: string): boolean {
    const resolved = absolute(source);
    try {
      return (
        resolved.kind === "local" &&
        realpathSync(resolved.path) === realpathSync(dir)
      );
    } catch {
      return false;
    }
  }

  /** Insight, как его записал тик; файл не прочёлся — строка и null (импорт ленивый). */
  async function lastInsight(data: string) {
    try {
      const { readProactiveState } = await import("../proactive/state.ts");
      return readProactiveState(join(data, "proactive.json"))?.insight ?? null;
    } catch (error) {
      const why = (error as Error).message;
      warn(
        translate(
          `data/proactive.json is not readable (${why}): installing without comparing the draft with the Insight message`,
          `data/proactive.json не читается (${why}): ставлю без сверки черновика с сообщением инсайта`,
        ),
      );
      return null;
    }
  }

  /**
   * С чем сверяется staged-копия: хеш из кнопки предложения, а у `add` без человека у терминала
   * по папке черновика последнего Insight — его отпечаток в минуту отправки (ADR-0022).
   */
  async function expectedTree(
    data: string,
    typed: PluginSource | null,
    options: AddOptions | undefined,
  ): Promise<string | null> {
    if (options?.expectDigest12 !== undefined) return options.expectDigest12;
    if (interactive() || typed === null) return null;
    const insight = await lastInsight(data);
    if (!insight?.tree) return null;
    const draft = join(data, "custom/plugin-drafts", insight.draft);
    return pointsAt(typed, draft) ? insight.tree : null;
  }

  /** Без человека у терминала и не из `install-proposal`: код и MCP — только через тап. */
  function proposalOnly(options: AddOptions | undefined): boolean {
    return options?.fromProposal !== true && !interactive();
  }

  async function add(options?: AddOptions): Promise<void> {
    const raw = args[0];
    if (!raw)
      throw new Error(
        "iva plugin add <name|source> — a name from a Marketplace, a folder, owner/repo[/subdir][@ref], https://… or git@…",
      );
    // Голое имя — запрос к Marketplace; всё остальное разбирается как источник
    // здесь же, до лока: неизвестная форма не должна занимать лок апдейта.
    const request = parseMarketplaceRequest(raw);
    const typed = request ? null : parsePluginSource(raw);
    const data = dataDirAbs();

    // Состояние читается и пишется ВНУТРИ лока: прочитать до лока значило бы
    // записать поверх чужого `disable`, который случился, пока шла установка.
    const installed = await locked(data, async () => {
      const state = await readPluginsState(data);
      if (!state.riskNoticeShownAt) {
        warn(translate(RISK_EN, RISK_RU));
        log();
      }
      const { source, provenance } = request
        ? await marketplace.sourceByName(data, state, request)
        : { source: typed as PluginSource, provenance: null };
      step(
        provenance
          ? `Installing ${provenance.expect} from ${provenance.marketplace} (${formatPluginSource(source)})`
          : `Installing ${formatPluginSource(source)}`,
      );
      return install(
        data,
        state,
        source,
        null,
        provenance,
        proposalOnly(options),
        await expectedTree(data, typed, options),
      );
    });

    // Вопрос доверия — БЕЗ лока: он ждёт человека, а лок один на `iva update` и на
    // таймер проверки обновлений, и держать их, пока владелец читает список команд,
    // значит отказывать им столько же, сколько он думает. Ответ нужен до сборки:
    // connection-файлы зависят от него, и спросить после значило бы собрать версию
    // дважды. Прерванный на вопросе `add` оставляет папку без записи — её принимает
    // обратно `iva plugin sync`.
    const trusted = await askTrust(installed.report);
    const { entry, report, undo } = await locked(data, async () => {
      // Состояние перечитывается: пока шёл вопрос, его могла сменить другая команда.
      const state = await readPluginsState(data);
      let next = upsertPlugin(state, {
        ...installed.entry,
        ...(options?.source ? { source: options.source } : {}),
        trusted,
      });
      if (trusted)
        next = grantPorts(data, next, installed.entry.name, installed.report);
      await writePluginsState(data, {
        ...next,
        riskNoticeShownAt: state.riskNoticeShownAt ?? now().toISOString(),
      });
      return {
        ...installed,
        entry: findPlugin(next, installed.entry.name) ?? installed.entry,
      };
    });

    // Код плагина и его connection-файлы живут в версии, поэтому установка
    // заканчивается сборкой и рестартом. Сборка не прошла — установки не было: стор и
    // plugins.json возвращаются как были, работающая версия не тронута (ADR-0003).
    let inRunningVersion = false;
    if (entry.enabled && inVersion(report, entry.trusted)) {
      const outcome = await buildCode(entry.name, true);
      if (outcome.failure !== null) {
        await undoInstalls(data, [undo]);
        throw new Error(`${entry.name} was not installed: ${outcome.failure}`);
      }
      inRunningVersion = outcome.built;
    }
    dropDisplaced(undo);
    // Юниты — после сборки: прокси запускается из версии, которая уже собрана.
    if (entry.trusted)
      await locked(data, async () =>
        reconcileUnits(data, await readPluginsState(data)),
      );

    ok(`${entry.name} installed`);
    if (report.skills.length)
      ok(
        translate(
          "skills work from the next turn: no build, no restart",
          "скиллы работают со следующего хода: без сборки и рестарта",
        ),
      );
    // Последняя строка говорит о том, что случилось, а не о том, что задумано: на
    // development checkout версии собирать нечем, и «код собран» там было бы неправдой
    // ровно после предупреждения, что собрать его придётся руками.
    if (report.code && entry.enabled)
      ok(
        inRunningVersion
          ? translate(
              `code is built into the version that runs; its tools are prefixed ${pluginNamespace(entry.name)}__`,
              `код собран в работающую версию; тулы идут с префиксом ${pluginNamespace(entry.name)}__`,
            )
          : translate(
              `code is not in the version that runs; its tools appear once it is built`,
              `кода нет в работающей версии; тулы появятся после её сборки`,
            ),
      );
    const wants =
      processCommands(report).length > 0 || Object.keys(report.mcp).length > 0;
    if (wants && !entry.trusted)
      warn(
        translate(
          `${entry.name} is not trusted: its MCP servers and services stay off — allow them with: iva plugin trust ${entry.name}`,
          `${entry.name} не доверен: его MCP-серверы и сервисы не работают — разрешить: iva plugin trust ${entry.name}`,
        ),
      );
    if (Object.keys(report.mcp).length && entry.trusted)
      ok(
        inRunningVersion
          ? translate(
              "its MCP tools reach the agent from the next turn",
              "тулы его MCP-серверов доступны агенту со следующего хода",
            )
          : translate(
              "its MCP tools reach the agent once the version is built",
              "тулы его MCP-серверов появятся у агента после сборки версии",
            ),
      );
  }

  async function remove(): Promise<void> {
    const data = dataDirAbs();
    const { entry, code } = await locked(data, async () => {
      const state = await readPluginsState(data);
      const found = mustFind(state, args[0]);
      // Код читается ДО удаления папки: после него узнать, был ли он, неоткуда.
      const report = await readPlugin(pluginRoot(data, found.name));
      rmSync(pluginRoot(data, found.name), { recursive: true, force: true });
      const next = removePlugin(state, found.name);
      await writePluginsState(data, next);
      // Юниты снятого плагина уходят вместе с записью, до сборки версии: они держат
      // порты и процессы, и ждать сборки им незачем.
      await reconcileUnits(data, next);
      return {
        entry: found,
        code: inVersion(report, found.trusted) && found.enabled,
      };
    });
    // Плагин удалён, а его код всё ещё в работающей версии: убирает его сборка.
    if (code) {
      const { failure } = await buildCode(entry.name, false);
      if (failure !== null) warn(failure);
    }
    ok(
      translate(
        `${entry.name} removed — its data stays in ${pluginDataDir(data, entry.name)}`,
        `${entry.name} удалён — данные плагина остались в ${pluginDataDir(data, entry.name)}`,
      ),
    );
  }

  /**
   * Правил ли владелец папку руками. Отпечаток снимается одинаково с git-checkout,
   * подпапки и локальной копии — одно правило на три вида источника.
   */
  async function editedInPlace(
    root: string,
    entry: PluginEntry,
  ): Promise<{
    readonly kind: "edited" | "unreadable";
    readonly why: string;
  } | null> {
    if (!entry.digest || !existsSync(root)) return null;
    try {
      const current = await pluginTreeDigest(root);
      return current === entry.digest ? null : { kind: "edited", why: root };
    } catch (error) {
      return { kind: "unreadable", why: (error as Error).message };
    }
  }

  type Updated = {
    readonly state: PluginsState;
    /** Чем откатить установку, если версия с новым кодом не соберётся. */
    readonly undo: Undo | null;
    readonly code: boolean;
    /**
     * Приехало ли другое содержимое. Юниты этого плагина держат СТАРЫЙ процесс: тело
     * юнита могло не измениться вовсе (та же команда, тот же порт), а код за ним —
     * измениться целиком.
     */
    readonly moved: boolean;
  };

  async function updateOne(
    data: string,
    state: PluginsState,
    entry: PluginEntry,
  ): Promise<Updated> {
    const untouched: Updated = {
      state,
      undo: null,
      code: false,
      moved: false,
    };
    if (!entry.source) {
      warn(
        `${entry.name} has no source recorded — reinstall it: iva plugin add <source>`,
      );
      return untouched;
    }
    const source = parsePluginSource(entry.source);
    const root = pluginRoot(data, entry.name);
    const changed = force ? null : await editedInPlace(root, entry);
    if (changed) {
      warn(
        changed.kind === "edited"
          ? translate(
              `${entry.name}: the folder was edited in place (${changed.why}) — not touching it; add --force to replace it`,
              `${entry.name}: папку правили руками (${changed.why}) — не трогаю; заменить принудительно: --force`,
            )
          : translate(
              `${entry.name}: the folder cannot be read (${changed.why}) — not touching it; add --force to replace it`,
              `${entry.name}: папка не читается (${changed.why}) — не трогаю; заменить принудительно: --force`,
            ),
      );
      return untouched;
    }
    if (source.kind === "git") {
      const { sha } = resolveRemoteSha(git, source.url, source.ref);
      if (sha === entry.sha && existsSync(root) && !force) {
        ok(`${entry.name} is already at ${sha.slice(0, 12)}`);
        // Запись Marketplace могла запинить коммит: тогда `update` двигать нечего,
        // и владелец должен узнать, чем с пина сходят, а не решать, что команда врёт.
        if (entry.marketplace && entry.ref === entry.sha)
          ok(
            translate(
              `${entry.name} is pinned by ${entry.marketplace} — to move it: iva plugin remove ${entry.name} && iva plugin add ${entry.name}`,
              `${entry.name} запинен маркетплейсом ${entry.marketplace} — сойти с пина: iva plugin remove ${entry.name} && iva plugin add ${entry.name}`,
            ),
          );
        return untouched;
      }
    }
    const {
      entry: installed,
      report,
      undo,
    } = await install(data, state, source, entry);
    ok(
      entry.sha && installed.sha
        ? `${entry.name}: ${entry.sha.slice(0, 12)} → ${installed.sha.slice(0, 12)}`
        : `${entry.name} reinstalled from ${installed.source}`,
    );
    return {
      state: upsertPlugin(state, installed),
      undo,
      // Доверенный плагин с MCP пересобирается и без кода: его connection-файлы
      // описывают тот `mcp.json`, который только что приехал.
      code: inVersion(report, installed.trusted) && installed.enabled,
      moved: installed.sha !== entry.sha || installed.digest !== entry.digest,
    };
  }

  async function update(): Promise<void> {
    const data = dataDirAbs();
    const failed: string[] = [];
    const undone: Undo[] = [];
    const rebuilt: string[] = [];
    const moved: string[] = [];
    await locked(data, async () => {
      const state = await readPluginsState(data);
      const targets = args[0] ? [mustFind(state, args[0])] : [...state.plugins];
      if (targets.length === 0) {
        ok("no plugins to update");
        return;
      }
      let next = state;
      for (const entry of targets) {
        try {
          const done = await updateOne(data, next, entry);
          next = done.state;
          if (done.undo) undone.push(done.undo);
          if (done.code) rebuilt.push(entry.name);
          if (done.moved) moved.push(entry.name);
        } catch (error) {
          failed.push(entry.name);
          bad(`${entry.name}: ${(error as Error).message}`);
        }
      }
      // Обновление могло привезти новый MCP-сервер или сервис: порт и токен ему выдаются
      // здесь, до сборки версии и до юнитов.
      next = await grantPortsToTrusted(data, next);
      await writePluginsState(data, next);
      const cycled = await reconcileUnits(data, next, moved);
      // Новое содержимое плагина — старый процесс за неизменившимся юнитом: тело
      // юнита могло совпасть байт в байт (та же команда, тот же порт), а сервер за ним
      // приехал другой. Новый restart запрашивают только если reconcile ещё не пытался.
      restartMoved(data, next, moved, cycled);
    });
    // Одна сборка на весь прогон: версия собирается со всеми плагинами сразу, и
    // отдельная сборка на каждый стоила бы столько же рестартов, сколько плагинов.
    if (rebuilt.length) {
      const { failure } = await buildCode(rebuilt.join(", "), true);
      if (failure !== null) {
        await undoInstalls(data, undone);
        throw new Error(`nothing was updated: ${failure}`);
      }
    }
    for (const undo of undone) dropDisplaced(undo);
    if (failed.length)
      throw new Error(`could not update: ${failed.join(", ")}`);
  }

  /**
   * Повреждённый файл сначала уезжает в бэкап и только потом переписывается.
   * Порядок именно такой: `sync` восстанавливает состояние по папкам, а имена
   * папок не помнят ни источник, ни sha, ни доверие — стереть единственную копию
   * этих полей и отчитаться зелёной галочкой было бы худшим исходом из всех.
   */
  function backUpDamaged(data: string): string {
    const file = pluginsStateFile(data);
    const stamp = now().toISOString().replace(/[:.]/gu, "-");
    const backup = `${file}.corrupt-${stamp}`;
    renameSync(file, backup);
    return backup;
  }

  /** Что удалось спасти из повреждённого plugins.json и прежних его копий. */
  async function salvageState(data: string): Promise<PluginsState> {
    const file = pluginsStateFile(data);
    const directory = dirname(file);
    const backups = existsSync(directory)
      ? readdirSync(directory)
          .filter((name) => name.startsWith(`${basename(file)}.corrupt-`))
          .sort()
          .reverse()
      : [];
    for (const backup of backups) {
      const salvaged = await salvagePluginsStateFile(join(directory, backup));
      if (salvaged?.plugins.length) {
        ok(
          `recovered ${salvaged.plugins.length} plugin(s) and ${salvaged.marketplaces.length} marketplace(s) from ${backup}`,
        );
        return salvaged;
      }
    }
    warn(
      "nothing could be read out of the damaged file — rebuilding from data/custom/plugins/, so sources, refs and trust flags are lost",
    );
    return { marketplaces: [], plugins: [] };
  }

  async function sync(): Promise<void> {
    const data = dataDirAbs();
    await locked(data, async () => {
      const read = await readPluginsStateSafe(data);
      let next = read.state;
      if (read.damaged) {
        warn(read.damaged.message);
        const backup = backUpDamaged(data);
        warn(`kept the damaged file as ${basename(backup)}`);
        next = await salvageState(data);
      }

      // Папка на диске, записи нет — принимаем её обратно в plugins.json, иначе
      // `add` упрётся в существующую папку, а `update` скажет «не установлен».
      const directory = pluginsDir(data);
      const folders = existsSync(directory)
        ? readdirSync(directory, { withFileTypes: true })
            .filter(
              (entry) => entry.isDirectory() && !entry.name.startsWith("."),
            )
            .map((entry) => entry.name)
            .sort()
        : [];
      for (const name of folders) {
        if (findPlugin(next, name)) continue;
        const report = await readPlugin(join(directory, name));
        if (!report.manifest) {
          bad(`${name}: ${pluginReadProblem(report)}`);
          continue;
        }
        if (report.manifest.name !== name) {
          bad(
            `${name}: the manifest calls this plugin ${JSON.stringify(report.manifest.name)} — rename the folder or reinstall it`,
          );
          continue;
        }
        next = upsertPlugin(next, {
          name,
          source: "",
          ref: "",
          sha: "",
          digest: await pluginTreeDigest(join(directory, name)),
          enabled: true,
          trusted: false,
          installedAt: now().toISOString(),
        });
        ok(`${name} taken back into plugins.json — ${components(report)}`);
      }

      // Запись есть, папки нет — доставляем ровно запиненный sha.
      const failed: string[] = [];
      for (const entry of next.plugins) {
        if (existsSync(pluginRoot(data, entry.name))) continue;
        if (!entry.source) {
          bad(
            `${entry.name}: no source recorded — reinstall it: iva plugin add <source>`,
          );
          failed.push(entry.name);
          continue;
        }
        step(`Restoring ${entry.name} from ${entry.source}`);
        try {
          const source = parsePluginSource(entry.source);
          const pinned: PluginSource =
            source.kind === "git" && entry.sha
              ? { ...source, ref: entry.sha }
              : source;
          const { entry: installed, report } = await install(
            data,
            next,
            pinned,
            entry,
          );
          next = upsertPlugin(next, {
            ...installed,
            source: entry.source,
            ref: entry.ref,
          });
          ok(`${entry.name} restored`);
          // `sync` доставляет папки, а не собирает версии: код плагина попадёт в
          // работающую версию только следующей сборкой, и молчать об этом нельзя.
          if (report.code && installed.enabled)
            warn(
              translate(
                `${entry.name}: code is not built into the current version — run: iva update`,
                `${entry.name}: кода нет в работающей версии — запусти: iva update`,
              ),
            );
        } catch (error) {
          failed.push(entry.name);
          bad(`${entry.name}: ${(error as Error).message}`);
        }
      }

      // Плагин уже стоит — значит предупреждение о риске владелец видел; после
      // починки показывать его снова незачем.
      if (!next.riskNoticeShownAt && next.plugins.length)
        next = { ...next, riskNoticeShownAt: now().toISOString() };
      // Доверенный плагин мог приехать без портов и токенов: `sync` — это починка,
      // и она доделывает то, что делает `trust`, прежде чем сверять юниты.
      next = await grantPortsToTrusted(data, next);
      await writePluginsState(data, next);
      await reconcileUnits(data, next);
      const sourceless = next.plugins.filter((entry) => !entry.source);
      if (sourceless.length)
        warn(
          `no source recorded for ${sourceless.map((entry) => entry.name).join(", ")} — reinstall each with: iva plugin add <source>`,
        );
      if (!read.damaged && failed.length === 0)
        ok(
          translate(
            `plugins.json and data/custom/plugins/ agree (${next.plugins.length})`,
            `plugins.json и data/custom/plugins/ сходятся (${next.plugins.length})`,
          ),
        );
      if (failed.length)
        throw new Error(`could not restore: ${failed.join(", ")}`);
    });
  }

  return { add, update, remove, sync };
}
