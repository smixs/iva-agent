import { randomUUID } from "node:crypto";
import { traceContextParts, traceTurnBound } from "./trace.ts";
import { localStamp } from "./vault-daily.ts";
import { resolveVaultDir } from "@iva/vault-dir";
import { QUEUED_STATUS_CLEARED } from "./run-status.ts";

type ChatStatus = Record<string, unknown> | null;
type GetStatus = (chatKey: string) => ChatStatus;
type SetStatusIf = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
  options?: { touch?: boolean },
) => unknown;

export interface PublishTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId?: string;
  now?: () => number;
  staleMs?: number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface PublishTelegramTurnStartedOptions {
  chatKey: string;
  sessionId: string;
  turnId: string;
  draftId: number;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface AbandonTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface EmitTelegramTurnLatencyOptions {
  chatKey: string;
  sessionId: string;
  deliveryAt: number;
  delivered: boolean;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  logImpl?: (line: string) => void;
}

export interface MarkTelegramFirstOutputOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export interface MarkTelegramTurnAliveOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  minIntervalMs?: number;
  beats?: Map<string, TurnHeartbeat>;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export type TurnHeartbeat = { sessionId: string; at: number };

export interface TakeOverTelegramChatOptions {
  chatKey: string;
  patch: Record<string, unknown>;
  now?: () => number;
  staleMs?: number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  onWorkingStatusError?: (error: unknown) => void;
  refuseImpl?: (status: ChatStatus) => boolean;
}

export function chatTakeOverPatch(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: "running",
    ingressId: null,
    ingressAt: null,
    turnAt: null,
    firstOutputAt: null,
    sessionId: null,
    turnId: null,
    compacting: null,
    draftId: null,
    latencyLogged: null,
    resetAt: null,
    // Принятая реплика заберёт Стоп в inbound; новый фоновый ход его снимает.
    ...(fields.ingressId === undefined ? { wasCancelled: null } : {}),
    restartRetryData: null,
    restartRetryUpdate: null,
    restartRetryQuestion: null,
    restartRetryMedia: null,
    ...fields,
  };
}

const freshRunning = (
  status: ChatStatus,
  at: number,
  staleMs: number,
): boolean =>
  status?.status === "running" &&
  typeof status.updatedAt === "number" &&
  at - status.updatedAt < staleMs;

type ClaimStep = {
  readonly chatKey: string;
  readonly patch: Record<string, unknown>;
  readonly at: number;
  readonly staleMs: number;
  readonly getStatusImpl: GetStatus;
  readonly setStatusIfImpl: SetStatusIf;
  readonly refuseImpl?: (status: ChatStatus) => boolean;
};

function claimOnce(step: ClaimStep): {
  readonly taken: boolean;
  readonly live: boolean;
} {
  const current = step.getStatusImpl(step.chatKey);
  if (
    freshRunning(current, step.at, step.staleMs) ||
    step.refuseImpl?.(current)
  )
    return { taken: false, live: true };
  const claimed = step.setStatusIfImpl(
    step.chatKey,
    { generation: current?.generation },
    step.patch,
  );
  return claimed
    ? {
        taken: true,
        live: false,
      }
    : { taken: false, live: false };
}

export function takeOverTelegramChat(
  options: TakeOverTelegramChatOptions,
): Promise<boolean> {
  return Promise.resolve(claimChat(options) === "taken");
}

function claimChat({
  chatKey,
  patch,
  now,
  staleMs,
  getStatusImpl,
  setStatusIfImpl,
  onWorkingStatusError,
  refuseImpl,
}: TakeOverTelegramChatOptions): "taken" | "live" | "lost" {
  const step: ClaimStep = {
    chatKey,
    patch,
    at: (now ?? Date.now)(),
    staleMs: staleMs ?? 30 * 60_000,
    getStatusImpl,
    setStatusIfImpl,
    refuseImpl,
  };
  const onError = onWorkingStatusError ?? (() => {});
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { taken, live } = claimOnce(step);
      if (live) return "live";
      if (!taken) continue;
      return "taken";
    }
  } catch (error) {
    onError(error);
  }
  return "lost";
}

export const TURN_HEARTBEAT_MIN_INTERVAL_MS = 60_000;
const turnHeartbeats = new Map<string, TurnHeartbeat>();

const durationFromIngress = (ingressAt: unknown, at: unknown): number | null =>
  typeof ingressAt === "number" &&
  Number.isFinite(ingressAt) &&
  typeof at === "number" &&
  Number.isFinite(at) &&
  at >= ingressAt
    ? at - ingressAt
    : null;

function holdQueuedIngress(
  chatKey: string,
  current: ChatStatus,
  ingressId: string,
  ingressAt: number,
  setStatusIfImpl: SetStatusIf,
): void {
  if (current?.queuedIngressId !== undefined) return;
  setStatusIfImpl(
    chatKey,
    { status: "running", queuedIngressId: undefined },
    {
      queuedIngressId: ingressId,
      queuedIngressAt: ingressAt,
      queuedSessionId: sessionIdOf(current),
    },
    { touch: false },
  );
}

const sessionIdOf = (current: ChatStatus): string | null =>
  typeof current?.sessionId === "string" ? current.sessionId : null;

const matches = (value: unknown, wanted: string | undefined): boolean =>
  wanted === undefined || value === wanted;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function queuedStatusOf(
  current: ChatStatus,
  sessionId: string,
): Record<string, unknown> {
  if (current?.queuedIngressId === undefined) return {};
  const ingressAt =
    current.queuedSessionId === sessionId
      ? finiteNumber(current.queuedIngressAt)
      : undefined;
  return {
    ...QUEUED_STATUS_CLEARED,
    ...(ingressAt === undefined ? {} : { ingressAt }),
  };
}

export function detachQueuedSignTime({
  chatKey,
  getStatusImpl,
  setStatusIfImpl,
}: Pick<
  DropQueuedStatusOptions,
  "chatKey" | "getStatusImpl" | "setStatusIfImpl"
>): boolean {
  const owner = getStatusImpl(chatKey)?.queuedIngressId;
  return (
    owner !== undefined &&
    Boolean(
      setStatusIfImpl(
        chatKey,
        { queuedIngressId: owner },
        { queuedIngressAt: null },
        { touch: false },
      ),
    )
  );
}

export interface DropQueuedStatusOptions {
  chatKey: string;
  ingressId?: string;
  sessionId?: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  onWorkingStatusError?: (error: unknown) => void;
}

export function dropQueuedStatus({
  chatKey,
  ingressId,
  sessionId,
  getStatusImpl,
  setStatusIfImpl,
}: DropQueuedStatusOptions): Promise<boolean> {
  const current = getStatusImpl(chatKey);
  const owner = current?.queuedIngressId;
  if (
    owner === undefined ||
    !matches(owner, ingressId) ||
    !matches(current?.queuedSessionId, sessionId)
  )
    return Promise.resolve(false);
  if (
    !setStatusIfImpl(
      chatKey,
      { queuedIngressId: owner },
      QUEUED_STATUS_CLEARED,
      { touch: false },
    )
  )
    return Promise.resolve(false);
  return Promise.resolve(true);
}

export function publishTelegramEarlyStatus({
  chatKey,
  ingressId = randomUUID(),
  now = Date.now,
  staleMs = 30 * 60_000,
  getStatusImpl,
  setStatusIfImpl,
  onWorkingStatusError,
}: PublishTelegramEarlyStatusOptions): Promise<string | null> {
  const ingressAt = now();
  // Мост пропускает реплаи на сообщения бота мимо busy-очереди, поэтому сюда можно
  // попасть, пока предыдущий ход ещё бежит. Клейм общий с ходом напоминания
  // (takeOverTelegramChat): живой ход не трогаем, а сообщению, вставшему за ним в
  // очередь, сразу ставим знак (sendQueuedStatus) — иначе под ним пусто до конца
  // чужого хода. Протухшую запись забираем и прибираем осиротевший индикатор.
  const claimed = claimChat({
    chatKey,
    patch: chatTakeOverPatch({ ingressId, ingressAt }),
    now: () => ingressAt,
    staleMs,
    getStatusImpl,
    setStatusIfImpl,
    onWorkingStatusError,
  });
  if (claimed === "live")
    holdQueuedIngress(
      chatKey,
      getStatusImpl(chatKey),
      ingressId,
      ingressAt,
      setStatusIfImpl,
    );
  return Promise.resolve(claimed === "taken" ? ingressId : null);
}

export async function publishTelegramTurnStarted({
  chatKey,
  sessionId,
  turnId,
  draftId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
  onWorkingStatusError = () => {},
}: PublishTelegramTurnStartedOptions): Promise<boolean> {
  // Trace: ключ апдейта ↔ ход. Единственное место, где события «до хода» (Bridge,
  // Inbound pipeline, Gate) сшиваются с событиями eve — раньше turnId не существует.
  // Рядом — состав памяти, которая уедет в системный промпт этого хода.
  traceTurnBound(chatKey, sessionId, turnId);
  traceContextParts(
    turnId,
    sessionId,
    resolveVaultDir(process.cwd()),
    localStamp().date,
  );
  const current = getStatusImpl(chatKey);
  try {
    if (current?.resetAt !== undefined) {
      await dropQueuedStatus({
        chatKey,
        getStatusImpl: () => current,
        setStatusIfImpl,
      });
      return false;
    }
    const early =
      current?.status === "running" &&
      typeof current.ingressId === "string" &&
      current.sessionId === undefined;
    return Boolean(
      setStatusIfImpl(
        chatKey,
        early
          ? {
              status: "running",
              ingressId: current.ingressId,
              sessionId: undefined,
            }
          : { generation: current?.generation },
        {
          status: "running",
          sessionId,
          turnId,
          draftId,
          wasCancelled: null,
          compacting: null,
          turnAt: now(),
          latencyLogged: null,
          ...(early
            ? current.queuedIngressId === undefined
              ? {}
              : QUEUED_STATUS_CLEARED
            : queuedStatusOf(current, sessionId)),
        },
      ),
    );
  } catch (error) {
    onWorkingStatusError(error);
    return false;
  }
}

export async function abandonTelegramEarlyStatus(
  options: AbandonTelegramEarlyStatusOptions,
): Promise<boolean> {
  return (await dropQueuedStatus(options)) || abandonOwnEarlyStatus(options);
}

function abandonOwnEarlyStatus({
  chatKey,
  ingressId,
  getStatusImpl,
  setStatusIfImpl,
}: AbandonTelegramEarlyStatusOptions): Promise<boolean> {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.ingressId !== ingressId ||
    current.sessionId !== undefined
  ) {
    return Promise.resolve(false);
  }
  const cleared = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId, sessionId: undefined },
    {
      status: "idle",
      ingressId: null,
      ingressAt: null,
      turnAt: null,
      firstOutputAt: null,
      draftId: null,
      latencyLogged: null,
    },
  );
  if (!cleared) return Promise.resolve(false);
  return Promise.resolve(true);
}

export function markTelegramFirstOutput({
  chatKey,
  sessionId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramFirstOutputOptions): boolean {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.firstOutputAt !== undefined
  ) {
    return false;
  }
  return Boolean(
    setStatusIfImpl(
      chatKey,
      { status: "running", sessionId, firstOutputAt: undefined },
      { firstOutputAt: now() },
    ),
  );
}

export function markTelegramTurnAlive({
  chatKey,
  sessionId,
  now = Date.now,
  minIntervalMs = TURN_HEARTBEAT_MIN_INTERVAL_MS,
  beats = turnHeartbeats,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramTurnAliveOptions): boolean {
  const at = now();
  const previous = beats.get(chatKey);
  if (previous?.sessionId === sessionId && at - previous.at < minIntervalMs)
    return false;
  const current = getStatusImpl(chatKey);
  if (current?.status !== "running" || current.sessionId !== sessionId) {
    // Ход этого чата уже не наш: пульс не пишем и забываем его отметку.
    if (previous !== undefined) beats.delete(chatKey);
    return false;
  }
  // Отметку ставим до записи: сбойный CAS не должен превращать поток событий в
  // поток попыток записи. Следующая попытка всё равно придёт через интервал.
  beats.set(chatKey, { sessionId, at });
  // Патч пустой намеренно: пульсу нечего сообщать, кроме «я жив», а любая успешная
  // запись run-status двигает updatedAt (agent/lib/run-status.ts). Отдельное поле
  // дублировало бы updatedAt и требовало уборки в каждом терминальном патче.
  return Boolean(
    setStatusIfImpl(chatKey, { status: "running", sessionId }, {}),
  );
}

export function emitTelegramTurnLatency({
  chatKey,
  sessionId,
  deliveryAt,
  delivered,
  getStatusImpl,
  setStatusIfImpl,
  logImpl = console.log,
}: EmitTelegramTurnLatencyOptions): boolean {
  if (delivered !== true) return false;
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.latencyLogged !== undefined
  ) {
    return false;
  }
  const marked = setStatusIfImpl(
    chatKey,
    { status: "running", sessionId, latencyLogged: undefined },
    { latencyLogged: true },
  );
  if (!marked) return false;

  const record = {
    event: "telegram_turn_latency",
    ingressToTurnMs: durationFromIngress(current.ingressAt, current.turnAt),
    ingressToFirstOutputMs: durationFromIngress(
      current.ingressAt,
      current.firstOutputAt,
    ),
    ingressToDeliveryMs: durationFromIngress(current.ingressAt, deliveryAt),
  };
  logImpl(JSON.stringify(record));
  return true;
}
