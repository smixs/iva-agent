/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
import { runNode } from "./lib/eve-app.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
process.env.OLLAMA_CONTEXT_WINDOW = "8000";
process.env.OLLAMA_API_KEY = "fixture";

test("N1 seven existing turn kinds retain base model on all six providers", async () => {
  const base = JSON.parse(
    await readFile(
      new URL("./fixtures/helper-usage-base.json", import.meta.url),
      "utf8",
    ),
  ) as {
    base: string;
    providers: Record<
      string,
      { model: string; turns: Record<string, string[]> }
    >;
  };
  assert.equal(base.base, "21f447ed");
  assert.equal(Object.keys(base.providers).length, 6);
  for (const [provider, entry] of Object.entries(base.providers)) {
    const home = await mkdtemp(join(tmpdir(), "iva-usage-base-"));
    try {
      const logs: string[] = [];
      await runNode(
        [
          "--input-type=module",
          "-e",
          "import './scripts/lib/ts-esm-hooks.ts'; const {existingUsageProbe}=await import('./scripts/fixtures/helper-usage-r2.test-fixture.ts'); console.log(JSON.stringify(await existingUsageProbe()));",
        ],
        process.cwd(),
        {
          ...process.env,
          MODEL_PROVIDER: provider,
          [`${provider.toUpperCase()}_MODEL`]: entry.model,
          [`${provider.toUpperCase()}_API_KEY`]: "fixture",
          CUSTOM_BASE_URL: "https://fixture.invalid/v1",
          CUSTOM_CONTEXT_WINDOW: "8000",
          HELPER_MODEL: "",
          PROBE_HELPER: "",
          ASSISTANT_DATA_DIR: home,
        },
        (line) => logs.push(line),
      );
      assert.deepEqual(JSON.parse(logs.at(-1)!), entry.turns, provider);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

for (const [provider, chat, helper] of [
  ["claude", "claude-opus-5-5", undefined],
  ["claude", "claude-opus-5-5", "claude-sonnet-5-5"],
  ["claude", "claude-fable-5-1", undefined],
  ["custom", "claude-opus-5-5", undefined],
  ["openrouter", "a/b", undefined],
  ["ollama", "chat-fixture", "helper-fixture"],
  ["ollama", "chat-fixture", undefined],
  ["opencode", "chat-fixture", undefined],
  ["codex", "gpt-6.1-sol", undefined],
] as const)
  test(`N1/N2 actual harness completion owns model: ${provider} ${chat} ${helper ?? "chat"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "iva-usage-r2-"));
    try {
      const logs: string[] = [];
      await runNode(
        [
          "--input-type=module",
          "-e",
          "import './scripts/lib/ts-esm-hooks.ts'; const {usageProbe}=await import('./scripts/fixtures/helper-usage-r2.test-fixture.ts'); console.log(JSON.stringify(await usageProbe()));",
        ],
        process.cwd(),
        {
          ...process.env,
          MODEL_PROVIDER: provider,
          [`${provider.toUpperCase()}_MODEL`]: chat,
          [`${provider.toUpperCase()}_API_KEY`]: "fixture",
          CUSTOM_BASE_URL: "https://fixture.invalid/v1",
          CUSTOM_CONTEXT_WINDOW: "8000",
          HELPER_MODEL: helper ?? "",
          PROBE_HELPER: helper ? "1" : "",
          ASSISTANT_DATA_DIR: home,
        },
        (line) => logs.push(line),
      );
      const observed = JSON.parse(logs.at(-1)!) as {
        rows: { model: string }[];
        models: string[];
        handlers: string[];
        events: { type: string; data: { providerModelId?: string } }[];
      };
      assert.deepEqual(
        observed.rows.map((row) => row.model),
        observed.models
          .slice(0, 3)
          .flatMap((m) => [m, m])
          .concat(chat),
      );
      assert.equal(observed.models[0], helper ?? chat);
      const completed = observed.events.filter(
        (e) => e.type === "step.completed",
      );
      assert.deepEqual(
        completed.map((e) => e.data.providerModelId),
        observed.models.slice(0, 3),
      );
      assert.ok(observed.events.some((e) => e.type === "step.failed"));
      assert.ok(
        !observed.handlers.includes("step.started"),
        "hook has no cross-event model state",
      );
      const source = await readFile("agent/hooks/usage.ts", "utf8");
      assert.doesNotMatch(source, /stepModels|new Map|wireModel/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

for (const mode of ["conversation", "task"] as const)
  for (const noEvents of [false, true]) {
    test(`N3 inputResponses with message keeps the turn ceiling: ${mode} events ${!noEvents}`, async () => {
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
      let result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
        turn.run(turn.result.session, {
          inputResponses: [{ requestId: "t2", optionId: "one" }],
          message: "supplement to the same task",
        }),
      );
      while (typeof result.next === "function") {
        const next = result.next;
        result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
          next(result.session),
        );
      }
      assert.equal(
        turn.model.doStreamCalls.length + turn.model.doGenerateCalls.length,
        3,
      );
      if (!noEvents)
        assert.equal(
          turn.events.filter((e) => e.type === "turn.started").length,
          2,
        );
    });
    for (const delivery of ["context", "stale-response", "message"] as const)
      test(`N3 new ${delivery} opens a full turn: ${mode} events ${!noEvents}`, async () => {
        const turn = await wireTurn({
          mode,
          noEvents,
          attributes: { iva_max_steps: "3" },
          calls: 99,
        });
        const input =
          delivery === "context"
            ? { context: ["new independent task"] }
            : delivery === "stale-response"
              ? { inputResponses: [{ requestId: "stale", optionId: "one" }] }
              : { message: "new task" };
        let result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
          turn.run(turn.result.session, input),
        );
        while (typeof result.next === "function") {
          const next = result.next;
          result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
            next(result.session),
          );
        }
        assert.equal(
          turn.model.doStreamCalls.length + turn.model.doGenerateCalls.length,
          6,
        );
        const calls = [
          ...turn.model.doStreamCalls,
          ...turn.model.doGenerateCalls,
        ];
        assert.ok(calls[3].tools?.length);
        assert.equal(calls[5].tools?.length ?? 0, 0);
        if (!noEvents)
          assert.equal(
            turn.events.filter((e) => e.type === "turn.started").length,
            delivery === "context" ? 1 : 2,
          );
      });
    test(`N3 ordinary message answering a question opens a new turn: ${mode} events ${!noEvents}`, async () => {
      const turn = await wireTurn({
        mode,
        noEvents,
        attributes: { iva_max_steps: "3" },
        sequence: [
          "read_file",
          "ask_question",
          "read_file",
          "read_file",
          "read_file",
          "done",
        ],
      });
      let result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
        turn.run(turn.result.session, { message: "One" }),
      );
      while (typeof result.next === "function") {
        const next = result.next;
        result = await turn.authored.eve.contextStorage.run(turn.ctx, () =>
          next(result.session),
        );
      }
      assert.equal(
        turn.model.doStreamCalls.length + turn.model.doGenerateCalls.length,
        5,
      );
      if (!noEvents)
        assert.equal(
          turn.events.filter((e) => e.type === "turn.started").length,
          2,
        );
    });
    if (mode === "task")
      test(`N4 last step refuses deferred followup: ${mode} events ${!noEvents}`, async () => {
        const turn = await wireTurn({
          mode,
          noEvents,
          sequence: ["done"],
          attributes: { iva_max_steps: "3" },
        });
        const {
          appendPendingInputBatch,
          queueDeferredStepInput,
          hasDeferredStepInput,
        } =
          await import("../node_modules/eve/dist/src/harness/pending-input-batches.js");
        let session = appendPendingInputBatch({
          session: {
            ...turn.result.session,
            state: {
              ...turn.result.session.state,
              "eve.harness.modelCalls": 2,
            },
          },
          requests: [
            {
              kind: "tool-approval",
              requestId: "approval-1",
              prompt: "Approve",
              action: {
                kind: "tool-call",
                callId: "approval-1",
                toolName: "read_file",
                input: { path: "CORE.md" },
              },
            },
          ],
          responseMessages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "approval-1",
                  toolName: "read_file",
                  input: { path: "CORE.md" },
                },
              ],
            },
          ],
        });
        session = queueDeferredStepInput(session, {
          message: "FOLLOWUP_MUST_BE_PROCESSED",
        });
        const result = await turn.authored.eve.contextStorage.run(
          turn.ctx,
          () =>
            turn.run(session, {
              inputResponses: [{ requestId: "approval-1", optionId: "cancel" }],
            }),
        );
        if (mode === "task")
          assert.equal(
            typeof result.next === "object" && result.next?.isError,
            true,
          );
        else assert.equal(result.settledTurn?.isError, true);
        assert.ok(hasDeferredStepInput(result.session));
        assert.ok(
          !JSON.stringify(result.session.history).includes(
            "FOLLOWUP_MUST_BE_PROCESSED",
          ),
        );
        const failure =
          mode === "task"
            ? typeof result.next === "object"
              ? result.next?.output
              : ""
            : result.settledTurn?.output;
        assert.match(String(failure), /deferred|unprocessed/i);
        if (!noEvents)
          assert.equal(
            turn.events.filter((e) => e.type === "turn.failed").at(-1)?.data
              ?.code,
            "STEP_LIMIT_REACHED",
          );
      });
  }

for (const [model, override, expected] of [
  ["", "200000", 200000],
  ["sonnet", "200000", 200000],
  ["sonnet", undefined, 1000000],
  ["claude-haiku-4-5", undefined, 200000],
  ["claude-haiku-4-5", "1000000", 200000],
  ["future-model", "1000000", 200000],
] as const)
  test(`N5 exact Claude helper window: ${model || "same"} ${override ?? "default"}`, async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODEL_PROVIDER: "claude",
      CLAUDE_MODEL: "sonnet",
      HELPER_MODEL: model,
    };
    delete env.CLAUDE_CONTEXT_WINDOW;
    if (override) env.CLAUDE_CONTEXT_WINDOW = override;
    const logs: string[] = [];
    await runNode(
      [
        "--input-type=module",
        "-e",
        "import './scripts/lib/ts-esm-hooks.ts'; const {stepModelChoice}=await import('./agent/agent.ts'); console.log(stepModelChoice({session:{id:'h',auth:{initiator:{authenticator:'iva-bearer',attributes:{iva_turn:'helper'}}}}}).contextWindow);",
      ],
      process.cwd(),
      env,
      (line) => logs.push(line),
    );
    assert.equal(Number(logs.at(-1)), expected);
  });

test("N6 observer sees different ordered tool sets, missing helper block and disabled logging", async () => {
  const logs: string[] = [];
  await runNode(
    [
      "--input-type=module",
      "-e",
      `import './scripts/lib/ts-esm-hooks.ts'; globalThis.fetch=async()=>{throw Error('fixture stop')}; const {makeTextModel}=await import('./agent/provider.ts'); const call=async(tools,block)=>makeTextModel({model:'fixture',chatModelSeesImages:async()=>false}).doStream({prompt:[{role:'system',content:block?'You are a background helper of Iva;':'ordinary'}],tools}).catch(()=>{}); const tool=n=>({type:'function',name:n,inputSchema:{type:'object',properties:{}}}); await call([tool('a')],true); await call([tool('b'),tool('c')],false); delete process.env.IVA_LIVE_WIRE; await call([tool('silent')],true);`,
    ],
    process.cwd(),
    { ...process.env, IVA_LIVE_WIRE: "1" },
    (line) => logs.push(line),
  );
  const rows = logs
    .filter((line) => line.startsWith("LIVE_HELPER_WIRE "))
    .map(
      (line) =>
        JSON.parse(line.slice(17)) as {
          hash: string;
          tools: number;
          helperBlock: boolean;
        },
    );
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].hash, rows[1].hash);
  assert.deepEqual(
    rows.map((r) => [r.tools, r.helperBlock]),
    [
      [1, true],
      [2, false],
    ],
  );
});

test("N6 bad helper id with absent or foreign bearer stays 401 in local-dev", async () => {
  const { createEveAuth } = await import("../agent/lib/eve-auth.ts");
  const { routeAuth } = await import("eve/channels/auth");
  const previous = process.env.EVE_DEV;
  process.env.EVE_DEV = "1";
  try {
    for (const bearer of [undefined, "Bearer foreign"]) {
      const headers: Record<string, string> = {
        "x-iva-turn": "helper",
        "x-iva-helper": "bad",
      };
      if (bearer) headers.authorization = bearer;
      const response = await routeAuth(
        new Request("http://127.0.0.1/eve", { headers }),
        createEveAuth({ ASSISTANT_BEARER: "fixture", EVE_DEV: "1" }),
      );
      assert.ok(response instanceof Response);
      assert.equal(response.status, 401);
    }
  } finally {
    if (previous === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = previous;
  }
});
