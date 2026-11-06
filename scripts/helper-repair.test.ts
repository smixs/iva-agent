/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeAuth } from "eve/channels/auth";
import {
  assistantBearerAuth,
  createEveAuth,
  isHelperTurn,
} from "../agent/lib/eve-auth.ts";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
process.env.OLLAMA_CONTEXT_WINDOW = "8000";
process.env.OLLAMA_API_KEY = "fixture";
process.env.HELPER_MODEL = "future-helper";
const { sessionInboxWire } =
  await import("../node_modules/eve/dist/src/execution/wire/session-inbox-encoder.js");

test("helper wire: prepare the authored tree and capture a complete observation for 140 tools", async () => {
  const live = await import("./live-turn.ts");
  assert.equal(
    typeof (live as Record<string, unknown>).prepareLiveApp,
    "function",
  );
  const home = await mkdtemp(join(tmpdir(), "iva-repair-live-"));
  try {
    process.env.LIVE_TURN_KIND = "helper";
    const prepared = await (
      live as unknown as {
        prepareLiveApp: (
          home: string,
          note: (line: string) => void,
        ) => Promise<{ app: string; env: NodeJS.ProcessEnv }>;
      }
    ).prepareLiveApp(home, () => {});
    assert.equal(
      await readFile(join(prepared.app, "agent/provider.ts"), "utf8"),
      await readFile("agent/provider.ts", "utf8"),
    );
    assert.equal(prepared.env.IVA_LIVE_WIRE, "1");
    const { helperWireResult } = live;
    const { runNode } = await import("./lib/eve-app.ts");
    const logs: string[] = [];
    const code = `import './scripts/lib/ts-esm-hooks.ts'; globalThis.fetch=async()=>{throw new Error('fixture end')}; const {makeTextModel}=await import('./agent/provider.ts'); const model=makeTextModel({model:'helper-fixture',chatModelSeesImages:async()=>false}); await model.doStream({prompt:[{role:'system',content:'You are a background helper of Iva;'}],tools:Array.from({length:140},(_,i)=>({type:'function',name:'tool'+i,description:'x'.repeat(700),inputSchema:{type:'object',properties:{}}}))}).catch(()=>{});`;
    await runNode(
      ["--input-type=module", "-e", code],
      prepared.app,
      prepared.env,
      (line) => logs.push(line),
    );
    assert.ok(logs.every((line) => line.length < 1000));
    assert.deepEqual(helperWireResult(logs, logs), {
      model: "helper-fixture",
      tools: 140,
    });
    const fragments: string[] = [];
    const observation = logs.find((line) =>
      line.startsWith("LIVE_HELPER_WIRE "),
    )!;
    await runNode(
      [
        "-e",
        `const line=${JSON.stringify(observation)}; process.stdout.write(line.slice(0,30)); setTimeout(()=>process.stdout.write(line.slice(30)+'\\n'),5);`,
      ],
      prepared.app,
      prepared.env,
      (line) => fragments.push(line),
    );
    assert.deepEqual(fragments, [observation]);
  } finally {
    delete process.env.LIVE_TURN_KIND;
    await rm(home, { recursive: true, force: true });
  }
});
for (const mode of ["conversation", "task"] as const)
  for (const noEvents of [false, true]) {
    test(`R2 resumes waiting within three calls: ${mode}, observer ${!noEvents}`, async () => {
      const turn = await wireTurn({
        mode,
        noEvents,
        attributes: { iva_max_steps: "3" },
        sequence: [
          "read_file",
          "ask_question",
          "read_file",
          "read_file",
          "done",
        ],
      });
      assert.equal(turn.result.next, null);
      const eve = turn.authored.eve;
      let resumed = await eve.contextStorage.run(turn.ctx, () =>
        turn.run(turn.result.session, {
          inputResponses: [{ requestId: "t2", optionId: "one" }],
        }),
      );
      for (let i = 0; typeof resumed.next === "function" && i < 5; i++) {
        const next = resumed.next;
        resumed = await eve.contextStorage.run(turn.ctx, () =>
          next(resumed.session),
        );
      }
      const calls = noEvents
        ? turn.model.doGenerateCalls
        : turn.model.doStreamCalls;
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.at(-1)?.tools ?? [], []);
      assert.match(
        JSON.stringify(calls.at(-1)?.prompt),
        /Step limit reached \(3 steps\)\. No tools are available now/,
      );
      assert.doesNotMatch(
        JSON.stringify(resumed.session.history),
        /Step limit reached \(3 steps\)\. No tools are available now/,
      );
    });
    for (const schema of [
      undefined,
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    ])
      test(`R2 rejects an unusable final result: ${mode}, observer ${!noEvents}, schema ${!!schema}`, async () => {
        const turn = await wireTurn({
          mode,
          noEvents,
          attributes: { iva_max_steps: "1" },
          outputSchema: schema,
          calls: schema ? 0 : 1,
          invalidLast: true,
        });
        const settled =
          mode === "task" ? turn.result.next : turn.result.settledTurn;
        assert.ok(settled && typeof settled === "object" && settled.isError);
        assert.match(
          String(settled.output),
          schema ? /requested schema/ : /step limit/i,
        );
        if (!noEvents)
          assert.ok(turn.events.some((e) => e.type === "turn.failed"));
        assert.equal(turn.result.session.compaction.lastKnownInputTokens, 10);
        assert.ok(
          (turn.result.session.compaction.lastKnownPromptMessageCount ?? 0) > 0,
        );
      });
  }
test("R2 two turns in the same session each receive their own ceiling without an observer", async () => {
  const turn = await wireTurn({
    noEvents: true,
    attributes: { iva_max_steps: "3" },
    calls: 10,
  });
  assert.equal(turn.model.doGenerateCalls.length, 3);
  let result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
    turn.run(turn.result.session, { message: "second" }),
  );
  for (let i = 0; typeof result.next === "function" && i < 5; i++) {
    const next = result.next;
    result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
      next(result.session),
    );
  }
  assert.equal(turn.model.doGenerateCalls.length, 6);
});
test("R3 helper auth crosses sessionInboxWire and the second turn receives eighty calls", async () => {
  const auth = await assistantBearerAuth("fixture")(
    new Request("http://fixture.invalid", {
      headers: {
        authorization: "Bearer fixture",
        "x-iva-turn": "helper",
        "x-iva-helper": "h-abc123",
      },
    }),
  );
  assert.ok(auth && !(auth instanceof Response));
  assert.equal(auth.attributes.iva_max_steps, "80");
  const encoded = sessionInboxWire.encode(
    { kind: "deliver", auth, payloads: [{ message: "second" }] },
    { version: 6 },
  );
  assert.ok(encoded);
  const turn = await wireTurn({
    noEvents: true,
    attributes: {},
    sequence: ["done", ...Array.from({ length: 100 }, () => "read_file")],
  });
  assert.equal(encoded.kind, "deliver");
  assert.ok("auth" in encoded && encoded.auth);
  turn.ctx.set(turn.authored.eve.AuthKey, encoded.auth);
  let result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
    turn.run(turn.result.session, { message: "second" }),
  );
  for (let i = 0; typeof result.next === "function" && i < 100; i++) {
    const next = result.next;
    result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
      next(result.session),
    );
  }
  assert.equal(turn.model.doGenerateCalls.length, 81);
  assert.equal(result.settledTurn?.output, "done");
  // The provider still sees tools on the first step: the transported ceiling is 80, not 1.
  assert.ok(turn.model.doGenerateCalls[1].tools!.length > 0);
});
test("R4 malformed helper cannot fall through to local-dev and foreign authenticators cannot mark helpers", async (t) => {
  const previous = process.env.EVE_DEV;
  process.env.EVE_DEV = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = previous;
  });
  const result = await routeAuth(
    new Request("http://127.0.0.1:8723/eve/v1/session", {
      headers: { authorization: "Bearer fixture", "x-iva-turn": "helper" },
    }),
    createEveAuth({ ASSISTANT_BEARER: "fixture", EVE_DEV: "1" }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
  assert.equal(
    isHelperTurn({
      session: {
        auth: {
          initiator: {
            authenticator: "foreign",
            attributes: { iva_turn: "helper" },
          },
        },
      },
    }),
    false,
  );
});
test("R5 records actual root, declared and inline models and never resolves helper windows in the usage hook", async () => {
  const home = await mkdtemp(join(tmpdir(), "iva-repair-usage-"));
  process.env.ASSISTANT_DATA_DIR = home;
  try {
    const hook = (await import("../agent/hooks/usage.ts")).default;
    const { generateText } = await import("ai");
    const { makeTextModel } = await import("../agent/provider.ts");
    const declared = {
      model: makeTextModel({
        model: "chat-fixture",
        chatModelSeesImages: () => Promise.resolve(false),
      }),
    };
    const previous = globalThis.fetch;
    const wire: string[] = [];
    globalThis.fetch = (_url, init) => {
      const body = JSON.parse(init!.body as string) as { model: string };
      wire.push(body.model);
      return Promise.resolve(
        Response.json({
          id: "reply",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "plan" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    };
    const rootModel = makeTextModel({
      model: "future-helper",
      chatModelSeesImages: () => Promise.resolve(false),
    });
    try {
      const ctx = {
        session: {
          id: "usage",
          turn: { id: "turn_0", sequence: 0 },
          auth: {
            initiator: {
              authenticator: "iva-bearer",
              attributes: { iva_turn: "helper" },
            },
          },
        },
        channel: { kind: "http" },
      };
      const data = {
        stepIndex: 0,
        turnId: "turn_0",
        usage: { inputTokens: 10, outputTokens: 2 },
      };
      // Root and separate declared sessions each receive their actual step.started model.
      for (const [id, kind, model] of [
        ["root", "http", rootModel],
        ["declared", "subagent", declared.model],
      ] as const) {
        await generateText({ model, prompt: "plan" });
        const owner = {
          ...ctx,
          session: { ...ctx.session, id },
          channel: { kind },
        };
        await hook.events!["step.completed"]!(
          { data: { ...data, providerModelId: model.modelId } } as never,
          owner as never,
        );
      }
      await generateText({ model: declared.model, prompt: "inline plan" });
      for (const inner of [
        {
          type: "step.completed",
          data: { ...data, providerModelId: declared.model.modelId },
        },
      ])
        await hook.events!["subagent.event"]!(
          { data: { subagentName: "declared", event: inner } } as never,
          ctx as never,
        );
      const rows = (await readFile(join(home, "usage.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { model: string; source: string });
      assert.deepEqual(
        rows.map((row) => row.model),
        wire,
      );
      assert.deepEqual(wire, ["future-helper", "chat-fixture", "chat-fixture"]);
    } finally {
      globalThis.fetch = previous;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    delete process.env.ASSISTANT_DATA_DIR;
  }
});
test("R6 usage source stays with the initiator and recognizes a helper on either side", async () => {
  const home = await mkdtemp(join(tmpdir(), "iva-repair-source-"));
  process.env.ASSISTANT_DATA_DIR = home;
  try {
    process.env.HELPER_MODEL = "deepseek-v4-pro";
    const hook = (await import("../agent/hooks/usage.ts")).default;
    const bearer = (kind: string) => ({
      authenticator: "iva-bearer",
      attributes: kind ? { iva_turn: kind } : {},
    });
    const telegram = { authenticator: "telegram-webhook", attributes: {} };
    const cases = [
      [telegram, bearer("reminder"), "channel:telegram"],
      [bearer("reminder"), telegram, "reminder"],
      [bearer("reminder"), bearer(""), "reminder"],
      [bearer("helper"), telegram, "helper"],
      [telegram, bearer("helper"), "helper"],
    ] as const;
    for (const [initiator, current] of cases)
      await hook.events!["step.completed"]!(
        {
          data: {
            stepIndex: 0,
            turnId: "turn_0",
            usage: { inputTokens: 10, outputTokens: 1 },
          },
        } as never,
        {
          session: { id: "source", auth: { initiator, current } },
          channel: { kind: "channel:telegram" },
        } as never,
      );
    const rows = (await readFile(join(home, "usage.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { model: string; source: string });
    assert.deepEqual(
      rows.map((row) => row.source),
      cases.map((row) => row[2]),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    delete process.env.ASSISTANT_DATA_DIR;
  }
});
test("R7 helper windows use Claude resolution and the other provider windows", async () => {
  const { runNode } = await import("./lib/eve-app.ts");
  for (const [provider, model] of [
    ["claude", "sonnet"],
    ["claude", "haiku"],
    ["claude", "sonnet[1m]"],
    ["claude", "claude-haiku-4-5"],
    ["claude", "claude-haiku-4-5[1m]"],
    ["ollama", "future-helper"],
    ["custom", "future-helper"],
  ]) {
    const logs: string[] = [];
    await runNode(
      [
        "--input-type=module",
        "-e",
        `import './scripts/lib/ts-esm-hooks.ts'; const {stepModelChoice}=await import('./agent/agent.ts'); const choice=stepModelChoice({session:{id:'h',auth:{initiator:{authenticator:'iva-bearer',attributes:{iva_turn:'helper'}}}}}); console.log(JSON.stringify([choice,stepModelChoice({session:{id:"chat"}})]));`,
      ],
      process.cwd(),
      {
        ...process.env,
        MODEL_PROVIDER: provider,
        HELPER_MODEL: model,
        CUSTOM_MODEL: "chat",
        CUSTOM_BASE_URL: "https://fixture.invalid/v1",
        CUSTOM_CONTEXT_WINDOW: "8000",
        CLAUDE_CONTEXT_WINDOW: "12345",
      },
      (line) => logs.push(line),
    );
    const [choice, chat] = JSON.parse(logs.at(-1)!) as {
      contextWindow: number;
    }[];
    assert.equal(chat.contextWindow, provider === "claude" ? 12345 : 8000);
    if (provider === "claude") assert.equal(choice.contextWindow, 12345);
    else assert.equal(choice.contextWindow, 8000);
  }
});
test("R5 compaction through makeTextModel records the selected helper model (A13b)", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "iva-repair-compaction-"));
  process.env.ASSISTANT_DATA_DIR = home;
  const previous = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = previous;
    delete process.env.ASSISTANT_DATA_DIR;
    await rm(home, { recursive: true, force: true });
  });
  const requests: string[] = [];
  globalThis.fetch = (_url, init) => {
    const body = JSON.parse(init!.body as string) as { model: string };
    requests.push(body.model);
    return Promise.resolve(
      Response.json({
        id: "summary",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "summary" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  };
  const { makeTextModel } = await import("../agent/provider.ts");
  const { compactMessages } =
    await import("../node_modules/eve/dist/src/harness/compaction.js");
  await compactMessages(
    [
      { role: "user", content: "long history ".repeat(100) },
      { role: "assistant", content: "long answer ".repeat(100) },
      { role: "user", content: "continue" },
    ],
    makeTextModel({
      model: "future-helper",
      chatModelSeesImages: () => Promise.resolve(false),
    }),
    { threshold: 1, recentWindowSize: 1 },
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  assert.ok(requests.includes("future-helper"));
  const rows = (await readFile(join(home, "usage.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { model: string; source: string });
  assert.equal(rows[0].source, "compaction");
  assert.equal(rows[0].model, "future-helper");
});
test("R9 filesystem enumeration order cannot change the ordered wire", async () => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const readdir = fs.promises.readdir;
  const normal = (await wireTurn()).wire;
  // Reorder the filesystem boundary, while running the actual fixture and harness unchanged.
  fs.promises.readdir = (async (...args: Parameters<typeof readdir>) => {
    const entries = await readdir(...args);
    return /agent\/(tools|subagents)$/.test(String(args[0]))
      ? [...entries].reverse()
      : entries;
  }) as typeof readdir;
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await wireTurn()).wire, normal);
  } finally {
    fs.promises.readdir = readdir;
    syncBuiltinESMExports();
  }
});

for (const mode of ["conversation", "task"] as const)
  for (const noEvents of [false, true])
    for (const schema of [
      undefined,
      {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    ])
      test(`R2 exhausted empty answer is a failed outcome: ${mode}, observer ${!noEvents}, schema ${!!schema}`, async () => {
        const turn = await wireTurn({
          mode,
          noEvents,
          attributes: { iva_max_steps: "1" },
          outputSchema: schema,
          emptyLast: true,
        });
        const outcome =
          mode === "task" ? turn.result.next : turn.result.settledTurn;
        assert.ok(outcome && typeof outcome === "object" && outcome.isError);
        assert.match(
          String(outcome.output),
          schema ? /requested schema/ : /step limit/i,
        );
        if (!noEvents)
          assert.ok(turn.events.some((e) => e.type === "turn.failed"));
      });
