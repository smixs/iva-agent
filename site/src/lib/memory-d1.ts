// The few calls of Cloudflare D1 the counts make, over `node:sqlite` in memory: the tests of
// installs.ts and roll-call.ts run their rules against a real SQLite. Not used by the site.
import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "./installs.ts";

export function memoryDatabase(schema: readonly string[]): {
  db: Database;
  raw: DatabaseSync;
} {
  const raw = new DatabaseSync(":memory:");
  for (const statement of schema) raw.exec(statement);
  const bound = new Map<Statement, () => void>();
  const db: Database = {
    prepare: (sql) => ({
      bind: (...values) => {
        const statement: Statement = {
          run: () =>
            Promise.resolve({
              meta: {
                changes: Number(raw.prepare(sql).run(...values).changes),
              },
            }),
          all: <Row>() =>
            Promise.resolve({
              results: raw.prepare(sql).all(...values) as Row[],
            }),
        };
        bound.set(statement, () => raw.prepare(sql).run(...values));
        return statement;
      },
    }),
    // As D1 does: the statements in one transaction, rolled back whole when one fails.
    batch: (statements) => {
      raw.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          const run = bound.get(statement);
          if (!run) throw new Error("a statement of another database");
          return run();
        });
        raw.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        raw.exec("ROLLBACK");
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  };
  return { db, raw };
}
