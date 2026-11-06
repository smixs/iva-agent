/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "iva-background-model-"));
process.env.ASSISTANT_DATA_DIR = home;
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
process.env.OLLAMA_CONTEXT_WINDOW = "8000";
process.env.HELPER_MODEL = "helper-fixture";
after(() => rmSync(home, { recursive: true, force: true }));
const { stepModelChoice } = await import("../agent/agent.ts");
const kinds = ["helper", "watch", "brief", "insight"];
const chatKinds = ["reminder", "signal", "alert", undefined];
const context = (
  kind: string | undefined,
  authenticator = "iva-bearer",
  side = "initiator",
) => ({
  session: {
    id: "background-fixture",
    auth: { [side]: { authenticator, attributes: { iva_turn: kind } } },
  },
});

test("background model: authenticated helper, Watch, Brief and Insight share model and window", () => {
  for (const side of ["initiator", "current"])
    for (const kind of [...kinds, ...chatKinds]) {
      const choice = stepModelChoice(context(kind, "iva-bearer", side));
      assert.equal(
        choice.model,
        kinds.includes(kind ?? "") ? "helper-fixture" : "chat-fixture",
        `${side}/${kind}`,
      );
      assert.equal(choice.contextWindow, 8000);
      assert.equal(choice.sessionId, "background-fixture");
      assert.equal(
        stepModelChoice(context(kind, "telegram", side)).model,
        "chat-fixture",
      );
    }
});

test("background model: empty, whitespace and absent HELPER_MODEL fall back to chat on Ollama", () => {
  for (const value of ["", "   ", undefined]) {
    if (value === undefined) delete process.env.HELPER_MODEL;
    else process.env.HELPER_MODEL = value;
    for (const kind of kinds)
      assert.equal(stepModelChoice(context(kind)).model, "chat-fixture");
  }
});

test("background model: Claude defaults, explicit chat and selected model windows match helper", () => {
  for (const [model, override, expectedModel, expectedWindow] of [
    [undefined, undefined, "claude-sonnet-5-5", 1000000],
    ["", undefined, "claude-opus-5-5", 1000000],
    ["claude-haiku-4-5", undefined, "claude-haiku-4-5", 200000],
    ["claude-haiku-4-5", "123456", "claude-haiku-4-5", 123456],
  ] as const) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODEL_PROVIDER: "claude",
      CLAUDE_MODEL: "claude-opus-5-5",
    };
    delete env.CLAUDE_CONTEXT_WINDOW;
    delete env.HELPER_MODEL;
    if (model !== undefined) env.HELPER_MODEL = model;
    if (override !== undefined) env.CLAUDE_CONTEXT_WINDOW = override;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import './scripts/lib/ts-esm-hooks.ts';
      const { stepModelChoice } = await import('./agent/agent.ts');
      console.log(JSON.stringify(${JSON.stringify([...kinds, ...chatKinds])}.map(kind => {
        const choice = stepModelChoice({session:{id:'background',auth:{initiator:{authenticator:'iva-bearer',attributes:{iva_turn:kind}}}}});
        return { model: choice.model, window: choice.contextWindow };
      })));
    `,
        ],
        { cwd: import.meta.dirname + "/..", env, encoding: "utf8" },
      ),
    ) as { model: string; window: number }[];
    assert.deepEqual(
      result.slice(0, 4),
      kinds.map(() => ({ model: expectedModel, window: expectedWindow })),
    );
    assert.deepEqual(
      result.slice(4),
      chatKinds.map(() => ({
        model: "claude-opus-5-5",
        window: override ? Number(override) : 1000000,
      })),
    );
  }
});
