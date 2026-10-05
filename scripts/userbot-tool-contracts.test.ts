// Real tools/list -> Eve schema -> AI SDK validation -> tools/call boundary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { asSchema } from "ai";
import fc from "fast-check";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  toInputSchema,
  toOutputSchema,
} from "../node_modules/eve/dist/src/tools/schema.js";

const directory = fileURLToPath(
  new URL("../services/telegram-userbot/", import.meta.url),
);
const python =
  process.env.IVA_USERBOT_TEST_PYTHON ??
  join(directory, ".venv", "bin", "python");

async function server(t: TestContext, json = false) {
  const child = spawn(
    python,
    [
      join(directory, "fixtures", "contract_server.py"),
      ...(json ? ["--json"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  child.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  t.after(() => {
    child.kill("SIGTERM");
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP fixture startup timed out: ${logs}`)),
      15_000,
    );
    const failed = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`MCP fixture exited ${String(code)}: ${logs}`));
    };
    child.once("exit", failed);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      child.off("exit", failed);
      resolve(output.trim());
    });
  });
  const client = new Client({ name: "iva-contract-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  return { client, url };
}

function value(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.ok("content" in result && Array.isArray(result.content));
  const text = result.content.find(
    (item: { type?: string }) => item.type === "text",
  ) as { text: string } | undefined;
  assert.ok(text);
  return JSON.parse(text.text) as unknown;
}

for (const json of [false, true]) {
  void test(
    `userbot optional None defaults cross Eve/AI and ${json ? "JSON" : "SSE"} MCP without type relaxation (seed 271)`,
    { skip: !existsSync(python) },
    async (t) => {
      const { client, url } = await server(t, json);
      const definitions = (await client.listTools()).tools;
      const list = definitions.find((tool) => tool.name === "list_messages");
      const probe = definitions.find((tool) => tool.name === "probe");
      assert.ok(list && probe);
      const schema = asSchema(toInputSchema(list.inputSchema));
      const probeSchema = asSchema(toInputSchema(probe.inputSchema));
      const baseline = {
        required: "yes",
        nested: { required: "yes", nullable: null },
        required_nullable: null,
      };
      for (const raw of [
        { chat_id: "@example" },
        {
          chat_id: "@example",
          account: null,
          from_date: null,
          to_date: null,
          search_query: null,
        },
      ]) {
        const validation = await schema.validate!(raw);
        assert.equal(validation.success, true);
        const response = await client.callTool({
          name: "list_messages",
          arguments: validation.value as Record<string, unknown>,
        });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        assert.deepEqual(value(response), {
          chat_id: "@example",
          limit: 20,
          search_query: null,
          from_date: null,
          to_date: null,
          account: null,
        });
      }
      await fc.assert(
        fc.asyncProperty(
          fc.option(fc.string({ maxLength: 30 }), { nil: null }),
          fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
          fc.option(fc.boolean(), { nil: null }),
          async (text, count, flag) => {
            const validation = await probeSchema.validate!({
              ...baseline,
              value: text,
              count,
              flag,
            });
            assert.equal(validation.success, true);
            const response = await client.callTool({
              name: "probe",
              arguments: validation.value as Record<string, unknown>,
            });
            assert.notEqual(response.isError, true);
            const returned = value(response) as {
              value: unknown;
              count: unknown;
              flag: unknown;
            };
            assert.deepEqual(
              [returned.value, returned.count, returned.flag],
              [text, count, flag],
            );
          },
        ),
        { seed: 271, numRuns: 30 },
      );
      const before = value(
        await client.callTool({ name: "inspect_calls", arguments: {} }),
      );
      for (const raw of [
        { ...baseline, required: null },
        { ...baseline, nested: { required: null, nullable: null } },
        { ...baseline, with_about: "false" },
        { ...baseline, with_about: null },
        { ...baseline, value: 123 },
      ]) {
        const validation = await probeSchema.validate!(raw);
        assert.equal(validation.success, false);
        // FastMCP itself may coerce the string "false"; Eve correctly refuses it
        // before HTTP. Do not confuse Python coercion with a widened Eve schema.
        if ("with_about" in raw && raw.with_about === "false") continue;
        const rejected = await client.callTool({
          name: "probe",
          arguments: raw,
        });
        assert.equal(rejected.isError, true);
      }
      assert.equal(
        value(await client.callTool({ name: "inspect_calls", arguments: {} })),
        before,
      );
      // A body that is not JSON never reaches a tool: FastMCP answers it, the server keeps serving.
      const garbage = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "not json",
      });
      assert.equal(garbage.status, 400);
      assert.match(await garbage.text(), /Parse error/u);
      assert.equal(
        value(await client.callTool({ name: "inspect_calls", arguments: {} })),
        before,
      );
      // One session (issues 248, 281): an invented account and "null" text arrive as
      // omitted, a public t.me link in chat_id as @name; other text keeps its link.
      for (const [raw, expected] of [
        [
          { chat_id: "@example", account: "main" },
          { chat_id: "@example", search_query: null, account: null },
        ],
        [
          {
            chat_id: "https://t.me/example_news/42",
            search_query: "null",
            account: '"null"',
          },
          { chat_id: "@example_news", search_query: null, account: null },
        ],
        [
          {
            chat_id: "t.me/x/123",
            search_query: "https://t.me/example_news",
          },
          {
            chat_id: "t.me/x/123",
            search_query: "https://t.me/example_news",
            account: null,
          },
        ],
      ] as const) {
        const validation = await schema.validate!(raw);
        assert.equal(validation.success, true);
        const response = await client.callTool({
          name: "list_messages",
          arguments: validation.value as Record<string, unknown>,
        });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const { chat_id, search_query, account } = value(response) as Record<
          string,
          unknown
        >;
        assert.deepEqual({ chat_id, search_query, account }, expected);
      }
      const valid = await client.callTool({
        name: "list_messages",
        arguments: { chat_id: "@example", account: "DEFAULT" },
      });
      assert.notEqual(valid.isError, true);
      assert.equal((value(valid) as { account: string }).account, "DEFAULT");
      const output = asSchema(toOutputSchema(list.outputSchema));
      assert.equal((await output.validate!({ result: null })).success, false);
    },
  );
}
