import { test } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import { accountFromIdToken } from "../../packages/codex-auth/index.ts";
import {
  listCodexModelCatalog,
  parseCodexModelCatalog,
} from "./codex-oauth.ts";

const idToken = (auth: Record<string, unknown>): string =>
  [
    "header",
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": auth }),
    ).toString("base64url"),
    "signature",
  ].join(".");

test("account claims accept only non-empty strings", () => {
  assert.deepEqual(
    accountFromIdToken(
      idToken({
        chatgpt_account_id: { unexpected: true },
        chatgpt_plan_type: 42,
      }),
    ),
    { accountId: null, planType: null },
  );
  assert.deepEqual(
    accountFromIdToken(
      idToken({ chatgpt_account_id: "account", chatgpt_plan_type: "pro" }),
    ),
    { accountId: "account", planType: "pro" },
  );
});

test("catalog parser supports model/slug/id/name and preserves quoted Unicode IDs", () => {
  const parsed = parseCodexModelCatalog({
    result: {
      items: [
        {
          model: "gpt-5.5",
          supported_reasoning_levels: [
            "minimal",
            { effort: "low" },
            { level: "MAX" },
            "ultra",
          ],
        },
        {
          slug: 'gpt-"кавычка"',
          supported_reasoning_levels: [{ id: "medium" }],
        },
        { id: "preset-id", supported_reasoning_levels: [{ name: "high" }] },
        { name: "модель-имя", supported_reasoning_levels: [] },
      ],
    },
    tiers: [{ id: "not-a-model" }],
  });

  const byId = Object.fromEntries(
    parsed.map((entry) => [entry.id, entry.reasoningLevels]),
  );
  assert.deepEqual(byId["gpt-5.5"], ["minimal", "low", "max"]);
  assert.deepEqual(byId['gpt-"кавычка"'], ["medium"]);
  assert.deepEqual(byId["preset-id"], ["high"]);
  assert.deepEqual(byId["модель-имя"], ["low", "medium", "high"]);
  assert.equal(byId["not-a-model"], undefined);
});

test("catalog parser handles strings, nested wrappers, empty and malformed input", () => {
  assert.deepEqual(parseCodexModelCatalog(null), []);
  assert.deepEqual(
    parseCodexModelCatalog({ models: [null, {}, "", "   ", { model: 42 }] }),
    [],
  );
  assert.deepEqual(parseCodexModelCatalog(["gpt-5", "модель"]), [
    { id: "gpt-5", reasoningLevels: ["low", "medium", "high"] },
    { id: "модель", reasoningLevels: ["low", "medium", "high"] },
  ]);
  assert.deepEqual(
    parseCodexModelCatalog({
      envelope: {
        data: [{ model: "gpt-6", supported_reasoning_levels: "bad" }],
      },
    }),
    [{ id: "gpt-6", reasoningLevels: ["low", "medium", "high"] }],
  );
});

test("model catalog and reasoning levels come from one HTTP request", async () => {
  let requests = 0;
  const result = await listCodexModelCatalog({
    dataDir: "/unused",
    authHeadersFn: async () => ({ Authorization: "Bearer test" }),
    fetchFn: async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          models: [
            { model: "gpt-5.5", supported_reasoning_levels: ["low", "high"] },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result, [
    { id: "gpt-5.5", reasoningLevels: ["low", "high"] },
  ]);
});
