import {
  resolveTimeZone,
  systemTimeZoneName,
  validateTimeZone,
} from "../../packages/timezone/index.ts";

/**
 * The zone the server runs in. `canonical` is what Intl consumers need; `exported` is the
 * name written to `process.env.TZ` for bash and python children, the same choice the systemd
 * units make: glibc reads a name it finds no file for as UTC, so the spelling has to be one
 * this host has. The owner's own spelling counts only once it passed validation.
 */
export function processTimeZone(
  rawTz: string | undefined,
  zoneinfoDir?: string,
): { canonical: string; exported: string; invalid: boolean } {
  const canonical = resolveTimeZone(rawTz);
  const valid = Boolean(rawTz?.trim()) && validateTimeZone(rawTz) !== null;
  return {
    canonical,
    exported: systemTimeZoneName(canonical, {
      configured: valid ? rawTz : undefined,
      zoneinfoDir,
    }),
    invalid: Boolean(rawTz?.trim()) && !valid,
  };
}
