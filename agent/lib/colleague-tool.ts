import { z } from "zod";
import {
  configuredTelegramBots,
  validTelegramBotId,
} from "../../packages/telegram-bots/index.ts";
import {
  COLLEAGUE_ROLES,
  COLLEAGUE_ROLE_SPECS,
  currentSettingsFile,
  isColleagueRole,
  isModelProviderName,
  parseColleaguesConfig,
  recommendedModelForProvider,
  suggestColleagueModel,
  validColleagueModelName,
  withColleague,
  withColleagueModel,
  type ColleagueEntry,
  type SuggestedColleagueModel,
} from "./colleagues.ts";
import { isHelperTurn } from "./eve-auth.ts";
import { MODEL_PROVIDER_NAMES } from "./model-provider.ts";
import { readSettings, updateSettings } from "./settings.ts";

type Auth = {
  readonly authenticator: string;
  readonly principalType?: string;
  readonly attributes?: Readonly<Record<string, unknown>> | null;
};

export type ColleagueToolContext = {
  readonly session?: {
    readonly auth?: {
      readonly initiator?: Auth | null;
      readonly current?: Auth | null;
    } | null;
  } | null;
};

// Плоский object на проводе — без oneOf/anyOf/allOf в корне (scripts/tool-wire-schema.test.ts).
export const colleagueInputSchema = z.object({
  action: z
    .enum(["list", "suggest_model", "configure", "set_model"])
    .describe(
      "list — показать опцию и коллег; suggest_model — предложить модель под роль; configure — задать роль и модель коллеги; set_model — сменить провайдера и модель коллеги",
    ),
  bot_id: z
    .string()
    .optional()
    .describe("Числовой bot_id коллеги (для configure и set_model)"),
  role: z
    .enum(COLLEAGUE_ROLES)
    .optional()
    .describe("Роль коллеги: critic, programmer, researcher, secretary"),
  name: z
    .string()
    .optional()
    .describe("Отображаемое имя коллеги (необязательно)"),
  provider: z
    .enum(MODEL_PROVIDER_NAMES)
    .optional()
    .describe("Провайдер модели из MODEL_PROVIDER_NAMES"),
  model: z.string().optional().describe("Имя модели у выбранного провайдера"),
});

export type ColleagueToolResult =
  | {
      readonly ok: true;
      readonly enabled?: boolean;
      readonly colleagues?: readonly ColleagueEntry[];
      readonly configured_bots?: readonly {
        readonly bot_id: string;
        readonly username?: string;
      }[];
      readonly roles?: readonly {
        readonly role: string;
        readonly label_ru: string;
        readonly label_en: string;
      }[];
      readonly suggestion?: SuggestedColleagueModel;
      readonly colleague?: ColleagueEntry;
    }
  | { readonly ok: false; readonly error: string };

/** Мутации коллег разрешены только в личном чате владельца (не в группе и не в Helper-ходе). */
export function isPrivateOwnerTurn(ctx?: ColleagueToolContext | null): boolean {
  const init = ctx?.session?.auth?.initiator;
  const current = ctx?.session?.auth?.current;
  if (isHelperTurn(ctx)) return false;
  return (
    init?.authenticator === "telegram-webhook" &&
    current?.authenticator === "telegram-webhook" &&
    init.principalType === "user" &&
    current.principalType === "user" &&
    init.attributes?.chat_type === "private" &&
    current.attributes?.chat_type === "private"
  );
}

export function colleagueExecute(
  input: unknown,
  ctx?: ColleagueToolContext | null,
  deps: {
    readonly env?: NodeJS.ProcessEnv;
    readonly settingsFile?: string;
  } = {},
): ColleagueToolResult {
  const parsed = colleagueInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  const env = deps.env ?? process.env;
  const settingsFile = deps.settingsFile ?? currentSettingsFile();
  const data = parsed.data;

  try {
    if (data.action === "list") {
      const config = parseColleaguesConfig(
        readSettings(settingsFile),
        () => {},
      );
      const configuredBots = configuredTelegramBots(env)
        .filter((bot) => !bot.isPrimary && bot.botId !== null)
        .map((bot) => ({
          bot_id: bot.botId as string,
          ...(bot.username ? { username: bot.username } : {}),
        }));
      return {
        ok: true,
        enabled: config.enabled,
        colleagues: Object.values(config.items),
        configured_bots: configuredBots,
        roles: COLLEAGUE_ROLES.map((role) => ({
          role,
          label_ru: COLLEAGUE_ROLE_SPECS[role].labelRu,
          label_en: COLLEAGUE_ROLE_SPECS[role].labelEn,
        })),
      };
    }

    if (data.action === "suggest_model") {
      if (!isColleagueRole(data.role)) {
        return {
          ok: false,
          error: `suggest_model requires role: one of ${COLLEAGUE_ROLES.join(", ")}`,
        };
      }
      return {
        ok: true,
        suggestion: suggestColleagueModel(data.role, env),
      };
    }

    if (!isPrivateOwnerTurn(ctx)) {
      return {
        ok: false,
        error:
          "Changing colleague configuration is allowed only in the owner's private chat.",
      };
    }

    if (data.action === "configure") {
      const botId = data.bot_id?.trim() ?? "";
      if (!validTelegramBotId(botId)) {
        return {
          ok: false,
          error: "configure requires numeric bot_id of the colleague bot",
        };
      }
      if (!isColleagueRole(data.role)) {
        return {
          ok: false,
          error: `configure requires role: one of ${COLLEAGUE_ROLES.join(", ")}`,
        };
      }
      const suggestion = suggestColleagueModel(data.role, env);
      const provider = data.provider ?? suggestion.provider;
      if (!isModelProviderName(provider)) {
        return {
          ok: false,
          error: `Invalid provider; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")}`,
        };
      }
      const model =
        data.model?.trim() ||
        recommendedModelForProvider(data.role, provider, env) ||
        "";
      if (!validColleagueModelName(model)) {
        return {
          ok: false,
          error: `configure requires model for provider ${provider}`,
        };
      }
      const next = updateSettings(
        (current) =>
          withColleague(current, {
            botId,
            role: data.role!,
            provider,
            model,
            ...(data.name ? { name: data.name } : {}),
          }),
        settingsFile,
      );
      const updated = parseColleaguesConfig(next, () => {}).items[botId];
      return { ok: true, colleague: updated, suggestion };
    }

    // set_model
    const botId = data.bot_id?.trim() ?? "";
    if (!validTelegramBotId(botId)) {
      return {
        ok: false,
        error: "set_model requires numeric bot_id of the colleague bot",
      };
    }
    const provider = data.provider;
    if (!isModelProviderName(provider)) {
      return {
        ok: false,
        error: `set_model requires provider: one of ${MODEL_PROVIDER_NAMES.join(", ")}`,
      };
    }
    const model = data.model?.trim() ?? "";
    if (!validColleagueModelName(model)) {
      return {
        ok: false,
        error: "set_model requires a non-empty model name",
      };
    }
    const next = updateSettings(
      (current) => withColleagueModel(current, botId, provider, model),
      settingsFile,
    );
    const updated = parseColleaguesConfig(next, () => {}).items[botId];
    return { ok: true, colleague: updated };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
