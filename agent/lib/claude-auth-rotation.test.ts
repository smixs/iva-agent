/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns registrations. */
import "../../scripts/fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter, once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type RequestOptions,
} from "node:http";
import https from "node:https";
import { Server } from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as immediate } from "node:timers/promises";
import fc from "fast-check";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  streamText,
  ToolLoopAgent,
  isStepCount,
  jsonSchema,
  tool,
  type LanguageModelMiddleware,
} from "ai";
import { makeClaudeCliModel } from "./claude-cli.ts";
import { modelAuthFailure, modelAuthText } from "./model-auth.ts";
import { humanizeProviderError } from "./error-humanizer.ts";
import { runAuthAlert } from "./model-auth-alert.ts";
import { readAlertState } from "../../packages/alert-state/index.ts";
import { modelFirstChunkDeadlineMiddleware } from "../provider.ts";
import {
  claudeAuthReplaySafe,
  claudeAuthRotationWaitMs,
  CLAUDE_AUTH_ROTATION_WAIT_MS,
  readClaudeAuthSnapshot,
} from "./claude-auth-rotation.ts";

const MODEL = "claude-fable-5-1";
const PROMPT: LanguageModelV4Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const CLI = `
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const frames = [];
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  frames.push(frame);
  if (frame.shouldQuery === false) {
    send({ type: "result", subtype: "success", is_error: false, num_turns: 0 });
    continue;
  }
  if (frame.type !== "user") continue;
  appendFileSync(process.env.ROTATION_CALLS, JSON.stringify({ pid: process.pid, temp: dirname(arg("--settings")), relay: process.env.ANTHROPIC_BASE_URL, frames, system: readFileSync(arg("--system-prompt-file"), "utf8") }) + "\\n");
  const call = readFileSync(process.env.ROTATION_CALLS, "utf8").trim().split("\\n").length;
  if (Number(process.env.ROTATION_HANG_CALL) === call) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const effect = process.env.ROTATION_EFFECT;
  if (effect === "text") send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "visible" } } });
  if (effect === "reasoning" || effect === "tool") send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: effect === "reasoning" ? { type: "thinking", thinking: "" } : { type: "tool_use", id: "t1", name: "mcp__iva__weather", input: {} } } });
  const credentials = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude"), ".credentials.json"), "utf8"));
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + credentials.claudeAiOauth.accessToken }, body: JSON.stringify({ model: arg("--model"), stream: true, messages: [{ role: "user", content: "hello" }] }) });
  const body = await response.text();
  if (!response.ok) {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: " + response.status], num_turns: 1 });
    process.exit(1);
  }
  const events = body.split("\\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
  const called = events.some(event => event.content_block?.type === "tool_use");
  for (const event of events) send({ type: "stream_event", event });
  send({ type: "assistant", message: { role: "assistant", content: called ? [{ type: "tool_use", id: "tool-current", name: "mcp__iva__weather", input: {} }] : [{ type: "text", text: "recovered" }], stop_reason: called ? "tool_use" : "end_turn" } });
  send({ type: "result", subtype: called ? "error_max_turns" : "success", is_error: called, num_turns: 1 });
  process.exit(called ? 1 : 0);
}
`;

type Call = {
  pid: number;
  temp: string;
  relay: string;
  frames: unknown;
  system: string;
};
async function fixture(
  t: TestContext,
  config: {
    statuses?: number[];
    effect?: string;
    fallbackHome?: boolean;
    refresh?: boolean;
    rotateBefore401?: boolean;
    waitMs?: number;
    toolAt?: number;
    hangCall?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "iva-rotation-test-"));
  const home = join(root, "home");
  const configDir = config.fallbackHome
    ? join(home, ".claude")
    : join(root, "config");
  const data = join(root, "data");
  const temporary = join(root, "tmp");
  for (const dir of [home, configDir, data, temporary])
    mkdirSync(dir, { recursive: true });
  const file = join(configDir, ".credentials.json");
  const payload = (accessToken: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        ...(config.refresh ? { refreshToken: "synthetic-refresh" } : {}),
      },
    });
  writeFileSync(file, payload("synthetic-A"));
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      claude: { authRotationWaitMs: config.waitMs ?? 60 },
      proactive: { quietFromHour: 0, quietToHour: 0 },
    }),
  );
  const callsFile = join(root, "calls.jsonl");
  const command = join(root, "cli.mjs");
  writeFileSync(command, CLI);
  const previous = new Map<string, string | undefined>();
  const env: Record<string, string | undefined> = {
    HOME: home,
    CLAUDE_CONFIG_DIR: config.fallbackHome ? undefined : configDir,
    ASSISTANT_DATA_DIR: data,
    TMPDIR: temporary,
    MODEL_PROVIDER: "claude",
    CLAUDE_COMMAND: `${process.execPath} ${command}`,
    ROTATION_CALLS: callsFile,
    ROTATION_EFFECT: config.effect ?? "",
    ROTATION_HANG_CALL: String(config.hangCall ?? 0),
  };
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let requests = 0;
  const rotate = () => {
    const before = statSync(file);
    writeFileSync(`${file}.next`, payload("synthetic-B"));
    utimesSync(`${file}.next`, before.atime, before.mtime);
    renameSync(`${file}.next`, file);
  };
  const server = createServer((request, response) => {
    request.resume();
    const index = requests++;
    if (config.rotateBefore401 && index === 0) rotate();
    const status = config.statuses?.[index] ?? (index === 0 ? 401 : 200);
    response.writeHead(status, {
      "content-type": status === 200 ? "text/event-stream" : "application/json",
    });
    const called = config.toolAt === index;
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_test",
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: called
          ? {
              type: "tool_use",
              id: "tool-current",
              name: "mcp__iva__weather",
              input: {},
            }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: called
          ? { type: "input_json_delta", partial_json: "{}" }
          : { type: "text_delta", text: "recovered" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: called ? "tool_use" : "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    response.end(
      status === 200
        ? events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join("")
        : '{"error":{"type":"authentication_error"}}',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const calls = (): Call[] =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : [];
  const model = (
    step?: number,
    attemptMiddleware = modelFirstChunkDeadlineMiddleware,
  ) => {
    const settings = {
      upstream: `http://127.0.0.1:${address.port}`,
      silenceTimeoutMs: 180_000,
      attemptMiddleware,
      ...(step === undefined ? {} : { turn: { turnId: "turn-current", step } }),
    };
    return makeClaudeCliModel(MODEL, settings);
  };
  const clean = () =>
    readdirSync(temporary).filter((name) => name.startsWith("iva-claude-"))
      .length === 0;
  const configuredModels = async () => {
    // Keep the real provider's wiring; only its HTTPS socket goes to this local upstream.
    t.mock.method(
      https,
      "request",
      (options: RequestOptions, callback: () => void) => {
        assert.equal(options.hostname, "api.anthropic.com");
        return httpRequest(
          {
            ...options,
            protocol: "http:",
            hostname: "127.0.0.1",
            port: address.port,
          },
          callback,
        );
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const url = new URL("../provider.ts", import.meta.url);
    url.searchParams.set("fixture", root);
    const provider = (await import(
      url.href
    )) as typeof import("../provider.ts");
    return (step: number) =>
      provider.makeTextModel({
        chatModelSeesImages: () => Promise.resolve(false),
        usage: { sessionId: "synthetic", turnId: "turn-current", step },
      });
  };
  return {
    root,
    data,
    file,
    calls,
    model,
    rotate,
    clean,
    configuredModels,
    requests: () => requests,
  };
}

async function consume(
  model: ReturnType<typeof makeClaudeCliModel>,
  prompt = PROMPT,
  abortSignal?: AbortSignal,
) {
  const parts: LanguageModelV4StreamPart[] = [];
  let error: unknown;
  try {
    const { stream } = await model.doStream({ prompt, abortSignal });
    for await (const part of stream) parts.push(part);
  } catch (caught) {
    error = caught;
  }
  return {
    parts,
    error,
    text: parts
      .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
      .join(""),
  };
}

async function settledIo(predicate: () => boolean) {
  const start = performance.now();
  while (!predicate()) {
    assert.ok(
      performance.now() - start < 5000,
      "fixture IO did not settle within 5s",
    );
    await immediate();
  }
  for (let n = 0; n < 10; n++) await immediate();
}

// Keep HTTP, node:timers/promises and session teardown on real time. Only the
// three rotation/deadline delays below belong to this test's controlled clock.
function rotationClock(t: TestContext) {
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const timers = new Map<unknown, { at: number; fire: () => void }>();
  let now = 0;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...rest] = args;
      if (delay !== 90_000 && delay !== 120_000 && delay !== 250)
        return nativeSet(...args);
      const handle = nativeSet(() => undefined, 2 ** 31 - 1).unref();
      timers.set(handle, {
        at: now + delay,
        fire: () => {
          Reflect.apply(callback, undefined, rest);
        },
      });
      return handle;
    },
  );
  t.mock.method(
    globalThis,
    "clearTimeout",
    (handle: Parameters<typeof clearTimeout>[0]) => {
      timers.delete(handle);
      nativeClear(handle);
    },
  );
  t.after(() => {
    for (const handle of timers.keys())
      nativeClear(handle as ReturnType<typeof setTimeout>);
    timers.clear();
  });
  return {
    pending: () => timers.size,
    tick(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        timers.delete(handle);
        nativeClear(handle as ReturnType<typeof setTimeout>);
        timer.fire();
      }
      now = until;
    },
  };
}

/** Hold the real relay's listening notification after its socket exists, before adopt. */
function holdRelayListening(t: TestContext) {
  const captured: { server?: Server } = {};
  let release: () => void = () => undefined;
  let signalReady!: (server: Server) => void;
  const ready = new Promise<Server>((resolve) => {
    signalReady = resolve;
  });
  t.mock.method(
    Server.prototype,
    "emit",
    function (this: Server, event: string | symbol, ...args: unknown[]) {
      const emit = EventEmitter.prototype.emit.bind(this);
      if (event !== "listening" || captured.server) return emit(event, ...args);
      captured.server = this;
      release = () => {
        release = () => undefined;
        emit(event, ...args);
      };
      signalReady(this);
      return true;
    },
  );
  t.after(async () => {
    release();
    if (captured.server?.listening)
      await new Promise<void>((resolve) => {
        captured.server?.close(() => resolve());
      });
  });
  return { ready, release: () => release() };
}

for (const mode of ["bare", "provider", "delayed-result"])
  test(`rotation late acquire: ${mode} cancellation cleans late resources without use`, async (t) => {
    const f = await fixture(t, { waitMs: 120_000 });
    const configured =
      mode === "provider" ? await f.configuredModels() : undefined;
    const clock = rotationClock(t);
    const relay = holdRelayListening(t);
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const middleware: LanguageModelMiddleware = {
      async wrapStream(context) {
        assert.ok(modelFirstChunkDeadlineMiddleware.wrapStream);
        const result =
          await modelFirstChunkDeadlineMiddleware.wrapStream(context);
        await resultGate;
        return result;
      },
    };
    t.after(releaseResult);
    const model = configured
      ? configured(0)
      : f.model(undefined, mode === "delayed-result" ? middleware : undefined);
    const { stream } = await model.doStream({ prompt: PROMPT });
    const server = await relay.ready;
    let completed = false;
    const cancelling = stream
      .cancel(new Error("cancel during synthetic admission acquire"))
      .then(() => {
        completed = true;
      });
    await immediate();
    const early = completed;
    releaseResult();
    await immediate();
    const beforeAdopt = completed;
    relay.release();
    await cancelling;
    await settledIo(
      () => !server.listening && f.clean() && clock.pending() === 0,
    );
    // Existing outer pipeThrough middleware acknowledges cancellation before
    // its source finishes cleanup. Only our own wrapper promises that wait.
    if (mode !== "provider") {
      assert.equal(
        early,
        false,
        "cancel must wait for its pending result/acquire",
      );
      assert.equal(
        beforeAdopt,
        false,
        "cancel must wait until admission can be adopted",
      );
    }
    f.rotate();
    clock.tick(121_000);
    await immediate();
    assert.equal(server.listening, false);
    assert.ok(f.clean());
    assert.equal(f.calls().length, 0);
    assert.equal(f.requests(), 0);
    assert.equal(clock.pending(), 0);
  });

test("rotation late spawn: cancel waits for attach and sends no input or API call", async (t) => {
  const f = await fixture(t);
  const clock = rotationClock(t);
  const spawn = childProcess.spawn;
  let child: ReturnType<typeof spawn> | undefined;
  let signalReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  let release: () => void = () => undefined;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    child = Reflect.apply(spawn, childProcess, args);
    const emit = child.emit.bind(child);
    const captured = child;
    t.mock.method(
      child,
      "emit",
      function (event: string | symbol, ...values: unknown[]) {
        if (event !== "spawn")
          return Reflect.apply(emit, captured, [event, ...values]) as boolean;
        release = () => {
          release = () => undefined;
          Reflect.apply(emit, captured, [event, ...values]);
        };
        signalReady();
        return true;
      },
    );
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    release();
    if (child?.pid && child.exitCode === null && child.signalCode === null)
      process.kill(-child.pid, "SIGKILL");
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { stream } = await f.model().doStream({ prompt: PROMPT });
  await ready;
  let completed = false;
  const cancelling = stream
    .cancel(new Error("cancel during synthetic spawn"))
    .then(() => {
      completed = true;
    });
  await immediate();
  const early = completed;
  release();
  await cancelling;
  for (let n = 0; n < 10; n++) await immediate();
  assert.equal(early, false);
  assert.ok(f.clean());
  assert.equal(f.calls().length, 0);
  assert.equal(f.requests(), 0);
  assert.equal(clock.pending(), 0);
  assert.ok(child?.pid);
  const pid = child.pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
});

test("rotation RED: snapshot precedes CLI; atomic access change with same mtime recovers silently", async (t) => {
  const f = await fixture(t, { rotateBefore401: true });
  const result = await consume(f.model());
  assert.equal(result.error, undefined);
  assert.equal(result.text, "recovered");
  assert.equal(f.requests(), 2);
  assert.deepEqual(f.calls()[0].frames, f.calls()[1].frames);
  assert.equal(f.calls()[0].system, f.calls()[1].system);
  assert.ok(f.clean());
  assert.deepEqual(readAlertState(f.data), {});
});

test("rotation RED: expired unchanged window makes one final call and one existing Alert", async (t) => {
  const f = await fixture(t, { statuses: [401, 401, 200] });
  const result = await consume(f.model());
  assert.equal(f.requests(), 2);
  assert.equal(modelAuthFailure(result.error, "claude"), "claude");
  const sent: string[] = [];
  const options = {
    dir: f.data,
    env: { MODEL_PROVIDER: "claude", ASSISTANT_TIMEZONE: "UTC" },
    lang: "ru" as const,
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve(true);
    },
  };
  await runAuthAlert(
    { provider: "claude", at: Date.now(), failed: true, answers: true },
    options,
  );
  await runAuthAlert(undefined, options);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /claude auth login/u);
});

test("rotation RED: doGenerate shares the recovered stream and HOME fallback", async (t) => {
  const f = await fixture(t, { rotateBefore401: true, fallbackHome: true });
  const result = await f.model().doGenerate({ prompt: PROMPT });
  assert.deepEqual(result.content, [{ type: "text", text: "recovered" }]);
  assert.equal(f.requests(), 2);
});

for (const effect of ["text", "reasoning", "tool"])
  test(`rotation guard: ${effect} before HTTP 401 closes replay`, async (t) => {
    const f = await fixture(t, { effect, rotateBefore401: true });
    const result = await consume(f.model());
    assert.ok(result.error instanceof Error);
    assert.equal(f.requests(), 1);
    assert.ok(
      result.parts.some(
        (part) =>
          part.type ===
          {
            text: "text-delta",
            reasoning: "reasoning-start",
            tool: "tool-input-start",
          }[effect],
      ),
    );
  });

const TOOL_HISTORY: LanguageModelV4Prompt = [
  ...PROMPT,
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "old-tool",
        toolName: "weather",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "old-tool",
        toolName: "weather",
        output: { type: "text", value: "done" },
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "continue" }] },
];

test("rotation guard: a recreated step 1 model and trailing service user preserve the tool barrier", async (t) => {
  const f = await fixture(t, { rotateBefore401: true });
  const result = await consume(f.model(1), TOOL_HISTORY);
  assert.ok(result.error instanceof Error);
  assert.equal(f.requests(), 1);
});

test("rotation RED: previous-turn tools permit a proven new turn's first step", async (t) => {
  const f = await fixture(t, { rotateBefore401: true });
  const result = await consume(f.model(0), TOOL_HISTORY);
  assert.equal(result.error, undefined);
  assert.equal(f.requests(), 2);
});

for (const status of [403, 429, 500])
  test(`rotation guard: HTTP ${status} has no new auth replay`, async (t) => {
    const f = await fixture(t, {
      statuses: [status, 200],
      rotateBefore401: true,
    });
    const result = await consume(f.model());
    assert.ok(result.error instanceof Error);
    assert.equal(f.requests(), 1);
  });

test("rotation RED: abort while waiting ends with its reason, clean sessions and one call", async (t) => {
  const f = await fixture(t, { waitMs: 120_000 });
  const configured = await f.configuredModels();
  const abort = new AbortController();
  const pending = consume(configured(0), PROMPT, abort.signal);
  await settledIo(() => f.requests() === 1 && f.clean());
  const reason = new Error("owner cancelled synthetic turn");
  abort.abort(reason);
  const result = await pending;
  assert.equal(result.error, reason);
  assert.ok(f.clean());
  assert.equal(f.requests(), 1);
  for (const call of f.calls()) {
    assert.equal(existsSync(call.temp), false);
    assert.throws(() => process.kill(call.pid, 0), /ESRCH/u);
    await assert.rejects(fetch(call.relay));
  }
});

test("rotation cancel: reader cancellation while waiting cleans up and closes replay", async (t) => {
  const f = await fixture(t, { waitMs: 120_000 });
  const clock = rotationClock(t);
  const { stream } = await f.model().doStream({ prompt: PROMPT });
  const reader = stream.getReader();
  await reader.read();
  await settledIo(() => f.requests() === 1 && f.clean());
  await reader.cancel("owner cancelled the synthetic reader");
  assert.equal(clock.pending(), 0);
  f.rotate();
  clock.tick(121_000);
  await immediate();
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  assert.equal(f.requests(), 1);
  assert.equal(f.calls().length, 1);
  assert.ok(f.clean());
  for (const call of f.calls()) {
    assert.equal(existsSync(call.temp), false);
    assert.throws(() => process.kill(call.pid, 0), /ESRCH/u);
    await assert.rejects(fetch(call.relay));
  }
});

test("rotation RED: real relay + CLI recover after 100s inside a 120s window", async (t) => {
  const f = await fixture(t, { waitMs: 120_000 });
  const configured = await f.configuredModels();
  const clock = rotationClock(t);
  const errors: unknown[] = [];
  const result = streamText({
    model: configured(0),
    prompt: "hello",
    maxRetries: 0,
    onError: ({ error }) => {
      errors.push(error);
    },
  });
  const pending = result.text;
  await settledIo(() => f.requests() === 1 && f.clean());
  clock.tick(100_000);
  await immediate();
  f.rotate();
  clock.tick(1000);
  await immediate();
  assert.equal(await pending, "recovered");
  assert.deepEqual(errors, []);
  assert.equal(f.requests(), 2);
  assert.deepEqual(readAlertState(f.data), {});
});

test("rotation integration: executed tool, recreated step and service user yield one final failure", async (t) => {
  const f = await fixture(t, {
    statuses: [200, 401, 200],
    toolAt: 0,
    rotateBefore401: true,
  });
  const configured = await f.configuredModels();
  let effects = 0;
  const agent = new ToolLoopAgent({
    model: configured(0),
    maxRetries: 0,
    stopWhen: isStepCount(3),
    tools: {
      weather: tool({
        inputSchema: jsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: () => {
          effects++;
          return Promise.resolve("done");
        },
      }),
    },
    prepareStep: ({ stepNumber, messages }) => ({
      model: configured(stepNumber),
      messages:
        stepNumber === 0
          ? messages
          : [
              ...messages,
              {
                role: "user",
                content:
                  "Step limit reached. Finish from the completed tool result.",
              },
            ],
    }),
  });
  await assert.rejects(agent.generate({ prompt: "hello" }), /HTTP 401/u);
  assert.equal(effects, 1);
  assert.equal(f.requests(), 2);
  assert.equal(f.calls().length, 2);
  assert.ok(f.clean());
});

for (const hangCall of [1, 2])
  test(`rotation deadline: silent attempt ${hangCall} keeps its own 90s bound`, async (t) => {
    const f = await fixture(t, { hangCall, rotateBefore401: true });
    const configured = await f.configuredModels();
    const clock = rotationClock(t);
    const pending = consume(configured(0));
    await settledIo(() => f.calls().length === hangCall);
    clock.tick(89_999);
    await immediate();
    const lastCall = f.calls().at(-1);
    assert.ok(lastCall && existsSync(lastCall.temp));
    clock.tick(1);
    const result = await pending;
    assert.equal(
      (result.error as { code?: string })?.code,
      "MODEL_FIRST_CHUNK_TIMEOUT",
    );
    await settledIo(f.clean);
    assert.equal(f.calls().length, hangCall);
  });

test("rotation waiting tolerates missing, unreadable and partial credentials until valid access returns", async (t) => {
  const f = await fixture(t, { waitMs: 120_000 });
  const clock = rotationClock(t);
  const pending = consume(f.model());
  await settledIo(() => f.requests() === 1 && f.clean());
  writeFileSync(f.file, '{"claudeAiOauth":');
  clock.tick(1000);
  await immediate();
  assert.equal(f.requests(), 1);
  rmSync(f.file);
  clock.tick(1000);
  await immediate();
  assert.equal(f.requests(), 1);
  mkdirSync(f.file);
  clock.tick(1000);
  await immediate();
  assert.equal(f.requests(), 1);
  rmSync(f.file, { recursive: true });
  writeFileSync(f.file, '{"claudeAiOauth":{"accessToken":"synthetic-B"}}');
  clock.tick(1000);
  assert.equal((await pending).error, undefined);
  assert.equal(f.requests(), 2);
});

test("rotation parser and first-step guard properties (seed 20261026)", async (t) => {
  const f = await fixture(t);
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.boolean(),
      (accessToken, refresh) => {
        fc.pre(accessToken.trim().length > 0);
        writeFileSync(
          f.file,
          JSON.stringify({
            claudeAiOauth: {
              accessToken,
              ...(refresh ? { refreshToken: "synthetic-refresh" } : {}),
            },
          }),
        );
        const snapshot = readClaudeAuthSnapshot();
        assert.match(snapshot.fingerprint ?? "", /^[a-f0-9]{64}$/u);
        assert.equal(snapshot.source, refresh ? "refresh" : "external");
        assert.deepEqual(Object.keys(snapshot).sort(), [
          "fingerprint",
          "source",
        ]);
      },
    ),
    { seed: 20261026, numRuns: 60 },
  );
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (step) => {
      assert.equal(
        claudeAuthReplaySafe(TOOL_HISTORY, { turnId: "current", step }),
        false,
      );
      assert.equal(claudeAuthReplaySafe(TOOL_HISTORY), false);
      assert.equal(
        claudeAuthReplaySafe(TOOL_HISTORY, { turnId: "new", step: 0 }),
        true,
      );
    }),
    { seed: 20261026, numRuns: 40 },
  );
  for (const value of [null, -1, 0.5, "120000", 2 ** 31]) {
    writeFileSync(
      join(f.data, "settings.json"),
      JSON.stringify({ claude: { authRotationWaitMs: value } }),
    );
    assert.equal(claudeAuthRotationWaitMs(), CLAUDE_AUTH_ROTATION_WAIT_MS);
  }
  writeFileSync(
    join(f.data, "settings.json"),
    '{"claude":{"authRotationWaitMs":0}}',
  );
  assert.equal(claudeAuthRotationWaitMs(), 0);
});

test("rotation RED: normalised access-only auth errors use the shared RU/EN synchronization text", async (t) => {
  await fixture(t);
  const result = humanizeProviderError({
    message: "ClaudeCliError: HTTP 401",
    provider: "claude",
  });
  assert.doesNotMatch(result.ru + result.en, /claude auth login/u);
  assert.match(result.ru, /извне|внешн/iu);
  assert.match(result.en, /external|sync/iu);
  for (const lang of ["ru", "en"] as const)
    assert.doesNotMatch(
      modelAuthText("claude", lang),
      /synthetic-[AB]|synthetic-refresh/u,
    );
});

test("rotation control: refresh installations retain login instructions", async (t) => {
  await fixture(t, { refresh: true });
  assert.match(modelAuthText("claude", "ru"), /claude auth login/u);
  assert.match(modelAuthText("claude", "en"), /claude auth login/u);
});
