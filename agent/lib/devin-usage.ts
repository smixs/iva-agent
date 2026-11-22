import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function tokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid Devin usage");
  return value;
}

/** Read only this invocation's isolated session, before its temporary state is removed.
 * ACP usage_update describes the latest context, repeats snapshots and lacks request IDs.
 * The CLI's persisted request metrics account for all internal model calls instead.
 * Missing, inconsistent or changed schemas remain unknown; accounting must not fail a turn.
 */
export function readDevinUsage(
  state: string,
  sessionId: string,
): LanguageModelV4Usage | undefined {
  const file = join(state, "devin", "cli", "sessions.db");
  if (!sessionId || !existsSync(file)) return undefined;
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    // Lazy builtin loading avoids initializing SQLite for other providers.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT json_extract(chat_message, '$.metadata') AS metadata FROM message_nodes WHERE session_id = ?",
      )
      .all(sessionId);
    const requests = new Map<string, readonly number[]>();
    for (const row of rows) {
      if (row.metadata === null) continue;
      if (typeof row.metadata !== "string") return undefined;
      const metadata = object(JSON.parse(row.metadata));
      if (!metadata || metadata.metrics == null) continue;
      const metrics = object(metadata.metrics);
      if (
        !metrics ||
        typeof metadata.request_id !== "string" ||
        !metadata.request_id
      )
        return undefined;
      // CLI input_tokens excludes cached reads/writes. context_input_tokens includes them.
      const fresh = tokens(metrics.input_tokens);
      const output = tokens(metrics.output_tokens);
      const read =
        metrics.cache_read_tokens == null
          ? 0
          : tokens(metrics.cache_read_tokens);
      const write =
        metrics.cache_creation_tokens == null
          ? 0
          : tokens(metrics.cache_creation_tokens);
      const total = tokens(fresh + read + write);
      if (
        metrics.context_input_tokens != null &&
        tokens(metrics.context_input_tokens) !== total
      )
        return undefined;
      const current = [fresh, output, read, write];
      const previous = requests.get(metadata.request_id);
      if (previous && previous.some((n, index) => n !== current[index]))
        return undefined;
      requests.set(metadata.request_id, current);
    }
    if (!requests.size) return undefined;
    const sum = [0, 0, 0, 0];
    for (const values of requests.values())
      for (let i = 0; i < sum.length; i++) sum[i] = tokens(sum[i] + values[i]);
    const [noCache, output, cacheRead, cacheWrite] = sum;
    return {
      inputTokens: {
        total: tokens(noCache + cacheRead + cacheWrite),
        noCache,
        cacheRead,
        cacheWrite,
      },
      outputTokens: { total: output, text: undefined, reasoning: undefined },
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Accounting never changes the outcome of the model call.
    }
  }
}
