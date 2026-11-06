/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import "./fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
import { reminderFromEvents } from "./fixtures/reminder-events.test-fixture.ts";
import { foldHelperSnapshot } from "../agent/lib/helper-snapshot.ts";
const home = await mkdtemp(join(tmpdir(), "iva-empty-response-"));
process.env.ASSISTANT_DATA_DIR = join(home, "data");
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.MODEL_PROVIDER = "ollama";
process.env.AGENT_LANGUAGE = "ru";
await mkdir(process.env.ASSISTANT_VAULT_DIR, { recursive: true });
after(() => rm(home, { recursive: true, force: true }));
for (const kind of [
  "reminder",
  "watch",
  "brief",
  "insight",
  "signal",
  "helper",
]) {
  for (const emptyN of [1, 2, 3, 4, Number.POSITIVE_INFINITY]) {
    test(`${kind}/conversation: ${emptyN} empty responses`, async () => {
      const turn = await wireTurn({ mode: "conversation", kind, emptyN });
      assert.equal(
        turn.model.doStreamCalls.length + turn.model.doGenerateCalls.length,
        Math.min(emptyN + 1, 4),
      );
      const exhausted = emptyN >= 4;
      assert.equal(
        turn.events.some((e) => e.type === "turn.failed"),
        exhausted,
      );
      const result = await reminderFromEvents(turn.events);
      assert.equal(result.status, exhausted ? "failed" : "waiting");
      if (exhausted) {
        assert.match(
          result.message ?? "",
          /The model did not return a response/,
        );
        assert.equal(foldHelperSnapshot(turn.events).outcome, "failed");
        assert.match(
          foldHelperSnapshot(turn.events).reason ?? "",
          /The model did not return a response/,
        );
      } else {
        assert.equal(result.message, "done");
        assert.equal(foldHelperSnapshot(turn.events).outcome, "done");
      }
    });
  }
}
