import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import fc from "fast-check";
import { readDevinUsage } from "./devin-usage.ts";

void test("request metrics preserve totals under duplicates, ordering and foreign sessions (seed 20261122)", (t) => {
  const state = mkdtempSync(join(tmpdir(), "iva-devin-property-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  mkdirSync(join(state, "devin/cli"), { recursive: true });
  const db = new DatabaseSync(join(state, "devin/cli/sessions.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE message_nodes(session_id TEXT, chat_message TEXT)");
  const insert = db.prepare("INSERT INTO message_nodes VALUES (?, ?)");
  const metric = fc.record({
    fresh: fc.integer({ min: 0, max: 1_000_000 }),
    out: fc.integer({ min: 0, max: 1_000_000 }),
    read: fc.integer({ min: 0, max: 1_000_000 }),
    write: fc.integer({ min: 0, max: 1_000_000 }),
    copies: fc.integer({ min: 1, max: 4 }),
  });
  fc.assert(
    fc.property(
      fc.array(metric, { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      (values, reverse) => {
        db.exec("DELETE FROM message_nodes");
        const ordered = reverse
          ? [...values.entries()].reverse()
          : [...values.entries()];
        for (const [i, m] of ordered) {
          const row = JSON.stringify({
            metadata: {
              request_id: `request-${i}`,
              metrics: {
                input_tokens: m.fresh,
                output_tokens: m.out,
                cache_read_tokens: m.read,
                cache_creation_tokens: m.write,
                context_input_tokens: m.fresh + m.read + m.write,
              },
            },
          });
          for (let copy = 0; copy < m.copies; copy++) insert.run("own", row);
          insert.run("foreign", row);
        }
        const usage = readDevinUsage(state, "own");
        const sum = (key: "fresh" | "out" | "read" | "write") =>
          values.reduce((n, m) => n + m[key], 0);
        assert.equal(
          usage?.inputTokens.total,
          sum("fresh") + sum("read") + sum("write"),
        );
        assert.equal(usage?.inputTokens.noCache, sum("fresh"));
        assert.equal(usage?.inputTokens.cacheRead, sum("read"));
        assert.equal(usage?.inputTokens.cacheWrite, sum("write"));
        assert.equal(usage?.outputTokens.total, sum("out"));
      },
    ),
    { seed: 20261122, numRuns: 100 },
  );
});
