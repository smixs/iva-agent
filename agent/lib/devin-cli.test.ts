import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDevinCliModel } from "./devin-cli.ts";

// The slow/external boundary is the Devin executable. The adapter, ACP transport,
// MCP inventory, tool interception, abort and cleanup all run as real processes.
const FAKE = `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
let session;
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
readline.createInterface({input:process.stdin}).on('line', async line => {
 const r=JSON.parse(line);
 if(r.method==='initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(r.method==='session/new') {session=r.params;send({id:r.id,result:{sessionId:'fixture'}});}
 if(r.method==='session/prompt') {
  const text=r.params.prompt[0].text;
  if(text.includes('WAIT_FOREVER')) return;
  if(text.includes('CALL_WEATHER')) {
   const m=session.mcpServers[0];
   const c=spawn(m.command,m.args,{stdio:['pipe','pipe','inherit']});
   c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'weather',arguments:{city:'Almaty'}}})+'\\n');
   return;
  }
  if(text.includes('CRASH_NOW')) process.exit(17);
  send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'tool_call_update',content:[]}}});
  if(text.includes('REPORT_ISOLATION')) { send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({data:process.env.XDG_DATA_HOME,config:process.env.XDG_CONFIG_HOME,secret:process.env.TELEGRAM_BOT_TOKEN})}}}}); send({id:r.id,result:{stopReason:'end_turn'}});return;}
  const answer=text.includes('FORECAST_RESULT')?'It is sunny.':'Hello from Devin';
  send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}});
  send({id:r.id,result:{stopReason:'end_turn'}});
 }
});
`;

function fixture(t: { after: (fn: () => void) => void }, timeoutMs = 3000) {
  const dir = mkdtempSync(join(tmpdir(), "iva-devin-test-"));
  const script = join(dir, "agent.cjs");
  writeFileSync(script, FAKE);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return makeDevinCliModel("swe-2-high", {
    command: [process.execPath, script],
    timeoutMs,
  });
}

void test("streams ACP text as a model response", async (t) => {
  const model = fixture(t);
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  assert.deepEqual(result.content, [
    { type: "text", text: "Hello from Devin" },
  ]);
  assert.equal(result.finishReason.unified, "stop");
  assert.equal(result.usage.inputTokens.total, undefined);
});

void test("MCP call is returned to Iva with original name and arguments", async (t) => {
  const model = fixture(t);
  const result = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "CALL_WEATHER" }] },
    ],
    tools: [
      {
        type: "function",
        name: "weather",
        description: "Forecast",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  });
  assert.equal(result.finishReason.unified, "tool-calls");
  const call = result.content.find((p) => p.type === "tool-call");
  assert.ok(call?.type === "tool-call");
  assert.equal(call.toolName, "weather");
  assert.deepEqual(JSON.parse(call.input), { city: "Almaty" });
  const next = await model.doGenerate({
    prompt: [
      { role: "assistant", content: [call] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: "weather",
            output: { type: "text", value: "FORECAST_RESULT" },
          },
        ],
      },
    ],
  });
  assert.deepEqual(next.content, [{ type: "text", text: "It is sunny." }]);
});

void test("aborted and timed out requests fail instead of hanging", async (t) => {
  const model = fixture(t, 150);
  const prompt = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "WAIT_FOREVER" }],
    },
  ];
  await assert.rejects(
    async () => await model.doGenerate({ prompt }),
    /timeout/i,
  );
  await assert.rejects(
    async () =>
      await model.doGenerate({ prompt, abortSignal: AbortSignal.abort() }),
    /abort/i,
  );
});

void test("CLI exit before a response is surfaced as a failure", async (t) => {
  await assert.rejects(
    async () =>
      await fixture(t).doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "CRASH_NOW" }] },
        ],
      }),
    /17/,
  );
});

void test("unsupported media fails explicitly", async (t) => {
  await assert.rejects(
    async () =>
      await fixture(t).doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data: new Uint8Array([1]) },
              },
            ],
          },
        ],
      }),
    /text.only/i,
  );
});

void test("named required tools cannot silently return text", async (t) => {
  await assert.rejects(
    async () =>
      await fixture(t).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        toolChoice: { type: "tool", toolName: "weather" },
      }),
    /required tool/,
  );
});

void test("CLI state is temporary and bot secrets are excluded from its environment", async (t) => {
  const old = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "sentinel-must-not-reach-model-process";
  t.after(() => {
    if (old === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = old;
  });
  const result = await fixture(t).doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "REPORT_ISOLATION" }] },
    ],
  });
  const content = result.content[0];
  assert.ok(content?.type === "text");
  const observed: unknown = JSON.parse(content.text);
  assert.ok(
    observed &&
      typeof observed === "object" &&
      "data" in observed &&
      "config" in observed,
  );
  assert.equal("secret" in observed, false);
  assert.ok(
    typeof observed.data === "string" && typeof observed.config === "string",
  );

  assert.match(observed.data, /iva-devin-/);
  assert.equal(existsSync(observed.data), false);
  assert.equal(existsSync(observed.config), false);
});
