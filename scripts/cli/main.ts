import { createAccountCommands } from "./account.ts";
import { createConfigCommand } from "./config.ts";
import { createDiagnoseCommand } from "./diagnose.ts";
import { createJobsCommand } from "./jobs.ts";
import { createDoctorCommand } from "./doctor.ts";
import { createNotifyCommand } from "./notify.ts";
import { createPluginCommands } from "./plugin.ts";
import { createPostCommand } from "./post.ts";
import { createProactiveCommand } from "./proactive.ts";
import { createRemindCommand } from "./remind.ts";
import { createSignalCommand } from "./signal.ts";
import { createCliRuntime } from "./runtime.ts";
import { createServiceCommands } from "./services.ts";
import { createCliSystemd } from "./systemd.ts";
import { createTraceCommands } from "./trace.ts";
import { createTreeRenderer } from "./tree.ts";
import { createUserbotCommands, reinstallUserbot } from "./userbot.ts";
import { createVersionUpdateCommand } from "./version-update-command.ts";
import { setBeta } from "../lib/update-channel.ts";

export type CliCommand = (args: readonly string[]) => unknown;

type DispatchDependencies = {
  readonly bad: (message: string) => void;
  readonly help: () => void;
  readonly exit?: (code: number) => never;
};

/** Dispatch one CLI invocation while preserving the legacy sync-throw boundary. */
export function dispatchCli(
  argv: readonly string[],
  commands: Readonly<Record<string, CliCommand>>,
  {
    bad,
    help,
    exit = (code): never => process.exit(code),
  }: DispatchDependencies,
): Promise<unknown> {
  const [commandName, ...rest] = argv;
  // Только собственные ключи: `commands["constructor"]` находил Object из прототипа,
  // и `iva constructor` молча завершался кодом 0, будто команда сработала.
  const command =
    commandName && Object.hasOwn(commands, commandName)
      ? commands[commandName]
      : undefined;
  if (!command) {
    if (commandName) bad(`Unknown command: ${commandName}`);
    help();
    return exit(commandName ? 1 : 0);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    help();
    return exit(0);
  }
  return Promise.resolve(command(rest)).catch((error: unknown) => {
    const message =
      (error as { readonly message?: string } | null | undefined)?.message ||
      String(error);
    bad(message);
    exit(1);
  });
}

/** iva beta / iva stable: включают и выключают бета-обновления; обновляет iva update. */
function betaCommands(
  root: string,
  runtime: ReturnType<typeof createCliRuntime>,
) {
  const switchTo = (on: boolean): void => {
    const refusal = {
      ok: "",
      "no-repo": "no git repository here: the setting was not recorded",
      unchanged:
        "the update setting was not written: git config is held by another process (or not writable); nothing changed, try again",
      partial: `the update setting may be partly written: git config is held by another process (or not writable); run iva ${on ? "beta" : "stable"} again`,
    }[setBeta(root, on)];
    if (refusal) throw new Error(refusal);
    const language =
      runtime.readEnv().AGENT_LANGUAGE || process.env.AGENT_LANGUAGE;
    const ru = language === "ru";
    const name = ru ? (on ? "бета" : "стабильные") : on ? "beta" : "stable";
    console.log(
      ru
        ? `Обновления: ${name}. Обновиться: iva update`
        : `Updates: ${name}. To update: iva update`,
    );
  };
  // Промис, а не синхронный throw: отказ уходит в .catch диспетчера одной строкой
  // «✗ …», а не стеком Node.
  const command = (on: boolean) => (): Promise<void> =>
    Promise.resolve().then(() => switchTo(on));
  return { beta: command(true), stable: command(false) };
}

/** `iva help`: every command in one screen. */
function printHelp(C: ReturnType<typeof createCliRuntime>["C"]): void {
  console.log(`
${C.b}Iva CLI${C.x} — manage your personal agent

${C.b}Commands:${C.x}
  ${C.c}iva update${C.x}         update: git pull + build + restart
  ${C.c}iva beta${C.x} / ${C.c}stable${C.x}   updates: every accepted change (beta) / releases only
  ${C.c}iva config${C.x}         configure: model, Telegram, Deepgram, TZ, vault
  ${C.c}iva login${C.x} [--browser]  sign in to an OpenAI subscription (ChatGPT) for MODEL_PROVIDER=codex
  ${C.c}iva rollback${C.x}       go back to the previous version (symlink flip + restart)
  ${C.c}iva doctor${C.x}         diagnose and safely auto-repair the install
  ${C.c}iva diagnose${C.x} [--turn <session>/<turn>]  collect one package of evidence for a bug report (no secrets)
  ${C.c}iva plugin${C.x} <cmd>     plugins: add|list|update|enable|disable|remove|sync|marketplace
  ${C.c}iva status${C.x}         status of services and nightly timers
  ${C.c}iva restart${C.x}        restart the agent and Telegram bridge
  ${C.c}iva reset${C.x}          full reset: clear stuck workflows and restart
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    start / stop
  ${C.c}iva usage${C.x} [win]      token usage (last|today|week|month|by-model|by-source|tail)
  ${C.c}iva trace${C.x} <cmd>      the turn journal: tail|show [<session>/<turn>|last]|open
  ${C.c}iva notify${C.x} <text>    send one Telegram message verbatim
  ${C.c}iva jobs ack${C.x} <name>  close an open schedule failure
  ${C.c}iva jobs skip memory-night${C.x} <date>  close a night-memory day without processing it
  ${C.c}iva remind${C.x} <text>    let the agent judge one Reminder, then send it to Telegram
  ${C.c}iva proactive${C.x} show|on|off|set <key> <value>  Watch, Brief and Insight settings
  ${C.c}iva signal${C.x} <source> <text>  pass a plugin's Signal to Iva (a one-off Reminder now)
  ${C.c}iva post${C.x} --md-file <p>  rich Telegram post to the digest chat or an allowlisted --chat
  ${C.c}iva userbot${C.x} [creds|setup|status|diagnose --json|off]  personal-account userbot proxy
  ${C.c}iva logs${C.x} [poll]     agent logs (or the Telegram bridge) -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes; update --verbose — show technical output${C.x}
`);
}

/** Compose the CLI command groups without executing a command. */
export function createCliMain(root: string) {
  const runtime = createCliRuntime(root);
  const { C, SERVICES, TIMERS, bad, ok } = runtime;
  const systemdLifecycle = createCliSystemd(runtime);
  const tree = createTreeRenderer(root);
  const userbot = createUserbotCommands(runtime, systemdLifecycle);
  const account = createAccountCommands(runtime, systemdLifecycle);
  const services = createServiceCommands(runtime, systemdLifecycle, {
    recoverUserbot: () =>
      reinstallUserbot(runtime, systemdLifecycle, runtime.warn, {
        keepHealthy: true,
      }),
  });
  const cmdConfig = createConfigCommand(runtime, systemdLifecycle);
  const cmdDoctor = createDoctorCommand(runtime, systemdLifecycle);
  const cmdDiagnose = createDiagnoseCommand(runtime, systemdLifecycle);
  const trace = createTraceCommands(runtime);
  const cmdNotify = createNotifyCommand(runtime);
  const cmdJobs = createJobsCommand(runtime);
  const cmdRemind = createRemindCommand(runtime);
  const cmdPost = createPostCommand(runtime);
  const cmdProactive = createProactiveCommand(runtime);
  const cmdSignal = createSignalCommand(runtime);
  const versionUpdate = createVersionUpdateCommand(runtime, systemdLifecycle);
  // The code of a plugin is built into a version, on exactly the updater's rails
  // (ADR-0009), so `iva plugin` is handed the updater's own rebuild instead of a
  // second path to the same probe, flip and restart.
  const plugin = createPluginCommands(runtime, {
    buildVersion: versionUpdate.rebuild,
  });

  const cmdHelp = (): void => printHelp(C);

  const commands: Readonly<Record<string, CliCommand>> = {
    update: versionUpdate.run,
    ...betaCommands(root, runtime),
    rollback: versionUpdate.rollback,
    userbot: userbot.cmdUserbot,
    config: cmdConfig,
    login: account.cmdLogin,
    doctor: cmdDoctor,
    diagnose: cmdDiagnose,
    plugin: plugin.cmdPlugin,
    trace: trace.cmdTrace,
    status: services.cmdStatus,
    restart: services.cmdRestart,
    reset: services.cmdReset,
    usage: account.cmdUsage,
    notify: cmdNotify,
    remind: cmdRemind,
    jobs: cmdJobs,
    post: cmdPost,
    proactive: cmdProactive,
    signal: cmdSignal,
    start: services.cmdStart,
    stop: services.cmdStop,
    logs: services.cmdLogs,
    uninstall: account.cmdUninstall,
    version: account.cmdVersion,
    tree: tree.showTree,
    help: cmdHelp,
    "--help": cmdHelp,
    "-h": cmdHelp,
    "_install-units": () =>
      ok(`systemd units written: ${systemdLifecycle.writeUnits().length}`),
    "_activate-units": () => {
      systemdLifecycle.activateUnits();
      ok(
        `systemd units enabled and active: ${SERVICES.length + TIMERS.length}`,
      );
    },
    "_await-healthy": services.cmdAwaitHealthy,
  };

  return {
    commands,
    cmdHelp,
    dispatch: (argv: readonly string[]) =>
      dispatchCli(argv, commands, { bad, help: cmdHelp }),
  };
}

export function main(
  root: string,
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return createCliMain(root).dispatch(argv);
}
