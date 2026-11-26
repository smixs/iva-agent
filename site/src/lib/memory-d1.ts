// The few calls of Cloudflare D1 the counts make, over `node:sqlite` in memory: the tests of
// installs.ts and roll-call.ts run their rules against a real SQLite. Not used by the site.
import { DatabaseSync } from "node:sqlite";
import type { Database } from "./installs.ts";

export function memoryDatabase(schema: readonly string[]): {
  db: Database;
  raw: DatabaseSync;
} {
  const raw = new DatabaseSync(":memory:");
  for (const statement of schema) raw.exec(statement);
  const db: Database = {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: () =>
          Promise.resolve({
            meta: { changes: Number(raw.prepare(sql).run(...values).changes) },
          }),
        all: <Row>() =>
          Promise.resolve({
            results: raw.prepare(sql).all(...values) as Row[],
          }),
      }),
    }),
  };
  return { db, raw };
}
