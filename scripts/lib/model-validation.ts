import {
  CATALOG,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.ts";
import { ClaudeCliError, probeClaudeModel } from "./claude-cli-status.ts";

type OpenRouterErrorReason = (body: unknown, status: number) => unknown;
type ModelSelection = {
  provider: string;
  model: string | null | undefined;
  key?: string;
  dataDir?: string;
  // Адрес эндпоинта у провайдера, чей base не вшит в каталог (custom).
  base?: string;
};
type ValidationOptions = {
  fetchFn?: typeof fetch;
  listCodexCatalog?: (options?: {
    dataDir?: string;
  }) => Promise<{ id: string; reasoningLevels: string[] }[]>;
  /** Живая проба вендора claude; по умолчанию — один запрос через чужой CLI. */
  probeClaude?: (
    model: string,
  ) => Promise<{ id: string; reasoningLevels: string[]; answered?: boolean }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const FETCH_TIMEOUT_MS = 10_000;

export class ModelValidationError extends Error {
  declare readonly code: string;
  declare readonly status?: number;

  constructor(
    code: string,
    message: string,
    { status, cause }: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ModelValidationError";
    this.code = code;
    this.status = status;
  }
}

const validationError = (error: unknown): ModelValidationError => {
  if (error instanceof ModelValidationError) return error;
  if (error instanceof ModelCatalogError) {
    return new ModelValidationError(error.code, error.message, {
      status: error.status,
      cause: error,
    });
  }
  return new ModelValidationError(
    "catalog_unavailable",
    "provider validation failed",
    {
      cause: error,
    },
  );
};

type ProbeOptions = {
  fetchFn?: typeof fetch;
  errorReason?: OpenRouterErrorReason;
};
type ProbeResult = { id: string; reasoningLevels: string[]; answered: boolean };

export async function probeOpenRouterModel(
  selection: { model: string; key?: string },
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  return probeToolCallModel("openrouter", selection, options);
}

// Requesty, like OpenRouter, serves far more models than its static list, so a model is
// accepted by the same live tool-call request instead of a catalog lookup.
export async function probeRequestyModel(
  selection: { model: string; key?: string },
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  return probeToolCallModel("requesty", selection, options);
}

async function probeToolCallModel(
  provider: "openrouter" | "requesty",
  { model, key }: { model: string; key?: string },
  { fetchFn = fetch, errorReason }: ProbeOptions,
): Promise<ProbeResult> {
  const { base, label } = CATALOG[provider];
  let response: Response;
  try {
    response = await fetchFn(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Call the ping tool." }],
        tools: [
          {
            type: "function",
            function: {
              name: "ping",
              description: "health check",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ModelValidationError(
      "catalog_unavailable",
      `${label} request failed`,
      {
        cause,
      },
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ModelValidationError(
      "auth_rejected",
      `${label} rejected credentials (${response.status})`,
      {
        status: response.status,
      },
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ModelValidationError(
      "catalog_invalid",
      `${label} returned invalid JSON`,
      {
        status: response.status,
        cause,
      },
    );
  }
  if (!response.ok) {
    const detail =
      errorReason?.(body, response.status) ??
      (isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : "");
    // Preserve the former template-literal coercion for malformed provider
    // values while keeping the callback contract honest at its boundary.
    const reason = detail ? `: ${detail as string}` : "";
    throw new ModelValidationError(
      "model_unavailable",
      `${label} rejected model ${model}${reason}`,
      { status: response.status },
    );
  }
  const choices =
    isRecord(body) && Array.isArray(body.choices)
      ? (body.choices as unknown[])
      : [];
  const first = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const answered = Boolean(
    (isRecord(message) &&
      typeof message.content === "string" &&
      message.content.trim()) ||
    (isRecord(message) &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length),
  );
  // A reasoning model can spend the entire small probe allowance before it
  // emits visible content. HTTP 200 still proves that the key, slug and tools
  // request were accepted, matching setup's long-standing probe contract.
  return { id: model, reasoningLevels: [], answered };
}

export async function validateModelSelection(
  { provider, model, key, dataDir, base }: ModelSelection,
  { fetchFn = fetch, listCodexCatalog, probeClaude }: ValidationOptions = {},
): Promise<{ id: string; reasoningLevels: string[]; answered?: boolean }> {
  const selected = selectionOf(provider, model);
  if (provider === "openrouter")
    return probeOpenRouterModel({ model: selected, key }, { fetchFn });
  if (provider === "requesty")
    return probeRequestyModel({ model: selected, key }, { fetchFn });
  // У вендора без ключа проверка одна: живой запрос через CLI на этой же машине.
  if (provider === "claude")
    return await probeClaudeSelection(selected, probeClaude);
  assertBase(provider, base);
  return await validateFromCatalog({
    provider,
    model: selected,
    key,
    dataDir,
    base,
    fetchFn,
    listCodexCatalog,
  });
}

/** Имя провайдера из каталога и однострочная модель: всё остальное — отказ выбора. */
function selectionOf(provider: unknown, model: unknown): string {
  if (
    typeof provider !== "string" ||
    !Object.hasOwn(CATALOG, provider) ||
    typeof model !== "string" ||
    !model.trim() ||
    /[\r\n]/.test(model)
  ) {
    throw new ModelValidationError(
      "invalid_selection",
      "invalid provider or model selection",
    );
  }
  return model.trim();
}

/** Свой эндпоинт без адреса проверять негде — и это отказ конфигурации, а не сети. */
function assertBase(provider: string, base: string | undefined): void {
  const { baseVar } = CATALOG[provider];
  if (baseVar && !base)
    throw new ModelValidationError("base_missing", `${baseVar} is not set`);
}

/** Каталог живой — значит он и есть правда: имени, которого в нём нет, в .env делать нечего. */
async function validateFromCatalog({
  provider,
  model,
  key,
  dataDir,
  base,
  fetchFn,
  listCodexCatalog,
}: ModelSelection & {
  provider: string;
  model: string;
  fetchFn: typeof fetch;
  listCodexCatalog: ValidationOptions["listCodexCatalog"];
}): Promise<{ id: string; reasoningLevels: string[]; answered?: boolean }> {
  let options;
  try {
    options = await fetchModelOptions(provider, key, {
      dataDir,
      fetchFn,
      ...(base ? { base } : {}),
      ...(listCodexCatalog ? { listCodexCatalog } : {}),
    });
  } catch (error) {
    const failure = validationError(error);
    // У чужого эндпоинта GET /models может не быть вовсе: OpenAI-совместимость его не
    // требует. Отказ по ключу (401/403) остаётся отказом, всё остальное — «каталога нет»,
    // и тогда принимается имя модели, которое владелец ввёл сам. Та же мягкая политика,
    // что у checkKey: сетевой сбой не повод объявить рабочую конфигурацию битой.
    if (CATALOG[provider].baseVar && failure.code !== "auth_rejected")
      return { id: model, reasoningLevels: [] };
    throw failure;
  }
  const match = options.find((option) => option.id === model);
  if (!match) {
    throw new ModelValidationError(
      "model_unavailable",
      `${model} is not present in the live ${CATALOG[provider].label} catalog`,
    );
  }
  return match;
}

/** Проба вендора claude: один запрос через чужой CLI (см. scripts/lib/claude-cli-status.ts).
 *  Подставлена ради теста: живой CLI в тестах не поднимается. */
async function probeClaudeSelection(
  model: string,
  probe?: ValidationOptions["probeClaude"],
): Promise<{ id: string; reasoningLevels: string[]; answered?: boolean }> {
  const run = probe ?? ((candidate: string) => probeClaudeModel(candidate));
  try {
    return await run(model);
  } catch (error) {
    throw claudeFailure(error);
  }
}

/** Отказы CLI становятся отказами выбора: «не вошёл» — тот же отказ по доступу, что 401. */
function claudeFailure(error: unknown): ModelValidationError {
  if (!(error instanceof ClaudeCliError)) return validationError(error);
  return new ModelValidationError(
    error.code === "not_logged_in" ? "auth_rejected" : error.code,
    error.message,
    { cause: error },
  );
}
