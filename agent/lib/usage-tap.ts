// Расход вызовов модели, которые идут мимо step.completed: компактация истории eve и
// зрение. Хук agent/hooks/usage.ts видит только шаги хода, а эти вызовы тратят токены того
// же провайдера, и без них usage.jsonl занижает расход (R12, отчёт 24.09.2026).
//
// Строки пишутся в тот же лог и той же формой; отличает их `source`: "compaction" или
// "vision". Числа — фактический usage провайдера из ответа, а не оценка.
//
// Ключ хода у таких строк — ход, в котором случился вызов, с суффиксом "#compaction" или
// "#vision". Читатели (scripts/lib/usage.ts) группируют ход по части до "#", поэтому расход
// компактации входит в итог хода, но не выдаёт себя за размер контекста основной сессии:
// вход компактации — это весь пересказываемый транскрипт, а не окно следующего шага.
//
// Зрение идёт в канале до хода, а компактация объявленного узла — вне шага, поэтому у их строк хода
// нет: sessionId "" и turnId "#vision"/"#compaction". Читатели считают такой расход в итоге
// окна, но ходом его не считают и последним ходом не показывают.
//
// Учёт не участвует в основном пути: сбой записи строки уходит в журнал, а компактация,
// описание картинки и пробник идут дальше, как будто учёта нет.
import type { LanguageModelMiddleware, LanguageModelUsage } from "ai";
import { createHash } from "node:crypto";
import { resolveModelProvider } from "./model-provider.ts";
import {
  appendUsage,
  readUsageTokens,
  usageRecord,
  setUsageRequest,
  takeUsageRequest,
  type UsageTokens,
} from "./usage.ts";

// Формы провайдерского уровня берём из самого middleware: @ai-sdk/provider напрямую в
// зависимостях не заявлен.
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapGenerateOptions = Parameters<WrapGenerate>[0];
type ProviderPrompt = WrapGenerateOptions["params"]["prompt"];
type ProviderUsage = Awaited<
  ReturnType<WrapGenerateOptions["doGenerate"]>
>["usage"];

// Модель и провайдер не приходят в вызов — тот же строгий выбор, что у хука и runtime.
const { name: PROVIDER, model: TEXT_MODEL } = resolveModelProvider();

// Начало system-промпта компактации eve (harness/compaction-prompt.js). Другого признака у
// вызова нет: eve зовёт generateText с тем же объектом модели, что ведёт ход. Совпадение
// с текстом eve пинует usage-tap.test.ts, гоняя настоящую компактацию eve.
const COMPACTION_SYSTEM_PREFIX =
  "You are performing a CONTEXT CHECKPOINT COMPACTION.";
let fingerprintWarned = false;

/**
 * Чей это вызов: сессия и ход, в котором eve построил модель шага. Родителя тут нет: eve
 * не отдаёт его резолверу модели. Строка ребёнка находит родителя по своей sessionId —
 * шаги той же сессии несут parentSessionId (agent/hooks/usage.ts).
 */
export interface UsageLabel {
  readonly sessionId: string;
  readonly turnId: string;
  readonly step: number;
}

/**
 * Метка из события step.started резолвера модели. eve типизирует событие как unknown,
 * поэтому читаем осторожно: чего нет или что не того типа — пустая строка и шаг 0.
 */
export function stepUsageLabel(event: unknown, sessionId: string): UsageLabel {
  const data = isRecord(event) && isRecord(event.data) ? event.data : {};
  const step = data.stepIndex;
  return {
    sessionId,
    turnId: typeof data.turnId === "string" ? data.turnId : "",
    step: typeof step === "number" && Number.isSafeInteger(step) ? step : 0,
  };
}

/** Промпт — это компактация eve, а не шаг хода. */
function isCompactionPrompt(prompt: ProviderPrompt): boolean {
  return prompt.some(
    (message) =>
      message.role === "system" &&
      message.content.startsWith(COMPACTION_SYSTEM_PREFIX),
  );
}

/** Расход в форме провайдера (LanguageModelV4Usage) → числа лога. */
export function providerUsageTokens(
  usage: ProviderUsage | undefined,
): UsageTokens | null {
  return readUsageTokens({
    in: usage?.inputTokens?.total,
    out: usage?.outputTokens?.total,
    cacheRead: usage?.inputTokens?.cacheRead,
    cacheWrite: usage?.inputTokens?.cacheWrite,
  });
}

/** Расход в форме результата AI SDK (generateText/streamText) → числа лога. */
export function sdkUsageTokens(
  usage: LanguageModelUsage | undefined,
): UsageTokens | null {
  return readUsageTokens({
    in: usage?.inputTokens,
    out: usage?.outputTokens,
    cacheRead: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens,
  });
}

/** Расход OpenAI-совместимого chat/completions (поле `usage` ответа) → числа лога. */
export function chatCompletionsUsageTokens(json: unknown): UsageTokens | null {
  const usage = isRecord(json) && isRecord(json.usage) ? json.usage : {};
  const details = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  return readUsageTokens({
    in: usage.prompt_tokens,
    out: usage.completion_tokens,
    cacheRead: details.cached_tokens,
    cacheWrite: undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cacheMarked(block: unknown): boolean {
  return (
    isRecord(block) &&
    isRecord(block.providerOptions) &&
    Object.values(block.providerOptions).some(
      (option) =>
        isRecord(option) &&
        ("cacheControl" in option || "cachePoint" in option),
    )
  );
}

type TapRow = {
  readonly source: "compaction" | "vision";
  readonly model: string;
  readonly label?: UsageLabel;
};

/**
 * Дописать строку расхода; ответ — легла ли строка в лог. Мусорные числа провайдера уходят
 * в журнал, а строка не пишется, как и у шага хода. Сбой диска тоже уходит в журнал и
 * дальше не идёт: вызов модели, ради которого пишется строка, уже состоялся, и его
 * результат важнее счётчика.
 */
export function recordTapUsage(
  row: TapRow,
  tokens: UsageTokens | null,
): boolean {
  if (!tokens) {
    console.error(`[usage] расход ${row.source} пропущен: мусор в usage`);
    return false;
  }
  const record = usageRecord(
    {
      source: row.source,
      provider: PROVIDER,
      model: row.model,
      sessionId: row.label?.sessionId ?? "",
      turnId: `${row.label?.turnId ?? ""}#${row.source}`,
      step: row.label?.step ?? 0,
    },
    tokens,
  );
  if (!record) return false;
  try {
    appendUsage(record);
    return true;
  } catch (error) {
    console.error(`[usage] строка ${row.source} не записана:`, error);
    return false;
  }
}

/** Расход зрения: vision-модель провайдера или пробник модели чата. */
export function recordVisionUsage(
  model: string,
  tokens: UsageTokens | null,
): boolean {
  return recordTapUsage({ source: "vision", model }, tokens);
}

/**
 * Расход зрения из стрима AI SDK. Обещание usage у стрима может отказать и после
 * дочитанного текста — это сбой учёта, а не зрения: строки нет, описание остаётся.
 */
export async function recordVisionStreamUsage(
  model: string,
  usage: PromiseLike<LanguageModelUsage>,
): Promise<boolean> {
  try {
    return recordVisionUsage(model, sdkUsageTokens(await usage));
  } catch (error) {
    console.error("[usage] расход vision не прочитан:", error);
    return false;
  }
}

/**
 * Звено цепочки makeTextModel: снимает расход компактации eve. Шаги хода идут через
 * doStream и их пишет хук; компактация — единственный generateText eve с этой моделью.
 * Без метки (модель собрана вне шага, как у объявленного узла) строка пишется без сессии и хода.
 */
export function compactionUsageMiddleware(
  label?: UsageLabel,
  model = TEXT_MODEL,
): LanguageModelMiddleware {
  return {
    transformParams({ params }) {
      try {
        if (label) takeUsageRequest(label);
        if (label && !isCompactionPrompt(params.prompt)) {
          const stable = params.prompt.filter(
            (message, i) =>
              message.role !== "user" || i !== params.prompt.length - 1,
          );
          const blocks = stable.flatMap((message) => [
            message,
            ...(Array.isArray(message.content) ? message.content : []),
          ]);
          // prettier-ignore
          const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
          const tools = params.tools ?? [];
          setUsageRequest(label, {
            system: hash(
              params.prompt.filter((message) => message.role === "system"),
            ),
            cache: hash([...blocks, ...tools].filter(cacheMarked)),
            tools: hash(tools),
            toolCount: tools.length,
          });
        }
      } catch {
        if (!fingerprintWarned) console.error("[usage] fingerprint skipped");
        fingerprintWarned = true;
      }
      return Promise.resolve(params);
    },
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      if (isCompactionPrompt(params.prompt))
        recordTapUsage(
          { source: "compaction", model, label },
          providerUsageTokens(result.usage),
        );
      return result;
    },
  };
}
