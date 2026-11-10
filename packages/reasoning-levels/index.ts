// Stable reasoning vocabulary understood by the runtime protocol: agent/provider.ts checks
// THINKING_EFFORT against it, the /think buttons and `iva config` offer it. One list for
// both trees, loadable on installs whose agent/ is missing.
// Telegram shows a model's live subset, with a conservative fallback when the
// catalog is unavailable. `ultra` is intentionally unsupported.
export const CANONICAL_REASONING_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const FALLBACK_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
]);
