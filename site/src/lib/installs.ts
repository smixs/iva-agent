// The install count of Iva's default Marketplace (ADR-0029 in docs/adr of Iva).
//
// An installed Iva sends one POST with the name of a plugin; this is everything the site
// does with it. What is kept: one number per plugin, and for one day a hash of the sender's
// address, the plugin name and that day under a secret salt - so one machine counts once
// a day and the address itself is never written anywhere. The handler in
// `functions/api/plugins/installs.ts` only reads the request; the rules live here, where a
// test can run them against a real SQLite.

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
  "CREATE TABLE IF NOT EXISTS seen (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash)) WITHOUT ROWID",
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

export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type Outcome = "counted" | "repeat" | "unlisted";

/**
 * One install. `unlisted` - the name is not on the published list, nothing is written.
 * `repeat` - this address already installed this plugin today. `counted` - the number went up.
 */
export async function recordInstall(
  db: Database,
  request: {
    readonly name: string;
    readonly address: string;
    readonly now: Date;
    readonly salt: string;
  },
  listed: ReadonlySet<string>,
): Promise<Outcome> {
  if (!listed.has(request.name)) return "unlisted";
  const day = dayOf(request.now);
  const hash = await sha256(
    [request.salt, day, request.address, request.name].join("\n"),
  );
  const first = await db
    .prepare("INSERT OR IGNORE INTO seen (day, hash) VALUES (?, ?)")
    .bind(day, hash)
    .run();
  if (first.meta.changes !== 1) return "repeat";
  await db
    .prepare(
      "INSERT INTO installs (name, count) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1",
    )
    .bind(request.name)
    .run();
  // Yesterday's hashes have done their work: they go with the first install of a new day.
  await db.prepare("DELETE FROM seen WHERE day < ?").bind(day).run();
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
