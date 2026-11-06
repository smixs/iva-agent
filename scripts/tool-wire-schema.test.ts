/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Контракт провода: каждый наш тул уходит провайдеру схемой, которую примет любой из них.
// Схему строит тот же сериализатор eve, что и в проде. Корень - объект с properties, без
// oneOf/anyOf/allOf: Anthropic требует input_schema.type, OpenAI и Gemini не берут
// комбинаторы в корне. Одна сломанная схема роняет каждый ход дня, а не только свой тул.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMBINATORS = ["oneOf", "anyOf", "allOf", "not", "$ref"];

// Сериализатор eve не экспортирован публично; берём его из того же пакета, что и рантайм.
const eveTools = import.meta.resolve("eve/tools");
const { serializeInputSchema } = (await import(
  new URL("../../tools/schema.js", eveTools).href
)) as { serializeInputSchema: (schema: unknown) => Record<string, unknown> };

function toolFiles(): string[] {
  const dirs = [join(ROOT, "agent/tools")];
  const subagents = join(ROOT, "agent/subagents");
  for (const name of existsSync(subagents) ? readdirSync(subagents) : [])
    dirs.push(join(subagents, name, "tools"));
  return dirs.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(dir, name));
  });
}

test("каждая схема тула на проводе - плоский объект, который примет любой провайдер", async () => {
  const files = toolFiles();
  assert.ok(files.length >= 12, `найдено тулов: ${files.length}`);
  for (const file of files) {
    const name = relative(ROOT, file);
    const tool = (await import(pathToFileURL(file).href)) as {
      default: { inputSchema?: unknown };
    };
    if (tool.default.inputSchema === undefined) continue;
    const wire = serializeInputSchema(tool.default.inputSchema);
    assert.equal(wire.type, "object", `${name}: в корне нет type: "object"`);
    assert.equal(
      typeof wire.properties,
      "object",
      `${name}: в корне нет properties`,
    );
    for (const key of COMBINATORS)
      assert.ok(!(key in wire), `${name}: ${key} в корне схемы`);
  }
});

// Connection schemas reach the same provider wrapper as authored tools.
const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
const { wrapLanguageModel } = await import("ai");
const { toolNameWireMiddleware, TOOL_NAME_MAX } =
  await import("../agent/lib/tool-wire-name.ts");
for (const inputSchema of [
  {},
  {
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
]) {
  for (const mode of ["generate", "stream"] as const) {
    test(`MCP schema without type reaches the HTTP provider as an object: ${mode}, ${JSON.stringify(inputSchema)}`, async () => {
      let body: Record<string, unknown> = {};
      const api = createOpenAICompatible({
        name: "fixture",
        baseURL: "https://provider.invalid/v1",
        apiKey: "fixture",
        fetch: (_url, init) => {
          assert.ok(typeof init?.body === "string");
          body = JSON.parse(init.body) as Record<string, unknown>;
          return Promise.resolve(
            new Response(
              mode === "generate"
                ? JSON.stringify({
                    id: "response",
                    created: 0,
                    model: "fixture",
                    choices: [
                      {
                        index: 0,
                        message: { role: "assistant", content: "done" },
                        finish_reason: "stop",
                      },
                    ],
                  })
                : 'data: {"id":"response","created":0,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              {
                headers: {
                  "content-type":
                    mode === "generate"
                      ? "application/json"
                      : "text/event-stream",
                },
              },
            ),
          );
        },
      });
      const model = wrapLanguageModel({
        model: api("fixture"),
        middleware: toolNameWireMiddleware(TOOL_NAME_MAX),
      });
      const options = {
        prompt: [],
        tools: [
          {
            type: "function" as const,
            name: "connection__search",
            inputSchema: serializeInputSchema(inputSchema),
          },
        ],
      };
      if (mode === "generate")
        assert.ok((await model.doGenerate(options)).content.length > 0);
      else {
        const { stream } = await model.doStream(options);
        for await (const part of stream) assert.notEqual(part.type, "error");
      }
      const sent = body.tools as { function: { parameters: unknown } }[];
      assert.deepEqual(sent[0].function.parameters, {
        ...inputSchema,
        type: "object",
        properties: inputSchema.properties ?? {},
      });
    });
  }
}
