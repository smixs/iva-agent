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

export const TELEGRAM_RESET_INTENT_VERSION = 1;

export interface TelegramResetIntent {
  version: typeof TELEGRAM_RESET_INTENT_VERSION;
  chatKey: string;
  requestedAt: number;
  discardThroughUpdateId?: number;
}

interface TelegramResetIntentOptions {
  now?: () => number;
  nonce?: () => string;
  discardThroughUpdateId?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
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
