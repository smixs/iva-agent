// Хук журнала (agent/hooks/trace.ts) на фейковых событиях eve: что попадает в строку, что
// отбрасывается и как выглядит ход субагента. Проверка идёт по РЕАЛЬНЫМ формам событий из
// node_modules/eve/dist/src/protocol/message.d.ts.
//
// Тест лежит в agent/lib, а не рядом с хуком: eve считает хуком КАЖДЫЙ файл в agent/hooks,
// и «trace.test» — нелегальное имя хука, из-за которого падает вся discovery (`eve build`:
// «Hook path segment "trace.test" is not a legal hook name»). Поэтому во всех слотах
// authored-дерева (hooks, channels, instructions, schedules, tools) тестов нет вовсе.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";

const root = mkdtempSync(join(tmpdir(), "iva-trace-hook-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const DATA = process.env.ASSISTANT_DATA_DIR;
// Хук импортирует "../lib/trace.js" (в проде специфкатор переписывает eve build) —
// голому node это переписывает тот же резолвер, что и другим тестам authored-дерева.
await import("../../scripts/lib/ts-esm-hooks.ts");
const {
  traceDay,
  traceFilePath,
  TRACE_CONTENT_LIMIT,
  TRACE_LINE_LIMIT,
  TRACE_TRUNCATION_MARKER,
} = await import("./trace.ts");
const { getChatStatus, hasTelegramPendingInputRequests, setChatStatus } =
  await import("./run-status.ts");
const { REDACTED } = await import("../../packages/secret-redaction/index.ts");
const { SECRET_ARGUMENTS } = await import("../connections/telegram-userbot.ts");
const traceHookModule = await import("../hooks/trace.ts");
const hook = traceHookModule.default;
const {
  createTelegramReplayRetirementObserver,
  TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS,
} = traceHookModule;

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handle = hook.events?.["*"] as unknown as Handler;

const ctx = {
  session: { id: "wrun_7", turn: { id: "turn_3", sequence: 3 }, auth: {} },
  channel: { kind: "channel:telegram" },
};

void test("Telegram fixture matches the channel kind built by installed eve", () => {
  const eveRoot = dirname(
    createRequire(import.meta.url).resolve("eve/package.json"),
  );
  const source = readFileSync(
    join(eveRoot, "dist/src/runtime/resolve-channel.js"),
    "utf8",
  );
  const template = /`channel:\$\{[^}]+\.name\}`/.exec(source)?.[0];
  assert.ok(
    template,
    "eve no longer derives authored channel kinds from channel:<name>",
  );
  const installedKind = template
    .slice(1, -1)
    .replace(/\$\{[^}]+\}/, "telegram");
  assert.equal(ctx.channel.kind, installedKind);
});

function feed(event: unknown, context: unknown = ctx): void {
  handle(event, context);
}

function journal(): Record<string, unknown>[] {
  return readFileSync(traceFilePath(traceDay(), DATA), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function only(name: string): Record<string, unknown>[] {
  return journal().filter((event) => event.name === name);
}

void test("шаг модели, вызов тула и ответ ложатся отдельными событиями", () => {
  feed({ type: "turn.started", data: { sequence: 1, turnId: "turn_3" } });
  feed({
    type: "step.started",
    data: { sequence: 2, stepIndex: 0, turnId: "turn_3" },
  });
  feed({
    type: "actions.requested",
    data: {
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
      actions: [
        {
          kind: "tool-call",
          callId: "call_1",
          toolName: "memory_search",
          input: { query: "что я говорил про отпуск" },
        },
      ],
    },
  });
  feed({
    type: "action.result",
    data: {
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_3",
      status: "completed",
      result: {
        callId: "call_1",
        kind: "tool-result",
        toolName: "memory_search",
        output: "3 карточки",
      },
    },
  });
  feed({
    type: "step.completed",
    data: {
      sequence: 5,
      stepIndex: 1,
      turnId: "turn_3",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
    },
  });
  feed({
    type: "message.completed",
    data: {
      sequence: 6,
      stepIndex: 1,
      turnId: "turn_3",
      finishReason: "stop",
      message: "в июле",
    },
  });
  feed({ type: "turn.completed", data: { sequence: 7, turnId: "turn_3" } });

  const events = journal();
  assert.deepEqual(
    events.map((event) => event.name),
    [
      "turn.started",
      "step.started",
      "actions.requested",
      "action.result",
      "step.completed",
      "message.completed",
      "turn.completed",
    ],
  );
  for (const event of events) {
    assert.equal(event.kind, "eve");
    assert.equal(event.turn, "turn_3");
    assert.equal(event.session, "wrun_7");
    assert.equal(event.source, "channel:telegram");
  }

  const [requested] = only("actions.requested");
  assert.deepEqual(requested.data, {
    sequence: 3,
    stepIndex: 0,
    actions: [
      { kind: "tool-call", callId: "call_1", toolName: "memory_search" },
    ],
    args: [{ query: "что я говорил про отпуск" }],
  });
});

void test("расход и содержимое шага пишутся с потолком", () => {
  const [step] = only("step.completed");
  assert.deepEqual(step.data, {
    sequence: 5,
    stepIndex: 1,
    finishReason: "stop",
    usage: { in: 120, out: 30, cacheRead: 10, cacheWrite: 0 },
  });
  const [message] = only("message.completed");
  assert.deepEqual(message.data, {
    sequence: 6,
    stepIndex: 1,
    finishReason: "stop",
    messageChars: 6,
    message: "в июле",
  });
  const [result] = only("action.result");
  assert.equal(
    (result.data as Record<string, unknown>).toolName,
    "memory_search",
  );
  assert.equal((result.data as Record<string, unknown>).status, "completed");
});

void test("дельта-события в журнал не попадают", () => {
  const before = journal().length;
  feed({
    type: "message.appended",
    data: { messageDelta: "в", turnId: "turn_3" },
  });
  feed({
    type: "reasoning.appended",
    data: { reasoningDelta: "…", turnId: "turn_3" },
  });
  feed({
    type: "action.partial",
    data: { result: { output: "частично" }, turnId: "turn_3" },
  });
  feed({
    type: "action.input.appended",
    data: { inputTextDelta: "{", turnId: "turn_3" },
  });
  assert.equal(journal().length, before);
});

void test("шаги субагента пишутся ключом хода родителя с суффиксом", () => {
  feed({
    type: "subagent.event",
    data: {
      callId: "call_9",
      subagentName: "planner",
      event: {
        type: "step.completed",
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_0",
          finishReason: "stop",
          usage: { inputTokens: 40, outputTokens: 5 },
        },
      },
    },
  });

  const nested = journal().at(-1);
  assert.equal(nested?.name, "step.completed");
  assert.equal(nested?.turn, "turn_3#planner");
  assert.equal(nested?.session, "wrun_7");
  assert.deepEqual(nested?.data, {
    sequence: 1,
    stepIndex: 0,
    finishReason: "stop",
    usage: { in: 40, out: 5, cacheRead: 0, cacheWrite: 0 },
    subagent: "planner",
    parentCallId: "call_9",
  });
});

void test("ход без turnId в событии берёт ход из сессии", () => {
  feed({ type: "session.waiting", data: { sessionId: "wrun_7" } });
  const waiting = journal().at(-1);
  assert.equal(waiting?.turn, "turn_3");

  feed(
    { type: "session.started", data: {} },
    {
      session: { id: "wrun_8", turn: { id: "", sequence: 0 }, auth: {} },
      channel: {},
    },
  );
  const started = journal().at(-1);
  assert.equal(started?.turn, "turn_0");
  assert.equal(started?.source, "unknown");
});

void test("сбой хода пишется кодом в data и текстом в содержимом", () => {
  feed({
    type: "turn.failed",
    data: {
      sequence: 9,
      turnId: "turn_3",
      code: "MODEL_ERROR",
      message: "provider refused",
      details: { status: 503 },
    },
  });
  const failed = journal().at(-1);
  assert.deepEqual(failed?.data, {
    sequence: 9,
    code: "MODEL_ERROR",
    messageChars: 16,
    message: "provider refused",
    details: { status: 503 },
  });
});

// Error id в чат больше не идёт: найти сбой владельцу и разработчику помогает журнал, поэтому
// id и число запросов к модели лежат в data и без тумблера содержимого.
void test("Error id, попытки и обрыв посреди ответа лежат в data даже без содержимого", (t) => {
  const settings = join(DATA, "settings.json");
  writeFileSync(settings, JSON.stringify({ captureContent: false }));
  t.after(() => rmSync(settings, { force: true }));
  feed({
    type: "turn.failed",
    data: {
      sequence: 10,
      turnId: "turn_3",
      code: "MODEL_CALL_FAILED",
      message: "api.anthropic.com did not finish the response",
      details: { errorId: "e-1", attempts: 3, answerStarted: true },
    },
  });
  const failed = journal().at(-1);
  const data = failed?.data as Record<string, unknown> | undefined;
  assert.equal(data?.errorId, "e-1");
  assert.equal(data?.attempts, 3);
  assert.equal(data?.answerStarted, true);
  assert.equal(failed?.content, undefined);
});

// specs/UserbotLogin.tla, NoSecretLeaves: вызов qr_login_password пишется до ответа
// прокси, и пароль двухфакторной защиты лежит в его аргументах.
void test("секретный аргумент пишется меткой при включённом содержимом NoSecretLeaves", () => {
  const password = "two-factor-password-not-for-disk";
  feed({
    type: "actions.requested",
    data: {
      sequence: 5,
      stepIndex: 1,
      turnId: "turn_3",
      actions: [
        {
          kind: "tool-call",
          callId: "call_pw",
          toolName: "telegram-userbot__qr_login_password",
          input: { password },
        },
        {
          kind: "tool-call",
          callId: "call_q",
          toolName: "memory_search",
          input: { query: "отпуск" },
        },
      ],
    },
  });
  const text = readFileSync(traceFilePath(traceDay(), DATA), "utf8");
  assert.ok(!text.includes(password), "the password reached the journal");
  const data = journal().at(-1)?.data as Record<string, unknown>;
  assert.deepEqual(data.args, [{ password: REDACTED }, { query: "отпуск" }]);
  assert.deepEqual(
    (data.actions as Record<string, unknown>[]).map((a) => a.toolName),
    ["telegram-userbot__qr_login_password", "memory_search"],
  );
});

void test("каждый параметр qr_login_password назван секретом NoSecretLeaves", () => {
  const source = readFileSync(
    new URL("../../services/telegram-userbot/onboarding.py", import.meta.url),
    "utf8",
  );
  const signature = /async def qr_login_password\((.*)\)\s*->/u.exec(
    source,
  )?.[1];
  assert.ok(signature, "onboarding.py no longer defines qr_login_password");
  const names = [...signature.matchAll(/(?:^|,)\s*(\w+)\s*:/gu)].map(
    (m) => m[1],
  );
  assert.deepEqual(names, ["password"]);
  for (const name of names) assert.ok(SECRET_ARGUMENTS.includes(name), name);
});

void test("captureContent=false оставляет от события имена, класс сбоя и размеры", (t) => {
  const settings = join(DATA, "settings.json");
  writeFileSync(settings, JSON.stringify({ captureContent: false }));
  t.after(() => rmSync(settings, { force: true }));
  const output = {
    stdout: "",
    stderr: "секрет в выводе\n",
    exitCode: 2,
    cwd: "/srv",
  };

  feed({
    type: "action.result",
    data: {
      sequence: 10,
      stepIndex: 2,
      turnId: "turn_3",
      status: "completed",
      result: {
        callId: "call_2",
        kind: "tool-result",
        toolName: "bash",
        output,
      },
    },
  });

  const event = journal().at(-1);
  assert.deepEqual(event?.data, {
    sequence: 10,
    stepIndex: 2,
    status: "completed",
    callId: "call_2",
    toolName: "bash",
    exitCode: 2,
    failure: "exit 2",
    outChars: JSON.stringify(output).length,
    resultChars: JSON.stringify({
      exitCode: 2,
      stderr: output.stderr,
      stdout: "",
      cwd: "/srv",
    }).length,
  });
  assert.equal(JSON.stringify(event).includes("секрет"), false);
});

// --- Результат инструмента: строка JSON и класс сбоя (docs/trace.md, `failure`) ---

type ResultEvent = { type: string; data: Record<string, unknown> };
// Формы событий — из настоящего eve: статус и error ставит его createActionResultEvent.
const eveRoot = dirname(
  createRequire(import.meta.url).resolve("eve/package.json"),
);
const { createActionResultEvent } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/protocol/message.js")).href
)) as {
  createActionResultEvent: (input: {
    result: Record<string, unknown>;
    sequence: number;
    stepIndex: number;
    turnId: string;
    rejected?: boolean;
  }) => ResultEvent;
};

function written(
  output: unknown,
  extra: { isError?: boolean; rejected?: boolean } = {},
): Record<string, unknown> {
  feed(
    createActionResultEvent({
      result: {
        callId: "call_r",
        toolName: "bash",
        output,
        ...(extra.isError ? { isError: true } : {}),
      },
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_3",
      rejected: extra.rejected,
    }),
  );
  return journal().at(-1)?.data as Record<string, unknown>;
}

const bash = (fields: Record<string, unknown>) => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  cwd: "/srv",
  ...fields,
});

void test("класс сбоя вызова — по таблице хука, первое сработавшее условие", () => {
  const cases: [string, unknown, Parameters<typeof written>[1], unknown][] = [
    ["ответ помечен isError", "boom", { isError: true }, "isError"],
    [
      "isError в самом ответе (MCP)",
      { content: [{ type: "text", text: "x" }], isError: true },
      {},
      "isError",
    ],
    [
      "ответ назвал code и message",
      { code: "E_X", message: "bad" },
      {},
      "status:failed",
    ],
    ["ok:false", { ok: false, reason: "no" }, {}, "ok:false"],
    ["error объектом", { error: { message: "m" } }, {}, "error"],
    ["error из пробелов — не сбой", { error: "  " }, {}, undefined],
    ["таймаут", bash({ timedOut: true, exitCode: 124 }), {}, "timeout"],
    [
      "код выхода со stderr",
      bash({ exitCode: 2, stderr: "ls: No such file\n" }),
      {},
      "exit 2",
    ],
    [
      "grep с кодом 1 и пустым stderr",
      bash({ exitCode: 1, stderr: " \n" }),
      {},
      undefined,
    ],
    [
      "Стоп владельца",
      bash({ exitCode: 1, stderr: "killed", cancelled: true }),
      {},
      undefined,
    ],
    ["отказ на подтверждении", { ok: false }, { rejected: true }, undefined],
    ["обычный ответ", "3 карточки", {}, undefined],
  ];
  for (const [label, output, extra, failure] of cases)
    assert.equal(written(output, extra).failure, failure, label);
  assert.equal(
    written("boom", { isError: true }).errorCode,
    "ACTION_RESULT_FAILED",
  );
  assert.equal(written({ code: "E_X", message: "bad" }).errorCode, "E_X");
  assert.equal(written({ ok: false }, { rejected: true }).status, "rejected");
});

void test("ответ пишется строкой JSON: без …[deep], с ключами сбоя в начале", () => {
  const deep = {
    ok: true,
    hits: [{ card: { meta: { tags: { a: { b: "глубоко" } } } } }],
  };
  const memory = written(deep);
  assert.equal(memory.result, JSON.stringify(deep));
  assert.equal(memory.outChars, JSON.stringify(deep).length);

  const long = { data: "x".repeat(10_000), error: "late" };
  const answer = written(long);
  assert.ok(String(answer.result).startsWith('{"error":"late","data":"xxx'));
  assert.ok(String(answer.result).endsWith(TRACE_TRUNCATION_MARKER));
  assert.equal(answer.outChars, JSON.stringify(long).length);
});

void test("у bash хранится конец вывода, код и stderr — в начале", () => {
  const stdout = `${Array.from({ length: 8000 }, (_, at) => String(at + 1)).join("\n")}\n`;
  assert.ok(stdout.length > 38_000);
  const output = bash({ stdout, stderr: "warn\n", truncated: true });
  const data = written(output);
  const result = String(data.result);
  assert.ok(result.length <= TRACE_CONTENT_LIMIT);
  assert.ok(
    result.startsWith(
      '{"exitCode":0,"truncated":true,"stderr":"warn\\n","stdout":',
    ),
  );
  const parsed = JSON.parse(result) as Record<string, string>;
  assert.ok(parsed.stdout.startsWith(TRACE_TRUNCATION_MARKER));
  assert.ok(parsed.stdout.endsWith("\n7999\n8000\n"));
  assert.ok(
    stdout.endsWith(parsed.stdout.slice(TRACE_TRUNCATION_MARKER.length)),
  );
  assert.equal(parsed.cwd, "/srv");
  assert.equal(data.outChars, JSON.stringify(output).length);
  assert.equal(data.exitCode, 0);
});

void test("error, равный ответу, второй копией не пишется", () => {
  assert.equal("error" in written("boom", { isError: true }), false);
  assert.equal("error" in written({ x: 1 }, { isError: true }), false);
  const own = written({ code: "E_X", message: "своя причина", x: 1 });
  assert.equal(own.error, "своя причина");
});

void test("у ответа load_skill и субагента в data остаётся, чей это вызов", () => {
  const event = (result: Record<string, unknown>) => {
    feed(
      createActionResultEvent({
        result,
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_3",
      }),
    );
    return journal().at(-1)?.data as Record<string, unknown>;
  };
  const skill = event({
    callId: "c9",
    kind: "load-skill-result",
    name: "insgiht",
    isError: true,
    output: "Skill not found",
  });
  assert.equal(skill.name, "insgiht");
  assert.equal(skill.failure, "isError");
  const child = event({
    callId: "c10",
    kind: "subagent-result",
    origin: "dispatch",
    subagentName: "researcher",
    isError: true,
    output: "no such agent",
  });
  assert.equal(child.subagentName, "researcher");
  assert.equal(child.failure, "isError");
});

void test("строковый ответ с JSON-ошибкой внутри помечается, как его видит сторож повторов", () => {
  assert.equal(
    written(JSON.stringify({ ok: false, error: "quota" })).failure,
    "ok:false",
  );
  assert.equal(
    written(` ${JSON.stringify({ error: "denied" })}\n`).failure,
    "error",
  );
  assert.equal(written('{"ok":true}').failure, undefined);
  assert.equal(written("{не JSON").failure, undefined);
});

void test("stderr, который влезает в поле, пишется целиком; огромный cwd не метит пустой stdout", () => {
  const trace = `Traceback (most recent call last):\n${'  File "x.py", line 1\n'.repeat(140)}ValueError: boom\n`;
  assert.ok(trace.length > 3000);
  const whole = JSON.parse(
    String(written(bash({ exitCode: 1, stderr: trace })).result),
  ) as Record<string, string>;
  assert.equal(whole.stderr, trace);

  // Поле дорежет писатель с конца, поэтому строка уже не JSON: смотрим на её начало.
  const wide = String(
    written(bash({ exitCode: 1, stderr: "e\n", cwd: "d".repeat(5000) })).result,
  );
  assert.ok(
    wide.startsWith('{"exitCode":1,"stderr":"e\\n","stdout":"","cwd":"ddd'),
    wide.slice(0, 80),
  );
});

void test("эмодзи в хвосте bash стоят столько, сколько занимают в JSON", () => {
  const stdout = "😀\u0000\n".repeat(12_000);
  const result = String(written(bash({ exitCode: 0, stdout })).result);
  assert.ok(result.length <= TRACE_CONTENT_LIMIT);
  assert.ok(
    result.length > TRACE_CONTENT_LIMIT - 20,
    `хвост занял ${result.length} из ${TRACE_CONTENT_LIMIT}`,
  );
});

void test("ответ, который не сериализуется, идёт прежним путём и ход не падает", () => {
  const cycle: Record<string, unknown> = { name: "cycle" };
  cycle.self = cycle;
  const looped = written(cycle);
  assert.equal(looped.toolName, "bash");
  assert.equal(typeof looped.result, "object");
  assert.equal("outChars" in looped, false);

  const poisoned = written({
    toJSON() {
      throw new Error("toJSON");
    },
  });
  assert.equal(poisoned.toolName, "bash");
});

const FAILURE_CLASS =
  /^(isError|status:failed|ok:false|error|timeout|exit -?\d+)$/u;
const HOOK_PBT_SEED = 2_610_060_412;
void test(`любой ответ: хук не бросает, класс сбоя из списка (fast-check seed ${HOOK_PBT_SEED})`, () => {
  const output = fc.oneof(
    fc.anything({ maxDepth: 4 }),
    fc.record({
      stdout: fc.string(),
      stderr: fc.string(),
      exitCode: fc.integer({ min: -2, max: 255 }),
      cwd: fc.string(),
      cancelled: fc.boolean(),
      timedOut: fc.boolean(),
    }),
  );
  fc.assert(
    fc.property(
      output,
      fc.constantFrom("completed", "failed", "rejected"),
      (value, status) => {
        feed({
          type: "action.result",
          data: {
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_3",
            status,
            result: { callId: "c", toolName: "t", output: value },
          },
        });
        const raw = readFileSync(traceFilePath(traceDay(), DATA), "utf8")
          .trimEnd()
          .split("\n")
          .at(-1);
        assert.ok(Buffer.byteLength(raw ?? "", "utf8") <= TRACE_LINE_LIMIT);
        const data = (
          JSON.parse(raw ?? "") as { data: Record<string, unknown> }
        ).data;
        assert.equal(data.toolName, "t");
        if (data.failure !== undefined) {
          assert.equal(typeof data.failure, "string");
          assert.match(data.failure as string, FAILURE_CLASS);
        }
      },
    ),
    { seed: HOOK_PBT_SEED, numRuns: 200 },
  );
});

const TAIL_PBT_SEED = 2_610_060_413;
void test(`хвост bash: поле не длиннее размера, код цел, stdout — суффикс (fast-check seed ${TAIL_PBT_SEED})`, () => {
  const stream = fc.oneof(
    fc.string({ unit: "grapheme", maxLength: 3000 }),
    fc.string({ unit: "binary", maxLength: 2000 }),
    fc
      .tuple(
        fc.integer({ min: 1, max: 12_000 }),
        fc.constantFrom("я", "\n", "\u0000", "🙂", "\ud800"),
      )
      .map(([size, unit]) => unit.repeat(size)),
  );
  fc.assert(
    fc.property(
      stream,
      stream,
      fc.integer({ min: -1, max: 255 }),
      (stdout, stderr, exitCode) => {
        const result = String(
          written(bash({ stdout, stderr, exitCode })).result,
        );
        assert.ok(result.length <= TRACE_CONTENT_LIMIT);
        const parsed = JSON.parse(result) as Record<string, unknown>;
        assert.equal(parsed.exitCode, exitCode);
        const kept = String(parsed.stdout);
        assert.ok(
          stdout.endsWith(
            kept.startsWith(TRACE_TRUNCATION_MARKER) && kept !== stdout
              ? kept.slice(TRACE_TRUNCATION_MARKER.length)
              : kept,
          ),
        );
      },
    ),
    { seed: TAIL_PBT_SEED, numRuns: 100 },
  );
});

void test("хук не роняет ход ни на каком событии", (t) => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  t.after(() => {
    console.error = original;
  });
  const before = journal().length;

  const hostile: [string, unknown, unknown][] = [
    // Чужой геттер в payload.
    [
      "throwing getter",
      {
        type: "action.result",
        data: {
          get result(): unknown {
            throw new Error("getter");
          },
        },
      },
      ctx,
    ],
    // subagent.event без вложенного события.
    [
      "subagent without event",
      { type: "subagent.event", data: { callId: "c", subagentName: "p" } },
      ctx,
    ],
    ["subagent without data", { type: "subagent.event" }, ctx],
    // Контекст без канала и без сессии.
    [
      "context without channel",
      { type: "turn.started", data: { turnId: "turn_1" } },
      { session: { id: "wrun_1", turn: { id: "turn_1" } } },
    ],
    ["empty context", { type: "turn.started", data: { turnId: "turn_1" } }, {}],
    // Событие без данных вовсе.
    ["event without data", { type: "turn.completed" }, ctx],
    ["no event at all", null, ctx],
  ];

  for (const [label, event, context] of hostile) {
    assert.doesNotThrow(() => feed(event, context), label);
  }
  // Что смогло — записано, что не смогло — объяснено в логе службы, ход жив.
  assert.ok(journal().length >= before);
  for (const line of journal()) assert.equal(typeof line.kind, "string");
});

void test("медленный Telegram replay помечает сессию, HTTP и быстрый replay — нет", () => {
  let now = 1_000;
  const marked: Array<{
    replayMs: number;
    sessionId: string;
    turnId: string;
  }> = [];
  const observe = createTelegramReplayRetirementObserver({
    now: () => now,
    markImpl: (sessionId, turnId, replayMs) => {
      marked.push({ replayMs, sessionId, turnId });
      return true;
    },
  });
  const telegramContext = (sessionId: string) => ({
    session: { id: sessionId, turn: { id: "turn_1", sequence: 1 } },
    channel: { kind: "channel:telegram" },
  });

  observe(
    { type: "turn.started", data: { sequence: 0, turnId: "turn_base" } },
    telegramContext("session-slow"),
  );
  now += 1_000;
  observe(
    {
      type: "message.received",
      data: { message: "base", sequence: 0, turnId: "turn_base" },
    },
    telegramContext("session-slow"),
  );

  observe(
    { type: "turn.started", data: { sequence: 1, turnId: "turn_slow" } },
    telegramContext("session-slow"),
  );
  now += TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS + 1;
  observe(
    {
      type: "message.received",
      data: { message: "slow", sequence: 1, turnId: "turn_slow" },
    },
    telegramContext("session-slow"),
  );

  now = 100_000;
  observe(
    { type: "turn.started", data: { sequence: 1, turnId: "turn_fast" } },
    telegramContext("session-fast"),
  );
  now += TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS;
  observe(
    {
      type: "message.received",
      data: { message: "fast", sequence: 2, turnId: "turn_fast" },
    },
    telegramContext("session-fast"),
  );

  now = 200_000;
  observe(
    { type: "turn.started", data: { sequence: 1, turnId: "turn-http" } },
    {
      session: { id: "session-http" },
      channel: { kind: "http" },
    },
  );
  now += TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS + 1;
  observe(
    {
      type: "message.received",
      data: { message: "slow", sequence: 2, turnId: "turn-http" },
    },
    {
      session: { id: "session-http" },
      channel: { kind: "http" },
    },
  );
  assert.deepEqual(marked, [
    {
      replayMs: TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS + 1,
      sessionId: "session-slow",
      turnId: "turn_slow",
    },
  ]);
});

function replayMarks(
  replays: readonly number[],
  sessionId: string,
  firstSequence = 0,
) {
  let now = 0;
  const marked: Array<{ replayMs: number; turnId: string }> = [];
  const observe = createTelegramReplayRetirementObserver({
    now: () => now,
    markImpl: (_sessionId, turnId, replayMs) => {
      if (marked.length > 0) return false;
      marked.push({ replayMs, turnId });
      return true;
    },
  });
  const context = {
    session: { id: sessionId },
    channel: { kind: "channel:telegram" },
  };

  for (const [index, replayMs] of replays.entries()) {
    const sequence = firstSequence + index;
    const turnId = `turn_${sequence}`;
    observe({ type: "turn.started", data: { sequence, turnId } }, context);
    now += replayMs;
    observe({ type: "message.received", data: { sequence, turnId } }, context);
  }

  return marked;
}

void test("первая видимая после рестарта sequence 7 помечается по абсолютному порогу", () => {
  assert.deepEqual(replayMarks([400_000], "restarted-session", 7), [
    { replayMs: 400_000, turnId: "turn_7" },
  ]);
});

void test("трасса Станислава помечает сессию впервые на turn_6", () => {
  assert.deepEqual(
    replayMarks(
      [33, 18, 14, 7, 23, 26, 73, 146, 93, 143, 427].map(
        (seconds) => seconds * 1_000,
      ),
      "stan-session",
    ),
    [{ replayMs: 73_000, turnId: "turn_6" }],
  );
});

void test("трасса Артёма помечает сессию на replay 87 секунд", () => {
  assert.deepEqual(replayMarks([2_000, 3_000, 87_000], "art-session"), [
    { replayMs: 87_000, turnId: "turn_2" },
  ]);
});

void test("ровный replay 40 секунд не создаёт цикл retire", () => {
  assert.deepEqual(
    replayMarks([40_000, 40_000, 40_000, 40_000], "flat-session"),
    [],
  );
});

const REPLAY_GROWTH_PBT_SEED = 2_609_040_906;
void test(`retire зависит от роста replay (fast-check seed ${REPLAY_GROWTH_PBT_SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_000 })),
      fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
        minLength: 1,
        maxLength: 20,
      }),
      (firstSequence, replays) => {
        const marks = replayMarks(replays, "property-session", firstSequence);
        const boundary =
          firstSequence === 0
            ? Math.max(TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS, 2 * replays[0])
            : TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS;
        const markedIndex = replays.findIndex(
          (replayMs, index) =>
            !(firstSequence === 0 && index === 0) && replayMs > boundary,
        );
        assert.deepEqual(
          marks,
          markedIndex === -1
            ? []
            : [
                {
                  replayMs: replays[markedIndex],
                  turnId: `turn_${firstSequence + markedIndex}`,
                },
              ],
        );
      },
    ),
    { seed: REPLAY_GROWTH_PBT_SEED, numRuns: 250 },
  );
});

void test("replay retirement threshold defaults to 30000 and rejects invalid env", () => {
  assert.equal(TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS, 30_000);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/lib/ts-esm-hooks.ts",
      "--input-type=module",
      "--eval",
      'import("./agent/hooks/trace.ts")',
    ],
    {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS: "abc",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TELEGRAM_REPLAY_RETIRE_THRESHOLD_MS/);
});

void test("Telegram input.requested и input.resolved держат pending-состояние без стрима", () => {
  const chatKey = "pending:";
  const sessionId = "session-pending";
  const context = {
    session: { id: sessionId, turn: { id: "turn_pending", sequence: 1 } },
    channel: { kind: "channel:telegram" },
  };
  setChatStatus(chatKey, {
    status: "running",
    sessionId,
    turnId: "turn_pending",
  });

  feed(
    {
      type: "input.requested",
      data: { requests: [{ requestId: "request-1" }], turnId: "turn_pending" },
    },
    context,
  );
  assert.equal(hasTelegramPendingInputRequests(chatKey, sessionId), true);
  assert.equal(
    hasTelegramPendingInputRequests(chatKey, "replacement-session"),
    false,
  );

  setChatStatus(chatKey, { status: "idle", sessionId: null, turnId: null });
  feed(
    {
      type: "input.resolved",
      data: {
        resolutions: [{ requestId: "request-1" }],
        turnId: "turn_pending",
      },
    },
    context,
  );
  assert.equal(hasTelegramPendingInputRequests(chatKey, sessionId), false);
  assert.equal(getChatStatus(chatKey)?.pendingInputSessionId, undefined);
});
