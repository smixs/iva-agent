/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
process.env.AGENT_LANGUAGE = "en";
process.env.ASSISTANT_TIMEZONE = "UTC";
const { default: helperTool } = await import("../agent/tools/helper.ts");
const { default: goalTool } = await import("../agent/tools/goal.ts");
const { default: tasksTool } = await import("../agent/tools/tasks.ts");
type Wire = {
  tools: { name: string; [key: string]: unknown }[];
  prefix: unknown[];
};
const base = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-w3-base.json", import.meta.url),
    "utf8",
  ),
) as { wires: Record<string, Wire> };
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-enabled-wire.json", import.meta.url),
    "utf8",
  ),
) as Wire;
const enabled = { tools: fixture.tools, prefix: fixture.prefix };
test("F1 wave 3-4 instructions, channel hooks and tools accept empty and unauthenticated contexts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-contexts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    import { readdir } from "node:fs/promises";
    await import("./scripts/lib/ts-esm-hooks.ts");
    const telegramUrl = import.meta.resolve("eve/channels/telegram");
    registerHooks({ load(url, context, next) {
      if (url !== telegramUrl) return next(url, context);
      const actual = JSON.stringify(url + "?f1-original");
      return { format: "module", shortCircuit: true, source:
        "export * from " + actual + "; import { telegramChannel as original } from " + actual +
        "; export function telegramChannel(config) { globalThis.f1Hooks = config.events; return original(config); }" };
    }});
    await import("./agent/channels/telegram.ts");
    const helper = (await import("./agent/tools/helper.ts")).default;
    const web = (await import("./agent/tools/web_search.ts")).default;
    const contexts = [
      ["empty", {}],
      ["no-auth", { session: { id: "fixture", turn: { id: "turn_0" } }, abortSignal: new AbortController().signal }],
    ];
    let posts = 0;
    const channel = { state: {}, telegram: { chatId: "41", messageThreadId: null, request: async () => ({ message_id: 1 }), post: async () => { posts++; return { id: "1" }; } } };
    globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 1, chat: { id: 41, type: "private" } }, results: [] });
    const results = [], failures = [];
    const probe = async (entry, context, work) => {
      try { await work(); results.push({ entry, context, ok: true }); }
      catch (error) { failures.push({ entry, context, error: String(error) }); }
    };
    for (const [name, ctx] of contexts) {
      for (const file of (await readdir("./agent/instructions")).filter(f => f.endsWith(".ts"))) {
        const definition = (await import("./agent/instructions/" + file)).default;
        if (definition.events?.["turn.started"]) await probe("instructions/" + file, name, async () => {
          const value = await definition.events["turn.started"]({}, ctx);
          if (file === "41-helper-outcomes.ts" || file === "00-helper.ts") assert.equal(value, null);
        });
      }
      for (const event of ["turn.completed", "message.completed"]) await probe("telegram:" + event, name, () => globalThis.f1Hooks[event]({ turnId: "turn_0", message: "Ready", finishReason: "stop" }, channel, ctx));
      if (name === "empty") assert.equal(posts, 0);
      for (const action of ["start", "list", "close", "outcome"]) await probe("helper:" + action, name, async () => {
        assert.match(await helper.execute({ action, task: "test", may: "", id: "h-abcdef" }, ctx), /личного/);
      });
      await probe("web_search", name, async () => {
        const reply = await web.execute({ query: "fixture" }, ctx);
        if (name === "empty") assert.match(reply.error, /сеть/);
        else assert.deepEqual(reply.results, []);
      });
    }
    console.log(JSON.stringify({ results, failures }));
    assert.deepEqual(failures, []);
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ASSISTANT_DATA_DIR: dir,
        ASSISTANT_VAULT_DIR: join(dir, "vault"),
        TELEGRAM_BOT_TOKEN: "fixture",
        TELEGRAM_WEBHOOK_SECRET_TOKEN: "fixture",
        TELEGRAM_ALLOWED_USER_IDS: "41",
        SEARCH_PROVIDER: "tavily",
        TAVILY_API_KEY: "fixture",
      },
    },
  );
  console.log("F1 context matrix " + output.trim());
});

test("real installed framework registry removes only the three automatic task tools", async () => {
  const { frameworkAgentSourceRegistry } =
    await import("../node_modules/eve/dist/src/framework/sources/registry.js");
  const paths = frameworkAgentSourceRegistry.registrations.flatMap((r) =>
    r.source.modules.map((m) => m.logicalPath),
  );
  for (const removed of ["agent", "task_cancel", "task_update"])
    assert.ok(!paths.includes(`tools/${removed}.ts`));
  for (const kept of [
    "bash",
    "read_file",
    "write_file",
    "todo",
    "web_fetch",
    "load_skill",
    "connection_search",
    "ask_question",
    "web_search",
  ])
    assert.ok(paths.includes(`tools/${kept}.ts`));
  assert.ok(paths.includes("agent.ts"));
});
test("enabled tools keep retained schemas and descriptions except the approved helper/goal/schedule additions and current tasks/remind/memory_search/write_card definitions", async () => {
  const previous = Object.values(base.wires)[0];
  const removed = new Set(["agent", "task_cancel", "task_update", "planner"]);
  const tasks = enabled.tools.find((t) => t.name === "tasks");
  assert.ok(tasks);
  assert.equal(tasks.description, tasksTool.description);
  const revised = new Map(
    enabled.tools
      .filter((t) =>
        ["bash", "remind", "memory_search", "tasks", "write_card"].includes(
          t.name,
        ),
      )
      .map((t) => [t.name, t]),
  );
  for (const name of ["bash", "remind"])
    assert.doesNotMatch(
      String(revised.get(name)?.description),
      /Блокируются|заблокирован/,
    );
  assert.ok(
    JSON.stringify(revised.get("memory_search")?.inputSchema).includes(
      '"history"',
    ),
  );
  assert.ok(
    JSON.stringify(revised.get("write_card")?.inputSchema).includes(
      "новой Card обязательны",
    ),
  );
  assert.deepEqual(
    enabled.tools.filter(
      (t) => !["helper", "goal", "schedule"].includes(t.name),
    ),
    previous.tools
      .filter((t) => !removed.has(t.name))
      .map((t) =>
        t.name === "memory_search" || t.name === "write_card"
          ? revised.get(t.name)!
          : revised.has(t.name)
            ? { ...t, description: revised.get(t.name)!.description }
            : t,
      ),
  );
  assert.equal(
    enabled.tools.find((t) => t.name === "helper")?.description,
    helperTool.description,
  );
  const goal = enabled.tools.find((t) => t.name === "goal");
  assert.equal(goal?.description, goalTool.description);
  assert.equal(goal?.inputSchema && typeof goal.inputSchema, "object");
  const goalSchema = goal.inputSchema as Record<string, unknown>;
  assert.equal(goalSchema.type, "object");
  for (const key of ["oneOf", "anyOf", "allOf", "$ref"])
    assert.ok(!(key in goalSchema));
  for (const kind of "chat reminder signal watch brief insight alert helper".split(
    " ",
  )) {
    const actual = await wireTurn({ kind });
    assert.deepEqual(actual.wire.tools, enabled.tools, kind);
  }
});
test("helper start/finish/read leave the static prefix and full set unchanged", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "iva-enabled-prefix-"));
  const before = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const s = await import("../agent/lib/helper-store.ts");
    const r = await s.addHelper(
      { task: "Find it", may: "", chat: { id: "41", threadId: null } },
      1000,
    );
    assert.ok(r.ok);
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
    await s.finalizeHelper(
      r.row.id,
      { kind: "pending", createdAt: 1000 },
      {
        outcome: "done",
        summary: "found",
        reason: null,
        model: "fixture",
        steps: 1,
        tokens: 10,
      },
      2000,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
    await s.showHelper(r.row.id, { id: "41", threadId: null });
    assert.deepEqual(
      JSON.parse(JSON.stringify((await wireTurn()).wire)),
      enabled,
    );
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("R3 real Telegram chat keeps system prefix across outcome and delivery; outcome context is user", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "iva-telegram-prefix-"));
  const before = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const s = await import("../agent/lib/helper-store.ts");
    const { helperExecute } = await import("../agent/lib/helper-tool.ts");
    const { noteHelperReply, finishHelperOutcomes } =
      await import("../agent/lib/helper-outcome.ts");
    const first = await wireTurn({ telegramAuth: true });
    assert.equal(first.authored.auth?.authenticator, "telegram-webhook");
    const added = await s.addHelper(
      { task: "Find it", may: "", chat: { id: "41", threadId: null } },
      1000,
    );
    assert.ok(added.ok);
    await s.finalizeHelper(
      added.row.id,
      { kind: "pending", createdAt: 1000 },
      {
        outcome: "done",
        summary: "found",
        reason: null,
        model: "fixture",
        steps: 1,
        tokens: 10,
      },
      2000,
    );
    const ready = await wireTurn({ telegramAuth: true });
    assert.deepEqual(ready.wire, first.wire);
    const prompt = ready.model.doStreamCalls[0].prompt;
    const block = prompt.find((message) =>
      JSON.stringify(message.content).includes(added.row.id),
    );
    assert.equal(block?.role, "user");
    assert.match(JSON.stringify(block), /прочитай helper outcome и расскажи/);
    assert.match(
      await helperExecute(
        { action: "outcome", id: added.row.id },
        ready.authored.context,
      ),
      /helper_outcome/,
    );
    const key = { sessionId: "fixture", turnId: "turn_0" };
    noteHelperReply(key, "Found it");
    await finishHelperOutcomes(key, 3000);
    assert.equal((await s.getHelper(added.row.id))?.deliveredAt, 3000);
    const delivered = await wireTurn({ telegramAuth: true });
    assert.deepEqual(delivered.wire, first.wire);
    assert.ok(
      !delivered.model.doStreamCalls[0].prompt.some((message) =>
        JSON.stringify(message.content).includes(added.row.id),
      ),
    );
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});
