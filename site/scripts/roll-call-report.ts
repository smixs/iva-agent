// The numbers of the roll call, for the project's owner only (ADR-0031 in docs/adr of Iva):
// live installations today, over 7 and 30 days, first roll calls, and how the latest day
// splits by version, update branch, platform, provider and model. Reads the production database through
// wrangler, so it needs the Cloudflare login the deploy uses.
//
//   node scripts/roll-call-report.ts [--preview]
import { execFileSync } from "node:child_process";
import {
  dayOf,
  FIELDS,
  installations,
  split,
  type Counter,
} from "../src/lib/roll-call.ts";

const DATABASE = process.argv.includes("--preview")
  ? "iva-plugin-installs-preview"
  : "iva-plugin-installs";
const DAY_MS = 86_400_000;
const today = dayOf(new Date());
const daysAgo = (n: number) => dayOf(new Date(Date.parse(today) - n * DAY_MS));
const since = daysAgo(29);

// The dates are ours, built by dayOf: nothing from outside reaches the query text. A day after
// today can only come from a clock that ran ahead; it is not counted.
const output = execFileSync(
  "npx",
  [
    "-y",
    "wrangler",
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--json",
    "--command",
    `SELECT day, field, value, count FROM roll_call WHERE day >= '${since}' AND day <= '${today}'`,
  ],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 << 20,
  },
);
const counters = (JSON.parse(output) as { results: Counter[] }[]).flatMap(
  (part) => part.results,
);
const days = [...new Set(counters.map((row) => row.day))].sort();
const latest = days.at(-1);

console.log(`Roll call, ${DATABASE}, ${today} (UTC)`);
console.log(`  today            ${installations(counters, today, today)}`);
console.log(
  `  yesterday        ${installations(counters, daysAgo(1), daysAgo(1))}`,
);
console.log(`  last 7 days      ${installations(counters, daysAgo(6), today)}`);
console.log(`  last 30 days     ${installations(counters, since, today)}`);
const fresh = counters
  .filter(
    (row) => row.field === "gap" && row.value === "0" && row.day >= daysAgo(6),
  )
  .reduce((sum, row) => sum + row.count, 0);
// gap 0 is an installation's first roll call: a new install, or one that has just updated to
// a version with the roll call. Not the same as new users.
console.log(`  first roll call, 7 days  ${fresh}`);
if (latest) {
  console.log(`\n${latest}, by field:`);
  for (const field of FIELDS.filter((name) => name !== "gap"))
    console.log(
      `  ${field.padEnd(9)} ${split(counters, latest, field)
        .map(([value, count]) => `${value} ${count}`)
        .join(", ")}`,
    );
}
