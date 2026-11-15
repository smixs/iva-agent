import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TELEGRAM_ACCEPTANCE_ROUTE } from "#lib/telegram-acceptance.ts";
import { TELEGRAM_CANCEL_ROUTE } from "#lib/telegram-cancel-route.ts";
import {
  dataDirSetting,
  resolveDataDir,
} from "../../packages/data-dir/index.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NODE = process.execPath;

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const BOT_USER_ID = /^(\d+):/.exec(TOKEN ?? "")?.[1] ?? null;
export const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? "my_bot";
export const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
export const PORT = process.env.IVA_PORT ?? "8723";
export const HOST = (
  process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");
export const DATA_DIR_RAW = dataDirSetting(process.env.ASSISTANT_DATA_DIR);
export const DATA_DIR = resolveDataDir(ROOT, DATA_DIR_RAW);
// Absolute paths for the /model wizard: .env is read fresh (this process's env goes
// stale after the wizard edits the file) and data/ holds codex-auth.json.
export const ENV_PATH = join(ROOT, ".env");
export const DATA_DIR_ABS = DATA_DIR;
export const ROUTE = `${HOST}/eve/v1/telegram`;
export const ACCEPTANCE_ROUTE = `${HOST}${TELEGRAM_ACCEPTANCE_ROUTE}`;
export const RESET_ROUTE = `${ROUTE}/reset`;
export const CANCEL_ROUTE = `${HOST}${TELEGRAM_CANCEL_ROUTE}`;
export const API = `https://api.telegram.org/bot${TOKEN}`;
export const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Acceptance returns 204 only after the turn starts. Ninety seconds is deliberately
// generous so no legitimate start should hit the deadline, while a wedged eve cannot
// block the bridge's single polling loop forever.
const configuredDirectAcceptanceTimeoutMs = Number(
  process.env.TELEGRAM_DIRECT_ACCEPTANCE_TIMEOUT_MS,
);
export const DIRECT_ACCEPTANCE_TIMEOUT_MS =
  Number.isInteger(configuredDirectAcceptanceTimeoutMs) &&
  configuredDirectAcceptanceTimeoutMs > 0 &&
  configuredDirectAcceptanceTimeoutMs <= 4_294_967_295
    ? configuredDirectAcceptanceTimeoutMs
    : 90_000;
// Pause between updates of the SAME chat: we give eve time to park the turn and register
// the continuation hook, otherwise a burst starts a second run on the same token → HookConflictError.
export const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);
export const UPDATE_JOB_TTL_MS = 6 * 60 * 60 * 1000;

// Trusted IDs — only they are allowed control commands (/restart etc.).
export const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

// LANG/t/HELP убраны: язык теперь динамический (getLang из i18n.ts, реагирует на
// data/settings.json без рестарта), /help генерится helpText() из общей таблицы COMMANDS.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const log = (...args: unknown[]): void =>
  console.log(new Date().toISOString(), ...args);
