// Provider/model/effort metadata for the /model and /think Telegram wizards.
// Static lists are suggestions only; selectable catalog providers must come from
// a successful live response. Codex also returns model-specific reasoning levels.
import { listCodexModelCatalog } from "./codex-oauth.ts";
import {
  claudeModelLabel,
  claudeReasoningLevels,
  claudeStatus,
  listClaudeModels,
  type ClaudeEnv,
} from "./claude-cli-status.ts";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.ts";

export interface ProviderCatalogEntry {
  label: string;
  // "key" — ключ обязателен; "oauth" — вход по подписке, ключа в .env нет; "key-optional" —
  // ключ есть, но эндпоинт может работать и без него (свой сервер без авторизации);
  // "cli" — ключа нет вовсе: вход живёт в чужом CLI на той же машине (claude).
  auth: "key" | "oauth" | "key-optional" | "cli";
  base?: string;
  // Адрес известен не всегда: у custom его задаёт владелец, и каталог знает только имя
  // переменной. Значение приходит от вызывающего — см. providerBase.
  baseVar: string | null;
  keyVar: string | null;
  modelVar: string;
  // null = дефолта нет, переменная обязательна (custom: модели чужого эндпоинта не угадать).
  def: string | null;
  // Vision-модель: своя переменная и свой дефолт. null у провайдера, который смотрит
  // картинку выбранной текстовой моделью (codex — подписка мультимодальна, custom —
  // дефолт назвать некому).
  visionVar: string | null;
  visionDef: string | null;
  models: string[];
}

export interface ModelOption {
  id: string;
  /** Подпись кнопки. Нет — кнопка показывает `id`. */
  label?: string;
  reasoningLevels: string[];
}

export interface FetchModelOptions {
  dataDir?: string;
  // Адрес эндпоинта для провайдера, у которого он не вшит (custom). Пусто — берётся base
  // каталога. Значение собирает вызывающий: только он читает свежий .env.
  base?: string;
  listCodexCatalog?: (options?: { dataDir?: string }) => Promise<ModelOption[]>;
  // Живой список моделей вендора claude (рукопожатие CLI). Подставлен ради теста:
  // половина CLI не импортирует agent/ и спрашивает CLI сама.
  listClaudeCatalog?: (env?: ClaudeEnv) => Promise<ModelOption[]>;
  // Окружение для чужого CLI: у сервиса оно своё, в тестах — своё.
  claudeEnv?: ClaudeEnv;
  fetchFn?: typeof fetch;
}

// Runtime accepts the stable protocol vocabulary. Telegram only offers the live
// model-specific subset; when the response is missing/broken it uses the conservative
// three-button fallback. `ultra` is intentionally absent from both lists.
export const EFFORTS = CANONICAL_REASONING_EFFORTS;
export const FALLBACK_EFFORTS = FALLBACK_REASONING_EFFORTS;

// A hung provider endpoint must not stall the bridge's single getUpdates loop.
const FETCH_TIMEOUT_MS = 10_000;

export class ModelCatalogError extends Error {
  declare readonly code: string;
  declare readonly status?: number;

  constructor(
    code: string,
    message: string,
    { status, cause }: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ModelCatalogError";
    this.code = code;
    this.status = status;
  }
}

// Зеркало MODEL_PROVIDERS из agent/lib/model-provider.ts: те же имена, те же переменные и
// те же дефолты обеих моделей. Импортировать оригинал нельзя (ADR-0003: эта половина грузится
// на инсталле, где authored tree может не быть), поэтому расхождение ловит тест по соседству.
export const CATALOG: Record<string, ProviderCatalogEntry> = {
  ollama: {
    label: "Ollama Cloud",
    auth: "key",
    base: "https://ollama.com/v1",
    baseVar: null,
    keyVar: "OLLAMA_API_KEY",
    modelVar: "OLLAMA_MODEL",
    def: "deepseek-v4-pro",
    visionVar: "OLLAMA_VISION_MODEL",
    visionDef: "gemma4:31b",
    // Mirrors the live GET /models list (checked 2026-07-28). Ollama Cloud retires tags without
    // notice — gemma3:12b went 410 on 2026-07-15 — so keep only IDs seen in the live response.
    // kimi-k3 is billed as "extra usage" on top of the plan (402 with an empty extra balance).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "glm-5.2",
      "minimax-m3",
      "gemma4:31b",
      "gpt-oss:120b",
    ],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
    base: "https://opencode.ai/zen/go/v1",
    baseVar: null,
    keyVar: "OPENCODE_API_KEY",
    modelVar: "OPENCODE_MODEL",
    def: "deepseek-v4-pro",
    // Живая проверка 2026-08-18: qwen3.7-plus отдаёт чистое описание, minimax-m3 подмешивает
    // в него <think>, gpt-5.6-luna отвечает 400. Список моделей картинки не гарантирует.
    visionVar: "OPENCODE_VISION_MODEL",
    visionDef: "qwen3.7-plus",
    // Mirrors OPENCODE_MODELS in scripts/setup/network.ts (bare IDs, no "opencode-go/" prefix).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4.1-flash",
      "kimi-k3",
      "kimi-k2.7-code",
      "glm-5.2",
      "minimax-m3",
      "qwen3.7-max",
      "grok-4.5",
    ],
  },
  codex: {
    label: "OpenAI (подписка)",
    auth: "oauth",
    baseVar: null,
    keyVar: null,
    modelVar: "CODEX_MODEL",
    def: "gpt-5.5",
    // Картинку смотрит выбранная текстовая модель подписки — своей переменной нет.
    visionVar: null,
    visionDef: null,
    // Кнопки экрана берутся из живого /models подписки (listCodexModelCatalog); здесь только
    // подпись того же списка. Живьём 23.09.2026 (client_version 0.156.0): gpt-6-sol, gpt-6-luna.
    models: ["gpt-5.5", "gpt-6-sol", "gpt-6-luna"],
  },
  claude: {
    label: "Claude (подписка Pro/Max)",
    // Ключа в .env нет: вход живёт в Claude Code CLI на той же машине (data/ его не хранит,
    // а ключ подписки Ива не видит вовсе).
    auth: "cli",
    baseVar: null,
    keyVar: null,
    modelVar: "CLAUDE_MODEL",
    def: "claude-fable-5-1",
    // Картинку смотрит выбранная текстовая модель подписки — своей переменной нет.
    visionVar: null,
    visionDef: null,
    // Вшитый список — запасной путь: живой приходит рукопожатием CLI (fetchModelOptions),
    // а он может не состояться (нет бинаря, нет входа, чужой вывод). Те же три id,
    // что у пикера: Haiku в экран не входит.
    models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5"],
  },
  openrouter: {
    label: "OpenRouter",
    auth: "key",
    base: "https://openrouter.ai/api/v1",
    baseVar: null,
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    def: "openai/gpt-5.1",
    visionVar: "OPENROUTER_VISION_MODEL",
    visionDef: "google/gemini-2.5-flash",
    // Always static (300+ live models don't fit inline buttons). Curated known-good
    // slugs only: every model here must support tool calling — Iva sends tool
    // definitions each turn (see the live test in scripts/setup/network.ts for the full check).
    models: [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "moonshotai/kimi-k3",
    ],
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    // Ключ опционален: локальный или self-hosted эндпоинт живёт без авторизации.
    auth: "key-optional",
    // Адрес статичным быть не может — его задаёт владелец, целиком, вместе с суффиксом
    // вида /v1. Каталог хранит только имя переменной: значение приходит от вызывающего,
    // который читает свежий .env (см. providerBase).
    baseVar: "CUSTOM_BASE_URL",
    keyVar: "CUSTOM_API_KEY",
    modelVar: "CUSTOM_MODEL",
    // Дефолта нет: какие модели у чужого адреса, знает только его владелец.
    def: null,
    visionVar: "CUSTOM_VISION_MODEL",
    visionDef: null,
    // Курировать нечего — список моделей приходит живым GET {base}/models, а если его нет,
    // мастер спрашивает id текстом.
    models: [],
  },
  requesty: {
    label: "Requesty",
    auth: "key",
    base: "https://router.requesty.ai/v1",
    baseVar: null,
    keyVar: "REQUESTY_API_KEY",
    modelVar: "REQUESTY_MODEL",
    def: "gpt-5.5",
    visionVar: "REQUESTY_VISION_MODEL",
    visionDef: "gemini-3.5-flash",
    // Always static, like OpenRouter: the live catalog has hundreds of models. Curated
    // managed policy ids (GET /v1/models/managed) that support tool calling; any
    // vendor/model id from GET /v1/models works as well.
    models: [
      "gpt-5.5",
      "gpt-5.4-mini",
      "claude-sonnet-5",
      "gemini-3.5-flash",
      "deepseek-v4-pro",
      "kimi-k3",
    ],
  },
};

// The one place the CLI half turns a configured MODEL_PROVIDER into a provider. Exact match,
// like the runtime resolver (agent/lib/model-provider.ts): an unknown name resolves to nothing
// rather than collapsing into Ollama, so the wizard, doctor, the update and the /menu screens
// all see the same broken configuration the agent refuses to start on (issue #161).
export function catalogProvider(
  name: string | undefined,
): ProviderCatalogEntry | undefined {
  return name !== undefined && Object.hasOwn(CATALOG, name)
    ? CATALOG[name]
    : undefined;
}

// The model a provider will actually be asked for, by the same rule the runtime uses
// (agent/lib/model-provider.ts `modelProviderModel`): trimmed, and blank means "not set",
// so the provider's own default answers. Every screen reads this instead of its own
// `|| default` or `|| "?"`, because one .env may not produce three different answers.
// The two halves are pinned together in the test next door.
export function catalogModel(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const provider = catalogProvider(name);
  if (!provider) return undefined;
  const configured = (env[provider.modelVar] ?? "").trim();
  const stripped =
    name === "opencode" ? configured.replace(/^opencode-go\//, "") : configured;
  // `|| undefined` на конце: у провайдера без дефолта (custom) пустая переменная — это не
  // модель, а незаполненная конфигурация. Рантайм на ней отказывается стартовать, и экраны
  // обязаны сказать «?», а не назвать модель, к которой никто не пойдёт.
  return stripped || provider.def || undefined;
}

// Базовый адрес провайдера. У известных четырёх он вшит; у custom его знает только .env,
// поэтому значение приходит аргументом: эта половина грузится и в мосте, где process.env
// протухает после записи в .env, и на инсталле, где authored tree может не быть (ADR-0003).
export function providerBase(
  provider: ProviderCatalogEntry,
  env: Readonly<Record<string, string | undefined>> = {},
): string | undefined {
  if (!provider.baseVar) return provider.base;
  return normalizeBaseUrl(env[provider.baseVar] ?? "") ?? undefined;
}

// Адрес, который ввёл владелец. Принимается только http(s)-URL целиком: без схемы
// (`api.example.com/v1`) fetch бросил бы «Failed to parse URL», и мастер объявил бы это
// сбоем сети. Хвостовые слэши срезаются — иначе к нему приклеится `//models`.
// Возвращает null, если строка адресом не является.
export function normalizeBaseUrl(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    new URL(value);
  } catch {
    return null;
  }
  return value;
}

// The .env keys a provider cannot work without. codex has no key — it signs in over OAuth
// (data/codex-auth.json), which is checked separately; custom needs its endpoint address but
// not necessarily a key. Shared by `iva doctor` and the setup wizard so one of them can never
// call a configuration complete that the other rejects.
export function providerEnvKeys(provider: ProviderCatalogEntry): string[] {
  return [
    ...(provider.baseVar ? [provider.baseVar] : []),
    ...(provider.auth === "key" && provider.keyVar ? [provider.keyVar] : []),
    provider.modelVar,
  ];
}

// Ollama Cloud and OpenCode Go both expose OpenAI-compatible reasoning_effort.
// Their /models payloads contain IDs only, so the API's common low/medium/high
// contract is the best available capability signal. Codex is richer: its live
// catalog carries a model-specific subset.
// custom is deliberately absent: an unknown endpoint has promised nothing about
// reasoning_effort, and sending it blind risks an HTTP 400 on every turn.
// claude carries levels per model (claudeReasoningLevels): the CLI sends them as
// output_config.effort, and only to models with adaptive thinking.
const REASONING_PROVIDERS = new Set(["ollama", "opencode", "codex", "claude"]);

export const providerSupportsReasoning = (provider: string): boolean =>
  REASONING_PROVIDERS.has(provider);
export const providerFallbackReasoningLevels = (provider: string): string[] =>
  providerSupportsReasoning(provider) ? [...FALLBACK_EFFORTS] : [];

const optionsFor = (
  provider: string,
  models: readonly string[],
): ModelOption[] =>
  models.map((id) => {
    const claude = provider === "claude";
    const label = claude ? claudeModelLabel(id) : "";
    return {
      id,
      ...(label && label !== id ? { label } : {}),
      reasoningLevels: claude
        ? claudeReasoningLevels(id)
        : providerFallbackReasoningLevels(provider),
    };
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const validOptions = (provider: string, entries: unknown): ModelOption[] => {
  if (!Array.isArray(entries)) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned a malformed model catalog",
    );
  }
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const value of entries as unknown[]) {
    const entry = isRecord(value) ? value : null;
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      throw new ModelCatalogError(
        "catalog_invalid",
        "provider returned a malformed model entry",
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      reasoningLevels:
        entry && Array.isArray(entry.reasoningLevels)
          ? ([...(entry.reasoningLevels as unknown[])] as string[])
          : providerFallbackReasoningLevels(provider),
    });
  }
  if (!options.length) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned an empty model catalog",
    );
  }
  return options;
};

// Selectable options come only from the live provider catalog. Static lists remain
// display metadata and OpenRouter suggestions; they must never resurrect retired models.
export async function fetchModelOptions(
  provider: string,
  key?: string,
  options: FetchModelOptions = {},
): Promise<ModelOption[]> {
  const cat = CATALOG[provider];
  if (!cat) return [];
  const endpoint = options.base ?? cat.base;
  // Провайдер, чей адрес задаёт владелец, без адреса не спрашивается вовсе: ходить некуда,
  // и молчаливый пустой список выглядел бы как «у эндпоинта нет моделей».
  if (cat.baseVar && !endpoint) {
    throw new ModelCatalogError(
      "base_missing",
      `${cat.baseVar} is not set — nowhere to ask for models`,
    );
  }
  const live = await liveCatalog(provider, key, endpoint, options);
  return live ?? optionsFor(provider, cat.models); // openrouter и остальные — вшитый список
}

/** Живой каталог провайдера; null — спрашивать некого или не у кого (openrouter и прочие
 *  живут вшитым списком). Отказы поднимаются сюда же ошибкой каталога. */
async function liveCatalog(
  provider: string,
  key: string | undefined,
  endpoint: string | undefined,
  options: FetchModelOptions,
): Promise<ModelOption[] | null> {
  try {
    return await liveSource(provider, key, endpoint, options);
  } catch (e) {
    if (e instanceof ModelCatalogError) throw e;
    throw new ModelCatalogError(
      "catalog_unavailable",
      "couldn't load the live model catalog",
      {
        cause: e,
      },
    );
  }
}

/** У каждого провайдера свой источник списка; null — источника нет вовсе. */
async function liveSource(
  provider: string,
  key: string | undefined,
  endpoint: string | undefined,
  options: FetchModelOptions,
): Promise<ModelOption[] | null> {
  const {
    dataDir,
    listCodexCatalog = listCodexModelCatalog,
    listClaudeCatalog = listClaudeModels,
    claudeEnv = process.env,
    fetchFn = fetch,
  } = options;
  if (provider === "codex")
    return validOptions(
      provider,
      await listCodexCatalog(dataDir ? { dataDir } : {}),
    );
  // У claude каталога в сети нет: список отдаёт чужой CLI рукопожатием, а когда он не
  // отвечает (нет бинаря, нет входа, чужой вывод), остаётся вшитый список — это не
  // ошибка, а запасной путь: модель всё равно надо выбрать во время настройки.
  if (provider === "claude")
    return await claudeCatalog(listClaudeCatalog, claudeEnv);
  if (endpoint && provider !== "openrouter" && provider !== "requesty")
    return await httpCatalog(provider, key, endpoint, fetchFn);
  return null;
}

/** Список моделей подписки claude; сбой рукопожатия — не ошибка, а вшитый список. */
async function claudeCatalog(
  list: NonNullable<FetchModelOptions["listClaudeCatalog"]>,
  env: ClaudeEnv,
): Promise<ModelOption[] | null> {
  try {
    return (await list(env)).map((option) => ({
      id: option.id,
      ...(option.label ? { label: option.label } : {}),
      reasoningLevels: [...option.reasoningLevels],
    }));
  } catch {
    return null;
  }
}

/** Каталог чужого эндпоинта: GET {base}/models и разбор ответа. */
async function httpCatalog(
  provider: string,
  key: string | undefined,
  endpoint: string,
  fetchFn: typeof fetch,
): Promise<ModelOption[]> {
  const res = await fetchFn(`${endpoint}/models`, {
    // Ключа может не быть вовсе (custom на своём сервере) — тогда идём без заголовка,
    // а не с «Bearer undefined».
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ModelCatalogError(
      "auth_rejected",
      `provider rejected credentials (${res.status})`,
      { status: res.status },
    );
  }
  if (!res.ok) {
    throw new ModelCatalogError(
      "catalog_unavailable",
      `model catalog returned HTTP ${res.status}`,
      { status: res.status },
    );
  }
  return validOptions(provider, await catalogData(res)).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

/** Тело ответа `{data: [...]}`; всё остальное — недописанный каталог. */
async function catalogData(res: Response): Promise<unknown[]> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned invalid catalog JSON",
      { cause },
    );
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned a malformed model catalog",
    );
  }
  return body.data as unknown[];
}

// Compatibility for setup or future CLI consumers that only need IDs.
export async function fetchModels(
  provider: string,
  key?: string,
  opts: FetchModelOptions = {},
): Promise<string[]> {
  return (await fetchModelOptions(provider, key, opts)).map(
    (option) => option.id,
  );
}

// Cheap key validity probe (same lenient policy as scripts/setup/network.ts: network flake ⇒ accept).
// Returns null when the key looks fine, or a short human-readable reason.
export async function checkKey(
  provider: string,
  key: string,
  base?: string,
): Promise<string | null> {
  const cat = CATALOG[provider];
  const endpoint = base ?? cat?.base;
  // У вендора без ключа (claude) в .env проверять нечего: его вход живёт в CLI на этой же
  // машине, и статус говорит то же, что скажет доктор. Ключ тут не читается вовсе.
  if (cat?.auth === "cli") return await claudeKeyState();
  if (!cat || !endpoint) return null;
  // OpenRouter has a dedicated auth-only endpoint; the others validate via /models.
  const url =
    provider === "openrouter" ? `${endpoint}/key` : `${endpoint}/models`;
  return await probeKey(url, key);
}

async function claudeKeyState(): Promise<string | null> {
  const status = await claudeStatus(process.env);
  return status.ready ? null : status.hint;
}

/** Мягкая политика: 401/403 — отказ ключа, сетевой сбой — «похоже, ключ в порядке». */
async function probeKey(url: string, key: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403)
      return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null;
  }
}
