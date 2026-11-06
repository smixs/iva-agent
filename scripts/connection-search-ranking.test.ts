/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";

import {
  ContextContainer,
  contextStorage,
} from "../node_modules/eve/dist/src/context/container.js";
import { ConnectionRegistryKey } from "../node_modules/eve/dist/src/context/providers/connection-key.js";
import { resolveConnectionSearchDynamicTools } from "../node_modules/eve/dist/src/execution/tools/connection-search.js";
import type { ConnectionToolMetadata } from "../node_modules/eve/dist/src/shared/connection-types.js";
import type { ConnectionRegistry } from "../node_modules/eve/dist/src/runtime/connections/registry-types.js";
import type { DynamicToolSet } from "../node_modules/eve/dist/src/tools/dynamic.js";
import type { ToolContext } from "../node_modules/eve/dist/src/tools/definition.js";
import { readDurableDynamicToolCallbacks } from "../node_modules/eve/dist/src/tools/durable-callbacks.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../eve/packages/eve/src/execution/tools/fixtures/telegram-tools-catalog.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  provenance: { commit: string; tools: number };
  tools: { name: string; description: string }[];
};

async function search(
  tools: readonly (Pick<ConnectionToolMetadata, "name" | "description"> &
    Partial<ConnectionToolMetadata>)[],
  keywords: string,
  limit = 116,
) {
  const ctx = new ContextContainer();
  const definition = {
    connectionName: "fixture",
    description: "Fixture connection",
    logicalPath: "agent/connections/fixture.ts",
    protocol: "mcp" as const,
    sourceId: "connections/fixture",
    sourceKind: "module" as const,
    url: "https://fixture.invalid/mcp",
  };
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => ({
      close: async () => {},
      connect: async () => {},
      executeTool: async () => {},
      getToolMetadata: () =>
        Promise.resolve(
          tools.map((tool) => ({
            ...tool,
            inputSchema: tool.inputSchema ?? { type: "object" },
          })),
        ),
      getTools: () => Promise.resolve({}),
    }),
    getConnectionApproval: () => undefined,
    getConnectionNames: () => ["fixture"],
    getConnections: () => [definition],
  };
  ctx.set(ConnectionRegistryKey, registry);
  return contextStorage.run(ctx, async () => {
    const resolved =
      (await resolveConnectionSearchDynamicTools()) as DynamicToolSet;
    return (await resolved.connection_search.execute(
      { keywords, limit },
      {} as ToolContext,
    )) as { tool?: string; description: string }[];
  });
}

const catalog = fixture.tools.map(({ name, description }) => ({
  name,
  description,
  inputSchema: { type: "object" },
}));

test("pinned catalogue contains all 116 unique tool descriptions", () => {
  assert.equal(
    fixture.provenance.commit,
    "f1a2d8e00a7f127bb7702655c58fdfcee7e73a5a",
  );
  assert.equal(fixture.provenance.tools, 116);
  assert.equal(catalog.length, 116);
  assert.equal(new Set(catalog.map((t) => t.name)).size, 116);
  assert.ok(catalog.every((t) => t.description.length > 0));
});

for (const keywords of [
  "get_history read chat messages history",
  "telegram history read messages chat get_history",
]) {
  test(`get_history is first for ${keywords}`, async (t) => {
    const result = await search(catalog, keywords);
    const rank = result.findIndex((t) => t.tool === "get_history") + 1;
    assert.equal(
      rank,
      1,
      JSON.stringify({ rank, top5: result.slice(0, 5).map((t) => t.tool) }),
    );
    t.diagnostic(`get_history rank=${rank} across ${catalog.length} tools`);
  });
}

test("expanded list chats puts get_chats in the first three results", async (t) => {
  const result = await search(catalog, "list chats");
  const rank = result.findIndex((t) => t.tool === "get_chats") + 1;
  assert.ok(
    rank > 0 && rank <= 3,
    JSON.stringify({ rank, top5: result.slice(0, 5).map((t) => t.tool) }),
  );
  t.diagnostic(`get_chats rank=${rank} across ${catalog.length} tools`);
});

test("explicit telegram-userbot search keeps all 116 tools scoped away from stronger unrelated matches", async (t) => {
  const definitions = ["telegram-userbot", "unrelated"].map((name) => ({
    connectionName: name,
    description: `${name} connection`,
    logicalPath: `agent/connections/${name}.ts`,
    protocol: "mcp" as const,
    sourceId: `connections/${name}`,
    sourceKind: "module" as const,
    url: `https://${name}.invalid/mcp`,
  }));
  for (const { keywords, tool, maxRank } of [
    {
      keywords: "get_history read chat messages history",
      tool: "get_history",
      maxRank: 1,
    },
    {
      keywords: "telegram history read messages chat get_history",
      tool: "get_history",
      maxRank: 1,
    },
    { keywords: "list chats", tool: "get_chats", maxRank: 3 },
  ]) {
    const unrelatedTools = keywords.split(" ").map((name) => ({
      name,
      description: keywords,
      inputSchema: { type: "object" },
    }));
    const loaded: string[] = [];
    const registry: ConnectionRegistry = {
      dispose: async () => {},
      getClient: (name) => ({
        close: async () => {},
        connect: async () => {},
        executeTool: async () => {},
        getToolMetadata: () => {
          loaded.push(name);
          return Promise.resolve(
            name === "telegram-userbot" ? catalog : unrelatedTools,
          );
        },
        getTools: () => Promise.resolve({}),
      }),
      getConnectionApproval: () => undefined,
      getConnectionNames: () => definitions.map((d) => d.connectionName),
      getConnections: () => definitions,
    };
    const ctx = new ContextContainer();
    ctx.set(ConnectionRegistryKey, registry);
    await contextStorage.run(ctx, async () => {
      const resolved =
        (await resolveConnectionSearchDynamicTools()) as DynamicToolSet;
      const input = { connection: "telegram-userbot", keywords, limit: 5 };
      const result = (await resolved.connection_search.execute(
        input,
        {} as ToolContext,
      )) as { connection: string; tool: string }[];
      const rank = result.findIndex((item) => item.tool === tool) + 1;
      assert.deepEqual(loaded, ["telegram-userbot"]);
      assert.ok(result.every((item) => item.connection === "telegram-userbot"));
      assert.ok(
        rank > 0 && rank <= maxRank,
        JSON.stringify({ input, rank, result }),
      );
      t.diagnostic(
        `${tool} rank=${rank}; connection=${input.connection}; tools=${catalog.length}`,
      );
    });
  }
});

test("a name match outranks a description-only match", async () => {
  const result = await search(
    [
      { name: "archive", description: "records records ".repeat(40) },
      { name: "list_records", description: "Enumerate saved entries" },
    ],
    "records",
  );
  assert.equal(result[0]?.tool, "list_records");
});

test("description-only discovery, no-match summaries and limit remain available", async () => {
  const tools = [
    { name: "archive", description: "Find records" },
    { name: "library", description: "Saved records" },
  ];
  assert.deepEqual(
    (await search(tools, "records", 1)).map((t) => t.tool),
    ["archive"],
  );
  assert.deepEqual(await search(tools, "unmatched"), [
    { connection: "fixture", description: "Fixture connection" },
  ]);
});

test("repeating query tokens preserves the result order", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (repetitions) => {
      const tools = [
        { name: "alpha", description: "" },
        { name: "beta", description: "" },
      ];
      const names = async (keywords: string) =>
        (await search(tools, keywords)).map((t) => t.tool);
      assert.deepEqual(
        await names(`alpha ${"beta ".repeat(repetitions)}`),
        await names("alpha beta"),
      );
    }),
    { seed: 380, numRuns: 30 },
  );
});

test("duplicating a whole description preserves its ranking", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 30 }), async (repetitions) => {
      const tools = [
        { name: "archive", description: "records detail " },
        { name: "library", description: "records records " },
      ];
      const names = async (items: typeof tools) =>
        (await search(items, "records")).map((t) => t.tool);
      assert.deepEqual(
        await names([
          {
            ...tools[0],
            description: tools[0].description.repeat(repetitions),
          },
          tools[1],
        ]),
        await names(tools),
      );
    }),
    { seed: 380, numRuns: 30 },
  );
});

test("literal tool names stay first despite repeated competing descriptions", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 50 }), async (repetitions) => {
      const result = await search(
        [
          { name: "archive", description: "list records ".repeat(repetitions) },
          { name: "list_records", description: "Enumerate saved entries" },
        ],
        "list_records records",
      );
      assert.equal(result[0]?.tool, "list_records");
    }),
    { seed: 380, numRuns: 30 },
  );
});

test("direct name coverage outranks reverse-prefix coverage with the same description", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 100000 }), async (suffix) => {
      const stem = `record${suffix}`;
      const result = await search(
        [
          { name: `lookup_${stem}`, description: "" },
          { name: `lookup_${stem}s`, description: "" },
        ],
        `${stem}s`,
      );
      assert.equal(result[0]?.tool, `lookup_${stem}s`);
    }),
    { seed: 380, numRuns: 30 },
  );
});

test("reverse-prefix name coverage outranks a direct description-only match", async () => {
  const result = await search(
    [
      { name: "archive", description: "records" },
      { name: "get_record", description: "" },
    ],
    "records",
  );
  assert.equal(result[0]?.tool, "get_record");
});

for (const { keywords, tools, expected } of [
  {
    keywords: "GET_HISTORY records",
    tools: [
      { name: "archive", description: "get history records ".repeat(40) },
      { name: "get_history", description: "Read entries" },
    ],
    expected: ["get_history", "archive"],
  },
  {
    keywords: "x",
    tools: [{ name: "x", description: "" }],
    expected: ["x"],
  },
  {
    keywords: "_ - / .",
    tools: [{ name: "archive", description: "Saved records" }],
    expected: [undefined],
  },
  {
    keywords: "issue",
    tools: [{ name: "archive", description: "Search issues" }],
    expected: ["archive"],
  },
  {
    keywords: "records",
    tools: [{ name: "get_record", description: "Read entries" }],
    expected: ["get_record"],
  },
  {
    keywords: "records",
    tools: [
      { name: "archive", description: "record" },
      { name: "library", description: "records" },
    ],
    expected: ["library", "archive"],
  },
  {
    keywords: "issues",
    tools: [{ name: "archive", description: "Read issue" }],
    expected: ["archive"],
  },
  {
    keywords: "issu",
    tools: [{ name: "archive", description: "Read issues" }],
    expected: ["archive"],
  },
  {
    keywords: "history",
    tools: [{ name: "archive", description: "is" }],
    expected: [undefined],
  },
  {
    keywords: "history",
    tools: [{ name: "is", description: "or to id" }],
    expected: [undefined],
  },
  {
    keywords: "records",
    tools: [
      { name: "library", description: "Saved records" },
      { name: "archive", description: "Saved records" },
    ],
    expected: ["library", "archive"],
  },
  {
    keywords: "records",
    tools: [
      { name: "archive", description: "records other unrelated words" },
      { name: "library", description: "records" },
    ],
    expected: ["library", "archive"],
  },
]) {
  test(`ranking boundary: ${JSON.stringify({ keywords, expected })}`, async () => {
    assert.deepEqual(
      (await search(tools, keywords)).map((t) => t.tool),
      expected,
    );
  });
}

test("ranking preserves cross-connection order, limits, schemas and durable discovery", async () => {
  const inputSchema = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  const outputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
  };
  const shared = {
    name: "records",
    description: "Read entries",
    inputSchema,
    outputSchema,
  };
  const groups = {
    first: [
      shared,
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `archive_${i}`,
        description: "records",
        inputSchema,
      })),
    ],
    second: [shared, { ...shared, name: "other" }],
  };
  const executions: {
    connection: string;
    name: string;
    args: unknown;
    callId?: string;
  }[] = [];
  const definitions = Object.keys(groups).map((name) => ({
    connectionName: name,
    description: `${name} connection`,
    logicalPath: `agent/connections/${name}.ts`,
    protocol: "mcp" as const,
    sourceId: `connections/${name}`,
    sourceKind: "module" as const,
    url: `https://${name}.invalid/mcp`,
  }));
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: (connection) => ({
      close: async () => {},
      connect: async () => {},
      getToolMetadata: () =>
        Promise.resolve(groups[connection as keyof typeof groups]),
      getTools: () => Promise.resolve({}),
      executeTool: (name, args, options) => {
        executions.push({ connection, name, args, callId: options?.callId });
        return Promise.resolve({ ok: true });
      },
    }),
    getConnectionApproval: () => undefined,
    getConnectionNames: () => Object.keys(groups),
    getConnections: () => definitions,
  };
  const ctx = new ContextContainer();
  ctx.set(ConnectionRegistryKey, registry);
  await contextStorage.run(ctx, async () => {
    const initial =
      (await resolveConnectionSearchDynamicTools()) as DynamicToolSet;
    const execute = initial.connection_search.execute.bind(
      initial.connection_search,
    );
    const result = (await execute(
      { keywords: "records" },
      {} as ToolContext,
    )) as Record<string, unknown>[];
    assert.equal(result.length, 10);
    assert.deepEqual(
      result.slice(0, 2),
      ["first", "second"].map((connection) => ({
        connection,
        description: shared.description,
        inputSchema,
        outputSchema,
        qualifiedName: `${connection}__records`,
        tool: "records",
      })),
    );
    const limited = (await execute(
      { keywords: "records", limit: 1 },
      {} as ToolContext,
    )) as Record<string, unknown>[];
    assert.deepEqual(limited, [result[0]]);
    const durableSearch = readDurableDynamicToolCallbacks(
      initial.connection_search,
    )!.execute!;
    await durableSearch.callback(durableSearch.closure, {
      connection: "second",
      keywords: "other",
    } as never);
    const discovered =
      (await resolveConnectionSearchDynamicTools()) as DynamicToolSet;
    assert.ok(discovered.first__records);
    assert.ok(discovered.second__records);
    assert.ok(discovered.second__other);
    const durableTool = readDurableDynamicToolCallbacks(
      discovered.second__other,
    )!.execute!;
    assert.deepEqual(durableTool.closure, {
      connectionName: "second",
      toolName: "other",
    });
    const args = { id: "fixture-id" };
    assert.deepEqual(
      await discovered.first__records.execute(args, {
        callId: "call-records",
      } as ToolContext),
      { ok: true },
    );
    assert.deepEqual(
      await durableTool.callback(
        durableTool.closure,
        args as never,
        {
          callId: "call-other",
        } as never,
      ),
      { ok: true },
    );
    assert.deepEqual(executions, [
      { connection: "first", name: "records", args, callId: "call-records" },
      { connection: "second", name: "other", args, callId: "call-other" },
    ]);
  });
});
