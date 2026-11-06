// Один rich-пост в ДРУГОЙ allowlist-чат, отправленный из CLI. Раньше это делал
// python-скрипт скилла rich-post: он звал Bot API напрямую и потому шёл мимо
// outbound-гейта, а ADR-0005 требует гейт на каждом выходе к Bot API. Теперь пост
// уходит тем же швом, что и ночной отчёт (scripts/lib/telegram-send.ts → Outbox).
//
// Правила, которые команда держит вместо модели:
//   • получателя выбирает владелец, а не модель: по умолчанию TELEGRAM_DIGEST_CHAT_ID,
//     явный --chat принимается только из allowlist;
//   • токен берётся из .env и никогда из argv (argv виден в ps), флага --token нет;
//   • локальная картинка уезжает на публичный tmpfiles.org только по явному
//     --allow-upload и только если это настоящий медиафайл из разрешённых корней —
//     иначе постом можно было бы вынести наружу .env, ключи или заметки vault.
import {
  closeSync,
  existsSync,
  openAsBlob,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { resolveDataDir } from "../lib/data-dir.ts";
import { readEnvFresh } from "../lib/env-file.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

// Как в notify: отправитель тянет авторское дерево (agent/lib/outbox.ts), поэтому
// здесь он только тип, а грузится внутри самой отправки — `iva doctor` и `iva update`
// обязаны стартовать на установке без `agent/` (scripts/authored-tree-guard.test.ts).
type SendTelegramRich =
  typeof import("../lib/telegram-send.ts").sendTelegramRich;

export type PostDependencies = {
  readonly readEnv?: typeof readEnvFresh;
  readonly send?: SendTelegramRich;
  readonly upload?: (path: string) => Promise<string>;
  readonly readStdin?: () => Promise<string>;
  readonly print?: (text: string) => void;
};

const USAGE =
  "usage: iva post (--md <markdown> | --md-file <path|->) [--chat <id>] [--dry-run] [--allow-upload] [--silent] [--thread-id <id>]";

// Лимиты rich-сообщения Bot API 10.1: 32768 символов и 50 медиа на сообщение.
const MAX_CHARS = 32768;
const MEDIA_LIMIT = 50;

// Локальная картинка в markdown: ![](file:/abs/path "caption").
const LOCAL_IMAGE =
  /!\[[^\]]*\]\(\s*(file:\/\/\S+|file:\/\S+)(\s+"[^"]*")?\s*\)/g;
// Любая markdown-картинка (и file:, и https:) — для общего лимита в 50 медиа.
const ANY_IMAGE = /!\[[^\]]*\]\(/g;

// Наружу уходит только настоящее медиа: .env, OAuth-json, логи и заметки vault
// не грузятся даже с --allow-upload.
const MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".mp3",
  ".ogg",
  ".m4a",
]);

type PostArguments = {
  readonly md?: string;
  readonly mdFile?: string;
  readonly chat?: string;
  readonly threadId?: string;
  readonly silent: boolean;
  readonly allowUpload: boolean;
  readonly dryRun: boolean;
};

/** Разобрать argv команды. Неизвестный флаг — отказ: `--token` сюда не пролезет. */
export function parsePostArguments(args: readonly string[]): PostArguments {
  let md: string | undefined;
  let mdFile: string | undefined;
  let chat: string | undefined;
  let threadId: string | undefined;
  let silent = false;
  let allowUpload = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = (): string => {
      const next = args[++index];
      if (next === undefined)
        throw new Error(`${flag} needs a value — ${USAGE}`);
      return next;
    };
    switch (flag) {
      case "--md":
        md = value();
        break;
      case "--md-file":
        mdFile = value();
        break;
      case "--chat":
        chat = value();
        break;
      case "--thread-id":
        threadId = value();
        break;
      case "--silent":
        silent = true;
        break;
      case "--allow-upload":
        allowUpload = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag} — ${USAGE}`);
    }
  }

  if ((md === undefined) === (mdFile === undefined))
    throw new Error(`Give exactly one of --md or --md-file — ${USAGE}`);

  return {
    ...(md === undefined ? {} : { md }),
    ...(mdFile === undefined ? {} : { mdFile }),
    ...(chat === undefined ? {} : { chat }),
    ...(threadId === undefined ? {} : { threadId }),
    silent,
    allowUpload,
    dryRun,
  };
}

/** Кому вообще можно писать: allowlist владельца плюс чат дайджеста. */
export function allowedChats(env: NodeJS.ProcessEnv): Set<string> {
  const allowed = new Set(
    String(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  if (digest) allowed.add(digest);
  return allowed;
}

function resolveChat(chat: string | undefined, env: NodeJS.ProcessEnv): string {
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  if (chat === undefined) {
    if (!digest)
      throw new Error(
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID in .env or pass an allowlisted --chat",
      );
    return digest;
  }
  const requested = chat.trim();
  if (!allowedChats(env).has(requested))
    throw new Error(
      `Refusing to send: chat ${chat} is not in the allowlist (TELEGRAM_ALLOWED_USER_IDS + TELEGRAM_DIGEST_CHAT_ID)`,
    );
  return requested;
}

// Реальный путь без падения на несуществующем: ровно так же поступает канонический
// резолвер каталога данных, и корни должны сравниваться с ним в одной системе координат.
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Корни, из которых `iva post` вообще может взять локальную картинку: сама установка
 * и её каталог данных. Каталог резолвится каноническим резолвером (packages/data-dir),
 * иначе относительный ASSISTANT_DATA_DIR после переезда на версии указывал бы в другое
 * место, чем у остальных процессов — и картинка из data стала бы «вне корней».
 */
export function imageRoots(
  root: string,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  return [
    physical(resolve(root)),
    physical(resolveDataDir(root, env.ASSISTANT_DATA_DIR)),
  ];
}

/** Абсолютный путь из ссылки `file:/…` или `file:///…`. */
function localImagePath(reference: string): string {
  return resolve(
    reference.startsWith("file://")
      ? reference.slice("file://".length)
      : reference.slice("file:".length),
  );
}

/** Все локальные картинки поста, в порядке появления. */
export function localImageReferences(markdown: string): string[] {
  return [...markdown.matchAll(LOCAL_IMAGE)].map((match) =>
    localImagePath(match[1]),
  );
}

/** Сколько всего медиа в посте — вместе с уже публичными URL. */
export function countMedia(markdown: string): number {
  return [...markdown.matchAll(ANY_IMAGE)].length;
}

// Расширение подделать тривиально (`cp .env cover.png`), заголовок настоящего
// медиафайла — нет. Проверяем стандартные сигнатуры по первым 16 байтам.
function looksLikeMedia(path: string): boolean {
  const buffer = Buffer.alloc(16);
  let read: number;
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    read = readSync(handle, buffer, 0, buffer.length, 0);
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  const head = buffer.subarray(0, read);
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return true; // jpeg
  if (head.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary")))
    return true; // png
  const text = head.toString("binary");
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return true; // gif
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return true; // webp
  if (text.slice(4, 8) === "ftyp") return true; // mp4 / mov / m4a
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return true; // webm/mkv (EBML)
  if (text.startsWith("OggS")) return true; // ogg
  if (text.startsWith("ID3")) return true; // mp3 с тегом
  return read >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0; // mp3 frame
}

type LocalImage = {
  /** Путь так, как он написан в посте. */
  readonly reference: string;
  /** Путь после разрешения симлинков — грузится ровно он, и ничто другое. */
  readonly real: string;
};

/**
 * Проверить каждую ссылку `file:`. Проходит только существующий обычный файл с
 * медийным расширением И медийным заголовком, лежащий внутри разрешённых корней и без
 * скрытого сегмента (`.env`, `.config`, `.eve`) в пути. Всё остальное — отказ: иначе
 * постом можно вынести секрет через публичный хост. Возвращает разрешённые реальные
 * пути — загрузка обязана взять именно то, что проверено (подмена симлинка не поможет).
 */
function validateLocalImages(
  markdown: string,
  roots: readonly string[],
): LocalImage[] {
  const images: LocalImage[] = [];
  for (const reference of localImageReferences(markdown)) {
    if (!existsSync(reference))
      throw new Error(`local image not found: ${reference}`);
    const real = physical(reference);
    if (!statSync(real).isFile())
      throw new Error(`not a regular file: ${reference}`);
    if (!roots.some((root) => real === root || real.startsWith(root + sep)))
      throw new Error(
        `refusing local image outside the allowed roots (${roots.join(", ")}): ${reference}`,
      );
    if (!MEDIA_EXTENSIONS.has(extname(real).toLowerCase()))
      throw new Error(
        `refusing non-media file (extension not in ${[...MEDIA_EXTENSIONS].sort().join(", ")}): ${reference} — only images/video/audio may be uploaded`,
      );
    if (real.split(sep).some((segment) => segment.startsWith(".")))
      throw new Error(
        `refusing dot-path (hidden/config file or directory): ${reference}`,
      );
    if (!looksLikeMedia(real))
      throw new Error(
        `refusing file that does not look like media (magic bytes): ${reference}`,
      );
    images.push({ reference, real });
  }
  const media = countMedia(markdown);
  if (media > MEDIA_LIMIT)
    throw new Error(
      `too many media attachments: ${media} > ${MEDIA_LIMIT} (Telegram rich-message limit)`,
    );
  return images;
}

/** Подставить публичные URL вместо проверенных ссылок `file:`. */
function substituteImages(
  markdown: string,
  uploaded: ReadonlyMap<string, string>,
): string {
  return markdown.replace(LOCAL_IMAGE, (match, reference: string, caption) => {
    const url = uploaded.get(localImagePath(reference));
    if (url === undefined)
      throw new Error(
        `internal error: unvalidated image reference ${reference}`,
      );
    return `![](${url}${typeof caption === "string" ? caption : ""})`;
  });
}

// tmpfiles.org — ПУБЛИЧНЫЙ анонимный хост: файл видит любой, у кого есть ссылка.
// Достижимо только из-за флага --allow-upload и только для проверенного медиафайла.
async function uploadToTmpfiles(path: string): Promise<string> {
  const form = new FormData();
  form.append("file", await openAsBlob(path), basename(path));
  const response = await fetch("https://tmpfiles.org/api/v1/upload", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let url: unknown;
  try {
    url = (JSON.parse(raw) as { data?: { url?: unknown } }).data?.url;
  } catch {
    url = undefined;
  }
  if (typeof url !== "string" || !url)
    throw new Error(`image upload failed for ${path}: ${raw.slice(0, 200)}`);
  // viewer URL → прямая ссылка на файл, иначе Telegram скачает html-страницу.
  return url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Длина считается по кодовым точкам: лимит Bot API — символы, а не UTF-16-единицы,
// иначе пост из эмодзи «кончался» бы вдвое раньше.
const charCount = (text: string): number => [...text].length;

/** Create the post command without reading .env or touching the network at import time. */
export function createPostCommand(
  runtime: CliRuntime,
  dependencies: PostDependencies = {},
) {
  const { ENV_PATH, ROOT, ok, warn } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;
  const print =
    dependencies.print ??
    ((text: string): void => {
      console.log(text);
    });

  return async function cmdPost(args: readonly string[] = []): Promise<void> {
    const options = parsePostArguments(args);
    let markdown: string;
    if (options.md !== undefined) markdown = options.md;
    else if (options.mdFile === "-")
      markdown = await (dependencies.readStdin ?? readAllStdin)();
    else markdown = await readFile(options.mdFile as string, "utf8");

    const env = await readEnv(ENV_PATH);
    const images = validateLocalImages(markdown, imageRoots(ROOT, env));
    if (charCount(markdown) > MAX_CHARS)
      throw new Error(
        `rich message too long: ${charCount(markdown)} > ${MAX_CHARS} chars`,
      );

    if (options.dryRun) {
      // Полностью офлайн: ни одной загрузки, ни одного вызова Bot API — только проверка.
      for (const image of images)
        warn(`would upload (with --allow-upload): ${image.reference}`);
      print(markdown);
      return;
    }

    // Получателя и токен проверяем ДО любой загрузки: локальное медиа не должно
    // оказаться на публичном хосте только затем, чтобы отправка упала на конфиге.
    const chat = resolveChat(options.chat, env);
    const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token)
      throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");

    if (images.length > 0 && !options.allowUpload)
      throw new Error(
        "markdown references local images, and Telegram needs a public URL for them. " +
          "Re-run with --allow-upload to publish them on tmpfiles.org (a PUBLIC anonymous " +
          "host — anyone with the link can view them), or switch to already-public URLs.",
      );

    if (images.length > 0) {
      const upload = dependencies.upload ?? uploadToTmpfiles;
      const uploaded = new Map<string, string>();
      for (const image of images) {
        const url = await upload(image.real);
        warn(`uploaded ${image.real} -> ${url}`);
        uploaded.set(image.reference, url);
      }
      markdown = substituteImages(markdown, uploaded);
      if (charCount(markdown) > MAX_CHARS)
        throw new Error(
          `rich message too long after image URL substitution: ${charCount(markdown)} > ${MAX_CHARS} chars`,
        );
    }

    const send =
      dependencies.send ??
      (await import("../lib/telegram-send.ts")).sendTelegramRich;
    // Отказ Bot API — ошибка команды: rich-фолбэка нет, и «часть поста ушла» тоже.
    const result = await send(token, chat, markdown, {
      silent: options.silent,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    });
    if (!result.ok) throw new Error(`Telegram send failed: ${result.error}`);
    ok(`Rich post sent to ${chat}`);
  };
}
