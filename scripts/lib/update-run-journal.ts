// Один журнал хода обновления на диске: фаза, снимок юнитов и пути карантина
// (specs/UpdateRun.tla). Процесс обновлятора умирает вместе с версией, которую выводит
// из обращения, и его памяти не остаётся. Поэтому всё, что нужно повтору, `iva doctor`
// и Bridge, лежит здесь одним файлом, и читается оно одной функцией - `readUpdateRun`.
//
// Файл новый: версии до 0.5.12 его не читают и не замечают, откат на 0.5.11 его не
// трогает. Формат меняется только с обратным чтением: неизвестная фаза читается как
// «ход не завершён», а не как повод его не продолжать.
import { join } from "node:path";
import { readJson, writeJson } from "./version-store.ts";

export const UPDATE_RUN_FILE = "update-run.json";
export const UPDATE_RUN_SCHEMA = "iva-update-run/v1";

/** Шаги хода: ровно те, на которых обновлятор пишет журнал. */
export type UpdateRunPhase =
  | "prepared"
  | "stopped"
  | "quarantined"
  | "migrated"
  | "flipped"
  | "started"
  | "settled"
  | "done"
  | "rolledback"
  | "failed";

const PHASES: readonly UpdateRunPhase[] = [
  "prepared",
  "stopped",
  "quarantined",
  "migrated",
  "flipped",
  "started",
  "settled",
  "done",
  "rolledback",
  "failed",
];

/** Фазы, после которых ход не продолжают, а итог читают: ход закончен любым исходом. */
const FINAL_PHASES: readonly UpdateRunPhase[] = [
  "done",
  "rolledback",
  "failed",
];

/** Снимок одного юнита: ровно то, что снимает captureOptionalWriterState. */
export type UpdateRunUnit = {
  readonly unit: string;
  readonly loadState: string;
  readonly active: boolean;
  readonly enabled: boolean;
};

/** Состояние, унесённое в карантин: где оно лежало и куда ушло. */
export type UpdateRunQuarantine = {
  readonly path: string;
  readonly trash: string;
  /** Исходный путь до `throughLink`; без него каталог за унесённым не завести заново. */
  readonly link?: string;
};

export type UpdateRunOutcome = {
  readonly status: "updated" | "current" | "unhealthy" | "failed";
  readonly before?: string;
  readonly after?: string;
  readonly message?: string;
};

export type UpdateRun = {
  readonly schema: typeof UPDATE_RUN_SCHEMA;
  readonly version: string;
  readonly from: string | null;
  readonly phase: UpdateRunPhase;
  /** Сколько раз ход начинали: первый запуск и каждый повтор после обрыва. */
  readonly attempts: number;
  readonly units: readonly UpdateRunUnit[];
  readonly quarantine: readonly UpdateRunQuarantine[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly outcome?: UpdateRunOutcome;
};

/** Путь журнала хода в каталоге данных установки. */
export function updateRunPath(dataDir: string): string {
  return join(dataDir, UPDATE_RUN_FILE);
}

function unitsOf(value: unknown): UpdateRunUnit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const one = entry as Record<string, unknown>;
    if (typeof one.unit !== "string" || one.unit === "") return [];
    return [
      {
        unit: one.unit,
        loadState:
          typeof one.loadState === "string" && one.loadState !== ""
            ? one.loadState
            : "loaded",
        active: one.active === true,
        enabled: one.enabled === true,
      },
    ];
  });
}

function quarantineOf(value: unknown): UpdateRunQuarantine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const one = entry as Record<string, unknown>;
    if (typeof one.path !== "string" || typeof one.trash !== "string")
      return [];
    return [
      {
        path: one.path,
        trash: one.trash,
        ...(typeof one.link === "string" ? { link: one.link } : {}),
      },
    ];
  });
}

function outcomeOf(value: unknown): UpdateRunOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const one = value as Record<string, unknown>;
  const status = one.status;
  if (
    status !== "updated" &&
    status !== "current" &&
    status !== "unhealthy" &&
    status !== "failed"
  )
    return undefined;
  return {
    status,
    ...(typeof one.before === "string" ? { before: one.before } : {}),
    ...(typeof one.after === "string" ? { after: one.after } : {}),
    ...(typeof one.message === "string" ? { message: one.message } : {}),
  };
}

/**
 * Журнал хода или null. Ничего не бросает: битый или чужой файл - это «журнала нет»,
 * и ход тогда идёт как ход без журнала. Один читатель на повтор, `iva doctor` и Bridge.
 */
export function readUpdateRun(dataDir: string): UpdateRun | null {
  const raw = readJson(updateRunPath(dataDir));
  if (raw.schema !== UPDATE_RUN_SCHEMA) return null;
  if (typeof raw.version !== "string" || raw.version === "") return null;
  const phase = PHASES.find((one) => one === raw.phase);
  if (!phase) return null;
  const units = unitsOf(raw.units);
  if (units.length === 0) return null;
  return {
    schema: UPDATE_RUN_SCHEMA,
    version: raw.version,
    from: typeof raw.from === "string" ? raw.from : null,
    phase,
    attempts: typeof raw.attempts === "number" ? raw.attempts : 1,
    units,
    quarantine: quarantineOf(raw.quarantine),
    startedAt:
      typeof raw.startedAt === "string"
        ? raw.startedAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
    ...(outcomeOf(raw.outcome) ? { outcome: outcomeOf(raw.outcome) } : {}),
  };
}

/** Ход, который оборвался и который этот повтор продолжает, или null. */
export function resumableUpdateRun(
  dataDir: string,
  version: string,
): UpdateRun | null {
  const run = readUpdateRun(dataDir);
  if (!run || run.version !== version) return null;
  return FINAL_PHASES.includes(run.phase) ? null : run;
}

/** Ход закончен: фаза говорит, чем. */
export function updateRunFinished(run: UpdateRun): boolean {
  return FINAL_PHASES.includes(run.phase);
}

function write(dataDir: string, run: UpdateRun): void {
  writeJson(updateRunPath(dataDir), {
    ...run,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Начало хода: журнал пишется до первой остановки служб. Повтор того же хода не теряет
 * записанное: снимок юнитов и пути карантина остаются те, что были до остановки, - иначе
 * повтор снял бы уже остановленное состояние за исходное.
 */
export function beginUpdateRun(
  dataDir: string,
  start: {
    readonly version: string;
    readonly from: string | null;
    readonly units: readonly UpdateRunUnit[];
    readonly quarantine: readonly UpdateRunQuarantine[];
  },
): UpdateRun {
  const previous = readUpdateRun(dataDir);
  const resumed =
    previous &&
    previous.version === start.version &&
    !updateRunFinished(previous);
  const run: UpdateRun = {
    schema: UPDATE_RUN_SCHEMA,
    version: start.version,
    from: start.from ?? previous?.from ?? null,
    phase: resumed ? previous.phase : "prepared",
    attempts: resumed ? previous.attempts + 1 : 1,
    units: resumed && previous.units.length > 0 ? previous.units : start.units,
    quarantine:
      resumed && previous.quarantine.length > 0
        ? previous.quarantine
        : start.quarantine,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  write(dataDir, run);
  return run;
}

/**
 * Фаза хода. Пишется только поверх своего журнала: если журнала нет (или он про другую
 * версию), звать нечего - ход без журнала так и идёт.
 */
export function markUpdateRun(
  dataDir: string,
  version: string,
  phase: UpdateRunPhase,
  extra: {
    readonly quarantine?: readonly UpdateRunQuarantine[];
    readonly outcome?: UpdateRunOutcome;
  } = {},
): void {
  const run = readUpdateRun(dataDir);
  if (!run || run.version !== version) return;
  write(dataDir, {
    ...run,
    phase,
    ...(extra.quarantine ? { quarantine: extra.quarantine } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
  });
}

/** Итог хода: фаза по исходу и сам исход одной записью. Ход, уже закрытый (например,
 * отказом кандидата в goBack), не переписывается: у него свой итог и своя причина. */
export function closeUpdateRun(
  dataDir: string,
  version: string,
  outcome: UpdateRunOutcome,
): void {
  const current = readUpdateRun(dataDir);
  if (!current || current.version !== version) return;
  if (updateRunFinished(current)) return;
  const phase: UpdateRunPhase =
    outcome.status === "updated" || outcome.status === "current"
      ? "done"
      : outcome.status === "unhealthy"
        ? "rolledback"
        : "failed";
  markUpdateRun(dataDir, version, phase, { outcome });
}
