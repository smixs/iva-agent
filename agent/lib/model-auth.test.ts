/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns registrations. */
import "../../scripts/fixtures/no-host-anthropic.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  modelAuthFailure,
  modelAuthText,
  modelAuthRecoveryText,
} from "./model-auth.ts";

test("Claude CLI, Codex and API authentication failures share one classifier", () => {
  for (const message of [
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "not signed in",
    "run /login",
    "invalid x-api-key",
  ])
    assert.equal(modelAuthFailure(new Error(message), "claude"), "claude");
  for (const message of [
    "CODEX_AUTH_EXPIRED",
    'token refresh failed: 400 {"error":"invalid_grant"}',
    "not logged in — run iva login",
  ])
    assert.equal(modelAuthFailure(message, "codex"), "codex");
  assert.equal(
    modelAuthFailure({ statusCode: 401 }, "openrouter"),
    "openrouter",
  );
  assert.equal(
    modelAuthFailure(
      { statusCode: 403, message: "invalid token" },
      "openrouter",
    ),
    "openrouter",
  );
  assert.equal(
    modelAuthFailure(
      { statusCode: 403, message: "region unavailable" },
      "openrouter",
    ),
    null,
  );
});

test("non-auth statuses and network failures never become authentication alerts", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(429, 500, 503, 408, 402, 400),
      fc.string(),
      (statusCode, noise) => {
        assert.equal(
          modelAuthFailure(
            { statusCode, message: `fetch failed timeout ECONNRESET ${noise}` },
            "openrouter",
          ),
          null,
        );
      },
    ),
    { seed: 231023, numRuns: 200 },
  );
  for (const message of [
    "429 invalid API key",
    "503 invalid API key",
    "socket hang up",
    "timeout",
    "400 bad request",
    "403 forbidden",
  ])
    assert.equal(modelAuthFailure(message, "claude"), null);
});

test("authentication text gives provider-specific repair commands in ru and en", () => {
  assert.match(modelAuthText("claude", "ru"), /claude auth login/u);
  assert.match(modelAuthText("codex", "en"), /iva login/u);
  assert.match(modelAuthText("openrouter", "ru"), /замените ключ в \/menu/u);
  assert.doesNotMatch(modelAuthText("claude", "en"), /[а-яё]/iu);
});

test("generated authentication errors remain recognizable through details and network prose", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("claude", "codex", "openrouter"),
      fc.stringMatching(/^[a-zA-Z _-]{0,40}$/u),
      (provider, noise) => {
        const message =
          provider === "claude"
            ? "Failed to authenticate: OAuth session expired"
            : provider === "codex"
              ? "token refresh failed: 400 invalid_grant"
              : "HTTP 403 invalid token";
        assert.equal(
          modelAuthFailure(
            {
              message: "model call failed",
              details: JSON.stringify({
                apiErrorMessage: `${noise} ${message} network timeout`,
              }),
            },
            provider,
          ),
          provider,
        );
      },
    ),
    { seed: 231024, numRuns: 200 },
  );
});

test("error name cannot override the installation provider", () => {
  assert.equal(
    modelAuthFailure(
      { name: "ClaudeCliError", message: "Failed to authenticate" },
      "custom",
    ),
    "custom",
  );
});

test("English recovery separates catch-up and remaining-job instructions", () => {
  assert.match(
    modelAuthRecoveryText("claude", "en", ["memory-night", "proactive"]),
    /next run\. Check the remaining/u,
  );
});

test("REPAIR1: content numbers and auth words cannot hide or invent an error", () => {
  for (const tail of [
    "Card отброшено: бюджет 500 долларов\nClaudeCliError: OAuth session expired",
    "Error at line 512\nClaudeCliError: OAuth session expired",
    "Error at line 512\nOAuth session expired",
    "бюджет 500 долларов\nOAuth session expired",
  ])
    assert.equal(modelAuthFailure(tail, "claude"), "claude");
  assert.equal(
    modelAuthFailure(
      'token refresh failed: 400 {"error":"invalid_grant","request_id":"503"}',
      "codex",
    ),
    "codex",
  );
  for (const tail of [
    "Card отброшено: two-factor authentication site.com/login квартира 401\nAPI Error: 500 unavailable",
    "invalid token in json",
    "authentication",
    "Card отброшено: OAuth session expired\nAPI Error: 500 unavailable",
  ])
    assert.equal(modelAuthFailure(tail, "claude"), null);
  fc.assert(
    fc.property(
      fc.integer({ min: 400, max: 599 }),
      fc.constantFrom("login", "authentication", "401", "invalid token"),
      (n, word) => {
        const content = `Card отброшено: ${word} бюджет ${n} site.com/login`;
        assert.equal(modelAuthFailure(content, "claude"), null);
        assert.equal(
          modelAuthFailure(
            `${content}\nClaudeCliError: OAuth session expired`,
            "claude",
          ),
          "claude",
        );
        assert.equal(
          modelAuthFailure(`${content}\nAPI Error: 500 unavailable`, "claude"),
          null,
        );
      },
    ),
    { seed: 231025, numRuns: 200 },
  );
});
test("REPAIR1: configured provider and API-key wording", () => {
  assert.equal(modelAuthFailure("invalid_grant", "claude"), "claude");
  assert.equal(
    modelAuthFailure("ClaudeCliError: Failed to authenticate", "custom"),
    "custom",
  );
  assert.match(
    modelAuthText("custom", "ru"),
    /Ключ API, который использует Ива, не принимается/u,
  );
  assert.match(
    modelAuthText("custom", "en"),
    /API key used by Iva is not accepted/u,
  );
});
test("REPAIR1: unset provider uses the model runtime default", (t) => {
  const before = process.env.MODEL_PROVIDER;
  delete process.env.MODEL_PROVIDER;
  t.after(() => {
    if (before === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = before;
  });
  assert.equal(modelAuthFailure({ statusCode: 401 }), "ollama");
});
test("REPAIR1: API key explanation in both languages", () => {
  assert.match(
    modelAuthText("custom", "ru"),
    /Ключ API, который использует Ива, не принимается/u,
  );
  assert.match(
    modelAuthText("custom", "en"),
    /API key used by Iva is not accepted/u,
  );
});
