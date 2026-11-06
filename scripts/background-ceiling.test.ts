/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
import { reminderFromEvents } from "./fixtures/reminder-events.test-fixture.ts";
import { foldHelperSnapshot } from "../agent/lib/helper-snapshot.ts";
const root = await mkdtemp(join(tmpdir(), "iva-r339-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_VAULT_DIR = join(root, "vault");
process.env.MODEL_PROVIDER = "ollama";
await mkdir(process.env.ASSISTANT_VAULT_DIR, { recursive: true });
after(() => rm(root, { recursive: true, force: true }));
for (const kind of [
  "reminder",
  "signal",
  "watch",
  "brief",
  "insight",
  "alert",
  "helper",
])
  test(`r339 ${kind}: empty final step retains machine failure metadata`, async () => {
    const turn = await wireTurn({
      mode: "conversation",
      kind,
      attributes: { iva_max_steps: "2" },
      calls: 1,
      emptyLast: true,
    });
    const failed = turn.events.find((e) => e.type === "turn.failed");
    assert.equal(failed?.data?.code, "STEP_LIMIT_REACHED");
    assert.equal(
      turn.events.some((e) => e.type === "turn.completed"),
      false,
    );
    const result = await reminderFromEvents(turn.events);
    assert.equal(result.status, "failed");
    assert.equal(result.failureInfo?.code, "STEP_LIMIT_REACHED");
    assert.equal(result.failureInfo?.stepIndex, 1);
    assert.equal(
      result.failureInfo?.details?.semanticErrorId,
      "empty-model-response",
    );
    const snapshot = foldHelperSnapshot(turn.events);
    assert.equal(snapshot.failureInfo?.code, "STEP_LIMIT_REACHED");
    assert.equal(snapshot.failureInfo?.stepIndex, 1);
  });
