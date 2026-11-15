// `iva plugin` — the way to install, remove and inspect plugins.
//
// A plugin with code or MCP is code in the agent's process with the installation's
// tokens, so it is installed from the owner's terminal or by the owner's tap (ADR-0009):
// without a terminal `add` refuses it, and the model asks with `propose` instead
// (`plugin-cli-proposal.ts`). There is no model tool and no Telegram command by design.
//
// A plugin that only ships skills needs no build and no restart: the live resolver
// (agent/lib/custom-skills.ts) re-reads `data/custom/plugins/` on every turn. A plugin
// that carries code is built into a version instead - the same rails as `iva update`,
// down to the probe, the flip and the restart (ADR-0009) - so installing one takes as
// long as an update, and a build that fails undoes the install rather than the box.
// MCP servers and the services a plugin declares are processes on the machine, so they
// wait for a second switch: `trusted`. `add` prints the commands it would start and asks
// once; `trust`/`untrust` answer the same question later. Without trust a plugin still
// gives its skills - only nothing runs and nothing calls out.
//
// This file is the dispatcher: the help, the list, and the wiring of the three command
// groups around one shared context (`plugin-cli-context.ts`) —
//   plugin-cli-install.ts      add, update, remove, sync
//   plugin-cli-trust.ts        trust, untrust, enable, disable and the units that follow
//   plugin-cli-marketplace.ts  the lists plugins are installed by name from
//
// Everything that lives in the authored tree comes through `loadPluginCore()`,
// never a static import: `iva` has to start on an installation whose `agent/` is
// missing (ADR-0003, scripts/authored-tree-guard.test.ts).
import { existsSync } from "node:fs";
import type { PluginMode } from "#lib/plugin-store.ts";
import { createLazyTranslate, type Translate } from "../lib/cli-translate.ts";
import { DEFAULT_MARKETPLACE } from "../lib/marketplace.ts";
import { tryLoadPluginCore, type PluginCore } from "../lib/plugin-core.ts";
import {
  createPluginCliContext,
  leftoverPluginDirs,
} from "./plugin-cli-context.ts";
import { createPluginInstallCommands } from "./plugin-cli-install.ts";
import { createPluginMarketplaceCommands } from "./plugin-cli-marketplace.ts";
import {
  createPluginProposalCommands,
  type ProposalSends,
} from "./plugin-cli-proposal.ts";
import { createPluginTrustCommands } from "./plugin-cli-trust.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { PluginVersionBuild } from "./version-update-command.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type PluginDependencies = {
  readonly now?: () => Date;
  readonly log?: (...args: unknown[]) => void;
  /** Where a relative local source is resolved from: the owner's shell, not ROOT. */
  readonly cwd?: () => string;
  readonly translate?: Translate;
  /**
   * Build and install a version carrying today's plugins, on the updater's rails
   * (`iva update`'s own `rebuild`). Absent means nobody can build one here, and a
   * plugin with code is installed with its code left out and said so.
   */
  readonly buildVersion?: (options: {
    readonly requirePlugins: boolean;
  }) => Promise<PluginVersionBuild>;
  /**
   * Is a person at this terminal. Without one, `add` refuses a plugin with code or MCP and
   * names `iva plugin propose`: that is how the model's `bash` reaches it (ADR-0009).
   */
  readonly interactive?: () => boolean;
  /** Telegram sends of `propose` and `install-proposal`. */
  readonly sends?: ProposalSends;
};

/** Режим плагина словами владельца: два тумблера, как он их и переключает. */
const MODE_FLAGS: Record<PluginMode, string> = {
  full: "enabled · trusted",
  "no-processes": "enabled · untrusted",
  paused: "disabled · trusted",
  off: "disabled · untrusted",
};

export function createPluginCommands(
  runtime: CliRuntime,
  dependencies: PluginDependencies = {},
) {
  const { C, warn, bad, cap, childEnv, dataDirAbs } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const buildVersion = dependencies.buildVersion;
  const interactive =
    dependencies.interactive ?? (() => process.stdin.isTTY === true);
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  // `GIT_TERMINAL_PROMPT=0` только здесь, для плагинов и Marketplace: приватный или
  // отсутствующий репозиторий (а дефолтного `smixs/iva-plugins` ещё нет) иначе
  // спросит логин в терминале и будет ждать — держа при этом лок апдейта. Ответ
  // «репозиторий недоступен» приходит сразу, и команда объясняет его фразой.
  // `iva update` этой правкой не тронут: там приглашение как раз уместно.
  const git = (args: readonly string[], dir?: string) =>
    cap("git", args, {
      ...(dir ? { cwd: dir } : {}),
      env: { ...childEnv, GIT_TERMINAL_PROMPT: "0" },
    });

  // Английский, пока язык не спрошен: таблица переводов тоже живёт в authored tree,
  // а помощь команда обязана печатать и без него.
  const { tr: translate, resolve: resolveTranslate } = createLazyTranslate(
    dependencies.translate,
  );

  function help(): void {
    log(`
${C.b}iva plugin${C.x} — ${translate("install and manage plugins", "установка плагинов и уход за ними")}

  ${C.c}iva plugin add${C.x} <name|source> [--trust]   ${translate("install by name from a Marketplace, or from a folder, owner/repo[/subdir][@ref], https:// or git@", "поставить по имени из Marketplace или из папки, owner/repo[/подпапка][@ref], https:// или git@")}
  ${C.c}iva plugin list${C.x} [--available]  ${translate("what is installed; --available: what the marketplaces offer", "что стоит; --available: что предлагают маркетплейсы")}
  ${C.c}iva plugin update${C.x} [name] [--force]  ${translate("pull the tracked ref, printing old → new", "подтянуть отслеживаемый ref, печатая old → new")}
  ${C.c}iva plugin enable${C.x} <name>  ${translate("turn the plugin back on", "включить плагин обратно")}
  ${C.c}iva plugin disable${C.x} <name> ${translate("turn the plugin off without removing it", "выключить плагин, не удаляя")}
  ${C.c}iva plugin trust${C.x} <name>   ${translate("let its MCP servers and services run on this machine", "разрешить запускать его MCP-серверы и сервисы на этой машине")}
  ${C.c}iva plugin untrust${C.x} <name> ${translate("stop and remove them; the plugin stays installed", "погасить и снять их; сам плагин остаётся")}
  ${C.c}iva plugin remove${C.x} <name>  ${translate("remove the plugin; its data is kept", "удалить плагин; данные плагина остаются")}
  ${C.c}iva plugin sync${C.x}           ${translate("repair: rebuild plugins.json and reinstall what is missing", "починка: пересобрать plugins.json и доставить недостающее")}
  ${C.c}iva plugin marketplace${C.x} add <source> | remove <name> | list  ${translate("lists of plugins to install by name", "списки плагинов, которые ставятся по имени")}
  ${C.c}iva plugin propose${C.x} <folder> ${translate("ask the owner in Telegram to install a plugin with code or MCP", "попросить владельца в Telegram поставить плагин с кодом или MCP")}

  ${C.d}${translate("Skills of an installed plugin work from the next turn: no build, no restart.", "Скиллы поставленного плагина работают со следующего хода: без сборки и рестарта.")}${C.x}
  ${C.d}${translate(`Marketplace by default: ${DEFAULT_MARKETPLACE}.`, `Marketplace по умолчанию: ${DEFAULT_MARKETPLACE}.`)}${C.x}
  ${C.d}${translate("A plugin with code in sh.iva/ is built into a version: that takes a build and a restart.", "Плагин с кодом в sh.iva/ собирается в версию: это сборка и рестарт.")}${C.x}
  ${C.d}${translate("MCP servers and services of a plugin run only once it is trusted.", "MCP-серверы и сервисы плагина работают только у доверенного плагина.")}${C.x}
`);
  }

  function commandsFor(core: PluginCore, argv: readonly string[]) {
    const context = createPluginCliContext({
      runtime,
      core,
      argv,
      git,
      translate,
      now,
      cwd,
      log,
      interactive,
      ...(buildVersion ? { buildVersion } : {}),
    });
    const marketplace = createPluginMarketplaceCommands(context);
    const trust = createPluginTrustCommands(context);
    const install = createPluginInstallCommands(context, {
      marketplace,
      trust,
    });
    const proposal = createPluginProposalCommands(
      context,
      trust,
      dependencies.sends,
    );
    return { context, marketplace, trust, install, proposal };
  }

  async function run(
    core: PluginCore,
    sub: string,
    argv: readonly string[],
  ): Promise<void> {
    const { context, marketplace, trust, install } = commandsFor(core, argv);
    const { components } = context;
    const { readPlugin } = core.reader;
    const { pluginMode, pluginRoot, pluginsDir, readPluginsState } = core.store;
    const { available } = marketplace;

    /** Что стоит: состав, флаги, источник — и недоделки, если они остались. */
    async function list(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      if (argv.includes("--available")) return available(data, state);
      for (const name of leftoverPluginDirs(pluginsDir(data)))
        warn(
          `${name} is a leftover of an interrupted install — iva plugin sync`,
        );
      if (state.plugins.length === 0) {
        log(
          translate(
            "No plugins installed. Add one: iva plugin add <source>",
            "Плагинов нет. Поставить: iva plugin add <источник>",
          ),
        );
        return;
      }
      for (const entry of state.plugins) {
        const root = pluginRoot(data, entry.name);
        const flags = MODE_FLAGS[pluginMode(entry)];
        if (!existsSync(root)) {
          bad(
            `${entry.name}  ${flags}  ${translate("missing — run: iva plugin sync", "папки нет — запусти: iva plugin sync")}`,
          );
          continue;
        }
        const report = await readPlugin(root);
        const sha = entry.sha ? entry.sha.slice(0, 12) : "local";
        const version = report.manifest?.version ?? "-";
        log(
          `${C.b}${entry.name}${C.x}  ${version}  ${sha}  ${flags}  ${components(report)}`,
        );
        // Отслеживаемый ref дописывается только когда его не видно в самой строке
        // источника: у запиненной записи Marketplace это был бы тот же sha дважды.
        const tracked =
          entry.ref && !entry.source.endsWith(`@${entry.ref}`)
            ? ` @${entry.ref}`
            : "";
        log(
          `  ${C.d}${entry.source || translate("no source recorded", "источник не записан")}${tracked}${entry.marketplace ? ` · via ${entry.marketplace}` : ""}${C.x}`,
        );
        for (const line of report.diagnostics) warn(`  ${line}`);
      }
    }

    switch (sub) {
      case "add":
        return install.add();
      case "list":
        return list();
      case "remove":
        return install.remove();
      case "enable":
        return trust.toggle(true);
      case "disable":
        return trust.toggle(false);
      case "trust":
        return trust.setTrusted(true);
      case "untrust":
        return trust.setTrusted(false);
      case "update":
        return install.update();
      case "sync":
        return install.sync();
      case "marketplace":
        return marketplace.cmdMarketplace();
      default:
        throw new Error(
          `unknown: iva plugin ${sub} — add, list, update, enable, disable, trust, untrust, remove, sync, marketplace, propose`,
        );
    }
  }

  async function cmdPlugin(args: readonly string[]): Promise<void> {
    const [sub, ...rest] = args;
    await resolveTranslate();
    if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h")
      return help();
    const core = await tryLoadPluginCore();
    if (!core)
      throw new Error(
        "plugins are not available: the agent tree is missing — run: iva update",
      );
    if (sub === "propose" || sub === "install-proposal")
      return runProposal(core, sub, rest);
    return run(core, sub, rest);
  }

  async function runProposal(
    core: PluginCore,
    sub: "propose" | "install-proposal",
    argv: readonly string[],
  ): Promise<void> {
    const { proposal } = commandsFor(core, argv);
    if (sub === "propose") return proposal.propose();
    // Только из Bridge, по тапу владельца: `add` копии одним вызовом, с доверием.
    return proposal.installProposal((folder, digest12, source) =>
      commandsFor(core, [folder, "--trust"]).install.add({
        fromProposal: true,
        expectDigest12: digest12,
        source,
      }),
    );
  }

  return { cmdPlugin };
}
