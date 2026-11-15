import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import { secretEntriesFromEnv } from "../../packages/secret-redaction/index.ts";
import secretKeyInventory from "../skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import { redactNotice } from "../lib/outbox.ts";
import type { ReminderChat } from "../lib/reminder-store.ts";
import { chatOfTurn } from "../lib/reminder-tool.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import {
  resolveVaultToolPath,
  resolveVaultToolRoot,
} from "../lib/vault-file-search.ts";

// Штатная отправка файла в чат хода. Гвард bash режет curl в api.telegram.org, поэтому
// файл уходит только отсюда и только из Vault или временного каталога ОС: .env, data/ и
// ключи не уезжают даже по симлинку — судим реальный путь.

// Предел Bot API на sendDocument.
export const MAX_BYTES = 50 * 1024 * 1024;

export type SendFileSent = {
  readonly ok: true;
  readonly name: string;
  readonly bytes: number;
  readonly message_id: number | null;
};
export type SendFileFailure = { readonly ok: false; readonly error: string };
export type SendFileAnswer = SendFileSent | SendFileFailure;
type Readable = { readonly name: string; readonly data: Buffer<ArrayBuffer> };

const fail = (error: string): SendFileFailure => ({ ok: false, error });

const OUTSIDE =
  "отправлять можно только файлы из Vault и временного каталога: положи файл в " +
  "vault/attachments/<дата>/ и вызови send_file ещё раз";

// Во временном каталоге лежат копии .env установщика и мастера и system.md Claude CLI:
// такие имена не уходят, где бы ни лежали.
const SECRET_PART = /^(?:\.env|iva-env|iva-config-|iva-claude-)/;

function carriesSecret(file: string): boolean {
  return file
    .split(sep)
    .some((part) => part !== ".env.example" && SECRET_PART.test(part));
}

// Exact installation values in either byte encoding, regardless of the file's encoding or suffix.
// Overlap retains a value crossing a chunk boundary; each chunk yields to cancellation and the loop.
async function secretInFile(
  data: Buffer,
  signal?: AbortSignal,
): Promise<string | null> {
  const needles = secretEntriesFromEnv(process.env, secretKeyInventory).flatMap(
    ({ name, value }) =>
      ["utf8", "utf16le"].map((encoding) => ({
        name,
        bytes: Buffer.from(value, encoding as BufferEncoding),
      })),
  );
  const overlap = Math.max(0, ...needles.map(({ bytes }) => bytes.length - 1));
  const chunkBytes = 64 * 1024;
  for (let start = 0; start < data.length; start += chunkBytes) {
    if (signal?.aborted) throw new Error("отправка отменена");
    const chunk = data.subarray(
      Math.max(0, start - overlap),
      start + chunkBytes,
    );
    for (const { name, bytes } of needles)
      if (chunk.includes(bytes)) return name;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return null;
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Корни и как заданы, и после симлинков: несуществующий путь судим по записи, чтобы
// отказ «не найден» не выдавал, есть ли файл снаружи.
async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of [resolveVaultToolRoot(), tmpdir()]) {
    // Нет каталога — нет и файлов в нём: остаётся корень как задан.
    const real = await realpath(dir).catch(() => null);
    roots.push(dir, ...(real === null ? [] : [real]));
  }
  return roots;
}

// Что не уходит даже из разрешённого каталога: не файл, жёсткая ссылка, сверх предела.
function refuseFile(
  info: Stats,
  path: string,
  maxBytes: number,
): SendFileFailure | null {
  if (info.isDirectory())
    return fail(`${path} - это каталог, а не файл; укажи файл`);
  if (!info.isFile()) return fail(`${path} - не обычный файл`);
  // Жёсткая ссылка - тот же файл под другим именем: .env, связанный в Vault, не уходит.
  if (info.nlink > 1)
    return fail(
      `${path} - жёсткая ссылка на другой файл; скопируй его в vault/attachments/<дата>/`,
    );
  if (info.size > maxBytes)
    return fail(
      `файл ${info.size} байт больше предела Telegram в 50 МБ; сожми или разбей его`,
    );
  return null;
}

async function readAllowed(
  path: string,
  maxBytes: number,
): Promise<Readable | SendFileFailure> {
  let resolved: string;
  try {
    resolved = resolveVaultToolPath(path);
  } catch (error) {
    const text = vaultDirErrorText(error);
    if (text !== null) return fail(text);
    throw error;
  }
  const roots = await allowedRoots();
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return fail(
      roots.some((root) => inside(root, resolved))
        ? `файл не найден: ${path}`
        : OUTSIDE,
    );
  }
  // Реальный путь без симлинков лежит под корнем, только если корень сам без них:
  // симлинк из Vault наружу не проходит.
  if (!roots.some((root) => inside(root, real)) || carriesSecret(real))
    return fail(OUTSIDE);
  const refusal = refuseFile(await stat(real), path, maxBytes);
  if (refusal !== null) return refusal;
  return { name: basename(real), data: await readFile(real) };
}

function telegramError(body: unknown, status: number): string {
  const description =
    typeof body === "object" && body !== null && "description" in body
      ? String(body.description)
      : `HTTP ${status}`;
  return `Telegram: ${description}`;
}

function messageId(body: unknown): number | null {
  const result = (body as { result?: { message_id?: unknown } } | null)?.result;
  return typeof result?.message_id === "number" ? result.message_id : null;
}

function documentForm(
  chatId: string,
  threadId: string | null,
  caption: string | undefined,
  file: Readable,
): FormData {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (threadId) form.append("message_thread_id", threadId);
  // Подпись - текст модели наружу: тот же гейт, что у Outbox.
  if (caption) form.append("caption", redactNotice(caption));
  form.append("document", new File([file.data], file.name));
  return form;
}

async function postDocument(
  token: string,
  form: FormData,
  file: Readable,
  signal: AbortSignal | undefined,
): Promise<SendFileAnswer> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendDocument`,
      { method: "POST", body: form, signal },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || (body as { ok?: unknown } | null)?.ok !== true)
      return fail(telegramError(body, response.status));
    return {
      ok: true,
      name: file.name,
      bytes: file.data.byteLength,
      message_id: messageId(body),
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return fail(`отправка не удалась: ${text.replaceAll(token, "***")}`);
  }
}

// Чат хода с его темой; фоновый ход без чата - чат уведомлений владельца.
function targetChat(chat: ReminderChat | null): ReminderChat | null {
  if (chat !== null) return chat;
  const id = notificationChat(process.env);
  return id ? { id, threadId: null } : null;
}

export async function sendFile(
  { path, caption }: { readonly path: string; readonly caption?: string },
  chat: ReminderChat | null,
  {
    maxBytes = MAX_BYTES,
    signal,
  }: { readonly maxBytes?: number; readonly signal?: AbortSignal } = {},
): Promise<SendFileAnswer> {
  const target = targetChat(chat);
  if (target === null)
    return fail(
      "нет чата: ход не из Telegram, а TELEGRAM_DIGEST_CHAT_ID и TELEGRAM_ALLOWED_USER_IDS пусты",
    );
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) return fail("не задан TELEGRAM_BOT_TOKEN");
  const file = await readAllowed(path, maxBytes);
  if ("ok" in file) return file;
  const name = await secretInFile(file.data, signal);
  if (name !== null)
    return fail(
      `файл содержит секрет ${name}: удали значение из копии и вызови send_file ещё раз`,
    );
  const form = documentForm(target.id, target.threadId, caption, file);
  return postDocument(token, form, file, signal);
}

export default defineTool({
  description:
    "Отправить файл документом в чат, где идёт разговор. path - файл из Vault " +
    "(от корня vault, vault/… или абсолютный) или из временного каталога; caption - подпись. " +
    "Возвращает { ok, name, bytes, message_id } или { ok: false, error }.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Файл: от корня vault, vault/… или абсолютный"),
    caption: z
      .string()
      .max(1024)
      .optional()
      .describe("Подпись к файлу, до 1024 знаков"),
  }),
  async execute(input, ctx): Promise<SendFileAnswer> {
    try {
      return await sendFile(input, chatOfTurn(ctx), {
        signal: ctx.abortSignal,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
