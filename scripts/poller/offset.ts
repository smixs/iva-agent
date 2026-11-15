/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion -- persisted Telegram payloads and injected I/O retain the original permissive runtime boundary. */
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { parseOffsetFile, serializeOffsetFile } from "../lib/offset-store.ts";
import { OFFSET_FILE, log } from "./config.ts";
import { tg } from "./transport.ts";

type ErrorLike = { code?: unknown; message?: unknown };
type TelegramUpdate = {
  stopped_message_generation?: {
    chat: { id: string | number };
    message_thread_id?: number;
  };
  message?: { chat?: { id?: unknown }; message_thread_id?: unknown };
  callback_query?: {
    message?: { chat?: { id?: unknown }; message_thread_id?: unknown };
  };
};
type TelegramResponse = {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
};
type ReadFileImpl = (
  file: string,
  encoding: BufferEncoding,
) => Promise<unknown>;
type TelegramImpl = (
  method: string,
  body: Record<string, unknown>,
) => Promise<unknown>;

const errorMessage = (error: unknown) => (error as ErrorLike).message;

// offset: null ⇒ no file (first run) — distinguish from a genuine offset 0.
async function loadOffset({
  file = OFFSET_FILE,
  readFileImpl = readFile,
}: { file?: string; readFileImpl?: ReadFileImpl } = {}) {
  try {
    return parseOffsetFile((await readFileImpl(file, "utf8")) as string);
  } catch (error) {
    if ((error as ErrorLike | null | undefined)?.code === "ENOENT")
      return { offset: null };
    throw new Error(
      `failed to load Telegram offset ${file}: ${String(errorMessage(error))}`,
      { cause: error },
    );
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset({
  tgImpl = tg as TelegramImpl,
  logImpl = log,
}: {
  tgImpl?: TelegramImpl;
  logImpl?: (...parts: unknown[]) => void;
} = {}) {
  try {
    const data = await tgImpl("getUpdates", { offset: -1, timeout: 0 });
    const result = data as TelegramResponse | null;
    if (result?.ok !== true || !Array.isArray(result.result)) {
      throw new Error(
        String(result?.description || "invalid getUpdates response"),
      );
    }
    const list = result.result;
    // Текущий first-run контракт: пустой backlog получает числовой курсор 0,
    // который можно сразу сохранить и передать следующему getUpdates.
    if (list.length === 0) return 0;
    const updateId = (
      list[list.length - 1] as { update_id?: unknown } | undefined
    )?.update_id;
    if (!Number.isSafeInteger(updateId)) {
      throw new Error("invalid update_id in getUpdates response");
    }
    const safeUpdateId = updateId as number;
    if (safeUpdateId < 0 || safeUpdateId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("invalid update_id in getUpdates response");
    }
    return safeUpdateId + 1;
  } catch (error) {
    logImpl("fast-forward offset failed:", errorMessage(error));
    throw new Error(
      `failed to fast-forward Telegram offset: ${String(errorMessage(error))}`,
      {
        cause: error,
      },
    );
  }
}

// Ключ сериализации — чат/тема Telegram; активную сессию eve маршрутизирует по sessionId.
// one chat (+ forum topic) — one session, deliver into it one at a time with a pause.
function chatKey(update: TelegramUpdate) {
  const msg =
    update.message ??
    update.callback_query?.message ??
    update.stopped_message_generation;
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return null;
  const threadId = msg?.message_thread_id;
  return `${String(chatId)}:${String(threadId ?? "")}`;
}
async function saveOffset(
  offset: number,
  {
    file = OFFSET_FILE,
    writeFileImpl = writeFileAtomic,
  }: {
    file?: string;
    writeFileImpl?: typeof writeFileAtomic;
  } = {},
) {
  try {
    await writeFileImpl(file, serializeOffsetFile(offset), {
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(
      `failed to save Telegram offset ${file}: ${String(errorMessage(error))}`,
      { cause: error },
    );
  }
}

export { loadOffset, saveOffset, fastForwardOffset, chatKey };
