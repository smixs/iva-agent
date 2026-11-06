// `iva trace` — the terminal reader of the turn journal (ADR-0010). The viewer plugin is
// the other reader; both are built against `docs/trace.md`, which is the contract, never
// against the writer's internals.
//
// Three commands, one journal:
//   tail  — the live stream, one line per event, following the day file across midnight
//   show  — one turn stitched back together, or the last 20 turns as a list
//   open  — the viewer address and the ssh tunnel that reaches it (loopback only)
//
// Everything that renders is a pure exported function over parsed lines, so the tests are
// input → string and the properties (permutation-stable stitching, a renderer that never
// throws) cost nothing. The day naming comes from `#lib/trace.ts` through a lazy import,
// never a static one: `iva` has to start on an installation whose `agent/` is missing
// (ADR-0003, scripts/authored-tree-guard.test.ts).
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "#lib/trace.ts";
import { createLazyTranslate, type Translate } from "../lib/cli-translate.ts";
import { tryLoadPluginCore, type PluginCore } from "../lib/plugin-core.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { parseTurnRef, turnRef } from "../lib/turn-ref.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

/** Only the contract's pure helpers: where a day file lives and what it is called. */
type TraceCore = Pick<
  typeof import("#lib/trace.ts"),
  "traceDay" | "traceDir" | "traceFilePath"
>;

type TraceDependencies = {
  readonly log?: (...args: unknown[]) => void;
  readonly now?: () => Date;
  readonly translate?: Translate;
  readonly loadTrace?: () => Promise<TraceCore>;
  readonly loadPlugins?: () => Promise<PluginCore | null>;
  /** The `tail` follow loop; the default one is a timer plus Ctrl-C. */
  readonly follow?: (flush: () => void) => Promise<void>;
  readonly hostName?: () => string;
  readonly userName?: () => string;
};

/** The viewer's default port — `sh.iva/services/viewer/service.json` may name another. */
const TRACE_VIEWER_PORT = 8726;
/** The plugin that carries the viewer (spec `.scratch/trace/spec.md`, ADR-0010). */
const TRACE_PLUGIN = "trace";
/** The day-file name of the contract; anything else in the folder is not ours. */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;
const TAIL_INTERVAL_MS = 500;
const TAIL_PREVIEW_CHARS = 80;
const FACT_LIMIT = 40;
const SHOW_PREVIEW_CHARS = 160;
const TURN_LIST_LIMIT = 20;
// Group key of a turn: the session AND the eve turnId. `turn_N` restarts in every session
// and one session holds many turns, so the pair is the identity — see stitchTurns.
const SESSION_TURN = "|";
const pairKey = (session: string, turn: string): string =>
  `${session}${SESSION_TURN}${turn}`;
// The events that end a turn: its duration stops at the latest of them, not at a
// compaction or a `session.waiting` that the runtime writes later.
const TURN_END = new Set([
  "eve.turn.completed",
  "eve.turn.failed",
  "eve.turn.cancelled",
  "outbox.delivered",
  "outbox.failed",
]);

// Content fields, in the order a reader wants to see them: the writer merges content flat
// into `data` next to its `<key>Chars` sizes, so there is no separate object to look in.
const CONTENT_KEYS = [
  "text",
  "message",
  "result",
  "args",
  "output",
  "reasoning",
  "error",
  "details",
  "context",
  "input",
] as const;

// The fields worth one column: what it touched, what the verdict was, where it stands.
// Two of them fit on a line, so the order is the priority.
const FACT_KEYS = [
  "toolName",
  "failure",
  "subagentName",
  "decision",
  "outcome",
  "blocked",
  "clean",
  "accepted",
  "ok",
  "status",
  "errorCode",
  "code",
  "finishReason",
  "reason",
  "allowlisted",
  "parts",
  "chars",
  "sequence",
  "stepIndex",
  "chatKey",
  "chatId",
] as const;

const MEMORY_PARTS = ["core", "persona", "moc", "daily"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function scalarText(value: unknown): string {
  return isScalar(value) ? String(value) : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function column(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Cut with a marker, never through a surrogate pair — half a character reads as damage. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let keep = Math.max(0, limit - 1);
  const code = keep > 0 ? text.charCodeAt(keep - 1) : 0;
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1;
  return `${text.slice(0, keep)}…`;
}

// --- Reading ---

/** One journal line, plus what sorts it and what `--json` prints. */
export type TraceLine = TraceEvent & {
  /** The line exactly as it lies in the file. */
  readonly raw: string;
  /** Position in the read stream: it settles equal timestamps. */
  readonly index: number;
  /** `ts` in milliseconds, or 0 when the timestamp cannot be read. */
  readonly at: number;
};

/**
 * One line → one event, or nothing. A broken line never spoils its neighbours
 * (docs/trace.md «Guarantees for a reader»), so anything that is not a JSON object with a
 * `kind` or a `name` is skipped instead of throwing.
 */
export function parseTraceLine(raw: string, index = 0): TraceLine | null {
  const text = raw.trim();
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const kind = str(value.kind);
  const name = str(value.name);
  if (!kind && !name) return null;
  const ts = str(value.ts);
  const at = Date.parse(ts);
  return {
    ts,
    turn: str(value.turn),
    session: str(value.session),
    source: str(value.source),
    kind,
    name,
    data: isRecord(value.data) ? value.data : {},
    raw: text,
    index,
    at: Number.isFinite(at) ? at : 0,
  };
}

/** Every day file of the journal, oldest first. Retention caps the folder at 30 files. */
function readTraceLines(dir: string): TraceLine[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => DAY_FILE.test(name))
      .sort();
  } catch {
    return [];
  }
  const lines: TraceLine[] = [];
  let index = 0;
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // an unreadable day is one day missing, not a failed command
    }
    for (const raw of text.split("\n")) {
      const parsed = parseTraceLine(raw, index++);
      if (parsed) lines.push(parsed);
    }
  }
  return lines;
}

// --- Stitching ---

/** One turn: its keys, the channels it came through, and its events in `ts` order. */
export type StitchedTurn = {
  /** The group key: the turnId, else the session of a night turn, else the raw key. */
  readonly key: string;
  readonly turnId: string;
  readonly updateKey: string;
  readonly session: string;
  readonly sources: readonly string[];
  readonly events: readonly TraceLine[];
};

/** `turn_3#planner` → `turn_3`: a subagent step belongs to the turn that spawned it. */
function baseTurn(key: string): string {
  const hash = key.indexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

/**
 * Lines → turns, exactly as docs/trace.md describes it.
 *
 * `turn.bound` is the only line where the update key and the turnId lie together, so it
 * decides which update-keyed lines (Bridge, inbound) belong to a chat turn. Every other
 * line is grouped by session AND eve turnId together, never by one of them alone: every
 * session starts at `turn_0`, so a turnId alone glues turns of different sessions, and one
 * Eve session holds many turns — the daily digest sends twice inside one session, and the
 * nightly Rollup keeps its session alive across nights. A line with `turn_N` and no session
 * joins the latest turn with that `turn_N`.
 *
 * A line with no turn key at all (the `gate.outbound` and `outbox.*` of a night send)
 * belongs to the most recent turn of its session by `ts`. Left with neither a key nor a
 * session, a line stands alone: Bridge callback lines are orphans by design.
 *
 * Source is deliberately part of no key: inside one night turn the eve lines carry
 * `source: "unknown"` while `gate.outbound` and `outbox.*` carry `rollup`, so keying on
 * source would cut one turn in two.
 */
export function stitchTurns(lines: readonly TraceLine[]): StitchedTurn[] {
  // Write order is not turn order — two processes append to one file — so everything below
  // reads the journal in `ts` order, including which turn a keyless line lands on.
  const sorted = [...lines].sort(
    (left, right) => left.at - right.at || left.index - right.index,
  );
  const binds = bindChatTurns(sorted);
  const keys = lineKeys(sorted, binds);

  const groups = new Map<string, TraceLine[]>();
  for (const line of sorted) {
    const key = keys.get(line) ?? "?";
    const bucket = groups.get(key);
    if (bucket) bucket.push(line);
    else groups.set(key, [line]);
  }

  return [...groups].map(([key, events]) => turnOf(key, events, binds));
}

type ChatBinds = {
  /** Update key → the pair key of the chat turn that took it. */
  readonly turnByUpdateKey: ReadonlyMap<string, string>;
  /** Pair key → the update key behind it. */
  readonly updateKeyByTurn: ReadonlyMap<string, string>;
};

/**
 * `turn.bound` is the only line where the update key and the turn lie together. Its key is
 * the pair: two sessions both start at `turn_0`. The earliest claim wins — two `turn.bound`
 * lines can name the same update key (a proactive turn in a chat whose last binding is still
 * on the books), and which one wins must not depend on which process wrote its line first.
 */
function bindChatTurns(sorted: readonly TraceLine[]): ChatBinds {
  const turnByUpdateKey = new Map<string, string>();
  const updateKeyByTurn = new Map<string, string>();
  for (const line of sorted) {
    if (line.kind !== "turn" || line.name !== "bound" || !line.turn) continue;
    const key = line.session ? pairKey(line.session, line.turn) : line.turn;
    const updateKey = str(line.data.updateKey);
    if (!updateKey) continue; // a proactive turn has no update behind it
    if (!turnByUpdateKey.has(updateKey)) turnByUpdateKey.set(updateKey, key);
    if (!updateKeyByTurn.has(key)) updateKeyByTurn.set(key, updateKey);
  }
  return { turnByUpdateKey, updateKeyByTurn };
}

/** The group key of every line, in one pass over the `ts`-sorted journal. */
function lineKeys(
  sorted: readonly TraceLine[],
  binds: ChatBinds,
): Map<TraceLine, string> {
  const keys = new Map<TraceLine, string>();
  const openTurn = new Map<string, string>();
  const firstTurn = new Map<string, string>();
  // `turn_N` → the latest pair seen with it: a seam that wrote no session joins it.
  const latestPair = new Map<string, string>();
  const waiting: TraceLine[] = [];
  for (const line of sorted) {
    const base = baseTurn(line.turn);
    if (!base) {
      // Keyless: the send seam of a night turn. It joins the turn open at that moment.
      const open = line.session ? openTurn.get(line.session) : undefined;
      if (open) keys.set(line, open);
      else waiting.push(line);
      continue;
    }
    const key = keyOf(line, base, binds, latestPair);
    keys.set(line, key);
    if (!line.session) continue;
    if (!base.startsWith("tg:")) latestPair.set(base, key);
    openTurn.set(line.session, key);
    if (!firstTurn.has(line.session)) firstTurn.set(line.session, key);
  }
  // A keyless line ahead of every turn of its session can only belong to the first one.
  for (const line of waiting) keys.set(line, firstKey(line, firstTurn));
  return keys;
}

/** The group of a line that carries a turn key of its own. */
function keyOf(
  line: TraceLine,
  base: string,
  binds: ChatBinds,
  latestPair: ReadonlyMap<string, string>,
): string {
  if (base.startsWith("tg:")) return binds.turnByUpdateKey.get(base) ?? base;
  if (line.session) return pairKey(line.session, base);
  return latestPair.get(base) ?? base;
}

function firstKey(
  line: TraceLine,
  firstTurn: ReadonlyMap<string, string>,
): string {
  return (
    (line.session ? firstTurn.get(line.session) : "") || line.session || "?"
  );
}

/** One group of lines → a turn: the session and turnId read back out of its key. */
function turnOf(
  key: string,
  events: readonly TraceLine[],
  binds: ChatBinds,
): StitchedTurn {
  // A turnId never carries the separator, so the last one is where the session ends.
  const split = key.lastIndexOf(SESSION_TURN);
  const session =
    split === -1
      ? (events.find((event) => event.session)?.session ?? "")
      : key.slice(0, split);
  // A turn keyed without a pair still shows the `turn_N` its eve lines carry.
  const turnId =
    split === -1
      ? (events
          .map((event) => baseTurn(event.turn))
          .find((base) => base && !base.startsWith("tg:")) ?? "")
      : key.slice(split + SESSION_TURN.length);
  return {
    key,
    turnId,
    updateKey:
      binds.updateKeyByTurn.get(key) ?? (key.startsWith("tg:") ? key : ""),
    session,
    sources: [...new Set(events.map((event) => event.source).filter(Boolean))],
    events,
  };
}

/**
 * `<session>/<turn>` as the list prints it, a turnId, an update key, a session id, or
 * `last` — whatever the owner has at hand.
 *
 * The pair names exactly one turn. Anything else: the newest match wins. A turnId restarts
 * at `turn_0` in every Eve session and a session holds many turns, so both can name more
 * than one turn in thirty days; the one the owner is looking at is the last one. `last` is
 * the model's last turn: a button tap after it leaves an orphan line, not a turn to read.
 */
export function selectTurn(
  turns: readonly StitchedTurn[],
  selector: string,
): StitchedTurn | undefined {
  if (selector === "last") return lastMatch(turns, modelTurn) ?? turns.at(-1);
  const ref = parseTurnRef(selector);
  if (ref) {
    const key = pairKey(ref.session, ref.turn);
    return lastMatch(turns, (turn) => turn.key === key);
  }
  return (
    lastMatch(turns, (turn) => turn.turnId === selector) ??
    lastMatch(turns, (turn) => turn.updateKey === selector) ??
    lastMatch(turns, (turn) => turn.key === selector) ??
    lastMatch(turns, (turn) => turn.session === selector)
  );
}

const modelTurn = (turn: StitchedTurn): boolean =>
  turn.events.some(
    (event) =>
      event.kind === "eve" &&
      (event.name === "step.started" || event.name === "turn.started"),
  );

/** The newest match. `Array.findLast` is ES2023 and the target of this repo is ES2022. */
function lastMatch(
  turns: readonly StitchedTurn[],
  match: (turn: StitchedTurn) => boolean,
): StitchedTurn | undefined {
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    const turn = turns[at];
    if (match(turn)) return turn;
  }
  return undefined;
}

type TurnOutcome =
  | "failed"
  | "stopped"
  | "blocked"
  | "dropped"
  | "delivered"
  | "answered"
  | "open";

/** How the turn ended, in one word. Collected first, judged by priority after. */
export function turnOutcome(turn: StitchedTurn): TurnOutcome {
  let failed = false;
  let stopped = false;
  let blocked = false;
  let dropped = false;
  let delivered = false;
  let completed = false;
  for (const { kind, name, data } of turn.events) {
    if (kind === "eve" && name === "turn.failed") failed = true;
    if (kind === "outbox" && name === "failed") failed = true;
    if (kind === "eve" && name === "turn.cancelled") stopped = true;
    if (kind === "stop") stopped = true;
    if (kind === "gate" && (name === "inbound" || name === "web"))
      blocked = blocked || data.blocked === true;
    if (kind === "inbound" && name === "dropped") dropped = true;
    if (kind === "bridge" && name === "dropped") dropped = true;
    if (kind === "outbox" && name === "delivered") delivered = true;
    if (kind === "eve" && name === "turn.completed") completed = true;
  }
  if (failed) return "failed";
  if (stopped) return "stopped";
  if (blocked) return "blocked";
  if (dropped) return "dropped";
  if (delivered) return "delivered";
  if (completed) return "answered";
  return "open";
}

/**
 * Model steps of the turn: what it began, not what survived. Subagent steps are excluded —
 * they belong to the subagent, and counting them here would make one planner call look
 * like extra work by the turn itself.
 */
function countSteps(turn: StitchedTurn): number {
  let started = 0;
  let finished = 0;
  for (const { kind, name, turn: key } of turn.events) {
    if (kind !== "eve" || key.includes("#")) continue;
    if (name === "step.started") started += 1;
    if (name === "step.completed") finished += 1;
  }
  return started || finished;
}

/**
 * Where the turn came from, in one word: Telegram, Rollup, a digest, cron. `bridge` is a
 * seam every chat turn passes and `unknown` is an eve event with no channel kind, so
 * neither answers the question a reader is asking.
 */
function turnSource(turn: StitchedTurn): string {
  return (
    turn.sources.find(
      (source) => source !== "bridge" && source !== "unknown",
    ) ??
    turn.sources[0] ??
    "-"
  );
}

/** Tools the turn called, first mention first. */
function turnTools(turn: StitchedTurn): string[] {
  const names: string[] = [];
  const add = (value: unknown): void => {
    const name = scalarText(value);
    if (name && !names.includes(name)) names.push(name);
  };
  for (const { kind, name, data } of turn.events) {
    if (kind !== "eve") continue;
    if (name === "action.result") add(data.toolName);
    if (name === "actions.requested" && Array.isArray(data.actions))
      for (const action of data.actions)
        if (isRecord(action)) add(action.toolName ?? action.name);
  }
  return names;
}

// --- Rendering ---

/** Wall time in the installation timezone; `ts` itself is UTC (docs/trace.md). */
export function clock(at: number, timeZone: string): string {
  if (!at) return "--:--:--";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
  } catch {
    return "--:--:--";
  }
}

/**
 * Day and wall time. The turn list spans thirty days, so a bare clock there would print
 * two nightly Rollups as the same `03:00:00`.
 */
export function stamp(at: number, timeZone: string): string {
  if (!at) return "--:-- --:--:--";
  try {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
    return `${day} ${clock(at, timeZone)}`;
  } catch {
    return `--:-- ${clock(at, timeZone)}`;
  }
}

/** A duration a person reads at a glance, not a number they convert. */
export function duration(ms: number): string {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m${Math.round((value % 60_000) / 1000)}s`;
}

function stepLabel(steps: number): string {
  return `${String(steps)} step${steps === 1 ? "" : "s"}`;
}

/**
 * The turn key in one narrow column: the tail is the half that tells turns apart.
 *
 * Sanitized, not trusted. The writer caps the length of `turn`, `session`, `kind` and
 * `name` but does not strip line breaks from them, and a chat title or an id that arrived
 * with a newline would otherwise print as two events.
 */
function shortTurn(key: string, width = 14): string {
  const text = sanitize(key);
  if (!text) return "-";
  return text.length <= width
    ? text
    : `…${text.slice(text.length - width + 1)}`;
}

/** One identity field of a header, on one line and inside its column. */
function label(value: string, width: number): string {
  return oneLine(value, width) || "-";
}

function eventName(event: TraceLine): string {
  const kind = oneLine(event.kind, 40);
  const name = oneLine(event.name, 40);
  if (!kind) return name;
  if (!name) return kind;
  return `${kind}.${name}`;
}

function flat(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "…[unreadable]";
  }
}

/**
 * Invisible characters: the repo's own threat class (`INVISIBLE_RE` in
 * `agent/lib/security-gate.ts`). A journal reads back whatever arrived from Telegram or a
 * tool, and an escape sequence in there would repaint the terminal it is printed on, so
 * nothing invisible reaches stdout — with or without `--full`.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034f]/gu;

/**
 * Any value → many lines, invisibles gone, line breaks kept. `--full` prints content whole
 * and a real newline is what makes it readable, so it is the one control character that
 * survives; everything else becomes a space.
 */
function visible(value: unknown): string {
  return flat(value)
    .replace(/\r\n?/gu, "\n")
    .replace(INVISIBLE, (character) => (character === "\n" ? character : " "));
}

/**
 * Any value → one line. Whitespace, control and format characters all collapse to one
 * space: a newline inside a tool result must not turn one event into two, and a stray
 * escape sequence must not repaint the terminal it is printed on.
 */
function sanitize(value: unknown): string {
  return flat(value)
    .replace(/[\s\p{Cc}\p{Cf}\u034f]+/gu, " ")
    .trim();
}

/** Any value → one capped line: a journal preview must not reflow the terminal. */
export function oneLine(value: unknown, limit: number): string {
  return cut(sanitize(value), limit);
}

/** The one or two `data` fields worth a column, plus the duration when there is one. */
function eventFacts(event: TraceLine): string {
  const data = event.data;
  const facts: string[] = [];
  if (Array.isArray(data.actions)) {
    const names = data.actions
      .map((action) =>
        isRecord(action)
          ? scalarText(action.toolName ?? action.name ?? action.subagentName)
          : "",
      )
      .filter(Boolean);
    facts.push(
      `actions=${oneLine(names.join(",") || String(data.actions.length), FACT_LIMIT)}`,
    );
  }
  if (isRecord(data.usage))
    facts.push(
      `tok=${String(num(data.usage.in))}/${String(num(data.usage.out))}`,
    );
  if (event.kind === "context" && event.name === "parts")
    facts.push(
      `bytes=${String(MEMORY_PARTS.reduce((sum, part) => sum + num(data[part]), 0))}`,
    );
  for (const key of FACT_KEYS) {
    if (facts.length >= 2) break;
    const value = data[key];
    if (!isScalar(value) || value === "") continue;
    // A field is a column, not a paragraph: a long `reason` must not push the content
    // preview off the screen.
    facts.push(`${key}=${oneLine(String(value), FACT_LIMIT)}`);
  }
  const head = facts.slice(0, 2).join(" ");
  const ms = data.ms;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return head;
  return head ? `${head} ${duration(ms)}` : duration(ms);
}

/**
 * The content fields the event carries, in reading order: present and not empty. One rule
 * for the one-line preview and the full listing alike.
 */
function contentFields(event: TraceLine): [string, unknown][] {
  const fields: [string, unknown][] = [];
  for (const key of CONTENT_KEYS) {
    const value = event.data[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    fields.push([key, value]);
  }
  return fields;
}

/** The first content field the event carries, capped — or the writer's marker instead. */
function eventPreview(event: TraceLine, limit: number): string {
  const [first] = contentFields(event);
  if (first) return `${first[0]}: ${oneLine(first[1], limit)}`;
  if (event.data.traceTrimmed === true) return "content: …[trimmed]";
  if (event.data.traceUnreadable === true) return "content: …[unreadable]";
  return "";
}

/** One event, one line: time, turn, event, facts, content preview. */
export function formatEventLine(
  event: TraceLine,
  options: { readonly timeZone: string; readonly previewChars?: number },
): string {
  const head = [
    clock(event.at, options.timeZone),
    column(shortTurn(event.turn), 14),
    column(eventName(event), 24),
    eventFacts(event),
  ].join("  ");
  const preview = eventPreview(
    event,
    options.previewChars ?? TAIL_PREVIEW_CHARS,
  );
  return (preview ? `${head}  ${preview}` : head).trimEnd();
}

/** Content under an event: capped to one line, or whole and indented under `--full`. */
function contentLines(
  event: TraceLine,
  full: boolean,
  indent: string,
): string[] {
  const out: string[] = [];
  for (const [key, value] of contentFields(event)) {
    if (!full) {
      out.push(`${indent}${key}: ${oneLine(value, SHOW_PREVIEW_CHARS)}`);
      continue;
    }
    const [first, ...rest] = visible(value).split("\n");
    // Trailing space is what a stripped escape sequence leaves behind; nobody needs it.
    out.push(`${indent}${key}: ${first ?? ""}`.trimEnd());
    for (const line of rest) out.push(`${indent}  ${line}`.trimEnd());
  }
  if (out.length === 0 && event.data.traceTrimmed === true)
    out.push(`${indent}content: …[trimmed]`);
  return out;
}

/**
 * When the turn started, when it ended, how long it took. One reading for both views. The
 * end is the latest `TURN_END` event; a turn without one ends with its last event.
 */
function turnSpan(turn: StitchedTurn) {
  const from = turn.events[0]?.at ?? 0;
  let to = 0;
  for (const event of turn.events)
    if (TURN_END.has(`${event.kind}.${event.name}`))
      to = Math.max(to, event.at);
  if (!to) to = turn.events.at(-1)?.at ?? 0;
  return { from, to, ms: to - from };
}

/** Tool calls the hook marked with a `failure` class. */
function failedCalls(turn: StitchedTurn): string[] {
  const count = turn.events.filter(
    (event) =>
      event.kind === "eve" &&
      event.name === "action.result" &&
      isScalar(event.data.failure) &&
      event.data.failure !== "",
  ).length;
  return count ? [`${String(count)} failed calls`] : [];
}

/** One turn as text: two header lines, then its events with the gap between them. */
export function formatTurn(
  turn: StitchedTurn,
  options: { readonly timeZone: string; readonly full?: boolean },
): string[] {
  const { timeZone } = options;
  const span = turnSpan(turn);
  const tools = turnTools(turn);
  const out = [
    [
      label(turn.turnId || turn.key, 80),
      label(turn.updateKey, 80),
      label(turnSource(turn), 20),
      `session ${label(turn.session, 80)}`,
    ].join(" · "),
    [
      `${clock(span.from, timeZone)} → ${clock(span.to, timeZone)}`,
      duration(span.ms),
      stepLabel(countSteps(turn)),
      tools.length ? `tools ${oneLine(tools.join(", "), 120)}` : "no tools",
      ...failedCalls(turn),
      turnOutcome(turn),
    ].join(" · "),
    "",
  ];
  let previous = span.from;
  for (const event of turn.events) {
    // A subagent step carries the parent key with a `#planner` suffix; the indent is what
    // says whose step it is, and `eve.subagent.started` above it says the name.
    const nested = event.turn.includes("#");
    const gap = event.at && previous ? event.at - previous : 0;
    if (event.at) previous = event.at;
    out.push(
      [
        `  ${clock(event.at, timeZone)}`,
        column(gap ? `+${duration(gap)}` : "", 8),
        column(`${nested ? "  " : ""}${eventName(event)}`, 26),
        eventFacts(event),
      ]
        .join(" ")
        .trimEnd(),
    );
    for (const line of contentLines(
      event,
      options.full === true,
      nested ? "              " : "            ",
    ))
      out.push(line);
  }
  return out;
}

/** The selector of a turn, whole: pasted into `iva trace show` it opens this turn. */
function listRef(turn: StitchedTurn): string {
  const ref =
    turn.session && turn.turnId ? turnRef(turn.session, turn.turnId) : turn.key;
  return sanitize(ref) || "-";
}

/** The last turns as one line each: time, source, selector, steps, tools, duration, outcome. */
export function formatTurnList(
  turns: readonly StitchedTurn[],
  options: { readonly timeZone: string; readonly limit?: number },
): string[] {
  return turns.slice(-(options.limit ?? TURN_LIST_LIMIT)).map((turn) => {
    const span = turnSpan(turn);
    return [
      stamp(span.from, options.timeZone),
      column(oneLine(turnSource(turn), 9), 9),
      column(listRef(turn), 20),
      column(stepLabel(countSteps(turn)), 8),
      column(oneLine(turnTools(turn).join(", "), 24), 24),
      column(duration(span.ms), 7),
      turnOutcome(turn),
    ]
      .join("  ")
      .trimEnd();
  });
}

// --- tail: following the day file ---

type TraceTail = {
  /** Events that appeared since the previous call. Rollover and truncation are inside. */
  drain(): TraceLine[];
  /** The day file being followed. */
  day(): string;
};

/**
 * The follower. Polls size and reads from the offset instead of watching: two processes
 * append to one file, `fs.watch` semantics differ per platform, and the incomplete tail is
 * kept as bytes — so a read that lands mid-character cannot damage the next line.
 */
export function createTraceTail(options: {
  readonly filePath: (day: string) => string;
  readonly day: (now: Date) => string;
  readonly now: () => Date;
  readonly since?: number;
}): TraceTail {
  const since = options.since ?? 0;
  const empty = Buffer.alloc(0);
  let day = options.day(options.now());
  let offset = 0;
  let firstDrain = true;
  let pending = empty;
  let index = 0;

  function readDelta(): Buffer {
    const path = options.filePath(day);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return empty; // the day file is not there yet — nothing to say about it
    }
    // Replaced or truncated (a restore, a hand edit): start the file over.
    if (size < offset) {
      offset = 0;
      pending = empty;
    }
    if (size === offset) return empty;
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    let read: number;
    const fd = openSync(path, "r");
    try {
      read = readSync(fd, buffer, 0, length, offset);
    } finally {
      closeSync(fd);
    }
    offset += read;
    return buffer.subarray(0, read);
  }

  /** Jump to the end without reading: a live tail with no history owes the file nothing. */
  function skipToEnd(): void {
    try {
      offset = statSync(options.filePath(day)).size;
    } catch {
      offset = 0; // the day file is not there yet, so its end is its start
    }
  }

  return {
    day: () => day,
    drain() {
      const today = options.day(options.now());
      if (today !== day) {
        day = today;
        offset = 0;
        pending = empty;
      }
      // The first drain of a tail with no history reads no bytes at all: a day file can be
      // megabytes, and none of them are going to be printed.
      if (firstDrain && since === 0) {
        firstDrain = false;
        skipToEnd();
        return [];
      }
      pending = Buffer.concat([pending, readDelta()]);
      const events: TraceLine[] = [];
      let start = 0;
      for (;;) {
        const brk = pending.indexOf(0x0a, start);
        if (brk === -1) break;
        const parsed = parseTraceLine(
          pending.subarray(start, brk).toString("utf8"),
          index++,
        );
        if (parsed) events.push(parsed);
        start = brk + 1;
      }
      if (start > 0) pending = Buffer.from(pending.subarray(start));
      if (!firstDrain) return events;
      firstDrain = false;
      // A live tail starts at the end; `--since N` asks for N lines of history first.
      return since > 0 ? events.slice(-since) : [];
    },
  };
}

/** The default follow loop: poll until Ctrl-C, then return so the command exits zero. */
function followUntilInterrupt(flush: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        flush();
      } catch {
        // One unreadable poll is not a reason to end a live stream.
      }
    }, TAIL_INTERVAL_MS);
    const stop = (): void => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      resolve();
    };
    process.on("SIGINT", stop);
  });
}

// --- open: the tunnel ---

/** The viewer's port out of its service declaration, or the default when it cannot be read. */
export function readServicePort(
  path: string,
  fallback = TRACE_VIEWER_PORT,
): number {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
  if (!isRecord(value)) return fallback;
  const port = value.port;
  return typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65_535
    ? port
    : fallback;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function urlHost(value: string): string {
  if (value.includes("://")) {
    try {
      return new URL(value).hostname;
    } catch {
      return "";
    }
  }
  return value.replace(/\/.*$/u, "").replace(/:\d+$/u, "");
}

/**
 * The host `ssh` is given. `ASSISTANT_HOST` is a URL — where the Bridge reaches the server
 * (docs/configuration.md) — so its hostname is what matters, and a loopback one is worth
 * nothing here: a tunnel to 127.0.0.1 ends on the owner's own laptop.
 */
export function sshHost(
  raw: string | undefined,
  fallback: () => string,
): string {
  const host = urlHost((raw ?? "").trim());
  return host && !LOOPBACK.has(host) ? host : fallback();
}

function sshTunnel(port: number, user: string, host: string): string {
  return `ssh -N -L ${String(port)}:127.0.0.1:${String(port)} ${user}@${host}`;
}

function viewerUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || "iva";
  }
}

/** `--since 20` or `--since=20`; anything else means no history. */
function flagCount(argv: readonly string[], flag: string): number {
  for (let at = 0; at < argv.length; at += 1) {
    const value = argv[at];
    const raw = value.startsWith(`${flag}=`)
      ? value.slice(flag.length + 1)
      : value === flag
        ? argv[at + 1]
        : "";
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function createTraceCommands(
  runtime: CliRuntime,
  dependencies: TraceDependencies = {},
) {
  const { C, warn, dataDirAbs, readEnv } = runtime;
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const now = dependencies.now ?? (() => new Date());
  const hostName = dependencies.hostName ?? hostname;
  const userName = dependencies.userName ?? currentUser;
  const loadTrace = dependencies.loadTrace ?? (() => import("#lib/trace.ts"));
  const loadPlugins = dependencies.loadPlugins ?? tryLoadPluginCore;
  const follow = dependencies.follow ?? followUntilInterrupt;

  // English until the language is known: the translation table lives in the authored tree
  // too, and help has to print without it.
  const { tr: translate, resolve: resolveTranslate } = createLazyTranslate(
    dependencies.translate,
  );

  async function core(): Promise<TraceCore> {
    try {
      return await loadTrace();
    } catch {
      throw new Error(
        "the journal cannot be read: the agent tree is missing — run: iva update",
      );
    }
  }

  function help(): void {
    log(`
${C.b}iva trace${C.x} — ${translate("read the turn journal", "читать журнал хода")}

  ${C.c}iva trace tail${C.x} [--since N]  ${translate("live stream of events; N last lines first", "живой поток событий; сначала N последних строк")}
  ${C.c}iva trace show${C.x}              ${translate("the last 20 turns", "последние 20 ходов")}
  ${C.c}iva trace show${C.x} <session>/<turn>|last  ${translate("one turn as the list names it; also turn_12, tg:<chat>:<message> or a session id — the newest match", "один ход, как его называет список; ещё turn_12, tg:<чат>:<сообщение> или id сессии — новейший из подходящих")}
  ${C.c}iva trace open${C.x}              ${translate("the viewer address and the ssh tunnel that reaches it", "адрес вьюера и готовая команда ssh-туннеля к нему")}

  ${C.d}${translate("flags: show --full — content without the cap; show --json — the raw lines", "флаги: show --full — содержимое без обрезки; show --json — сырые строки")}${C.x}
`);
  }

  async function tail(argv: readonly string[]): Promise<void> {
    const trace = await core();
    const env = readEnv();
    const timeZone = resolveTimeZone(env.ASSISTANT_TIMEZONE);
    const data = dataDirAbs(env);
    const dir = trace.traceDir(data);
    if (!existsSync(dir))
      warn(
        translate(
          `no journal yet: ${dir} — it appears with the first turn`,
          `журнала ещё нет: ${dir} — появится с первым ходом`,
        ),
      );
    const reader = createTraceTail({
      filePath: (day) => trace.traceFilePath(day, data),
      day: (at) => trace.traceDay(at, env.ASSISTANT_TIMEZONE),
      now,
      since: flagCount(argv, "--since"),
    });
    const flush = (): void => {
      for (const event of reader.drain())
        log(formatEventLine(event, { timeZone }));
    };
    flush();
    await follow(flush);
  }

  async function show(argv: readonly string[]): Promise<void> {
    const trace = await core();
    const env = readEnv();
    const timeZone = resolveTimeZone(env.ASSISTANT_TIMEZONE);
    const dir = trace.traceDir(dataDirAbs(env));
    const turns = stitchTurns(readTraceLines(dir));
    if (turns.length === 0) {
      log(translate(`the journal is empty: ${dir}`, `журнал пуст: ${dir}`));
      return;
    }
    const selector = argv.find((value) => !value.startsWith("--"));
    if (!selector) {
      // `--json` on the list would silently print the human table instead of JSON, and a
      // pipe that gets prose where it asked for lines fails somewhere far from here.
      if (argv.includes("--json"))
        throw new Error(
          "--json shows one turn: iva trace show --json <session>/<turn>|last",
        );
      log(
        translate(
          "One turn: iva trace show <session>/<turn>|last",
          "Один ход: iva trace show <сессия>/<ход>|last",
        ),
      );
      for (const line of formatTurnList(turns, { timeZone })) log(line);
      return;
    }
    const turn = selectTurn(turns, selector);
    if (!turn)
      throw new Error(
        `no turn ${selector} in the journal — list them: iva trace show`,
      );
    if (argv.includes("--json")) {
      for (const event of turn.events) log(event.raw);
      return;
    }
    for (const line of formatTurn(turn, {
      timeZone,
      full: argv.includes("--full"),
    }))
      log(line);
  }

  async function open(): Promise<void> {
    const env = readEnv();
    const data = dataDirAbs(env);
    let port = TRACE_VIEWER_PORT;
    const plugins = await loadPlugins();
    if (!plugins) {
      warn(
        translate(
          "the plugin state cannot be read: the agent tree is missing — run: iva update",
          "состояние плагинов не прочитать: дерева агента нет — запусти: iva update",
        ),
      );
    } else {
      const state = await plugins.store.readPluginsState(data);
      const entry = plugins.store.findPlugin(state, TRACE_PLUGIN);
      if (!entry)
        warn(
          translate(
            "the viewer is not installed — install it: iva plugin add trace",
            "вьюер не поставлен — поставить: iva plugin add trace",
          ),
        );
      else {
        if (!entry.enabled)
          warn(
            translate(
              "the trace plugin is off — turn it on: iva plugin enable trace",
              "плагин trace выключен — включить: iva plugin enable trace",
            ),
          );
        port = readServicePort(
          join(
            plugins.store.pluginRoot(data, TRACE_PLUGIN),
            "sh.iva/services/viewer/service.json",
          ),
        );
      }
    }
    const command = sshTunnel(
      port,
      userName(),
      sshHost(env.ASSISTANT_HOST, hostName),
    );
    log(
      `1. ${translate("Run this on your computer", "Запусти это у себя на компьютере")}: ${C.c}${command}${C.x}`,
    );
    log(
      `2. ${translate("Then open in the browser", "Потом открой в браузере")}: ${C.c}${viewerUrl(port)}${C.x}`,
    );
  }

  async function cmdTrace(args: readonly string[]): Promise<void> {
    const [sub, ...rest] = args;
    await resolveTranslate();
    if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h")
      return help();
    switch (sub) {
      case "tail":
        return tail(rest);
      case "show":
        return show(rest);
      case "open":
        return open();
      default:
        throw new Error(`unknown: iva trace ${sub} — tail, show, open`);
    }
  }

  return { cmdTrace };
}
