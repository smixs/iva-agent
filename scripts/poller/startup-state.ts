import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import type { OffsetState } from "../lib/offset-store.ts";
import { DATA_DIR } from "./config.ts";
import { loadOffset } from "./offset.ts";
import {
  assertTelegramProcessLease,
  type TelegramProcessLease,
} from "./process-lock.ts";

const MARKER_SCHEMA = "iva-telegram-backlog-drop/v1";
export const BACKLOG_DROP_MARKER_FILE = join(
  DATA_DIR,
  "telegram-backlog-drop.json",
);

export type BacklogDropMarker = { schema: typeof MARKER_SCHEMA };
export type MarkerState = "missing" | "present";
export type StartupDecision =
  | { action: "resume"; offset: number }
  | { action: "write-marker-and-drop"; offset: null }
  | { action: "write-marker-and-resume"; offset: number }
  | { action: "ambiguous" };

type ErrorLike = { code?: unknown; message?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBacklogDropMarker(raw: string): BacklogDropMarker {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.schema !== MARKER_SCHEMA ||
    Object.keys(parsed).length !== 1
  ) {
    throw new Error("invalid Telegram backlog marker schema");
  }
  return { schema: MARKER_SCHEMA };
}

export function decideTelegramStartup(
  offset: OffsetState,
  marker: MarkerState,
): StartupDecision {
  if (offset.offset === null) {
    return marker === "missing"
      ? { action: "write-marker-and-drop", offset: null }
      : { action: "ambiguous" };
  }
  return marker === "missing"
    ? { action: "write-marker-and-resume", offset: offset.offset }
    : { action: "resume", offset: offset.offset };
}

async function loadMarker(
  file: string,
  readFileImpl: typeof readFile,
): Promise<MarkerState> {
  try {
    parseBacklogDropMarker(await readFileImpl(file, "utf8"));
    return "present";
  } catch (error) {
    if ((error as ErrorLike | null | undefined)?.code === "ENOENT") {
      return "missing";
    }
    const message = (error as ErrorLike | null | undefined)?.message;
    throw new Error(
      `failed to load Telegram backlog marker ${file}: ${String(message)}`,
      { cause: error },
    );
  }
}

export async function prepareTelegramStartup(
  lease: TelegramProcessLease,
  {
    markerFile = BACKLOG_DROP_MARKER_FILE,
    loadOffsetImpl = loadOffset,
    readFileImpl = readFile,
    createMarkerImpl = (file: string, data: string) =>
      writeFileAtomic(file, data, { mode: 0o600 }),
  }: {
    markerFile?: string;
    loadOffsetImpl?: () => Promise<OffsetState>;
    readFileImpl?: typeof readFile;
    createMarkerImpl?: (file: string, data: string) => Promise<void>;
  } = {},
): Promise<
  { firstRun: true; offset: null } | { firstRun: false; offset: number }
> {
  assertTelegramProcessLease(lease);
  const [offset, marker] = await Promise.all([
    loadOffsetImpl(),
    loadMarker(markerFile, readFileImpl),
  ]);
  const decision = decideTelegramStartup(offset, marker);
  if (decision.action === "ambiguous") {
    throw new Error(
      "Telegram backlog marker exists without an offset; refusing to drop pending updates again",
    );
  }
  if (
    decision.action === "write-marker-and-drop" ||
    decision.action === "write-marker-and-resume"
  ) {
    await createMarkerImpl(
      markerFile,
      `${JSON.stringify({ schema: MARKER_SCHEMA })}\n`,
    );
  }
  if (decision.action === "write-marker-and-drop") {
    return { firstRun: true, offset: null };
  }
  return { firstRun: false, offset: decision.offset };
}
