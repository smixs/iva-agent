// `iva colleague show | on | off | set <bot_id> <role> [provider] [model] | model <bot_id> <provider> <model> | remove <bot_id>`
// Управление опцией коллег, их ролями и моделями со стороны владельца (ADR-0030).
// Импорты из authored tree — ленивые: CLI обязан грузиться и без agent/ (authored-tree-guard.test.ts).
import { join } from "node:path";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

const USAGE =
  "usage: iva colleague show | on | off | set <bot_id> <role> [provider] [model] | model <bot_id> <provider> <model> | remove <bot_id>";

export function createColleagueCommand(
  runtime: Pick<CliRuntime, "ok" | "dataDirAbs" | "readEnv">,
) {
  const { ok, dataDirAbs, readEnv } = runtime;

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

  async function remove(settingsFile: string, botId: string): Promise<void> {
    const { updateSettings } = await import("#lib/settings.ts");
    const { withoutColleague } = await import("#lib/colleagues.ts");
    updateSettings(
      (current) => withoutColleague(current, botId.trim()),
      settingsFile,
    );
    ok(`colleague ${botId.trim()} removed`);
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
    if (subcommand === "set" && a && b && rest.length === 0) {
      return configure(settingsFile, env, a, b, c, d);
    }
    if (subcommand === "model" && a && b && c && d === undefined) {
      return setModel(settingsFile, a, b, c);
    }
    if (subcommand === "remove" && a && b === undefined) {
      return remove(settingsFile, a);
    }
    throw new Error(USAGE);
  };
}
