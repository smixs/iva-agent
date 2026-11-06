// One call's Claude access rotation: no refresh, durable state or delivery path.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { dataDir } from "./data-dir.ts";
import { readSettings } from "./settings.ts";

export const CLAUDE_AUTH_ROTATION_WAIT_MS = 120_000;
const CLAUDE_AUTH_POLL_MS = 250;
const MAX_TIMER_MS = 2 ** 31 - 1;
type AuthSnapshot = {
  fingerprint?: string;
  source: "external" | "refresh" | "unknown";
};
export type ClaudeTurn = { readonly turnId: string; readonly step: number };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only an opaque access fingerprint and source kind escape this reader. */
export function readClaudeAuthSnapshot(): AuthSnapshot {
  try {
    const dir =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const oauth = record(
      record(JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")))
        .claudeAiOauth,
    );
    if (typeof oauth.accessToken !== "string" || !oauth.accessToken.trim())
      return { source: "unknown" };
    return {
      fingerprint: createHash("sha256")
        .update(oauth.accessToken, "utf8")
        .digest("hex"),
      source:
        typeof oauth.refreshToken === "string" && oauth.refreshToken.trim()
          ? "refresh"
          : "external",
    };
  } catch {
    // Parser and filesystem errors can contain secret bytes or paths. Keep neither.
    return { source: "unknown" };
  }
}

export function claudeAuthRotationWaitMs(): number {
  const value = record(
    readSettings(join(dataDir(), "settings.json")).claude,
  ).authRotationWaitMs;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMER_MS
    ? value
    : CLAUDE_AUTH_ROTATION_WAIT_MS;
}

/** A synthetic user note after tools cannot erase a known later-step boundary. */
export function claudeAuthReplaySafe(
  prompt: LanguageModelV4Prompt,
  turn?: ClaudeTurn,
): boolean {
  let lastUser = prompt.length - 1;
  while (lastUser >= 0 && prompt[lastUser].role !== "user") lastUser--;
  if (
    lastUser < 0 ||
    prompt.slice(lastUser + 1).some((message) => message.role !== "system")
  )
    return false;
  if (turn !== undefined)
    return turn.turnId.trim().length > 0 && turn.step === 0;
  return prompt.every(
    (message) => message.role === "system" || message.role === "user",
  );
}

function waitForRotation(
  before: AuthSnapshot,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      clearTimeout(windowTimer);
      clearTimeout(pollTimer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () =>
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Claude auth rotation was aborted"),
      );
    const changed = () => {
      const next = readClaudeAuthSnapshot().fingerprint;
      return next !== undefined && next !== before.fingerprint;
    };
    if (changed() || waitMs === 0) {
      resolve();
      return;
    }
    const poll = () => {
      if (changed()) finish();
      else pollTimer = setTimeout(poll, Math.min(CLAUDE_AUTH_POLL_MS, waitMs));
    };
    signal.addEventListener("abort", abort, { once: true });
    const windowTimer = setTimeout(finish, waitMs);
    pollTimer = setTimeout(poll, Math.min(CLAUDE_AUTH_POLL_MS, waitMs));
  });
}

/** Recovery surrounds the attempt, including its deadline and fully owned CLI session. */
export function claudeAuthRotationStream(
  options: LanguageModelV4CallOptions,
  turn: ClaudeTurn | undefined,
  attempt: (
    options: LanguageModelV4CallOptions,
  ) => PromiseLike<LanguageModelV4StreamResult>,
  is401: (error: unknown) => boolean,
): LanguageModelV4StreamResult {
  const cancel = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, cancel.signal])
    : cancel.signal;
  let reader:
    ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
  let completed = Promise.resolve();
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        let useful = false;
        const forwardAttempt = async (call: number) => {
          const result = await attempt({ ...options, abortSignal: signal });
          reader = result.stream.getReader();
          if (signal.aborted) await reader.cancel(signal.reason);
          signal.throwIfAborted();
          for (;;) {
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) return;
            if (
              part.value.type !== "stream-start" &&
              part.value.type !== "response-metadata"
            )
              useful = true;
            if (call === 0 || part.value.type !== "stream-start")
              controller.enqueue(part.value);
          }
        };
        const pump = async () => {
          signal.throwIfAborted();
          const snapshot = readClaudeAuthSnapshot();
          const waitMs = claudeAuthRotationWaitMs();
          const safe = claudeAuthReplaySafe(options.prompt, turn);
          for (let call = 0; call < 2; call++) {
            signal.throwIfAborted();
            try {
              await forwardAttempt(call);
              controller.close();
              return;
            } catch (error) {
              signal.throwIfAborted();
              if (call !== 0 || useful || !safe || !is401(error)) throw error;
            } finally {
              reader?.releaseLock();
              reader = undefined;
            }
            await waitForRotation(snapshot, waitMs, signal);
          }
        };
        completed = pump().catch((error) => {
          // reader.cancel owns closure; an external abort still reports its reason.
          if (!cancel.signal.aborted) controller.error(error);
        });
      },
      async cancel(reason) {
        cancel.abort(reason);
        await reader?.cancel(reason).catch(() => undefined);
        await completed;
      },
    }),
  };
}
