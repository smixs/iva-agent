import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import fc from "fast-check";
import { diskTmp, smokeProperty, startTelegram, waitFor } from "./harness.ts";
import { startMockOpenAiServer } from "../lib/mock-openai-server.ts";

const execute = promisify(execFile);

void test("Bot API records arbitrary text and chat/topic on HTTP; controlled getUpdates preserves order", async (t) => {
  const root = await mkdtemp(join(diskTmp, "bot-wire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const telegram = await startTelegram(join(root, "bot.jsonl"));
  t.after(() => telegram.close());
  await smokeProperty(
    fc.asyncProperty(
      fc.string(),
      fc.integer(),
      fc.nat(),
      async (value, chat, topic) => {
        const body = { chat_id: chat, message_thread_id: topic, text: value };
        const response = await fetch(`${telegram.url}/botfake/sendMessage`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        const request = telegram.requests.at(-1)!;
        assert.equal(request.method, "sendMessage");
        assert.deepEqual(request.body, body);
        assert.equal(request.chat, chat);
        assert.equal(request.topic, topic);
        assert.equal(request.raw, JSON.stringify(body));
      },
    ),
  );
  const pending = fetch(`${telegram.url}/botfake/getUpdates`, {
    method: "POST",
    body: '{"offset":100}',
  });
  await waitFor(() => telegram.requests.at(-1)?.method === "getUpdates");
  telegram.push({ update_id: 3 }, { update_id: 2 }, { update_id: 3 });
  const batch = (await (await pending).json()) as { result: unknown[] };
  assert.deepEqual(batch.result, [
    { update_id: 3 },
    { update_id: 2 },
    { update_id: 3 },
  ]);
});

void test("programmed provider emits N overloads, tool calls, empty completion and interrupted SSE", async (t) => {
  const provider = await startMockOpenAiServer([
    { kind: "overloaded", times: 2 },
    { kind: "tool", name: "read_file", arguments: '{"path":"CORE.md"}' },
    { kind: "text", text: "after tool" },
    { kind: "empty" },
    { kind: "disconnect" },
  ]);
  t.after(() => provider.close());
  const complete = () =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      body: '{"stream":true,"messages":[]}',
    });
  assert.equal((await complete()).status, 429);
  assert.equal((await complete()).status, 429);
  const tool = await (await complete()).text();
  assert.match(tool, /"name":"read_file"/u);
  assert.match(tool, /"finish_reason":"tool_calls"/u);
  assert.match(await (await complete()).text(), /after tool/u);
  assert.match(await (await complete()).text(), /"content":""/u);
  await assert.rejects(async () => {
    await (await complete()).text();
  });
  assert.equal(provider.requests.length, 6);
  assert.equal(provider.wireRequests.length, 6);
  provider.enqueue({ kind: "tool", name: "read_file", arguments: "{}" });
  const nonstream = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    body: "{}",
  });
  const response = (await nonstream.json()) as {
    choices: { message: { tool_calls: unknown[] }; finish_reason: string }[];
  };
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls.length, 1);
});

void test("preload forwards Request bodies to Bot API and denies foreign origins and redirects", async (t) => {
  const root = await mkdtemp(join(diskTmp, "preload-wire-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const telegram = await startTelegram(join(root, "bot.jsonl"));
  t.after(() => telegram.close());
  const redirector = createServer((_req, res) => {
    res.writeHead(302, { location: "https://example.invalid/redirect-target" });
    res.end();
  });
  await new Promise<void>((resolve) =>
    redirector.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => redirector.close(() => resolve())),
  );
  const address = redirector.address();
  assert.ok(address && typeof address !== "string");
  const redirectUrl = `http://127.0.0.1:${address.port}`;
  const wire = new URL("./telegram-wire.ts", import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    const response = await fetch(new Request('https://api.telegram.org/botfake/sendMessage', {
      method: 'POST', body: JSON.stringify({chat_id: 7, message_thread_id: 8, text: 'forwarded'})
    }));
    assert.equal(response.status, 200);
    await assert.rejects(fetch('https://example.invalid/'), /Forbidden smoke network/);
    await assert.rejects(fetch('http://127.0.0.1:1/'), /Forbidden smoke network/);
    await assert.rejects(fetch(process.env.REDIRECT_URL));
    console.log('wire passed');
  `;
  const output = await execute(
    process.execPath,
    ["--import", wire, "--input-type=module", "-e", code],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        SMOKE_TELEGRAM_URL: telegram.url,
        SMOKE_ALLOWED_ORIGINS: JSON.stringify([redirectUrl]),
        REDIRECT_URL: redirectUrl,
        SMOKE_NETWORK_LOG: join(root, "denied.log"),
      },
      timeout: 5000,
    },
  );
  assert.match(output.stdout, /wire passed/u);
  assert.equal(
    telegram.requests[0].raw,
    '{"chat_id":7,"message_thread_id":8,"text":"forwarded"}',
  );
  assert.match(
    await readFile(join(root, "denied.log"), "utf8"),
    /example.invalid/u,
  );
});

void test("waitFor rejects a false condition at the deadline and propagates errors", async () => {
  await assert.rejects(
    waitFor(() => false, 20),
    /within 20ms/u,
  );
  await assert.rejects(
    waitFor(() => {
      throw new Error("condition failed");
    }),
    /condition failed/u,
  );
});

void test("fake systemctl records lifecycle operations without calling the host", async (t) => {
  const root = await mkdtemp(join(diskTmp, "units-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "units.json");
  const log = join(root, "units.jsonl");
  await writeFile(state, "{}");
  const command = new URL("./systemctl.ts", import.meta.url).pathname;
  const options = {
    env: { SMOKE_UNIT_STATE: state, SMOKE_UNIT_LOG: log },
    timeout: 5000,
  };
  await execute(
    process.execPath,
    [command, "--user", "enable", "--now", "iva.service"],
    options,
  );
  assert.match(
    (
      await execute(
        process.execPath,
        [command, "--user", "is-active", "iva.service"],
        options,
      )
    ).stdout,
    /active/u,
  );
  await execute(
    process.execPath,
    [command, "--user", "stop", "iva.service"],
    options,
  );
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    "iva.service": { active: false, enabled: true },
  });
  const before = await readFile(state, "utf8");
  await execute(
    process.execPath,
    [command, "--user", "show", "unknown.service"],
    options,
  );
  assert.equal(await readFile(state, "utf8"), before);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4);
});
