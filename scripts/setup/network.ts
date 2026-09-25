// Сетевые проверки мастера установки: ключи провайдеров, списки моделей, бот Telegram и
// кто ему писал. `fetch` приходит параметром: в бою глобальный, в тестах подменный.
import {
  probeOpenRouterModel,
  probeRequestyModel,
} from "../lib/model-validation.ts";
import { openrouterErrReason } from "./openrouter.ts";
import {
  C,
  type SetupBackend,
  type TelegramBot,
  type TelegramUser,
  type ThrownSetupError,
} from "./steps.ts";

// Эти типы описывают удачный ответ и не меняют прежнего чтения полей у кривого ответа.
type ModelListResponse = { data?: Array<{ id: string }> };
type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramBot;
};
type TelegramFrom = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
};
type TelegramMessage = { from?: TelegramFrom };
export type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
type TelegramUpdatesResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramUpdate[];
};

export type NetworkChecks = Pick<
  SetupBackend,
  | "ollamaModels"
  | "opencodeCheck"
  | "opencodeModels"
  | "openrouterKeyCheck"
  | "openrouterModelCheck"
  | "requestyKeyCheck"
  | "requestyModelCheck"
  | "deepgramCheck"
  | "telegramGetMe"
  | "fetchTelegramUserIds"
>;

type Net = {
  readonly fetchFn: typeof fetch;
  readonly t: (en: string, ru: string) => string;
  readonly print: (...args: unknown[]) => void;
};

const OLLAMA_BASE = "https://ollama.com/v1";
const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REQUESTY_BASE = "https://router.requesty.ai/v1";
// OpenCode Go (ex-Zen; путь /zen/ устарел, но живой) — голый ID модели без префикса
// "opencode-go/": ровно его ждёт /v1 в теле запроса (с префиксом отвечает "Model ... is not
// supported"). Мастер берёт живой список из GET /models; этот — только запасной без сети.
export const OPENCODE_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "kimi-k3",
  "kimi-k2.7-code",
  "glm-5.2",
  "minimax-m3",
  "qwen3.7-max",
  "grok-4.5",
];

const TOOL_ISSUE =
  /tool use|function call|no endpoints found that support tool/i;
const MODEL_REFUSALS = new Set(["model_unavailable", "auth_rejected"]);

export function createNetworkChecks(net: Net): NetworkChecks {
  return {
    ollamaModels: (key) => ollamaModels(net, key),
    opencodeCheck: (key) =>
      authRejection(
        net,
        `${OPENCODE_BASE}/models`,
        bearer(key),
        net.t(
          "OpenCode rejected the key (401/403). Check your Go subscription and that the key was copied in full.",
          "OpenCode не принял ключ (401/403). Проверьте подписку Go и что ключ скопирован целиком.",
        ),
      ),
    opencodeModels: (key) => opencodeModels(net, key),
    // OpenRouter: ключ проверяем через GET /key (требует auth, токенов не тратит).
    openrouterKeyCheck: (key) =>
      authRejection(
        net,
        `${OPENROUTER_BASE}/key`,
        bearer(key),
        net.t(
          "OpenRouter rejected the key (401/403). Copy it in full from https://openrouter.ai/keys (starts with sk-or-).",
          "OpenRouter не принял ключ (401/403). Скопируйте целиком с https://openrouter.ai/keys (начинается с sk-or-).",
        ),
      ),
    openrouterModelCheck: (key, model) => openrouterModelCheck(net, key, model),
    // Requesty: GET /models с ключом отвечает 403 на чужой ключ и токенов не тратит.
    requestyKeyCheck: (key) =>
      authRejection(
        net,
        `${REQUESTY_BASE}/models`,
        bearer(key),
        net.t(
          "Requesty rejected the key (401/403). Copy it in full from https://app.requesty.ai/api-keys.",
          "Requesty не принял ключ (401/403). Скопируйте целиком с https://app.requesty.ai/api-keys.",
        ),
      ),
    requestyModelCheck: (key, model) => requestyModelCheck(net, key, model),
    deepgramCheck: (key) =>
      authRejection(
        net,
        "https://api.deepgram.com/v1/projects",
        { Authorization: `Token ${key}` },
        net.t(
          "Deepgram rejected the key (401/403). Copy the key in full from the API Keys page.",
          "Deepgram не принял ключ (401/403). Скопируйте ключ целиком со страницы API Keys.",
        ),
      ),
    telegramGetMe: (token) => telegramGetMe(net, token),
    fetchTelegramUserIds: (token) => fetchTelegramUserIds(net, token),
  };
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const isAuthStatus = (status: number) => status === 401 || status === 403;

/** Ключ отвергнут (401/403) — слова отказа; любой другой ответ и сбой сети не блокируют. */
async function authRejection(
  net: Net,
  url: string,
  headers: Record<string, string>,
  refusal: string,
): Promise<string | null> {
  try {
    const res = await net.fetchFn(url, { headers });
    return isAuthStatus(res.status) ? refusal : null;
  } catch {
    return null;
  }
}

/** ID моделей из ответа /models по алфавиту. */
export function modelIds(body: ModelListResponse): string[] {
  return (body.data || []).map((model) => model.id).sort();
}

async function ollamaModels(net: Net, key: string): Promise<string[]> {
  const res = await net.fetchFn(`${OLLAMA_BASE}/models`, {
    headers: bearer(key),
  });
  if (isAuthStatus(res.status))
    throw Object.assign(new Error("key rejected"), { auth: true });
  if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
  return modelIds((await res.json()) as ModelListResponse);
}

// Живой список моделей Go (голые ID). Каталог плывёт (kimi-k3 появилась, qwen3.7 убрали),
// поэтому вшитый список — только запасной, когда адрес недоступен.
async function opencodeModels(net: Net, key: string): Promise<string[]> {
  try {
    const res = await net.fetchFn(`${OPENCODE_BASE}/models`, {
      headers: bearer(key),
    });
    if (!res.ok) return OPENCODE_MODELS;
    return idsOrFallback(modelIds((await res.json()) as ModelListResponse));
  } catch {
    return OPENCODE_MODELS;
  }
}

const idsOrFallback = (ids: string[]) => (ids.length ? ids : OPENCODE_MODELS);

// OpenRouter: ЖИВОЙ тест модели — настоящий chat/completions выбранным слагом с минимальным
// tools-блоком: Iva — агент, и chat-only модель без function calling сломается на первом же
// ходе. Не-200 → строка отказа → мастер спросит снова. Обёртку "Provider returned error"
// разворачивает openrouterErrReason: настоящая причина лежит в error.metadata.raw.
async function openrouterModelCheck(
  net: Net,
  key: string,
  model: string,
): Promise<string | null> {
  try {
    const result = await probeOpenRouterModel(
      { model, key },
      { fetchFn: net.fetchFn, errorReason: openrouterErrReason },
    );
    if (!result.answered) {
      net.print(
        `${C.y}${net.t("(model replied empty — maybe a reasoning model / max_tokens; proceeding)", "(модель ответила пусто — возможно reasoning-модель / max_tokens; продолжаю)")}${C.x}`,
      );
    }
    return null;
  } catch (error) {
    return modelRefusal(net, error as ThrownSetupError);
  }
}

// Requesty: тот же живой тест модели с tools-блоком, что у OpenRouter. Причину отказа
// Requesty кладёт прямо в error.message, разворачивать нечего.
async function requestyModelCheck(
  net: Net,
  key: string,
  model: string,
): Promise<string | null> {
  try {
    const result = await probeRequestyModel(
      { model, key },
      { fetchFn: net.fetchFn },
    );
    if (!result.answered) {
      net.print(
        `${C.y}${net.t("(model replied empty, maybe a reasoning model / max_tokens; proceeding)", "(модель ответила пусто, возможно reasoning-модель / max_tokens; продолжаю)")}${C.x}`,
      );
    }
    return null;
  } catch (error) {
    return requestyRefusal(net, error as ThrownSetupError);
  }
}

// Подсказка своя: id Requesty бывают и без вендора (managed policy вида gpt-5.5).
function requestyRefusal(net: Net, caught: ThrownSetupError): string {
  if (!MODEL_REFUSALS.has(codeOf(caught))) return modelRefusal(net, caught);
  const reason = caught.message;
  const hint = TOOL_ISSUE.test(reason)
    ? net.t(
        "Iva needs a chat model with tool/function calling, pick one on https://www.requesty.ai/models.",
        "Iva нужна chat-модель с поддержкой инструментов (function calling), выберите такую на https://www.requesty.ai/models.",
      )
    : net.t(
        "pick another model on https://www.requesty.ai/models.",
        "выберите другую модель на https://www.requesty.ai/models.",
      );
  return net.t(
    `the model can't be used: ${reason}. ${hint}`,
    `модель не подходит: ${reason}. ${hint}`,
  );
}

function modelRefusal(net: Net, caught: ThrownSetupError): string {
  if (MODEL_REFUSALS.has(codeOf(caught)))
    return unusableModel(net, caught.message);
  return net.t(
    `request failed: ${caught.message}`,
    `запрос не прошёл: ${caught.message}`,
  );
}

const codeOf = (caught: ThrownSetupError | null | undefined) =>
  caught?.code ?? "";

function unusableModel(net: Net, reason: string): string {
  const hint = TOOL_ISSUE.test(reason)
    ? net.t(
        "Iva needs a chat model with tool/function calling — pick one on https://openrouter.ai/models (form vendor/model).",
        "Iva нужна chat-модель с поддержкой инструментов (function calling) — выберите такую на https://openrouter.ai/models (вид vendor/model).",
      )
    : net.t(
        "pick another model on https://openrouter.ai/models (form vendor/model).",
        "выберите другую модель на https://openrouter.ai/models (вид vendor/model).",
      );
  return net.t(
    `the model can't be used: ${reason}. ${hint}`,
    `модель не подходит: ${reason}. ${hint}`,
  );
}

async function telegramGetMe(
  net: Net,
  token: string,
): Promise<TelegramBot | undefined> {
  const res = await net.fetchFn(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json()) as TelegramGetMeResponse;
  if (!body.ok) throw new Error(body.description || "token rejected");
  return body.result;
}

async function fetchTelegramUserIds(
  net: Net,
  token: string,
): Promise<TelegramUser[]> {
  const res = await net.fetchFn(
    `https://api.telegram.org/bot${token}/getUpdates`,
  );
  const body = (await res.json()) as TelegramUpdatesResponse;
  if (!body.ok) throw new Error(body.description || "getUpdates failed");
  return telegramUsers(body.result, net.t("(no name)", "(без имени)"));
}

/** Кто писал боту: по одному на ID, в порядке первого сообщения. */
export function telegramUsers(
  updates: readonly TelegramUpdate[] | undefined,
  noName: string,
): TelegramUser[] {
  const seen = new Map<string, TelegramUser>();
  for (const update of updates ?? []) addSender(seen, senderOf(update), noName);
  return [...seen.values()];
}

const senderOf = (update: TelegramUpdate) =>
  (update.message || update.edited_message)?.from;

function addSender(
  seen: Map<string, TelegramUser>,
  from: TelegramFrom | undefined,
  noName: string,
): void {
  if (!from || seen.has(String(from.id))) return;
  seen.set(String(from.id), {
    id: String(from.id),
    name: senderName(from, noName),
  });
}

function senderName(from: TelegramFrom, noName: string): string {
  const name = [
    from.first_name,
    from.last_name,
    from.username ? `@${from.username}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return name || noName;
}
