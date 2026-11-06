import { Client, ClientError } from "eve/client";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { OWNER_STARTED_AT } from "./schedule-runner.ts";
import * as s from "./helper-store.ts";
import { traceHelper } from "./trace.ts";
import { isEmptyModelResponse, stepLimitNotice } from "./model-response.ts";
import { tr } from "./i18n.ts";
import {
  foldHelperSnapshot,
  helperSummary,
  isQuietReply,
} from "./helper-snapshot.ts";
import { writeFileAtomic } from "./fs-atomic.ts";
import { ownerTimeZone } from "./reminder-time.ts";
import { formatZoned } from "./zoned-time.ts";
import { dueGoals } from "./goal-store.ts";
type Session = ReturnType<Client["sessions"]["attach"]>;
const stopReasons = {
  closed: "помощник закрыт",
  ceiling: "предел работы помощника",
  deadline: "истёк срок помощника",
};
export async function runHelperTick(
  options: { nowMs?: number; log?: (...args: unknown[]) => void } = {},
): Promise<void> {
  const now = options.nowMs ?? Date.now(),
    log = options.log ?? console.error;
  const client = (id: string) =>
    new Client({
      host:
        process.env.ASSISTANT_HOST ??
        `http://127.0.0.1:${process.env.IVA_PORT ?? "8723"}`,
      auth: { bearer: process.env.ASSISTANT_BEARER ?? "" },
      headers: { "x-iva-turn": "helper", "x-iva-helper": id },
    });
  const call = () => ({ signal: AbortSignal.timeout(s.HELPER_CHECK_MS) });
  const cancel = (session: Session) =>
    session.cancel({ tasks: true, ...call() });
  const cleanup = (session: Session, cancelled = false) => {
    if (!cancelled) void cancel(session).catch(log);
    void session.reset(call()).catch(log);
  };
  const finish = async (
    row: s.HelperRow,
    state: ReturnType<typeof foldHelperSnapshot>,
    outcome = state.outcome,
    reason = stepLimitNotice(state.failureInfo, tr) ??
      (isEmptyModelResponse(state.failureInfo)
        ? "модель не дала ответа"
        : state.reason),
  ) => {
    const { text, model, steps, tokens } = state;
    const data = { model, steps, tokens };
    const usable = !!text?.trim() && !isQuietReply(text);
    const finished = await s.finalizeHelper(
      row.id,
      { kind: "running", firedAt: row.run!.firedAt },
      {
        ...data,
        outcome,
        summary: usable ? helperSummary(text!) : null,
        reason: row.stop ? stopReasons[row.stop] : reason,
      },
      now,
    );
    if (!finished) return;
    if (usable)
      try {
        await mkdir(dirname(s.helperResultPath(row.id)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFileAtomic(s.helperResultPath(row.id), text!, {
          mode: 0o600,
        });
      } catch (error) {
        log("helper result:", row.id, error);
      }
    const { outcome: result, reason: cause } = finished;
    traceHelper("finished", row.id, {
      session: row.run!.sessionId ?? undefined,
      data: {
        outcome: result,
        reason: cause,
        steps,
        tokens,
        goal: finished.goal,
        rule: finished.rule,
      },
    });
  };
  try {
    try {
      await dueGoals(now);
    } catch (error) {
      if (error instanceof s.HelperStoreError) throw error;
      log("goal due:", error);
    }
    const rows = (await s.readHelpers()).rows.sort(
      (a, b) =>
        Number(!a.run) - Number(!b.run) ||
        Number(a.goal !== null) - Number(b.goal !== null) ||
        a.createdAt - b.createdAt,
    );
    for (let row of rows)
      try {
        if (row.run) {
          const run = row.run,
            old = run.ownerStartedAt !== OWNER_STARTED_AT;
          const session = run.sessionId
            ? client(row.id).sessions.attach(run.sessionId)
            : null;
          let state = foldHelperSnapshot([]),
            readable = false,
            delivered = false;
          if (session)
            try {
              state = foldHelperSnapshot(
                (await session.snapshot(call())).events,
              );
              readable = true;
            } catch (error) {
              log("helper snapshot:", row.id, error);
            }
          if (!state.ended && old) {
            if (!session) delivered = true;
            else
              try {
                const result = await cancel(session);
                delivered =
                  result.status === "accepted" ||
                  result.status === "no_active_turn";
              } catch (error) {
                log("helper cancel:", row.id, error);
              }
          }
          if (
            state.ended ||
            delivered ||
            now >= run.deadlineAtMs + s.HELPER_GRACE_MS
          ) {
            if (!state.ended) {
              state.outcome = delivered ? "interrupted" : "deadline";
              state.reason = delivered
                ? "помощник остановлен после прерывания"
                : stopReasons.deadline;
            }
            await finish(row, state);
            if (session) cleanup(session, delivered);
            continue;
          }
          if (!old && readable) {
            const stop =
              state.tokens > s.HELPER_CEILING_TOKENS
                ? "ceiling"
                : now >= run.deadlineAtMs
                  ? "deadline"
                  : null;
            if (stop)
              row = (await s.stopHelper(row.id, run.firedAt, stop)) ?? row;
          }
          if (!old && row.stop && session) await cancel(session);
        } else if (row.status === "pending") {
          const claimed = await s.claimHelper(
            row.id,
            { ownerStartedAt: OWNER_STARTED_AT },
            now,
          );
          if (!claimed?.run) continue;
          let session;
          try {
            ({ session } = await client(row.id).sessions.create({
              ...call(),
              message: `Helper ${row.id}. Now: ${formatZoned(now, ownerTimeZone())}. Allowed: ${row.may || "nothing, look and draft only"}. Task: ${row.task}`,
            }));
          } catch (error) {
            log("helper create:", row.id, error);
            if (
              error instanceof ClientError &&
              ((error.status >= 400 && error.status < 500) || error.body)
            )
              await finish(
                claimed,
                foldHelperSnapshot([]),
                "failed",
                "помощник не смог начать",
              );
            continue;
          }
          try {
            if (
              await s.recordHelperSession(row.id, now, session.state.sessionId)
            )
              continue;
          } catch (error) {
            log("helper session:", row.id, error);
          }
          cleanup(session);
          await finish(
            claimed,
            foldHelperSnapshot([]),
            "failed",
            "ход не записан",
          );
        }
      } catch (error) {
        if (error instanceof s.HelperStoreError) throw error;
        log("helper tick:", row.id, error);
      }
    await s.sweepHelpers(now);
  } catch (error) {
    log("helper tick:", error);
    if (error instanceof s.HelperStoreError)
      traceHelper("store_broken", null, { data: { error: String(error) } });
  }
}
