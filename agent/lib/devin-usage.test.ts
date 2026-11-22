import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeDevinCliModel } from "./devin-cli.ts";

const FAKE = String.raw`
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');
let session;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(r.method==='session/new'){session=r.params;send({id:r.id,result:{sessionId:'fixture'}});}
 if(r.method==='session/prompt'){
  const scenario=JSON.parse(r.params.prompt[0].text.split('Conversation (ordered messages):\n')[1])[0].content[0].text;
  const root=path.join(process.env.XDG_DATA_HOME,'devin/cli');fs.mkdirSync(root,{recursive:true});
  const db=new DatabaseSync(path.join(root,'sessions.db'));
  db.exec('CREATE TABLE message_nodes (session_id TEXT,chat_message TEXT)');
  const add=(request_id,metrics,session_id='fixture')=>db.prepare('INSERT INTO message_nodes VALUES (?,?)').run(session_id,JSON.stringify({metadata:{request_id,metrics}}));
  const a={input_tokens:100,output_tokens:20,cache_read_tokens:40,cache_creation_tokens:10,context_input_tokens:150};
  add('other',{input_tokens:9000,output_tokens:9000},'foreign');
  if(scenario.startsWith('invalid:')){const [key,value]=JSON.parse(scenario.slice(8));a[key]=value;}
  add('a',a);add('a',a);
  if(scenario==='conflict')add('a',{...a,output_tokens:21});
  if(scenario==='tool')add('b',{input_tokens:200,output_tokens:30,cache_read_tokens:80,cache_creation_tokens:null,context_input_tokens:280});
  db.close();
  const update={sessionUpdate:'usage_update',used:99999,size:262000,_meta:{'cognition.ai/inputTokens':999,'cognition.ai/outputTokens':111}};
  send({method:'session/update',params:{sessionId:'fixture',update}});send({method:'session/update',params:{sessionId:'fixture',update}});
  if(scenario==='tool'){
   const m=session.mcpServers[0];const c=spawn(m.command,m.args,{stdio:['pipe','pipe','inherit']});
   c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'probe',arguments:{}}})+'\n');return;
  }
  send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OK'}}}});
  send({id:r.id,result:{stopReason:'end_turn'}});
 }
});
`;
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "iva-devin-usage-"));
  const file = join(dir, "agent.cjs");
  writeFileSync(file, FAKE);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return makeDevinCliModel("swe-2-high", {
    command: [process.execPath, file],
    timeoutMs: 5000,
  });
}
const prompt = (text: string) => [
  { role: "user" as const, content: [{ type: "text" as const, text }] },
];
void test("Devin text usage includes cache exactly once and excludes other sessions", async (t) => {
  const result = await fixture(t).doGenerate({ prompt: prompt("text") });
  assert.equal(result.usage.inputTokens.total, 150);
  assert.equal(result.usage.inputTokens.noCache, 100);
  assert.equal(result.usage.inputTokens.cacheRead, 40);
  assert.equal(result.usage.inputTokens.cacheWrite, 10);
  assert.equal(result.usage.outputTokens.total, 20);
});
void test("MCP interruption accounts for every internal request without duplicate snapshots", async (t) => {
  const result = await fixture(t).doGenerate({
    prompt: prompt("tool"),
    tools: [
      { type: "function", name: "probe", inputSchema: { type: "object" } },
    ],
  });
  assert.equal(result.finishReason.unified, "tool-calls");
  assert.equal(result.usage.inputTokens.total, 430);
  assert.equal(result.usage.inputTokens.noCache, 300);
  assert.equal(result.usage.inputTokens.cacheRead, 120);
  assert.equal(result.usage.inputTokens.cacheWrite, 10);
  assert.equal(result.usage.outputTokens.total, 50);
});
void test("invalid or conflicting persisted metrics leave usage unknown without losing the answer", async (t) => {
  const model = fixture(t);
  for (const [key, value] of [
    ["input_tokens", -1],
    ["output_tokens", 1.5],
    ["input_tokens", "100"],
    ["input_tokens", null],
    ["input_tokens", Number.MAX_SAFE_INTEGER],
    ["cache_read_tokens", -1],
    ["context_input_tokens", 999],
  ] as const) {
    const result = await model.doGenerate({
      prompt: prompt("invalid:" + JSON.stringify([key, value])),
    });
    assert.equal(
      result.usage.inputTokens.total,
      undefined,
      JSON.stringify([key, value]),
    );
    assert.equal(result.content[0]?.type, "text");
  }
  const result = await model.doGenerate({ prompt: prompt("conflict") });
  assert.equal(result.usage.inputTokens.total, undefined);
});
