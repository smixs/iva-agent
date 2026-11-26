/**
 * Roll call: once a day an installed Iva tells iva-agent.com that it is alive, with its
 * version, update branch, platform, provider and model, and nothing that points at the
 * installation or its owner (ADR-0031).
 *
 * The whole request is spelled here, as the install count spells its own
 * (install-count.ts), so that what leaves the machine is read in one place. There is no
 * identifier: the site counts installations by `gap`, the days since this installation's
 * last roll call. That is enough to count distinct installations over any window of up to
 * a month without telling two of them apart - an installation is counted in its first
 * roll call inside the window, and that is exactly the one whose gap reaches back past
 * the window's start.
 *
 * It runs after the daily update check, waits a bounded time and never throws: a roll
 * call that did not reach the site is simply not counted, and the next one names the
 * longer gap.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { statsOff } from "./install-count.ts";
import { CATALOG, catalogModel } from "./model-catalog.ts";

export const ROLL_CALL_URL = "https://iva-agent.com/api/roll-call";

/** How long the end of the daily check may wait for a site that does not answer. */
export const ROLL_CALL_TIMEOUT_MS = 2500;

/** The longest gap a roll call names: a longer silence reads the same as a month. */
export const ROLL_CALL_MAX_GAP = 31;

/** The one thing kept on the machine: the UTC day of the last roll call the site took. */
export const ROLL_CALL_FILE = "roll-call.json";

type Env = Readonly<Record<string, string | undefined>>;

export type Branch = "main" | "beta" | "other";

export type RollCall = {
  /** 0 for an installation's first roll call, else days since the last one, at most 31. */
  readonly gap: number;
  readonly version: string;
  readonly branch: Branch;
  readonly os: "linux" | "darwin" | "other";
  readonly arch: "x64" | "arm64" | "other";
  readonly provider: string;
  readonly model: string;
};

export type RollCallResult =
  | { readonly status: "off" }
  | { readonly status: "already-today" }
  | { readonly status: "sent"; readonly body: RollCall }
  | { readonly status: "not-taken"; readonly body: RollCall }
  | { readonly status: "failed"; readonly error: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** `IVA_STATS=off` in `.env`, or `DO_NOT_TRACK=1`, turns the roll call off. */
export function rollCallEnabled(env: Env): boolean {
  return !statsOff(env);
}

/** The UTC day of a moment, `YYYY-MM-DD`. */
export function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The gap to name today, from the day of the last roll call the site took: `null` when one
 * was already taken today; 0 when there was none (`last === null`); the longest gap when the
 * record is unreadable or lies in the future, since then the silence is unknown.
 */
export function gapSince(
  last: string | null | undefined,
  today: string,
): number | null {
  if (last === null) return 0;
  // `2026-02-30` has the shape of a day and parses as 2 March: only a day that reads back
  // as itself is one.
  if (last === undefined || !DAY.test(last) || !isDay(last))
    return ROLL_CALL_MAX_GAP;
  const days = Math.round((Date.parse(today) - Date.parse(last)) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return ROLL_CALL_MAX_GAP;
  if (days === 0) return null;
  return Math.min(days, ROLL_CALL_MAX_GAP);
}

const isDay = (text: string) => {
  const time = Date.parse(text);
  return Number.isFinite(time) && dayOf(new Date(time)) === text;
};

/**
 * The body of the roll call. Every field comes out of a closed list, or for the version a
 * fixed shape, so no value of `.env` can carry anything else off the machine: the model is
 * one Iva's own catalog names for that provider, the custom provider's model is always
 * "custom", and its address is never read.
 */
export function rollCallBody(input: {
  readonly gap: number;
  readonly version: string | undefined;
  readonly branch: Branch;
  readonly platform: string;
  readonly arch: string;
  readonly env: Env;
}): RollCall {
  const name = input.env.MODEL_PROVIDER ?? "ollama";
  const known = Object.hasOwn(CATALOG, name);
  return {
    gap: input.gap,
    version:
      input.version !== undefined && VERSION.test(input.version)
        ? input.version
        : "other",
    branch: input.branch,
    os:
      input.platform === "linux" || input.platform === "darwin"
        ? input.platform
        : "other",
    arch: input.arch === "x64" || input.arch === "arm64" ? input.arch : "other",
    provider: known ? name : "other",
    model: known ? publicModel(name, input.env) : "other",
  };
}

// Only a name Iva itself offers for the provider: a model the owner named on their own - a
// fine-tune, a file, a deployment on their server - can say who they are, and leaves as
// "other". Many "other" on one provider is a reason to add models to the catalog.
function publicModel(provider: string, env: Env): string {
  if (provider === "custom") return "custom";
  const entry = CATALOG[provider];
  const model = (catalogModel(provider, env) ?? "").trim().toLowerCase();
  const published = [...entry.models, entry.def, entry.visionDef].find(
    (name) => name !== null && name.toLowerCase() === model,
  );
  return published ?? "other";
}

/** Sends the body; `true` when the site took it. Never throws. */
export async function sendRollCall(
  body: RollCall,
  request: typeof fetch = fetch,
  timeoutMs: number = ROLL_CALL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await request(ROLL_CALL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The answer has no body worth reading; an unread one would keep the connection, and
    // with it the daily run, open after the check is done.
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** The day of the last roll call taken: `null` when there is none, `undefined` when unreadable. */
async function lastDay(file: string): Promise<string | null | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : undefined;
  }
  try {
    const day = (JSON.parse(text) as { day?: unknown }).day;
    return typeof day === "string" ? day : undefined;
  } catch {
    return undefined;
  }
}

async function remember(storage: string, day: string): Promise<void> {
  await mkdir(storage, { recursive: true });
  const file = join(storage, ROLL_CALL_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ day })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function installedVersion(root: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One roll call: at most one taken per UTC day. The day is written only after the site took
 * the call, so a call that did not reach it is followed tomorrow by one with a longer gap.
 */
export async function runRollCall(options: {
  readonly root: string;
  readonly storage: string;
  readonly branch: Branch;
  readonly env: Env;
  readonly now?: Date;
  readonly platform?: string;
  readonly arch?: string;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<RollCallResult> {
  try {
    if (!rollCallEnabled(options.env)) return { status: "off" };
    const today = dayOf(options.now ?? new Date());
    const gap = gapSince(
      await lastDay(join(options.storage, ROLL_CALL_FILE)),
      today,
    );
    if (gap === null) return { status: "already-today" };
    const body = rollCallBody({
      gap,
      version: await installedVersion(options.root),
      branch: options.branch,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      env: options.env,
    });
    if (!(await sendRollCall(body, options.request, options.timeoutMs)))
      return { status: "not-taken", body };
    await remember(options.storage, today);
    return { status: "sent", body };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
