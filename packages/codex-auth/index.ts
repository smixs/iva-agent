// Файл токена подписки OpenAI (data/codex-auth.json) и протокол его получения — одно место
// на обе половины: вход (`iva login`, мастер setup — scripts/lib/codex-oauth.ts) создаёт
// файл, рантайм (agent/lib/codex-auth.ts) обновляет его перед запросом модели. Пакет грузится
// и на инсталле без авторского дерева. Только node-builtins и соседний пакет data-dir.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveDataDir } from "../data-dir/index.ts";

export interface CodexAuth {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  accountId: string | null;
  planType: string | null;
}

type JsonRecord = Record<string, unknown>;
export type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
};

// Протокол (reverse-engineered из openai/codex, публичный client_id).
export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // публичный client_id Codex CLI
export const TOKEN_URL = `${ISSUER}/oauth/token`;
export const ORIGINATOR = "codex_cli_rs";

// От cwd, как у всех процессов установки: корень — WorkingDirectory сервиса.
const defaultDir = () => resolveDataDir(process.cwd());

// ── хранилище токенов ─────────────────────────────────────────────────────
export function authFilePath(dataDir = defaultDir()): string {
  return join(dataDir, "codex-auth.json");
}

export function readAuth(dataDir = defaultDir()): CodexAuth | null {
  try {
    return JSON.parse(readFileSync(authFilePath(dataDir), "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

// Атомарная запись 0600 (temp + rename) — секрет не должен мелькнуть с широкими правами,
// а конкурентный read не должен поймать полу-записанный файл.
export function writeAuth(auth: CodexAuth, dataDir = defaultDir()): void {
  const file = authFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// ── JWT (без внешних зависимостей) ─────────────────────────────────────────
export function parseJwt(jwt: string): JsonRecord {
  const payload = String(jwt).split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as JsonRecord;
}

// Из id_token достаём account_id и план подписки (клейм https://api.openai.com/auth).
export function accountFromIdToken(idToken: string): {
  accountId: string | null;
  planType: string | null;
} {
  let auth: JsonRecord = {};
  try {
    auth = (parseJwt(idToken)["https://api.openai.com/auth"] ||
      {}) as JsonRecord;
  } catch {
    /* нет клейма — вернём пустое */
  }
  const accountId = auth.chatgpt_account_id;
  const planType = auth.chatgpt_plan_type;
  return {
    accountId: typeof accountId === "string" && accountId ? accountId : null,
    planType: typeof planType === "string" && planType ? planType : null,
  };
}

// Собирает объект хранилища из ответа токен-эндпоинта.
export function toAuth(
  tokens: TokenResponse,
  prev: Partial<CodexAuth> = {},
): CodexAuth {
  const idToken = tokens.id_token || prev.id_token;
  // id_token есть, но аккаунта в нём нет (не JWT, нет клейма, пустой клейм) — прежние
  // accountId и planType остаются: без заголовка ChatGPT-Account-ID бэкенд подписки
  // отвечает отказом, а рефреш сам себя не чинит (слепое QA v3). Новый id_token,
  // НАЗВАВШИЙ аккаунт, по-прежнему побеждает: так переезжают на другой.
  const named = idToken
    ? accountFromIdToken(idToken)
    : { accountId: null, planType: null };
  return {
    id_token: idToken,
    // Пустой ответ не смеет стереть уже записанный токен: файл входа обновляется только
    // на непустое значение (PBT-DS1-P F2).
    access_token: tokens.access_token || prev.access_token || "",
    refresh_token: tokens.refresh_token || prev.refresh_token,
    accountId: named.accountId ?? prev.accountId ?? null,
    planType: named.planType ?? prev.planType ?? null,
  };
}
