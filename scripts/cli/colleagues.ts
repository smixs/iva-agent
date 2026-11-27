// `iva colleague show | on | off | hire <role> [name] [username] | set <bot_id> <role> [provider] [model] | model <bot_id> <provider> <model> | remove <bot_id>`
// Управление опцией коллег, наймом по ссылке, их ролями и моделями со стороны владельца (ADR-0030).
// Импорты из authored tree — ленивые: CLI обязан грузиться и без agent/ (authored-tree-guard.test.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

const USAGE =
  "usage: iva colleague show | on | off | hire <role> [name] [username] | set <bot_id> <role> [provider] [model] | model <bot_id> <provider> <model> | remove <bot_id>";

export function createColleagueCommand(
  runtime: Pick<CliRuntime, "ok" | "dataDirAbs" | "readEnv"> &
    Partial<Pick<CliRuntime, "ENV_PATH">>,
) {
  const { ok, dataDirAbs, readEnv, ENV_PATH } = runtime;

  async function show(settingsFile: string): Promise<void> {
    const { readSettings } = await import("#lib/settings.ts");
    const { COLLEAGUE_ROLE_SPECS, parseColleaguesConfig } =
      await import("#lib/colleagues.ts");
    const config = parseColleaguesConfig(readSettings(settingsFile), () => {});
    console.log(`enabled: ${config.enabled ? "on" : "off"}`);
    const entries = Object.values(config.items);
    if (entries.length === 0) {
      console.log("colleagues: none");
      return;
    }
    for (const entry of entries) {
      const label = entry.name ?? COLLEAGUE_ROLE_SPECS[entry.role].labelRu;
      console.log(
        `${entry.botId}: ${label} (${entry.role}) -> ${entry.provider}/${entry.model}`,
      );
    }
  }

  async function setEnabled(
    settingsFile: string,
    enabled: boolean,
  ): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const { withColleaguesEnabled } = await import("#lib/colleagues.ts");
    updateSettings(
      (current) => withColleaguesEnabled(current, enabled),
      settingsFile,
    );
    ok(`colleagues: ${enabled ? "on" : "off"}`);
  }

  async function configure(
    settingsFile: string,
    env: NodeJS.ProcessEnv,
    botId: string,
    rawRole: string,
    rawProvider?: string,
    rawModel?: string,
  ): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const {
      COLLEAGUE_ROLES,
      isModelProviderName,
      parseColleagueRole,
      recommendedModelForProvider,
      suggestColleagueModel,
      withColleague,
    } = await import("#lib/colleagues.ts");
    const { MODEL_PROVIDER_NAMES } = await import("#lib/model-provider.ts");
    const role = parseColleagueRole(rawRole);
    if (!role) {
      throw new Error(
        `Invalid colleague role ${JSON.stringify(rawRole)}; expected one of: ${COLLEAGUE_ROLES.join(", ")}`,
      );
    }
    const suggestion = suggestColleagueModel(role, env);
    const provider =
      rawProvider === undefined ? suggestion.provider : rawProvider.trim();
    if (!isModelProviderName(provider)) {
      throw new Error(
        `Invalid provider ${JSON.stringify(provider)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")}`,
      );
    }
    const model =
      rawModel?.trim() ||
      recommendedModelForProvider(role, provider, env) ||
      "";
    if (!model) {
      throw new Error(`Provider ${provider} requires an explicit model name`);
    }
    updateSettings(
      (current) =>
        withColleague(current, {
          botId: botId.trim(),
          role,
          provider,
          model,
        }),
      settingsFile,
    );
    ok(`colleague ${botId.trim()}: ${role} -> ${provider}/${model}`);
  }

  async function setModel(
    settingsFile: string,
    botId: string,
    rawProvider: string,
    rawModel: string,
  ): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const { isModelProviderName, withColleagueModel } =
      await import("#lib/colleagues.ts");
    const { MODEL_PROVIDER_NAMES } = await import("#lib/model-provider.ts");
    const provider = rawProvider.trim();
    if (!isModelProviderName(provider)) {
      throw new Error(
        `Invalid provider ${JSON.stringify(provider)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")}`,
      );
    }
    updateSettings(
      (current) =>
        withColleagueModel(current, botId.trim(), provider, rawModel.trim()),
      settingsFile,
    );
    ok(`colleague ${botId.trim()} model: ${provider}/${rawModel.trim()}`);
  }

  async function hire(
    settingsFile: string,
    env: NodeJS.ProcessEnv,
    rawRole: string,
    rawName?: string,
    rawUsername?: string,
  ): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const {
      COLLEAGUE_ROLES,
      buildColleagueHireLink,
      parseColleagueRole,
      suggestColleagueModel,
      withColleagueHireProposal,
    } = await import("#lib/colleagues.ts");
    const role = parseColleagueRole(rawRole);
    if (!role) {
      throw new Error(
        `Invalid colleague role ${JSON.stringify(rawRole)}; expected one of: ${COLLEAGUE_ROLES.join(", ")}`,
      );
    }
    const lang =
      (env.AGENT_LANGUAGE ?? "ru").trim().toLowerCase() === "en" ? "en" : "ru";
    const link = buildColleagueHireLink({
      managerBotUsername: env.TELEGRAM_BOT_USERNAME ?? "",
      role,
      name: rawName,
      username: rawUsername,
      lang,
    });
    const suggestion = suggestColleagueModel(role, env);
    updateSettings(
      (current) =>
        withColleagueHireProposal(current, {
          botUsername: link.botUsername,
          role,
          provider: suggestion.provider,
          model: suggestion.model,
          name: link.displayName,
        }),
      settingsFile,
    );
    console.log(link.url);
    ok(
      `colleague hire link ready: ${link.displayName} (@${link.botUsername}, ${role} -> ${suggestion.provider}/${suggestion.model})`,
    );
  }

  async function remove(
    settingsFile: string,
    env: NodeJS.ProcessEnv,
    botId: string,
  ): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const { withoutColleague } = await import("#lib/colleagues.ts");
    const trimmed = botId.trim();
    updateSettings(
      (current) => withoutColleague(current, trimmed),
      settingsFile,
    );
    // Снимаем токен удалённого коллеги из `.env`, чтобы старый токен не продолжал опрос
    // на модели Ивы (заметка арбитра T909 D1393 п.B).
    if (ENV_PATH && existsSync(ENV_PATH)) {
      const { readEnvValues, upsertEnv } = await import("../lib/env-file.ts");
      const { botIdFromToken, removeColleagueBotToken } =
        await import("../../packages/telegram-bots/index.ts");
      const fromFile = await readEnvValues(ENV_PATH);
      if (fromFile.TELEGRAM_COLLEAGUE_BOT_TOKENS) {
        const primaryId = botIdFromToken(
          fromFile.TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN,
        );
        const nextTokens = removeColleagueBotToken(
          fromFile.TELEGRAM_COLLEAGUE_BOT_TOKENS,
          trimmed,
          primaryId,
        );
        if (nextTokens !== fromFile.TELEGRAM_COLLEAGUE_BOT_TOKENS.trim()) {
          await upsertEnv(ENV_PATH, {
            TELEGRAM_COLLEAGUE_BOT_TOKENS:
              nextTokens.length > 0 ? nextTokens : null,
          });
        }
      }
    }
    ok(`colleague ${trimmed} removed`);
  }

  return async function cmdColleague(args: readonly string[]): Promise<void> {
    const [subcommand, a, b, c, d, ...rest] = args;
    const env = readEnv();
    const settingsFile = join(dataDirAbs(env), "settings.json");

    if ((subcommand === "show" || subcommand === "list") && a === undefined) {
      return show(settingsFile);
    }
    if ((subcommand === "on" || subcommand === "off") && a === undefined) {
      return setEnabled(settingsFile, subcommand === "on");
    }
    if (subcommand === "hire" && a && d === undefined && rest.length === 0) {
      return hire(settingsFile, env, a, b, c);
    }
    if (subcommand === "set" && a && b && rest.length === 0) {
      return configure(settingsFile, env, a, b, c, d);
    }
    if (subcommand === "model" && a && b && c && d === undefined) {
      return setModel(settingsFile, a, b, c);
    }
    if (subcommand === "remove" && a && b === undefined) {
      return remove(settingsFile, env, a);
    }
    throw new Error(USAGE);
  };
}
