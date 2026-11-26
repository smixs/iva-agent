// Случайный талисман-аватарка коллеги из библиотеки ip-as-logo
// (visualskills.dev/ip-as-logo, cdn.ipaslogo.com) → JPG 640×640 → setMyProfilePhoto.
// Перенесено из пробы .scratch/bot-colleagues/avatars/pick.ts (bun) в Node.js TS.
// Решение владельца (26.11, grill круг 4): случайный талисман без связи с ролью;
// при недоступности библиотеки — бот остаётся без фото, повтор позже.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../../packages/guards/index.ts";
import { redactSecretValues } from "../../packages/secret-redaction/index.ts";

const execFileAsync = promisify(execFile);

export const IP_AS_LOGO_APP_URL = "https://visualskills.dev/ip-as-logo-app/";
export const IP_AS_LOGO_RPC_BASE =
  "https://phdpivfhxxgezcauesga.supabase.co/rest/v1/rpc";
export const COLLEAGUE_AVATAR_SIZE = 640;

const FETCH_TIMEOUT_MS = 15_000;
const CONVERT_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_APP_ORIGIN = new URL(IP_AS_LOGO_APP_URL).origin;
const SCRIPT_PATH_RE = /assets\/index-[A-Za-z0-9_-]+\.js/u;
const PUBLIC_KEY_RE = /sb_publishable_[A-Za-z0-9_-]+/u;

export interface IpAsLogoEntry {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly category: string;
  readonly image_url: string;
}

export interface PickedTalisman {
  readonly logo: IpAsLogoEntry;
  readonly sourceBytes: Buffer;
}

export interface AppliedAvatarResult {
  readonly ok: true;
  readonly logo: {
    readonly id: number;
    readonly name: string;
    readonly category: string;
    readonly source: string;
  };
  readonly jpegBytes: number;
}

export interface FailedAvatarResult {
  readonly ok: false;
  readonly error: string;
}

export type ColleagueAvatarOutcome = AppliedAvatarResult | FailedAvatarResult;

export interface ColleagueAvatarDeps {
  readonly fetchImpl?: typeof fetch;
  readonly random?: () => number;
  readonly convertToJpeg640?: (pngBytes: Buffer) => Promise<Buffer>;
  readonly apiBaseUrl?: string;
}

function parseLogoEntry(value: unknown): IpAsLogoEntry | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.image_url !== "string"
  ) {
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.image_url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "https:") return null;
  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : String(value.id),
    name: value.name.trim(),
    category: typeof value.category === "string" ? value.category.trim() : "",
    image_url: parsedUrl.toString(),
  };
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`avatar image exceeds ${maxBytes} bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("avatar image response is empty");
  if (bytes.length > maxBytes) {
    throw new Error(`avatar image exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

/** Читает публичный ключ Supabase из скрипта страницы visualskills.dev (в код и git не вшивается). */
export async function fetchIpAsLogoPublicKey(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const htmlRes = await fetchImpl(IP_AS_LOGO_APP_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!htmlRes.ok) {
    throw new Error(`ip-as-logo app HTML: HTTP ${htmlRes.status}`);
  }
  const html = await htmlRes.text();
  const scriptRel = SCRIPT_PATH_RE.exec(html)?.[0];
  if (!scriptRel) {
    throw new Error("ip-as-logo app script path not found");
  }
  const scriptUrl = new URL(scriptRel, IP_AS_LOGO_APP_URL);
  if (scriptUrl.origin !== ALLOWED_APP_ORIGIN) {
    throw new Error("ip-as-logo script URL left expected origin");
  }
  const jsRes = await fetchImpl(scriptUrl.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!jsRes.ok) {
    throw new Error(`ip-as-logo app JS: HTTP ${jsRes.status}`);
  }
  const js = await jsRes.text();
  const key = PUBLIC_KEY_RE.exec(js)?.[0];
  if (!key) {
    throw new Error("ip-as-logo publishable key not found in bundle");
  }
  return key;
}

/** Выбирает случайный талисман из библиотеки ip-as-logo без привязки к роли и скачивает его PNG. */
export async function pickRandomIpAsLogo(
  deps: Pick<ColleagueAvatarDeps, "fetchImpl" | "random"> = {},
): Promise<PickedTalisman> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const random = deps.random ?? Math.random;
  const key = await fetchIpAsLogoPublicKey(fetchImpl);
  const rpcRes = await fetchImpl(`${IP_AS_LOGO_RPC_BASE}/get_logos`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_seed: random(),
      p_offset: 0,
      p_limit: 24,
      p_search: "",
      p_category: "all",
      p_sort: "random",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!rpcRes.ok) {
    throw new Error(`ip-as-logo get_logos: HTTP ${rpcRes.status}`);
  }
  const payload: unknown = await rpcRes.json();
  if (!Array.isArray(payload)) {
    throw new Error("ip-as-logo get_logos returned non-array payload");
  }
  const logos = payload
    .map(parseLogoEntry)
    .filter((entry): entry is IpAsLogoEntry => entry !== null);
  if (logos.length === 0) {
    throw new Error("ip-as-logo returned no usable talismans");
  }
  const rawIdx = Math.floor(random() * logos.length);
  const idx = Math.max(0, Math.min(logos.length - 1, rawIdx));
  const logo = logos[idx];
  const imgRes = await fetchImpl(logo.image_url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!imgRes.ok) {
    throw new Error(`ip-as-logo image download: HTTP ${imgRes.status}`);
  }
  const sourceBytes = await readBoundedBytes(imgRes, MAX_IMAGE_BYTES);
  return { logo, sourceBytes };
}

/** Разбирает размеры JPEG из SOF-маркера (0xFFC0..0xFFC3, 0xFFC5..0xFFC7, 0xFFC9..0xFFCB, 0xFFCD..0xFFCF). */
export function jpegDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return { width, height };
    }
    offset += length;
  }
  return null;
}

type ConverterCommand = readonly [
  bin: string,
  args: (inputPath: string, outputPath: string) => readonly string[],
];

const LOCAL_CONVERTERS: readonly ConverterCommand[] = [
  [
    "magick",
    (input, output) => [
      input,
      "-resize",
      `${COLLEAGUE_AVATAR_SIZE}x${COLLEAGUE_AVATAR_SIZE}^`,
      "-gravity",
      "center",
      "-extent",
      `${COLLEAGUE_AVATAR_SIZE}x${COLLEAGUE_AVATAR_SIZE}`,
      "-background",
      "white",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-quality",
      "90",
      output,
    ],
  ],
  [
    "convert",
    (input, output) => [
      input,
      "-resize",
      `${COLLEAGUE_AVATAR_SIZE}x${COLLEAGUE_AVATAR_SIZE}^`,
      "-gravity",
      "center",
      "-extent",
      `${COLLEAGUE_AVATAR_SIZE}x${COLLEAGUE_AVATAR_SIZE}`,
      "-background",
      "white",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-quality",
      "90",
      output,
    ],
  ],
  [
    "ffmpeg",
    (input, output) => [
      "-y",
      "-loglevel",
      "error",
      "-i",
      input,
      "-vf",
      `scale=${COLLEAGUE_AVATAR_SIZE}:${COLLEAGUE_AVATAR_SIZE}:force_original_aspect_ratio=increase,crop=${COLLEAGUE_AVATAR_SIZE}:${COLLEAGUE_AVATAR_SIZE}`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      output,
    ],
  ],
  [
    "sips",
    (input, output) => [
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "90",
      "-z",
      String(COLLEAGUE_AVATAR_SIZE),
      String(COLLEAGUE_AVATAR_SIZE),
      input,
      "--out",
      output,
    ],
  ],
];

/** Конвертирует PNG-талисман в JPG 640×640 без shell (magick / convert / ffmpeg / sips). */
export async function convertPngToJpeg640(
  pngBytes: Buffer,
  deps: {
    readonly runConverter?: (
      bin: string,
      args: readonly string[],
    ) => Promise<void>;
  } = {},
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "iva-colleague-avatar-"));
  const inputPath = join(dir, "source.png");
  const outputPath = join(dir, "avatar.jpg");
  const run =
    deps.runConverter ??
    (async (bin: string, args: readonly string[]) => {
      await execFileAsync(bin, [...args], { timeout: CONVERT_TIMEOUT_MS });
    });
  try {
    await writeFile(inputPath, pngBytes, { mode: 0o600 });
    const errors: string[] = [];
    for (const [bin, buildArgs] of LOCAL_CONVERTERS) {
      try {
        await run(bin, buildArgs(inputPath, outputPath));
        const jpeg = await readFile(outputPath);
        const dims = jpegDimensions(jpeg);
        if (
          dims === null ||
          dims.width !== COLLEAGUE_AVATAR_SIZE ||
          dims.height !== COLLEAGUE_AVATAR_SIZE
        ) {
          errors.push(`${bin}: output is not 640x640 JPEG`);
          continue;
        }
        return jpeg;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${bin}: ${message}`);
      }
    }
    throw new Error(
      `no image converter produced 640x640 JPEG (${errors.join("; ")})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Загружает JPG-аватарку боту через Bot API `setMyProfilePhoto` (InputProfilePhotoStatic). */
export async function uploadBotProfilePhoto(options: {
  readonly botToken: string;
  readonly jpegBytes: Buffer;
  readonly fetchImpl?: typeof fetch;
  readonly apiBaseUrl?: string;
}): Promise<void> {
  const dims = jpegDimensions(options.jpegBytes);
  if (
    dims === null ||
    dims.width !== COLLEAGUE_AVATAR_SIZE ||
    dims.height !== COLLEAGUE_AVATAR_SIZE
  ) {
    throw new Error("profile photo must be a 640x640 JPEG");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(
    /\/+$/u,
    "",
  );
  const form = new FormData();
  form.set(
    "photo",
    JSON.stringify({ type: "static", photo: "attach://avatar" }),
  );
  form.set(
    "avatar",
    new Blob([new Uint8Array(options.jpegBytes)], { type: "image/jpeg" }),
    "avatar.jpg",
  );
  let res: Response;
  try {
    res = await fetchImpl(
      `${baseUrl}/bot${options.botToken}/setMyProfilePhoto`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecretValues(raw, [options.botToken]), {
      cause: error,
    });
  }
  const parsed = (await res.json().catch(() => null)) as {
    ok?: unknown;
    description?: unknown;
  } | null;
  if (!res.ok || parsed?.ok !== true) {
    const detail =
      typeof parsed?.description === "string"
        ? parsed.description
        : `HTTP ${res.status}`;
    throw new Error(
      redactSecretValues(`setMyProfilePhoto failed: ${detail}`, [
        options.botToken,
      ]),
    );
  }
}

/**
 * Ставит коллеге случайный талисман из ip-as-logo (JPG 640×640).
 * Никогда не бросает наружу и не утекает токеном в текст ошибки.
 */
export async function applyRandomColleagueAvatar(
  botToken: string,
  deps: ColleagueAvatarDeps = {},
): Promise<ColleagueAvatarOutcome> {
  try {
    const { logo, sourceBytes } = await pickRandomIpAsLogo({
      fetchImpl: deps.fetchImpl,
      random: deps.random,
    });
    const convert = deps.convertToJpeg640 ?? convertPngToJpeg640;
    const jpegBytes = await convert(sourceBytes);
    await uploadBotProfilePhoto({
      botToken,
      jpegBytes,
      fetchImpl: deps.fetchImpl,
      apiBaseUrl: deps.apiBaseUrl,
    });
    return {
      ok: true,
      logo: {
        id: logo.id,
        name: logo.name,
        category: logo.category,
        source: logo.image_url,
      },
      jpegBytes: jpegBytes.length,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: redactSecretValues(raw, [botToken]),
    };
  }
}
