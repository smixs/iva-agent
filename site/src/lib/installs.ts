// The install count of Iva's default Marketplace (ADR-0029 in docs/adr of Iva, with ADR-0031).
//
// An installed Iva sends one POST with the name of a plugin; this is everything the site
// does with it. What is kept: one number per plugin, and nothing about the sender - neither
// its address nor a hash of it (ADR-0031 took the daily hash away: while its salt lives, a
// hash of an address is still the address). An install is a person's act, so repeats are
// rare. The handler in `functions/api/plugins/installs.ts` only reads the request; the rules
// live here, where a test can run them against a real SQLite.

/** The part of Cloudflare D1 this module uses; `node:sqlite` fits behind it in tests. */
export type Database = {
  prepare(sql: string): {
    bind(...values: (string | number)[]): {
      run(): Promise<{ meta: { changes?: number } }>;
      all<Row>(): Promise<{ results: Row[] }>;
    };
  };
};

export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS installs (name TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID",
  // The table of daily hashes the count once kept; a database that still has it loses it.
  "DROP TABLE IF EXISTS seen",
];

/** A body larger than this is not a plugin name: refused before it is parsed. */
export const MAX_BODY = 256;

/** The name in a request body, or null when the body is anything but `{"name":"<string>"}`. */
export function nameIn(body: string): string | null {
  if (body.length > MAX_BODY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

export type Outcome = "counted" | "unlisted";

/** One install. `unlisted` - the name is not on the published list, nothing is written. */
export async function recordInstall(
  db: Database,
  name: string,
  listed: ReadonlySet<string>,
): Promise<Outcome> {
  if (!listed.has(name)) return "unlisted";
  await db
    .prepare(
      "INSERT INTO installs (name, count) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1",
    )
    .bind(name)
    .run();
  return "counted";
}

/** The numbers the page shows, for the plugins that are still listed. */
export async function installCounts(
  db: Database,
  listed: ReadonlySet<string>,
): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT name, count FROM installs WHERE count > ?")
    .bind(0)
    .all<{ name: string; count: number }>();
  const counts: Record<string, number> = {};
  for (const row of results)
    if (listed.has(row.name)) counts[row.name] = row.count;
  return counts;
}
