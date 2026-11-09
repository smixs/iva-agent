/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
// Вендор claude без ключа: единственный источник входа — чужой CLI на той же машине.
// Здесь проверяется вся работа с ним: статус, живой список моделей и живая проба.
// CLI подменён скриптом с тем же контрактом, что у настоящего: `auth status` отвечает
// JSON, рукопожатие initialize — пикером, проба — потоком stream-json.
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { claudeConflicts, claudeEffort, claudeModel } from "#lib/claude-cli.ts";
import { CANONICAL_REASONING_EFFORTS } from "./reasoning-levels.ts";
import {
  claudeBinary,
  claudeContextWindow,
  claudeModelLabel,
  claudeReasoningLevels,
  claudeStatus,
  ClaudeCliError,
  firstConflict,
  listClaudeModels,
  probeClaudeModel,
} from "./claude-cli-status.ts";

const tempRoots: string[] = [];
test.after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function scratch(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `iva-${prefix}-`));
  tempRoots.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Поведение подставного CLI: режим читается из FAKE_CLAUDE, ответы — из соседних переменных. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const mode = process.env.FAKE_CLAUDE ?? "auth";
const args = process.argv.slice(2);
const write = (line) => process.stdout.write(line + "\\n");
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: args, extra: process.env.CLAUDE_CODE_EXTRA_BODY ?? null }) + "\\n");
}
// Статус спрашивают у того же бинаря в любом режиме: у настоящего CLI так же.
if (args[0] === "auth") {
  // Выходим по факту сброса ответа: process.exit сразу после write обрывает его в пайпе.
  process.stdout.write(process.env.FAKE_CLAUDE_AUTH ?? '{"loggedIn":true,"subscriptionType":"max"}', () => process.exit(0));
}
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
if (mode === "handshake") {
  process.stdin.on("end", () => {
    if (!input.includes("initialize")) { write("no handshake"); process.exitCode = 1; return; }
    if (process.env.FAKE_CLAUDE_PICKER) { write(process.env.FAKE_CLAUDE_PICKER); return; }
    write("not json at all");
    const picker = (models) => JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "iva-picker", response: { models } },
    });
    write(picker([
      { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)" },
      { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)" },
      { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
      { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
      { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
      { value: "anonymous", displayName: "no resolved model" },
    ]));
  });
}
if (mode === "probe-success") {
  process.stdin.on("end", () => {
    write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "pong" }] } }));
    write(JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }));
  });
}
if (mode === "probe-tool") {
  process.stdin.on("end", () => {
    write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__iva__ping", input: {} }] } }));
    write(JSON.stringify({ type: "result", subtype: "error_max_turns", num_turns: 2, is_error: true }));
    process.exitCode = 1;
  });
}
if (mode === "probe-error") {
  process.stdin.on("end", () => {
    write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "API Error: 500" }] }, is_error: true }));
    write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 500 upstream" }));
    process.exitCode = 1;
  });
}
if (mode === "silent") {
  // Ни одного события: проверяется сторож тишины, а не ответ CLI.
  setInterval(() => {}, 1000);
}
`;

/** Подставной CLI в PATH-виде: `CLAUDE_COMMAND` → этот файл. */
function fakeClaude(t: TestContext): string {
  const dir = scratch(t, "fake-claude");
  const file = join(dir, "claude");
  writeFileSync(file, FAKE_CLAUDE);
  chmodSync(file, 0o755);
  return file;
}

const envWith = (
  t: TestContext,
  mode: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...process.env,
  CLAUDE_COMMAND: fakeClaude(t),
  FAKE_CLAUDE: mode,
  ...extra,
});

const loggedIn = '{"loggedIn":true,"subscriptionType":"max"}';

test("the CLI status comes from its own auth status, plan included", async (t) => {
  const status = await claudeStatus(envWith(t, "auth"));
  assert.equal(status.installed, true);
  assert.equal(status.loggedIn, true);
  assert.equal(status.plan, "max");
  assert.equal(status.ready, true);
  assert.equal(status.hint, "");
});

test("a logged-out CLI is told from a missing one, each with its own command", async (t) => {
  const out = await claudeStatus(
    envWith(t, "auth", { FAKE_CLAUDE_AUTH: "{}" }),
  );
  assert.equal(out.installed, true);
  assert.equal(out.loggedIn, false);
  assert.equal(out.ready, false);
  assert.match(out.hint, /claude auth login/u);

  // Мусор вместо JSON — тот же ответ «входа нет»: выдумывать план по нечитаемому выводу нельзя.
  const garbage = await claudeStatus(
    envWith(t, "auth", { FAKE_CLAUDE_AUTH: "not json" }),
  );
  assert.equal(garbage.loggedIn, false);

  // Пустой HOME: `claude` нет нигде в PATH сервиса, и отказ называет этот PATH.
  const home = scratch(t, "empty-home");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
  });
  const missing = await claudeStatus({});
  assert.equal(missing.installed, false);
  assert.equal(missing.ready, false);
  assert.match(
    missing.hint,
    /npm install -g --prefix ~\/\.local @anthropic-ai\/claude-code/u,
  );
  assert.ok(missing.hint.includes(`${home}/.local/bin`), missing.hint);

  const broken = await claudeStatus({ CLAUDE_COMMAND: "/nonexistent/claude" });
  assert.equal(broken.installed, false);
  assert.match(
    broken.hint,
    /^CLAUDE_COMMAND=\/nonexistent\/claude is not found or not executable \(PATH: /u,
  );
});

// Чужая авторизация в окружении увела бы подписку на чужой счёт. Имя переменной
// называется, значение — нет: в нём секрет.
test("a foreign auth variable makes the vendor unusable and is named, not printed", async (t) => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_SOMETHING_NEW",
  ]) {
    const status = await claudeStatus(
      envWith(t, "auth", { [name]: "sk-ant-secret-value" }),
    );
    assert.equal(status.ready, false, name);
    assert.equal(status.conflict, name, name);
    assert.match(status.hint, new RegExp(name, "u"), name);
    assert.equal(status.hint.includes("sk-ant-secret-value"), false, name);
  }
});

// Доктор и агент обязаны отказывать на одном и том же .env: доктор читает свой перечень
// (половина CLI не импортирует рантайм, ADR-0003), а отказывает на ходу рантайм. Разъедься
// они — доктор объявил бы .env здоровым перед агентом, который на нём не делает ни хода.
test("both halves refuse the same variables, and the same values", () => {
  const cases: Record<string, string | undefined>[] = [
    { ANTHROPIC_API_KEY: "sk-ant-x" },
    { ANTHROPIC_AUTH_TOKEN: "t" },
    { ANTHROPIC_FOUNDRY_API_KEY: "k" },
    { ANTHROPIC_BASE_URL: "https://proxy.example" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_BEDROCK: "0" },
    { CLAUDE_CODE_USE_VERTEX: "false" },
    { CLAUDE_CODE_USE_SOMETHING_NEW: "yes" },
    { CLAUDE_MODEL: "claude-fable-5-1", PATH: "/usr/bin" },
    {},
  ];
  for (const env of cases)
    assert.equal(
      firstConflict(env),
      claudeConflicts(env)[0] ?? null,
      JSON.stringify(env),
    );
});

/** Уровни, которые подписка приняла живьём 23.09.2026 (CLI 2.1.280). */
const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_FOUR = [
  {
    id: "claude-fable-5-2",
    label: "Fable 5.2",
    reasoningLevels: CLAUDE_LEVELS,
  },
  { id: "claude-opus-5-5", label: "Opus 5.5", reasoningLevels: CLAUDE_LEVELS },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    reasoningLevels: CLAUDE_LEVELS,
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    reasoningLevels: CLAUDE_LEVELS,
  },
];

/** Пикер без Haiku 5.5 (CLI 2.1.287 и старше): четвёртая кнопка — Haiku 4.5 на том же месте,
 *  без уровней: adaptive thinking она не умеет. */
const HAIKU_45 = {
  id: "claude-haiku-4-5-20251001",
  label: "Haiku 4.5",
  reasoningLevels: [],
};
const CLAUDE_BEFORE_HAIKU_55 = [...CLAUDE_FOUR.slice(0, 3), HAIKU_45];

/** Пикер до Sonnet 5.5 (CLI 2.1.280–2.1.283): третья кнопка — Sonnet 5 на том же месте. */
const CLAUDE_BEFORE_SONNET_55 = [
  ...CLAUDE_FOUR.slice(0, 2),
  { id: "claude-sonnet-5", label: "Sonnet 5", reasoningLevels: CLAUDE_LEVELS },
  HAIKU_45,
];

// Кнопки уровней и тело запроса рантайма — две руки одного правила: уровень у модели есть
// ровно тогда, когда рантайм шлёт ей adaptive thinking, и каждый уровень рантайм пропускает
// в output_config.effort. Разъедься они — кнопка писала бы в .env то, что до модели не едет.
test("reasoning levels mirror the runtime: adaptive models only, efforts it sends", () => {
  const ids = [
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "claude-someday-9",
  ];
  for (const id of ids)
    assert.equal(
      claudeReasoningLevels(id).length > 0,
      claudeModel(id).adaptive,
      id,
    );
  assert.deepEqual(claudeReasoningLevels("claude-haiku-4-5-20251001"), []);
  assert.deepEqual(claudeReasoningLevels("claude-someday-9"), []);
  assert.deepEqual(
    claudeReasoningLevels("claude-sonnet-5-5"),
    CANONICAL_REASONING_EFFORTS.filter(
      (effort) => claudeEffort(effort) !== undefined,
    ),
  );
  assert.deepEqual(claudeReasoningLevels("claude-sonnet-5-5"), CLAUDE_LEVELS);
  assert.deepEqual(claudeReasoningLevels("claude-sonnet-5"), CLAUDE_LEVELS);
  assert.deepEqual(claudeReasoningLevels("claude-haiku-5-5"), CLAUDE_LEVELS);
});

// Владелец, 10.11.2026: кнопка Fable 5.2 стоит на месте 5.1 сразу. Пикер CLI 2.1.321 называет
// это место `claude-fable-5-1`, подписка на 5.2 отвечает; 5.1 остаётся известной для .env.
test("a picker that names Fable 5.1 shows the Fable 5.2 button, and 5.1 keeps its label", async (t) => {
  const picker = (resolved: string[]) =>
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "iva-picker",
        response: {
          models: resolved.map((resolvedModel) => ({
            value: resolvedModel,
            resolvedModel,
          })),
        },
      },
    });
  for (const resolved of [
    ["claude-fable-5-1"],
    ["claude-fable-5-2"],
    ["claude-fable-5-1", "claude-fable-5-2"],
  ]) {
    const models = await listClaudeModels(
      envWith(t, "handshake", { FAKE_CLAUDE_PICKER: picker(resolved) }),
    );
    assert.deepEqual(
      models.map((option) => option.id),
      ["claude-fable-5-2"],
      resolved.join(),
    );
  }
  assert.equal(claudeModelLabel("claude-fable-5-2"), "Fable 5.2");
  assert.equal(claudeModelLabel("claude-fable-5-1"), "Fable 5.1");
  assert.deepEqual(claudeReasoningLevels("claude-fable-5-1"), CLAUDE_LEVELS);
});

test("the model list is the four named models, aliases and Haiku 4.5 dropped", async (t) => {
  const models = await listClaudeModels(envWith(t, "handshake"));
  assert.deepEqual(models, CLAUDE_FOUR);
  assert.equal(
    models.some((option) => option.id === "claude-haiku-4-5-20251001"),
    false,
  );
});

// Живой пикер CLI 2.1.293 (08.10.2026) отдаёт Haiku 5.5 на псевдоним `haiku` и Haiku 4.5
// отдельной строкой: кнопок четыре, в порядке экрана, Haiku — новая.
test("the live handshake of CLI 2.1.293 yields Fable, Opus, Sonnet and Haiku 5.5 in order", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../fixtures/claude/handshake-2026-10-08.jsonl", import.meta.url),
    ),
    "utf8",
  );
  const models = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: fixture.trim() }),
  );
  assert.deepEqual(models, CLAUDE_FOUR);
});

// Пикер CLI 2.1.287 на c1 (08.10.2026) Haiku 5.5 не знает: кнопка Haiku не пропадает, а встаёт
// на своё место с Haiku 4.5 и без кнопок уровня.
test("a picker without Haiku 5.5 shows Haiku 4.5 in its place, without levels", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/claude/handshake-2026-10-08-c1.jsonl",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const models = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: fixture.trim() }),
  );
  assert.deepEqual(models, CLAUDE_BEFORE_HAIKU_55);
});

// Живой пикер CLI 2.1.284 (29.09.2026) отдаёт и Sonnet 5.5 (на псевдоним `sonnet`), и прошлый
// Sonnet 5 отдельной строкой: кнопка одна — новая.
test("the live handshake fixture yields Fable, Opus 5.5, Sonnet 5.5 and Haiku 4.5", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../fixtures/claude/handshake-2026-09-29.jsonl", import.meta.url),
    ),
    "utf8",
  );
  const models = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: fixture.trim() }),
  );
  assert.deepEqual(models, CLAUDE_BEFORE_HAIKU_55);
});

// Пикер CLI 2.1.280 (23.09.2026) Sonnet 5.5 не знает: кнопка Sonnet не пропадает, а встаёт на
// своё место с Sonnet 5 — моделью, которую CLI знает.
test("a picker without Sonnet 5.5 shows Sonnet 5 in its place", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../fixtures/claude/handshake-2026-09-23.jsonl", import.meta.url),
    ),
    "utf8",
  );
  const models = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: fixture.trim() }),
  );
  assert.deepEqual(models, CLAUDE_BEFORE_SONNET_55);
});

// Пикер CLI постарше (c1: 2.1.278, 22-23.09.2026) отдаёт Opus 5, а не 5.5: кнопка Opus не
// пропадает, а встаёт на своё место с честной подписью той модели, которую CLI знает.
test("an older picker with Opus 5 shows Fable, Opus 5, Sonnet and Haiku", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../fixtures/claude/c1-handshake.jsonl", import.meta.url),
    ),
    "utf8",
  );
  const models = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: fixture.trim() }),
  );
  assert.deepEqual(models, [
    {
      id: "claude-fable-5-2",
      label: "Fable 5.2",
      reasoningLevels: CLAUDE_LEVELS,
    },
    { id: "claude-opus-5", label: "Opus 5", reasoningLevels: CLAUDE_LEVELS },
    {
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      reasoningLevels: CLAUDE_LEVELS,
    },
    HAIKU_45,
  ]);
});

// Пикер, отдавший обе версии Opus, даёт одну кнопку — новую: предшественница нужна только
// там, где новой нет.
test("a picker with both Opus 5 and Opus 5.5 shows Opus 5.5 once", async (t) => {
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../fixtures/claude/handshake-2026-09-23.jsonl", import.meta.url),
    ),
    "utf8",
  );
  const handshake = JSON.parse(fixture) as {
    response: { response: { models: unknown[] } };
  };
  handshake.response.response.models.push({
    value: "claude-opus-5[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus 5",
  });
  const models = await listClaudeModels(
    envWith(t, "handshake", {
      FAKE_CLAUDE_PICKER: JSON.stringify(handshake),
    }),
  );
  assert.deepEqual(models, CLAUDE_BEFORE_SONNET_55);
});

test("a picker without Fable omits it, and an empty picker uses the pinned four", async (t) => {
  const picker = (rows: unknown[]) =>
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", response: { models: rows } },
    });
  const withoutFable = await listClaudeModels(
    envWith(t, "handshake", {
      FAKE_CLAUDE_PICKER: picker([
        { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5" },
        { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
      ]),
    }),
  );
  assert.deepEqual(
    withoutFable.map((option) => option.id),
    ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  );
  const empty = await listClaudeModels(
    envWith(t, "handshake", { FAKE_CLAUDE_PICKER: picker([]) }),
  );
  assert.deepEqual(empty, CLAUDE_FOUR);
  // В пикере есть строки, но ни одна не из таблицы — тот же вшитый список, не пустой экран.
  const onlyStrangers = await listClaudeModels(
    envWith(t, "handshake", {
      FAKE_CLAUDE_PICKER: picker([
        { value: "opus[1m]", resolvedModel: "claude-opus-4-6[1m]" },
      ]),
    }),
  );
  assert.deepEqual(onlyStrangers, CLAUDE_FOUR);
});

type ClaudeCall = { argv: string[]; extra: string | null };

/** Последний запуск CLI, кроме `auth status`: статус спрашивают перед каждым ходом. */
function lastCall(path: string): ClaudeCall | undefined {
  const calls: ClaudeCall[] = [];
  try {
    calls.push(
      ...readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ClaudeCall),
    );
  } catch {
    return undefined;
  }
  return [...calls].reverse().find((call) => call.argv[0] !== "auth");
}

test("the handshake is the CLI's own initialize, not a request to Anthropic", async (t) => {
  const log = join(scratch(t, "claude-calls"), "calls.jsonl");
  const env = { ...envWith(t, "handshake"), FAKE_CLAUDE_LOG: log };
  await listClaudeModels(env);
  const call = lastCall(log);
  assert.ok(call, "CLI не позвали");
  assert.equal(call.argv[0], "-p");
  assert.equal(call.argv.includes("--input-format"), true);
  assert.equal(call.argv.includes("stream-json"), true);
  assert.equal(call.argv.includes("--strict-mcp-config"), true);
  assert.equal(call.argv.includes("--disable-slash-commands"), true);
  assert.equal(call.argv.includes("--no-session-persistence"), true);
  // Рукопожатию инструменты не нужны вовсе: ни одного объявления не уезжает.
  assert.equal(call.extra, null);
});

test("a handshake that answers garbage or nothing is a typed failure", async (t) => {
  // loggedIn:false и «нечего разобрать» — разные отказы, и оба именованы.
  await assert.rejects(
    listClaudeModels(
      envWith(t, "auth", { FAKE_CLAUDE_AUTH: '{"loggedIn":false}' }),
    ),
    (error: unknown) =>
      error instanceof ClaudeCliError && error.code === "not_logged_in",
  );
  await assert.rejects(
    listClaudeModels(
      envWith(t, "handshake", { FAKE_CLAUDE_PICKER: '{"type":"other"}' }),
    ),
    (error: unknown) =>
      error instanceof ClaudeCliError && error.code === "catalog_unavailable",
  );
  const missing = await claudeStatus({ CLAUDE_COMMAND: "/nonexistent/claude" });
  assert.equal(missing.installed, false);
});

test("the live probe accepts text and a tool call, and names any other answer", async (t) => {
  const text = await probeClaudeModel(
    "claude-fable-5-1",
    envWith(t, "probe-success"),
  );
  assert.equal(text.answered, true);
  assert.equal(text.id, "claude-fable-5-1");
  assert.deepEqual(text.reasoningLevels, CLAUDE_LEVELS);

  // Ход с инструментом — штатная граница: модель ответила вызовом, CLI остановился на
  // --max-turns. Это ответ, а не отказ (как answered у OpenRouter).
  const tool = await probeClaudeModel(
    "claude-fable-5-1",
    envWith(t, "probe-tool"),
  );
  assert.equal(tool.answered, true);

  await assert.rejects(
    probeClaudeModel("claude-fable-5-1", envWith(t, "probe-error")),
    (error: unknown) =>
      error instanceof ClaudeCliError &&
      error.code === "model_unavailable" &&
      /API Error: 500 upstream/u.test(error.message),
  );
});

// Тишина — не ответ: проба обязана закончиться по таймауту и убить CLI вместе с детьми.
// CLI здесь шелловый: ответ на `auth status` должен быть мгновенным, иначе короткий
// таймаут теста уйдёт на запуск node, а не на проверку сторожа тишины.
function sleepingClaude(t: TestContext): string {
  const dir = scratch(t, "sleeping-claude");
  const file = join(dir, "claude");
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":true,"subscriptionType":"max"}'
  exit 0
fi
sleep 60
`,
  );
  chmodSync(file, 0o755);
  return file;
}

test("a silent CLI ends the probe on the timeout", async (t) => {
  const started = Date.now();
  await assert.rejects(
    probeClaudeModel(
      "claude-fable-5-1",
      { ...process.env, CLAUDE_COMMAND: sleepingClaude(t) },
      { timeoutMs: 1500 },
    ),
    (error: unknown) =>
      error instanceof ClaudeCliError &&
      error.code === "model_unavailable" &&
      /timeout/u.test(error.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1500, `проба оборвалась раньше таймаута: ${elapsed} мс`);
  assert.ok(elapsed < 6000, `проба не оборвалась по таймауту: ${elapsed} мс`);
});

// Проба идёт с инструментом (как answered у OpenRouter), но исполнить его некому:
// объявление едет телом запроса, а муляж MCP отвечает на любой вызов отказом.
test("the probe declares one tool and marks it inert", async (t) => {
  const log = join(scratch(t, "claude-probe-calls"), "calls.jsonl");
  const env = { ...envWith(t, "probe-success"), FAKE_CLAUDE_LOG: log };
  await probeClaudeModel("claude-fable-5-1", env);
  const call = lastCall(log);
  assert.ok(call, "пробу не запустили");
  assert.equal(call.argv.includes("--max-turns"), true);
  assert.match(String(call.extra), /mcp__iva__ping/u);
  const mcpIndex = call.argv.indexOf("--mcp-config");
  const mcp = JSON.parse(call.argv[mcpIndex + 1] ?? "{}") as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const server = mcp.mcpServers?.iva;
  assert.equal(server?.command, process.execPath);
  assert.equal(server?.args?.[0], "-e");
  assert.match(String(server?.args?.[1]), /Denied: tools run in Iva/u);
});

test("the model binary comes from CLAUDE_COMMAND or from the service PATH", (t) => {
  const file = fakeClaude(t);
  assert.deepEqual(claudeBinary({ CLAUDE_COMMAND: file }), [file]);
  assert.deepEqual(claudeBinary({ CLAUDE_COMMAND: `${file} --flag` }), [
    file,
    "--flag",
  ]);
  const home = scratch(t, "home");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
  });
  // PATH шелла не в счёт: сервис его не видит и `claude` оттуда не запустит.
  const shell = scratch(t, "shell-path");
  const onShell = join(shell, "claude");
  writeFileSync(onShell, "#!/bin/sh\n");
  chmodSync(onShell, 0o755);
  assert.deepEqual(claudeBinary({ PATH: shell }), null);
  // ~/.local/bin в PATH сервиса: туда ставит подсказка.
  const onLocal = join(home, ".local/bin/claude");
  mkdirSync(dirname(onLocal), { recursive: true });
  writeFileSync(onLocal, "#!/bin/sh\n");
  chmodSync(onLocal, 0o755);
  assert.deepEqual(claudeBinary({ PATH: shell }), [onLocal]);
});

// Окно контекста пишет мастер: у Haiku 4.5 оно впятеро меньше, и завышенное окно сдвинуло бы
// порог компактации к переполнению. У Haiku 5.5 — миллион, как у остальных.
test("the context window follows the model the owner picked", () => {
  assert.equal(claudeContextWindow("claude-haiku-4-5-20251001"), "200000");
  assert.equal(claudeContextWindow("claude-haiku-5-5"), "1000000");
  assert.equal(claudeContextWindow("claude-fable-5-1"), "1000000");
  assert.equal(claudeContextWindow("claude-opus-5-5[1m]"), "1000000");
  assert.equal(claudeContextWindow("claude-sonnet-5-5"), "1000000");
  assert.equal(claudeContextWindow("claude-sonnet-5"), "1000000");
});

test("auth status is read from the first JSON line of the output", async (t) => {
  const status = await claudeStatus(
    envWith(t, "auth", {
      FAKE_CLAUDE_AUTH: `noise before\n${loggedIn}\nnoise after`,
    }),
  );
  assert.equal(status.loggedIn, true);
  assert.equal(status.plan, "max");
});

// Настоящий CLI печатает ответ разложенным по строкам (проверено на 2.1.278): разбор,
// который верит только в однострочный JSON, объявляет живую подписку незалогиненной.
test("a pretty-printed auth status is read as well", async (t) => {
  const pretty = JSON.stringify(
    {
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
      orgName: "Example's Organization",
    },
    null,
    2,
  );
  const status = await claudeStatus(
    envWith(t, "auth", { FAKE_CLAUDE_AUTH: pretty }),
  );
  assert.equal(status.loggedIn, true);
  assert.equal(status.plan, "max");
  assert.equal(status.ready, true);

  // Тот же ответ, но с болтовнёй вокруг: JSON ищется и целиком, и построчно.
  const wrapped = await claudeStatus(
    envWith(t, "auth", {
      FAKE_CLAUDE_AUTH: `warning: something\n${pretty}\ndone`,
    }),
  );
  assert.equal(wrapped.loggedIn, true);
});
