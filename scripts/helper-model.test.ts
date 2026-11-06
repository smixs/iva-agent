/* eslint-disable @typescript-eslint/require-await -- Fake provider implements async fetch. */
/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { eveInternals, wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "text-fixture";
process.env.OLLAMA_CONTEXT_WINDOW = "8000";
process.env.OLLAMA_API_KEY = "fixture-key";
process.env.OLLAMA_BASE_URL = "https://fixture.invalid/v1";
process.env.HELPER_MODEL = "deepseek-v4-pro";
const home = await mkdtemp(join(tmpdir(), "iva-model-test-"));
process.env.ASSISTANT_DATA_DIR = home;
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
const { default: usageHook } = await import("../agent/hooks/usage.ts");
const { default: agent, stepModelChoice } = await import("../agent/agent.ts");
const { providerConfig } = await import("../agent/provider.ts");
const { resolveRuntimeModelSelection } =
  await import("../node_modules/eve/dist/src/runtime/agent/resolve-model.js");
const { MODEL_PROVIDERS } = await import("../agent/lib/model-provider.ts");

test("F14: concurrent chat and helper use separate wire models and image verdicts with provider windows and thresholds", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
    return rm(home, { recursive: true, force: true });
  });
  const wire: { model: string; stream: boolean }[] = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(typeof init?.body, "string");
    const body = JSON.parse(init!.body as string) as {
      model: string;
      stream?: boolean;
    };
    wire.push({ model: body.model, stream: body.stream === true });
    if (!body.stream)
      return Response.json({
        id: "probe",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: body.model === "deepseek-v4-pro" ? "red" : "blue",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    const data = [
      {
        id: "answer",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "done" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "answer",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    ];
    return new Response(
      data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const eve = await eveInternals();
  const choices: ReturnType<typeof stepModelChoice>[] = [];
  async function run(kind: string) {
    return wireTurn({
      kind,
      onStep: async (ctx) => {
        const resolved = eve.buildResolveContext(ctx, []);
        const choice = stepModelChoice(resolved);
        choices.push(choice);
        assert.ok(Object.isFrozen(choice));
        const selection = await agent.model.events["step.started"]!(
          { type: "step.started", data: { stepIndex: 0 } },
          resolved,
        );
        const live = await resolveRuntimeModelSelection({
          selection,
          state: ctx,
          durability: "live",
        });
        ctx.setVirtualContext(eve.LiveStepDynamicModelSelectionKey, live);
      },
    });
  }
  const [chat, helper] = await Promise.all([run("chat"), run("helper")]);
  assert.ok(wire.some((w) => w.stream && w.model === "text-fixture"));
  assert.ok(wire.some((w) => w.stream && w.model === "deepseek-v4-pro"));
  assert.equal(
    chat.result.session.agent.modelReference?.contextWindowTokens,
    8000,
  );
  assert.equal(
    helper.result.session.agent.modelReference?.contextWindowTokens,
    8000,
  );
  assert.equal(chat.result.session.compaction.threshold, 6000);
  assert.equal(helper.result.session.compaction.threshold, 6000);
  for (const kind of [
    "watch",
    "brief",
    "insight",
    "reminder",
    "signal",
    "alert",
  ]) {
    const start = wire.length;
    const turn = await run(kind);
    const expectedModel = ["watch", "brief", "insight"].includes(kind)
      ? "deepseek-v4-pro"
      : "text-fixture";
    assert.ok(
      wire
        .slice(start)
        .some((request) => request.stream && request.model === expectedModel),
      kind,
    );
    assert.equal(
      turn.result.session.agent.modelReference?.contextWindowTokens,
      8000,
    );
  }
  const verdicts = new Map(
    await Promise.all(
      choices.map(async (c) => [c.model, await c.seesImages()] as const),
    ),
  );
  assert.equal(verdicts.get("text-fixture"), false);
  assert.equal(verdicts.get("deepseek-v4-pro"), true);
  await Promise.all(choices.map((c) => c.seesImages()));
  assert.equal(wire.filter((w) => !w.stream).length, 2);
  await writeFile(join(home, "usage.jsonl"), "");
  for (const turn of [chat, helper]) {
    const ctx = turn.authored.eve.buildResolveContext(turn.ctx, []);
    await usageHook.events!["step.completed"]!(
      {
        data: {
          providerModelId: turn === helper ? "deepseek-v4-pro" : "text-fixture",
          stepIndex: 0,
          turnId: ctx.session.id,
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      } as never,
      { ...ctx, channel: { kind: "http" } } as never,
    );
  }
  const rows = (await readFile(join(home, "usage.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { model: string });
  assert.deepEqual(
    rows.map((row) => row.model),
    ["text-fixture", "deepseek-v4-pro"],
  );
  assert.equal(providerConfig.textModel, "text-fixture");
  assert.equal(providerConfig.contextWindow, 8000);
  assert.equal(process.env.OLLAMA_MODEL, "text-fixture");
});
test("helper defaults and unknown windows", () => {
  for (const [name, p] of Object.entries(MODEL_PROVIDERS))
    assert.equal(
      p.defaultHelperModel,
      name === "claude" ? "claude-sonnet-5-5" : null,
    );
  process.env.HELPER_MODEL = "";
  assert.equal(
    stepModelChoice({
      session: {
        id: "helper",
        auth: {
          initiator: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: "helper" },
          },
        },
      },
    }).model,
    "text-fixture",
  );
});
