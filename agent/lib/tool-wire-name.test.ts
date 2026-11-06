/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Имя инструмента на проводе. Имена приходят от подключений и плагинов eve любой длины и
// любого алфавита, а провайдер принимает только `[A-Za-z0-9_-]` до своего предела: имя
// кодируется на входе в провайдер и раскодируется на выходе. Генератор перебирает наборы
// имён; seed печатается (IVA_WIRE_PBT_SEED, прогонов IVA_WIRE_PBT_RUNS).
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  CLAUDE_TOOL_NAME_MAX,
  CLAUDE_TOOL_PREFIX,
  claudeTools,
} from "./claude-cli.ts";
import {
  TOOL_NAME_MAX,
  toolNameWireMiddleware,
  wireToolName,
} from "./tool-wire-name.ts";

const SEED = Number(process.env.IVA_WIRE_PBT_SEED ?? 20_260_923);
const RUNS = Number(process.env.IVA_WIRE_PBT_RUNS ?? 200);
const SETTINGS = { seed: SEED, numRuns: RUNS };
const WIRE = /^[A-Za-z0-9_-]+$/u;

function tool(name: string): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description: "",
    inputSchema: { type: "object" },
  };
}

/** Модель за middleware: запоминает, что ушло на провод, и зовёт каждый инструмент. */
function wiredModel(max: number) {
  const sent: LanguageModelV4CallOptions[] = [];
  const inner = new MockLanguageModelV4({
    doStream: (options) => {
      sent.push(options);
      const parts: LanguageModelV4StreamPart[] = [];
      for (const [index, entry] of (options.tools ?? []).entries()) {
        const id = `call_${index}`;
        parts.push(
          { type: "tool-input-start", id, toolName: entry.name },
          {
            type: "tool-call",
            toolCallId: id,
            toolName: entry.name,
            input: "{}",
          },
        );
      }
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      });
    },
  });
  const model = wrapLanguageModel({
    model: inner,
    middleware: toolNameWireMiddleware(max),
  });
  return { model, sent };
}

async function streamParts(
  model: ReturnType<typeof wiredModel>["model"],
  options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4StreamPart[]> {
  const { stream } = await model.doStream(options);
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

// ─── Якоря ──────────────────────────────────────────────────────────────────────────────

// #240: имена из пакета пользователя и два края. На main каждое роняло вызов целиком.
for (const name of [
  "eva_sources_runtime__granola__query_granola_meetings",
  "eva_sources_runtime__eva-sources__api_delta_decrypt",
  "a".repeat(CLAUDE_TOOL_NAME_MAX + 1),
  "mcp-x--y__files.read",
]) {
  test(`#240: ${name} доходит до claude допустимым именем`, async () => {
    const { model, sent } = wiredModel(CLAUDE_TOOL_NAME_MAX);
    await streamParts(model, {
      prompt: [],
      tools: [tool("weather"), tool(name)],
    });
    const { body, manifest } = claudeTools(sent[0].tools);
    for (const entry of body) assert.ok(entry.name.length <= TOOL_NAME_MAX);
    assert.deepEqual(
      manifest.map((entry) => entry.name),
      body.map((entry) => entry.name.slice(CLAUDE_TOOL_PREFIX.length)),
    );
  });
}

test("имя в пределе уходит как есть, на символ длиннее получает хэш", () => {
  const fits = "a".repeat(CLAUDE_TOOL_NAME_MAX);
  const over = "a".repeat(CLAUDE_TOOL_NAME_MAX + 1);
  assert.equal(wireToolName(fits, CLAUDE_TOOL_NAME_MAX), fits);
  const wire = wireToolName(over, CLAUDE_TOOL_NAME_MAX);
  assert.equal(wire.length, CLAUDE_TOOL_NAME_MAX);
  assert.match(wire, /_[0-9a-f]{8}$/u);
});

test("files.read и files_read не склеиваются в одно имя", () => {
  assert.equal(wireToolName("files_read", TOOL_NAME_MAX), "files_read");
  assert.notEqual(wireToolName("files.read", TOOL_NAME_MAX), "files_read");
  assert.notEqual(
    wireToolName("files.read", TOOL_NAME_MAX),
    wireToolName("files:read", TOOL_NAME_MAX),
  );
});

test("имя, равное проводному имени другого, — явная ошибка с обоими именами", async () => {
  const long = "x".repeat(TOOL_NAME_MAX + 10);
  const natural = wireToolName(long, TOOL_NAME_MAX);
  const { model } = wiredModel(TOOL_NAME_MAX);
  await assert.rejects(
    streamParts(model, { prompt: [], tools: [tool(long), tool(natural)] }),
    (error: Error) =>
      error.message.includes(long) && error.message.includes(natural),
  );
});

test("инструмент провайдера не переименовывается", async () => {
  const { model, sent } = wiredModel(TOOL_NAME_MAX);
  const provider = {
    type: "provider" as const,
    id: "openai.web_search" as const,
    name: "web.search",
    args: {},
  };
  await streamParts(model, { prompt: [], tools: [provider] });
  assert.deepEqual(sent[0].tools, [provider]);
});

test("принуждение к инструменту уходит с тем же проводным именем", async () => {
  const long = "files.read_".repeat(8);
  const { model, sent } = wiredModel(TOOL_NAME_MAX);
  await streamParts(model, {
    prompt: [],
    tools: [tool(long)],
    toolChoice: { type: "tool", toolName: long },
  });
  assert.deepEqual(sent[0].toolChoice, {
    type: "tool",
    toolName: sent[0].tools![0].name,
  });
  assert.notEqual(sent[0].tools![0].name, long);
});

test("ответ без стрима раскодирует вызов так же", async () => {
  const long = "conn__".repeat(12);
  const inner = new MockLanguageModelV4({
    doGenerate: (options) =>
      Promise.resolve({
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: options.tools![0].name,
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
  });
  const model = wrapLanguageModel({
    model: inner,
    middleware: toolNameWireMiddleware(TOOL_NAME_MAX),
  });
  const result = await model.doGenerate({ prompt: [], tools: [tool(long)] });
  assert.deepEqual(
    result.content.map((part) => (part as { toolName: string }).toolName),
    [long],
  );
});

// ─── Свойства ───────────────────────────────────────────────────────────────────────────

// Длина задаётся явно: stringMatching на размере по умолчанию не доходит и до 40 символов,
// а предел — 54 и 64. Край предела (50..70) выбирается отдельно.
const WIRE_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
];
const charArbitrary = fc.oneof(
  { weight: 9, arbitrary: fc.constantFrom(...WIRE_CHARS) },
  { weight: 1, arbitrary: fc.constantFrom(".", ":", "/") },
);
function pieceArbitrary(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .integer({ min, max })
    .chain((length) =>
      fc.array(charArbitrary, { minLength: length, maxLength: length }),
    )
    .map((chars) => chars.join(""));
}
const nameArbitrary = fc.oneof(
  pieceArbitrary(1, 300),
  pieceArbitrary(50, 70),
  fc
    .tuple(pieceArbitrary(1, 64), pieceArbitrary(1, 64), pieceArbitrary(1, 64))
    .map(([ns, conn, name]) => `${ns}__${conn}__${name}`),
);
const namesArbitrary = fc.uniqueArray(nameArbitrary, {
  minLength: 1,
  maxLength: 8,
});
const maxArbitrary = fc.constantFrom(CLAUDE_TOOL_NAME_MAX, TOOL_NAME_MAX);

test("проводное имя допустимо, в пределе и не меняет алфавит MCP", () => {
  console.error(`[tool-wire-name property] seed ${SEED}, прогонов ${RUNS}`);
  fc.assert(
    fc.property(nameArbitrary, maxArbitrary, (name, max) => {
      const wire = wireToolName(name, max);
      assert.match(wire, WIRE);
      assert.ok(wire.length <= max);
      // Муляж MCP у CLI заменяет чужие символы на `_`: на проводном имени это ничего не меняет.
      assert.equal(wire.replace(/[^a-zA-Z0-9_-]/gu, "_"), wire);
      if (WIRE.test(name) && name.length <= max) assert.equal(wire, name);
    }),
    SETTINGS,
  );
});

test("набор имён проходит туда и обратно: вызовы возвращают исходные имена", async () => {
  console.error(`[tool-wire-name property] seed ${SEED}, прогонов ${RUNS}`);
  await fc.assert(
    fc.asyncProperty(namesArbitrary, maxArbitrary, async (names, max) => {
      const { model, sent } = wiredModel(max);
      let parts: LanguageModelV4StreamPart[];
      try {
        parts = await streamParts(model, {
          prompt: [],
          tools: names.map(tool),
        });
      } catch (error) {
        // Совпадение проводных имён у разных исходных — только явным отказом.
        assert.match((error as Error).message, /share the wire name/u);
        return;
      }
      const wires = (sent[0].tools ?? []).map((entry) => entry.name);
      assert.equal(
        new Set(wires).size,
        names.length,
        "проводные имена уникальны",
      );
      const called = (type: string) =>
        parts
          .filter((part) => part.type === type)
          .map((part) => (part as { toolName: string }).toolName);
      assert.deepEqual(called("tool-input-start"), names);
      assert.deepEqual(called("tool-call"), names);
    }),
    SETTINGS,
  );
});

test("имя в истории кодируется одинаково, есть инструмент в наборе или нет", async () => {
  console.error(`[tool-wire-name property] seed ${SEED}, прогонов ${RUNS}`);
  await fc.assert(
    fc.asyncProperty(
      nameArbitrary,
      namesArbitrary,
      maxArbitrary,
      async (called, others, max) => {
        const prompt: LanguageModelV4Prompt = [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c",
                toolName: called,
                input: {},
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c",
                toolName: called,
                output: { type: "text", value: "ok" },
              },
            ],
          },
        ];
        const withTool = others.includes(called) ? others : [...others, called];
        const withoutTool = others.filter((name) => name !== called);
        const encoded: string[] = [];
        for (const names of [withTool, withoutTool]) {
          const { model, sent } = wiredModel(max);
          try {
            await streamParts(model, { prompt, tools: names.map(tool) });
          } catch (error) {
            assert.match((error as Error).message, /share the wire name/u);
            continue;
          }
          for (const message of sent[0].prompt)
            if (message.role !== "system")
              for (const part of message.content)
                encoded.push((part as { toolName: string }).toolName);
        }
        for (const name of encoded)
          assert.equal(name, wireToolName(called, max));
      },
    ),
    SETTINGS,
  );
});

test("MCP schema defaults preserve constraints and leave the source unchanged (seed=20261020)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.constant({ type: "string" as const }),
      ),
      fc.boolean(),
      async (properties, present) => {
        const inputSchema = present
          ? {
              type: "object" as const,
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            }
          : {
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            };
        const before = JSON.stringify(inputSchema);
        const { model, sent } = wiredModel(TOOL_NAME_MAX);
        await streamParts(model, {
          prompt: [],
          tools: [{ ...tool("connection__search"), inputSchema }],
        });
        const sentTool = sent[0].tools?.[0];
        assert.ok(sentTool?.type === "function");
        assert.deepEqual(sentTool.inputSchema, {
          ...inputSchema,
          type: "object",
          properties,
        });
        assert.equal(JSON.stringify(inputSchema), before);
        assert.equal(inputSchema.properties, properties);
      },
    ),
    { seed: 20261020, numRuns: 100 },
  );
});
