// The roll call of installed Ivas (ADR-0031 in docs/adr of Iva).
//
// Once a day an installed Iva posts seven fields: gap, version, branch, os, arch, provider
// and model. The site keeps counters, one per day, field and value, and never a row with all
// the fields together, so a rare combination cannot single an installation out. Nothing about
// the sender is kept: no address, no hash of it, no country. The handler in
// `functions/api/roll-call.ts` only reads the request; the rules live here, where a test can
// run them against a real SQLite.
//
// There is no identifier, and the counters still give the number of distinct installations
// over any window of up to a month: `gap` is the days since that installation's previous roll
// call (0 for its first), so an installation is counted once, in its first roll call inside the
// window - the one whose gap reaches back past the window's start.
import type { Database } from "./installs.ts";

export const ROLL_CALL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS roll_call (day TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, field, value)) WITHOUT ROWID",
];

/** A body larger than this is not a roll call: refused before it is parsed. */
export const MAX_ROLL_CALL_BODY = 512;

/** The longest gap a roll call names. */
export const MAX_GAP = 31;

export const FIELDS = [
  "gap",
  "version",
  "branch",
  "os",
  "arch",
  "provider",
  "model",
] as const;

export type Field = (typeof FIELDS)[number];
export type RollCall = Readonly<Record<Field, string>>;

// Shapes, not lists: an Iva newer than the site may name a provider the site has not heard of,
// and a refused roll call would hide that installation until the site caught up.
const SHAPES: Record<Exclude<Field, "gap">, RegExp> = {
  version: /^(\d{1,4}\.\d{1,4}\.\d{1,4}|other)$/,
  branch: /^[a-z]{1,16}$/,
  os: /^[a-z0-9]{1,16}$/,
  arch: /^[a-z0-9]{1,16}$/,
  provider: /^[a-z][a-z0-9-]{0,31}$/,
  model: /^[a-z0-9][a-z0-9._:/-]{0,63}$/,
};

/**
 * The roll call in a request body, every value as text, or null when the body is anything but
 * an object with exactly the seven fields in their shapes.
 */
export function rollCallIn(body: string): RollCall | null {
  if (body.length > MAX_ROLL_CALL_BODY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== FIELDS.length || !FIELDS.every((f) => keys.includes(f)))
    return null;
  const gap = fields.gap;
  if (
    typeof gap !== "number" ||
    !Number.isInteger(gap) ||
    gap < 0 ||
    gap > MAX_GAP
  )
    return null;
  const call: Record<string, string> = { gap: String(gap) };
  for (const [field, shape] of Object.entries(SHAPES)) {
    const value = fields[field];
    if (typeof value !== "string" || !shape.test(value)) return null;
    if (field === "model" && looksLikeAnAddress(value)) return null;
    call[field] = value;
  }
  return call as RollCall;
}

// Iva sends only the names its model catalog knows; whoever else posts here must not leave an
// address in the table either. An address has no letter, an IPv4 address anywhere in it
// (192.168.1.5:11434/llama3), two colons (IPv6) or a scheme; a model's name has a letter and
// at most one colon (gemma4:31b).
function looksLikeAnAddress(model: string): boolean {
  return (
    !/[a-z]/.test(model) ||
    /\d{1,3}(\.\d{1,3}){3}/.test(model) ||
    (model.match(/:/g) ?? []).length > 1 ||
    model.includes("://")
  );
}

export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * One roll call: each of its seven values adds one to its counter for the day, in one
 * transaction, so a failure keeps the day's counters agreeing with each other.
 */
export async function recordRollCall(
  db: Database,
  call: RollCall,
  now: Date,
): Promise<void> {
  const day = dayOf(now);
  const upsert = db.prepare(
    "INSERT INTO roll_call (day, field, value, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, field, value) DO UPDATE SET count = count + 1",
  );
  await db.batch(FIELDS.map((field) => upsert.bind(day, field, call[field])));
}

export type Counter = {
  readonly day: string;
  readonly field: string;
  readonly value: string;
  readonly count: number;
};

const DAY_MS = 86_400_000;
const between = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * Distinct installations that answered at least once in the window `from`..`to` (UTC days,
 * both included, at most a month long): a roll call counts when it is the installation's first
 * in the window, that is, when its gap reaches back before `from`, or it is a first roll call.
 */
export function installations(
  counters: readonly Counter[],
  from: string,
  to: string,
): number {
  let total = 0;
  for (const row of counters) {
    if (row.field !== "gap" || row.day < from || row.day > to) continue;
    const gap = Number(row.value);
    if (gap === 0 || gap > between(from, row.day)) total += row.count;
  }
  return total;
}

/** How a field split on one day: value → roll calls, largest first. */
export function split(
  counters: readonly Counter[],
  day: string,
  field: Field,
): [string, number][] {
  return counters
    .filter((row) => row.day === day && row.field === field)
    .map((row): [string, number] => [row.value, row.count])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
