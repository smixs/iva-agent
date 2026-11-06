// `iva plugin propose` and `iva plugin install-proposal`: the door through which the model
// asks for a plugin with code or MCP, and the half that installs it after the owner's tap.
//
// A plugin of skills alone the model installs itself (`iva plugin add`). A plugin with
// `mcp.json` or `sh.iva/` runs processes and code with this installation's keys, so the model
// only proposes it: the folder is copied into `data/plugin-proposals/<name>-<digest12>/`, and
// the owner gets a message built here — what it will run, how many files — with one button.
// The tap is taken by the Bridge (`scripts/poller/plugin-proposal-tap.ts`), which starts
// `install-proposal` in its own unit, out of the model's turn (ADR-0009). The tap marks the
// owner's intent on the regular path; it does not stop a model that already has `bash`
// (ADR-0005 step 2 is deferred).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  carriesCodeOrMcp,
  commandLines,
  fromFile,
  installButtonLabel,
  installedText,
  notInstalledText,
  PROPOSAL_CALLBACK_PREFIX,
  proposalFolder,
  proposalsDir,
  proposalText,
  proposalReadmeLines,
  staleReason,
  stagingPrefix,
  sweepProposals,
  takenDir,
} from "../lib/plugin-proposal.ts";
import { button, escapeRichText } from "../lib/telegram-buttons.ts";
import {
  pluginReadProblem,
  type PluginCliContext,
} from "./plugin-cli-context.ts";
import type { createPluginTrustCommands } from "./plugin-cli-trust.ts";

// `telegram-send.ts` reaches the authored tree through the Outbox, so it is a type here and
// loaded inside the send (scripts/authored-tree-guard.test.ts).
type TelegramSend = typeof import("../lib/telegram-send.ts");
export type ProposalSends = {
  readonly screen?: TelegramSend["sendTelegramScreen"];
  readonly text?: TelegramSend["sendTelegramHtml"];
};

const DIGEST12 = /^[a-f0-9]{12}$/u;

/**
 * Переложить копию на её место. `false` — то же содержимое уже предложено (гонка двух
 * propose или повтор): папка переиспользуется, кнопка та же. Другой отказ — наружу.
 */
function claimFolder(staging: string, target: string): boolean {
  try {
    renameSync(staging, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPluginProposalCommands(
  context: PluginCliContext,
  trust: ReturnType<typeof createPluginTrustCommands>,
  sends: ProposalSends = {},
) {
  const { runtime, core, args, translate, now, absolute } = context;
  const { ok, bad, readEnv, dataDirAbs } = runtime;
  const { readPlugin, pluginTreeDigest, walkPluginTree } = core.reader;
  const { findPlugin, readPluginsState } = core.store;

  /** Бот и личный чат владельца: первый id из Allowlist, не notificationChat(). */
  function ownerChat(): { readonly token: string; readonly chat: string } {
    const env = readEnv();
    const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token)
      throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");
    const chat =
      String(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
        .split(/[,\s]+/u)
        .find(Boolean) ?? "";
    if (!chat)
      throw new Error("TELEGRAM_ALLOWED_USER_IDS is empty — run: iva config");
    return { token, chat };
  }

  async function screenSender() {
    return (
      sends.screen ??
      (await import("../lib/telegram-send.ts")).sendTelegramScreen
    );
  }

  async function textSender() {
    return (
      sends.text ?? (await import("../lib/telegram-send.ts")).sendTelegramHtml
    );
  }

  async function propose(): Promise<void> {
    const raw = args[0];
    if (!raw)
      throw new Error(
        "iva plugin propose <folder> — a plugin folder with mcp.json or sh.iva/",
      );
    const source = absolute({ kind: "local", path: raw });
    const folder = source.kind === "local" ? source.path : raw;
    const owner = ownerChat();
    const data = dataDirAbs();
    const dir = proposalsDir(data);
    mkdirSync(dir, { recursive: true });
    sweepProposals(dir, now().getTime());
    // Копия, а не исходник: владелец видит состав той папки, которую потом и поставят.
    const staging = mkdtempSync(stagingPrefix(dir));
    try {
      await core.install.copyPluginTree(folder, staging);
      const report = await readPlugin(staging);
      if (!report.manifest) {
        for (const line of report.diagnostics) bad(line);
        throw new Error(`${raw} is not a usable Agent Plugins folder`);
      }
      const name = report.manifest.name;
      await context.checkDescriptions(report);
      // Черновик, у которого читатель что-то выбросил, владельцу не уходит: после тапа он
      // встал бы без этой части. Строки возвращаются модели — она чинит и зовёт propose снова.
      if (report.diagnostics.length > 0) {
        for (const line of report.diagnostics) bad(line);
        throw new Error(
          `${name}: fix the draft and run iva plugin propose again — the lines above name what would not work`,
        );
      }
      if (!carriesCodeOrMcp(staging))
        throw new Error(
          translate(
            `${name} has neither mcp.json nor sh.iva/ — it installs through iva plugin add`,
            `у ${name} нет ни mcp.json, ни sh.iva/ — ставится через iva plugin add`,
          ),
        );
      if (findPlugin(await readPluginsState(data), name))
        throw new Error(
          `${name} is already installed — an update is iva plugin update ${name} in the owner's terminal`,
        );
      const digest12 = (await pluginTreeDigest(staging)).slice(0, 12);
      const files = (await walkPluginTree(staging)).length;
      const target = join(dir, proposalFolder(name, digest12));
      const created = claimFolder(staging, target);
      const stamp = now();
      utimesSync(target, stamp, stamp);
      writeFileSync(fromFile(dir, digest12), folder);
      const commands = commandLines(translate, {
        commands: trust.processCommands(report).concat(remoteServers(report)),
        code: report.code,
      }).map(escapeRichText);
      const text = [
        proposalText(translate, escapeRichText(name), commands, files),
        ...(await proposalReadmeLines(translate, target)),
        button(
          installButtonLabel(translate),
          `${PROPOSAL_CALLBACK_PREFIX}${digest12}`,
          "success",
        ),
      ].join("\n\n");
      const sent = await (await screenSender())(owner.token, owner.chat, text);
      if (!sent.ok) {
        if (created) {
          rmSync(target, { recursive: true, force: true });
          rmSync(fromFile(dir, digest12), { force: true });
        }
        throw new Error(`Telegram send failed: ${sent.error}`);
      }
      ok(
        `proposal ${name} (${digest12}) sent to the owner — the result arrives as a message after the tap`,
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Удалённые MCP-серверы процессов не запускают, но владелец видит, куда плагин ходит. */
  function remoteServers(
    report: Awaited<ReturnType<typeof readPlugin>>,
  ): string[] {
    const lines: string[] = [];
    for (const [server, declared] of Object.entries(report.mcp))
      if (declared.type !== "stdio")
        lines.push(`mcp ${server}: ${declared.url}`);
    return lines;
  }

  /**
   * Установка забранного тапом предложения: один `add <копия> --trust`, итог владельцу
   * сообщением, копия удаляется. Процесс живёт в своём юните и переживает перезапуск моста.
   * Первая сверка хеша здесь — быстрый отказ; решающая — у копии в staging установщика
   * (`addFolder` получает хеш из кнопки): ставятся только те байты, что с ним совпали.
   */
  async function installProposal(
    addFolder: (
      path: string,
      digest12: string,
      source: string,
    ) => Promise<void>,
  ): Promise<void> {
    const digest12 = args[0] ?? "";
    if (!DIGEST12.test(digest12))
      throw new Error("iva plugin install-proposal <digest12>");
    const owner = ownerChat();
    const dir = proposalsDir(dataDirAbs());
    const taken = takenDir(dir, digest12);
    const from = fromFile(dir, digest12);
    let name = digest12;
    let failure: string | null = null;
    try {
      const report = await readPlugin(taken);
      if (!report.manifest) throw new Error(pluginReadProblem(report));
      name = report.manifest.name;
      if ((await pluginTreeDigest(taken)).slice(0, 12) !== digest12)
        throw new Error(staleReason(translate));
      // Источник в plugins.json — папка черновика, а не эта копия: копию сейчас удалим.
      await addFolder(taken, digest12, readFileSync(from, "utf8"));
    } catch (error) {
      failure = errorText(error);
    }
    rmSync(taken, { recursive: true, force: true });
    rmSync(from, { force: true });
    const text =
      failure === null
        ? installedText(translate, name)
        : notInstalledText(translate, name, failure);
    const sent = await (
      await textSender()
    )(owner.token, owner.chat, text, {
      retryTransient: true,
    });
    if (!sent.ok) bad(`Telegram send failed: ${sent.error}`);
    if (failure !== null) throw new Error(failure);
  }

  return { propose, installProposal };
}
