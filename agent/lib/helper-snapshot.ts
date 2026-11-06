import type { ModelFailure } from "./model-response.ts";
import assert from "node:assert/strict";
import { type HelperOutcome, HELPER_SUMMARY_MAX } from "./helper-store.ts";
export function isQuietReply(text: string): boolean {
  return /^[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*quiet[\s\u200B-\u200D\u2060\uFEFF*_`"'«».!]*$/iu.test(
    text,
  );
}
export function helperSummary(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length <= HELPER_SUMMARY_MAX
    ? trimmed || null
    : trimmed
        .slice(0, HELPER_SUMMARY_MAX - 1)
        .replace(/[\uD800-\uDBFF]$/u, "") + "…";
}
type Usage = { inputTokens?: number; outputTokens?: number };
const ends: Record<string, HelperOutcome> = {
  "turn.completed": "done",
  "session.completed": "done",
  "turn.failed": "failed",
  "session.failed": "failed",
  "input.requested": "failed",
  "authorization.required": "failed",
  "turn.cancelled": "interrupted",
};
export function foldHelperSnapshot(
  events: readonly { type: string; data?: unknown }[],
) {
  let text: string | null = null,
    model: string | null = null,
    started: string | null = null,
    steps = 0,
    tokens = 0,
    previous = 0,
    ended = false,
    outcome: HelperOutcome = "empty",
    reason: string | null = null,
    failureInfo: ModelFailure | undefined;
  for (const event of events) {
    if (!event || typeof event.type !== "string")
      throw Error("invalid helper snapshot");
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (!ended && event.type === "step.failed") failureInfo = d;
    if (event.type === "session.completed") assert.equal(event.data, undefined);
    if (Object.hasOwn(ends, event.type) && event.type !== "session.completed") {
      assert.equal(Object.getPrototypeOf(event.data), Object.prototype);
      if (event.type !== "session.failed")
        assert.ok(Number.isFinite(d.sequence));
      if (d.reason !== undefined) assert.equal(typeof d.reason, "string");
      if (event.type.endsWith(".failed"))
        assert.equal(typeof d.message, "string");
    }
    if (event.type === "message.completed") {
      assert.equal(Object.getPrototypeOf(event.data), Object.prototype);
      assert.ok(d.message === null || typeof d.message === "string");
      if (typeof d.message === "string") text = d.message;
    }
    if (event.type === "step.started" && typeof d.modelId === "string")
      started = d.modelId;
    if (event.type === "step.completed") {
      assert.equal(Object.getPrototypeOf(event.data), Object.prototype);
      const usage = (d.usage === undefined ? {} : d.usage) as Usage;
      assert.equal(Object.getPrototypeOf(usage), Object.prototype);
      assert.ok(Object.values(usage).every(Number.isFinite));
      steps++;
      tokens +=
        Math.max(0, (usage.inputTokens ?? 0) - previous) +
        (usage.outputTokens ?? 0);
      previous = usage.inputTokens ?? 0;
      model = typeof d.providerModelId === "string" ? d.providerModelId : null;
    }
    if (!ended && Object.hasOwn(ends, event.type)) {
      ended = true;
      outcome = ends[event.type];
      if (outcome === "failed") {
        reason = d.message as string;
        failureInfo = { ...failureInfo, ...d };
      }
      if (event.type === "input.requested") reason = "помощник ждал ответа";
      if (event.type === "authorization.required")
        reason = "помощник ждал авторизации";
      if (outcome === "done" && d.reason === "step-limit") {
        outcome = "ceiling";
        reason = "предел работы";
      }
    }
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw Error("invalid helper usage");
  if (outcome === "done" && (!text?.trim() || isQuietReply(text)))
    outcome = "empty";
  return {
    text,
    ended,
    outcome,
    reason,
    failureInfo,
    model: model ?? started,
    steps,
    tokens,
  };
}
