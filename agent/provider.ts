import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APICallError,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  imageMediaType,
  imageRefsIn,
  MAX_ATTACHED_IMAGES,
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
} from "./lib/attachment-ref.ts";
import { resolveAttachmentPath } from "./lib/telegram-media-cache.ts";
import { claudeContextWindow, makeClaudeCliModel } from "./lib/claude-cli.ts";
import {
  CODEX_BASE_URL,
  codexAuthHeaders,
  forceRefreshAccessToken,
} from "./lib/codex-auth.ts";
import { resolveContextWindow } from "./lib/context-window.ts";
import {
  MODEL_PROVIDERS,
  resolveModelProvider,
  type ModelProviderName,
} from "./lib/model-provider.ts";
import { CANONICAL_REASONING_EFFORTS as EFFORTS } from "./lib/reasoning-levels.ts";
import { toolNameWireMiddleware } from "./lib/tool-wire-name.ts";
import { repeatGuardMiddleware } from "./lib/repeat-guard.ts";
import { compactionUsageMiddleware, type UsageLabel } from "./lib/usage-tap.ts";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type ModelStreamPart =
  Awaited<
    ReturnType<ReturnType<typeof wrapLanguageModel>["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Единый источник конфигурации провайдера модели. Имя, текстовую и vision-модель выбирает
// resolveModelProvider — раз при старте и одинаково для рантайма и учёта расхода; неизвестное
// MODEL_PROVIDER валит загрузку модуля здесь же, до первого запроса к провайдеру.
// ollama/opencode/openrouter — OpenAI-совместимы (chat/completions, статичный ключ из .env).
// codex — личная подписка OpenAI (ChatGPT): Responses API + OAuth-токен (data/codex-auth.json,
// `iva login`). claude — подписка Claude Pro/Max через установленный Claude Code CLI: ни
// адреса, ни ключа, ход уходит процессу `claude` (agent/lib/claude-cli.ts).
// custom — тот же OpenAI-совместимый провод, но адрес задаёт владелец
// (CUSTOM_BASE_URL): чужой прокси, vLLM, LiteLLM, вендорская подписка. Имена моделей и их
// дефолты живут в agent/lib/model-provider.ts (там же и переменные *_VISION_MODEL); здесь
// остаётся то, что из .env не задаётся ни у кого: адрес, ключ и окно контекста.
const selected = resolveModelProvider();
const PROVIDER = selected.name;

// Читается ровно в одном месте — PROVIDERS[PROVIDER] ниже, поэтому запись выбранного
// провайдера в поле соседа невозможна. satisfies держит таблицу полной.
const PROVIDERS = {
  ollama: {
    // OLLAMA_BASE_URL — не пользовательская настройка, а шов для тестов: replica-смоук
    // подставляет сюда локальный mock-провайдер (scripts/lib/mock-openai-server.ts).
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    contextWindow: 131072,
  },
  opencode: {
    // Продукт переименован Zen → Go, но API живёт на легаси-пути /zen/ (у /go/v1 — 404).
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    contextWindow: 131072,
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    contextWindow: 131072,
  },
  codex: {
    baseURL: CODEX_BASE_URL,
    apiKey: undefined, // авторизация — OAuth-токен подписки, не статичный ключ (см. codexFetch)
    contextWindow: 272000,
  },
  claude: {
    // Адрес никто не открывает: модель — процесс `claude`, и строка называет вендора в
    // журнале и в провайдер-опциях. Ключа нет намеренно: авторизацию держит CLI (подписка
    // владельца), и ключ в .env увёл бы ход мимо подписки — agent/lib/claude-cli.ts такой
    // .env отвергает, а не молча берёт его.
    baseURL: "process://claude",
    apiKey: undefined,
    contextWindow: claudeContextWindow(selected.model),
  },
  custom: {
    // Адрес целиком задаёт владелец, вместе с суффиксом вида /v1 — как у ollama
    // (https://ollama.com/v1). Хвостовой слэш срезаем: к адресу приклеивается /chat/completions.
    // Пустое значение ловится ниже: таблица строится целиком на загрузке модуля, и падать
    // на чужой переменной ей нельзя.
    baseURL: (process.env.CUSTOM_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    // Ключ необязателен: локальный или self-hosted эндпоинт живёт без авторизации, и тогда
    // openai-compatible не ставит заголовок Authorization вовсе.
    apiKey: process.env.CUSTOM_API_KEY,
    contextWindow: 131072,
  },
} as const satisfies Record<
  ModelProviderName,
  {
    baseURL: string;
    apiKey: string | undefined;
    contextWindow: number;
  }
>;

export const providerName = PROVIDER;
const contextWindowVariable =
  `${PROVIDER.toUpperCase()}_CONTEXT_WINDOW` as const;
export const providerConfig = {
  ...PROVIDERS[PROVIDER],
  contextWindow: resolveContextWindow(
    contextWindowVariable,
    process.env[contextWindowVariable],
    PROVIDERS[PROVIDER].contextWindow,
  ),
  textModel: selected.model,
  // Модель для картинок — из того же резолвера (переменные *_VISION_MODEL, дефолты там же).
  // У codex это та же текстовая модель: подписка мультимодальна.
  visionModel: selected.visionModel,
};

// Адрес чужого эндпоинта не угадывается: без него запрос ушёл бы в пустую строку и агент
// молчал бы, не назвав причину. Отказ здесь же, на загрузке модуля, — как у неизвестного
// MODEL_PROVIDER, и ровно тем же списком обязательных ключей ругается `iva doctor`.
if (providerName === "custom" && !providerConfig.baseURL)
  throw new Error(
    "MODEL_PROVIDER=custom requires CUSTOM_BASE_URL (OpenAI-compatible base, e.g. https://api.example.com/v1) — run: iva config",
  );

// --- OpenCode Go: что провайдер требует от клиента --------------------------------------------
// С сентября 2026 Go принимает запрос только от клиента, который (1) называет себя своим
// User-Agent, а не именем SDK, и (2) шлёт стабильный ID диалога в x-opencode-session. Без них
// каждый ход падает 4xx MissingSessionID (https://opencode.ai/docs/go/#where-can-i-use-it).
// ID диалога — sessionId eve: agent.ts получает его на session.started и строит модель под
// него. Там, где сессии нет (планировщик, vision-пробник, describeImage), идёт один ID на
// процесс: заголовок обязан быть всегда, пустой не уходит никогда. Остальным провайдерам
// заголовки не достаются — их провод остаётся ровно таким, каким был.
function readOwnVersion(): string {
  // От cwd, не от import.meta.url: authored-модули инлайнятся в кэш eve (см. lib/data-dir.ts).
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    );
    if (isRecord(parsed) && typeof parsed.version === "string") {
      const version = parsed.version.trim();
      if (version.length > 0) return version;
    }
  } catch {
    /* версия нужна только для User-Agent — без неё ход не падает */
  }
  return "0";
}
export const IVA_USER_AGENT = `iva/${readOwnVersion()}`;
const PROCESS_SESSION_ID = `iva-${randomUUID()}`;

/**
 * ID диалога на проводе: sessionId eve как есть, без него — ID процесса. Им подписан
 * x-opencode-session у Go и prompt_cache_key у Codex.
 */
function wireSessionId(sessionId?: string): string {
  const id = (sessionId ?? "").trim();
  return id.length > 0 ? id : PROCESS_SESSION_ID;
}

/** Заголовки клиента для активного провайдера. Требует их только Go; остальным — ничего. */
export function providerRequestHeaders(
  sessionId?: string,
): Record<string, string> | undefined {
  if (providerName !== "opencode") return undefined;
  return {
    "x-opencode-session": wireSessionId(sessionId),
    "user-agent": IVA_USER_AGENT,
  };
}

// AI SDK ставит свой User-Agent (`ai/… ai-sdk/… runtime/node.js`) поверх заголовков
// провайдера — ровно то «имя SDK», которое Go отказывается принимать. Поэтому у Go свой
// fetch: имя клиента ставится в самом запросе, после SDK. ID диалога SDK не трогает,
// он едет обычными заголовками модели.
export const opencodeFetch: typeof fetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("user-agent", IVA_USER_AGENT);
  return fetch(input, { ...init, headers });
};

// THINKING_EFFORT (.env, пишут /model и /think в Telegram): reasoning-усилие модели.
// Codex получает его через providerOptions.openai.reasoningEffort ниже. Ollama Cloud
// и OpenCode Go говорят на OpenAI-compatible chat/completions; eve передаёт им
// provider-agnostic reasoning как reasoning_effort (см. compatibleThinkingEffort).
// Уровни — из общего каталога мастера, чтобы кнопки и рантайм не разъезжались.
const effortRaw = (process.env.THINKING_EFFORT ?? "").toLowerCase();
export const thinkingEffort = EFFORTS.includes(effortRaw)
  ? effortRaw
  : undefined;
const COMPATIBLE_EFFORTS = ["low", "medium", "high"] as const;
type CompatibleEffort = (typeof COMPATIBLE_EFFORTS)[number];
// CUSTOM_REASONING=1 (.env): владелец custom-эндпоинта подтверждает, что тот понимает
// reasoning_effort (Meta Model API, vLLM с reasoning-моделью). По умолчанию — не шлём.
const customReasoning =
  selected.name === "custom" && process.env.CUSTOM_REASONING === "1";
export const compatibleThinkingEffort: CompatibleEffort | undefined =
  (selected.compatibleReasoning || customReasoning) &&
  (COMPATIBLE_EFFORTS as readonly string[]).includes(effortRaw)
    ? (effortRaw as CompatibleEffort)
    : undefined;

// --- Codex (подписка ChatGPT): Responses API через @ai-sdk/openai ----------------------------
// Кастомный fetch: перед КАЖДЫМ запросом подставляет свежий Bearer + ChatGPT-Account-ID
// (getAccessToken рефрешит истёкший токен) и форсит store:false — бэкенд подписки stateless,
// историю eve шлёт целиком каждый ход. Тело патчим здесь же (точка правки, если бэкенд строже).
type CodexAuthExpiredError = Error & { code: "CODEX_AUTH_EXPIRED" };

function codexAuthExpiredError(cause?: unknown): CodexAuthExpiredError {
  return Object.assign(
    new Error(
      "Codex auth rejected (401 token_expired); run `iva login` to sign in again",
      cause === undefined ? undefined : { cause },
    ),
    { code: "CODEX_AUTH_EXPIRED" as const },
  );
}

function isCodexAuthFailureCode(value: unknown): boolean {
  return value === "token_expired" || value === "invalid_token";
}

async function isCodexAuthFailure(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  let text: string;
  try {
    text = await response.clone().text();
  } catch {
    return true;
  }
  if (text.trim().length === 0) return true;
  try {
    const body: unknown = JSON.parse(text);
    if (
      isRecord(body) &&
      (isCodexAuthFailureCode(body.code) ||
        isCodexAuthFailureCode(body.error) ||
        (isRecord(body.error) && isCodexAuthFailureCode(body.error.code)))
    )
      return true;
  } catch {
    /* не-JSON может всё ещё назвать код ошибки */
  }
  return /\b(?:token_expired|invalid_token)\b/u.test(text);
}

async function codexRequestHeaders(
  init: RequestInit | undefined,
): Promise<Headers> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(await codexAuthHeaders()))
    headers.set(key, value);
  return headers;
}

export const codexFetch: typeof fetch = async (input, init) => {
  let headers = await codexRequestHeaders(init);
  let body = init?.body;
  if (
    typeof body === "string" &&
    String((input as Request).url ?? input).endsWith("/responses")
  ) {
    try {
      const j: unknown = JSON.parse(body);
      if (!isRecord(j)) throw new TypeError("Responses body is not an object");
      j.store = false;
      delete j.previous_response_id;
      // eve 0.47+ инжектит это поле для моделей openai/*, приватный бэкенд подписки его не понимает
      // и отвечает 400.
      delete j.safety_identifier;
      // store:false → бэкенд ничего не персистит, поэтому любой server-side id в input — это эхо
      // прошлого ответа, которого на сервере уже нет: item_reference (ссылка без контента) и даже
      // echoed id у инлайн-item ловят "Item '<id>' not found. Items are not persisted...".
      // Контент истории уже инлайнится целиком (store:false задан на этапе сборки тела, см.
      // codexProviderOptions), поэтому ссылки режем, а id-эхо у остальных item'ов вычищаем.
      const input = j.input;
      if (Array.isArray(input)) {
        const filteredInput = input.filter(
          (item) => !isRecord(item) || item.type !== "item_reference",
        );
        for (const item of filteredInput) if (isRecord(item)) delete item.id;
        j.input = filteredInput;
      }
      body = JSON.stringify(j);
    } catch {
      /* не JSON — не трогаем */
    }
  }
  const response = await fetch(input, { ...init, headers, body });
  if (typeof body !== "string" || !(await isCodexAuthFailure(response)))
    return response;

  try {
    await forceRefreshAccessToken();
    headers = await codexRequestHeaders(init);
  } catch (cause) {
    throw codexAuthExpiredError(cause);
  }

  const retry = await fetch(input, { ...init, headers, body });
  if (retry.status === 401) throw codexAuthExpiredError();
  return retry;
};

// Провайдер-опции codex на этапе СБОРКИ тела (не пост-фактум в codexFetch): store:false
// и reasoning-усилие из THINKING_EFFORT.
// store:false: без него @ai-sdk/openai берёт store:true по умолчанию и реплеит прошлые ответы
// ассистента как item_reference (голая ссылка на msg_-item, без контента); codexFetch затем
// ставит store:false — и stateless-бэкенд подписки не находит item → сессия падает со второго
// запроса ("Item ... not found. Items are not persisted when store is set to false").
// store:false заставляет SDK инлайнить историю целиком.
// reasoningSummary:null гасит побочный эффект SDK: при заданном reasoningEffort он сам
// добавляет summary:"detailed" в reasoning-блок. Summary нам не нужен (обратно модели едет
// encrypted_content, владельцу рассуждение не показывается), а лишний параметр — лишний шанс
// на 400 от бэкенда.
// forceReasoning:true: SDK решает «рассуждающая ли модель» по префиксу id (o1/o3/gpt-5…) и
// для незнакомой серии молча выбрасывает reasoningEffort ("not supported for non-reasoning
// models"), шлёт system вместо developer и не просит reasoning.encrypted_content. Живой
// прогон 23.09.2026: gpt-6-sol и gpt-6-luna уходили без reasoning. Все модели подписки
// рассуждающие (у каждой supported_reasoning_levels в /models), поэтому флаг общий.
// strict:false на каждом инструменте - явно, как Hermes в своём Codex-адаптере. AI SDK поле
// не шлёт, а Responses API без него включает строгий режим сам: тогда все поля схемы
// обязательны, и модель забивает необязательные мусором (живой прогон 13.09.2026:
// luna слала в remind `cron: ":"`, `id: ":? "`, получала «give exactly one of at or cron»
// и повторяла это 33 раза, пока висело «Работаю»).
// promptCacheKey (в теле prompt_cache_key) — ID диалога, как у Codex CLI: бэкенд по нему
// ведёт шаги одного диалога к одному кэшу, и префикс прошлого шага читается из кэша. Без
// ключа соседние шаги попадали в кэш через раз. Без сессии ключ — ID процесса (wireSessionId).
export function codexProviderOptions(
  sessionId?: string,
): LanguageModelMiddleware {
  const promptCacheKey = wireSessionId(sessionId);
  return {
    transformParams: ({ params }) =>
      Promise.resolve({
        ...params,
        tools: params.tools?.map((tool) =>
          tool.type === "function" ? { ...tool, strict: false } : tool,
        ),
        providerOptions: {
          ...params.providerOptions,
          openai: {
            ...params.providerOptions?.openai,
            store: false,
            forceReasoning: true,
            promptCacheKey,
            ...(thinkingEffort
              ? { reasoningEffort: thinkingEffort, reasoningSummary: null }
              : {}),
          },
        },
      }),
  };
}

/**
 * Строит Codex-модель (Responses API подписки). Общая для agent.ts и vision.ts; sessionId —
 * ключ кэша промпта (см. codexProviderOptions).
 */
export function makeCodexModel(
  model: string = providerConfig.textModel,
  sessionId?: string,
) {
  const openai = createOpenAI({
    baseURL: CODEX_BASE_URL,
    apiKey: "chatgpt-subscription",
    fetch: codexFetch,
  });
  return wrapLanguageModel({
    model: openai.responses(model),
    middleware: codexProviderOptions(sessionId),
  });
}

// --- Картинки из Vault → в запрос модели ----------------------------------------------------
// Модель чата, которая сама видит картинки, получает пиксели, а не пересказ vision-модели.
// В тексте хода едет путь (`vault/attachments/<дата>/<файл>`), а байты по нему дочитывает
// этот middleware и дописывает file-part в то же user-сообщение.
//
// ГДЕ ИСКАТЬ ССЫЛКУ: строки `context`, которые канал вернул из onMessage, eve кладёт
// КАЖДУЮ отдельным сообщением с role "user" — перед сообщением владельца
// (eve/dist/src/harness/tool-loop.js: `for(let e of I.context) z.push({content:e,role:"user"})`).
// Поэтому смотрим все user-сообщения промпта, а не только последнее.
//
// ИНВАРИАНТ: история хода на диске остаётся текстом. Байты живут ровно в одном запросе —
// в сессии и в Vault лежит путь, поэтому реплей истории не тащит за собой base64.
// Промпт в том виде, в каком его видит middleware: спека провайдера, не пользовательская
// форма сообщений. Берём из самого типа middleware, чтобы не тянуть @ai-sdk/provider.
type ModelPrompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type ModelMessage = ModelPrompt[number];

function isUserMessage(
  message: ModelMessage,
): message is Extract<ModelMessage, { role: "user" }> {
  return (
    isRecord(message) &&
    message.role === "user" &&
    Array.isArray(message.content)
  );
}

function imageRefsInMessage(
  message: Extract<ModelMessage, { role: "user" }>,
): string[] {
  const refs: string[] = [];
  for (const part of message.content) {
    if (part?.type !== "text") continue;
    for (const rel of imageRefsIn(part.text))
      if (!refs.includes(rel)) refs.push(rel);
  }
  return refs;
}

function readVaultImage(rel: string): Uint8Array {
  // Путь на диске собирает и проверяет резолвер кэша медиа — единственное место, где
  // rel-путь вложения превращается в абсолютный, с проверкой границ vault/attachments.
  const path = resolveAttachmentPath(rel);
  if (!path) throw new Error(`вложение недоступно: ${rel}`);
  const file = readFileSync(path);
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
}

/**
 * Дописывает картинки Vault в user-сообщения промпта. Файлы читает readImage, поэтому
 * ядро проверяется без файловой системы.
 *
 * Едут ПОСЛЕДНИЕ MAX_ATTACHED_IMAGES ссылок промпта (по последнему упоминанию каждой) и
 * только пока хватает бюджета байтов — почему потолок обязателен, написано в
 * agent/lib/attachment-ref.ts. Что не поместилось, остаётся в ходе путём, и каждая такая
 * картинка называет себя строкой в журнале.
 */
export function attachVaultImages(
  prompt: ModelPrompt,
  { readImage }: { readImage: (rel: string) => Uint8Array },
): ModelPrompt {
  if (!Array.isArray(prompt)) return prompt;
  const mentions: { index: number; rel: string }[] = [];
  prompt.forEach((message, index) => {
    if (!isUserMessage(message)) return;
    for (const rel of imageRefsInMessage(message)) {
      // Дедуп по последнему упоминанию: пересланная заново картинка считается свежей.
      const seen = mentions.findIndex((mention) => mention.rel === rel);
      if (seen >= 0) mentions.splice(seen, 1);
      mentions.push({ index, rel });
    }
  });

  const files = new Map<
    number,
    Extract<ModelMessage, { role: "user" }>["content"]
  >();
  // Что не влезло в счётчик — называем поимённо: молчаливая пропажа кадра из альбома
  // выглядит как «Ива не увидела картинку» и не объясняется ничем.
  for (const { rel } of mentions.slice(0, -MAX_ATTACHED_IMAGES))
    console.error(
      `[vision] картинок в промпте больше ${MAX_ATTACHED_IMAGES}, ${rel} не прикладываю`,
    );

  // От свежих к старым: бюджет достаётся последней картинке, а не первой.
  const queue = mentions.slice(-MAX_ATTACHED_IMAGES).reverse();
  let budget = MAX_ATTACHED_IMAGE_BYTES;
  for (const [position, { index, rel }] of queue.entries()) {
    const mediaType = imageMediaType(rel);
    if (!mediaType) continue;
    let data: Uint8Array;
    try {
      data = readImage(rel);
    } catch (error) {
      // Файла нет или он не читается — ход важнее картинки, идём без неё.
      console.error(`[vision] картинку ${rel} из Vault не прочитал:`, error);
      continue;
    }
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
      console.error(
        data.byteLength === 0
          ? `[vision] картинка ${rel} пустая, иду без неё`
          : `[vision] картинка ${rel} больше потолка, иду без неё`,
      );
      continue;
    }
    if (data.byteLength > budget) {
      // Дальше только более старые картинки: режем хвост целиком, чтобы выбор не зависел
      // от того, чей размер удачно совпал с остатком бюджета.
      for (const rest of queue.slice(position))
        console.error(
          `[vision] бюджет картинок исчерпан, ${rest.rel} не прикладываю`,
        );
      break;
    }
    budget -= data.byteLength;
    const attached = files.get(index) ?? [];
    // Тегированная форма обязательна: плоское `data: bytes` провайдеры спецификации v4
    // сериализуют в null и получают ошибку вместо картинки. filename провайдеры для
    // картинок не читают — не шлём.
    attached.unshift({ type: "file", mediaType, data: { type: "data", data } });
    files.set(index, attached);
  }
  if (files.size === 0) return prompt;
  return prompt.map((message, index) => {
    const attached = files.get(index);
    if (!attached || !isUserMessage(message)) return message;
    return { ...message, content: [...message.content, ...attached] };
  });
}

/**
 * Прикладывает картинки Vault к промпту. Предикат «текстовая модель видит картинки»
 * приходит параметром, а не импортом `vision.ts`: vision сам зовёт `makeTextModel()`
 * для пробника, и этот импорт замыкал цикл provider ↔ vision. Форма — как у эффектов
 * telegram-media: потребитель (agent.ts, planner, vision) отдаёт свою реализацию.
 */
export type ImageCapability = () => Promise<boolean>;

export function attachImagesMiddleware(
  chatModelSeesImages: ImageCapability,
): LanguageModelMiddleware {
  return {
    async transformParams({ params }) {
      // Ссылки ищем ДО пробника: ход без картинок не будит сеть, и сам пробник (он идёт
      // через makeTextModel, то есть через этот же middleware) не ждёт собственного вердикта.
      if (!Array.isArray(params.prompt)) return params;
      const hasRefs = params.prompt.some(
        (message) =>
          isUserMessage(message) && imageRefsInMessage(message).length > 0,
      );
      if (!hasRefs) return params;
      if (!(await chatModelSeesImages())) return params;
      return {
        ...params,
        prompt: attachVaultImages(params.prompt, { readImage: readVaultImage }),
      };
    },
  };
}

// Silent provider streams can keep a turn open indefinitely.
// Remove when eve forwards ai SDK `timeout.firstChunkMs` to ToolLoopAgent (vercel/ai#17315 added the option; no eve issue yet).
export const MODEL_FIRST_CHUNK_TIMEOUT_MS = 90_000;

export const MODEL_PRESTREAM_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 90_000,
] as const;

const CONTENT_BEARING_STREAM_PART_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
  "tool-call",
  "tool-input-start",
  "text-start",
  "reasoning-start",
  "file",
  "source",
]);

type ModelFirstChunkTimeoutError = Error & {
  code: "MODEL_FIRST_CHUNK_TIMEOUT";
};

function makeModelFirstChunkTimeoutError(): ModelFirstChunkTimeoutError {
  return Object.assign(
    new Error(
      `Model produced no output for ${MODEL_FIRST_CHUNK_TIMEOUT_MS / 1_000}s`,
    ),
    { code: "MODEL_FIRST_CHUNK_TIMEOUT" as const },
  );
}

type RetryableProviderError = Error & {
  statusCode?: number;
  isRetryable?: boolean;
  responseHeaders?: Record<string, string>;
  code?: string;
  cause?: unknown;
};

function errorChain(error: unknown): RetryableProviderError[] {
  const errors: RetryableProviderError[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    errors.push(current as RetryableProviderError);
    current = (current as { cause?: unknown }).cause;
  }
  return errors;
}

function isAbortError(error: unknown): boolean {
  return errorChain(error).some(
    (candidate) =>
      candidate.name === "AbortError" ||
      candidate.code === "ABORT_ERR" ||
      candidate.code === "ERR_CANCELED",
  );
}

function retryAfterMs(error: RetryableProviderError): number | undefined {
  const raw = Object.entries(error.responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === "retry-after",
  )?.[1];
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(raw) - Date.now());
  return ms <= 120_000 ? ms : undefined;
}

function isTransientPreStreamError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const chain = errorChain(error);
  const statusError = chain.find(
    (candidate) => typeof candidate.statusCode === "number",
  );
  if (statusError?.statusCode !== undefined) {
    if (statusError.statusCode === 429)
      return (
        retryAfterMs(statusError) !== undefined ||
        (statusError.isRetryable === true &&
          !/quota|balance|insufficient/iu.test(statusError.message))
      );
    return (
      statusError.isRetryable === true &&
      [408, 425, 500, 502, 503, 504].includes(statusError.statusCode)
    );
  }
  return chain.some(
    (candidate) =>
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(
        candidate.code ?? "",
      ) || /fetch failed/iu.test(candidate.message),
  );
}

function terminalPreStreamError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  // The outer AI SDK retry must not restart this completed retry budget.
  Object.defineProperty(error, "isRetryable", {
    configurable: true,
    enumerable: true,
    value: false,
    writable: true,
  });
  return error;
}

function sleepUntilAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted)
    return Promise.reject(
      abortSignal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function transientPreStreamRetryMiddleware({
  retryDelaysMs = MODEL_PRESTREAM_RETRY_DELAYS_MS,
  sleep = sleepUntilAbort,
}: {
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): LanguageModelMiddleware {
  return {
    async wrapStream({ doStream, params }) {
      for (let retry = 0; ; retry += 1) {
        if (params.abortSignal?.aborted)
          throw (
            params.abortSignal.reason ??
            new DOMException("Aborted", "AbortError")
          );
        try {
          return await doStream();
        } catch (error) {
          if (params.abortSignal?.aborted || !isTransientPreStreamError(error))
            throw error;
          if (retry >= retryDelaysMs.length)
            throw terminalPreStreamError(error);
          const providerError =
            errorChain(error).find(
              (candidate) => typeof candidate.statusCode === "number",
            ) ?? errorChain(error)[0];
          const delay =
            (providerError === undefined
              ? undefined
              : retryAfterMs(providerError)) ?? retryDelaysMs[retry];
          const status = providerError?.statusCode ?? "network";
          console.warn(
            `[provider] transient ${status}, retry ${retry + 1}/${retryDelaysMs.length} in ${delay / 1_000}s`,
          );
          await sleep(delay, params.abortSignal);
        }
      }
    },
  };
}

export const modelFirstChunkDeadlineMiddleware: LanguageModelMiddleware = {
  async wrapStream({ model, params }) {
    const timeoutError = makeModelFirstChunkTimeoutError();
    const timeoutController = new AbortController();
    const abortSignal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, timeoutController.signal])
      : timeoutController.signal;
    let outputController:
      ReadableStreamDefaultController<ModelStreamPart> | undefined;
    let cancelProviderStream: (reason?: unknown) => Promise<void> = () =>
      Promise.resolve();
    let ended = false;
    let timedOut = false;
    let rejectDeadline: (reason: unknown) => void = () => undefined;

    const deadlineReached = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const clearDeadline = () => {
      clearTimeout(deadline);
      params.abortSignal?.removeEventListener("abort", clearDeadline);
    };
    const deadline = setTimeout(() => {
      if (ended) return;
      ended = true;
      timedOut = true;
      timeoutController.abort(timeoutError);
      outputController?.error(timeoutError);
      void cancelProviderStream(timeoutError).catch(() => undefined);
      rejectDeadline(timeoutError);
    }, MODEL_FIRST_CHUNK_TIMEOUT_MS);

    if (params.abortSignal?.aborted) clearDeadline();
    else
      params.abortSignal?.addEventListener("abort", clearDeadline, {
        once: true,
      });

    const providerResult = model.doStream({ ...params, abortSignal });
    let result: Awaited<typeof providerResult>;
    try {
      result = await Promise.race([providerResult, deadlineReached]);
    } catch (error) {
      clearDeadline();
      if (timedOut) {
        void providerResult.then(
          ({ stream }) => stream.cancel(timeoutError).catch(() => undefined),
          () => undefined,
        );
      }
      throw error;
    }

    const { stream, ...rest } = result;
    const reader = stream.getReader();
    cancelProviderStream = (reason) => reader.cancel(reason);

    return {
      ...rest,
      stream: new ReadableStream<ModelStreamPart>({
        start(controller) {
          outputController = controller;
          void (async () => {
            try {
              for (;;) {
                const part = await reader.read();
                if (ended) return;
                if (part.done) {
                  ended = true;
                  clearDeadline();
                  controller.close();
                  return;
                }
                if (CONTENT_BEARING_STREAM_PART_TYPES.has(part.value.type))
                  clearDeadline();
                controller.enqueue(part.value);
              }
            } catch (error) {
              if (ended) return;
              ended = true;
              clearDeadline();
              controller.error(error);
            }
          })();
        },
        cancel(reason) {
          ended = true;
          clearDeadline();
          return reader.cancel(reason);
        },
      }),
    };
  },
};

// --- Схема инструмента, которую провайдер не принимает --------------------------------------
// OpenAI (codex) отвергает ВЕСЬ запрос, если у любого инструмента в `pattern` стоит lookaround:
// «Invalid JSON schema: regex lookaround is not supported. Found at $.properties.….pattern»,
// 400, `param: tools` (пакет пользователя 13.09.2026: календарный инструмент с полем attendees, источник в пакете не различим - личный слой data/custom или подключение;
// ход умирал до первого слова модели). Инструменты приходят откуда угодно - плагины,
// подключения eve, свои - а граница с провайдером одна, эта. Как у Hermes (issue #42631):
// отказ по схеме = вырезать такие `pattern` из инструментов ЭТОГО запроса и повторить один раз.
// Остальная схема, включая описание поля, остаётся: модель по-прежнему видит, что от неё ждут.
const LOOKAROUND_PATTERN = /\(\?<?[=!]/u;

/** Копия схемы без `pattern` с lookaround на любой глубине; `dropped` считает вырезанные. */
export function withoutLookaroundPatterns(
  schema: unknown,
  dropped = { count: 0 },
): unknown {
  if (Array.isArray(schema))
    return schema.map((item) => withoutLookaroundPatterns(item, dropped));
  if (!isRecord(schema)) return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "pattern" &&
      typeof value === "string" &&
      LOOKAROUND_PATTERN.test(value)
    ) {
      dropped.count++;
      continue;
    }
    copy[key] = withoutLookaroundPatterns(value, dropped);
  }
  return copy;
}

export function isToolSchemaRejection(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    error.statusCode === 400 &&
    /invalid[ _-]?json[ _-]?schema/iu.test(error.message)
  );
}

export const toolSchemaRetryMiddleware: LanguageModelMiddleware = {
  async wrapStream({ doStream, model, params }) {
    try {
      return await doStream();
    } catch (error) {
      if (!isToolSchemaRejection(error) || !params.tools?.length) throw error;
      const dropped = { count: 0 };
      const tools = params.tools.map((tool) =>
        tool.type === "function"
          ? {
              ...tool,
              inputSchema: withoutLookaroundPatterns(
                tool.inputSchema,
                dropped,
              ) as typeof tool.inputSchema,
            }
          : tool,
      );
      if (dropped.count === 0) throw error; // не та схема: чинить нечего, ошибка наружу
      console.error(
        `[provider] the provider rejected a tool schema; retrying without ${dropped.count} regex pattern(s) with lookaround`,
      );
      return model.doStream({ ...params, tools });
    }
  },
};

// --- Соседние user-сообщения ------------------------------------------------------------------
// Строка времени (agent/instructions/now.ts) приходит user-сообщением перед вводом владельца, и
// eve их не склеивает. Часть chat-шаблонов (vLLM, llama.cpp) отвергает две реплики одной роли
// подряд, поэтому граница с провайдером отдаёт их одним сообщением: всем вендорам, одним правилом.
type UserMessage = Extract<ModelMessage, { role: "user" }>;

function mergeUserMessages(first: UserMessage, next: UserMessage): UserMessage {
  const content: UserMessage["content"] = [];
  for (const part of [...first.content, ...next.content]) {
    const previous = content.at(-1);
    if (part.type === "text" && previous?.type === "text")
      content[content.length - 1] = {
        ...previous,
        text: `${previous.text}\n\n${part.text}`,
      };
    else content.push(part);
  }
  return { role: "user", content };
}

function withAdjacentUserMessagesMerged(prompt: ModelPrompt): ModelPrompt {
  const merged: ModelMessage[] = [];
  for (const message of prompt) {
    const last = merged.at(-1);
    if (message.role === "user" && last?.role === "user")
      merged[merged.length - 1] = mergeUserMessages(last, message);
    else merged.push(message);
  }
  return merged;
}

const adjacentUserMessagesMiddleware: LanguageModelMiddleware = {
  transformParams({ params }) {
    return Promise.resolve({
      ...params,
      prompt: withAdjacentUserMessagesMerged(params.prompt),
    });
  },
};

/**
 * Текстовая модель активного провайдера. Общая для КАЖДОГО узла графа: корень и субагенты
 * обязаны говорить с одним провайдером, свои createOpenAICompatible/env в субагентах не заводим.
 */
export function makeTextModel(options: {
  sessionId?: string;
  chatModelSeesImages: ImageCapability;
  // Чей шаг ведёт модель: расход компактации eve уходит в usage.jsonl под этим ходом.
  usage?: UsageLabel;
}) {
  return wrapLanguageModel({
    model: makeBareTextModel(options.sessionId),
    middleware: [
      repeatGuardMiddleware,
      attachImagesMiddleware(options.chatModelSeesImages),
      toolSchemaRetryMiddleware,
      transientPreStreamRetryMiddleware(),
      modelFirstChunkDeadlineMiddleware,
      adjacentUserMessagesMiddleware,
      // Порядок свободен: кодирование идемпотентно, других читателей toolName в цепочке нет.
      toolNameWireMiddleware(MODEL_PROVIDERS[providerName].toolNameMax),
      compactionUsageMiddleware(options.usage),
    ],
  });
}

function makeBareTextModel(sessionId?: string) {
  // Codex-подписка говорит на Responses API — отдельная модель-фабрика (@ai-sdk/openai).
  // Claude-подписка — тоже своя модель: рукописная LanguageModelV4 поверх Claude Code CLI
  // (stream-json), потому что API-адреса у неё нет вовсе.
  // Остальные провайдеры — OpenAI-совместимый chat/completions через openai-compatible.
  if (providerName === "codex")
    return makeCodexModel(providerConfig.textModel, sessionId);
  if (providerName === "claude")
    return makeClaudeCliModel(providerConfig.textModel, { sessionId });
  return createOpenAICompatible({
    name: `iva-${providerName}`,
    baseURL: providerConfig.baseURL,
    apiKey: providerConfig.apiKey,
    // Go: ID диалога и User-Agent (см. providerRequestHeaders); у остальных — undefined.
    headers: providerRequestHeaders(sessionId),
    fetch: providerName === "opencode" ? opencodeFetch : undefined,
    // Без этого стрим OpenAI-совместимых провайдеров НЕ несёт usage (нет stream_options:
    // {include_usage:true}) → событие step.completed приходит без поля usage, и учёт токенов
    // (agent/hooks/usage.ts) пуст. Включаем, чтобы провайдер отдавал расход в финальном чанке.
    includeUsage: true,
  })(providerConfig.textModel);
}

// --- Рассуждение в истории хода: возвращаем там, где вендор его принимает ---------------------
// eve хранит вывод модели в истории и реплеит его на каждом следующем шаге и ходе. Правило одно
// на всех вендоров, решение по вендору — одна строка replaysReasoning в MODEL_PROVIDERS
// (agent/lib/model-provider.ts):
//  - вендор принимает рассуждение обратно (codex: reasoning-item с encrypted_content) — оно
//    остаётся в выводе и едет в следующий запрос, модель не теряет ход мысли между шагами;
//  - не принимает или это не доказано — рассуждение вырезается из вывода (в историю не попадает)
//    и из промпта (история, записанная до смены вендора в той же сессии).
// Исходный дефект закрыт у всех: deepseek (openai-compatible) отдавал reasoning-часть без поля
// `text`, а ai@7 ModelMessage-схема требует у reasoning string `text` → AI_InvalidPromptError в
// standardizePrompt ещё до модели, и сессия отравлена навсегда (Iva молчит в треде до сброса).
// Промпт до middleware уже провалидирован, поэтому такая часть режется на выходе, а не на входе.
// Подтверждено репродукцией: reasoning с text:"" проходит, без text — FAIL.
const REASONING_PART_TYPES = new Set([
  "reasoning",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning-file",
]);

type StreamPart = { type: string; delta?: unknown };
type ContentPart = { type: string; text?: unknown };

/** Часть вывода, которой нельзя в историю: любое рассуждение у вендора без возврата, и
 *  рассуждение без строки у любого (оно отравило бы реплей). */
function unreplayableOutput(part: StreamPart | ContentPart, replays: boolean) {
  if (!REASONING_PART_TYPES.has(part.type)) return false;
  if (!replays) return true;
  if (part.type === "reasoning")
    return typeof (part as ContentPart).text !== "string";
  if (part.type === "reasoning-delta")
    return typeof (part as StreamPart).delta !== "string";
  return false;
}

export function reasoningReplayMiddleware(
  replays: boolean,
): LanguageModelMiddleware {
  return {
    transformParams({ params }) {
      if (replays) return Promise.resolve(params);
      return Promise.resolve({
        ...params,
        prompt: params.prompt.map((message) =>
          message.role === "assistant"
            ? {
                ...message,
                content: message.content.filter(
                  (part) => !REASONING_PART_TYPES.has(part.type),
                ),
              }
            : message,
        ),
      });
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      return {
        ...result,
        content: result.content.filter(
          (part) => !unreplayableOutput(part, replays),
        ),
      };
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              if (!unreplayableOutput(part, replays)) controller.enqueue(part);
            },
          }),
        ),
      };
    },
  };
}

/** Оборачивает текстовую модель правилом возврата рассуждения активного вендора. */
export function withReplayableReasoning(
  model: WrappableModel,
  replays: boolean = MODEL_PROVIDERS[providerName].replaysReasoning,
): WrappableModel {
  return wrapLanguageModel({
    model,
    middleware: reasoningReplayMiddleware(replays),
  });
}
