import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./data-dir.ts";
import { quarantineDamagedRecord } from "./damaged-record.ts";
import { acquireLock, releaseLock, saveJsonAtomic } from "./json-store.ts";
import { goalSchema, helperIdSchema, settleGoal } from "./goal-rules.ts";

export const HELPER_MAX_OPEN = 3,
  HELPER_MAX_ROWS = 20;
export const HELPER_DEADLINE_MS = 2700000,
  HELPER_GRACE_MS = 120000;
export const HELPER_CEILING_TOKENS = 1000000;
export const HELPER_MAX_RUNNING = 3;
export const HELPER_CHECK_MS = 15000;
export const HELPER_SUMMARY_MAX = 1500,
  HELPER_KEEP_MS = 86400000;
const integer = z.number().int().nonnegative();
const text = z.string().min(1);
const chatSchema = goalSchema.shape.chat;
const runSchema = z.strictObject({
  firedAt: integer,
  ownerStartedAt: integer,
  deadlineAtMs: integer,
  sessionId: text.nullable(),
});
const rowSchema = z
  .strictObject({
    id: helperIdSchema,
    goal: goalSchema.shape.id.nullable().default(null),
    task: z.string().trim().min(1).max(2000),
    may: z.string().max(500),
    chat: chatSchema,
    createdAt: integer,
    status: z.enum(["pending", "finished", "closed"]),
    run: runSchema.nullable(),
    stop: z.enum(["deadline", "ceiling", "closed"]).nullable(),
    outcome: z
      .enum([
        "done",
        "empty",
        "failed",
        "deadline",
        "ceiling",
        "interrupted",
        "stopped",
      ])
      .nullable(),
    summary: z.string().max(HELPER_SUMMARY_MAX).nullable(),
    reason: z.string().nullable(),
    model: z.string().nullable(),
    steps: integer,
    tokens: integer,
    finishedAt: integer.nullable(),
    deliveredAt: integer.nullable(),
  })
  .refine(
    (r) =>
      (r.status === "pending"
        ? r.outcome === null && r.finishedAt === null
        : r.outcome !== null && r.finishedAt !== null && r.run === null) &&
      (r.stop === null || r.run !== null || r.outcome !== null) &&
      (r.deliveredAt === null || r.status === "finished"),
    "inconsistent helper row",
  );
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    rows: z.array(z.unknown()),
    goals: z.array(z.unknown()).default([]),
  })
  .passthrough();
const rowsSchema = z
  .array(rowSchema)
  .max(HELPER_MAX_ROWS)
  .refine(
    (rows) =>
      new Set(rows.map((r) => r.id)).size === rows.length &&
      rows.filter((r) => r.status === "pending").length <= HELPER_MAX_OPEN,
    "duplicate id or pending capacity",
  );
const storedGoalSchema = goalSchema.refine(
  (g) =>
    (g.nextCheckAtMs !== null) === (g.status === "active") &&
    (g.pause !== null) === (g.status === "paused") &&
    (g.verdict === null || g.check !== null),
  "inconsistent goal",
);
const goalsSchema = z
  .array(storedGoalSchema)
  .refine(
    (goals) => new Set(goals.map((g) => g.id)).size === goals.length,
    "duplicate goal id",
  );
const stateSchema = documentSchema
  .extend({ rows: rowsSchema, goals: goalsSchema.default([]) })
  .refine(
    (s) =>
      s.goals.every(
        (g) =>
          g.check === null ||
          (g.status === "active" &&
            s.rows.some(
              (r) =>
                r.id === g.check && r.goal === g.id && r.status === "pending",
            )),
      ),
    "inconsistent goal links",
  );
export type HelperRow = z.infer<typeof rowSchema>;
export type HelpersState = z.infer<typeof stateSchema>;
export type HelperChat = HelperRow["chat"];
export type HelperStatus = HelperRow["status"];
export type HelperStop = NonNullable<HelperRow["stop"]>;
export type HelperOutcome = NonNullable<HelperRow["outcome"]>;
export type HelperExpected =
  { kind: "pending"; createdAt: number } | { kind: "running"; firedAt: number };
export type HelperFinish = Pick<
  HelperRow,
  "summary" | "reason" | "model" | "steps" | "tokens"
> & { outcome: HelperOutcome };
export type HelperShow = { row: HelperRow };
export type HelperClose = {
  row: HelperRow;
  branch: "pending" | "running" | "finished";
  rule: string | null;
};
export type HelperRefusal =
  | "invalid-input"
  | "capacity"
  | "max-rows"
  | "not-found"
  | "foreign-chat"
  | "no-outcome"
  | "already-delivered";
export type HelperResult<T extends object> =
  ({ ok: true } & T) | { ok: false; reason: HelperRefusal; text: string };
export type { HelperTraceEvent } from "./trace.ts";
export class HelperStoreError extends Error {}
const file = () => join(dataDir(), "helpers.json");
const root = () => join(dataDir(), "helpers");
export const sameChat = (a: HelperChat, b: HelperChat) =>
  a.id === b.id && a.threadId === b.threadId;
export const ready = (r: HelperRow) =>
  r.status === "finished" && r.deliveredAt === null;
const running = (r: HelperRow, firedAt: number) =>
  r.run?.firedAt === firedAt && r.outcome === null;
const refuse = (reason: HelperRefusal, text: string) => ({
  ok: false as const,
  reason,
  text,
});
export function helperResultPath(id: string): string {
  if (!/^h-[0-9a-f]{6}$/.test(id))
    throw new HelperStoreError("invalid helper id");
  return join(root(), id, "out", "result.md");
}
export async function readHelpers(path = file()): Promise<HelpersState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, rows: [], goals: [] };
    throw new HelperStoreError(`${path}: ${String(error)}`);
  }
  try {
    const document = documentSchema.parse(JSON.parse(raw));
    const state: HelpersState = { ...document, rows: [], goals: [] };
    const damaged = (label: string, record: unknown) =>
      quarantineDamagedRecord(path, {
        reason: "invalid or inconsistent row",
        record,
        label: `helpers ${label}`,
      });
    // Validate each record before checking links across the surviving records.
    const rows = document.rows.flatMap((record) => {
      const parsed = rowSchema.safeParse(record);
      if (parsed.success) return [{ row: parsed.data, record }];
      damaged("rows", record);
      return [];
    });
    for (const record of document.goals) {
      const parsed = goalsSchema.safeParse([...state.goals, record]);
      if (parsed.success) state.goals = parsed.data;
      else damaged("goals", record);
    }
    for (const { row, record } of rows) {
      const parsed = rowsSchema.safeParse([...state.rows, row]);
      if (parsed.success) state.rows = parsed.data;
      else damaged("rows", record);
    }
    for (const row of state.rows)
      if (row.goal !== null && !state.goals.some((g) => g.id === row.goal))
        row.goal = null;
    for (const g of state.goals) {
      // A lost or mismatched check detaches without discarding either record.
      if (
        g.check !== null &&
        !(
          g.status === "active" &&
          state.rows.some(
            (r) =>
              r.id === g.check && r.goal === g.id && r.status === "pending",
          )
        )
      )
        g.check = g.verdict = null;
    }
    stateSchema.parse(state);
    return state;
  } catch (error) {
    throw new HelperStoreError(`${path}: ${String(error)}`);
  }
}
async function locked<T>(fn: (s: HelpersState) => Promise<T>): Promise<T> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const path = `${file()}.lock`,
    token = await acquireLock(path);
  try {
    const state = await readHelpers(),
      before = [...state.rows];
    const result = await fn(state);
    for (const row of before.filter(
      (r) => !state.rows.some((v) => v.id === r.id),
    ))
      await rm(join(root(), row.id), { recursive: true, force: true }).catch(
        (error: unknown) => console.error(`helper cleanup ${row.id}:`, error),
      );
    return result;
  } finally {
    releaseLock(path, token);
  }
}
async function save(s: HelpersState) {
  await saveJsonAtomic(file(), stateSchema.parse(s), { mode: 0o600 });
}
export const mutateHelpers = <T>(
  fn: (s: HelpersState) => { save: boolean; value: T },
) =>
  locked(async (s) => {
    const result = fn(s);
    if (result.save) await save(s);
    return result.value;
  });
export function insertRow(
  s: HelpersState,
  input: Pick<HelperRow, "task" | "may" | "chat" | "goal">,
  now: number,
) {
  const reserved = Number(input.goal !== null);
  const pending = s.rows.filter((r) => r.status === "pending");
  if (pending.length >= HELPER_MAX_OPEN - reserved)
    return refuse(
      "capacity",
      `${pending.filter((r) => r.run).length} running, ${pending.filter((r) => !r.run).length} waiting, ${s.rows.filter(ready).length} outcomes; pending maximum 3. Wait, read or close.`,
    );
  const needed = Math.max(0, s.rows.length - HELPER_MAX_ROWS + reserved + 1);
  const oldest = s.rows
    .filter(
      (r) =>
        r.goal === null && (r.deliveredAt !== null || r.status === "closed"),
    )
    .sort(
      (a, b) =>
        (a.deliveredAt ?? a.finishedAt!) - (b.deliveredAt ?? b.finishedAt!),
    )
    .slice(0, needed);
  if (oldest.length < needed)
    return refuse(
      "max-rows",
      `20 helper rows: ${s.rows.map((r) => r.id).join(", ")}. All helper slots are occupied by running tasks or unread outcomes.`,
    );
  s.rows = s.rows.filter((r) => !oldest.includes(r));
  let id: string;
  do id = `h-${randomBytes(3).toString("hex")}`;
  while (s.rows.some((r) => r.id === id));
  const row: HelperRow = {
    ...input,
    id,
    createdAt: now,
    status: "pending",
    run: null,
    stop: null,
    outcome: null,
    summary: null,
    reason: null,
    model: null,
    steps: 0,
    tokens: 0,
    finishedAt: null,
    deliveredAt: null,
  };
  s.rows.push(row);
  return { ok: true as const, row };
}
export const getHelper = async (id: string) =>
  (await readHelpers()).rows.find((r) => r.id === id) ?? null;
export const listHelpers = async (chat: HelperChat) =>
  (await readHelpers()).rows.filter((r) => sameChat(r.chat, chat));
async function change(
  id: string,
  fn: (r: HelperRow, s: HelpersState) => boolean,
): Promise<HelperRow | null> {
  return locked(async (s) => {
    const r = s.rows.find((r) => r.id === id);
    if (!r || !fn(r, s)) return null;
    await save(s);
    return r;
  });
}
export async function addHelper(
  input: { task: string; may: string; chat: HelperChat },
  now: number,
): Promise<HelperResult<{ row: HelperRow }>> {
  const parsed = z
    .strictObject({
      task: rowSchema.shape.task,
      may: rowSchema.shape.may,
      chat: chatSchema,
    })
    .safeParse(input);
  if (!parsed.success) return refuse("invalid-input", parsed.error.message);
  return locked(async (s) => {
    const result = insertRow(s, { ...parsed.data, goal: null }, now);
    if (result.ok) await save(s);
    return result;
  });
}

export const claimHelper = (
  id: string,
  owner: { ownerStartedAt: number },
  now: number,
) =>
  change(id, (r, s) => {
    if (
      r.status !== "pending" ||
      r.run ||
      r.stop ||
      (r.goal !== null &&
        s.rows.some(
          (row) => row.goal === null && row.status === "pending" && !row.run,
        )) ||
      // Today HELPER_MAX_OPEN enforces this cap; helper-constants-docs.test.ts guards their relation.
      s.rows.filter((r) => r.run).length >= HELPER_MAX_RUNNING
    )
      return false;
    r.run = {
      firedAt: now,
      ownerStartedAt: owner.ownerStartedAt,
      deadlineAtMs: now + HELPER_DEADLINE_MS,
      sessionId: null,
    };
    return true;
  });
export async function recordHelperSession(
  id: string,
  firedAt: number,
  sessionId: string,
): Promise<boolean> {
  const result = await change(id, (r) => {
    if (
      !running(r, firedAt) ||
      !r.run ||
      (r.run.sessionId !== null && r.run.sessionId !== sessionId)
    )
      return false;
    r.run.sessionId = sessionId;
    return true;
  });
  return result !== null;
}
export const stopHelper = (id: string, firedAt: number, stop: HelperStop) =>
  change(id, (r) => {
    if (!running(r, firedAt)) return false;
    r.stop ??= stop;
    return true;
  });
function finishRow(
  r: HelperRow,
  f: HelperFinish,
  now: number,
  s: HelpersState,
) {
  Object.assign(r, f, {
    outcome: r.stop === "closed" ? "stopped" : (r.stop ?? f.outcome),
    status: r.stop === "closed" ? "closed" : "finished",
    run: null,
    finishedAt: now,
  });
  return r.goal === null ? null : settleGoal(s, r, now);
}
export const finalizeHelper = (
  id: string,
  expected: HelperExpected,
  finish: HelperFinish,
  now: number,
) =>
  mutateHelpers((s) => {
    const r = s.rows.find((r) => r.id === id);
    if (
      !r ||
      r.outcome !== null ||
      r.status !== "pending" ||
      (expected.kind === "running"
        ? !running(r, expected.firedAt)
        : r.run !== null || r.createdAt !== expected.createdAt)
    )
      return { save: false, value: null };
    const rule = finishRow(r, finish, now, s);
    return { save: true, value: { ...r, rule } };
  });
export function closeRow(s: HelpersState, row: HelperRow, now: number) {
  const branch = row.run ? "running" : row.outcome ? "finished" : "pending";
  let rule: string | null = null;
  if (branch === "running") row.stop ??= "closed";
  else if (branch === "pending") {
    row.stop = "closed";
    rule = finishRow(
      row,
      {
        outcome: "stopped",
        summary: null,
        reason: null,
        model: null,
        steps: 0,
        tokens: 0,
      },
      now,
      s,
    );
  } else row.status = "closed";
  return { branch, rule } satisfies Omit<HelperClose, "row">;
}
export async function closeHelper(
  id: string,
  chat: HelperChat,
  now: number,
): Promise<HelperResult<HelperClose>> {
  return locked(async (s) => {
    const row = s.rows.find((r) => r.id === id);
    if (!row) return refuse("not-found", "Helper not found.");
    if (!sameChat(row.chat, chat))
      return refuse("foreign-chat", "Helper belongs to another chat.");
    if (row.deliveredAt !== null) {
      if (row.goal !== null)
        return refuse("already-delivered", "Outcome already delivered.");
      s.rows = s.rows.filter((r) => r.id !== id);
      await save(s);
      return { ok: true, row, branch: "finished", rule: null };
    }
    const result = closeRow(s, row, now);
    await save(s);
    return { ok: true, row, ...result };
  });
}
export async function showHelper(
  id: string,
  chat: HelperChat,
): Promise<HelperResult<HelperShow>> {
  const s = await readHelpers();
  const row = s.rows.find((r) => r.id === id);
  if (!row) return refuse("not-found", "Helper not found.");
  if (!sameChat(row.chat, chat))
    return refuse("foreign-chat", "Helper belongs to another chat.");
  if (row.outcome === null && row.stop !== "closed")
    return refuse("no-outcome", "Helper has not finished.");
  return { ok: true, row };
}
export async function markHelperDelivered(
  id: string,
  chat: HelperChat,
  now: number,
): Promise<HelperRow | null> {
  return locked(async (s) => {
    const row = s.rows.find(
      (r) => r.id === id && ready(r) && sameChat(r.chat, chat),
    );
    if (!row) return null;
    row.deliveredAt = now;
    await save(s);
    return row;
  });
}
export async function sweepHelpers(now: number): Promise<string[]> {
  return locked(async (s) => {
    const removed = s.rows
      .filter(
        (r) =>
          !r.run &&
          ((r.goal !== null &&
            (r.status === "closed" || r.deliveredAt !== null)) ||
            (r.status === "closed" &&
              r.finishedAt !== null &&
              r.finishedAt + HELPER_KEEP_MS <= now) ||
            (r.deliveredAt !== null && r.deliveredAt + HELPER_KEEP_MS <= now)),
      )
      .map((r) => r.id);
    if (removed.length) {
      s.rows = s.rows.filter((r) => !removed.includes(r.id));
      await save(s);
    }
    return removed;
  });
}
