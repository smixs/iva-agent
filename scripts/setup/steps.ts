// Шаги мастера настройки, вынесенные из scripts/setup/main.ts (B5, шаг 1).
//
// Шаг получает состояние мастера и контекст: диалог, печать и запись .env приходят
// параметром, поэтому шаги проверяются in-process (scripts/setup/steps.test.ts), а
// чёрный ящик scripts/cli/config.test.ts продолжает гонять настоящий процесс.
// Тексты вопросов и порядок строк не менялись — это чистый вынос.
import { randomBytes } from "node:crypto";
import {
  CATALOG,
  catalogProvider,
  normalizeBaseUrl,
  providerBase,
} from "../lib/model-catalog.ts";
import { resolveMemorySearchMode } from "../lib/memory-mode.ts";
import { validateTimeZone } from "../lib/timezone.ts";
import {
  claudeContextWindow,
  type ClaudeStatus,
} from "../lib/claude-cli-status.ts";
import { claudeModelLabel } from "../lib/claude-cli-status.ts";
import type { fetchModels } from "../lib/model-catalog.ts";
import type {
  listCodexModels,
  readAuth,
  runBrowserLogin,
  runDeviceCodeLogin,
} from "../lib/codex-oauth.ts";
import type { validateModelSelection } from "../lib/model-validation.ts";

export type Env = Record<string, string>;
type CodexAuthFile = ReturnType<typeof readAuth>;
export type TelegramBot = { username?: string };
export type TelegramUser = { id: string; name: string };
export type ThrownSetupError = {
  code?: string;
  auth?: unknown;
  message: string;
};
export type AskRequiredOptions = {
  help?: string;
  existing?: string;
  validate?: (value: string) => Promise<string | null>;
};

/** Цвета мастера: одни на все шаги и на сам main. */
export const C = {
  g: "\x1b[32m",
  y: "\x1b[33m",
  c: "\x1b[36m",
  b: "\x1b[1m",
  r: "\x1b[31m",
  x: "\x1b[0m",
};

/** Диалог и печать: в бою — readline мастера, в тестах — стаб. */
export type SetupIo = {
  t: (en: string, ru: string) => string;
  lang: () => string;
  print: (...args: unknown[]) => void;
  write: (text: string) => void;
  ask: (q: string, def?: string, existing?: string) => Promise<string>;
  askYesNo: (q: string, def?: boolean) => Promise<boolean>;
  askRequired: (label: string, options?: AskRequiredOptions) => Promise<string>;
  mask: (value: string) => string;
  pickFromList: (
    items: readonly (string | { id: string; label?: string })[],
    current: string,
    recommended: string,
  ) => Promise<string>;
  pickPort: (def: string) => Promise<string>;
  head: (step: number, title: string) => void;
  hr: () => void;
};

/** Внешний мир шага: сеть, вход в подписку, запись .env. В бою — реальные, в тестах — стабы. */
export type SetupBackend = {
  envValue: (name: string) => string | undefined;
  dataDirAbs: (env: Env | null | undefined) => string;
  readAuth: typeof readAuth;
  listCodexModels: typeof listCodexModels;
  runBrowserLogin: typeof runBrowserLogin;
  runDeviceCodeLogin: typeof runDeviceCodeLogin;
  fetchModels: typeof fetchModels;
  validateModelSelection: typeof validateModelSelection;
  writeEnv: (out: Env) => Promise<void>;
  ollamaModels: (key: string) => Promise<string[]>;
  opencodeCheck: (key: string) => Promise<string | null>;
  opencodeModels: (key: string) => Promise<string[]>;
  openrouterKeyCheck: (key: string) => Promise<string | null>;
  openrouterModelCheck: (key: string, model: string) => Promise<string | null>;
  requestyKeyCheck: (key: string) => Promise<string | null>;
  requestyModelCheck: (key: string, model: string) => Promise<string | null>;
  /** Статус Claude Code CLI: у вендора claude нет ключа, вход живёт на этом же сервере. */
  claudeCli: () => Promise<ClaudeStatus>;
  deepgramCheck: (key: string) => Promise<string | null>;
  telegramGetMe: (token: string) => Promise<TelegramBot | undefined>;
  fetchTelegramUserIds: (token: string) => Promise<TelegramUser[]>;
};

export type SetupContext = SetupIo & SetupBackend;

/** Состояние мастера: что было в .env, что уже собрано и какой провайдер выбран. */
export type SetupState = {
  readonly existing: Env;
  readonly out: Env;
  readonly provider: string;
};

async function askOllamaSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.print(
    `\n  ${ctx.t("Ollama key", "Ключ Ollama")}: ${C.c}https://ollama.com/settings/keys${C.x} (Settings → Keys → Create key)`,
  );
  let models: string[] = [];
  out.OLLAMA_API_KEY = await ctx.askRequired(
    `  ${ctx.t("Paste the Ollama key", "Вставьте ключ Ollama")}`,
    {
      existing: ctx.envValue("OLLAMA_API_KEY") || existing.OLLAMA_API_KEY || "",
      validate: async (k) => {
        try {
          models = await ctx.ollamaModels(k);
          return null;
        } catch (error) {
          const caught = error as ThrownSetupError;
          return caught.auth
            ? ctx.t(
                "Ollama rejected the key. Copy it again (no spaces).",
                "Ollama не принял ключ. Скопируйте заново (без пробелов).",
              )
            : ctx.t(
                `couldn't verify: ${caught.message}`,
                `не смог проверить: ${caught.message}`,
              );
        }
      },
    },
  );
  ctx.print(
    `\n  ${ctx.t("Models available", "Доступно моделей")}: ${models.length}. ${ctx.t("I recommend", "Рекомендую")} ${C.g}deepseek-v4-pro${C.x}.`,
  );
  out.OLLAMA_MODEL = await ctx.pickFromList(
    models,
    out.OLLAMA_MODEL,
    "deepseek-v4-pro",
  );
  ctx.print(
    `\n  ${ctx.t("Vision model (photos)", "Vision-модель (фото)")}: ${ctx.t("describes incoming pictures — the text model above is usually blind.", "описывает входящие картинки — текстовая модель выше обычно их не видит.")} ${ctx.t("I recommend", "Рекомендую")} ${C.g}${CATALOG.ollama.visionDef ?? ""}${C.x}.`,
  );
  out.OLLAMA_VISION_MODEL = await ctx.pickFromList(
    models,
    out.OLLAMA_VISION_MODEL,
    CATALOG.ollama.visionDef ?? "",
  );
  out.OLLAMA_CONTEXT_WINDOW = out.OLLAMA_CONTEXT_WINDOW || "131072";
  ctx.print(`  → ${ctx.t("model", "модель")}: ${C.g}${out.OLLAMA_MODEL}${C.x}`);
  ctx.print(`  → vision: ${C.g}${out.OLLAMA_VISION_MODEL}${C.x}`);
}

async function askOpencodeSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.print(
    `\n  ${ctx.t("OpenCode key", "Ключ OpenCode")}: ${C.c}https://opencode.ai/auth${C.x} ${ctx.t("(subscribe to Go → copy the API key).", "(подпишитесь на Go → скопируйте API key).")}`,
  );
  out.OPENCODE_API_KEY = await ctx.askRequired(
    `  ${ctx.t("Paste the OpenCode API key", "Вставьте OpenCode API key")}`,
    {
      existing:
        ctx.envValue("OPENCODE_API_KEY") || existing.OPENCODE_API_KEY || "",
      validate: ctx.opencodeCheck,
    },
  );
  const models = await ctx.opencodeModels(out.OPENCODE_API_KEY);
  ctx.print(
    `\n  ${ctx.t("OpenCode Go models", "Модели OpenCode Go")}: ${models.length}. ${ctx.t("I recommend", "Рекомендую")} ${C.g}deepseek-v4-pro${C.x}.`,
  );
  // Strip the stale prefix from older .env files so the current model pre-selects from the bare list.
  const curModel = (out.OPENCODE_MODEL || "").replace(/^opencode-go\//, "");
  out.OPENCODE_MODEL = await ctx.pickFromList(
    models,
    curModel,
    "deepseek-v4-pro",
  );
  ctx.print(
    `\n  ${ctx.t("Vision model (photos)", "Vision-модель (фото)")}: ${ctx.t("describes incoming pictures — the text model above is usually blind.", "описывает входящие картинки — текстовая модель выше обычно их не видит.")} ${ctx.t("I recommend", "Рекомендую")} ${C.g}${CATALOG.opencode.visionDef ?? ""}${C.x}.`,
  );
  // Тот же срез устаревшего префикса, что и у текстовой модели выше.
  const curVision = (out.OPENCODE_VISION_MODEL || "").replace(
    /^opencode-go\//,
    "",
  );
  out.OPENCODE_VISION_MODEL = await ctx.pickFromList(
    models,
    curVision,
    CATALOG.opencode.visionDef ?? "",
  );
  out.OPENCODE_CONTEXT_WINDOW = out.OPENCODE_CONTEXT_WINDOW || "131072";
  ctx.print(
    `  → ${ctx.t("model", "модель")}: ${C.g}${out.OPENCODE_MODEL}${C.x}`,
  );
  ctx.print(`  → vision: ${C.g}${out.OPENCODE_VISION_MODEL}${C.x}`);
}

/** Модель OpenRouter: слаг и живой тест (включая tool calling). */
async function askOpenrouterModel(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.print(
    `\n  ${ctx.t("OpenRouter key", "Ключ OpenRouter")}: ${C.c}https://openrouter.ai/keys${C.x} ${ctx.t("(Create Key → copy sk-or-…).", "(Create Key → скопируйте sk-or-…).")}`,
  );
  out.OPENROUTER_API_KEY = await ctx.askRequired(
    `  ${ctx.t("Paste the OpenRouter key", "Вставьте ключ OpenRouter")}`,
    {
      existing:
        ctx.envValue("OPENROUTER_API_KEY") || existing.OPENROUTER_API_KEY || "",
      validate: ctx.openrouterKeyCheck,
    },
  );
  // 300+ моделей — пикер не подходит. Инструкция: откуда взять слаг и в каком виде, + живой тест.
  ctx.print(
    `\n  ${ctx.t("Now the model.", "Теперь модель.")} ${ctx.t("Open", "Откройте")} ${C.c}https://openrouter.ai/models${C.x}, ${ctx.t("pick a model and copy its slug", "выберите модель и скопируйте её слаг")}`,
  );
  ctx.print(
    `  ${ctx.t("— the id under the name, form", "— id под названием, вид")} ${C.g}vendor/model${C.x} (${ctx.t("e.g.", "напр.")} ${C.g}anthropic/claude-sonnet-4.5${C.x}, ${C.g}openai/gpt-5.1${C.x}, ${C.g}google/gemini-2.5-pro${C.x}).`,
  );
  ctx.print(
    `  ${C.y}${ctx.t("I'll send a live test (incl. tool/function calling, which Iva needs) — so a wrong or chat-only model can't slip through and leave the bot mute.", "Сразу отправлю живой тест (включая поддержку инструментов — она нужна Iva) — чтобы кривая или chat-only модель не проскочила и бот не остался немым.")}${C.x}`,
  );
  for (;;) {
    const m = (
      await ctx.ask(
        `  ${ctx.t("OpenRouter model slug", "Слаг модели OpenRouter")}`,
        out.OPENROUTER_MODEL || "",
      )
    ).trim();
    if (!m) {
      ctx.print(
        `${C.y}  ⚠ ${ctx.t("Required — paste a slug from openrouter.ai/models.", "Обязательно — вставьте слаг с openrouter.ai/models.")}${C.x}\n`,
      );
      continue;
    }
    ctx.write(
      `  ${ctx.t("testing the model answers…", "проверяю, что модель отвечает…")} `,
    );
    const err = await ctx.openrouterModelCheck(out.OPENROUTER_API_KEY, m);
    if (err) {
      ctx.print(
        `${C.r}${ctx.t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`,
      );
      continue;
    }
    ctx.print(
      `${C.g}${ctx.t("ok — the model answered", "ок — модель ответила")}${C.x}`,
    );
    out.OPENROUTER_MODEL = m;
    break;
  }
}

/** Vision-слаг OpenRouter и окно контекста. */
async function askOpenrouterVision(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { out } = state;
  // Vision — отдельный слаг: выбранная текстовая модель может быть text-only.
  // Живого теста тут нет (мастер не шлёт картинку) — только дефолт и то, что вписали.
  const visionDef = CATALOG.openrouter.visionDef ?? "";
  ctx.print(
    `\n  ${ctx.t("Vision model (photos)", "Vision-модель (фото)")}: ${ctx.t("a slug that accepts images, any vendor.", "слаг модели, принимающей картинки, любого вендора.")} ${ctx.t("Enter keeps", "Enter оставит")} ${C.g}${visionDef}${C.x}.`,
  );
  out.OPENROUTER_VISION_MODEL =
    (
      await ctx.ask(
        `  ${ctx.t("OpenRouter vision slug", "Слаг vision-модели OpenRouter")}`,
        out.OPENROUTER_VISION_MODEL || visionDef,
      )
    ).trim() || visionDef;
  out.OPENROUTER_CONTEXT_WINDOW = out.OPENROUTER_CONTEXT_WINDOW || "131072";
  ctx.print(
    `  → ${ctx.t("model", "модель")}: ${C.g}${out.OPENROUTER_MODEL}${C.x}`,
  );
  ctx.print(`  → vision: ${C.g}${out.OPENROUTER_VISION_MODEL}${C.x}`);
}

async function askOpenrouterSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  await askOpenrouterModel(state, ctx);
  await askOpenrouterVision(state, ctx);
}

/** Модель Requesty: id и живой тест (включая tool calling), как у OpenRouter. */
async function askRequestyModel(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.print(
    `\n  ${ctx.t("Requesty key", "Ключ Requesty")}: ${C.c}https://app.requesty.ai/api-keys${C.x} ${ctx.t("(create a key and copy it).", "(создайте ключ и скопируйте его).")}`,
  );
  out.REQUESTY_API_KEY = await ctx.askRequired(
    `  ${ctx.t("Paste the Requesty key", "Вставьте ключ Requesty")}`,
    {
      existing:
        ctx.envValue("REQUESTY_API_KEY") || existing.REQUESTY_API_KEY || "",
      validate: ctx.requestyKeyCheck,
    },
  );
  ctx.print(
    `\n  ${ctx.t("Now the model.", "Теперь модель.")} ${ctx.t("Open", "Откройте")} ${C.c}https://www.requesty.ai/models${C.x}, ${ctx.t("pick a model and copy its id", "выберите модель и скопируйте её id")}`,
  );
  ctx.print(
    `  (${ctx.t("e.g.", "напр.")} ${C.g}gpt-5.5${C.x}, ${C.g}claude-sonnet-5${C.x}, ${C.g}openai/gpt-4o-mini${C.x}).`,
  );
  ctx.print(
    `  ${C.y}${ctx.t("I'll send a live test (incl. tool/function calling, which Iva needs), so a wrong or chat-only model can't slip through and leave the bot mute.", "Сразу отправлю живой тест (включая поддержку инструментов, она нужна Iva), чтобы кривая или chat-only модель не проскочила и бот не остался немым.")}${C.x}`,
  );
  for (;;) {
    const m = (
      await ctx.ask(
        `  ${ctx.t("Requesty model id", "Id модели Requesty")}`,
        out.REQUESTY_MODEL || CATALOG.requesty.def || "",
      )
    ).trim();
    if (!m) {
      ctx.print(
        `${C.y}  ⚠ ${ctx.t("Required: paste a model id from requesty.ai/models.", "Обязательно: вставьте id модели с requesty.ai/models.")}${C.x}\n`,
      );
      continue;
    }
    ctx.write(
      `  ${ctx.t("testing the model answers…", "проверяю, что модель отвечает…")} `,
    );
    const err = await ctx.requestyModelCheck(out.REQUESTY_API_KEY, m);
    if (err) {
      ctx.print(
        `${C.r}${ctx.t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`,
      );
      continue;
    }
    ctx.print(
      `${C.g}${ctx.t("ok, the model answered", "ок, модель ответила")}${C.x}`,
    );
    out.REQUESTY_MODEL = m;
    break;
  }
}

/** Vision-модель Requesty и окно контекста. */
async function askRequestyVision(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { out } = state;
  const visionDef = CATALOG.requesty.visionDef ?? "";
  ctx.print(
    `\n  ${ctx.t("Vision model (photos)", "Vision-модель (фото)")}: ${ctx.t("a model that accepts images, any vendor.", "модель, принимающая картинки, любого вендора.")} ${ctx.t("Enter keeps", "Enter оставит")} ${C.g}${visionDef}${C.x}.`,
  );
  out.REQUESTY_VISION_MODEL =
    (
      await ctx.ask(
        `  ${ctx.t("Requesty vision model", "Vision-модель Requesty")}`,
        out.REQUESTY_VISION_MODEL || visionDef,
      )
    ).trim() || visionDef;
  out.REQUESTY_CONTEXT_WINDOW = out.REQUESTY_CONTEXT_WINDOW || "131072";
  ctx.print(
    `  → ${ctx.t("model", "модель")}: ${C.g}${out.REQUESTY_MODEL}${C.x}`,
  );
  ctx.print(`  → vision: ${C.g}${out.REQUESTY_VISION_MODEL}${C.x}`);
}

async function askRequestySettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  await askRequestyModel(state, ctx);
  await askRequestyVision(state, ctx);
}

async function askCustomEndpoint(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  // Свой OpenAI-совместимый эндпоинт. Курировать нечего: адрес и модель знает только
  // владелец, поэтому спрашиваем их, а список моделей пробуем живым GET /models.
  ctx.print(
    `\n  ${ctx.t("Your own OpenAI-compatible endpoint: a proxy, vLLM, LiteLLM or a vendor plan.", "Свой OpenAI-совместимый эндпоинт: прокси, vLLM, LiteLLM или вендорская подписка.")}`,
  );
  ctx.print(
    `  ${ctx.t("Address in full, with the /v1-style suffix", "Адрес целиком, вместе с суффиксом вида /v1")}: ${C.g}https://api.example.com/v1${C.x}`,
  );
  for (;;) {
    const base = normalizeBaseUrl(
      await ctx.ask(
        `  ${ctx.t("Endpoint base URL", "Базовый адрес эндпоинта")}`,
        out.CUSTOM_BASE_URL || "",
      ),
    );
    if (base) {
      out.CUSTOM_BASE_URL = base;
      break;
    }
    ctx.print(
      `${C.y}  ⚠ ${ctx.t("Needs a full http(s) address, e.g. https://api.example.com/v1.", "Нужен полный http(s)-адрес, напр. https://api.example.com/v1.")}${C.x}\n`,
    );
  }
  ctx.print(
    `\n  ${ctx.t("API key — Enter to skip if the endpoint needs none (self-hosted usually doesn't).", "API-ключ — Enter, если эндпоинт его не требует (свой сервер обычно не требует).")}`,
  );
  const customKeyExisting =
    ctx.envValue("CUSTOM_API_KEY") || existing.CUSTOM_API_KEY || "";
  const customKey = await ctx.ask(
    `  ${ctx.t("Custom API key", "API-ключ эндпоинта")}`,
    customKeyExisting ? ctx.mask(customKeyExisting) : "",
    customKeyExisting,
  );
  out.CUSTOM_API_KEY = (customKey || "").trim();
}

/** Модель своего эндпоинта: каталог, если отдаётся, иначе id из рук владельца. */
async function askCustomModel(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { out } = state;
  // GET /models спецификацией не гарантирован: нет каталога — берём id из рук владельца.
  let customModels: string[] = [];
  try {
    customModels = await ctx.fetchModels(
      "custom",
      out.CUSTOM_API_KEY || undefined,
      { base: out.CUSTOM_BASE_URL },
    );
  } catch (error) {
    ctx.print(
      `  ${C.y}${ctx.t("couldn't read the model list", "не смог прочитать список моделей")}: ${(error as ThrownSetupError).message}${C.x}`,
    );
  }
  if (customModels.length) {
    ctx.print(
      `\n  ${ctx.t("Models available", "Доступно моделей")}: ${customModels.length}.`,
    );
    out.CUSTOM_MODEL = await ctx.pickFromList(
      customModels,
      out.CUSTOM_MODEL || "",
      customModels[0],
    );
    return;
  }
  for (;;) {
    const id = (
      await ctx.ask(
        `  ${ctx.t("Model id, exactly as the provider names it", "ID модели, ровно как называет её провайдер")}`,
        out.CUSTOM_MODEL || "",
      )
    ).trim();
    if (id) {
      out.CUSTOM_MODEL = id;
      break;
    }
    ctx.print(
      `${C.y}  ⚠ ${ctx.t("Required — this endpoint has no default model.", "Обязательно — дефолтной модели у этого эндпоинта нет.")}${C.x}\n`,
    );
  }
}

async function askCustomSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { out } = state;
  await askCustomEndpoint(state, ctx);
  await askCustomModel(state, ctx);
  ctx.print(
    `\n  ${ctx.t("Vision model (photos)", "Vision-модель (фото)")}: ${ctx.t("a fallback only — a chat model that reads images is asked directly. Enter — skip.", "только запасной путь: модель чата, которая видит картинки, спрашивается напрямую. Enter — пропустить.")}`,
  );
  out.CUSTOM_VISION_MODEL = (
    await ctx.ask(
      `  ${ctx.t("Custom vision model id", "ID vision-модели эндпоинта")}`,
      out.CUSTOM_VISION_MODEL || "",
    )
  ).trim();
  out.CUSTOM_CONTEXT_WINDOW = out.CUSTOM_CONTEXT_WINDOW || "131072";
  ctx.print(`  → ${ctx.t("model", "модель")}: ${C.g}${out.CUSTOM_MODEL}${C.x}`);
}

/**
 * Вендор claude: ключа нет вовсе — Ива зовёт Claude Code CLI на том же сервере.
 * Поставить пакет и войти в подписку мастер за владельца не может, поэтому он проверяет
 * статус, показывает команды для сервера и даёт повторить проверку.
 */
async function askClaudeSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { out } = state;
  ctx.print(
    `\n  ${ctx.t("Claude by subscription: Iva calls the claude CLI on this server. No API key — sign the CLI in once and Iva uses that login.", "Claude по подписке: Ива зовёт CLI claude на этом же сервере. API-ключа нет — войдите в CLI один раз, и Ива пользуется этим входом.")}`,
  );
  let status = await ctx.claudeCli();
  while (!status.ready) {
    ctx.print(`  ${C.y}${status.hint}${C.x}`);
    if (
      !(await ctx.askYesNo(
        `  ${ctx.t("Done that? Check again?", "Сделали? Проверить снова?")}`,
        true,
      ))
    )
      break;
    status = await ctx.claudeCli();
  }
  if (status.ready)
    ctx.print(
      `  ${C.g}${ctx.t("signed in", "вход выполнен")}${status.plan ? ` — ${ctx.t("plan", "план")}: ${status.plan}` : ""}${C.x}`,
    );
  // Список моделей спрашиваем у того же CLI; не ответил — остаётся вшитый список каталога.
  // На экране — имя, в .env — канонический id.
  const models = await ctx.fetchModels("claude");
  out.CLAUDE_MODEL = await ctx.pickFromList(
    models.map((id) => ({ id, label: claudeModelLabel(id) })),
    out.CLAUDE_MODEL,
    CATALOG.claude.def ?? "",
  );
  // Окно контекста пишем сразу за моделью: компактация считает порог от него.
  out.CLAUDE_CONTEXT_WINDOW = claudeContextWindow(out.CLAUDE_MODEL);
  ctx.print(
    `  → ${ctx.t("model", "модель")}: ${C.g}${out.CLAUDE_MODEL}${C.x} · ${ctx.t("context window", "окно контекста")}: ${out.CLAUDE_CONTEXT_WINDOW}`,
  );
}

/** Вход по подписке OpenAI (OAuth): токен уезжает в data/codex-auth.json. */
async function askCodexLogin(
  state: SetupState,
  ctx: SetupContext,
): Promise<CodexAuthFile> {
  const { existing, out } = state;
  const dataDir = ctx.dataDirAbs({ ...existing, ...out });
  let auth = ctx.readAuth(dataDir);
  if (auth) {
    ctx.print(
      `\n  ${C.g}${ctx.t("Already signed in", "Вход уже выполнен")}${auth.planType ? ` (${ctx.t("plan", "план")}: ${auth.planType})` : ""}.${C.x} ${ctx.t("Re-login: iva login", "Перелогиниться: iva login")}`,
    );
    return auth;
  }
  ctx.print(
    `\n  ${ctx.t("Sign in to your OpenAI (ChatGPT) subscription. No API key — auth like the codex CLI.", "Вход по подписке OpenAI (ChatGPT). Без API-ключа — авторизация как у codex CLI.")}`,
  );
  const useBrowser = await ctx.askYesNo(
    `  ${ctx.t("Sign in via a browser on THIS machine? (No = by link + code, best for a headless VPS)", "Войти через браузер на ЭТОЙ машине? (Нет = по ссылке и коду, для headless-VPS)")}`,
    false,
  );
  while (!auth) {
    try {
      auth = useBrowser
        ? await ctx.runBrowserLogin({
            dataDir,
            lang: ctx.lang(),
            log: (m) => ctx.print(m),
          })
        : await ctx.runDeviceCodeLogin({
            dataDir,
            lang: ctx.lang(),
            log: (m) => ctx.print(m),
          });
      ctx.print(
        `  ${C.g}${ctx.t("signed in", "вход выполнен")}${auth.planType ? ` — ${ctx.t("plan", "план")}: ${auth.planType}` : ""}${C.x}`,
      );
    } catch (error) {
      const caught = error as ThrownSetupError;
      ctx.print(
        `  ${C.r}${ctx.t("sign-in failed", "не удалось войти")}: ${caught.message}${C.x}`,
      );
      if (
        !(await ctx.askYesNo(
          `  ${ctx.t("Try again?", "Попробовать снова?")}`,
          true,
        ))
      )
        break;
    }
  }
  return auth;
}

/** Модель Codex: список подписки с бэкенда, ручной ввод — только фолбэк. */
async function askCodexModel(
  state: SetupState,
  ctx: SetupContext,
  auth: CodexAuthFile,
): Promise<void> {
  const { existing, out } = state;
  const dataDir = ctx.dataDirAbs({ ...existing, ...out });
  // Список моделей подписки — тянем с бэкенда (как ollama/opencode). Fallback — ручной ввод.
  let models: string[] = [];
  if (auth) {
    try {
      models = await ctx.listCodexModels({ dataDir });
    } catch (error) {
      const caught = error as ThrownSetupError;
      ctx.print(
        `  ${C.y}${ctx.t("couldn't fetch the model list", "не смог получить список моделей")}: ${caught.message}${C.x}`,
      );
    }
  }
  if (models.length) {
    ctx.print(
      `\n  ${ctx.t("Models available", "Доступно моделей")}: ${models.length}.`,
    );
    out.CODEX_MODEL = await ctx.pickFromList(
      models,
      out.CODEX_MODEL || "",
      models[0],
    );
  } else {
    out.CODEX_MODEL = await ctx.ask(
      `  ${ctx.t("Codex model id", "ID модели Codex")}`,
      out.CODEX_MODEL || "gpt-5.1",
    );
  }
  out.CODEX_CONTEXT_WINDOW = out.CODEX_CONTEXT_WINDOW || "272000";
  ctx.print(`  → ${ctx.t("model", "модель")}: ${C.g}${out.CODEX_MODEL}${C.x}`);
}

async function askCodexSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const auth = await askCodexLogin(state, ctx);
  await askCodexModel(state, ctx, auth);
}

/** Шаг 1: провайдер и модель. Ветка выбирается именем провайдера, меню — в main. */
export async function askProviderSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<Env> {
  const { out, provider } = state;
  if (provider === "ollama") await askOllamaSettings(state, ctx);
  else if (provider === "opencode") await askOpencodeSettings(state, ctx);
  else if (provider === "openrouter") await askOpenrouterSettings(state, ctx);
  else if (provider === "custom") await askCustomSettings(state, ctx);
  else if (provider === "requesty") await askRequestySettings(state, ctx);
  else if (provider === "claude") await askClaudeSettings(state, ctx);
  else await askCodexSettings(state, ctx);
  ctx.print(
    `  ${C.y}${ctx.t("Don't inflate the context window:", "Окно контекста не завышайте:")}${C.x} ${ctx.t("compaction computes its threshold from it; an inflated window risks overflow.", "компактация считает порог от него; завышенное окно = риск переполнения.")}`,
  );
  return out;
}

/** Шаг 2: Deepgram — расшифровка голоса и видео. Необязателен: из части стран
 *  console.deepgram.com не открывается, а бот без голосовых работает; ключ можно
 *  добавить потом в /menu → 🎤 Голос или через iva config. */
async function askDeepgramSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.head(
    2,
    ctx.t(
      "Deepgram — voice and video transcription (optional)",
      "Deepgram — расшифровка голоса и видео (необязательно)",
    ),
  );
  ctx.print(
    `  ${ctx.t("Where to get the key", "Где взять ключ")}: ${C.c}https://console.deepgram.com${C.x}`,
  );
  ctx.print(
    `    1) ${ctx.t("sign up (free starter credit)", "зарегистрируйтесь (дают бесплатный стартовый кредит)")}`,
  );
  ctx.print("    2) API Keys → Create a New API Key");
  ctx.print(`    3) ${ctx.t("copy the key", "скопируйте ключ")}`);
  ctx.print(
    `  ${C.y}${ctx.t("Enter — skip: voice notes stay untranscribed until you add the key in /menu → 🎤 Voice or iva config.", "Enter — пропустить: голосовые не расшифровываются, пока не добавите ключ в /menu → 🎤 Голос или iva config.")}${C.x}`,
  );
  const keyExisting =
    ctx.envValue("DEEPGRAM_API_KEY") || existing.DEEPGRAM_API_KEY || "";
  let key: string;
  for (;;) {
    key = (
      (await ctx.ask(
        `  ${ctx.t("Paste the Deepgram API key", "Вставьте Deepgram API key")}`,
        keyExisting ? ctx.mask(keyExisting) : "",
        keyExisting,
      )) || ""
    ).trim();
    if (!key) break;
    const err = await ctx.deepgramCheck(key);
    if (!err) break;
    ctx.print(`  ${C.y}${ctx.t("not ok", "не ок")}: ${err}${C.x}`);
  }
  out.DEEPGRAM_API_KEY = key;
  if (!key) {
    out.DEEPGRAM_LANGUAGE = out.DEEPGRAM_LANGUAGE || "multi";
    ctx.print(
      `  ${ctx.t("Voice is off for now — enable it later in /menu → 🎤 Voice.", "Голос пока выключен — включите потом в /menu → 🎤 Голос.")}`,
    );
    return;
  }
  out.DEEPGRAM_LANGUAGE = await ctx.ask(
    `  ${ctx.t("Recognition language (multi = auto ru/uz/en)", "Язык распознавания (multi = авто ru/uz/en)")}`,
    out.DEEPGRAM_LANGUAGE || "multi",
  );
}

type SearchProvider = {
  readonly id: string;
  readonly key: string;
  readonly url: string;
  readonly note: string;
};

/** Провайдеры веб-поиска: ключ и справка. Без ключа поиск выключен. */
function searchProviderTable(ctx: SetupContext): SearchProvider[] {
  return [
    {
      id: "tavily",
      key: "TAVILY_API_KEY",
      url: "https://app.tavily.com",
      note: ctx.t(
        "free ~1000/mo, no card, has answer ★",
        "free ~1000/мес, без карты, есть answer ★",
      ),
    },
    {
      id: "exa",
      key: "EXA_API_KEY",
      url: "https://dashboard.exa.ai",
      note: ctx.t("free ~20k/mo, no card", "free ~20k/мес, без карты"),
    },
    {
      id: "parallel",
      key: "PARALLEL_API_KEY",
      url: "https://platform.parallel.ai",
      note: ctx.t("starter credits, no card", "стартовые кредиты, без карты"),
    },
    {
      id: "brave",
      key: "BRAVE_API_KEY",
      url: "https://api-dashboard.search.brave.com",
      note: ctx.t(
        "card required (verification), ~$5/mo credit",
        "нужна карта (идентификация), ~$5/мес кредит",
      ),
    },
  ];
}

/** Веб-поиск: провайдер и его ключ (Enter на ключе — поиск остаётся выключенным). */
async function askWebSearchSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  // Without a key for the chosen provider web_search is off (DuckDuckGo gives a captcha from a server IP).
  ctx.print(
    `\n  ${C.b}${ctx.t("Web search", "Веб-поиск")}${C.x} — ${ctx.t("so Iva can search the internet (Enter on the key — skip, search stays off).", "чтобы Iva искала в интернете (Enter на ключе — пропустить, поиск будет выключен).")}`,
  );
  const SEARCH = searchProviderTable(ctx);
  SEARCH.forEach((s, i) =>
    ctx.print(
      `   ${i + 1}. ${s.id}  ${C.c}${s.url}${C.x}  ${C.y}(${s.note})${C.x}`,
    ),
  );
  const curSearch = existing.SEARCH_PROVIDER || out.SEARCH_PROVIDER || "tavily";
  const defIdx = Math.max(
    0,
    SEARCH.findIndex((s) => s.id === curSearch),
  );
  const chSearch = await ctx.ask(
    `  ${ctx.t("Search provider (number)", "Провайдер поиска (номер)")}`,
    String(defIdx + 1),
  );
  let si = parseInt(chSearch, 10) - 1;
  if (isNaN(si) || si < 0 || si >= SEARCH.length) si = defIdx;
  const sprov = SEARCH[si];
  out.SEARCH_PROVIDER = sprov.id;
  ctx.print(
    `  ${ctx.t("Key for", "Ключ")} ${sprov.id}: ${C.c}${sprov.url}${C.x}${sprov.id === "brave" ? `  ${C.y}${ctx.t("(card required)", "(потребуется карта)")}${C.x}` : ""}. ${ctx.t("Enter — skip.", "Enter — пропустить.")}`,
  );
  const keyExisting =
    ctx.envValue(sprov.key) || existing[sprov.key] || out[sprov.key] || "";
  const kv = await ctx.ask(
    `  ${sprov.id} API key`,
    keyExisting ? ctx.mask(keyExisting) : "",
    keyExisting,
  );
  out[sprov.key] = (kv || "").trim();
}

/** Вопрос про hybrid-память; «нет» сразу фиксирует бесплатный режим. */
async function askHybridOptIn(
  state: SetupState,
  ctx: SetupContext,
): Promise<boolean> {
  const { existing, out } = state;
  // База (BM25 + граф связей) уже включена всегда, бесплатно, без ключа. Здесь — только
  // opt-in на семантический hybrid, который стоит внешнего ключа.
  ctx.print(
    `\n  ${ctx.t("Enhanced memory (hybrid search) — optional", "Улучшенная память (hybrid-поиск) — по желанию")}`,
  );
  ctx.print(
    `  ${C.y}${ctx.t(
      "Base search (BM25 + link graph) is already on — free, no key. Hybrid adds semantic search via ONE external key (~cents/mo), better for a large vault or fuzzy/cross-language queries.",
      "Базовый поиск (BM25 + граф связей) уже включён — бесплатно, без ключа. Hybrid добавляет семантику через ОДИН внешний ключ (~центы/мес), лучше для большого вольта и нечётких/межъязычных запросов.",
    )}${C.x}`,
  );
  if (
    await ctx.askYesNo(
      `  ${ctx.t("Enable hybrid memory?", "Включить hybrid-память?")}`,
      existing.MEMORY_SEARCH_MODE === "hybrid",
    )
  )
    return true;
  out.MEMORY_SEARCH_MODE = resolveMemorySearchMode(false, out);
  return false;
}

/** Ключ эмбеддингов и итоговый режим поиска памяти. */
async function askEmbeddingKey(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  const EMB = [
    {
      id: "jina",
      key: "JINA_API_KEY",
      url: "https://jina.ai/embeddings",
      note: ctx.t("no-train, EU, ~$0.02/1M", "no-train, EU, ~$0.02/1M"),
    },
    {
      id: "deepinfra",
      key: "DEEPINFRA_API_KEY",
      url: "https://deepinfra.com/dash/api_keys",
      note: ctx.t("cheapest, BGE-M3", "дешевле всех, BGE-M3"),
    },
  ];
  EMB.forEach((e, i) =>
    ctx.print(
      `   ${i + 1}. ${e.id}  ${C.c}${e.url}${C.x}  ${C.y}(${e.note})${C.x}`,
    ),
  );
  const chEmb = await ctx.ask(
    `  ${ctx.t("Embedding provider (number)", "Провайдер эмбеддингов (номер)")}`,
    existing.DEEPINFRA_API_KEY && !existing.JINA_API_KEY ? "2" : "1",
  );
  let ei = parseInt(chEmb, 10) - 1;
  if (isNaN(ei) || ei < 0 || ei >= EMB.length) ei = 0;
  const eprov = EMB[ei];
  const eExisting =
    ctx.envValue(eprov.key) || existing[eprov.key] || out[eprov.key] || "";
  ctx.print(
    `  ${ctx.t("Key for", "Ключ")} ${eprov.id}: ${C.c}${eprov.url}${C.x}. ${ctx.t("Enter — skip.", "Enter — пропустить.")}`,
  );
  const ek = await ctx.ask(
    `  ${eprov.id} API key`,
    eExisting ? ctx.mask(eExisting) : "",
    eExisting,
  );
  out[eprov.key] = (ek || "").trim();
  out.MEMORY_SEARCH_MODE = resolveMemorySearchMode(true, out);
  if (out.MEMORY_SEARCH_MODE === "hybrid") {
    ctx.print(
      `  ${C.y}${ctx.t("Index will build on the next nightly maintenance (or run: node scripts/memory/embed-index.ts).", "Индекс соберётся при ближайшем ночном обслуживании (или вручную: node scripts/memory/embed-index.ts).")}${C.x}`,
    );
  } else {
    ctx.print(
      `  ${C.y}${ctx.t("No key — hybrid skipped. Memory search stays on free BM25. Enable later: iva config.", "Ключа нет — hybrid пропущен. Поиск памяти остаётся на бесплатном BM25. Включить позже: iva config.")}${C.x}`,
    );
  }
}

async function askMemorySettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  if (await askHybridOptIn(state, ctx)) await askEmbeddingKey(state, ctx);
}

/** Шаги 2 и «Веб-поиск» + «Память»: ключи внешних сервисов между моделью и Telegram. */
export async function askKeysSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<Env> {
  await askDeepgramSettings(state, ctx);
  await askWebSearchSettings(state, ctx);
  await askMemorySettings(state, ctx);
  return state.out;
}

/** Шаг 3: бот Telegram. */
async function askTelegramBot(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.head(
    3,
    ctx.t(
      "Telegram bot — how you talk to Iva",
      "Telegram-бот — через него вы говорите с Iva",
    ),
  );
  ctx.print(
    `  ${ctx.t("Create a bot via @BotFather in Telegram:", "Создайте бота у @BotFather в Telegram:")}`,
  );
  ctx.print(
    `    1) ${ctx.t("open a chat with @BotFather", "откройте чат с @BotFather")}`,
  );
  ctx.print(`    2) ${ctx.t("send /newbot", "отправьте /newbot")}`);
  ctx.print(
    `    3) ${ctx.t("set the bot's name and username", "задайте имя и username бота")}`,
  );
  ctx.print(
    `    4) ${ctx.t("copy the token like 123456789:ABCdef...", "скопируйте token вида 123456789:ABCdef...")}`,
  );
  let me: TelegramBot | null | undefined = null;
  out.TELEGRAM_BOT_TOKEN = await ctx.askRequired(
    `  ${ctx.t("Paste the Bot token", "Вставьте Bot token")}`,
    {
      existing: existing.TELEGRAM_BOT_TOKEN || "",
      validate: async (token) => {
        try {
          me = await ctx.telegramGetMe(token);
          return null;
        } catch (error) {
          const caught = error as ThrownSetupError;
          return ctx.t(
            `Telegram rejected the token (${caught.message}). Copy it again from @BotFather.`,
            `Telegram не принял токен (${caught.message}). Скопируйте заново у @BotFather.`,
          );
        }
      },
    },
  );
  const telegramBot = me as TelegramBot | null | undefined;
  out.TELEGRAM_BOT_USERNAME =
    telegramBot?.username ||
    out.TELEGRAM_BOT_USERNAME ||
    (await ctx.ask(
      `  ${ctx.t("Bot username (without @)", "Username бота (без @)")}`,
      existing.TELEGRAM_BOT_USERNAME || "",
    ));
  if (telegramBot?.username)
    ctx.print(
      `  → ${ctx.t("bot", "бот")}: ${C.g}@${telegramBot.username}${C.x}`,
    );
  out.TELEGRAM_WEBHOOK_SECRET_TOKEN =
    existing.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");
}

/** Список найденных собеседников бота: номера через запятую или все по Enter. */
async function addFoundUsers(
  ctx: SetupContext,
  ids: Set<string>,
  found: TelegramUser[],
): Promise<void> {
  ctx.print(
    `  ${ctx.t("Found who messaged the bot:", "Нашёл, кто писал боту:")}`,
  );
  found.forEach((u, i) => ctx.print(`   ${i + 1}. ${u.id}  ${u.name}`));
  const pick = await ctx.ask(
    `  ${ctx.t("Which IDs to add? numbers comma-separated (Enter — add all)", "Чьи ID добавить? номера через запятую (Enter — добавить всех)")}`,
    "",
  );
  const chosen = pick
    ? pick
        .split(/[,\s]+/)
        .map((n) => found[parseInt(n, 10) - 1])
        .filter(Boolean)
    : found;
  chosen.forEach((u) => ids.add(u.id));
}

/** Шаг 4: доверенные Telegram ID — цикл, пока не наберётся хотя бы один. */
/** Кого нашёл бот: номера через запятую или все по Enter; иначе ручной ввод ID. */
async function collectTelegramIds(
  ctx: SetupContext,
  ids: Set<string>,
  token: string,
): Promise<void> {
  try {
    const found = await ctx.fetchTelegramUserIds(token);
    if (found.length) {
      await addFoundUsers(ctx, ids, found);
    } else {
      ctx.print(
        `${C.y}  ${ctx.t("I see no messages to the bot. Did you definitely send one? (if a webhook is set, getUpdates returns nothing)", "Не вижу сообщений боту. Точно написали? (если уже стоит вебхук — getUpdates не отдаёт апдейты)")}${C.x}`,
      );
    }
  } catch (error) {
    const caught = error as ThrownSetupError;
    ctx.print(
      `${C.y}  ${ctx.t(`Couldn't fetch updates: ${caught.message}`, `Не смог получить апдейты: ${caught.message}`)}${C.x}`,
    );
  }
  if (ids.size > 0) return;
  const manual = await ctx.ask(
    `  ${ctx.t("Enter your Telegram ID manually (find it: message @userinfobot), or Enter — try again", "Введите свой Telegram ID вручную (узнать: напишите @userinfobot), или Enter — попробовать снова")}`,
    "",
  );
  manual
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((s) => ids.add(s));
}

/** Шаг 4: доверенные Telegram ID — цикл, пока не наберётся хотя бы один. */
async function askAllowedUsers(
  state: SetupState,
  ctx: SetupContext,
): Promise<void> {
  const { existing, out } = state;
  ctx.head(
    4,
    ctx.t(
      "Access — who the bot answers at all",
      "Доступ — кому бот вообще отвечает",
    ),
  );
  ctx.print(
    `  ${C.y}${ctx.t("IMPORTANT:", "ВАЖНО:")}${C.x} ${ctx.t("Iva answers ONLY trusted Telegram IDs.", "Iva отвечает ТОЛЬКО доверенным Telegram ID.")}`,
  );
  ctx.print(
    `  ${ctx.t("Without at least one ID the bot stays silent to everyone (that's how your data is protected).", "Без хотя бы одного ID бот промолчит всем (так ваши данные защищены).")}`,
  );
  const ids = new Set(
    (existing.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  while (ids.size === 0) {
    ctx.print(
      `\n  ${ctx.t("Let's find your ID.", "Определим ваш ID.")} ${C.c}${ctx.t(`Open Telegram, find @${out.TELEGRAM_BOT_USERNAME || "your_bot"} and send it any message`, `Откройте Telegram, найдите @${out.TELEGRAM_BOT_USERNAME || "своего_бота"} и напишите ему любое сообщение`)}${C.x} ${ctx.t('(e.g. "hi").', "(напр. «привет»).")}`,
    );
    await ctx.ask(
      `  ${ctx.t("Sent the bot a message? press Enter", "Написали боту? нажмите Enter")}`,
    );
    await collectTelegramIds(ctx, ids, out.TELEGRAM_BOT_TOKEN);
  }
  out.TELEGRAM_ALLOWED_USER_IDS = [...ids].join(",");
  out.TELEGRAM_DIGEST_CHAT_ID =
    existing.TELEGRAM_DIGEST_CHAT_ID || [...ids][0] || "";
  ctx.print(
    `  → ${ctx.t("access granted to ID", "доступ разрешён ID")}: ${C.g}${out.TELEGRAM_ALLOWED_USER_IDS}${C.x}`,
  );
}

export async function askTelegramSettings(
  state: SetupState,
  ctx: SetupContext,
): Promise<Env> {
  await askTelegramBot(state, ctx);
  await askAllowedUsers(state, ctx);
  return state.out;
}

/** Шаг 5: часовой пояс, вольт, каталог данных, порт и адрес сервера. */
export async function askVaultAndPort(
  state: SetupState,
  ctx: SetupContext,
): Promise<Env> {
  const { out } = state;
  ctx.head(
    5,
    ctx.t("Timezone and memory storage", "Часовой пояс и хранилище памяти"),
  );
  ctx.print(
    `  ${ctx.t("The timezone lets Iva use your real local time, not the server's.", "Часовой пояс нужен, чтобы Iva понимала ваше реальное время, а не время сервера.")}`,
  );
  for (;;) {
    const candidate = await ctx.ask(
      `  ${ctx.t("Timezone (IANA, e.g. Asia/Almaty, Asia/Tashkent, Europe/Berlin)", "Часовой пояс (IANA, напр. Asia/Almaty, Asia/Tashkent, Europe/Moscow)")}`,
      out.ASSISTANT_TIMEZONE || "Asia/Almaty",
    );
    const timezone = validateTimeZone(candidate);
    if (timezone) {
      out.ASSISTANT_TIMEZONE = timezone;
      break;
    }
    ctx.print(
      `${C.r}  ${ctx.t("Unknown IANA timezone. Try again.", "Неизвестный часовой пояс IANA. Введите ещё раз.")}${C.x}`,
    );
  }
  out.ASSISTANT_VAULT_DIR =
    (await ctx.ask(
      `  ${ctx.t("Vault directory (memory + git backup)", "Каталог vault (память + git-бэкап)")}`,
      out.ASSISTANT_VAULT_DIR || "vault",
    )) || "vault";
  out.ASSISTANT_DATA_DIR = out.ASSISTANT_DATA_DIR || "data";
  // Off-the-beaten-path port: 3000/8000/8080 are often taken on a typical VPS (docker etc.). The server
  // listens on IVA_PORT and clients (poll bridge, digest, rollups) reach it via ASSISTANT_HOST. We check
  // the chosen port is free — otherwise the server would die with EADDRINUSE (silent exit → bot is mute).
  out.IVA_PORT = await ctx.pickPort(out.IVA_PORT || "8723");
  // For localhost, ASSISTANT_HOST MUST follow IVA_PORT: otherwise changing the port here
  // leaves bridge/cron clients on the old port (server moved, clients didn't) → the bot goes
  // mute. A custom non-localhost host (remote server) is kept as is.
  const localHost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(
    out.ASSISTANT_HOST || "",
  );
  out.ASSISTANT_HOST =
    !out.ASSISTANT_HOST || localHost
      ? `http://127.0.0.1:${out.IVA_PORT}`
      : out.ASSISTANT_HOST;
  return out;
}

/** Итог мастера: чем закончилась настройка. */
function printSetupSummary(
  state: SetupState,
  ctx: SetupContext,
  staging: boolean,
): void {
  const { out, provider } = state;
  const chosenModel = {
    ollama: out.OLLAMA_MODEL,
    opencode: out.OPENCODE_MODEL,
    openrouter: out.OPENROUTER_MODEL,
    codex: out.CODEX_MODEL,
    claude: out.CLAUDE_MODEL,
    custom: out.CUSTOM_MODEL,
    requesty: out.REQUESTY_MODEL,
  }[provider];
  ctx.print();
  ctx.hr();
  ctx.print(
    `${C.g}${C.b}  ✓ ${
      staging
        ? ctx.t(
            "Ready — settings validated for apply",
            "Готово к применению — настройки проверены",
          )
        : ctx.t(
            "Done — everything written to .env",
            "Готово — всё записано в .env",
          )
    }${C.x}`,
  );
  ctx.print(
    `  ${ctx.t("Provider", "Провайдер")}: ${provider} · ${ctx.t("Model", "Модель")}: ${C.g}${chosenModel}${C.x} · ${ctx.t("Voice", "Голос")}: ${out.DEEPGRAM_API_KEY ? out.DEEPGRAM_LANGUAGE : ctx.t("off (/menu → Voice)", "выкл (/menu → Голос)")} · ${ctx.t("Bot", "Бот")}: ${C.g}@${out.TELEGRAM_BOT_USERNAME}${C.x}`,
  );
  ctx.print(
    `  ${ctx.t("Access", "Доступ")}: ${out.TELEGRAM_ALLOWED_USER_IDS} · TZ: ${out.ASSISTANT_TIMEZONE} · vault: ${out.ASSISTANT_VAULT_DIR} · ${ctx.t("lang", "язык")}: ${out.AGENT_LANGUAGE}`,
  );
  ctx.hr();
}

/**
 * Запись .env: ещё раз проверяет выбранную модель и отдаёт собранные ответы писателю.
 * `staging` — запись идёт не в живой .env, а в файл-кандидат (iva config).
 */
export async function writeSetupEnv(
  state: SetupState,
  ctx: SetupContext,
  staging: boolean,
): Promise<Env> {
  const { out, provider } = state;
  const selected: { model: string; key: string | null } | undefined = {
    ollama: { model: "OLLAMA_MODEL", key: "OLLAMA_API_KEY" },
    opencode: { model: "OPENCODE_MODEL", key: "OPENCODE_API_KEY" },
    openrouter: { model: "OPENROUTER_MODEL", key: "OPENROUTER_API_KEY" },
    codex: { model: "CODEX_MODEL", key: null },
    claude: { model: "CLAUDE_MODEL", key: null },
    custom: { model: "CUSTOM_MODEL", key: "CUSTOM_API_KEY" },
    requesty: { model: "REQUESTY_MODEL", key: "REQUESTY_API_KEY" },
  }[provider];
  if (!selected) throw new Error(`unknown provider: ${provider}`);
  ctx.write(
    `  ${ctx.t("validating the selected model again…", "ещё раз проверяю выбранную модель…")} `,
  );
  const catOut = catalogProvider(provider);
  await ctx.validateModelSelection({
    provider: out.MODEL_PROVIDER,
    model: out[selected.model],
    key: selected.key ? out[selected.key] || undefined : undefined,
    dataDir: ctx.dataDirAbs(out),
    // Адрес своего эндпоинта: у остальных провайдеров он вшит в каталог.
    ...(catOut ? { base: providerBase(catOut, out) } : {}),
  });
  ctx.print(`${C.g}${ctx.t("ok", "ок")}${C.x}`);
  await ctx.writeEnv(out);
  printSetupSummary(state, ctx, staging);
  return out;
}
