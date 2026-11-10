// Состояние Job по записи (машина Job, модель specs/JobRun.tla): бронь имени в
// data/rollup-status.json и его факты в data/jobs.json. Бронь пишет и снимает раннер
// (agent/lib/schedule-runner.ts); здесь — как её читать. Зовут: допуск раннера, `iva jobs`,
// `iva doctor` и незакрытые провалы (agent/lib/open-failures.ts), через них — сторож Job.
//
// Формат на диске прежний: бронь — три поля записи имени (inProgressSince, ownerPid,
// ownerStartedAt) рядом с гвардами. Запись без ownerPid (раннер до владельца брони) держит
// допуск только до срока.
import { z } from "zod";
import { latestFact, type JobFact } from "./job-facts.ts";

const processOwner = globalThis as typeof globalThis & {
  ivaOwnerStartedAt?: number;
};
/** Воплощение процесса: одно значение на процесс, общее для всех копий модуля. */
export const OWNER_STARTED_AT = (processOwner.ivaOwnerStartedAt ??= Math.round(
  Date.now() - process.uptime() * 1000,
));

const sinceSchema = z.object({ inProgressSince: z.number() });
const ownedSchema = sinceSchema.extend({
  ownerPid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerStartedAt: z.number(),
});

export type JobReservation =
  | { readonly kind: "none" }
  | { readonly kind: "unowned"; readonly since: number }
  | {
      readonly kind: "owned";
      readonly since: number;
      readonly ownerPid: number;
      readonly ownerStartedAt: number;
    };

/** Бронь записи имени; чужая форма полей — брони нет, как и раньше. */
export function jobReservation(entry: unknown): JobReservation {
  const owned = ownedSchema.safeParse(entry);
  if (owned.success)
    return {
      kind: "owned",
      since: owned.data.inProgressSince,
      ownerPid: owned.data.ownerPid,
      ownerStartedAt: owned.data.ownerStartedAt,
    };
  const since = sinceSchema.safeParse(entry);
  return since.success
    ? { kind: "unowned", since: since.data.inProgressSince }
    : { kind: "none" };
}

/** Владелец брони умер: процесса с таким pid нет. */
export function reservationOwnerIsDead(
  reservation: Extract<JobReservation, { kind: "owned" }>,
): boolean {
  try {
    process.kill(reservation.ownerPid, 0);
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ESRCH";
  }
}

// free — брони нет; running — бронь держит допуск; owner-dead и expired — бронь лежит, но
// следующий допуск её перепишет.
export const JOB_STATES = ["free", "running", "owner-dead", "expired"] as const;
export type JobStateName = (typeof JOB_STATES)[number];

export interface JobState {
  readonly state: JobStateName;
  readonly reservation: JobReservation;
  /** Последний факт имени: исход последнего завершённого запуска. */
  readonly last: JobFact | null;
}

export function jobState(
  name: string,
  {
    entry,
    facts = [],
    now = Date.now(),
    deadlineMs = Number.POSITIVE_INFINITY,
    ownerDead = reservationOwnerIsDead,
  }: {
    readonly entry?: unknown;
    readonly facts?: readonly JobFact[];
    readonly now?: number;
    /** Срок брони: timeoutMs запуска, бесконечность — срока нет. */
    readonly deadlineMs?: number;
    readonly ownerDead?: typeof reservationOwnerIsDead;
  } = {},
): JobState {
  const reservation = jobReservation(entry);
  const last = latestFact(facts, name);
  const state: JobStateName =
    reservation.kind === "none"
      ? "free"
      : now - reservation.since >= deadlineMs
        ? "expired"
        : reservation.kind === "owned" && ownerDead(reservation)
          ? "owner-dead"
          : "running";
  return { state, reservation, last };
}
