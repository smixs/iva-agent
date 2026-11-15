import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "../../packages/reasoning-levels/index.ts";

void test("the conservative fallback stays a subset of the vocabulary", () => {
  for (const effort of FALLBACK_REASONING_EFFORTS)
    assert.ok(CANONICAL_REASONING_EFFORTS.includes(effort), effort);
});
