/* eslint-disable @typescript-eslint/no-floating-promises -- Node test registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { isEmptyModelResponse, stepLimitNotice } from "./model-response.ts";
const seed = Number(process.env.FC_SEED ?? 20261020);
test(`empty response uses the semantic id independently of prose; seed ${seed}`, () => {
  fc.assert(
    fc.property(fc.string(), (message) => {
      assert.equal(
        isEmptyModelResponse({
          message,
          details: { semanticErrorId: "empty-model-response" },
        }),
        true,
      );
      assert.equal(isEmptyModelResponse({ message }), false);
    }),
    { seed, numRuns: 100 },
  );
});
for (const message of [
  "EmptyModelResponseError",
  "The model did not return a response",
  "provider down",
])
  test(`prose alone is not a semantic failure marker: ${message}`, () => {
    assert.equal(isEmptyModelResponse({ message }), false);
  });
for (const n of [1, 11, 21, 40, 101, 111, 121])
  test(`r339 ceiling notice uses the correct step form for ${n}`, () => {
    const failure = { code: "STEP_LIMIT_REACHED", stepIndex: n - 1 };
    const singular = n % 10 === 1 && n % 100 !== 11;
    assert.equal(
      stepLimitNotice(failure, (_, ru) => ru),
      `Остановилась на ${n} ${singular ? "шаге" : "шагах"} и не успела подвести итог.`,
    );
    assert.equal(
      stepLimitNotice(failure, (en) => en),
      `Stopped after ${n} ${n === 1 ? "step" : "steps"} without a final summary.`,
    );
  });
