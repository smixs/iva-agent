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

/** The name of an already canonical zone as systemd and `TZ=` find it in the system tzdata. */
export function systemTimeZoneName(zone: string): string {
  return SYSTEM_ZONE_NAME[zone] ?? zone;
}
