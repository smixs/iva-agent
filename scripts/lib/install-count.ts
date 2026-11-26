/**
 * Install count: after a plugin from the default Marketplace is installed, Iva tells
 * iva-agent.com its name, and nothing else (ADR-0029).
 *
 * The whole request is spelled here so that what leaves the machine can be read in one
 * place: one POST, one JSON field, no identifier of the installation. It is the last
 * thing an install does, it waits a bounded time, and it cannot fail the install -
 * every error is swallowed and reported as `false`.
 */
export const INSTALL_COUNT_URL = "https://iva-agent.com/api/plugins/installs";

/** How long the end of `iva plugin add` may wait for a site that does not answer. */
export const INSTALL_COUNT_TIMEOUT_MS = 2500;

/**
 * The settings that turn the count off, by name: whoever starts the installer in an
 * environment of its own (the bridge, for an install after the owner's tap) hands these over.
 */
export const INSTALL_COUNT_SWITCHES = [
  "IVA_PLUGIN_STATS",
  "IVA_STATS",
  "DO_NOT_TRACK",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

const OFF = new Set(["off", "0", "false", "no"]);

/**
 * A setting as `.env` spells it, without quotes and without a trailing comment. On Linux the
 * service reads `.env` through systemd's EnvironmentFile, which keeps `IVA_STATS=off # …` and
 * `IVA_STATS=off#…` whole; Node's `--env-file` drops the comment in both. Both have to mean
 * the same here, so everything from the first `#` is a comment: no value of these switches
 * has one.
 */
function setting(value: string | undefined): string {
  return (value ?? "")
    .replace(/#.*$/s, "")
    .trim()
    .replace(/^(["'])(.*)\1$/s, "$2")
    .trim();
}

const switchedOff = (value: string | undefined) =>
  OFF.has(setting(value).toLowerCase());

/**
 * `IVA_STATS=off` (or `0`, `false`, `no`, any case) or `DO_NOT_TRACK=1`: the switch of
 * everything Iva reports on its own, the install count and the roll call (ADR-0031).
 */
export function statsOff(env: Env): boolean {
  return switchedOff(env.IVA_STATS) || setting(env.DO_NOT_TRACK) === "1";
}

/** `IVA_PLUGIN_STATS=off` in `.env` turns the count off; so does everything `statsOff` names. */
export function installCountEnabled(env: Env): boolean {
  return !switchedOff(env.IVA_PLUGIN_STATS) && !statsOff(env);
}

/** Sends the name; `true` when the site took it. Never throws. */
export async function sendInstallCount(
  name: string,
  request: typeof fetch = fetch,
  timeoutMs: number = INSTALL_COUNT_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await request(INSTALL_COUNT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
