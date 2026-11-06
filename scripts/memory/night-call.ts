import { randomUUID } from "node:crypto";
import { streamText } from "ai";
import type { ZodType } from "zod";
import { makeTextModel, providerConfig, providerName } from "#provider.ts";
import { appendUsage, usageRecord } from "#lib/usage.ts";
import { sdkUsageTokens } from "#lib/usage-tap.ts";
import {
  NIGHT_DEFAULTS,
  NIGHT_MAX,
  setNightSetting,
  nightRaised,
  nightSaveFailed,
  type NightSettings,
  type NightNotice,
} from "#lib/memory-night-constants.ts";
import { parseJson } from "./night-input.ts";

// Один способ вызова модели для всей ночи у всех провайдеров: формат ответа словами и
// примером в инструкции шага, ответ — JSON в тексте, разбор мягкий. Инструментов нет. Не
// прошёл схему — один повтор с текстом ошибки, потом NightSchemaError. Сетевой
// отказ классифицируется для следующей попытки дня. Ceiling проверяется до вызова; неизвестный usage
// закрывает следующие вызовы.

export class NightCeilingError extends Error {}
export class NightSchemaError extends Error {}
class NightNetworkError extends Error {}
export class NightTransientError extends NightNetworkError {}

function failureText(error: unknown): string {
  const { message, code } = (error ?? {}) as {
    message?: string;
    code?: string;
  };
  return `${message ?? (typeof error === "string" ? error : "")} ${code ?? ""}`.trim();
}

function transient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let temporary = false;
  while (error != null && !seen.has(error)) {
    seen.add(error);
    const row = error as {
      statusCode?: number;
      status?: number;
      isRetryable?: boolean;
      cause?: unknown;
    };
    const text = failureText(error);
    const statuses = [
      row.statusCode,
      row.status,
      ...Array.from(text.matchAll(/\bHTTP\s+(\d{3})\b/giu), (m) =>
        Number(m[1]),
      ),
    ];
    if (
      statuses.some(
        (status) =>
          typeof status === "number" &&
          status >= 400 &&
          status < 500 &&
          status !== 408,
      ) ||
      /account.{0,40}(?:terminated|suspended|disabled|deactivated|blocked)|(?:invalid|incorrect|expired|revoked).{0,20}(?:api.?key|token|credentials)|insufficient[_ ]quota|exceeded.{0,30}quota|quota.{0,30}(?:exceeded|exhausted)|payment required/iu.test(
        text,
      )
    )
      return false;
    temporary ||=
      row.isRetryable === true ||
      statuses.some(
        (status) =>
          status === 408 ||
          (typeof status === "number" && status >= 500 && status < 600),
      ) ||
      /connection .{0,40}lost|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket hang up|fetch failed|other side closed|^(?:TypeError: )?terminated$|network request failed|(?:connect|body) timeout|model produced no output/iu.test(
        text,
      );
    error = row.cause;
  }
  return temporary;
}

export let modelSuccessAt: number | undefined;

export const nightModelName = providerConfig.textModel;
const model = makeTextModel({
  chatModelSeesImages: () => Promise.resolve(false),
});
const SYSTEM =
  "Ты выполняешь один шаг ночной памяти. Ответ — один JSON-объект по формату из инструкции, без пояснений.";
// Низкое рассуждение там, где провайдер его принимает.
const openai = { reasoningEffort: "low", reasoningSummary: null };
const low = providerName === "codex" ? { providerOptions: { openai } } : {};

export const ceiling = {
  calls: 0,
  inputTokens: 0,
  unknownUsage: false,
  usageLost: "",
};

export const nightCeiling = {
  limits: { ...NIGHT_DEFAULTS } as NightSettings,
  raises: 0,
  notices: [] as NightNotice[],
  blocked: new Set<"calls" | "inputTokens">(),
};

/** validate бросает с текстом, который уйдёт модели в повторе. */
export type SchemaCall<T> = {
  skill: string;
  input: unknown;
  schema: ZodType<T>;
  signal: AbortSignal;
  validate?: (value: T) => void;
};

/** Расход в usage.jsonl тем же путём, что у чата; нет usage — ночь дальше не зовёт. */
function recordUsage(
  usage: Parameters<typeof sdkUsageTokens>[0],
  estimate: number,
) {
  const tokens = Number.isSafeInteger(usage?.inputTokens)
    ? sdkUsageTokens(usage)
    : null;
  ceiling.inputTokens += tokens?.in ?? estimate * 2;
  ceiling.unknownUsage ||= !tokens;
  const turnId = `memory-night#${randomUUID()}`;
  const meta = {
    source: "memory-night",
    provider: providerName,
    model: nightModelName,
    sessionId: "",
    turnId,
    step: ceiling.calls,
  };
  const row = tokens && usageRecord(meta, tokens);
  try {
    if (row) appendUsage(row);
  } catch (error) {
    // Расход считается в памяти до конца ночи; потерянная строка видна в её итоге.
    ceiling.usageLost = String(error);
  }
}

function checkCeiling(estimate: number): void {
  if (ceiling.unknownUsage)
    throw new NightCeilingError("memory night ceiling reached");
  for (const [key, needed] of [
    ["calls", ceiling.calls + 1],
    ["inputTokens", ceiling.inputTokens + estimate],
  ] as const) {
    const limits = nightCeiling.limits;
    while (
      needed > limits[key] &&
      limits[key] < limits[NIGHT_MAX[key]] &&
      nightCeiling.raises < limits.raisesPerNight
    ) {
      const before = limits[key];
      limits[key] = Math.min(
        limits[NIGHT_MAX[key]],
        before + NIGHT_DEFAULTS[key],
      );
      nightCeiling.raises++;
      nightCeiling.notices.push(nightRaised(key, before, limits[key]));
      try {
        setNightSetting(key, limits[key]);
      } catch {
        nightCeiling.notices.push(nightSaveFailed(key));
      }
    }
    if (needed > limits[key]) {
      nightCeiling.blocked.add(key);
      throw new NightCeilingError("memory night ceiling reached");
    }
  }
  ceiling.calls++;
}

export const estimateInputTokens = (prompt: string) =>
  Math.ceil(Buffer.byteLength(prompt, "utf8") / 3);

async function oneCall<T>(call: SchemaCall<T>, hint: string): Promise<T> {
  const prompt = `${call.skill}${hint ? `\nОшибка прошлого ответа: ${hint}` : ""}\nВход:\n${JSON.stringify(call.input)}`;
  const estimate = estimateInputTokens(prompt);
  checkCeiling(estimate);
  let result;
  let streamError: unknown;
  try {
    const response = streamText({
      model,
      abortSignal: call.signal,
      maxRetries: 0,
      system: SYSTEM,
      prompt,
      ...low,
      // Ошибка идёт вызывающему коду через text/usage, без побочной печати промпта.
      onError: ({ error }) => {
        streamError = error;
      },
    });
    const [text, usage] = await Promise.all([response.text, response.usage]);
    call.signal.throwIfAborted();
    if (streamError !== undefined)
      throw new Error("model stream failed", { cause: streamError });
    result = { text, usage };
  } catch (error) {
    ceiling.inputTokens += estimate;
    if (call.signal.aborted) throw error;
    const cause = streamError ?? error;
    const Failure = transient(cause) ? NightTransientError : NightNetworkError;
    throw new Failure(String(cause), { cause });
  }
  modelSuccessAt = Date.now();
  recordUsage(result.usage, estimate);
  const parsed = call.schema.safeParse(parseJson(result.text));
  if (!parsed.success)
    throw new Error(`ответ не по формату: ${parsed.error.message}`);
  call.validate?.(parsed.data);
  return parsed.data;
}

/** Ошибка ответа (форма, проверка), а не сеть, Ceiling или обрыв по сроку: один повтор
 * с текстом ошибки, второй отказ — NightSchemaError. */
export async function callBySchema<T>(call: SchemaCall<T>): Promise<T> {
  let hint = "";
  for (let attempt = 0; ; attempt++)
    try {
      return await oneCall(call, hint);
    } catch (error) {
      const network =
        error instanceof NightCeilingError ||
        error instanceof NightNetworkError;
      if (network || call.signal.aborted) throw error;
      hint = error instanceof Error ? error.message : String(error);
      if (attempt === 1) throw new NightSchemaError(hint);
    }
}
