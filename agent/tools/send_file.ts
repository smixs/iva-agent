import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import {
  isSecretValue,
  secretEntriesFromEnv,
} from "../../packages/secret-redaction/index.ts";
import {
  allTelegramBotTokens,
  liveTelegramEnv,
  resolveTelegramBot,
  validTelegramBotId,
} from "../../packages/telegram-bots/index.ts";
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

// Предел Bot API на sendPhoto: картинка крупнее уходит документом.
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_EXT = /\.(?:jpe?g|png|webp)$/i;

export type SendFileInput = {
  readonly path: string;
  readonly caption?: string;
  readonly as?: "document";
};

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
  const liveEnv = liveTelegramEnv(process.env);
  const entries = [
    ...secretEntriesFromEnv(liveEnv, secretKeyInventory),
    ...allTelegramBotTokens(liveEnv)
      .filter(isSecretValue)
      .map((value) => ({ name: "TELEGRAM_COLLEAGUE_BOT_TOKENS", value })),
  ];
  const needles = entries.flatMap(({ name, value }) =>
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

type TelegramField = "photo" | "document";

type TelegramReply = {
  readonly ok: boolean;
  readonly rejected: boolean;
  readonly status: number;
  readonly body: unknown;
};

type Delivery = {
  readonly token: string;
  readonly chat: ReminderChat;
  readonly caption: string | undefined;
  readonly file: Readable;
  readonly signal: AbortSignal | undefined;
  readonly asDocument: boolean;
};

// Картинка уходит фото, чтобы Telegram показал её в ленте, остальное - документом.
// Документ отправляется после sendPhoto только при явном ok:false от Telegram.
// При сбое сети, обрыве чтения или неизвестном ответе фото могло дойти.
async function deliver(delivery: Delivery): Promise<SendFileAnswer> {
  const { token, file, asDocument } = delivery;

  try {
    if (!asDocument && fitsSendPhoto(file)) {
      const photo = await postToTelegram(delivery, "photo");
      if (photo.ok) return sent(file, photo.body);
      if (!photo.rejected)
        return fail(
          `Telegram: не удалось подтвердить отправку фото (HTTP ${photo.status})`,
        );
    }

    const document = await postToTelegram(delivery, "document");
    if (document.ok) return sent(file, document.body);

    return fail(telegramError(document.body, document.status));
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return fail(`отправка не удалась: ${text.replaceAll(token, "***")}`);
  }
}

function fitsSendPhoto(file: Readable): boolean {
  return PHOTO_EXT.test(file.name) && file.data.byteLength <= PHOTO_MAX_BYTES;
}

async function postToTelegram(
  delivery: Delivery,
  field: TelegramField,
): Promise<TelegramReply> {
  const { token, chat, caption, file, signal } = delivery;

  const form = new FormData();
  form.append("chat_id", chat.id);
  if (chat.threadId) form.append("message_thread_id", chat.threadId);

  // Подпись - текст модели наружу: тот же гейт, что у Outbox.
  if (caption) form.append("caption", redactNotice(caption));

  form.append(field, new File([file.data], file.name));

  const apiMethod = field === "photo" ? "sendPhoto" : "sendDocument";
  const url = `https://api.telegram.org/bot${token}/${apiMethod}`;
  const response = await fetch(url, { method: "POST", body: form, signal });
  const json: Promise<unknown> = response.json();
  const body = await (field === "photo" ? json : json.catch(() => null));
  const ok = (body as { ok?: unknown } | null)?.ok;

  return {
    ok: response.ok && ok === true,
    rejected: ok === false,
    status: response.status,
    body,
  };
}

function sent(file: Readable, body: unknown): SendFileSent {
  return {
    ok: true,
    name: file.name,
    bytes: file.data.byteLength,
    message_id: messageId(body),
  };
}

// Чат хода с его темой; фоновый ход без чата - чат уведомлений владельца.
function targetChat(chat: ReminderChat | null): ReminderChat | null {
  if (chat !== null) return chat;
  const id = notificationChat(process.env);
  return id ? { id, threadId: null } : null;
}

function botIdOfTurn(ctx: {
  readonly session?: {
    readonly auth?: {
      readonly current?: { readonly attributes?: unknown } | null;
    };
  };
}): string | null {
  const attributes = ctx.session?.auth?.current?.attributes;
  if (attributes === null || typeof attributes !== "object") return null;
  const raw = (attributes as Record<string, unknown>).bot_id;
  return validTelegramBotId(raw) ? raw : null;
}

export async function sendFile(
  input: SendFileInput,
  chat: ReminderChat | null,
  {
    maxBytes = MAX_BYTES,
    signal,
    botId,
  }: {
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
    readonly botId?: string | null;
  } = {},
): Promise<SendFileAnswer> {
  const { path, caption, as } = input;

  const target = targetChat(chat);
  if (target === null)
    return fail(
      "нет чата: ход не из Telegram, а TELEGRAM_DIGEST_CHAT_ID и TELEGRAM_ALLOWED_USER_IDS пусты",
    );
  const liveEnv = liveTelegramEnv(process.env);
  const bot =
    botId !== undefined && botId !== null
      ? resolveTelegramBot(botId, liveEnv)
      : resolveTelegramBot(null, liveEnv);
  const token =
    bot?.token ?? (botId ? "" : (process.env.TELEGRAM_BOT_TOKEN ?? ""));
  if (!token)
    return fail(
      botId ? `не найден токен бота ${botId}` : "не задан TELEGRAM_BOT_TOKEN",
    );
  const file = await readAllowed(path, maxBytes);
  if ("ok" in file) return file;
  const name = await secretInFile(file.data, signal);
  if (name !== null)
    return fail(
      `файл содержит секрет ${name}: удали значение из копии и вызови send_file ещё раз`,
    );

  const asDocument = as === "document";
  return deliver({ token, chat: target, caption, file, signal, asDocument });
}

const PHOTO_MAX_MB = PHOTO_MAX_BYTES / 1024 / 1024;

export default defineTool({
  description:
    "Отправить файл в чат, где идёт разговор. path - файл из Vault " +
    "(от корня vault, vault/… или абсолютный) или из временного каталога; caption - подпись. " +
    `Картинка JPG/PNG/WebP до ${PHOTO_MAX_MB} МБ уходит фото, остальные файлы и as: "document" - документом. ` +
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
    as: z
      .literal("document")
      .optional()
      .describe("document - картинку оригиналом без сжатия"),
  }),
  async execute(input, ctx): Promise<SendFileAnswer> {
    try {
      return await sendFile(input, chatOfTurn(ctx), {
        signal: ctx.abortSignal,
        botId: botIdOfTurn(ctx),
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
