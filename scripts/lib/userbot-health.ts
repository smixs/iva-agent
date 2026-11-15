import { serviceManager } from "./service-manager.ts";
import { runLaunchd } from "./launchd.ts";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "../../packages/data-dir/index.ts";

export const USERBOT_HEALTH_TIMEOUT_MS = 1500;
export const USERBOT_SERVICE = "iva-telegram-userbot.service";
/**
 * The proxy listens only after it has connected to Telegram, and Telethon's defaults
 * allow five connect attempts of 10 s each: a slow network must not read as a broken
 * environment and switch the userbot off.
 */
export const USERBOT_READINESS_TIMEOUT_MS = 60_000;

/** A reachable unauthorized proxy is ready for QR login; it is not a ready Telegram session. */
export function userbotProxyReady(health: UserbotHealth): boolean {
  return health.state === "ready" || health.state === "unauthorized";
}

export async function awaitUserbotHealth(
  probe: (signal: AbortSignal) => Promise<UserbotHealth>,
  timeoutMs = USERBOT_READINESS_TIMEOUT_MS,
): Promise<UserbotHealth> {
  const controller = new AbortController();
  let expired = false;
  let last: UserbotHealth = { state: "starting", reason: "service_starting" };
  let timer: NodeJS.Timeout | undefined;
  let pause: NodeJS.Timeout | undefined;
  const deadline = new Promise<UserbotHealth>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      resolve({
        state: "unreachable",
        reason: "readiness_timeout:" + last.reason,
      });
    }, timeoutMs);
  });
  try {
    while (!expired) {
      const health = await Promise.race([
        Promise.resolve()
          .then(() => probe(controller.signal))
          .catch(
            () =>
              ({ state: "unreachable", reason: "proxy_unreachable" }) as const,
          ),
        deadline,
      ]);
      if (expired || userbotProxyReady(health)) return health;
      last = health;
      const waiting = new Promise<null>((resolve) => {
        pause = setTimeout(() => resolve(null), 200);
      });
      const timedOut = await Promise.race([waiting, deadline]);
      clearTimeout(pause);
      if (timedOut) return timedOut;
    }
    return await deadline;
  } finally {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(pause);
  }
}

export type UserbotHealthState =
  "off" | "starting" | "unreachable" | "unauthorized" | "ready";

/** The state in the owner's words, one wording for every menu screen. */
export const userbotStateLabel = (
  tr: (en: string, ru: string) => string,
  state: UserbotHealthState,
) =>
  ({
    off: tr("off", "выкл"),
    starting: tr("starting", "запускается"),
    unreachable: tr("unreachable", "недоступен"),
    unauthorized: tr("login required", "нужен вход"),
    ready: tr("ready", "готов"),
  })[state];

/**
 * The login phases of the proxy: `Phase` in services/telegram-userbot/onboarding.py lists
 * them and `/healthz` sends one as `login` (specs/UserbotLogin.tla).
 */
export const USERBOT_LOGIN_PHASES = [
  "idle",
  "starting",
  "waiting",
  "password_needed",
  "authorized",
  "expired",
  "error",
  "interrupted",
] as const;
export type UserbotLoginPhase = (typeof USERBOT_LOGIN_PHASES)[number];

export interface UserbotHealth {
  readonly state: UserbotHealthState;
  readonly reason: string;
  /** Named by a proxy that answered; `ready` goes with `authorized` and only with it. */
  readonly login?: UserbotLoginPhase;
}

interface SystemctlResult {
  readonly code: number;
  readonly out: string;
}

interface HealthResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

interface HealthFetchInit {
  readonly method: "GET";
  readonly headers: { readonly authorization: string };
  readonly signal: AbortSignal;
}

type RunSystemctl = (
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<SystemctlResult>;
type ReadToken = (dataDir: string) => Promise<string>;
type FetchImpl = (
  url: string,
  init: HealthFetchInit,
) => Promise<HealthResponse>;

interface ProbeOptions {
  readonly root?: string;
  readonly dataDir?: string;
  readonly port?: string | number;
  readonly timeoutMs?: number;
  readonly runSystemctl?: RunSystemctl;
  readonly readToken?: ReadToken;
  readonly fetchImpl?: FetchImpl;
  readonly signal?: AbortSignal;
}

function fixed(
  state: UserbotHealthState,
  reason: string,
  login?: UserbotLoginPhase,
): UserbotHealth {
  return login ? { state, reason, login } : { state, reason };
}

function defaultRunSystemctl(
  args: string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<SystemctlResult> {
  if (serviceManager() === "launchd") return Promise.resolve(runLaunchd(args));
  return new Promise((resolve) => {
    execFile(
      "systemctl",
      ["--user", ...args],
      { encoding: "utf8", signal },
      (error, stdout = "") => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          out: String(stdout).trim(),
        });
      },
    );
  });
}

async function defaultReadToken(dataDir: string): Promise<string> {
  try {
    return (
      await readFile(join(dataDir, "telegram-userbot.token"), "utf8")
    ).trim();
  } catch {
    return "";
  }
}

function payloadHealth(payload: unknown): UserbotHealth {
  const { state, login: named } = (payload ?? {}) as Record<string, unknown>;
  const login = USERBOT_LOGIN_PHASES.find((phase) => phase === named);
  const ready = state === "ready";
  if (
    (ready || state === "unauthorized") &&
    (login === undefined || ready === (login === "authorized"))
  )
    return ready
      ? fixed("ready", "ok", login)
      : fixed("unauthorized", "telegram_login_required", login);
  return fixed("unreachable", "invalid_proxy_response");
}

interface RunProbeOptions {
  readonly dataDir: string;
  readonly port: string | number;
  readonly signal: AbortSignal;
  readonly runSystemctl: RunSystemctl;
  readonly readToken: ReadToken;
  readonly fetchImpl: FetchImpl;
}

async function runProbe({
  dataDir,
  port,
  signal,
  runSystemctl,
  readToken,
  fetchImpl,
}: RunProbeOptions): Promise<UserbotHealth> {
  const [active, enabled] = await Promise.all([
    runSystemctl(["is-active", USERBOT_SERVICE], { signal }),
    runSystemctl(["is-enabled", USERBOT_SERVICE], { signal }),
  ]);
  const activeLabel = String(active?.out || "").trim();
  const enabledLabel = String(enabled?.out || "").trim();
  const isActive = active?.code === 0 && activeLabel === "active";
  const isEnabled = enabled?.code === 0 && enabledLabel === "enabled";

  if (!isActive) {
    if (activeLabel === "activating" || isEnabled)
      return fixed("starting", "service_starting");
    return fixed("off", "service_off");
  }

  const token = String(await readToken(dataDir)).trim();
  if (!token) return fixed("unreachable", "proxy_token_missing");

  const safePort = /^\d{1,5}$/.test(String(port)) ? String(port) : "8724";
  const response = await fetchImpl(`http://127.0.0.1:${safePort}/healthz`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (response.status === 401)
    return fixed("unreachable", "proxy_auth_rejected");
  if (!response.ok) return fixed("unreachable", "proxy_unreachable");

  return payloadHealth(await response.json());
}

export async function probeUserbotHealth({
  root = process.cwd(),
  dataDir = resolveDataDir(root),
  port = process.env.TELEGRAM_MCP_PORT || "8724",
  timeoutMs = USERBOT_HEALTH_TIMEOUT_MS,
  runSystemctl = defaultRunSystemctl,
  readToken = defaultReadToken,
  fetchImpl = globalThis.fetch,
  signal,
}: ProbeOptions = {}): Promise<UserbotHealth> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<UserbotHealth>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fixed("unreachable", "probe_timeout"));
    }, timeoutMs);
  });
  const probe = runProbe({
    dataDir,
    port,
    signal: controller.signal,
    runSystemctl,
    readToken,
    fetchImpl,
  }).catch(() =>
    controller.signal.aborted
      ? fixed("unreachable", "probe_timeout")
      : fixed("unreachable", "proxy_unreachable"),
  );

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}
