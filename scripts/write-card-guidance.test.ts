/* eslint-disable @typescript-eslint/require-await -- Model doubles implement the SDK Promise interface. */
// The live Standard Schema survives Eve compilation/hydration and reaches model history.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { asSchema } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import fc from "fast-check";
import {
  toInputSchema,
  serializeInputSchema,
} from "../node_modules/eve/dist/src/tools/schema.js";
import { resolveToolDefinition } from "../node_modules/eve/dist/src/runtime/resolve-tool.js";
import { createToolLoopHarness } from "../node_modules/eve/dist/src/harness/tool-loop.js";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../node_modules/eve/dist/src/harness/types.js";
import type { CompiledAgentManifest } from "../node_modules/eve/dist/src/compiler/manifest.js";
import type { CompiledModuleMap } from "../node_modules/eve/dist/src/compiler/module-map.js";
import "./lib/ts-esm-hooks.ts";

const writeCard = (await import("../agent/tools/write_card.ts")).default;
const compiled = fileURLToPath(
  new URL(
    "../.output/.eve/compile/compiled-agent-manifest.json",
    import.meta.url,
  ),
);
const moduleMapPath = fileURLToPath(
  new URL("../.output/.eve/compile/module-map.mjs", import.meta.url),
);

void test("write_card Standard Schema keeps wire validation/results and adds guidance once (seed 255)", async () => {
  const schema = asSchema(toInputSchema(writeCard.inputSchema));
  const wire = serializeInputSchema(writeCard.inputSchema);
  const baseline = asSchema(toInputSchema(wire));
  const scalar = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        operation: fc.constantFrom("fact", "truth", "merge", "invalid"),
        title: scalar,
        text: scalar,
        confirmed_by_owner: scalar,
        tags: fc.oneof(scalar, fc.array(scalar, { maxLength: 3 })),
      }),
      async (raw) => {
        const expected = await baseline.validate!(raw);
        const actual = await schema.validate!(raw);
        assert.equal(actual.success, expected.success);
        if (actual.success && expected.success)
          assert.deepEqual(actual.value, expected.value);
        if (!actual.success) {
          assert.match(actual.error.message, /Пример формы/u);
          assert.match(
            actual.error.message,
            /не повторяй тот же неверный вызов/u,
          );
          assert.equal(
            (actual.error.message.match(/Исправь указанное поле/gu) ?? [])
              .length,
            1,
          );
        }
      },
    ),
    { seed: 255, numRuns: 100 },
  );
  const valid = {
    operation: "fact",
    type: "note",
    title: "Example",
    text: "Fact",
    tags: ["one"],
  };
  assert.deepEqual(
    await schema.validate!(valid),
    await baseline.validate!(valid),
  );
  const rejected = await schema.validate!({ ...valid, title: null });
  assert.equal(rejected.success, false);
  const issues = rejected.error.cause as Array<{
    path: string[];
    code: string;
    message: string;
  }>;
  assert.deepEqual(issues[0].path, ["title"]);
  assert.equal(issues[0].code, "invalid_type");
  assert.match(issues[0].message, /expected string, received null/u);
  assert.match(issues[0].message, /Пример формы fact/u);
  assert.match(issues[0].message, /пример не является подтверждением/u);
  assert.equal(wire.type, "object");
  assert.equal("anyOf" in wire, false);
});

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Why `.output` cannot answer for this tree, or false when it can. The test below compares
 * the schema in the build with the schema in the source, so the build is judged by what
 * made it and when - never by that schema: a build left over from another day would
 * otherwise fail the test for a difference nobody introduced.
 */
function unusableBuild(): string | false {
  if (!existsSync(compiled) || !existsSync(moduleMapPath))
    return "no .output build - run `npm run build`";
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  const metadata = join(ROOT, ".output/.eve/compile/compile-metadata.json");
  const builtBy = existsSync(metadata)
    ? (
        read(".output/.eve/compile/compile-metadata.json") as {
          generator?: { version?: string };
        }
      ).generator?.version
    : undefined;
  const installed = (
    read("node_modules/eve/package.json") as { version: string }
  ).version;
  if (builtBy !== installed)
    return `.output was built by eve ${builtBy ?? "unknown"}, node_modules has ${installed} - run \`npm run build\``;
  const builtAt = statSync(compiled).mtimeMs;
  const agent = join(ROOT, "agent");
  for (const entry of readdirSync(agent, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || entry.name.endsWith(".test.ts")) continue;
    const file = join(entry.parentPath, entry.name);
    if (statSync(file).mtimeMs > builtAt)
      return `.output is older than ${relative(ROOT, file)} - run \`npm run build\``;
  }
  return false;
}

void test(
  "built Eve resolves write_card's live validator and gives the model a corrected shape after the first schema refusal",
  { skip: unusableBuild() },
  async (t) => {
    const manifest = JSON.parse(
      readFileSync(compiled, "utf8"),
    ) as CompiledAgentManifest;
    const metadata = manifest.tools?.find((tool) => tool.name === "write_card");
    assert.ok(metadata);
    const { moduleMap } = (await import(pathToFileURL(moduleMapPath).href)) as {
      moduleMap: CompiledModuleMap;
    };
    const loaded = await resolveToolDefinition(
      metadata,
      moduleMap,
      "__root__",
      { kind: "application" },
    );
    assert.ok(loaded.inputSchema);
    assert.equal(loaded.inputSchema["~standard"].vendor, "iva");
    assert.deepEqual(
      serializeInputSchema(loaded.inputSchema),
      metadata.inputSchema,
    );
    let executions = 0;
    const tools: HarnessToolMap = new Map([
      [
        loaded.name,
        {
          name: loaded.name,
          description: loaded.description,
          inputSchema: loaded.inputSchema,
          execute: () => {
            executions++;
            return "unexpected execution";
          },
        },
      ],
    ]);
    let calls = 0;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (++calls === 1)
          return {
            stream: convertArrayToReadableStream([
              {
                type: "tool-call",
                toolCallId: "invalid-card",
                toolName: "write_card",
                input: JSON.stringify({
                  operation: "fact",
                  type: "note",
                  title: null,
                  text: "Test fact",
                }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage,
              },
            ]),
          };
        return {
          stream: convertArrayToReadableStream([
            { type: "text-start", id: "reply" },
            {
              type: "text-delta",
              id: "reply",
              delta: "I have the corrected shape.",
            },
            { type: "text-end", id: "reply" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage,
            },
          ]),
        };
      },
    });
    t.mock.method(console, "error", () => {});
    const session: HarnessSession = {
      agent: {
        system: "Repair invalid tool arguments.",
        tools: [metadata],
        modelReference: { id: "test/model" },
      },
      compaction: { threshold: 100_000, recentWindowSize: 100 },
      continuationToken: "test",
      sessionId: "test",
      history: [],
    };
    const run = createToolLoopHarness({
      mode: "conversation",
      tools,
      resolveModel: () => Promise.resolve(model),
      handleEvent: () => Promise.resolve(),
    });
    const first = await run(session, {
      message: "Check a fact's tool shape.",
    });
    assert.equal(calls, 1);
    assert.equal(executions, 0);
    assert.equal(typeof first.next, "function");
    assert.ok(typeof first.next === "function");
    const result = await first.next(first.session);
    assert.equal(result.settledTurn?.isError, undefined);
    assert.equal(calls, 2);
    assert.equal(executions, 0);
    const retryContext = strings(model.doStreamCalls[1].prompt).join("\n");
    assert.match(retryContext, /Invalid input for tool write_card/u);
    assert.match(retryContext, /expected string, received null/u);
    assert.match(retryContext, /Пример формы fact/u);
    assert.match(retryContext, /"operation":"fact"/u);
    assert.match(retryContext, /не повторяй тот же неверный вызов/u);
    assert.match(retryContext, /пример не является подтверждением/u);
  },
);
