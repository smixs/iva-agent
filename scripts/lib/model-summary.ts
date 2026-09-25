import { resolveContextWindow } from "../../packages/context-window/index.ts";
import { catalogModel, catalogProvider } from "./model-catalog.ts";

type Env = Record<string, string | undefined>;

// Короткая подпись провайдера для одной строки статуса — не лейбл каталога (там
// «Ollama Cloud»). Имя переменной модели здесь НЕ повторяется: раньше это был третий
// реестр, и переименуй его кто-нибудь — экран обновления показывал бы «?» на рабочей
// установке, а никакой тест бы не заметил. Модель берётся из каталога, окно контекста —
// единственное, что осталось локальным, и оно ни с чем не пересекается.
const PROVIDERS: Record<string, { label: string; context: string }> = {
  ollama: { label: "Ollama", context: "OLLAMA_CONTEXT_WINDOW" },
  opencode: { label: "OpenCode", context: "OPENCODE_CONTEXT_WINDOW" },
  openrouter: { label: "OpenRouter", context: "OPENROUTER_CONTEXT_WINDOW" },
  codex: { label: "OpenAI", context: "CODEX_CONTEXT_WINDOW" },
  claude: { label: "Claude", context: "CLAUDE_CONTEXT_WINDOW" },
  custom: { label: "Custom", context: "CUSTOM_CONTEXT_WINDOW" },
  requesty: { label: "Requesty", context: "REQUESTY_CONTEXT_WINDOW" },
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
  const label = known ? PROVIDERS[id].label : `invalid (${id})`;
  const model = known ? (catalogModel(id, env) ?? "?") : "?";
  const contextVariable = known ? PROVIDERS[id].context : null;
  const rawContext = contextVariable ? env[contextVariable] : undefined;
  const contextWindow =
    contextVariable && rawContext !== undefined
      ? resolveContextWindow(contextVariable, rawContext)
      : null;
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
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  return new Intl.NumberFormat("en-US").format(value);
}
