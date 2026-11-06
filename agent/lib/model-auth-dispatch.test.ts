import "../../scripts/fixtures/no-host-anthropic.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAuthDispatcher,
  dispatchModelAuth,
} from "./model-auth-dispatch.ts";
import { readModelAuthStatuses } from "./model-auth-state.ts";

await test("the agent serializes ticks and observations, continues after child failure", async () => {
  let running = 0;
  const seen: string[] = [];
  const dispatch = createAuthDispatcher(async (observation) => {
    assert.equal(running++, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    seen.push(observation?.provider ?? "tick");
    running--;
  });
  await Promise.all([
    dispatch({ provider: "claude", at: 1, failed: true }),
    dispatch(),
    dispatch({ provider: "codex", at: 2, failed: true }),
  ]);
  assert.deepEqual(seen, ["claude", "tick", "codex"]);
  let count = 0;
  const retry = createAuthDispatcher(() => {
    if (++count === 1) throw new Error("child failed");
    return Promise.resolve();
  });
  await retry();
  await retry();
  assert.equal(count, 2);
});

await test("real hook records all turn kinds in the agent and a successful model call recovers", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-auth-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = [
    "ASSISTANT_DATA_DIR",
    "MODEL_PROVIDER",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ];
  const before = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    }),
  );
  process.env.ASSISTANT_DATA_DIR = dir;
  process.env.MODEL_PROVIDER = "claude";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  await import("../../scripts/lib/ts-esm-hooks.ts");
  const { default: hook } = await import("../hooks/model-auth.ts");
  type Handler = (event: unknown, ctx: unknown) => Promise<void>;
  const fail = hook.events?.["turn.failed"] as unknown as Handler;
  const success = hook.events?.["step.completed"] as unknown as Handler;
  for (const kind of [
    "channel:telegram",
    "watch",
    "brief",
    "wake",
    "reminder",
    "helper",
  ]) {
    await fail(
      {
        data: {
          message: "Failed to authenticate: OAuth session expired",
          details: {},
        },
      },
      { channel: { kind } },
    );
    await dispatchModelAuth();
    if (kind !== "channel:telegram")
      assert.equal(readModelAuthStatuses(dir)[0]?.provider, "claude");
  }
  assert.equal(readModelAuthStatuses(dir)[0]?.answers, false);
  await success({ data: { usage: { inputTokens: 1 } } }, {});
  await dispatchModelAuth();
  const status = readModelAuthStatuses(dir)[0];
  assert.ok(status.successAt >= status.failedAt);
});
