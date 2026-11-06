import { providerContextWindow } from "../../packages/context-window/index.ts";
import { catalogModel, catalogProvider } from "./model-catalog.ts";

type Env = Record<string, string | undefined>;

// Models come from the catalog; windows use the runtime's shared resolver.
const PROVIDERS: Record<string, string> = {
  ollama: "Ollama",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  codex: "OpenAI",
  claude: "Claude",
  custom: "Custom",
};

/** Имена провайдеров, которые умеет подписать этот экран. Сверяются с рантаймом в тесте. */
export const SUMMARY_PROVIDER_NAMES = Object.keys(PROVIDERS);

/**
 * Display-only модель и окно контекста. Значение модели читается тем же правилом, что и
 * рантайм (catalogModel): пробелы срезаны, пустое — это «не задано», то есть дефолт
 * провайдера. Экран обновления и /menu обязаны показывать ту модель, к которой пойдёт агент.
 */
export function modelSummary(env: Env = process.env): {
  provider: string;
  model: string;
  contextWindow: number | null;
  line: string;
} {
  // Строгое совпадение, как в рантайме (agent/lib/model-provider.ts): привести здесь
  // регистр или обрезать пробелы значило бы назвать провайдера, на котором агент даже
  // не стартует. Неизвестное имя показываем тем же словом, что и /menu → Статус.
  const id = env.MODEL_PROVIDER ?? "ollama";
  const known = Boolean(catalogProvider(id)) && Object.hasOwn(PROVIDERS, id);
  const label = known ? PROVIDERS[id] : `invalid (${id})`;
  const model = known ? (catalogModel(id, env) ?? "?") : "?";
  const contextWindow = known ? providerContextWindow(id, model, env) : null;
  return {
    provider: label,
    model,
    contextWindow,
    line: `${label} · ${model}`,
  };
}

export function compactNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "?";
  }
  if (value >= 1_000_000 && value % 1_000_000 === 0)
    return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  return new Intl.NumberFormat("en-US").format(value);
}
