// Имя инструмента на проводе. Инструменты приходят от подключений и плагинов eve, а их имена
// eve собирает как `${connection}__${tool}` (и ещё `${ns}__` у плагина) без проверки длины и
// алфавита. Провайдеры принимают только `[A-Za-z0-9_-]` до 64 символов, и одно такое имя
// роняло весь вызов модели (#240). Граница с провайдером одна — makeTextModel в provider.ts,
// — поэтому имя кодируется здесь для всех вендоров сразу, а не в адаптере каждого.
import { createHash } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";

/** Предел имени инструмента на проводе у Anthropic и OpenAI. */
export const TOOL_NAME_MAX = 64;
const WIRE_NAME = /^[A-Za-z0-9_-]+$/u;
const FOREIGN_CHARACTER = /[^A-Za-z0-9_-]/gu;
const HASH_LENGTH = 8;

/**
 * Проводное имя. Допустимое имя в пределе уходит как есть: кэш промпта и прошлые истории не
 * меняются. Остальное — допустимые символы, обрезка и `_` + 8 hex от sha256 исходного имени,
 * поэтому `files.read` и `files_read` остаются разными.
 */
export function wireToolName(name: string, max: number): string {
  if (name.length <= max && WIRE_NAME.test(name)) return name;
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const head = name
    .replace(FOREIGN_CHARACTER, "_")
    .slice(0, max - HASH_LENGTH - 1);
  return `${head}_${hash}`;
}

type Named = { readonly toolName: string };

function isNamed(part: unknown): part is Named {
  return typeof (part as Partial<Named> | null)?.toolName === "string";
}

/** Проводное имя → исходное для инструментов этого запроса; совпадение двух имён — отказ. */
function encodeTools(
  tools: LanguageModelV4CallOptions["tools"],
  max: number,
): { tools: LanguageModelV4CallOptions["tools"]; table: Map<string, string> } {
  const table = new Map<string, string>();
  const encoded = tools?.map((tool) => {
    if (tool.type !== "function") return tool;
    const wire = wireToolName(tool.name, max);
    const taken = table.get(wire);
    if (taken !== undefined && taken !== tool.name)
      throw new Error(
        `tool names ${JSON.stringify(taken)} and ${JSON.stringify(tool.name)} share the wire name ${JSON.stringify(wire)}`,
      );
    table.set(wire, tool.name);
    const inputSchema =
      tool.inputSchema.type === undefined
        ? {
            ...tool.inputSchema,
            type: "object" as const,
            properties: tool.inputSchema.properties ?? {},
          }
        : tool.inputSchema;
    return { ...tool, name: wire, inputSchema };
  });
  return { tools: encoded, table };
}

/** Любая часть с `toolName`: вызов, результат, принуждение к инструменту. */
function encodePart<Part>(part: Part, max: number): Part {
  return isNamed(part)
    ? { ...part, toolName: wireToolName(part.toolName, max) }
    : part;
}

function encodePrompt(
  prompt: LanguageModelV4Prompt,
  max: number,
): LanguageModelV4Prompt {
  return prompt.map((message) =>
    message.role === "system"
      ? message
      : {
          ...message,
          content: message.content.map((part) => encodePart(part, max)),
        },
  ) as LanguageModelV4Prompt;
}

function encodeParams(
  params: LanguageModelV4CallOptions,
  max: number,
  tools: LanguageModelV4CallOptions["tools"],
): LanguageModelV4CallOptions {
  return {
    ...params,
    prompt: encodePrompt(params.prompt, max),
    tools,
    toolChoice: encodePart(params.toolChoice, max),
  };
}

/** Незнакомое имя проходит как есть: вызов вне набора разберёт eve. */
function decodePart<Part>(part: Part, table: Map<string, string>): Part {
  if (!isNamed(part)) return part;
  const name = table.get(part.toolName);
  return name === undefined ? part : { ...part, toolName: name };
}

/**
 * Кодирует имена на входе в модель и раскодирует их в ответе. Порядок middleware
 * свободен: кодирование идемпотентно, других читателей toolName в цепочке нет.
 */
export function toolNameWireMiddleware(max: number): LanguageModelMiddleware {
  return {
    async wrapStream({ model, params }) {
      const { tools, table } = encodeTools(params.tools, max);
      const result = await model.doStream(encodeParams(params, max, tools));
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              controller.enqueue(decodePart(part, table));
            },
          }),
        ),
      };
    },
    async wrapGenerate({ model, params }) {
      const { tools, table } = encodeTools(params.tools, max);
      const result = await model.doGenerate(encodeParams(params, max, tools));
      return {
        ...result,
        content: result.content.map((part) => decodePart(part, table)),
      };
    },
  };
}
