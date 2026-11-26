/* eslint-disable @typescript-eslint/no-base-to-string -- Telegram payload fields retain source-compatible permissive coercion. */
import { execFile } from "node:child_process";
import { screenPayload } from "../lib/telegram-buttons.ts";
import { redactTelegramBody } from "../lib/notice.ts";
import { API, TOKEN, log } from "./config.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { runLaunchd } from "../lib/launchd.ts";

type TelegramResponse = {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
};
type Reader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
};
type StreamBody = { getReader: () => Reader };
type ErrorLike = { message?: unknown };

const errorMessage = (error: unknown) => (error as ErrorLike).message;

// Every Bot API call carries a deadline — a hung response must never stall the single polling loop.
// The default suits normal calls; getUpdates overrides it to sit above its own long-poll window.
//
// This is the bridge's only way of speaking to Telegram — every menu screen, wizard, status
// edit and reply passes through it — so the outbound Gate stands here and not in the views
// above it. A screen carrying runtime data (a spawned command's output, an error text) is
// therefore gated by construction, including one written tomorrow. The rule, and the static
// strings exempt from it, live in agent/lib/outbox.ts.
async function tg(
  method: string,
  body: unknown,
  { timeoutMs = 30_000, token }: { timeoutMs?: number; token?: string } = {},
): Promise<unknown> {
  const base = token ? `https://api.telegram.org/bot${token}` : API;
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(await redactTelegramBody(body ?? {})),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

// Read a web ReadableStream as UTF-8 text with a HARD cap: it stops and cancels the stream the moment
// the running total exceeds maxBytes, so an oversized (or size-unknown) body is never fully buffered.
// The caller passes an already time-bounded body (see downloadTelegramFile) so a hung socket mid-read
// aborts the read too. Returns null on over-size or a read error. Pure — unit-tested off the network.
export async function readCappedStream(body: unknown, maxBytes: number) {
  if (!body || typeof (body as StreamBody).getReader !== "function")
    return null;
  const reader = (body as StreamBody).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) return null;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Download a Telegram file's bytes as UTF-8 text (getFile → file download), hard-capped at maxBytes and
// deadline-bounded at every step (getFile call, the download connection, and the streamed read — a size
// cap alone doesn't save the loop from a stalled socket). Returns null on any failure or over-size.
async function downloadTelegramFile(
  fileId: string,
  maxBytes: number,
  { token }: { token?: string } = {},
) {
  try {
    const info = await tg(
      "getFile",
      { file_id: fileId },
      { timeoutMs: 10_000, token },
    );
    const filePath = (info as TelegramResponse | null)?.result as
      { file_path?: unknown } | undefined;
    const path = filePath?.file_path;
    if (!path) return null;
    const effectiveToken = token ?? TOKEN;
    const res = await fetch(
      `https://api.telegram.org/file/bot${effectiveToken}/${String(path)}`,
      {
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return null;
    // Cheap early reject when the server declares an over-size body; the stream reader below is the
    // hard cap regardless (a missing or lying Content-Length can't get past it).
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    return await readCappedStream(res.body, maxBytes);
  } catch {
    return null;
  }
}
async function reply(
  chatId: number | string,
  text: string,
  { silent = false, token }: { silent?: boolean; token?: string } = {},
) {
  try {
    const data = (await tg(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...(silent ? { disable_notification: true } : {}),
      },
      { token },
    )) as TelegramResponse;
    if (!data.ok)
      throw new Error(String(data.description || "sendMessage failed"));
    return data.result;
  } catch (error) {
    log("reply failed:", errorMessage(error));
    return null;
  }
}

// Правка rich-экрана моста: кнопки теперь живут в самом markdown, поэтому клавиатуры
// (четвёртого параметра) у этой функции нет вовсе. reply() рядом остаётся обычным
// sendMessage: голый текст без кнопок не обязан быть rich-сообщением.
async function edit(
  chatId: number | string,
  messageId: number,
  markdown: string,
  { token }: { token?: string } = {},
) {
  try {
    const data = (await tg(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        ...screenPayload(markdown),
      },
      { token },
    )) as TelegramResponse;
    if (!data.ok)
      throw new Error(String(data.description || "editMessageText failed"));
    return data.result;
  } catch (error) {
    if (!/message is not modified/i.test(String(errorMessage(error))))
      log("edit failed:", errorMessage(error));
    return null;
  }
}

const sc = (...args: string[]) =>
  new Promise<boolean>((resolve) =>
    serviceManager() === "launchd"
      ? resolve(runLaunchd(args).code === 0)
      : execFile("systemctl", ["--user", ...args], (err) => resolve(!err)),
  );

export { tg, downloadTelegramFile, reply, edit, sc };
