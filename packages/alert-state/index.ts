// The existing Notice throttle, shared by the agent dispatcher and operational scripts.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

// ── Alert: алерт, который нельзя выключить ───────────────────────────────────────────────
export const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

type AlertRecord = { essence: string; lastSentAt: number };
export type AlertState = Record<string, AlertRecord>;

function alertStatePath(dataDir: string): string {
  return join(dataDir, "alert-state.json");
}

// Битый, недописанный или чужой формат состояния значит «слать»: fail-open. Замолчавшая
// алерт стоит дороже, чем увиденный дважды, поэтому непонятная запись просто теряется.
export function readAlertState(dataDir: string): AlertState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(alertStatePath(dataDir), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  const state: AlertState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const { essence, lastSentAt } = value as {
      essence?: unknown;
      lastSentAt?: unknown;
    };
    if (
      typeof essence === "string" &&
      typeof lastSentAt === "number" &&
      Number.isFinite(lastSentAt)
    )
      state[key] = { essence, lastSentAt };
  }
  return state;
}

// Запись состояния — своя, из node:fs, а НЕ через #lib/fs-atomic.ts. Дроссель нужен ровно
// той установке, у которой authored tree сломан: там алерт `authored-tree` уходит каждую
// ночь, и статический импорт из agent/ упал бы вместе с ним — недельный дроссель умер бы там,
// где он нужнее всего. Механизм тот же (tmp + rename), три строки, зависимостей ноль.
function writeAlertState(dataDir: string, state: AlertState): boolean {
  const path = alertStatePath(dataDir);
  // Уникален на вызов, а не на миллисекунду. Живого бага здесь нет: записи синхронные, и
  // одному процессу поделить имя не с кем. Это дешёвая страховка на случай второго писателя
  // — цена ошибки на флаге "wx" была бы потерянной отметкой дросселя.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path);
    return true;
  } catch (error) {
    // Не записалось — алерт повторится завтра, а это безопасная сторона.
    console.error("[notice-policy] could not record the alert state:", error);
    try {
      rmSync(temp, { force: true });
    } catch {
      /* tmp уже забрал rename или его не удалось создать вовсе */
    }
    return false;
  }
}

// Operational scripts resolve the existing lock lazily. The built agent injects its
// static authored import, because the output package has no source import aliases.
// Scripts without an authored tree retain their atomic write without a lock.
type AlertLock = Pick<
  typeof import("#lib/fs-atomic.ts"),
  "acquireFileLockSync" | "releaseFileLock"
>;
let alertLockLib: AlertLock | null | undefined;
export function configureAlertLock(lock: AlertLock): void {
  alertLockLib = lock;
}
function alertLock(): AlertLock | null {
  if (alertLockLib === undefined)
    try {
      alertLockLib = createRequire(import.meta.url)(
        "#lib/fs-atomic.ts",
      ) as AlertLock;
    } catch {
      alertLockLib = null;
    }
  return alertLockLib;
}
/** Сколько ждать чужую запись состояния: сама запись — миллисекунды. */
const ALERT_LOCK_WAIT_MS = 1_000;

/**
 * Одна правка состояния дросселя под замком: прочитать, поменять, записать. `change` отвечает,
 * есть ли что писать. Замок не взят или запись не прошла — false. `afterRead` — шов теста
 * (второй писатель между чтением и записью).
 */
export function updateAlertState(
  dataDir: string,
  change: (state: AlertState) => boolean,
  afterRead?: () => void,
): boolean {
  const lock = lockAlertState(dataDir);
  if (lock === "refused") return false;
  try {
    const state = readAlertState(dataDir);
    afterRead?.();
    return change(state) ? writeAlertState(dataDir, state) : true;
  } finally {
    if (lock !== null) alertLock()?.releaseFileLock(lock);
  }
}

/** The agent always injects its lock; null is the script fallback without agent/. */
function lockAlertState(
  dataDir: string,
):
  NonNullable<ReturnType<AlertLock["acquireFileLockSync"]>> | null | "refused" {
  const lib = alertLock();
  if (lib === null) return null;
  try {
    const lock = lib.acquireFileLockSync(join(dataDir, "alert-state.lock"), {
      timeoutMs: ALERT_LOCK_WAIT_MS,
    });
    if (lock !== null) return lock;
    console.error("[notice-policy] the alert state is busy, not recorded");
  } catch (error) {
    console.error("[notice-policy] could not lock the alert state:", error);
  }
  return "refused";
}

/**
 * Отметка дросселя: алерт с этим существом сказан сейчас. Одна запись на alertOnce и на сбой,
 * доставленный Watch (scripts/proactive/tick.ts); false — не записалась.
 */
export function recordAlert(
  dataDir: string,
  key: string,
  essence: string,
  now: number = Date.now(),
): boolean {
  return updateAlertState(dataDir, (state) => {
    state[key] = { essence, lastSentAt: now };
    return true;
  });
}

/**
 * Пора ли говорить: записи нет, существо проблемы сменилось, прошёл период
 * повтора (по умолчанию неделя) — или часы ушли назад (запись из будущего
 * иначе заглушила бы алерт навсегда).
 */
export function alertDue(
  dataDir: string,
  key: string,
  essence: string,
  now: number = Date.now(),
  repeatMs: number = ALERT_REPEAT_MS,
): boolean {
  const record = readAlertState(dataDir)[key];
  if (!record) return true;
  if (record.essence !== essence) return true;
  const elapsed = now - record.lastSentAt;
  return elapsed >= repeatMs || elapsed < 0;
}

/**
 * Алерт с дросселем. Состояние обновляется только после состоявшейся отправки:
 * неотправленный алерт не имеет права заглушить следующий.
 */
export async function alertOnce(
  dataDir: string,
  key: string,
  essence: string,
  send: () => Promise<boolean>,
  repeatMs: number = ALERT_REPEAT_MS,
): Promise<"sent" | "throttled" | "failed"> {
  if (!alertDue(dataDir, key, essence, Date.now(), repeatMs))
    return "throttled";
  if (!(await send())) return "failed";
  recordAlert(dataDir, key, essence);
  return "sent";
}

/** Проблема ушла: забыть её, чтобы завтрашний рецидив заговорил сразу, а не через неделю. */
export function alertResolved(dataDir: string, key: string): void {
  // Без записи нечего забывать — и незачем ни брать замок, ни трогать файл.
  if (!(key in readAlertState(dataDir))) return;
  updateAlertState(dataDir, (state) => {
    if (!(key in state)) return false;
    delete state[key];
    return true;
  });
}
