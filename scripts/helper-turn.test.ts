/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, after } from "node:test";
import helperRole from "../agent/instructions/00-helper.ts";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
const home = await mkdtemp(join(tmpdir(), "iva-helper-wire-"));
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
process.env.ASSISTANT_DATA_DIR = join(home, "data");
process.env.MODEL_PROVIDER = "ollama";
process.env.AGENT_LANGUAGE = "en";
process.env.ASSISTANT_TIMEZONE = "UTC";
for (const dir of [
  "vault",
  "data/custom/agent/instructions",
  "data/custom/agent/skills/owner-fixture",
])
  await mkdir(join(home, dir), { recursive: true });
for (const [file, text] of [
  ["vault/CORE.md", "CORE_FIXTURE owner project"],
  ["vault/PERSONA.md", "PERSONA_FIXTURE concise"],
  ["data/custom/agent/instructions/rule.md", "OWNER_FIXTURE use dated sources"],
  [
    "data/custom/agent/skills/owner-fixture/SKILL.md",
    "---\nname: owner-fixture\ndescription: OWNER_SKILL_FIXTURE\n---\nOwner skill instructions.",
  ],
])
  await writeFile(join(home, file), text);
after(() => rm(home, { recursive: true, force: true }));
test("helper uses chat definitions and static block, retaining owner instructions and skills", async () => {
  const chat = await wireTurn(),
    helper = await wireTurn({ kind: "helper" });
  const current = {
    session: {
      ...helper.authored.context.session,
      auth: { current: helper.authored.auth, initiator: null },
    },
  };
  assert.ok(helperRole.events["turn.started"]!({}, current as never));
  assert.deepEqual(helper.wire.tools, chat.wire.tools);
  assert.ok(helper.wire.tools.some((t) => t.name.endsWith("__send_message")));
  assert.equal(helper.authored.system, chat.authored.system);
  assert.ok(helper.wire.prefix[0].content.startsWith(chat.authored.system));
  const prefix = JSON.stringify(helper.wire.prefix);
  assert.match(prefix, /background helper of Iva/);
  assert.match(prefix, /CORE_FIXTURE/);
  assert.match(prefix, /OWNER_FIXTURE/);
  assert.doesNotMatch(prefix, /PERSONA_FIXTURE/);
  assert.ok(!("40-open-failures.ts" in helper.authored.instructions));
  assert.equal(helper.authored.userInstructions.length, 0);
  assert.ok(chat.authored.userInstructions.length > 0);
  const custom = (await import("../agent/skills/custom.ts")).default;
  assert.match(
    JSON.stringify(
      await custom.events["turn.started"]!(
        {},
        helper.authored.eve.buildResolveContext(helper.ctx, []),
      ),
    ),
    /owner-fixture/,
  );
});
test("R7 Telegram chat and existing turns retain 91dd9bb6 wire bytes except approved tools, current bash/tasks/remind/memory_search definitions and prefix switch", async () => {
  const base = JSON.parse(
    await readFile(
      new URL("./fixtures/helper-w3-base.json", import.meta.url),
      "utf8",
    ),
  ) as {
    base: string;
    wires: Record<string, { tools: { name: string }[]; prefix: unknown[] }>;
  };
  const enabled = JSON.parse(
    await readFile(
      new URL("./fixtures/helper-enabled-wire.json", import.meta.url),
      "utf8",
    ),
  ) as { tools: { name: string; description: string }[]; ruPrefix: unknown[] };
  assert.equal(base.base, "91dd9bb6");
  const tasks = enabled.tools.find((tool) => tool.name === "tasks");
  assert.ok(tasks);
  const previous = base.wires["wire-0"],
    removed = new Set(["agent", "task_cancel", "task_update", "planner"]),
    tools = previous.tools
      .filter((tool) => !removed.has(tool.name))
      .map((tool) =>
        tool.name === "memory_search"
          ? enabled.tools.find((current) => current.name === tool.name)!
          : ["bash", "tasks", "remind"].includes(tool.name)
            ? {
                ...tool,
                description: enabled.tools.find(
                  (current) => current.name === tool.name,
                )!.description,
              }
            : tool,
      ),
    helper = enabled.tools.find((tool) => tool.name === "helper");
  assert.ok(helper);
  assert.equal(previous.tools.length, 140);
  assert.equal(
    previous.tools.filter((tool) => removed.has(tool.name)).length,
    4,
  );
  const goal = enabled.tools.find((tool) => tool.name === "goal");
  assert.ok(goal);
  tools.splice(enabled.tools.indexOf(goal), 0, goal);
  tools.splice(enabled.tools.indexOf(helper), 0, helper);
  const schedule = enabled.tools.find((tool) => tool.name === "schedule");
  assert.ok(schedule);
  tools.splice(enabled.tools.indexOf(schedule), 0, schedule);
  const expected = JSON.stringify({ tools, prefix: enabled.ruPrefix });
  const saved = { ...process.env };
  Object.assign(process.env, {
    AGENT_LANGUAGE: "ru",
    ASSISTANT_DATA_DIR: join(home, "golden-data"),
    ASSISTANT_VAULT_DIR: join(home, "golden-vault"),
  });
  try {
    await mkdir(join(home, "golden-vault"), { recursive: true });
    for (const kind of "chat reminder signal watch brief insight alert".split(
      " ",
    )) {
      const turn = await wireTurn({ kind, telegramAuth: kind === "chat" });
      if (kind === "chat") {
        assert.equal(turn.authored.auth?.authenticator, "telegram-webhook");
        assert.equal(turn.authored.auth?.principalType, "user");
        assert.equal(turn.authored.auth?.attributes?.chat_id, "41");
        assert.equal(turn.authored.auth?.attributes?.chat_type, "private");
      }
      assert.equal(turn.wire.tools.length, 139, kind);
      assert.ok(
        turn.wire.tools.some((t) => t.name === "goal"),
        kind,
      );
      assert.equal(JSON.stringify(turn.wire), expected, kind);
      assert.notEqual(
        JSON.stringify({ ...turn.wire, tools: [...turn.wire.tools].reverse() }),
        expected,
      );
    }
  } finally {
    for (const key of [
      "AGENT_LANGUAGE",
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_VAULT_DIR",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
});
for (const noEvents of [false, true])
  for (const max of [1, 3])
    for (const calls of [0, max - 1, max, max + 1])
      test(`ceiling ${max}, calls ${calls}, observer ${!noEvents}`, async () => {
        const turn = await wireTurn({
          attributes: { iva_max_steps: String(max) },
          calls,
          noEvents,
        });
        const requests = noEvents
          ? turn.model.doGenerateCalls
          : turn.model.doStreamCalls;
        assert.equal(requests.length, Math.min(calls + 1, max));
        assert.equal(turn.executions, Math.min(calls, max - 1));
        assert.equal(turn.result.next, null);
        if (requests.length === max) {
          assert.deepEqual(requests.at(-1)!.tools ?? [], []);
          if (!noEvents)
            assert.equal(
              turn.events.find((e) => e.type === "turn.completed")?.data
                ?.reason,
              "step-limit",
            );
        }
      });
for (const value of [
  0,
  -1,
  1.5,
  "03",
  "0",
  "-1",
  "1.5",
  "1000000000",
  "80\n",
  " 80",
  "80 ",
  NaN,
  Infinity,
  [],
  1e20,
])
  test(`specified garbage ${String(value)} closes at one`, async () => {
    const turn = await wireTurn({
      attributes: { iva_max_steps: value },
      calls: 4,
      noEvents: true,
    });
    assert.equal(turn.model.doGenerateCalls.length, 1);
    assert.equal(turn.executions, 0);
  });
test("minimum is symmetric and retry/compaction are outside the step count", async () => {
  for (const [first, current] of [
    [1, 3],
    [3, 1],
  ]) {
    const turn = await wireTurn({
      attributes: { iva_max_steps: String(first) },
      currentAttributes: { iva_max_steps: String(current) },
      calls: 3,
    });
    assert.equal(turn.model.doStreamCalls.length, 1);
  }
  const retry = await wireTurn({
    attributes: { iva_max_steps: "2" },
    calls: 4,
    retry: true,
  });
  assert.equal(retry.model.doStreamCalls.length, 3);
  assert.equal(retry.executions, 1);
  const compact = await wireTurn({
    attributes: { iva_max_steps: "2" },
    calls: 4,
    compact: true,
  });
  assert.ok(compact.model.doGenerateCalls.length > 0);
  assert.equal(compact.model.doStreamCalls.length, 2);
  assert.equal(compact.executions, 1);
});

test("live helper observations compare ordered hashes and fail closed", async () => {
  const { helperWireResult, liveTurnHeaders } = await import("./live-turn.ts");
  const { createHash } = await import("node:crypto");
  const chat = await wireTurn(),
    helper = await wireTurn({ kind: "helper" });
  const observation = (tools: unknown[], helperBlock: boolean) =>
    "LIVE_HELPER_WIRE " +
    JSON.stringify({
      model: "helper-fixture",
      tools: tools.length,
      hash: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
      helperBlock,
    });
  const normal = [observation(chat.wire.tools, false)],
    background = [observation(helper.wire.tools, true)];
  assert.deepEqual(helperWireResult(normal, background), {
    model: "helper-fixture",
    tools: chat.wire.tools.length,
  });
  for (const tools of [
    [],
    helper.wire.tools.slice(1),
    [...helper.wire.tools].reverse(),
  ])
    assert.throws(() => helperWireResult(normal, [observation(tools, true)]));
  assert.throws(() =>
    helperWireResult(normal, [observation(helper.wire.tools, false)]),
  );
  assert.deepEqual(liveTurnHeaders(), {});
  assert.match(liveTurnHeaders(true)["x-iva-helper"], /^h-[0-9a-f]{6}$/);
});
test("R1 incomplete wire observations fail closed", async () => {
  const { helperWireResult } = await import("./live-turn.ts");
  for (const fields of [
    { tools: 140 },
    { tools: "140", hash: "a".repeat(64) },
  ]) {
    const line = (helperBlock: boolean) =>
      "LIVE_HELPER_WIRE " +
      JSON.stringify({ model: "fixture", ...fields, helperBlock });
    assert.throws(() => helperWireResult([line(false)], [line(true)]));
  }
});
