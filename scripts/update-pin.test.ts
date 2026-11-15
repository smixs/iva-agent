import "./fixtures/no-host-anthropic.ts";
import test from "node:test";
import { assertPinnedFinal } from "./fixtures/update-pin-harness.ts";
await test(
  "UpdateRun FinalOnlyWhenPinned: UpdateJob waits for active.json",
  assertPinnedFinal,
);
