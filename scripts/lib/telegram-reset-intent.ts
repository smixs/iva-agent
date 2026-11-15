import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord, isSafeInteger } from "../../packages/guards/index.ts";

export const TELEGRAM_RESET_INTENT_VERSION = 1;

export interface TelegramResetIntent {
  version: typeof TELEGRAM_RESET_INTENT_VERSION;
  chatKey: string;
  requestedAt: number;
  discardThroughUpdateId?: number;
}

// Фаза Интента сброса личного чата — оператор Phase модели specs/ResetIntent.tla.
// none — намерения нет; blocked — записать намерение не удалось, /new ждёт отсрочку в
// Telegram; recorded — намерение записано, очередь чата закрыта до очистки; waiting —
// записано, шаг сброса отказал и ждёт повтора; escalated — то же, владелец получил
// «запусти iva reset».
export const RESET_INTENT_PHASES = [
  "none",
  "blocked",
  "recorded",
  "waiting",
  "escalated",
] as const;
export type ResetIntentPhase = (typeof RESET_INTENT_PHASES)[number];

// Запись — файл намерения (его зеркало в памяти Bridge); память — отсрочка повтора и
// отметка о доставленной эскалации. Память не переживает перезапуск, запись переживает.
export function resetIntentPhase({
  recorded,
  retryPending,
  escalated,
}: {
  recorded: boolean;
  retryPending: boolean;
  escalated: boolean;
}): ResetIntentPhase {
  if (!recorded) return retryPending ? "blocked" : "none";
  if (!retryPending) return "recorded";
  return escalated ? "escalated" : "waiting";
}

// Очередь чата закрыта для доставки, пока намерение записано (ExactCut модели).
export const resetIntentFences = (phase: ResetIntentPhase) =>
  phase === "recorded" || phase === "waiting" || phase === "escalated";

// Отсрочка повтора идёт: /new не начинает новый сброс.
export const resetIntentRetryPending = (phase: ResetIntentPhase) =>
  phase === "blocked" || phase === "waiting" || phase === "escalated";

interface TelegramResetIntentOptions {
  now?: () => number;
  nonce?: () => string;
  discardThroughUpdateId?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

function intentPath(directory: string, chatKey: string) {
  return join(
    directory,
    `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`,
  );
}

function normalizeIntent(value: unknown, source: string): TelegramResetIntent {
  if (
    !isRecord(value) ||
    value.version !== TELEGRAM_RESET_INTENT_VERSION ||
    typeof value.chatKey !== "string" ||
    !value.chatKey ||
    !isSafeInteger(value.requestedAt) ||
    value.requestedAt < 0 ||
    (value.discardThroughUpdateId !== undefined &&
      (!isSafeInteger(value.discardThroughUpdateId) ||
        value.discardThroughUpdateId < 0))
  ) {
    throw new Error(`invalid Telegram reset intent in ${source}`);
  }
  return {
    version: TELEGRAM_RESET_INTENT_VERSION,
    chatKey: value.chatKey,
    requestedAt: value.requestedAt,
    ...(value.discardThroughUpdateId === undefined
      ? {}
      : { discardThroughUpdateId: value.discardThroughUpdateId }),
  };
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureIntentDirectory(directory: string) {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  await mkdir(directory, { recursive: true });
  await syncDirectory(parent);
}

export async function persistTelegramResetIntent(
  directory: string,
  chatKey: string,
  {
    now = Date.now,
    nonce = () => randomBytes(8).toString("hex"),
    discardThroughUpdateId,
  }: TelegramResetIntentOptions = {},
) {
  const intent = normalizeIntent(
    {
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey,
      requestedAt: now(),
      ...(discardThroughUpdateId === undefined
        ? {}
        : { discardThroughUpdateId }),
    },
    "new reset request",
  );
  await ensureIntentDirectory(directory);
  const target = intentPath(directory, chatKey);
  const tmp = `${target}.tmp-${process.pid}-${nonce()}`;
  try {
    await writeFile(tmp, JSON.stringify(intent), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const staged = await open(tmp, "r+");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(tmp, target);
    await syncDirectory(directory);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return intent;
}

export async function loadTelegramResetIntents(
  directory: string,
): Promise<TelegramResetIntent[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const intents: TelegramResetIntent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const raw = await readFile(path, "utf8");
    try {
      const intent = normalizeIntent(JSON.parse(raw), path);
      if (intentPath(directory, intent.chatKey) !== path) {
        throw new Error(
          `Telegram reset intent filename does not match its chat key: ${path}`,
        );
      }
      intents.push(intent);
    } catch (error) {
      console.error(
        `cannot load Telegram reset intent ${path}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return intents.sort(
    (left, right) =>
      left.requestedAt - right.requestedAt ||
      left.chatKey.localeCompare(right.chatKey),
  );
}

export async function clearTelegramResetIntent(
  directory: string,
  chatKey: string,
) {
  try {
    await rm(intentPath(directory, chatKey));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await syncDirectory(directory);
}
