import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "iva-night-devin-"));
const executable = join(dir, "devin");
writeFileSync(
  executable,
  `#!${process.execPath}
import readline from 'node:readline';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
  if (r.method === 'session/new') send({id:r.id,result:{sessionId:'night'}});
  if (r.method === 'session/prompt') {
    if (r.params.prompt[0].text.includes('KNOWN_USAGE')) {
      const root=join(process.env.XDG_DATA_HOME,'devin/cli');mkdirSync(root,{recursive:true});
      const db=new DatabaseSync(join(root,'sessions.db'));
      db.exec('CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT)');
      db.prepare('INSERT INTO message_nodes VALUES (?,?)').run('night',JSON.stringify({metadata:{request_id:'one',metrics:{input_tokens:100,output_tokens:20,cache_read_tokens:40,context_input_tokens:140}}}));
      db.close();
    }
    send({method:'session/update',params:{sessionId:'night',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"text":"done"}'}}}});
    send({id:r.id,result:{stopReason:'end_turn'}});
  }
});
`,
  { mode: 0o700 },
);
process.env.MODEL_PROVIDER = "devin";
process.env.DEVIN_COMMAND = executable;
process.env.ASSISTANT_DATA_DIR = dir;
const { callBySchema, ceiling, nightCeiling, NightCeilingError } =
  await import("./night-call.ts");
const { NIGHT_DEFAULTS } =
  await import("../../agent/lib/memory-night-constants.ts");
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  Object.assign(ceiling, {
    calls: 0,
    inputTokens: 0,
    unknownUsage: false,
    usageLost: "",
  });
  Object.assign(nightCeiling.limits, NIGHT_DEFAULTS, { raisesPerNight: 0 });
  nightCeiling.blocked.clear();
});
const ask = () =>
  callBySchema({
    skill: 'Return {"text":"done"}',
    input: { day: "2026-11-19" },
    schema: z.object({ text: z.string() }),
    signal: AbortSignal.timeout(5000),
  });

void test("Devin night continues across steps without inventing usage", async () => {
  assert.deepEqual(await ask(), { text: "done" });
  const firstEstimate = ceiling.inputTokens;
  assert.ok(firstEstimate > 0);
  assert.equal(ceiling.unknownUsage, true);
  assert.deepEqual(await ask(), { text: "done" });
  assert.equal(ceiling.calls, 2);
  assert.equal(ceiling.inputTokens, firstEstimate * 2);
  assert.equal(existsSync(join(dir, "usage.jsonl")), false);
});

void test("Devin night still stops at call and estimated input ceilings", async () => {
  await ask();
  nightCeiling.limits.calls = 1;
  await assert.rejects(ask(), NightCeilingError);
  assert.ok(nightCeiling.blocked.has("calls"));
  nightCeiling.limits.calls = NIGHT_DEFAULTS.calls;
  nightCeiling.limits.inputTokens = ceiling.inputTokens;
  await assert.rejects(ask(), NightCeilingError);
  assert.ok(nightCeiling.blocked.has("inputTokens"));
  assert.equal(ceiling.calls, 1);
});

void test("Devin real request metrics reach night ceilings and usage.jsonl through AI SDK", async () => {
  const answer = await callBySchema({
    skill: 'KNOWN_USAGE: Return {"text":"done"}',
    input: {},
    schema: z.object({ text: z.string() }),
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(answer, { text: "done" });
  assert.equal(ceiling.unknownUsage, false);
  assert.equal(ceiling.inputTokens, 140);
  const row = JSON.parse(
    readFileSync(join(dir, "usage.jsonl"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(row.source, "memory-night");
  assert.equal(row.provider, "devin");
  assert.equal(row.in, 140);
  assert.equal(row.out, 20);
  assert.equal(row.cacheRead, 40);
});
