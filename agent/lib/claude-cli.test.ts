/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Модель claude проверяется на поддельном CLI: настоящий `claude` ходил бы в api.anthropic.com
// подписочным токеном владельца, а проверять надо ПЕРЕВОД, а не чужую сеть. Подделка — это
// node-скрипт, который говорит на том же stream-json: подтверждает переигрывание истории
// `result num_turns:0`, отвечает на последний кадр и умеет ломаться так, как ломается настоящий
// CLI (ошибка API в assistant, обрыв без result, тишина, свой инструмент CLI вне списка).
import "../../scripts/fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
  wrapLanguageModel,
  ToolLoopAgent,
  isStepCount,
  jsonSchema,
  simulateReadableStream,
  tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { classifyModelCallError } from "../../node_modules/eve/dist/src/harness/model-call-error.js";
import { createToolLoopHarness } from "../../node_modules/eve/dist/src/harness/tool-loop.js";

// Свой TMPDIR на файл: тест «временная папка уходит раньше» считает папки iva-claude-* в
// tmpdir(), а pre-push гоняет файлы параллельно — чужой ход с тем же префиксом в общем /tmp
// делал его красным без дефекта. os.tmpdir() читает TMPDIR на каждом вызове.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), "iva-claude-cli-test-"));
process.env.TMPDIR = PRIVATE_TMP;
process.on("exit", () => rmSync(PRIVATE_TMP, { recursive: true, force: true }));
import {
  CLAUDE_TOOL_NAME_MAX,
  CLAUDE_MESSAGE_ID_PREFIX,
  CLAUDE_SILENCE_TIMEOUT_MS,
  claudeModel,
  claudeNativeModel,
  CLAUDE_TOOL_PREFIX,
  ClaudeCliError,
  claudeCommand,
  claudeConflicts,
  claudeEffort,
  claudeEnv,
  claudeExtraBody,
  claudeHistory,
  claudeTools,
  claudeUsage,
  claudeWarnings,
  makeClaudeCliModel,
  readCompletion,
} from "./claude-cli.ts";

// ─── Поддельный CLI ─────────────────────────────────────────────────────────────────────
// Сценарий выбирается FAKE_CLAUDE_MODE, а всё, что ему дали на входе (argv, settings.json,
// system.md и полученные кадры), он кладёт в FAKE_CLAUDE_DUMP: тест проверяет не только ответ,
// но и то, что уехало в CLI.
const FAKE_CLI = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const mode = process.env.FAKE_CLAUDE_MODE ?? "text";
const dumpPath = process.env.FAKE_CLAUDE_DUMP;
const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
const frames = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const message = (content, stop, usage) => ({ role: "assistant", content, stop_reason: stop, usage });
const textBlock = (text) => ({ type: "text", text });
const usage = { input_tokens: 11, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 };

function streamText(chunks) {
  send({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
  send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: textBlock("") } });
  for (const chunk of chunks)
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } } });
  send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
}

function dump(extra) {
  if (dumpPath === undefined) return;
  writeFileSync(dumpPath, JSON.stringify({ argv, settings, system: readFileSync(arg("--system-prompt-file"), "utf8"), frames, pid: process.pid, cwd: process.cwd(), ...extra }));
}

async function scenario() {
  if (mode === "relay" || mode === "relay-mismatch" || mode === "relay-cache") {
    // Подделка ходит в реле так же, как настоящий CLI: POST на ANTHROPIC_BASE_URL с query,
    // своими заголовками (в том числе секретным) и без ожидания второго ответа.
    const relayMessages = mode === "relay-cache"
      ? [
          { role: "assistant", content: [{ type: "text", text: "stable answer" }] },
          {
            role: "user",
            content: [
              ...frames.at(-1).message.content,
              { type: "text", text: "volatile CLI tail", cache_control: { type: "ephemeral" } },
            ],
          },
        ]
      : [{ role: "user", content: "привет" }];
    const answer = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (process.env.FAKE_CLAUDE_TOKEN ?? "") },
      body: JSON.stringify({ model: arg("--model"), stream: true, messages: relayMessages }),
    });
    const body = await answer.text();
    const received = body
      .split("\\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join("");
    const printed = mode === "relay-mismatch" ? "другой ответ" : (process.env.FAKE_CLAUDE_PRINT ?? received);
    // Второй поход — то, что настоящий CLI делает сам, чтобы дописать ход за eve. Реле его
    // отбивает, CLI объявляет ошибку API и выходит единицей: ровно так ведёт себя Fable.
    let second = null;
    if (process.env.FAKE_CLAUDE_SECOND === "1") {
      const retry = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: arg("--model"), stream: true, messages: [] }),
      });
      second = { status: retry.status, body: await retry.text() };
    }
    dump({ answer: answer.status, second, received, printed, fallback: process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK });
    streamText([printed]);
    send({ type: "assistant", message: message([textBlock(printed)], "end_turn", { input_tokens: 999, output_tokens: 999 }) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    if (second !== null) {
      send({ type: "assistant", error: { type: "api_error" }, message: message([textBlock("API Error: 400 " + second.body)], "end_turn", {}) });
      send({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage: {} });
      process.exit(1);
    }
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 999, output_tokens: 999 } });
    process.exit(0);
  }
  if (mode === "script") {
    // Сценарий по шагам: событие CLI как есть или пауза. С FAKE_CLAUDE_RELAY=1 подделка сначала
    // сходит в реле, как настоящий CLI, и печатает сценарий уже после ответа API.
    if (process.env.FAKE_CLAUDE_RELAY === "1") {
      const answer = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: arg("--model"), stream: true, messages: [] }),
      });
      await answer.text();
    }
    dump({});
    for (const step of JSON.parse(process.env.FAKE_CLAUDE_SCRIPT)) {
      if (typeof step.pause === "number") await new Promise((resolve) => setTimeout(resolve, step.pause));
      else send(step);
    }
    const code = Number(process.env.FAKE_CLAUDE_EXIT ?? "0");
    const linger = process.env.FAKE_CLAUDE_LINGER_MS;
    if (linger === undefined) process.exit(code);
    // Вывод закрыт, а процесс ещё жив: так шаг ждёт выхода CLI после конца его вывода.
    process.stdout.write("", () => {
      closeSync(1);
      setTimeout(() => process.exit(code), Number(linger));
    });
    return;
  }
  if (mode === "text") {
    dump({});
    // Причина остановки и расход самого CLI задаются снаружи: без реле шаг верит его итогу,
    // и разойтись эти два числа должны именно в тесте.
    const stop = process.env.FAKE_CLAUDE_STOP ?? "end_turn";
    const own = process.env.FAKE_CLAUDE_ASSISTANT_USAGE;
    streamText(["Го", "тово"]);
    send({ type: "assistant", message: message([textBlock("Готово")], stop, own === undefined ? usage : JSON.parse(own)) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(0);
  }
  if (mode === "long") {
    dump({});
    streamText(["a".repeat(4000)]);
    const text = "a".repeat(4000);
    send({ type: "assistant", message: message([textBlock(text)], "end_turn", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(0);
  }
  if (mode === "tool") {
    dump({});
    const calls = [
      { type: "tool_use", id: "toolu_1", name: "mcp__iva__weather", input: { city: "Ташкент" } },
      { type: "tool_use", id: "toolu_2", name: "mcp__iva__remind", input: { action: "list" } },
    ];
    streamText(["Сейчас "]);
    send({ type: "assistant", message: message([textBlock("Сейчас "), ...calls], "tool_use", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, usage });
    process.exit(1);
  }
  if (mode === "foreign-tool") {
    dump({});
    send({ type: "assistant", message: message([{ type: "tool_use", id: "toolu_9", name: "Bash", input: {} }], "tool_use", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2, usage });
    process.exit(1);
  }
  if (mode === "api-error") {
    dump({});
    send({ type: "assistant", error: { type: "api_error" }, message: message([textBlock("API Error: 500 internal server error")], "end_turn", usage) });
    send({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, usage });
    process.exit(1);
  }
  if (mode === "truncated") {
    dump({});
    streamText(["Обры"]);
    send({ type: "assistant", message: message([textBlock("Обрыв")], "end_turn", usage) });
    process.exit(0);
  }
  if (mode === "exit-noise") {
    dump({});
    streamText(["Ответ"]);
    send({ type: "assistant", message: message([textBlock("Ответ")], "end_turn", usage) });
    send({ type: "stream_event", event: { type: "message_stop" } });
    send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
    process.exit(7);
  }
  if (mode === "silent") {
    dump({});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "slow") {
    dump({});
    const every = Number(process.env.FAKE_CLAUDE_INTERVAL_MS ?? "100");
    const total = Number(process.env.FAKE_CLAUDE_EVENTS ?? "4");
    let sent = 0;
    streamText([]);
    const tick = setInterval(() => {
      sent += 1;
      send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
      if (sent < total) return;
      clearInterval(tick);
      send({ type: "assistant", message: message([textBlock("x".repeat(total))], "end_turn", usage) });
      send({ type: "stream_event", event: { type: "message_stop" } });
      send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
      process.exit(0);
    }, every);
    return;
  }
  if (mode === "mcp") {
    // Муляж MCP проверяется по-настоящему: подделка CLI запускает его так, как это делает CLI.
    const config = JSON.parse(arg("--mcp-config"));
    const server = config.mcpServers.iva;
    const child = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
    const ask = (row) => { child.stdin.write(JSON.stringify(row) + "\\n"); };
    let buffer = "";
    const answers = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf("\\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        answers.push(JSON.parse(line));
        end = buffer.indexOf("\\n");
        if (answers.length === 4) finish();
      }
    });
    const finish = () => {
      child.kill("SIGKILL");
      const text = JSON.stringify(answers.map((row) => row.result));
      dump({ mcp: answers });
      streamText([text]);
      send({ type: "assistant", message: message([textBlock(text)], "end_turn", usage) });
      send({ type: "stream_event", event: { type: "message_stop" } });
      send({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage });
      process.exit(0);
    };
    ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "weather" } });
    ask({ jsonrpc: "2.0", id: 4, method: "resources/list" });
    return;
  }
  dump({});
  process.exit(3);
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const end = pending.indexOf("\\n");
    if (end < 0) return;
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (line.trim() === "") continue;
    const frame = JSON.parse(line);
    frames.push(frame);
    if (frame.shouldQuery === false) {
      send({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage: {} });
      continue;
    }
    if (frame.type === "user") void scenario();
  }
});
`;
const WEATHER: LanguageModelV4FunctionTool = {
  type: "function",
  name: "weather",
  description: "Погода в городе",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const MODEL = "claude-fable-5-1";

type Fake = {
  readonly command: string;
  readonly dump: string;
  read(): Record<string, unknown>;
};

/** Ставит подделку в PATH-независимый CLAUDE_COMMAND и убирает за собой env и файлы. */
function fakeCli(
  t: TestContext,
  mode: string,
  env: Record<string, string> = {},
): Fake {
  const dir = mkdtempSync(join(tmpdir(), "iva-fake-claude-"));
  const command = join(dir, "fake-claude.mjs");
  writeFileSync(command, FAKE_CLI);
  chmodSync(command, 0o755);
  const dump = join(dir, "dump.json");
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string): void => {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  };
  set("CLAUDE_COMMAND", command);
  set("FAKE_CLAUDE_MODE", mode);
  set("FAKE_CLAUDE_DUMP", dump);
  for (const [key, value] of Object.entries(env)) set(key, value);
  t.after(() => {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    command,
    dump,
    read: () =>
      JSON.parse(readFileSync(dump, "utf8")) as Record<string, unknown>,
  };
}

// ─── Заглушка api.anthropic.com ─────────────────────────────────────────────────────────
// Реле пересылает шаг наружу, и на верёвочке из двух подделок (CLI + API) видно то, что в бою
// не видно глазами: расход и блоки берутся из ПОЙМАННОГО ответа, а не из рассказа CLI о нём.

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Ответ Anthropic: текст двумя дельтами, вызов инструмента и расход в двух местах. */
function relayAnswer(text: string): string[] {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_relay",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 800,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(0, 11) },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: text.slice(11) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_relay",
        name: `${CLAUDE_TOOL_PREFIX}weather`,
        input: {},
      },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":"Ташкент"}' },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        output_tokens: 12,
        output_tokens_details: { thinking_tokens: 5 },
      },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** Ответ Anthropic из одних вызовов weather: по блоку tool_use на каждый id. */
function relayCalls(ids: readonly string[]): string[] {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_relay",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    }),
    ...ids.flatMap((id, index) => [
      sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id,
          name: `${CLAUDE_TOOL_PREFIX}weather`,
          input: {},
        },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: '{"city":"Ташкент"}' },
      }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ]),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** Что заглушка API увидела от реле: адрес запроса и заголовки хода. */
type SeenRequest = {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly acceptEncoding: string | undefined;
  readonly transferEncoding: string | undefined;
  readonly contentLength: string | undefined;
  /** Длина тела, которое заглушка прочитала: с ней сверяется объявленная длина. */
  readonly body: number;
  readonly payload: unknown;
};

/** Поднимает заглушку API: адрес получает реле как upstream, запросы — тест. */
async function stubApi(
  t: TestContext,
  // Ответ на каждый запрос один и тот же или свой по номеру запроса (с нуля).
  events: readonly string[] | ((request: number) => readonly string[]),
  status = 200,
): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        acceptEncoding: request.headers["accept-encoding"],
        transferEncoding: request.headers["transfer-encoding"],
        contentLength: request.headers["content-length"],
        body: body.length,
        payload: JSON.parse(body.toString("utf8")) as unknown,
      });
      const answer =
        typeof events === "function" ? events(seen.length - 1) : events;
      response.writeHead(status, { "content-type": "text/event-stream" });
      for (const event of answer) response.write(event);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

/** Временные папки хода: по ним видно, поднимались ли процесс и реле. */
function tempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("iva-claude-"))
    .sort();
}

/** Так ход снимает eve: `TurnCancelledError` в причине сигнала (harness/turn-cancellation). */
function cancellation(): Error {
  const error = new Error("The turn was cancelled.");
  error.name = "TurnCancelledError";
  return error;
}

function userPrompt(text = "привет"): LanguageModelV4Prompt {
  return [
    { role: "system", content: "Ты Ива." },
    { role: "user", content: [{ type: "text", text }] },
  ];
}

function replayPrompt(): LanguageModelV4Prompt {
  return [
    { role: "system", content: "Ты Ива." },
    { role: "user", content: [{ type: "text", text: "меня зовут Шима" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "думаю" },
        { type: "text", text: "Приятно познакомиться." },
        {
          type: "tool-call",
          toolCallId: "toolu_old",
          toolName: "weather",
          input: '{"city":"Ташкент"}',
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_old",
          toolName: "weather",
          output: { type: "text", value: "+30" },
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "а завтра?" }] },
  ];
}

async function drain(
  result: LanguageModelV4StreamResult,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = result.stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done === true) return parts;
    parts.push(next.value);
  }
}

function partsOfType<T extends LanguageModelV4StreamPart["type"]>(
  parts: readonly LanguageModelV4StreamPart[],
  type: T,
): Extract<LanguageModelV4StreamPart, { type: T }>[] {
  return parts.filter(
    (part): part is Extract<LanguageModelV4StreamPart, { type: T }> =>
      part.type === type,
  );
}

function textOf(parts: readonly LanguageModelV4StreamPart[]): string {
  return partsOfType(parts, "text-delta")
    .map((part) => part.delta)
    .join("");
}

function finishOf(parts: readonly LanguageModelV4StreamPart[]) {
  const finishes = partsOfType(parts, "finish");
  assert.equal(finishes.length, 1, "ровно одна причина остановки на шаг");
  return finishes[0];
}

async function failureOf(
  run: () => Promise<unknown>,
): Promise<Error & { name: string }> {
  let caught: unknown;
  await assert.rejects(run, (error: unknown) => {
    caught = error;
    return error instanceof Error;
  });
  assert.ok(caught instanceof Error);
  return caught;
}

// ─── Сценарий CLI по шагам ──────────────────────────────────────────────────────────────
// Режим script печатает события, которые дал тест, с паузами между ними: так видно, КОГДА
// часть шага уходит наружу, а не только какой она была.

type ScriptStep = Record<string, unknown>;

/** Пауза внутри сценария: сторож первой части считает время, и тест меряет его же. */
const PAUSE_MS = 1_000;
const STEP_USAGE = { input_tokens: 11, output_tokens: 4 };
const MESSAGE_START = streamEvent({
  type: "message_start",
  message: { id: "msg_1" },
});
const MESSAGE_STOP = streamEvent({ type: "message_stop" });
const MAX_TURNS: ScriptStep = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 2,
  usage: STEP_USAGE,
};

function streamEvent(event: Record<string, unknown>): ScriptStep {
  return { type: "stream_event", event };
}

function blockStart(index: number, block: Record<string, unknown>): ScriptStep {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function blockDelta(index: number, delta: Record<string, unknown>): ScriptStep {
  return streamEvent({ type: "content_block_delta", index, delta });
}

function blockStop(index: number): ScriptStep {
  return streamEvent({ type: "content_block_stop", index });
}

function toolUse(
  id: string,
  wireName: string,
  input: unknown = { city: "Ташкент" },
): Record<string, unknown> {
  return { type: "tool_use", id, name: wireName, input };
}

function assistantSays(
  content: Record<string, unknown>[],
  stop = "tool_use",
): ScriptStep {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
      stop_reason: stop,
      usage: STEP_USAGE,
    },
  };
}

function scriptCli(
  t: TestContext,
  steps: readonly ScriptStep[],
  env: Record<string, string> = {},
): Fake {
  return fakeCli(t, "script", {
    FAKE_CLAUDE_SCRIPT: JSON.stringify(steps),
    ...env,
  });
}

type Timed = { readonly part: LanguageModelV4StreamPart; readonly at: number };

/** Части шага с моментом прихода; ошибка, которой кончился поток, возвращается рядом. */
async function timed(
  result: LanguageModelV4StreamResult,
): Promise<{ parts: Timed[]; error: unknown }> {
  const parts: Timed[] = [];
  const reader = result.stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) return { parts, error: undefined };
      parts.push({ part: next.value, at: performance.now() });
    }
  } catch (error) {
    return { parts, error };
  }
}

function momentOf(parts: readonly Timed[], type: string): number {
  const found = parts.find((entry) => entry.part.type === type);
  assert.ok(found !== undefined, `в потоке есть ${type}`);
  return found.at;
}

function untimed(parts: readonly Timed[]): LanguageModelV4StreamPart[] {
  return parts.map((entry) => entry.part);
}

// ─── Нормальный ход ─────────────────────────────────────────────────────────────────────

test("текст, расход и причина остановки доезжают из ответа CLI", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(await model.doStream({ prompt: userPrompt() }));

  assert.equal(textOf(parts), "Готово");
  assert.deepEqual(
    parts.map((part) => part.type),
    [
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ],
  );
  const finish = finishOf(parts);
  assert.deepEqual(finish.finishReason, { unified: "stop", raw: "end_turn" });
  // Расход — из настоящего ответа: total включает кэш, cache-read и cache-write отдельными полями.
  assert.deepEqual(finish.usage.inputTokens, {
    total: 16,
    noCache: 11,
    cacheRead: 3,
    cacheWrite: 2,
  });
  assert.equal(finish.usage.outputTokens.total, 4);
  // Счётчик реле: запроса к api.anthropic.com не было — подделка в сеть не ходит.
  assert.equal(
    (finish.providerMetadata?.["iva-claude"] as { upstreamRequests?: number })
      ?.upstreamRequests,
    0,
  );

  const dump = fake.read();
  assert.equal(dump.system, "Ты Ива.");
  const settings = dump.settings as {
    env: { CLAUDE_CODE_EXTRA_BODY: string };
  };
  assert.deepEqual(JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY), {
    tools: [],
    thinking: { type: "adaptive" },
  });
});

test("инструменты уезжают в тело запроса с префиксом муляжа MCP", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  await drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }));
  const settings = fake.read().settings as {
    env: { CLAUDE_CODE_EXTRA_BODY: string };
  };
  const body = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY) as {
    tools: unknown;
  };
  assert.deepEqual(body.tools, [
    {
      name: `${CLAUDE_TOOL_PREFIX}weather`,
      description: "Погода в городе",
      input_schema: WEATHER.inputSchema,
    },
  ]);
  const argv = fake.read().argv as string[];
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "1");
  assert.equal(
    argv[argv.indexOf("--model") + 1],
    "claude-fable-5-1[1m]",
    "CLI принимает своё имя модели, а не route-ид",
  );
  const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
    mcpServers: { iva: { command: string; args: string[] } };
  };
  assert.equal(mcp.mcpServers.iva.command, process.execPath);
  assert.equal(mcp.mcpServers.iva.args[0], "-e");
});

test("история уезжает кадрами: переигрывание помечено, рассуждение не переигрывается", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  await drain(
    await model.doStream({ prompt: replayPrompt(), tools: [WEATHER] }),
  );
  const frames = fake.read().frames as {
    type: string;
    shouldQuery?: boolean;
    message: { role: string; content: { type: string; name?: string }[] };
  }[];
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.shouldQuery]),
    [
      ["user", false],
      ["assistant", undefined],
      ["user", undefined],
    ],
    "все кадры истории, кроме последнего запроса, помечены shouldQuery:false",
  );
  const assistant = frames[1];
  assert.deepEqual(
    assistant.message.content.map((block) => block.type),
    ["text", "tool_use"],
    "рассуждение в историю не возвращается",
  );
  const result = frames[2].message.content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(
    frames[2].message.content.length,
    2,
    "результат инструмента и следующий вопрос склеены в один user-кадр",
  );
});

// #236: без message.id CLI склеивает соседние кадры ассистента, и префикс запроса между
// шагами расходится — кэш промпта не читает историю.
test("каждый вызов — свой кадр ассистента со своим номером", () => {
  const call = (id: string): LanguageModelV4Prompt[number] => ({
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: "weather", input: "{}" },
    ],
  });
  const result = (id: string): LanguageModelV4Prompt[number] => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "weather",
        output: { type: "text", value: "+30" },
      },
    ],
  });
  const { frames } = claudeHistory([
    { role: "user", content: [{ type: "text", text: "погода?" }] },
    call("toolu_a"),
    result("toolu_a"),
    call("toolu_b"),
    result("toolu_b"),
  ]);
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.message.id]),
    [
      ["user", undefined],
      ["assistant", `${CLAUDE_MESSAGE_ID_PREFIX}0`],
      ["user", undefined],
      ["assistant", `${CLAUDE_MESSAGE_ID_PREFIX}1`],
      ["user", undefined],
    ],
  );
});

test("муляж MCP отдаёт список инструментов и отказывается их исполнять", async (t) => {
  fakeCli(t, "mcp");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  const [initialized, listed, called, unknown] = JSON.parse(textOf(parts)) as {
    tools?: { name: string }[];
    isError?: boolean;
    content?: { text: string }[];
  }[];
  assert.equal(initialized?.tools, undefined, "initialize без инструментов");
  assert.deepEqual(listed?.tools, [
    {
      name: "weather",
      description: "Погода в городе",
      inputSchema: WEATHER.inputSchema,
    },
  ]);
  assert.equal(called?.isError, true);
  assert.match(String(called?.content?.[0]?.text), /Denied/u);
  // Отказ — только на исполнение. Незнакомый метод (CLI спрашивает и про ресурсы, и про
  // промпты) получает пустой ответ: объявлять ошибкой то, чего у нас просто нет, незачем.
  assert.deepEqual(unknown, {});
});

// ─── Инструменты и границы хода ─────────────────────────────────────────────────────────

test("tool_use и error_max_turns с кодом 1 — штатный конец хода", async (t) => {
  fakeCli(t, "tool");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(
    await model.doStream({
      prompt: userPrompt(),
      tools: [
        WEATHER,
        { ...WEATHER, name: "remind", description: "Напоминания" },
      ],
    }),
  );
  assert.deepEqual(
    partsOfType(parts, "tool-call").map((part) => [
      part.toolName,
      part.toolCallId,
      part.input,
    ]),
    [
      ["weather", "toolu_1", '{"city":"Ташкент"}'],
      ["remind", "toolu_2", '{"action":"list"}'],
    ],
    "имя приходит без префикса, аргументы — JSON-строкой",
  );
  assert.deepEqual(finishOf(parts).finishReason, {
    unified: "tool-calls",
    raw: "tool_use",
  });
  assert.equal(textOf(parts), "Сейчас ");
});

// Свой инструмент CLI Iva не исполняет, но и шаг им не роняет: вызов уходит в eve как есть, и
// eve отвечает модели tool-error со списком доступных, как на любое незнакомое имя.
test("инструмент вне списка уходит в eve как есть, а не роняет шаг", async (t) => {
  fakeCli(t, "foreign-tool");
  const model = makeClaudeCliModel(MODEL);
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  assert.deepEqual(
    partsOfType(parts, "tool-call").map((part) => [part.toolName, part.input]),
    [["Bash", "{}"]],
  );
});

// Сторож первой части (provider.ts) снимается только содержательной частью. Модель, которая
// думает и зовёт инструмент без текста, обязана подать её на старте блока: иначе на большом
// контексте шаг умирает на 90 с, пока CLI ещё отвечает (#239).
test("думающая модель подаёт голос на старте блока, а не после выхода CLI", async (t) => {
  const weather = `${CLAUDE_TOOL_PREFIX}weather`;
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "thinking", thinking: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "" }),
      blockDelta(0, { type: "signature_delta", signature: "sig" }),
      { pause: PAUSE_MS },
      blockStart(1, toolUse("toolu_1", weather, {})),
      blockDelta(1, {
        type: "input_json_delta",
        partial_json: '{"city":"Ташкент"}',
      }),
      blockStop(1),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_1", weather)]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.equal(error, undefined);
  assert.equal(
    parts[1]?.part.type,
    "reasoning-start",
    "первая часть после stream-start — начало рассуждения",
  );
  assert.ok(
    momentOf(parts, "tool-call") - momentOf(parts, "reasoning-start") >=
      0.8 * PAUSE_MS,
    "начало рассуждения ушло до паузы, а не вместе с вызовом",
  );
  const [start] = partsOfType(untimed(parts), "tool-input-start");
  const [call] = partsOfType(untimed(parts), "tool-call");
  assert.equal(start?.id, call?.toolCallId);
  assert.equal(start?.toolName, "weather");
});

test("вызов инструмента объявляется на старте блока, до его аргументов", async (t) => {
  const weather = `${CLAUDE_TOOL_PREFIX}weather`;
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_1", weather, {})),
      { pause: PAUSE_MS },
      blockDelta(0, {
        type: "input_json_delta",
        partial_json: '{"city":"Ташкент"}',
      }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_1", weather)]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.equal(error, undefined);
  assert.ok(
    momentOf(parts, "tool-call") - momentOf(parts, "tool-input-start") >=
      0.8 * PAUSE_MS,
    "начало вызова ушло до паузы в его аргументах",
  );
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-input-delta").map((part) => part.delta),
    ['{"city":"Ташкент"}'],
  );
});

// 0.4.9 на поле: Opus на первом шаге новой сессии назвал `memory_search` без префикса, и
// весь ход упал. Имя инструмента Ивы из набора шага — тот же вызов, чужое — отказ, как раньше.
function bareMemorySearch(t: TestContext): void {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_m", "memory_search", { query: "кофе" })),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_m", "memory_search", { query: "кофе" })]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
}

test("имя инструмента Ивы без префикса из набора шага — тот же вызов", async (t) => {
  bareMemorySearch(t);
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER, { ...WEATHER, name: "memory_search" }],
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-call").map((part) => [
      part.toolName,
      part.toolCallId,
      part.input,
    ]),
    [["memory_search", "toolu_m", '{"query":"кофе"}']],
  );
});

test("имя без префикса, которого нет в наборе шага, уходит в eve как есть", async (t) => {
  bareMemorySearch(t);
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-call").map((part) => part.toolName),
    ["memory_search"],
  );
});

// Угадывания нет: другое написание уходит в eve как есть и получает там tool-error, иначе
// `Bash` от Claude стал бы `bash` Ивы и исполнился.
test("имя в другом написании уходит в eve как есть, и на старте блока, и в вызове", async (t) => {
  const wire = "mcp__claude_ai_iva__Memory-Search";
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_m", wire, {})),
      blockDelta(0, { type: "input_json_delta", partial_json: "{}" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_m", wire, {})]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER, { ...WEATHER, name: "memory_search" }],
    }),
  );
  assert.equal(error, undefined);
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-input-start").map(
      (part) => part.toolName,
    ),
    [wire],
  );
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-call").map((part) => part.toolName),
    [wire],
  );
});

test("свой инструмент CLI объявляется на старте блока как есть и не роняет шаг", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_9", "Bash", {})),
      { pause: PAUSE_MS },
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_9", "Bash", {})]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.equal(error, undefined);
  assert.ok(
    momentOf(parts, "tool-call") - momentOf(parts, "tool-input-start") >=
      0.8 * PAUSE_MS,
    "начало вызова ушло до паузы",
  );
  assert.deepEqual(
    partsOfType(untimed(parts), "tool-input-start").map(
      (part) => part.toolName,
    ),
    ["Bash"],
  );
});

// Сквозной путь: шаг claude отдаёт неузнанное имя, цикл инструментов AI SDK (на нём eve строит
// шаг, harness/tool-loop.js) не бросает, а кладёт в историю tool-error со списком доступных, и
// следующий шаг модели идёт дальше. Второй шаг — муляж: его дело только показать, что он был
// и что увидел.
test("неузнанное имя доходит до модели tool-error со списком доступных, ход идёт дальше", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_9", "Bash", { command: "ls" })),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_9", "Bash", { command: "ls" })]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const claude = makeClaudeCliModel(MODEL);
  const prompts: LanguageModelV4Prompt[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      if (prompts.length === 1) return claude.doStream(options);
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Готово" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
  let executed = 0;
  const agent = new ToolLoopAgent({
    model,
    stopWhen: isStepCount(3),
    tools: {
      weather: tool({
        description: "Погода в городе",
        inputSchema: jsonSchema<{ city: string }>(
          WEATHER.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: () => {
          executed += 1;
          return "+30";
        },
      }),
    },
  });
  const result = await agent.stream({ prompt: "привет" });
  assert.equal(await result.text, "Готово");
  assert.equal(prompts.length, 2, "после неузнанного вызова был второй шаг");
  assert.equal(executed, 0);
  const results = prompts[1]
    ?.filter((message) => message.role === "tool")
    .flatMap((message) => message.content);
  assert.equal(results?.length, 1);
  const [answer] = results ?? [];
  assert.ok(answer?.type === "tool-result");
  assert.equal(answer.toolCallId, "toolu_9");
  assert.equal(answer.output.type, "error-text");
  assert.match(
    answer.output.type === "error-text" ? answer.output.value : "",
    /unavailable tool 'Bash'\. Available tools: weather\./u,
  );
});
// Имя с префиксом Iva, которого нет в наборе шага, — ошибка модели, а не поломка шага: eve
// отвечает на неё модели tool-error, как у любого другого вендора.
test("незнакомый инструмент Iva уходит в eve, а не роняет шаг", async (t) => {
  const unknown = `${CLAUDE_TOOL_PREFIX}not_offered`;
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_1", unknown, {})),
      blockDelta(0, { type: "input_json_delta", partial_json: "{}" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_1", unknown, {})]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.deepEqual(
    partsOfType(parts, "tool-input-start").map((part) => part.toolName),
    ["not_offered"],
  );
  assert.deepEqual(
    partsOfType(parts, "tool-call").map((part) => [part.toolName, part.input]),
    [["not_offered", "{}"]],
  );
});

test("вызов в потоке, не совпавший с пойманным ответом, валит шаг без подмены", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  const weather = `${CLAUDE_TOOL_PREFIX}weather`;
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(1, toolUse("toolu_other", weather, {})),
      blockStop(1),
      MESSAGE_STOP,
      assistantSays([toolUse("toolu_other", weather)]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_RELAY: "1", FAKE_CLAUDE_EXIT: "1" },
  );
  const { parts, error } = await timed(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 10_000,
      upstream: upstream.url,
    }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  assert.ok(error instanceof ClaudeCliError);
  assert.match(error.message, /toolu_other/u);
  assert.equal(partsOfType(untimed(parts), "tool-call").length, 0);
});

// Реле поймало weather#toolu_1; поток, разошедшийся с ним по id или по имени, шаг не проходит.
for (const [what, id, name] of [
  ["id", "toolu_other", "weather"],
  ["имени", "toolu_1", "other"],
] as const)
  test(`вызов в потоке, разошедшийся с пойманным ответом по ${what}, валит шаг`, async (t) => {
    const upstream = await stubApi(t, relayCalls(["toolu_1"]));
    const wire = CLAUDE_TOOL_PREFIX + name;
    scriptCli(
      t,
      [
        MESSAGE_START,
        blockStart(0, toolUse(id, wire, {})),
        blockStop(0),
        MESSAGE_STOP,
        assistantSays([toolUse(id, wire)]),
        MAX_TURNS,
      ],
      { FAKE_CLAUDE_RELAY: "1", FAKE_CLAUDE_EXIT: "1" },
    );
    const { parts, error } = await timed(
      await makeClaudeCliModel(MODEL, {
        silenceTimeoutMs: 10_000,
        upstream: upstream.url,
      }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
    );
    assert.ok(error instanceof ClaudeCliError);
    assert.equal(
      error.message,
      `Claude CLI streamed tool calls [${name}#${id}] that differ from the response it received [weather#toolu_1]`,
    );
    assert.equal(partsOfType(untimed(parts), "tool-call").length, 0);
  });

// CLI оборвал вывод, а реле поймало ответ целиком: недоехавший вызов уходит без начала блока.
test("вызов, не доехавший до потока, уходит из пойманного ответа", async (t) => {
  const upstream = await stubApi(t, relayCalls(["toolu_a", "toolu_b"]));
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, toolUse("toolu_a", `${CLAUDE_TOOL_PREFIX}weather`, {})),
      blockDelta(0, {
        type: "input_json_delta",
        partial_json: '{"city":"Ташкент"}',
      }),
      blockStop(0),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_RELAY: "1", FAKE_CLAUDE_EXIT: "1" },
  );
  const parts = await drain(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 10_000,
      upstream: upstream.url,
    }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  assert.deepEqual(
    partsOfType(parts, "tool-input-start").map((part) => part.id),
    ["toolu_a"],
  );
  assert.deepEqual(
    partsOfType(parts, "tool-call").map((part) => part.toolCallId),
    ["toolu_a", "toolu_b"],
  );
});

// eve на tool-input-start выгружает накопленный текст отдельным сообщением, поэтому хвост
// текста, дописанный сверкой, уезжает после начала вызова. Порядок закреплён здесь.
test("хвост текста, дописанный сверкой, идёт после начала вызова и до самого вызова", async (t) => {
  const weather = `${CLAUDE_TOOL_PREFIX}weather`;
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Сейчас " }),
      blockStart(1, toolUse("toolu_1", weather, {})),
      blockDelta(1, {
        type: "input_json_delta",
        partial_json: '{"city":"Ташкент"}',
      }),
      blockStop(1),
      MESSAGE_STOP,
      assistantSays([
        { type: "text", text: "Сейчас посмотрю" },
        toolUse("toolu_1", weather),
      ]),
      MAX_TURNS,
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({
      prompt: userPrompt(),
      tools: [WEATHER],
    }),
  );
  assert.deepEqual(
    parts.map((part) =>
      part.type === "text-delta" ? `${part.type}:${part.delta}` : part.type,
    ),
    [
      "stream-start",
      "text-start",
      "text-delta:Сейчас ",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "text-delta:посмотрю",
      "text-end",
      "tool-call",
      "finish",
    ],
  );
});

test("ошибка API в assistant доезжает текстом и остаётся поправимой", async (t) => {
  fakeCli(t, "api-error");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /API Error: 500 internal server error/u);
  assert.equal(
    classifyModelCallError(error),
    "recoverable",
    "ход чинится повтором, а не отравлением сессии",
  );
});

test("обрыв потока без result — незавершённый ответ, а не половина хода", async (t) => {
  fakeCli(t, "truncated");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /incomplete response/u);
  assert.equal(classifyModelCallError(error), "recoverable");
});

test("нулевой код выхода с непустым result не выдаётся за успех", async (t) => {
  fakeCli(t, "exit-noise");
  const model = makeClaudeCliModel(MODEL);
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /exit 7/u);
});

// ─── Тишина, отмена, отсутствие бинаря ──────────────────────────────────────────────────

test("тишина дольше порога валит ход, а событие порог сбрасывает", async (t) => {
  const silent = fakeCli(t, "silent");
  void silent;
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 300 });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.match(error.message, /produced nothing for 0\.3s/u);
  assert.equal(classifyModelCallError(error), "recoverable");

  // Порог 2500 мс, событие каждые 400 мс: без сброса таймера ход умер бы на 2500 мс, а с ним
  // живёт до конца (событий всего на 3200 мс). Запас в шесть раз больше промежутка: тесты идут
  // параллельно, и под нагрузкой подделка может опоздать — но не на секунды.
  fakeCli(t, "slow", {
    FAKE_CLAUDE_INTERVAL_MS: "400",
    FAKE_CLAUDE_EVENTS: "8",
  });
  const slow = await drain(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 2_500,
    }).doStream({ prompt: userPrompt() }),
  );
  assert.equal(textOf(slow), "x".repeat(8));
  assert.equal(finishOf(slow).finishReason.unified, "stop");
});

test("порог тишины в бою — три минуты", () => {
  assert.equal(CLAUDE_SILENCE_TIMEOUT_MS, 180_000);
});

test("AbortSignal убивает claude и всех его детей", async (t) => {
  const fake = fakeCli(t, "silent");
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 30_000 });
  const controller = new AbortController();
  const parts = drain(
    await model.doStream({
      prompt: userPrompt(),
      abortSignal: controller.signal,
    }),
  );
  // Даём подделке завестись и записать свой pid, затем отменяем ход.
  const pid = await waitForPid(fake);
  controller.abort(cancellation());
  const error = await failureOf(() => parts);
  // Наружу едет причина отмены, а не своя ошибка на её месте: по ней eve и узнаёт, что ход
  // сняли, — иначе снятый ход поехал бы у неё как поправимый отказ модели, то есть повтором.
  assert.equal(error.name, "TurnCancelledError");
  assert.equal(classifyModelCallError(error), "terminal");
  await waitForExit(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH|EPERM/u);
});

test("отменённый до старта ход не поднимает ни CLI, ни реле, ни временной папки", async (t) => {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL, { silenceTimeoutMs: 8_000 });
  const controller = new AbortController();
  controller.abort();
  const before = tempDirs();
  const started = Date.now();
  const error = await failureOf(async () =>
    drain(
      await model.doStream({
        prompt: userPrompt(),
        abortSignal: controller.signal,
      }),
    ),
  );
  assert.equal(error.name, "AbortError");
  assert.ok(
    Date.now() - started < 1_000,
    "отказ мгновенный, а не по таймауту тишины",
  );
  assert.equal(existsSync(fake.dump), false, "процесс CLI не поднимался");
  assert.deepEqual(tempDirs(), before, "временной папки не появилось");
});

test("временная папка уходит раньше, чем ход отдаёт ответ", async (t) => {
  fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const before = tempDirs();
  const reader = (
    await model.doStream({ prompt: userPrompt() })
  ).stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done === true) break;
    if (next.value.type === "finish")
      assert.deepEqual(
        tempDirs(),
        before,
        "системный промпт хода уже убран с диска",
      );
  }
  assert.deepEqual(tempDirs(), before);
});

// ─── Рабочая папка CLI ──────────────────────────────────────────────────────────────────
// Путь рабочей папки CLI печатает в блок «# Environment» каждого запроса, а запрос следующего
// шага должен начинаться с запроса прошлого, иначе кэш промпта пишет хвост истории заново.
// Поэтому шаги одной сессии eve идут в одной папке, а временная папка шага остаётся только
// под system.md, tools.json и settings.json.

/** Рабочая папка, в которой CLI отработал шаг сессии sessionId (undefined — шаг без сессии). */
async function stepCwd(t: TestContext, sessionId?: string): Promise<string> {
  const fake = fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL, { sessionId });
  assert.equal(
    textOf(await drain(await model.doStream({ prompt: userPrompt() }))),
    "Готово",
  );
  return fake.read().cwd as string;
}

/**
 * Папки сессий теста обязаны лежать в своём TMPDIR файла: общий $TMPDIR/iva-cwd-<uid> держит
 * рабочие папки живой Ивы того же пользователя, а тесты ниже удаляют родителя целиком.
 */
function assertInPrivateTmp(path: string): void {
  assert.ok(
    path.startsWith(realpathSync(PRIVATE_TMP) + "/"),
    `папка сессий теста вне своего TMPDIR: ${path}`,
  );
}

/** Меняет переменную окружения на время теста. */
function withEnv(t: TestContext, key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("шаги одной сессии идут в одной рабочей папке, разных сессий — в разных", async (t) => {
  const first = await stepCwd(t, "session-a");
  const second = await stepCwd(t, "session-a");
  const other = await stepCwd(t, "session-b");
  assertInPrivateTmp(first);

  assert.equal(second, first, "второй шаг сессии в той же папке");
  assert.notEqual(other, first, "у другой сессии своя папка");
  assert.equal(dirname(other), dirname(first), "папки сессий лежат рядом");
  assert.ok(existsSync(first), "папка сессии переживает шаг");
  assert.equal(statSync(first).mode & 0o777, 0o700, "папка только для Ивы");
  assert.equal(statSync(dirname(first)).mode & 0o777, 0o700);
  assert.ok(!first.includes("session-a"), "в пути нет sessionId как есть");
  assert.ok(
    !basename(first).startsWith("iva-claude-"),
    "это не временная папка шага",
  );
});

test("шаг без сессии и выключатель CLAUDE_SESSION_CWD остаются во временной папке шага", async (t) => {
  const bare = await stepCwd(t);
  assert.ok(basename(bare).startsWith("iva-claude-"));
  assert.equal(existsSync(bare), false, "временная папка убрана после шага");

  withEnv(t, "CLAUDE_SESSION_CWD", "off");
  const first = await stepCwd(t, "session-off");
  const second = await stepCwd(t, "session-off");
  assert.ok(basename(first).startsWith("iva-claude-"));
  assert.notEqual(second, first, "выключатель возвращает папку на шаг");
  assert.equal(existsSync(first), false);
});

test("чужая или открытая папка сессий не становится рабочей папкой CLI", async (t) => {
  const probe = await stepCwd(t, "session-probe");
  const parent = dirname(probe);
  assertInPrivateTmp(parent);
  const elsewhere = mkdtempSync(join(tmpdir(), "iva-elsewhere-"));
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  // Симлинк на месте папки сессий: подложить его может любой, кто пишет в общий /tmp.
  rmSync(parent, { recursive: true, force: true });
  symlinkSync(elsewhere, parent);
  const linked = await stepCwd(t, "session-link");
  assert.ok(
    basename(linked).startsWith("iva-claude-"),
    "шаг ушёл во временную",
  );
  assert.deepEqual(readdirSync(elsewhere), [], "по симлинку ничего не создано");

  // Папка сессий, открытая другим: шаг тоже уходит во временную папку и не падает.
  rmSync(parent, { recursive: true, force: true });
  mkdirSync(parent, { mode: 0o755 });
  chmodSync(parent, 0o755);
  const open = await stepCwd(t, "session-open");
  assert.ok(basename(open).startsWith("iva-claude-"));

  // Файл на месте папки сессии: шаг идёт во временную папку, файл не тронут.
  rmSync(parent, { recursive: true, force: true });
  const fresh = await stepCwd(t, "session-file");
  rmSync(fresh, { recursive: true, force: true });
  writeFileSync(fresh, "не папка");
  const onFile = await stepCwd(t, "session-file");
  assert.ok(basename(onFile).startsWith("iva-claude-"));
  assert.equal(readFileSync(fresh, "utf8"), "не папка");
});

// CLI закрыл вывод и вышел чуть позже: шаг дождался выхода, и ожидание выхода больше ничего
// не держит — иначе процесс Iva, поднятый ради одного запуска расписания, жил бы лишние секунды.
// Шаг идёт в отдельном процессе: таймеры этого файла от прошлых тестов его не касаются.
test("после выхода CLI ожидание выхода не держит процесс Iva", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Готово" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([{ type: "text", text: "Готово" }], "end_turn"),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        usage: STEP_USAGE,
      },
    ],
    { FAKE_CLAUDE_LINGER_MS: "300" },
  );
  const step = `
    import { makeClaudeCliModel } from ${JSON.stringify(new URL("./claude-cli.ts", import.meta.url).href)};
    const { stream } = await makeClaudeCliModel(${JSON.stringify(MODEL)}).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "привет" }] }],
    });
    const reader = stream.getReader();
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "text-delta") text += next.value.delta;
    }
    process.stdout.write(text + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", step], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let printed = "";
  let drainedAt = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    printed += chunk;
    drainedAt = performance.now();
  });
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0);
  assert.equal(printed, "Готово\n");
  assert.ok(
    performance.now() - drainedAt < 2_000,
    "процесс вышел сразу после шага, а не по таймеру ожидания выхода",
  );
});

test("шаг с отменённым сигналом доезжает до отмены и на doGenerate", async () => {
  const controller = new AbortController();
  controller.abort(cancellation());
  const error = await failureOf(async () =>
    makeClaudeCliModel(MODEL).doGenerate({
      prompt: userPrompt(),
      abortSignal: controller.signal,
    }),
  );
  assert.equal(classifyModelCallError(error), "terminal");
});

// Сигнал, отменённый без причины (`abort()` без аргумента), тоже обязан назваться отменой:
// свою ошибку на это место ставить нечего, у отмены уже есть имя.
test("отмена без причины остаётся отменой, а не отказом CLI", async (t) => {
  const fake = fakeCli(t, "text");
  const controller = new AbortController();
  controller.abort();
  const error = await failureOf(async () =>
    drain(
      await makeClaudeCliModel(MODEL).doStream({
        prompt: userPrompt(),
        abortSignal: controller.signal,
      }),
    ),
  );
  assert.equal(error.name, "AbortError");
  assert.equal(existsSync(fake.dump), false, "процесс CLI не поднимался");
});

test("реле отдаёт наружу пойманный ответ: и текст, и блоки, и расход — из него", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  const api = upstream;
  // Подделка CLI напечатала только голову ответа и выдумала свой расход: и то и другое
  // должно быть отброшено в пользу ответа, который поймало реле.
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_PRINT: "В Ташкенте ",
    FAKE_CLAUDE_TOKEN: "subscription-secret",
  });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: api.url,
  });
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );

  assert.equal(fake.read().answer, 200, "реле пропустило запрос к API");
  // Что именно доехало до API: адрес вместе со строкой запроса (её прибавляет CLI — по ней в
  // прошлом раунде и ломался ход), заголовок CLI как есть и расжатый ответ. Тело реле
  // пересобирает из прочитанного: длина посчитана заново и совпадает с телом.
  const [seen] = api.seen;
  assert.equal(seen?.url, "/v1/messages?beta=true");
  assert.equal(seen?.authorization, "Bearer subscription-secret");
  assert.equal(seen?.acceptEncoding, "identity");
  assert.equal(seen?.contentLength, String(seen?.body));
  assert.equal(
    textOf(parts),
    "В Ташкенте +31",
    "хвост, не доехавший от CLI, дописан из пойманного ответа",
  );
  // Вызов инструмента подделка не печатала вовсе: он приехал из блока ответа API.
  const calls = partsOfType(parts, "tool-call");
  assert.deepEqual(
    calls.map((call) => [call.toolName, call.input]),
    [["weather", '{"city":"Ташкент"}']],
  );
  const finish = finishOf(parts);
  assert.deepEqual(finish.finishReason, {
    unified: "tool-calls",
    raw: "tool_use",
  });
  // Расход — из ответа API (11 + 800 кэша, 12 выходных и 5 думающих), а не из рассказа CLI
  // о себе: подделка называла 999/999 в своём `assistant` и своём `result`.
  assert.deepEqual(finish.usage.inputTokens, {
    total: 811,
    noCache: 11,
    cacheRead: 0,
    cacheWrite: 800,
  });
  assert.equal(finish.usage.outputTokens.total, 12);
  assert.equal(finish.usage.outputTokens.reasoning, 5);
  const relay = finish.providerMetadata?.["iva-claude"] as {
    upstreamRequests?: number;
    deniedRequests?: number;
    cacheWriteTokens?: number;
  };
  assert.equal(relay.upstreamRequests, 1, "ход — это ровно один запрос к API");
  assert.equal(relay.deniedRequests, 0);
  assert.equal(relay.cacheWriteTokens, 800);
});

test("адаптер передаёт реле последний спрашивающий кадр", async (t) => {
  const upstream = await stubApi(t, relayAnswer("Готово"));
  fakeCli(t, "relay-cache");
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });

  await drain(
    await model.doStream({ prompt: userPrompt("закрепи этот кадр") }),
  );

  const payload = upstream.seen[0]?.payload as {
    messages: { content: Record<string, unknown>[] }[];
  };
  assert.equal(payload.messages[1]?.content[0]?.text, "закрепи этот кадр");
  assert.deepEqual(payload.messages[1]?.content[0]?.cache_control, {
    type: "ephemeral",
  });
  assert.equal(
    "cache_control" in (payload.messages[1]?.content[1] ?? {}),
    false,
  );
});

// Боевая ветка Fable: CLI, получив ответ, идёт за продолжением сам. Реле его отбивает, CLI
// объявляет ошибку API и выходит единицей — и всё это НЕ провал шага, а его работа по плану.
test("отбитый второй запрос CLI — не провал хода, а работа реле", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_SECOND: "1",
    FAKE_CLAUDE_PRINT: "В Ташкенте +31",
  });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const parts = await drain(
    await model.doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );

  const second = fake.read().second as { status: number; body: string };
  assert.equal(second.status, 400, "второй запрос CLI не ушёл наружу");
  assert.match(second.body, /IVA_MODEL_ADMISSION_CONSUMED/u);
  assert.equal(upstream.seen.length, 1, "к API ушёл ровно один запрос");
  assert.equal(textOf(parts), "В Ташкенте +31");
  const finish = finishOf(parts);
  assert.equal(finish.finishReason.unified, "tool-calls");
  assert.equal(finish.usage.inputTokens.total, 811);
  const relay = finish.providerMetadata?.["iva-claude"] as {
    upstreamRequests?: number;
    deniedRequests?: number;
  };
  assert.equal(relay.upstreamRequests, 1);
  assert.equal(relay.deniedRequests, 1);
});

// Обратная сторона той же ветки: реле запрос пропустило, а целого ответа не собралось.
// Верить пересказу CLI тут нельзя — ход оборвался на настоящем запросе, и так и надо сказать.
test("оборванный ответ API не подменяется рассказом CLI о нём", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31").slice(0, 5));
  fakeCli(t, "relay", { FAKE_CLAUDE_PRINT: "В Ташкенте" });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] })),
  );
  assert.equal(error.name, "ClaudeCliError");
  assert.match(error.message, /did not finish the response/u);
  // Обрыв связи: eve попросит шаг ещё раз, если до обрыва не пришло ни одной части ответа.
  assert.equal(classifyModelCallError(error), "retry");
});

// Отказ на вход и прочие 4xx — не связь: повтор дал бы тот же ответ, владельцу нужен ответ
// сразу. 408, 429 и 5xx — связь или «позже»: eve просит шаг ещё раз.
for (const [status, verdict] of [
  [401, "recoverable"],
  [403, "recoverable"],
  [400, "recoverable"],
  [408, "retry"],
  [429, "retry"],
  [500, "retry"],
  [529, "retry"],
] as const) {
  test(`HTTP ${status} от api.anthropic.com: ${verdict === "retry" ? "повторяется" : "не повторяется"}`, async (t) => {
    const upstream = await stubApi(
      t,
      ['{"type":"error","error":{"type":"some_error"}}'],
      status,
    );
    fakeCli(t, "relay", { FAKE_CLAUDE_PRINT: "" });
    const error = await failureOf(async () =>
      drain(
        await makeClaudeCliModel(MODEL, {
          silenceTimeoutMs: 10_000,
          upstream: upstream.url,
          // This matrix checks classification after a current-turn effect; recovery has
          // its own first-step fixtures and bounded-window tests.
          turn: { turnId: "status-classification", step: 1 },
        }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
      ),
    );
    assert.match(error.message, new RegExp(`HTTP ${status}`, "u"));
    assert.equal(classifyModelCallError(error), verdict);
  });
}

/** Ответ Anthropic из одного текста: relayAnswer без блока вызова. */
function relayText(text: string): string[] {
  return relayAnswer(text)
    .filter((event) => !event.includes('"index":1'))
    .map((event) =>
      event.replace('"stop_reason":"tool_use"', '"stop_reason":"end_turn"'),
    );
}

// Ночь c1 07.10.2026: поток оборвался, а повтора не было — CLI-шаг открывал поток сразу, и
// eve считала его начатым ответом. Теперь до первой части ответа шаг просится ещё раз, и
// второй запрос идёт через своё реле со своим допуском: первое реле его бы отбило.
test("обрыв до первой части ответа: eve просит шаг ещё раз через новое реле", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const upstream = await stubApi(t, (request) =>
    request === 0 ? relayText("Готово").slice(0, 1) : relayText("Готово"),
  );
  fakeCli(t, "script", {
    FAKE_CLAUDE_RELAY: "1",
    FAKE_CLAUDE_SCRIPT: JSON.stringify([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        usage: {},
      },
    ]),
  });
  // Пауза eve между попытками (5 с) — сразу; таймеры CLI и реле не трогаем.
  const waits: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...rest] = args;
      if (callback.name === "done" && delay === 5_000) {
        waits.push(delay);
        return original(callback, 0, ...rest);
      }
      return original(...args);
    },
  );
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const events: Array<{ type: string; data?: unknown }> = [];
  const step = createToolLoopHarness({
    mode: "conversation",
    tools: new Map(),
    resolveModel: () => Promise.resolve(model),
    handleEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const result = await step(
    {
      agent: {
        system: "Ты Ива.",
        tools: [],
        modelReference: { id: "test/model" },
      },
      compaction: { threshold: 100_000, recentWindowSize: 100 },
      continuationToken: "test",
      sessionId: "test",
      history: [],
    },
    { message: "привет" },
  );
  assert.equal(result.settledTurn?.output, "Готово");
  assert.equal(upstream.seen.length, 2, "второй запрос дошёл до API");
  assert.deepEqual(waits, [5_000]);
  assert.equal(
    events.filter((event) => event.type === "turn.failed").length,
    0,
  );
});

// Ночь 22.09 на c1: апстрим оборвал поток, CLI пошёл за ответом вторым, нестриминговым
// запросом, реле его отбило — и в журнал уехал отказ реле вместо причины обрыва.
test("обрыв ответа API назван обрывом, а не отказом реле на второй запрос CLI", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31").slice(0, 5));
  const fake = fakeCli(t, "relay", {
    FAKE_CLAUDE_SECOND: "1",
    FAKE_CLAUDE_PRINT: "В Ташкенте",
  });
  const error = await failureOf(async () =>
    drain(
      await makeClaudeCliModel(MODEL, {
        silenceTimeoutMs: 10_000,
        upstream: upstream.url,
      }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
    ),
  );
  assert.equal(
    fake.read().fallback,
    "1",
    "CLI не идёт за ответом вторым, нестриминговым запросом",
  );
  assert.doesNotMatch(error.message, /IVA_MODEL_ADMISSION_CONSUMED/u);
  assert.match(error.message, /broke off before message_stop/u);
});

// Аудит ошибок модели, находка 4: вызов закрыт и `message_stop` пришёл, а аргументы модели не
// JSON. Шаг не падает обрывом API: сырые аргументы уходят в eve, eve отвечает модели ошибкой
// аргументов, и история следующего шага собирается.
test("битые аргументы вызова при целом ответе доходят до модели ошибкой, ход идёт дальше", async (t) => {
  const broken = relayAnswer("В Ташкенте +31").map((event) =>
    event.replace(
      JSON.stringify('{"city":"Ташкент"}'),
      JSON.stringify('{"city":'),
    ),
  );
  assert.notDeepEqual(broken, relayAnswer("В Ташкенте +31"));
  const upstream = await stubApi(t, broken);
  fakeCli(t, "relay", { FAKE_CLAUDE_PRINT: "В Ташкенте +31" });
  const claude = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const prompts: LanguageModelV4Prompt[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      if (prompts.length === 1) return claude.doStream(options);
      return {
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Готово" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
  let executed = 0;
  const agent = new ToolLoopAgent({
    model,
    stopWhen: isStepCount(3),
    tools: {
      weather: tool({
        description: "Погода в городе",
        inputSchema: jsonSchema<{ city: string }>(
          WEATHER.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: () => {
          executed += 1;
          return "+30";
        },
      }),
    },
  });
  const result = await agent.stream({ prompt: "привет" });
  assert.equal(await result.text, "Готово");
  assert.equal(prompts.length, 2, "после битых аргументов был второй шаг");
  assert.equal(executed, 0);
  const [answer] =
    prompts[1]
      ?.filter((message) => message.role === "tool")
      .flatMap((message) => message.content) ?? [];
  assert.ok(answer?.type === "tool-result");
  assert.equal(answer.toolCallId, "toolu_relay");
  assert.match(
    answer.output.type === "error-text" ? answer.output.value : "",
    /Invalid input for tool weather/u,
  );
  assert.doesNotThrow(() => claudeHistory(prompts[1] ?? []));
});

test("целый ответ API, начатый словами «API Error», — ответ модели, а не отказ", async (t) => {
  const upstream = await stubApi(
    t,
    relayAnswer("API Error: так называется глава"),
  );
  fakeCli(t, "relay");
  const parts = await drain(
    await makeClaudeCliModel(MODEL, {
      silenceTimeoutMs: 10_000,
      upstream: upstream.url,
    }).doStream({ prompt: userPrompt(), tools: [WEATHER] }),
  );
  assert.equal(textOf(parts), "API Error: так называется глава");
  assert.equal(finishOf(parts).finishReason.unified, "tool-calls");
});

test("текст ошибки из result CLI доезжает в отказ шага", async (t) => {
  scriptCli(
    t,
    [
      MESSAGE_START,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Ответ" }),
      blockStop(0),
      MESSAGE_STOP,
      assistantSays([{ type: "text", text: "Ответ" }], "end_turn"),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
        usage: STEP_USAGE,
        errors: ["Stream idle timeout - partial response received"],
      },
    ],
    { FAKE_CLAUDE_EXIT: "1" },
  );
  const error = await failureOf(async () =>
    drain(await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() })),
  );
  assert.match(
    error.message,
    /error_during_execution \(exit 1\): Stream idle timeout - partial response received/u,
  );
});

test("текст CLI, не совпавший с пойманным ответом, валит ход с понятной причиной", async (t) => {
  const upstream = await stubApi(t, relayAnswer("В Ташкенте +31"));
  fakeCli(t, "relay-mismatch", { FAKE_CLAUDE_PRINT: "" });
  const model = makeClaudeCliModel(MODEL, {
    silenceTimeoutMs: 10_000,
    upstream: upstream.url,
  });
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt(), tools: [WEATHER] })),
  );
  assert.equal(error.name, "ClaudeCliError");
  assert.match(
    error.message,
    /printed text that differs from the response it received/u,
  );
});

// Без пойманного ответа расход берётся из итога CLI, а не из его же сообщения ассистента:
// итог — это то, что CLI насчитал за весь запуск, и другого источника у шага нет.
test("расход без реле берётся из итога CLI", async (t) => {
  fakeCli(t, "text", {
    FAKE_CLAUDE_ASSISTANT_USAGE: JSON.stringify({
      input_tokens: 1,
      output_tokens: 1,
    }),
  });
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal(finishOf(parts).usage.inputTokens.total, 16);
  assert.equal(finishOf(parts).usage.outputTokens.total, 4);
});

// Переполненное окно модель называет своим словом, а eve обязана увидеть ту же стену, что и
// на потолке вывода: иначе обрезанный ответ уедет владельцу как законченный.
test("переполненное окно — это оборванный ответ, а не законченный", async (t) => {
  fakeCli(t, "text", { FAKE_CLAUDE_STOP: "model_context_window_exceeded" });
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.deepEqual(finishOf(parts).finishReason, {
    unified: "length",
    raw: "model_context_window_exceeded",
  });
});

test("нет бинаря — отказ с командой установки, а не молчание", async (t) => {
  fakeCli(t, "text");
  const missing = join(tmpdir(), "iva-no-such-claude");
  process.env.CLAUDE_COMMAND = missing;
  const model = makeClaudeCliModel(MODEL);
  const broken = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.ok(
    broken.message.startsWith(
      `CLAUDE_COMMAND=${missing} is not found or not executable (PATH: `,
    ),
    broken.message,
  );
  // Без CLAUDE_COMMAND и с пустым PATH — команда установки и PATH, где искали.
  const emptyDir = mkdtempSync(join(tmpdir(), "iva-empty-path-"));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(emptyDir, { recursive: true, force: true });
  });
  process.env.CLAUDE_COMMAND = "";
  process.env.PATH = emptyDir;
  const error = await failureOf(async () =>
    drain(await model.doStream({ prompt: userPrompt() })),
  );
  assert.ok(error.message.includes(`(PATH: ${emptyDir})`), error.message);
  assert.match(
    error.message,
    /npm install -g --prefix ~\/\.local @anthropic-ai\/claude-code/u,
  );
  assert.equal(classifyModelCallError(error), "recoverable");
});

// Подсказка установки зовёт userInfo(), а он бросает у uid без записи в passwd: успешный
// запуск не должен её собирать.
test("найденный CLI запускается, даже если userInfo() бросает", async (t) => {
  fakeCli(t, "text");
  t.mock.method(os, "userInfo", () => {
    throw new Error("uv_os_get_passwd returned ENOENT");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal(finishOf(parts).finishReason.unified, "stop");
});

test("doGenerate собирает тот же шаг в один результат", async (t) => {
  fakeCli(t, "text");
  const model = makeClaudeCliModel(MODEL);
  const result = await model.doGenerate({ prompt: userPrompt() });
  assert.deepEqual(result.content, [{ type: "text", text: "Готово" }]);
  assert.deepEqual(result.finishReason, { unified: "stop", raw: "end_turn" });
  assert.equal(result.usage.inputTokens.total, 16);
});

test("длинный ответ доезжает целиком, без склейки текста", async (t) => {
  fakeCli(t, "long");
  const parts = await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal(textOf(parts), "a".repeat(4000));
});

async function waitForPid(fake: Fake): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Дампа ещё может не быть: подделка только заводится.
    if (existsSync(fake.dump)) {
      const pid = fake.read().pid;
      if (typeof pid === "number") return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("поддельный CLI не записал свой pid");
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ─── Чистые части: окружение, инструменты, усилие, расход ───────────────────────────────

test("имя модели для CLI и окно контекста берутся из одной таблицы", () => {
  // Рукопожатие отдаёт route-ид; CLI принимает своё имя — у миллионного окна с суффиксом [1m].
  assert.equal(claudeNativeModel("claude-fable-5-1"), "claude-fable-5-1[1m]");
  assert.equal(claudeNativeModel("fable"), "claude-fable-5-1[1m]");
  assert.equal(claudeNativeModel("opus"), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeModel("claude-opus-5-5"), "claude-opus-5-5[1m]");
  assert.equal(claudeNativeModel("sonnet"), "claude-sonnet-5-5[1m]");
  assert.equal(claudeNativeModel("claude-sonnet-5-5"), "claude-sonnet-5-5[1m]");
  assert.equal(
    claudeNativeModel(" claude-opus-5-5[1m] "),
    "claude-opus-5-5[1m]",
  );
  // Haiku 5.5 — миллионное окно, с суффиксом; псевдоним `haiku` ведёт к ней, как у пикера
  // CLI 2.1.293. Haiku 4.5 по полному имени едет без суффикса.
  assert.equal(claudeNativeModel("claude-haiku-5-5"), "claude-haiku-5-5[1m]");
  assert.equal(claudeNativeModel("haiku"), "claude-haiku-5-5[1m]");
  assert.equal(
    claudeNativeModel("claude-haiku-4-5"),
    "claude-haiku-4-5-20251001",
  );
  assert.equal(
    claudeNativeModel("claude-haiku-4-5-20251001"),
    "claude-haiku-4-5-20251001",
  );
  // Прошлые Opus и Sonnet подписки — тоже миллионное окно, то есть тоже с суффиксом: старый
  // id в .env не должен уехать к CLI голым именем.
  assert.equal(claudeNativeModel("claude-opus-5"), "claude-opus-5[1m]");
  assert.equal(claudeNativeModel("claude-sonnet-5"), "claude-sonnet-5[1m]");
  assert.equal(claudeNativeModel("claude-opus-4-8"), "claude-opus-4-8[1m]");
  // Незнакомая модель уезжает как есть: чужой аккаунт не угадывают.
  assert.equal(claudeNativeModel("claude-mystery-9"), "claude-mystery-9");
  assert.deepEqual(claudeModel("claude-mystery-9"), {
    native: "claude-mystery-9",
    window: 200_000,
    adaptive: false,
  });
  assert.equal(claudeModel("claude-haiku-4-5-20251001").window, 200_000);
  assert.equal(claudeModel("claude-haiku-5-5").window, 1_000_000);
  assert.equal(claudeModel("haiku").window, 1_000_000);
  assert.equal(claudeModel("fable").window, 1_000_000);
  // adaptive thinking Haiku 4.5 не умеет — и он же не едет в тело запроса.
  assert.equal(claudeModel("claude-haiku-4-5-20251001").adaptive, false);
  assert.equal(claudeModel("fable").adaptive, true);
  const haikuBody = claudeExtraBody(
    { prompt: userPrompt() },
    [],
    "claude-haiku-4-5",
  );
  assert.equal(haikuBody.thinking, undefined);
  assert.equal(haikuBody.output_config, undefined);
  // Haiku 5.5 adaptive умеет: живьём 08.10.2026 подписка приняла low…max.
  assert.equal(claudeModel("claude-haiku-5-5").adaptive, true);
  const haiku55Body = claudeExtraBody(
    { prompt: userPrompt() },
    [],
    "claude-haiku-5-5",
  );
  assert.deepEqual(haiku55Body.thinking, { type: "adaptive" });
  const fableBody = claudeExtraBody({ prompt: userPrompt() }, [], MODEL);
  assert.deepEqual(fableBody.thinking, { type: "adaptive" });
});

test("ключ API в окружении — отказ с именем переменной и без её значения", () => {
  const secret = "sk-ant-super-secret";
  const error = (() => {
    try {
      claudeEnv({ ANTHROPIC_API_KEY: secret }, "http://127.0.0.1:1/x");
      return undefined;
    } catch (caught) {
      return caught as Error;
    }
  })();
  assert.ok(error instanceof ClaudeCliError);
  assert.match(error.message, /ANTHROPIC_API_KEY/u);
  assert.ok(!error.message.includes(secret), "значение в журнал не попадает");
  assert.deepEqual(claudeConflicts({ ANTHROPIC_AUTH_TOKEN: "x" }), [
    "ANTHROPIC_AUTH_TOKEN",
  ]);
  // Чужой адрес API Iva не отменяет молча: ход всё равно ушёл бы через реле на
  // api.anthropic.com, и настройка владельца исчезла бы без единого слова.
  assert.deepEqual(
    claudeConflicts({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      ANTHROPIC_FOUNDRY_API_KEY: "k",
    }),
    ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_BASE_URL"],
  );
  // Выключенный бэкенд — не конфликт: `0`, `false` и пустое значение значат «нет».
  for (const value of ["", "0", "false", "no", "off", "OFF"])
    assert.deepEqual(claudeConflicts({ CLAUDE_CODE_USE_BEDROCK: value }), []);
  assert.deepEqual(claudeConflicts({ CLAUDE_CODE_USE_BEDROCK: "1" }), [
    "CLAUDE_CODE_USE_BEDROCK",
  ]);
  // Незнакомый бэкенд — тоже конфликт: имена вендор добавляет, а список имён стареет.
  assert.deepEqual(
    claudeConflicts({
      CLAUDE_CODE_USE_SOMETHING_NEW: "1",
      CLAUDE_CODE_USE_VERTEX: "",
    }),
    ["CLAUDE_CODE_USE_SOMETHING_NEW"],
  );
});

test("окружение CLI получает адрес реле и выключенный лишний трафик", () => {
  const env = claudeEnv(
    {
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/user/.claude",
      EMPTY: undefined,
    },
    "http://127.0.0.1:9999/admit/x",
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999/admit/x");
  assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(env.DISABLE_AUTO_COMPACT, "1");
  // Чужой каталог настроек CLI не трогаем: там его логин.
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/user/.claude");
  assert.equal("EMPTY" in env, false);
  // Унаследованное тело запроса — чужие инструменты поверх наших; своё едет в settings.json.
  assert.equal(
    "CLAUDE_CODE_EXTRA_BODY" in
      claudeEnv(
        { CLAUDE_CODE_EXTRA_BODY: '{"tools":[]}' },
        "http://127.0.0.1:1/x",
      ),
    false,
  );
  // Потолок вывода CLI обязан знать до запроса: иначе попросит у модели свой.
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(
    claudeEnv({}, "http://127.0.0.1:1/x", 2000).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    "2000",
  );
});

// CLAUDE_COMMAND — командная строка: голова ищется, аргументы идут CLI перед нашими.
test("CLAUDE_COMMAND с аргументом запускает CLI, а не ищет файл с пробелом в имени", async (t) => {
  const fake = fakeCli(t, "text");
  process.env.CLAUDE_COMMAND = `${fake.command} --iva-extra`;
  assert.deepEqual(claudeCommand(process.env), [fake.command, "--iva-extra"]);
  // Пусто и пробелы — это `claude`, а на пустом PATH его нет: отказ до запуска.
  assert.equal(claudeCommand({ PATH: "" }), null);
  assert.equal(claudeCommand({ CLAUDE_COMMAND: "  ", PATH: "" }), null);
  await drain(
    await makeClaudeCliModel(MODEL).doStream({ prompt: userPrompt() }),
  );
  assert.equal((fake.read().argv as string[])[0], "--iva-extra");
});

test("имя инструмента — только ASCII, с префиксом до 64 символов", () => {
  const tool = (name: string): LanguageModelV4FunctionTool => ({
    ...WEATHER,
    name,
  });
  assert.equal(claudeTools([tool("a".repeat(54))]).names.length, 1);
  assert.throws(() => claudeTools([tool("a".repeat(55))]), /54/u);
  assert.throws(() => claudeTools([tool("погода")]), /A-Za-z0-9_-/u);
  assert.throws(() => claudeTools([tool("same"), tool("same")]), /unique/u);
  assert.throws(
    () =>
      claudeTools([
        {
          type: "provider",
          id: "openai.web_search",
          name: "x",
          args: {},
        } as never,
      ]),
    /function tools only/u,
  );
});

// Предупреждение — не украшение: вызывающий, попросивший строгий JSON или обязательный
// вызов инструмента, обязан узнать, что подписка этого не обещает.
test("непереданные гарантии названы предупреждением, а не потеряны", () => {
  const warnings = claudeWarnings({
    prompt: [],
    temperature: 0.7,
    toolChoice: { type: "required" },
    responseFormat: { type: "json" },
  });
  assert.deepEqual(
    warnings.map((warning) =>
      warning.type === "unsupported" ? warning.feature : warning.type,
    ),
    ["temperature", "toolChoice", "responseFormat"],
  );
  assert.deepEqual(
    claudeWarnings({
      prompt: [],
      toolChoice: { type: "auto" },
      responseFormat: { type: "text" },
    }),
    [],
  );
});

test("усилие уходит только из принятого списка", () => {
  assert.equal(claudeEffort("low"), "low");
  assert.equal(claudeEffort(" MAX "), "max");
  // minimal подписка отвергает, disabled Iva не знает вовсе.
  assert.equal(claudeEffort("minimal"), undefined);
  assert.equal(claudeEffort("disabled"), undefined);
  assert.equal(claudeEffort("turbo"), undefined);
  assert.equal(claudeEffort(undefined), undefined);

  const previous = process.env.THINKING_EFFORT;
  process.env.THINKING_EFFORT = "xhigh";
  const body = claudeExtraBody({ prompt: userPrompt() }, [], MODEL);
  assert.deepEqual(body.output_config, { effort: "xhigh" });
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  if (previous === undefined) delete process.env.THINKING_EFFORT;
  else process.env.THINKING_EFFORT = previous;

  const limited = claudeExtraBody(
    { prompt: userPrompt(), maxOutputTokens: 700, stopSequences: ["STOP"] },
    [],
    MODEL,
  );
  assert.equal(limited.max_tokens, 700);
  assert.deepEqual(limited.stop_sequences, ["STOP"]);
  assert.deepEqual(
    claudeWarnings({
      prompt: userPrompt(),
      temperature: 0.5,
      topP: 0.9,
    }).map((warning) => (warning as { feature?: string }).feature),
    ["temperature", "topP"],
  );
});

test("расход складывает весь вход и отдельно называет кэш", () => {
  const usage = claudeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
    output_tokens_details: { thinking_tokens: 7 },
  });
  assert.deepEqual(usage.inputTokens, {
    total: 1050,
    noCache: 100,
    cacheRead: 900,
    cacheWrite: 50,
  });
  assert.deepEqual(usage.outputTokens, {
    total: 20,
    text: undefined,
    reasoning: 7,
  });
  // Мусор провайдера не превращается в расход: дробное и отрицательное — не токены.
  assert.deepEqual(
    claudeUsage({ input_tokens: 1.5, output_tokens: -3 }).inputTokens,
    {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  );
  assert.equal(claudeUsage(undefined).outputTokens.total, 0);
});

test("readCompletion берёт текст, вызовы и причину из сообщений модели", () => {
  const completion = readCompletion([
    {
      content: [
        { type: "thinking", thinking: "думаю" },
        { type: "text", text: "Иду " },
        {
          type: "tool_use",
          id: "toolu_1",
          name: `${CLAUDE_TOOL_PREFIX}weather`,
          input: { city: "Ташкент" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  ]);
  assert.equal(completion.text, "Иду ");
  assert.deepEqual(completion.calls, [
    { id: "toolu_1", name: "weather", input: '{"city":"Ташкент"}' },
  ]);
  assert.equal(completion.stopReason, "tool_use");
  assert.equal(completion.usage.inputTokens.total, 5);
  assert.equal(completion.hasUsage, true);
  assert.equal(readCompletion([]).hasUsage, false);
});

test("MCP schema without type reaches the Claude request with an object root", async (t) => {
  const fake = fakeCli(t, "text");
  const { toolNameWireMiddleware } = await import("./tool-wire-name.ts");
  const model = wrapLanguageModel({
    model: makeClaudeCliModel(MODEL),
    middleware: toolNameWireMiddleware(CLAUDE_TOOL_NAME_MAX),
  });
  const inputSchema = {
    properties: { query: { type: "string" as const } },
    required: ["query"],
    additionalProperties: false,
  };
  const parts = await drain(
    await model.doStream({
      prompt: userPrompt(),
      tools: [{ ...WEATHER, name: "connection__search", inputSchema }],
    }),
  );
  assert.equal(textOf(parts), "Готово");
  const settings = fake.read().settings as {
    env: { CLAUDE_CODE_EXTRA_BODY: string };
  };
  const body = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY) as {
    tools: { input_schema: unknown }[];
  };
  assert.deepEqual(body.tools[0].input_schema, {
    ...inputSchema,
    type: "object",
  });
});
