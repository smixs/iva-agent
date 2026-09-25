// Единственный резолвер MODEL_PROVIDER: имя провайдера, текстовая модель, vision-модель
// (её зовёт agent/vision.ts на картинке) и поддержка OpenAI-совместимого reasoning_effort
// решаются РАЗ и одинаково для рантайма (agent/provider.ts) и учёта расхода
// (agent/hooks/usage.ts).
//
// Выбор fail-closed. Неизвестное значение (опечатка `ollmaa`, лишний пробел, другой
// регистр, пустая строка) валит старт с перечнем принятых имён вместо того, чтобы
// подставить конфигурацию ollama под чужим именем: иначе клиент ходит к одному
// провайдеру, а имя, reasoning и учёт токенов живут от другого (issue #161).
// ОТСУТСТВИЕ переменной — не опечатка, а дефолт: ollama, как было всегда.
// Нормализации нет намеренно: `.trim().toLowerCase()` принял бы значение, которого нет
// ни в одном мастере, и вернул бы ту же расходящуюся правду под другим соусом.
//
// Тот же перечень имён повторён ключами CATALOG в scripts/lib/model-catalog.ts: кнопки
// /model и `iva doctor` грузятся на инсталле, где авторского дерева может не быть
// (ADR-0003), поэтому импортировать этот модуль оттуда нельзя. Разъехаться копии не
// могут — их сверяет scripts/lib/model-catalog.test.ts. Зеркало несёт ОБЕ модели
// провайдера: и текстовую, и vision.
//
// Модуль читает env; пределы имён берёт из общих констант проводного формата.
import { CLAUDE_TOOL_NAME_MAX } from "./claude-cli.ts";
import { TOOL_NAME_MAX } from "./tool-wire-name.ts";

type Env = Readonly<Record<string, string | undefined>>;

// Порядок — тот же, что у кнопок мастера (scripts/setup/wizard.ts: 1-4) и ключей CATALOG,
// поэтому список в ошибке читается как список в интерфейсе.
export const MODEL_PROVIDER_NAMES = [
  "ollama",
  "opencode",
  "codex",
  "claude",
  "openrouter",
  "custom",
  "requesty",
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export interface ModelProviderSelection {
  readonly name: ModelProviderName;
  readonly model: string;
  // Модель, которой agent/vision.ts описывает картинку. Отдельная от текстовой: та
  // сплошь и рядом text-only. У codex своей переменной нет — подписка мультимодальна,
  // поэтому здесь оказывается та же текстовая модель.
  readonly visionModel: string;
  // Провайдер понимает reasoning_effort прямо в OpenAI-совместимом chat/completions.
  // Это не то же самое, что providerSupportsReasoning в scripts/lib/model-catalog.ts:
  // codex тоже умеет reasoning, но получает его через providerOptions Responses API.
  readonly compatibleReasoning: boolean;
}

// Record<ModelProviderName, …> держит таблицу полной: новое имя в MODEL_PROVIDER_NAMES
// не соберётся, пока ему не задали модель, ответ про reasoning и ответ про vision.
// Экспортируется ради шва: CATALOG в scripts/lib/model-catalog.ts несёт те же modelVar и
// те же дефолты для кнопок /model и мастера, и разъехаться им нельзя — расхождение значит,
// что мастер предлагает не ту модель, которую возьмёт рантайм. Сверяет model-catalog.test.ts.
export const MODEL_PROVIDERS = {
  ollama: {
    modelVar: "OLLAMA_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
    // Рассуждение прошлых шагов обратно не шлём, как и у остальных OpenAI-совместимых:
    // вернулось бы полем reasoning_content, а принимает ли его бэкенд, живьём не доказано.
    replaysReasoning: false,
    toolNameMax: TOOL_NAME_MAX,
    // Дешёвая мультимодалка того же провайдера (проверено на проде: принимает image_url,
    // http 200). Ollama Cloud снимает теги с раздачи: gemma3:12b отвечает
    // 410 "retired at 2026-07-15" — заменён на gemma4:31b (проверено 2026-07-28).
    // Текстовые модели (deepseek, glm, gpt-oss) отдают 400 "does not support image input",
    // так что подменять vision на них нельзя. Переопределяется OLLAMA_VISION_MODEL.
    visionModelVar: "OLLAMA_VISION_MODEL",
    defaultVisionModel: "gemma4:31b",
  },
  opencode: {
    modelVar: "OPENCODE_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
    replaysReasoning: false,
    toolNameMax: TOOL_NAME_MAX,
    // Живая проверка 2026-08-18, картинка через POST /chat/completions: qwen3.7-plus
    // отвечает 200 и кладёт в message.content чистое описание с OCR (4-6 с) — он и дефолт.
    // minimax-m3 картинку тоже видит, но течёт <think>…</think> прямо в content, а vision.ts
    // рассуждение не режет — оно уехало бы в транскрипт. gpt-5.6-luna на любую форму
    // картинки отвечает 400 с пустым телом, хотя текст берёт. reasoning_effort на Go
    // отвергается: max → 400 invalid_request_error. glm-*, deepseek-*, qwen3.7-max и
    // grok-4.5 картинок не видят вовсе. Переопределяется OPENCODE_VISION_MODEL.
    visionModelVar: "OPENCODE_VISION_MODEL",
    defaultVisionModel: "qwen3.7-plus",
  },
  codex: {
    modelVar: "CODEX_MODEL",
    defaultModel: "gpt-5.5",
    compatibleReasoning: false,
    // Бэкенд подписки принимает рассуждение прошлых шагов обратно (reasoning-item с
    // encrypted_content, store:false): живой многошаговый ход gpt-6-sol 23.09.2026.
    replaysReasoning: true,
    toolNameMax: TOOL_NAME_MAX,
    // gpt-5* мультимодальны — картинки идут через ту же подписку (agent/vision.ts гонит их
    // по Responses API), поэтому отдельной переменной нет вовсе: vision-модель подписки —
    // это и есть выбранная текстовая.
    visionModelVar: null,
    defaultVisionModel: null,
  },
  claude: {
    // Ключа нет: модель — установленный и залогиненный Claude Code CLI на той же машине
    // (agent/lib/claude-cli.ts). Имя модели — то, которое вернул живой список аккаунта
    // (scripts/lib/model-catalog.ts просит его рукопожатием CLI), поэтому здесь кандидаты, а
    // не единственно верное имя: fable, opus, sonnet — 1M контекста, haiku — 200k.
    modelVar: "CLAUDE_MODEL",
    defaultModel: "claude-fable-5-1",
    compatibleReasoning: false,
    // Подписка отвергает рассуждение без подписи, а сборка промпта CLI его и так пропускает.
    replaysReasoning: false,
    toolNameMax: CLAUDE_TOOL_NAME_MAX,
    // Подписка мультимодальна — как у codex, отдельной vision-модели нет: картинку смотрит
    // та же модель, что ведёт ход (agent/vision.ts гонит её через тот же CLI).
    visionModelVar: null,
    defaultVisionModel: null,
  },
  openrouter: {
    // Слаг модели вида vendor/model (напр. anthropic/claude-sonnet-4.5) — задаётся мастером.
    // Дефолт — лишь заглушка на случай ручного .env; мастер всегда перезапишет живой проверкой.
    modelVar: "OPENROUTER_MODEL",
    defaultModel: "openai/gpt-5.1",
    compatibleReasoning: false,
    replaysReasoning: false,
    toolNameMax: TOOL_NAME_MAX,
    // Дешёвая гарантированно-мультимодальная модель для картинок: vision работает независимо
    // от выбранной текстовой (та может быть text-only). Сюда вписывается любой слаг
    // OpenRouter с поддержкой картинок. Переопределяется OPENROUTER_VISION_MODEL.
    visionModelVar: "OPENROUTER_VISION_MODEL",
    defaultVisionModel: "google/gemini-2.5-flash",
  },
  custom: {
    // Свой OpenAI-совместимый эндпоинт (прокси, vLLM, LiteLLM, вендорская подписка). Адрес
    // приходит из CUSTOM_BASE_URL и живёт в agent/provider.ts вместе с ключом и окном.
    modelVar: "CUSTOM_MODEL",
    // Дефолту взяться неоткуда: что за модели у чужого эндпоинта, знает только его владелец.
    // null — «обязательна»: пустая переменная валит старт, а не подставляет чужое имя.
    defaultModel: null,
    // reasoning_effort незнакомому эндпоинту не шлём: OpenAI-совместимость этого поля не
    // обещает, а лишний параметр — HTTP 400 на каждом ходу.
    compatibleReasoning: false,
    replaysReasoning: false,
    toolNameMax: TOOL_NAME_MAX,
    // Vision-модель необязательна: с 0.3.34 картинку сначала предлагают самой модели чата
    // (ADR-0012). Пусто — дефолта нет, и картинку смотрит выбранная текстовая модель.
    visionModelVar: "CUSTOM_VISION_MODEL",
    defaultVisionModel: null,
  },
  requesty: {
    // Id модели Requesty: managed policy (напр. gpt-5.5) или vendor/model (напр.
    // openai/gpt-5.5). Задаётся мастером с живой проверкой, как у openrouter.
    modelVar: "REQUESTY_MODEL",
    defaultModel: "gpt-5.5",
    compatibleReasoning: false,
    replaysReasoning: false,
    toolNameMax: TOOL_NAME_MAX,
    // Мультимодальная модель для картинок, как у openrouter: выбранная текстовая может быть
    // text-only. Переопределяется REQUESTY_VISION_MODEL.
    visionModelVar: "REQUESTY_VISION_MODEL",
    defaultVisionModel: "gemini-3.5-flash",
  },
} as const satisfies Record<
  ModelProviderName,
  {
    modelVar: string;
    // null = обязательная переменная: у провайдера нет модели, которую можно подставить молча.
    defaultModel: string | null;
    compatibleReasoning: boolean;
    // Рассуждение прошлых шагов возвращается модели в истории хода. false — вырезается и из
    // вывода, и из промпта: вендор его не принимает или это не доказано живьём.
    replaysReasoning: boolean;
    // Максимальная длина имени до обращения к провайдеру; у claude зарезервирован префикс.
    toolNameMax: number;
    visionModelVar: string | null;
    defaultVisionModel: string | null;
  }
>;

// Текст отказа: одно предложение с заданным значением, принятыми именами и починкой.
// Его же собирает `iva doctor` из своей половины перечня — совпадение двух строк
// пинует scripts/cli/doctor.test.ts.
export function invalidModelProviderMessage(raw: string): string {
  return `Invalid MODEL_PROVIDER ${JSON.stringify(raw)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")} — run: iva config`;
}

// Отказ на провайдере без дефолтной модели (custom): подставить нечего, и промолчать нельзя —
// пустое имя модели в теле запроса провайдер вернул бы ошибкой на каждом ходу.
export function missingModelMessage(name: ModelProviderName): string {
  return `MODEL_PROVIDER=${name} requires ${MODEL_PROVIDERS[name].modelVar} — run: iva config`;
}

// Одно правило чтения на ОБЕ модели провайдера — текстовую и vision. Разными их делает
// только дефолт, поэтому он и приходит аргументом: две копии этой функции разъехались бы
// ровно так же, как раньше расходились три ответа на одну строку .env.
function configuredModel(
  name: ModelProviderName,
  raw: string | undefined,
  fallback: string | null,
): string {
  const configured = (raw ?? "").trim();
  // Эндпоинт OpenCode ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/"
  // из дефолта и старых .env. Срез идёт ДО проверки на пустоту: голый "opencode-go/"
  // тоже «не задано», а не пустое имя модели в запросе.
  const stripped =
    name === "opencode" ? configured.replace(/^opencode-go\//, "") : configured;
  if (stripped) return stripped;
  // Дефолта нет — значит переменная обязательна, и «не задано» здесь громкий отказ, а не
  // тихая подстановка.
  if (fallback === null) throw new Error(missingModelMessage(name));
  return fallback;
}

/**
 * Модель провайдера из сырого значения переменной. Одно правило на всех, потому что раньше
 * ответов на один и тот же `.env` было три: рантайм брал пустую строку как есть, экран
 * статуса подставлял дефолт, а экран обновления рисовал «?».
 *
 * Пробелы срезаются, пустое (и пробельное) значение — это «не задано», то есть дефолт
 * провайдера. Свою модель нельзя «стереть», оставив агента без имени модели в запросе.
 * У провайдера без дефолта (custom) «не задано» — отказ с именем переменной.
 *
 * Повторено в scripts/lib/model-catalog.ts (`catalogModel`) для половины, которая грузится
 * без authored tree; равенство двух правил сверяет scripts/lib/model-catalog.test.ts.
 */
export function modelProviderModel(
  name: ModelProviderName,
  raw: string | undefined,
): string {
  return configuredModel(name, raw, MODEL_PROVIDERS[name].defaultModel);
}

/**
 * Vision-модель провайдера — тем же правилом trim/blank→дефолт, что и текстовая.
 * У провайдера без дефолтной vision-модели её место занимает выбранная текстовая: у codex
 * своей переменной нет вовсе (подписка мультимодальна), у custom эндпоинт чужой и назвать
 * дефолт некому. Здесь vision никогда не отказывает: пустая строка — не отсутствие модели.
 */
function visionModelFor(
  name: ModelProviderName,
  raw: string | undefined,
  textModel: string,
): string {
  const fallback: string | null = MODEL_PROVIDERS[name].defaultVisionModel;
  return configuredModel(name, raw, fallback ?? textModel);
}

/**
 * Разрешает MODEL_PROVIDER в одну согласованную четвёрку «имя · модель · vision · reasoning».
 * Бросает на любом значении, которого нет в MODEL_PROVIDER_NAMES.
 */
export function resolveModelProvider(
  env: Env = process.env,
): ModelProviderSelection {
  const raw = env.MODEL_PROVIDER ?? "ollama";
  if (!(MODEL_PROVIDER_NAMES as readonly string[]).includes(raw))
    throw new Error(invalidModelProviderMessage(raw));

  const name = raw as ModelProviderName;
  const { modelVar, visionModelVar, compatibleReasoning } =
    MODEL_PROVIDERS[name];
  const model = modelProviderModel(name, env[modelVar]);
  return {
    name,
    model,
    // Переменную соседа не читаем: у codex её нет вовсе, и подставить её нечем.
    visionModel: visionModelFor(
      name,
      visionModelVar === null ? undefined : env[visionModelVar],
      model,
    ),
    compatibleReasoning,
  };
}
