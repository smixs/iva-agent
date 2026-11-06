/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  CONTEXT_WINDOW_CONFIGURATION_ERROR,
  ContextWindowConfigurationError,
  resolveContextWindow,
  providerContextWindow,
  claudeContextWindow,
} from "./context-window.ts";

const VARIABLE = "OLLAMA_CONTEXT_WINDOW";
const FALLBACK = 131_072;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function exactPositiveSafeInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const exact = BigInt(raw);
  if (exact <= 0n || exact > MAX_SAFE_INTEGER) return null;
  return Number(exact);
}

test("context window accepts positive safe integers and the configured fallback", () => {
  assert.equal(resolveContextWindow(VARIABLE, undefined, FALLBACK), FALLBACK);
  assert.equal(resolveContextWindow(VARIABLE, "1", FALLBACK), 1);
  assert.equal(
    resolveContextWindow(VARIABLE, String(Number.MAX_SAFE_INTEGER), FALLBACK),
    Number.MAX_SAFE_INTEGER,
  );
});

test("context window rejects every invalid numeric boundary with one typed error", () => {
  for (const raw of [
    "NaN",
    "0",
    "-7",
    "1.5",
    "1.0000000000000001",
    "9007199254740990.5",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.throws(
      () => resolveContextWindow(VARIABLE, raw, FALLBACK),
      (error: unknown) => {
        assert.ok(error instanceof ContextWindowConfigurationError);
        assert.equal(error.code, CONTEXT_WINDOW_CONFIGURATION_ERROR);
        assert.equal(error.variable, VARIABLE);
        assert.equal(error.value, raw);
        assert.equal(
          error.message,
          `Invalid ${VARIABLE} ${JSON.stringify(raw)}; expected a positive safe integer — run: iva config`,
        );
        return true;
      },
      raw,
    );
  }
});

test("property: arbitrary strings resolve to a positive safe integer or the typed error", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), (raw) => {
      const exact = exactPositiveSafeInteger(raw);
      if (exact !== null) {
        assert.equal(resolveContextWindow(VARIABLE, raw, FALLBACK), exact);
        return;
      }

      assert.throws(
        () => resolveContextWindow(VARIABLE, raw, FALLBACK),
        (error: unknown) =>
          error instanceof ContextWindowConfigurationError &&
          error.code === CONTEXT_WINDOW_CONFIGURATION_ERROR,
      );
    }),
    { seed: 18802, numRuns: 1_000 },
  );
});

test("provider windows share defaults, explicit overrides and blank handling", () => {
  const providers = [
    "claude",
    "codex",
    "ollama",
    "opencode",
    "openrouter",
    "custom",
  ];
  fc.assert(
    fc.property(
      fc.constantFrom(...providers),
      fc.integer({ min: 1, max: 2_000_000 }),
      (provider, override) => {
        const variable = `${provider.toUpperCase()}_CONTEXT_WINDOW`;
        assert.equal(
          providerContextWindow(provider, "claude-fable-5-1", {
            [variable]: String(override),
          }),
          override,
        );
        const fallback =
          provider === "claude"
            ? 1_000_000
            : provider === "codex"
              ? 272_000
              : 131_072;
        assert.equal(
          providerContextWindow(provider, "claude-fable-5-1", {}),
          fallback,
        );
        assert.equal(
          providerContextWindow(provider, "claude-fable-5-1", {
            [variable]: "",
          }),
          fallback,
        );
      },
    ),
    { seed: 10312026, numRuns: 150 },
  );
});

test("Claude windows preserve runtime aliases, old Haiku and the safe unknown-model default", () => {
  for (const model of [
    "fable",
    "opus[1m]",
    "sonnet",
    "haiku",
    "claude-haiku-5-5",
  ]) {
    assert.equal(claudeContextWindow(model), 1_000_000);
    assert.equal(providerContextWindow("claude", model, {}), 1_000_000);
  }
  for (const model of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "future-model",
  ]) {
    assert.equal(claudeContextWindow(model), 200_000);
    assert.equal(providerContextWindow("claude", model, {}), 200_000);
  }
});
