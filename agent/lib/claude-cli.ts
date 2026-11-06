// Модель вендора claude: Iva зовёт установленный и залогиненный Claude Code CLI на той же
// машине и говорит с ним на его языке — stream-json. Ключа нет: ни api.anthropic.com, ни
// подписочный токен не читаются отсюда, авторизацию держит CLI.
//
// Устройство одного шага:
//   1. История eve превращается в кадры stream-json: система уезжает отдельным файлом
//      (--system-prompt-file), пары «вызов инструмента/результат» — блоками tool_use и
//      tool_result в user-кадрах, картинки — только base64. Все кадры, кроме последнего
//      user-кадра, идут с shouldQuery:false и получают ответ `result num_turns:0`: это
//      переигрывание истории, а не ход модели (см. пробник probe.mjs).
//   2. Инструменты Iva уезжают ДВУМЯ путями сразу: манифест в муляж MCP, чтобы модель знала
//      их имена и схемы, и tools в CLAUDE_CODE_EXTRA_BODY. Муляж отвечает на tools/call
//      отказом: инструменты исполняет eve, не CLI.
//   3. Единственный настоящий запрос к api.anthropic.com идёт через локальное реле допуска
//      (claude-admission.ts). Оно пропускает первый POST /v1/messages и отбивает второй —
//      поэтому шагов eve ровно столько же, сколько запросов к api.anthropic.com, а
//      продолжение хода после tool_use делает eve, а не CLI.
//   4. Наружу (в eve) уезжает то, что вернул настоящий ответ. Каждое событие stream_event с
//      полезной нагрузкой уходит в момент прихода: text_delta — текстом, начало блока
//      thinking и tool_use — началом рассуждения и вызова, их непустые дельты — дельтами.
//      Ничего не копится до выхода CLI: сторож первой части в eve снимается только такой
//      частью. Части tool-call уходят в конце, после сверки с ответом, который поймало реле,
//      за ними finish с расходом и причиной остановки. Расход берётся из ПЕРВОГО ответа (реле
//      запомнило его целиком), а не из `result` CLI: у CLI свои представления о том, сколько
//      он потратил.
//
// Процесс CLI — в своей группе (detached), поэтому отмена хода убивает и его, и детей
// (`process.kill(-pid)`), и не оставляет за собой висящих запросов. Тишина CLI дольше
// CLAUDE_SILENCE_TIMEOUT_MS считается смертью хода; таймер сбрасывается на КАЖДОМ событии,
// потому что думающая модель молчит между дельтами дольше, чем между кадрами.

import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import {
  claudeAuthRotationStream,
  type ClaudeTurn,
} from "./claude-auth-rotation.ts";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4ToolResultPart,
  LanguageModelV4Usage,
  SharedV4FileData,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import {
  ADMISSION_CONSUMED,
  startAdmission,
  type Admission,
  type NativeBlock,
  type NativeMessage,
} from "./claude-admission.ts";
import { CANONICAL_REASONING_EFFORTS } from "./reasoning-levels.ts";
import { TOOL_NAME_MAX, wireToolName } from "./tool-wire-name.ts";
import {
  claudeNotFound,
  resolveClaude,
} from "../../packages/claude-command/index.ts";

const CLAUDE_PROVIDER_ID = "iva-claude";
/** Префикс имён инструментов в муляже MCP: по нему видно, что вызов пришёл от Iva. */
export const CLAUDE_TOOL_PREFIX = "mcp__iva__";
/** Предел имени без префикса: на проводе имя с префиксом укладывается в TOOL_NAME_MAX. */
export const CLAUDE_TOOL_NAME_MAX = TOOL_NAME_MAX - CLAUDE_TOOL_PREFIX.length;
/**
 * Префикс message.id кадров ассистента. Кадры без id CLI склеивает в одно сообщение, и запрос
 * следующего шага перестаёт начинаться с запроса прошлого: кэш промпта не читает историю (#236).
 * Точка удаления — версия CLI, в которой stream-json не склеивает кадры без id. В 2.1.280 склейка
 * есть: в бинаре строка «stamped a message.id on id-less assistant entries (pre-#61940
 * stream-json injection)».
 */
export const CLAUDE_MESSAGE_ID_PREFIX = "msg_iva_";
/** Тишина CLI, после которой ход считается мёртвым. Отсчитывается заново на каждом событии. */
export const CLAUDE_SILENCE_TIMEOUT_MS = 180_000;
/** Сколько ждать выхода процесса после того, как он закрыл вывод. */
const CLAUDE_EXIT_GRACE_MS = 5_000;

const CLAUDE_UPSTREAM = "https://api.anthropic.com";
/** Значения, при которых переменная означает «не включено». */
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);
/**
 * Переменные, при которых ход ушёл бы мимо подписки владельца. Ключи уводят CLI на платный
 * ключ; `ANTHROPIC_BASE_URL` — на чужой адрес, и молча подменять его адресом реле значило бы
 * тихо отменять настройку владельца: его прокси перестал бы работать, не сказав ни слова.
 */
const AUTH_CONFLICTS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_BASE_URL",
];
/** Префикс переменных, которыми CLI уходит на другой бэкенд: bedrock, vertex, foundry и новые. */
const BACKEND_PREFIX = "CLAUDE_CODE_USE_";
/**
 * Что CLI обязан видеть с этими значениями. Телеметрия и необязательный трафик выключены:
 * они уходят на чужие адреса, а ход — это запрос к api.anthropic.com и ничего больше.
 * Повторы выключены: реле допуска пропускает ОДИН запрос, и повтор CLI — это второй.
 * Нестриминговый запрос после сбоя потока выключен по той же причине: это тоже второй POST,
 * реле его отбивает, и вместо причины обрыва CLI печатает отказ реле.
 * Автосжатие выключено: историю держит eve, а сжатая CLI история ломает кэш подписки.
 */
const CLAUDE_ENV: Record<string, string> = {
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_MAX_RETRIES: "0",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
};
export { claudeModel, claudeContextWindow } from "./context-window.ts";
import { claudeModel } from "./context-window.ts";

/** Имя модели в том виде, в каком его понимает `claude -p --model`. */
export function claudeNativeModel(route: string): string {
  return claudeModel(route).native;
}

/** Имя инструмента: правило Anthropic, [A-Za-z0-9_-] и вместе с префиксом до 64 символов. */
/**
 * Усилия, которые принимает `output_config.effort`. `minimal` в их числе нет: подписка
 * отвечает на него 400, а `disabled` Iva и не знает — словарь лежит в reasoning-levels.ts
 * и общий с остальными вендорами.
 */
const CLAUDE_EFFORTS: readonly string[] = CANONICAL_REASONING_EFFORTS.filter(
  (effort) => effort !== "minimal",
);
const SAMPLING_DETAILS = "Claude by subscription rejects sampling controls";
const SAMPLING_FIELDS = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;

/**
 * Муляж MCP: список инструментов и отказ на любой вызов. Живёт inline-скриптом в `node -e`,
 * а не файлом рядом: собранный eve бандл не обещает, что соседний файл доедет до установки.
 * Последний аргумент — файл манифеста (`node -e <код> <манифест>` даёт его в argv[1]).
 */
const INERT_MCP = `const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\\n");
    if (end < 0) return;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === "") continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!("id" in row)) continue;
    const result = row.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "iva-inert-inventory", version: "1" } }
      : row.method === "tools/list"
        ? { tools: manifest }
        : row.method === "tools/call"
          ? { isError: true, content: [{ type: "text", text: "Denied: tools run in Iva, not here." }] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\\n");
  }
});`;

/**
 * Ошибка шага claude. Нарочно без statusCode: ход чинится повтором, а не отравлением сессии.
 * `isRetryable` — связь с api.anthropic.com оборвалась так, как видело реле: ответа не было,
 * 408, 429, 5xx или поток кончился до `message_stop`. По этому флагу eve просит шаг ещё раз,
 * пока не пришло ни одной части ответа (eve, runModelCallWithRetries), а каждый
 * новый запрос — это новый doStream, свой процесс CLI и своё реле со своим единственным
 * допуском (startAdmission в runCall). Отказ на вход (401, 403) и прочие 4xx флага не несут.
 */
export class ClaudeCliError extends Error {
  override readonly name = "ClaudeCliError";
  readonly isRetryable: boolean;
  readonly authRotation: boolean;
  constructor(
    message: string,
    { retryable = false, authRotation = false } = {},
  ) {
    super(message);
    this.isRetryable = retryable;
    this.authRotation = authRotation;
  }
}

/** Блок ответа модели: у Anthropic это text, thinking, tool_use, redacted_thinking и другие. */
type ClaudeBlock = NativeBlock;

/** Кадр stream-json: сообщение CLI в его собственном формате. */
export type ClaudeFrame = {
  readonly type: "user" | "assistant";
  message: {
    /** Есть у каждого кадра ассистента: номер по порядку, см. CLAUDE_MESSAGE_ID_PREFIX. */
    readonly id?: string;
    readonly role: "user" | "assistant";
    content: ClaudeBlock[];
  };
  /** false — переигрывание истории: CLI отвечает `result num_turns:0` и не идёт к модели. */
  readonly shouldQuery?: boolean;
};

type ClaudeToolCall = {
  /** Идентификатор вызова: тот же, что придёт обратно в tool_result. */
  readonly id: string;
  /** Имя без префикса — то, что знает eve. */
  readonly name: string;
  /** Аргументы JSON-строкой, как их ждёт AI SDK. */
  readonly input: string;
};

/** Всё, что eve считает содержимым шага: текст, вызовы, причина остановки и расход. */
export type ClaudeCompletion = {
  readonly text: string;
  readonly calls: readonly ClaudeToolCall[];
  readonly stopReason: string | undefined;
  readonly usage: LanguageModelV4Usage;
  readonly hasUsage: boolean;
};

// ─── Инструменты ────────────────────────────────────────────────────────────────────────

type ClaudeToolManifest = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema7;
};

type ClaudeToolBody = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JSONSchema7;
};

/**
 * Раскладывает инструменты eve на две половины: манифест для муляжа MCP (имена и схемы,
 * которые видит модель) и тело запроса с префиксом. Схему не переписываем: у Anthropic она
 * та же JSON Schema, что у eve, а менять чужую схему на своей границе — терять поля.
 */
export function claudeTools(tools: LanguageModelV4CallOptions["tools"]): {
  manifest: ClaudeToolManifest[];
  body: ClaudeToolBody[];
  names: string[];
} {
  const manifest: ClaudeToolManifest[] = [];
  const body: ClaudeToolBody[] = [];
  const names: string[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== "function")
      throw new ClaudeCliError(
        `Claude CLI runs Iva function tools only, got a ${tool.type} tool`,
      );
    if (wireToolName(tool.name, CLAUDE_TOOL_NAME_MAX) !== tool.name)
      throw new ClaudeCliError(
        `tool name ${JSON.stringify(tool.name)} does not match [A-Za-z0-9_-]{1,${CLAUDE_TOOL_NAME_MAX}}`,
      );
    if (names.includes(tool.name))
      throw new ClaudeCliError(
        `tool name ${JSON.stringify(tool.name)} is not unique in this request`,
      );
    const description = tool.description ?? "";
    names.push(tool.name);
    manifest.push({
      name: tool.name,
      description,
      inputSchema: tool.inputSchema,
    });
    body.push({
      name: CLAUDE_TOOL_PREFIX + tool.name,
      description,
      input_schema: tool.inputSchema,
    });
  }
  return { manifest, body, names };
}

/** Усилие рассуждения из THINKING_EFFORT; `minimal` и мусор не отправляются вовсе. */
export function claudeEffort(raw: string | undefined): string | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  return CLAUDE_EFFORTS.includes(value) ? value : undefined;
}

/**
 * Тело, которое CLI подмешивает в запрос (CLAUDE_CODE_EXTRA_BODY): инструменты, adaptive
 * thinking, усилие, потолок вывода и стоп-последовательности. Температуры и top_p здесь нет
 * намеренно — подписка их отвергает, а не «принимает и игнорирует».
 */
export function claudeExtraBody(
  options: LanguageModelV4CallOptions,
  tools: readonly ClaudeToolBody[],
  route: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { tools };
  // adaptive thinking и усилие едут вместе: без первого второе не имеет смысла, а модель,
  // которая adaptive не умеет (Haiku 4.5), отвергает и то и другое.
  if (claudeModel(route).adaptive) {
    body.thinking = { type: "adaptive" };
    const effort = claudeEffort(process.env.THINKING_EFFORT);
    if (effort !== undefined) body.output_config = { effort };
  }
  if (options.maxOutputTokens !== undefined)
    body.max_tokens = options.maxOutputTokens;
  if (options.stopSequences !== undefined && options.stopSequences.length > 0)
    body.stop_sequences = options.stopSequences;
  return body;
}

/** Что eve просил, а подписка не принимает: молчаливая потеря параметра выглядела бы поломкой хода. */
export function claudeWarnings(
  options: LanguageModelV4CallOptions,
): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const field of SAMPLING_FIELDS)
    if (options[field] !== undefined)
      warnings.push({
        type: "unsupported",
        feature: field,
        details: SAMPLING_DETAILS,
      });
  // Принуждение к инструменту и строгий JSON на выходе Claude Code не передаёт: ход идёт
  // через его собственный запрос, и чужие поля тела в него не попадают. Молча потерять
  // их нельзя — вызывающий ждал бы гарантии, которой нет.
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto")
    warnings.push({
      type: "unsupported",
      feature: "toolChoice",
      details: `Claude by subscription always chooses tools itself, ${options.toolChoice.type} is ignored`,
    });
  if (
    options.responseFormat !== undefined &&
    options.responseFormat.type !== "text"
  )
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details: "Claude by subscription answers in text, not in a given schema",
    });
  return warnings;
}

// ─── История eve → кадры stream-json ────────────────────────────────────────────────────

/**
 * История eve в кадры CLI. Возвращает system отдельно: он уезжает файлом, а не кадром.
 * Последний кадр — всегда непустой user (иначе ход не начать: prefill ассистента CLI не
 * принимает), а все user-кадры до него помечены shouldQuery:false — это переигрывание.
 */
export function claudeHistory(prompt: LanguageModelV4Prompt): {
  system: string;
  frames: ClaudeFrame[];
} {
  const system: string[] = [];
  const frames: ClaudeFrame[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      if (frames.length > 0)
        throw new ClaudeCliError(
          "system messages must come before the history",
        );
      system.push(message.content);
      continue;
    }
    appendFrame(frames, ...messageBlocks(message));
  }
  return { system: system.join("\n\n"), frames: sealFrames(frames) };
}

type Role = "user" | "assistant";

function messageBlocks(
  message: Exclude<LanguageModelV4Message, { role: "system" }>,
): [Role, ClaudeBlock[]] {
  if (message.role === "user") return ["user", userBlocks(message.content)];
  if (message.role === "assistant")
    return ["assistant", assistantBlocks(message.content)];
  return ["user", toolResultBlocks(message.content)];
}

/**
 * Подряд идущие сообщения одной роли склеиваются в один кадр: у CLI один кадр — одно сообщение
 * истории, и кадры не зависят от того, как CLI склеивает соседей сам.
 */
function appendFrame(
  frames: ClaudeFrame[],
  role: Role,
  blocks: ClaudeBlock[],
): void {
  if (blocks.length === 0) return;
  const last = frames.at(-1);
  if (last !== undefined && last.type === role) {
    last.message.content.push(...blocks);
    return;
  }
  frames.push({ type: role, message: { role, content: blocks } });
}

function sealFrames(frames: ClaudeFrame[]): ClaudeFrame[] {
  const last = frames.at(-1);
  if (
    last === undefined ||
    last.type !== "user" ||
    last.message.content.length === 0
  )
    throw new ClaudeCliError(
      "Claude CLI needs the history to end with a non-empty user or tool-result message (assistant prefill is unsupported)",
    );
  // Номер кадра ассистента по порядку: история только растёт, и у кадра он тот же на каждом
  // шаге. Хэш содержимого не годится: одинаковые тексты и повторные id вызовов совпали бы.
  let assistants = 0;
  return frames.map((frame, index) => {
    if (frame.type === "assistant")
      return {
        ...frame,
        message: {
          id: `${CLAUDE_MESSAGE_ID_PREFIX}${assistants++}`,
          ...frame.message,
        },
      };
    return index < frames.length - 1 ? { ...frame, shouldQuery: false } : frame;
  });
}

function userBlocks(
  content: Extract<LanguageModelV4Message, { role: "user" }>["content"],
): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];
  for (const part of content) {
    if (part.type === "text") pushText(blocks, part.text);
    else if (part.type === "file") blocks.push(imageBlock(part));
    else
      throw new ClaudeCliError(
        `Claude prompt carries an unsupported ${partType(part)} part in a user message`,
      );
  }
  return blocks;
}

function assistantBlocks(
  content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"],
): ClaudeBlock[] {
  const blocks: ClaudeBlock[] = [];
  for (const part of content) {
    if (part.type === "text") pushText(blocks, part.text);
    else if (part.type === "tool-call")
      blocks.push({
        type: "tool_use",
        id: part.toolCallId,
        name: historyToolName(part.toolName),
        input: toolInput(part.input),
      });
    // Рассуждение в историю не возвращается: у claude replaysReasoning=false (его режет
    // withReplayableReasoning), а подписка за рассуждение без подписи отвечает отказом.
    else if (part.type !== "reasoning" && part.type !== "reasoning-file")
      throw new ClaudeCliError(
        `Claude prompt carries an unsupported ${partType(part)} part in an assistant message`,
      );
  }
  return blocks;
}

/**
 * Имя вызова в истории. Неузнанное имя модели возвращается в следующий запрос, а Anthropic
 * принимает только `[A-Za-z0-9_-]{1,64}`: имя кодируется тем же wireToolName, что и у middleware
 * провода (допустимое уходит как есть, кэш промпта не меняется); пустое — `unknown`.
 */
function historyToolName(name: string): string {
  return (
    CLAUDE_TOOL_PREFIX + wireToolName(name || "unknown", CLAUDE_TOOL_NAME_MAX)
  );
}

function toolResultBlocks(
  content: Extract<LanguageModelV4Message, { role: "tool" }>["content"],
): ClaudeBlock[] {
  return content.map((part) => {
    // Согласие на вызов инструмента Iva не спрашивает: инструменты eve исполняются сами.
    if (part.type !== "tool-result")
      throw new ClaudeCliError(
        `Claude CLI cannot be asked for a ${partType(part)} answer to a tool`,
      );
    return toolResultBlock(part);
  });
}

function toolResultBlock(part: LanguageModelV4ToolResultPart): ClaudeBlock {
  const output = part.output;
  const block: ClaudeBlock = {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content: toolResultContent(output),
  };
  if (isErrorOutput(output)) block.is_error = true;
  return block;
}

function toolResultContent(output: LanguageModelV4ToolResultOutput): unknown {
  if (output.type === "text" || output.type === "error-text")
    return output.value;
  if (output.type === "json" || output.type === "error-json")
    return JSON.stringify(output.value);
  if (output.type === "execution-denied") return output.reason ?? "Denied";
  return output.value.map((part) => resultContentBlock(part));
}

/** Часть внутри результата инструмента: текст или картинка, и ничего больше. */
function resultContentBlock(part: {
  readonly type: string;
  readonly text?: string;
  readonly mediaType?: string;
  readonly data?: SharedV4FileData;
}): ClaudeBlock {
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  if (part.type === "file") return imageBlock(part);
  throw new ClaudeCliError(
    `Claude CLI cannot take a ${part.type} part inside a tool result`,
  );
}

function isErrorOutput(output: { type: string }): boolean {
  return (
    output.type === "error-text" ||
    output.type === "error-json" ||
    output.type === "execution-denied"
  );
}

/** Имя части для сообщения об отказе: у закрытых союзов типов до ветки отказа не дойти. */
function partType(part: unknown): string {
  const type = (part as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" ? type : "unknown";
}

/** Текстовая часть: пустая не занимает места в кадре и не считается содержимым. */
function pushText(blocks: ClaudeBlock[], text: string): void {
  if (text.length > 0) blocks.push({ type: "text", text });
}

function imageBlock(part: {
  readonly mediaType?: string;
  readonly data?: SharedV4FileData;
}): ClaudeBlock {
  const mediaType = part.mediaType ?? "";
  if (!mediaType.startsWith("image/"))
    throw new ClaudeCliError(
      `Claude accepts images only, got ${mediaType || "an unknown media type"}`,
    );
  const data = part.data;
  if (data === undefined || data.type !== "data")
    throw new ClaudeCliError(
      `Claude accepts images only as inline base64 data, got a ${data?.type ?? "missing"} reference`,
    );
  const raw = data.data;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: base64Data(raw),
    },
  };
}

/** Байты кодируем сами, строку берём как base64 (срезав data-URL, если он пришёл целиком). */
function base64Data(raw: unknown): string {
  if (typeof raw === "string") return raw.replace(/^data:[^,]*;base64,/u, "");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
  throw new ClaudeCliError(
    "Claude accepts images only as bytes or base64 text",
  );
}

/** Аргументы вызова: AI SDK хранит их строкой, но история могла прийти и объектом. */
function toolInput(input: unknown): unknown {
  if (input === undefined || input === null) return {};
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ClaudeCliError(
      "history carries a tool call whose input is not JSON",
    );
  }
}

// ─── Ответ модели → то, что видит eve ───────────────────────────────────────────────────

/** Собирает содержимое шага из сообщений модели: текст, вызовы инструментов и расход. */
export function readCompletion(
  messages: readonly NativeMessage[],
  usage: Record<string, unknown> | undefined = messages.at(-1)?.usage,
  inventory: readonly string[] = [],
): ClaudeCompletion {
  const blocks = messages.flatMap((message) => message.content ?? []);
  return {
    text: blocks
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => String(block.text))
      .join(""),
    calls: blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => toolCall(block, inventory)),
    stopReason: stopReasonOf(messages),
    usage: claudeUsage(usage),
    hasUsage:
      typeof usage?.input_tokens === "number" ||
      typeof usage?.output_tokens === "number",
  };
}

/**
 * Имя вызова для eve. Инструмент набора узнаётся только по точному имени и по имени с префиксом
 * Iva: модель видит имена только в этом виде (муляж MCP `iva`, `--strict-mcp-config`). Всё
 * остальное — без префикса, в другом регистре, с чужим префиксом MCP, свои инструменты CLI вроде
 * `Bash` — уходит в eve как есть: угадывание сделало бы `Bash` от Claude инструментом `bash` Ивы.
 * На ошибку модели eve отвечает ей tool-error со списком доступных, как у любого вендора.
 */
function ivaToolName(wireName: string, inventory: readonly string[]): string {
  if (inventory.includes(wireName)) return wireName;
  return wireName.startsWith(CLAUDE_TOOL_PREFIX)
    ? wireName.slice(CLAUDE_TOOL_PREFIX.length)
    : wireName;
}

function toolCall(
  block: ClaudeBlock,
  inventory: readonly string[],
): ClaudeToolCall {
  return {
    id: text(block.id),
    name: ivaToolName(text(block.name), inventory),
    // Отсутствующие аргументы — пустой объект (так их шлёт Anthropic для инструмента без
    // параметров), а всё остальное уезжает как есть, включая null: подменять значение модели
    // на своё — это выдумывать вызов, которого не было. `partial_json` — сырые аргументы, которые
    // реле не разобрало как JSON (blockStop): их разбирает и отвергает eve.
    input:
      typeof block.partial_json === "string"
        ? block.partial_json
        : JSON.stringify(block.input === undefined ? {} : block.input),
  };
}

function stopReasonOf(messages: readonly NativeMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reason = messages[index]?.stop_reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return undefined;
}

/**
 * Расход шага из usage настоящего ответа. `total` включает кэш: у Anthropic `input_tokens`
 * считает только некэшированный вход, а платит владелец за весь. cache-read и cache-write
 * едут отдельными полями — их ждёт agent/hooks/usage.ts.
 */
export function claudeUsage(
  usage: Record<string, unknown> | undefined,
): LanguageModelV4Usage {
  const input = tokenCount(usage?.input_tokens);
  const cacheRead = tokenCount(usage?.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage?.cache_creation_input_tokens);
  const details = usage?.output_tokens_details as
    Record<string, unknown> | undefined;
  return {
    inputTokens: {
      total: input + cacheRead + cacheWrite,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: tokenCount(usage?.output_tokens),
      text: undefined,
      reasoning: tokenCount(details?.thinking_tokens),
    },
    raw: (usage ?? {}) as JSONObject,
  };
}

/** Строковое поле чужого JSON: не строка — пустая строка, а не «[object Object]». */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Токены — целое неотрицательное: дробное и отрицательное это мусор провайдера, не расход. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

// ─── Запуск CLI ─────────────────────────────────────────────────────────────────────────

/**
 * Окружение процесса CLI: своё плюс выключенный лишний трафик и адрес реле. Значения
 * посторонних ANTHROPIC_* или CLAUDE_CODE_USE_* не читаются и не печатаются: с ключом в
 * окружении CLI пошёл бы мимо подписки, а секрет в журнале — это секрет в журнале.
 */
export function claudeEnv(
  source: Readonly<Record<string, string | undefined>>,
  relayUrl: string,
  maxOutputTokens?: number,
): Record<string, string> {
  const conflicts = claudeConflicts(source);
  if (conflicts.length > 0)
    throw new ClaudeCliError(
      `Claude Code CLI refuses to run while ${conflicts.join(", ")} is set: unset ${conflicts.length > 1 ? "them" : "it"} and restart Iva (values are never printed)`,
    );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined) env[key] = value;
  // Унаследованное тело запроса — чужие инструменты и чужой потолок вывода поверх наших:
  // своё Iva кладёт в приватный settings.json и другого источника не признаёт.
  delete env.CLAUDE_CODE_EXTRA_BODY;
  const child: Record<string, string> = {
    ...env,
    ...CLAUDE_ENV,
    ANTHROPIC_BASE_URL: relayUrl,
  };
  // Потолок вывода CLI знает и сам, до запроса: без этой переменной он подставит свой и
  // попросит у модели больше, чем разрешила eve.
  if (maxOutputTokens !== undefined)
    child.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return child;
}

/** Имена конфликтующих переменных — без значений: этого достаточно, чтобы починить .env. */
export function claudeConflicts(
  source: Readonly<Record<string, string | undefined>>,
): string[] {
  const names = AUTH_CONFLICTS.filter((key) => (source[key] ?? "").length > 0);
  // Бэкенды ищутся по префиксу, а не по списку трёх имён: следующий бэкенд Anthropic проехал бы
  // по списку молча и увёл ход мимо подписки — то есть ровно туда, куда ход идти не должен.
  const backends = Object.keys(source)
    .filter(
      (key) =>
        key.startsWith(BACKEND_PREFIX) &&
        !OFF_VALUES.has((source[key] ?? "").toLowerCase()),
    )
    .sort();
  return names.concat(backends);
}

/**
 * Команда CLI с аргументами или null. Ищется по PATH процесса: под юнитом это PATH сервиса
 * (каталог node, затем `~/.local/bin`, куда ставит подсказка), тот же, которым ищет доктор.
 * PATH не переписываем: подмена PATH — это чужие `claude` в ходу.
 */
export function claudeCommand(
  env: Readonly<Record<string, string | undefined>>,
): string[] | null {
  return resolveClaude(env.CLAUDE_COMMAND, env.PATH);
}

type PreparedCall = {
  readonly frames: ClaudeFrame[];
  readonly argv: string[];
};

/** Раскладывает один вызов по временной папке: system.md, tools.json, settings.json и argv. */
function prepareCall(
  model: string,
  options: LanguageModelV4CallOptions,
  session: ClaudeSession,
): PreparedCall {
  const dir = session.tempDir;
  const { system, frames } = claudeHistory(options.prompt);
  const tools = claudeTools(options.tools);
  writeFileSync(join(dir, "system.md"), system, "utf8");
  writeFileSync(
    join(dir, "tools.json"),
    JSON.stringify(tools.manifest),
    "utf8",
  );
  // Настройки приватные (в своей временной папке) и приходят через --settings: длинные схемы
  // инструментов не переживают execve-лимит на размер одного аргумента.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      env: {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify(
          claudeExtraBody(options, tools.body, model),
        ),
      },
    }),
    "utf8",
  );
  return { frames, argv: claudeArgv(model, dir) };
}

function claudeArgv(model: string, dir: string): string[] {
  const manifestPath = join(dir, "tools.json");
  const mcp = JSON.stringify({
    mcpServers: {
      iva: { command: process.execPath, args: ["-e", INERT_MCP, manifestPath] },
    },
  });
  return [
    "-p",
    "--model",
    claudeNativeModel(model),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Свои инструменты CLI выключены: единственный источник имён — наш муляж MCP.
    "--tools",
    "",
    "--system-prompt-file",
    join(dir, "system.md"),
    "--settings",
    join(dir, "settings.json"),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--mcp-config",
    mcp,
  ];
}

// ─── Рабочая папка CLI ──────────────────────────────────────────────────────────────────
// CLI печатает свою рабочую папку в блок «# Environment» запроса, в начало истории. Будь это
// временная папка шага, запрос каждого шага отличался бы от прошлого уже во втором сообщении,
// и кэш промпта записывал бы весь хвост истории заново. Поэтому CLI работает в папке, одной на
// сессию eve, а временная папка шага держит только system.md, tools.json и settings.json.
// Папка сессии лежит в ОС-tmp, а не в каталоге данных: тот внутри git-checkout установки,
// и CLI вписал бы в Environment «Is a git repository: true».

/** Выключатель постоянной папки: CLAUDE_SESSION_CWD=0|false|no|off — папка снова на шаг. */
export function claudeSessionCwdEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = (env.CLAUDE_SESSION_CWD ?? "").trim().toLowerCase();
  return raw === "" || !OFF_VALUES.has(raw);
}

/**
 * Рабочая папка CLI для сессии eve: один путь на sessionId, свой у каждой сессии. Вместо
 * sessionId в пути его хэш: путь виден модели, а id сессии ей ни к чему. Родитель несёт uid,
 * чтобы у двух пользователей одной машины были разные папки.
 */
export function claudeSessionCwd(
  sessionId: string,
  root: string = tmpdir(),
): string {
  const hash = createHash("sha256")
    .update(sessionId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return join(root, `iva-cwd-${String(process.getuid?.() ?? "user")}`, hash);
}

/**
 * Папка для шага: папка сессии, если она есть и своя, иначе временная папка шага. Папка сессии
 * создаётся здесь, в момент первого шага, с правами 0700.
 */
function stepCwd(session: ClaudeSession, run: ClaudeRun): string {
  const sessionId = run.sessionId?.trim() ?? "";
  if (sessionId === "" || !claudeSessionCwdEnabled(process.env))
    return session.tempDir;
  const cwd = claudeSessionCwd(sessionId);
  return privateDir(dirname(cwd)) && privateDir(cwd) ? cwd : session.tempDir;
}

/**
 * Создаёт папку 0700 или принимает уже созданную, но только свою: настоящая папка (не симлинк
 * и не файл), владелец — этот процесс, для группы и остальных закрыта. Иначе — false: в общем
 * /tmp её мог подложить кто угодно.
 */
function privateDir(path: string): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    return (
      stat.isDirectory() &&
      (stat.mode & 0o077) === 0 &&
      (uid === undefined || stat.uid === uid)
    );
  } catch {
    return false;
  }
}

/** Временная папка, реле и процесс в одном месте: отмена и уборка — это один вызов. */
class ClaudeSession {
  tempDir: string;
  private child: ChildProcess | undefined;
  private admission: Admission | undefined;
  private closed = false;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), "iva-claude-"));
  }

  adopt(admission: Admission): void {
    this.admission = admission;
  }

  attach(child: ChildProcess): void {
    this.child = child;
    // После `spawn` ошибка процесса приходит сюда: без слушателя она стала бы исключением
    // в чужом стеке, а ход и так узнает о беде по закрытому выводу.
    child.on("error", () => undefined);
  }

  abort(): void {
    this.admission?.abort();
    killTree(this.child);
  }

  /** Закрытие идемпотентно: runCall убирает за собой до конца шага, а `finally` — следом. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    try {
      await this.admission?.close();
      if (this.child !== undefined) await waitForExit(this.child);
    } finally {
      rmSync(this.tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Убивает процесс и всех его детей. CLI — это node, который сам поднимает детей (муляж MCP),
 * поэтому `kill` по одному pid оставил бы их висеть; группа процессов заводится при запуске
 * (detached), и минус-pid бьёт по всей группе.
 */
function killTree(child: ChildProcess | undefined): void {
  if (child === undefined || child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function spawnClaude(
  command: string[] | null,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  if (command === null)
    throw new ClaudeCliError(
      claudeNotFound(options.env?.CLAUDE_COMMAND, options.env?.PATH),
    );
  const [head, ...args] = command;
  const child = spawn(head, [...args, ...argv], options);
  return await new Promise<ChildProcess>((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", (error: Error) =>
      reject(
        new ClaudeCliError(
          `claude CLI (${head}) did not start: ${error.message}`,
        ),
      ),
    );
  });
}

// ─── Чтение вывода CLI ──────────────────────────────────────────────────────────────────

/** Строки stdout как JSON-события CLI: одна строка — одно событие. */
async function* jsonLines(
  stream: Readable,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.write(chunk as Buffer);
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim().length > 0) yield parseEvent(line);
      end = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  if (buffer.trim().length > 0) yield parseEvent(buffer);
}

function parseEvent(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null)
    throw new ClaudeCliError(
      "Claude CLI printed a stream-json line that is not an object",
    );
  return parsed as Record<string, unknown>;
}

/**
 * Тишина дольше timeoutMs — смерть хода, но таймер взводится заново на каждом событии:
 * думающая модель молчит между дельтами дольше, чем CLI между кадрами.
 */
async function* silentFor(
  source: AsyncGenerator<Record<string, unknown>>,
  timeoutMs: number,
): AsyncGenerator<Record<string, unknown>> {
  const iterator = source[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ClaudeCliError(
              `Claude CLI produced nothing for ${timeoutMs / 1000}s`,
            ),
          ),
        timeoutMs,
      );
    });
    let next: IteratorResult<Record<string, unknown>>;
    try {
      next = await Promise.race([iterator.next(), expired]);
    } finally {
      clearTimeout(timer);
    }
    if (next.done === true) return;
    yield next.value;
  }
}

// ─── Шаг модели ─────────────────────────────────────────────────────────────────────────

type ClaudeSettings = {
  /** The provider's existing deadline, applied inside recovery to each attempt. */
  readonly attemptMiddleware?: LanguageModelMiddleware;
  readonly turn?: ClaudeTurn;
  /** Тишина CLI до отказа; в тестах — доли секунды, в бою CLAUDE_SILENCE_TIMEOUT_MS. */
  readonly silenceTimeoutMs?: number;
  /**
   * Адрес API, на который реле пересылает шаг. В бою — api.anthropic.com; в тестах — заглушка:
   * без подмены боевая ветка «ответ поймало реле» не наблюдаема вовсе, а в ней живут и расход,
   * и блоки ответа, и сверка напечатанного CLI с полученным.
   */
  readonly upstream?: string;
  /** Сессия eve: её шаги идут в одной рабочей папке CLI (см. claudeSessionCwd). */
  readonly sessionId?: string;
};

/** Что шаг берёт из настроек модели: тишина CLI, адрес для реле и сессия eve. */
type ClaudeRun = {
  readonly silenceMs: number;
  readonly upstream: string;
  readonly sessionId?: string;
};

/** Рукописная LanguageModelV4: шаг модели — это один запуск Claude Code CLI. */
export function makeClaudeCliModel(
  model: string,
  settings: ClaudeSettings = {},
): LanguageModelV4 {
  const run: ClaudeRun = {
    silenceMs: settings.silenceTimeoutMs ?? CLAUDE_SILENCE_TIMEOUT_MS,
    upstream: settings.upstream ?? CLAUDE_UPSTREAM,
    sessionId: settings.sessionId,
  };
  const single: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: CLAUDE_PROVIDER_ID,
    modelId: model,
    // Картинки едут только base64: URL пришлось бы скачивать, а у CLI нет для этого канала.
    supportedUrls: {},
    doStream: (options: LanguageModelV4CallOptions) =>
      Promise.resolve(attemptStream(model, options, run)),
    doGenerate: (options: LanguageModelV4CallOptions) =>
      generateCall(options, (options) => attemptStream(model, options, run)),
  };
  const attempt = settings.attemptMiddleware
    ? wrapLanguageModel({
        model: single,
        middleware: settings.attemptMiddleware,
      })
    : single;
  const recovered = (options: LanguageModelV4CallOptions) =>
    claudeAuthRotationStream(
      options,
      settings.turn,
      (options) => attempt.doStream(options),
      (error) => error instanceof ClaudeCliError && error.authRotation,
    );
  return {
    ...single,
    doStream: (options) => Promise.resolve(recovered(options)),
    doGenerate: (options) => generateCall(options, recovered),
  };
}

/**
 * Шаг модели. Ход, отменённый ДО старта, не поднимает ничего: ни процесса CLI, ни реле, ни
 * временной папки. Одного слушателя `abort` тут мало — на уже отменённом сигнале он не
 * срабатывает никогда, и ход оплачивал бы запрос к API, а `claude -p` висел бы до таймаута
 * тишины (QA: 8116 мс при пороге 8 с, в бою было бы 180 с).
 */
function attemptStream(
  model: string,
  options: LanguageModelV4CallOptions,
  run: ClaudeRun,
): LanguageModelV4StreamResult {
  if (options.abortSignal?.aborted === true) return abortedStream(options);
  const cancelled = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, cancelled.signal])
    : cancelled.signal;
  const session = new ClaudeSession();
  const onAbort = () => {
    session.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let completed = Promise.resolve();
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({
        type: "stream-start",
        warnings: claudeWarnings(options),
      });
      completed = runCall({
        model,
        options: { ...options, abortSignal: signal },
        session,
        controller,
        run,
      })
        .catch((error: unknown) => {
          if (!cancelled.signal.aborted) controller.error(asClaudeError(error));
        })
        .finally(() => signal.removeEventListener("abort", onAbort));
    },
    async cancel(reason) {
      // runCall owns pending acquire/adopt; its finally must close late resources too.
      cancelled.abort(reason);
      await completed;
    },
  });
  return { stream };
}

/** Отменённый до старта ход: поток кончается отказом, и ни один процесс не запускается. */
function abortedStream(
  options: LanguageModelV4CallOptions,
): LanguageModelV4StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "stream-start",
          warnings: claudeWarnings(options),
        });
        controller.error(abortReason(options.abortSignal));
      },
    }),
  };
}

/**
 * Причина отмены, а не своя выдумка на её месте: eve отменяет ход своей ошибкой и по ней же
 * узнаёт отмену (`isTurnCancellation`). Подмени её на ошибку CLI — и отменённый ход поехал
 * бы у eve как поправимый отказ модели, то есть повтором того, что владелец только что снял.
 */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new ClaudeCliError("Claude CLI step was aborted before it started");
}

/** Отменённый ход дальше не идёт: ни запроса к api.anthropic.com, ни запуска CLI. */
function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

type RunContext = {
  readonly model: string;
  readonly options: LanguageModelV4CallOptions;
  readonly session: ClaudeSession;
  readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  readonly run: ClaudeRun;
};

async function runCall(context: RunContext): Promise<void> {
  const { model, options, session, controller, run } = context;
  const step: StepStream = {
    text: new TextStream(controller),
    blocks: new BlockStream(controller, toolNames(options)),
    controller,
  };
  try {
    const prepared = prepareCall(model, options, session);
    assertLive(options.abortSignal);
    const admission = await startAdmission(
      run.upstream,
      run.silenceMs,
      prepared.frames.at(-1)?.message.content,
    );
    session.adopt(admission);
    assertLive(options.abortSignal);
    const env = claudeEnv(
      process.env,
      admission.url,
      options.maxOutputTokens ?? undefined,
    );
    assertLive(options.abortSignal);
    const child = await spawnClaude(claudeCommand(env), prepared.argv, {
      cwd: stepCwd(session, run),
      env,
      // stderr никто не читает: оставленная труба заполнилась бы и остановила CLI на записи.
      stdio: ["pipe", "pipe", "ignore"],
      // Своя группа процессов: отмена бьёт по ней целиком (см. killTree).
      detached: true,
    });
    session.attach(child);
    assertLive(options.abortSignal);
    if (child.stdout === null)
      throw new ClaudeCliError("Claude CLI started without a stdout pipe");
    const events = silentFor(jsonLines(child.stdout), run.silenceMs);
    await writeFrames(child, prepared.frames, events);
    const seen = await collect(events, step);
    const exit = await waitForExit(child);
    // Ход, снятый пока CLI отвечал, наружу не едет: eve его уже не ждёт, а убитый процесс
    // оставил бы огрызок ответа, который выглядел бы как настоящий.
    assertLive(options.abortSignal);
    const completion = complete(admission, seen, exit, toolNames(options));
    // Уборка ДО первой части ответа: ни `finish`, ни `process.exit` по нему не должны обгонять
    // удаление системного промпта хода — иначе падение или рестарт сразу после шага оставляют
    // его в /tmp (QA: четыре папки после четырёх пробников). Ответ уже собран: ни реле, ни
    // временная папка дальше не нужны.
    await session.close();
    assertLive(options.abortSignal);
    emit(completion, step, admission);
    report(model, completion, admission);
    controller.close();
  } finally {
    await session.close();
  }
}

/** Имена инструментов Ивы в наборе шага. */
function toolNames(options: LanguageModelV4CallOptions): string[] {
  return (options.tools ?? []).map((tool) => tool.name);
}

/** Кадр за кадром; на переигрывании ждём `result num_turns:0` — иначе история не принята. */
async function writeFrames(
  child: ChildProcess,
  frames: readonly ClaudeFrame[],
  events: AsyncGenerator<Record<string, unknown>>,
): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null)
    throw new ClaudeCliError("Claude CLI started without a stdin pipe");
  for (const frame of frames) {
    stdin.write(`${JSON.stringify(frame)}\n`);
    if (frame.shouldQuery === false) await awaitReplay(events);
  }
  stdin.end();
}

async function awaitReplay(
  events: AsyncGenerator<Record<string, unknown>>,
): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true)
      throw new ClaudeCliError(
        "Claude CLI exited before acknowledging the replayed history",
      );
    const event = next.value;
    if (event.type !== "result") continue;
    if (event.num_turns !== 0 || event.is_error === true)
      throw new ClaudeCliError(
        `Claude CLI did not replay the history (${String(event.subtype)} at ${String(event.num_turns)} turns)`,
      );
    return;
  }
}

type Collected = {
  readonly assistants: NativeMessage[];
  readonly results: Record<string, unknown>[];
  readonly stopped: boolean;
  readonly nativeError: string | undefined;
};

/** Куда уходят части шага: текст, блоки рассуждения и вызовов и сам поток наружу. */
type StepStream = {
  readonly text: TextStream;
  readonly blocks: BlockStream;
  readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
};

/**
 * Читает ответ CLI до конца вывода: текст, рассуждение и начала вызовов уезжают в поток сразу,
 * сообщения и итог собираются.
 */
async function collect(
  events: AsyncGenerator<Record<string, unknown>>,
  step: StepStream,
): Promise<Collected> {
  const assistants: NativeMessage[] = [];
  const results: Record<string, unknown>[] = [];
  let stopped = false;
  let nativeError: string | undefined;
  for await (const event of events) {
    if (event.type === "assistant") {
      const assistant = readAssistant(event);
      if (assistant.error !== undefined) nativeError = assistant.error;
      else if (assistant.message !== undefined)
        assistants.push(assistant.message);
    } else if (event.type === "result") results.push(event);
    else if (event.type === "stream_event") {
      stopped = applyStreamEvent(event, step) || stopped;
    }
  }
  return { assistants, results, stopped, nativeError };
}

/** Полное сообщение ассистента или ошибка провайдера, которую CLI назвал сам. */
function readAssistant(event: Record<string, unknown>): {
  message?: NativeMessage;
  error?: string;
} {
  const message = event.message as NativeMessage | undefined;
  const text = message === undefined ? "" : textOf(message);
  const named =
    event.error !== undefined ||
    message?.error !== undefined ||
    /^API Error/u.test(text);
  if (named)
    return { error: text.trim().length > 0 ? text : "Claude API error" };
  return message === undefined ? {} : { message };
}

function textOf(message: NativeMessage): string {
  return (message.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
}

/**
 * Событие частичного сообщения: текст уходит в TextStream, всё остальное — в BlockStream,
 * `message_stop` отмечает конец ответа.
 */
function applyStreamEvent(
  event: Record<string, unknown>,
  step: StepStream,
): boolean {
  const native = asRecord(event.event);
  if (native === undefined) return false;
  if (native.type === "message_stop") return true;
  const delta = asRecord(native.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string")
    step.text.push(delta.text);
  else step.blocks.apply(native);
  return false;
}

/** Приёмник частей: поток шага наружу, а в тесте — запись. */
type PartSink = { enqueue(part: LanguageModelV4StreamPart): void };

type OpenBlock = { readonly kind: "reasoning" | "tool"; readonly id: string };

type StreamedCall = { readonly id: string; readonly name: string };

/**
 * Блоки рассуждения и вызовов в момент прихода. Начало блока — `reasoning-start` или
 * `tool-input-start`, непустая дельта своего вида — `*-delta`, `content_block_stop` — `*-end`.
 * Текст ведёт TextStream, прочие блоки не идут. Индексы блоков в каждом сообщении начинаются
 * с нуля, а сообщений за запуск бывает несколько: блок, который CLI не закрыл до
 * `message_start` или до нового начала на том же индексе, закрывается тут же.
 */
export class BlockStream {
  private readonly open = new Map<number, OpenBlock>();
  private readonly started: StreamedCall[] = [];
  private readonly sink: PartSink;
  private readonly inventory: readonly string[];

  constructor(sink: PartSink, inventory: readonly string[] = []) {
    this.sink = sink;
    this.inventory = inventory;
  }

  /** Вызовы, чьё начало ушло наружу, в порядке прихода. */
  get tools(): readonly StreamedCall[] {
    return this.started;
  }

  apply(native: Record<string, unknown>): void {
    if (native.type === "message_start") this.close();
    const index = native.index;
    if (typeof index !== "number") return;
    if (native.type === "content_block_start")
      this.start(index, asRecord(native.content_block));
    else if (native.type === "content_block_delta")
      this.delta(index, asRecord(native.delta));
    else if (native.type === "content_block_stop") this.end(index);
  }

  /** Закрывает всё, что не закрыл CLI: перед вызовами шаг обязан закончить блоки. */
  close(): void {
    for (const index of this.open.keys()) this.end(index);
  }

  private start(
    index: number,
    block: Record<string, unknown> | undefined,
  ): void {
    this.end(index);
    const type = text(block?.type);
    if (type === "thinking" || type === "redacted_thinking") {
      const id = `rsn-${randomUUID()}`;
      this.sink.enqueue({ type: "reasoning-start", id });
      this.open.set(index, { kind: "reasoning", id });
    } else if (type === "tool_use") {
      const toolName = ivaToolName(text(block?.name), this.inventory);
      const id = text(block?.id);
      this.started.push({ id, name: toolName });
      this.sink.enqueue({ type: "tool-input-start", id, toolName });
      this.open.set(index, { kind: "tool", id });
    }
  }

  /** Дельта чужого вида и пустая частей не дают. */
  private delta(
    index: number,
    delta: Record<string, unknown> | undefined,
  ): void {
    const open = this.open.get(index);
    if (open === undefined || delta === undefined) return;
    const reasoning = open.kind === "reasoning";
    if (delta.type !== (reasoning ? "thinking_delta" : "input_json_delta"))
      return;
    const chunk = text(reasoning ? delta.thinking : delta.partial_json);
    if (chunk.length === 0) return;
    this.sink.enqueue({
      type: reasoning ? "reasoning-delta" : "tool-input-delta",
      id: open.id,
      delta: chunk,
    });
  }

  private end(index: number): void {
    const open = this.open.get(index);
    if (open === undefined) return;
    this.open.delete(index);
    this.sink.enqueue({
      type: open.kind === "reasoning" ? "reasoning-end" : "tool-input-end",
      id: open.id,
    });
  }
}

/** Копит текст ответа и держит один текстовый блок открытым, пока в него что-то едет. */
class TextStream {
  private id: string | undefined;
  private written = "";
  private readonly sink: PartSink;

  constructor(sink: PartSink) {
    this.sink = sink;
  }

  get emitted(): string {
    return this.written;
  }

  push(delta: string): void {
    if (delta.length === 0) return;
    this.id ??= `txt-${randomUUID()}`;
    if (this.written.length === 0)
      this.sink.enqueue({ type: "text-start", id: this.id });
    this.written += delta;
    this.sink.enqueue({ type: "text-delta", id: this.id, delta });
  }

  close(): void {
    if (this.id !== undefined)
      this.sink.enqueue({ type: "text-end", id: this.id });
  }
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ClaudeCliError(
            "Claude CLI did not exit after closing its output",
          ),
        ),
      CLAUDE_EXIT_GRACE_MS,
    );
  });
  try {
    await Promise.race([closed, expired]);
  } finally {
    // Процесс вышел — ожидание кончилось: взведённый таймер держал бы процесс Iva ещё 5 с.
    clearTimeout(timer);
  }
  return child.exitCode;
}

/**
 * Что считать ответом модели. Реле запомнило настоящий ответ целиком — он и есть правда:
 * CLI мог его обрезать, а его собственный второй поход в API отбит реле. Без запомненного
 * ответа верим CLI, но требуем целостности: один `result`, хоть одно сообщение ассистента
 * и увиденный `message_stop`. Отдельная граница — `error_max_turns` с вызовами инструментов
 * и кодом выхода 1: это штатный конец хода после tool_use, а не отказ.
 */
function complete(
  admission: Admission,
  seen: Collected,
  exit: number | null,
  inventory: readonly string[],
): ClaudeCompletion {
  const captured = capturedMessage(admission, seen);
  const assistants = captured === null ? seen.assistants : [captured];
  const expected = failureExpected(admission, captured);
  // Ошибку, которую CLI назвал сам (assistant с `error` или текстом `API Error`), не глотаем —
  // кроме той, о которой мы и просили (см. failureExpected), и кроме целого ответа, пойманного
  // реле: правда в нём, а текст «API Error» в нём — слова модели.
  if (seen.nativeError !== undefined && captured === null && !expected)
    throw new ClaudeCliError(seen.nativeError);
  const result = onlyResult(seen, assistants.length, captured !== null);
  const completion = readCompletion(
    assistants,
    captured === null ? asRecord(result?.usage) : captured.usage,
    inventory,
  );
  if (!expected && !isToolBoundary(completion, result, exit))
    assertSuite(result, exit);
  return completion;
}

/**
 * Ответ, пойманный реле. Реле пропустило запрос, а целого ответа из него не собралось (не 200,
 * обрыв SSE посреди блока) — значит, ход оборвался на настоящем запросе. Это надо назвать тем,
 * что видело реле, а не подменять тем, что CLI успел напечатать: у него в такие минуты своя
 * версия событий. Отказ реле на второй запрос CLI (ADMISSION_CONSUMED) — не причина обрыва,
 * а его следствие, и в сообщение он не идёт.
 */
function capturedMessage(
  admission: Admission,
  seen: Collected,
): NativeMessage | null {
  if (!admission.used) return null;
  const captured = admission.capture.message;
  if (
    admission.status === 200 &&
    admission.capture.complete &&
    captured !== null
  )
    return captured;
  const said = seen.nativeError;
  const detail =
    said === undefined || said.includes(ADMISSION_CONSUMED) ? "" : `: ${said}`;
  throw new ClaudeCliError(
    `api.anthropic.com did not finish the response (${relayWitness(admission)})${detail}`,
    {
      retryable: connectionBroke(admission.status),
      authRotation: admission.status === 401,
    },
  );
}

/** Что реле видело от api.anthropic.com, когда целого ответа не собралось. */
function relayWitness(admission: Admission): string {
  if (admission.status === undefined) return "no answer reached the relay";
  if (admission.status !== 200) return `HTTP ${admission.status}`;
  return "the stream broke off before message_stop";
}

/** Связь, а не отказ: ответа не было, поток оборвался или сервер сказал «позже». */
function connectionBroke(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 200 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Провал CLI, о котором Iva и просила. Отбитый второй запрос — это работа реле: ответ уже
 * получен, а ненулевой код выхода и `API Error` в выводе рассказывают о попытке CLI продолжить
 * ход за eve. Отказ модели (`refusal`) — тоже ответ, и он уезжает владельцу как есть.
 */
function failureExpected(
  admission: Admission,
  captured: NativeMessage | null,
): boolean {
  return admission.denied > 0 || captured?.stop_reason === "refusal";
}

/** Единственный `result` CLI; без него или без сообщений ассистента ответ неполный. */
function onlyResult(
  seen: Collected,
  assistants: number,
  captured: boolean,
): Record<string, unknown> | undefined {
  const result = seen.results.at(-1);
  const subtype = text(result?.subtype);
  if (
    seen.results.length !== 1 ||
    assistants === 0 ||
    !(captured || seen.stopped)
  )
    throw new ClaudeCliError(
      `Claude CLI returned an incomplete response (${subtype || "no result"})`,
    );
  return result;
}

/** Поле чужого JSON, которое обязано быть объектом: массив и null объектом не считаются. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Штатная граница хода: модель позвала инструменты, CLI упёрся в `--max-turns 1` и вышел
 * единицей. Это не отказ, а конец шага: вызовы уезжают в eve, и ход продолжает она.
 */
function isToolBoundary(
  completion: ClaudeCompletion,
  result: Record<string, unknown> | undefined,
  exit: number | null,
): boolean {
  return (
    completion.calls.length > 0 &&
    text(result?.subtype) === "error_max_turns" &&
    exit === 1
  );
}

function assertSuite(
  result: Record<string, unknown> | undefined,
  exit: number | null,
): void {
  const subtype = text(result?.subtype);
  if (exit === 0 && result?.is_error !== true && subtype === "success") return;
  const said = resultError(result);
  throw new ClaudeCliError(
    `Claude CLI failed: ${subtype || "no subtype"}${exit === 0 ? "" : ` (exit ${String(exit)})`}${said.length > 0 ? `: ${said}` : ""}`,
  );
}

/**
 * Текст ошибки, который CLI положил в `result`. У `error_*` он в `errors` (массив строк), у
 * `success` с `is_error` — в `result` (CLI 2.1.280, cli-2.1.280.strings.txt: `variant:{subtype:
 * "error_during_execution",errors:…}` и `variant:{subtype:"success",…,result:…}`).
 */
function resultError(result: Record<string, unknown> | undefined): string {
  const errors = Array.isArray(result?.errors)
    ? result.errors.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  if (errors.length > 0) return errors.join("; ");
  return result?.is_error === true ? text(result.result) : "";
}

/**
 * Отдаёт шаг наружу: хвост текста, конец открытых блоков, вызовы инструментов, расход и
 * причина остановки. Вызовы уходят только здесь, после сверки: eve начинает исполнять вызов,
 * как только его увидит. Уборка уже позади, а поток закрывает вызывающий (см. runCall).
 */
function emit(
  completion: ClaudeCompletion,
  step: StepStream,
  admission: Admission,
): void {
  const { controller } = step;
  matchStreamedCalls(step.blocks.tools, completion.calls);
  reconcile(step.text, completion.text);
  step.text.close();
  step.blocks.close();
  for (const call of completion.calls)
    controller.enqueue({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    });
  controller.enqueue({
    type: "finish",
    finishReason: finishOf(completion),
    usage: completion.usage,
    providerMetadata: {
      [CLAUDE_PROVIDER_ID]: {
        stopReason: completion.stopReason ?? null,
        cacheWriteTokens: completion.usage.inputTokens.cacheWrite ?? 0,
        upstreamRequests: admission.used ? 1 : 0,
        deniedRequests: admission.denied,
      },
    },
  });
}

/**
 * Вызовы, начатые в потоке, обязаны быть началом вызовов ответа: те же id и имена в том же
 * порядке. Хвост, который CLI не допечатал, — норма: он уходит `tool-call` без начала блока.
 */
function matchStreamedCalls(
  streamed: readonly StreamedCall[],
  calls: readonly ClaudeToolCall[],
): void {
  const matches = streamed.every(
    (call, index) =>
      call.id === calls[index]?.id && call.name === calls[index]?.name,
  );
  if (!matches)
    throw new ClaudeCliError(
      `Claude CLI streamed tool calls [${callList(streamed)}] that differ from the response it received [${callList(calls)}]`,
    );
}

function callList(
  calls: readonly { readonly id: string; readonly name: string }[],
): string {
  return calls.map((call) => `${call.name}#${call.id}`).join(", ");
}

/** Хвост ответа, не доехавший дельтами: реле могло получить больше, чем CLI успел напечатать. */
function reconcile(text: TextStream, final: string): void {
  if (final === text.emitted) return;
  if (final.startsWith(text.emitted)) {
    text.push(final.slice(text.emitted.length));
    return;
  }
  throw new ClaudeCliError(
    "Claude CLI printed text that differs from the response it received",
  );
}

function finishOf(completion: ClaudeCompletion): LanguageModelV4FinishReason {
  const raw = completion.stopReason;
  if (completion.calls.length > 0) return { unified: "tool-calls", raw };
  // Переполненное окно — та же стена, что и потолок вывода: ответ оборван не по своей воле.
  if (raw === "max_tokens" || raw === "model_context_window_exceeded")
    return { unified: "length", raw };
  return { unified: "stop", raw };
}

/** Счётчик реле в журнале: по нему видно, что шагов столько же, сколько запросов к API. */
function report(
  model: string,
  completion: ClaudeCompletion,
  admission: Admission,
): void {
  const { total, cacheRead, cacheWrite } = completion.usage.inputTokens;
  console.error(
    `[claude] ${model}: upstream=${admission.used ? 1 : 0} denied=${admission.denied} finish=${finishOf(completion).unified} tokens=${String(total ?? 0)}/${String(completion.usage.outputTokens.total ?? 0)} cache=${String(cacheRead ?? 0)}+${String(cacheWrite ?? 0)}`,
  );
  if (!completion.hasUsage)
    console.error(
      "[claude] the response carried no token usage: this step will not show up in the usage report",
    );
}

/** doGenerate — это тот же поход, только собранный в один результат: второй дороги нет. */
async function generateCall(
  options: LanguageModelV4CallOptions,
  call: (options: LanguageModelV4CallOptions) => LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  const { stream } = call(options);
  const reader = stream.getReader();
  const content: LanguageModelV4Content[] = [];
  const warnings: SharedV4Warning[] = [];
  let text = "";
  let usage = claudeUsage(undefined);
  let finishReason: LanguageModelV4FinishReason = {
    unified: "other",
    raw: undefined,
  };
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  for (;;) {
    const part = await reader.read();
    if (part.done === true) break;
    if (part.value.type === "stream-start")
      warnings.push(...part.value.warnings);
    else if (part.value.type === "text-delta") text += part.value.delta;
    else if (part.value.type === "tool-call")
      content.push({
        type: "tool-call",
        toolCallId: part.value.toolCallId,
        toolName: part.value.toolName,
        input: part.value.input,
      });
    else if (part.value.type === "finish") {
      usage = part.value.usage;
      finishReason = part.value.finishReason;
      providerMetadata = part.value.providerMetadata;
    }
  }
  if (text.length > 0) content.unshift({ type: "text", text });
  return { content, finishReason, usage, providerMetadata, warnings };
}

function asClaudeError(error: unknown): Error {
  return error instanceof Error ? error : new ClaudeCliError(String(error));
}
