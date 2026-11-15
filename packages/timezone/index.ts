import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Return the canonical IANA timezone `Intl` resolves the input to, or `null`.
 * `Intl` accepts any case and the historical aliases, systemd accepts neither, so
 * the canonical spelling is what callers get: `europe/moscow` and `US/Pacific`
 * come back as `Europe/Moscow` and `America/Los_Angeles`.
 */
export function validateTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** Resolve every configured timezone to a valid IANA zone or the stable UTC fallback. */
export function resolveTimeZone(value: unknown): string {
  return validateTimeZone(value) ?? "UTC";
}

/**
 * Zones where `Intl` still answers with a legacy spelling that the tz database keeps only
 * as a backward link (CLDR never renames an id): `Europe/Kiev` for `Europe/Kyiv`. A system
 * tzdata that ships no legacy links (Ubuntu 26.04) has no such file, so systemd refuses an
 * `OnCalendar=` naming it and `TZ=` silently means UTC. Each value is the name of the same
 * zone in the tz database's `zone.tab`; the keys are exactly the `Intl` zones that are
 * backward links and absent from `zone.tab`.
 */
const SYSTEM_ZONE_NAME: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

const DEFAULT_ZONEINFO_DIR = "/usr/share/zoneinfo";

// Slash-separated segments of `[A-Za-z0-9_+-]`: no `..`, no empty or absolute parts.
const ZONE_FILE_NAME = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;

function zoneFileExists(dir: string, name: string): boolean {
  return ZONE_FILE_NAME.test(name) && existsSync(join(dir, name));
}

/**
 * The name of an already canonical zone as systemd and `TZ=` find it on this host. The
 * candidates are the owner's own spelling, the tz database's modern name from the table and
 * the `Intl` name; the first one with a file in the host's tz directory wins, so a host with
 * only the legacy link or only the modern name is served either way. With no tz directory or
 * no matching file the table's name is returned.
 */
export function systemTimeZoneName(
  zone: string,
  options: { configured?: string; zoneinfoDir?: string } = {},
): string {
  const mapped = SYSTEM_ZONE_NAME[zone] ?? zone;
  const dir = options.zoneinfoDir ?? DEFAULT_ZONEINFO_DIR;
  const candidates = [options.configured, mapped, zone];
  return (
    candidates.find(
      (name): name is string => name !== undefined && zoneFileExists(dir, name),
    ) ?? mapped
  );
}
