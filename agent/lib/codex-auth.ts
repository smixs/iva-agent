// Рантайм-доступ к подписке OpenAI (ChatGPT Plus/Pro/Team): прочитать data/codex-auth.json,
// обновить протухший токен и собрать заголовки для Codex-бэкенда. Живёт в authored tree,
// потому что этим занимается сам агент — agent/provider.ts подставляет свежий Bearer перед
// КАЖДЫМ запросом модели, а eve пересобирает дерево при старте (issue #176).
//
// Вход (device-code и browser-PKCE), который этот файл создаёт, живёт в
// scripts/lib/codex-oauth.ts: `iva login` обязан работать на инсталле без авторского дерева
// (ADR-0003). Сам файл токена — путь, чтение, атомарная запись 0600, разбор id_token — и
// протокольные константы у обеих половин одни: packages/codex-auth.
//
// Протокол (reverse-engineered из openai/codex, публичный client_id):
//   auth-домен  https://auth.openai.com     refresh
//   API-домен   https://chatgpt.com/backend-api/codex   Responses API (/responses, /models)
// Токен (access_token — JWT, живёт ~1 ч) лежит в data/codex-auth.json (0600, gitignored).
import { dataDir } from "./data-dir.ts";
import {
  accountFromIdToken,
  authFilePath,
  CLIENT_ID,
  type CodexAuth,
  ISSUER,
  ORIGINATOR,
  parseJwt,
  readAuth,
  toAuth,
  TOKEN_URL,
  type TokenResponse,
  writeAuth,
} from "../../packages/codex-auth/index.ts";

export {
  accountFromIdToken,
  authFilePath,
  CLIENT_ID,
  type CodexAuth,
  ISSUER,
  ORIGINATOR,
  parseJwt,
  readAuth,
  toAuth,
  TOKEN_URL,
  writeAuth,
};

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Для ?client_version= у /models и User-Agent. ВАЖНО: /models гейтит список по версии —
// слишком старая (напр. 0.20/0.42) → бэкенд отдаёт {"models":[]}, а модель прячется, если её
// minimal_client_version выше нашей (напр. gpt-6-sol и gpt-6-luna требуют ≥0.155.0). Держим на
// актуальном релизе codex, иначе свежие модели не появятся в списке. Проверено 2026-09-23: 0.144.0
// отдаёт только gpt-5.6-*, 0.156.0 — ещё gpt-6-{sol,luna,astra}. Проверено 2026-10-03: 0.156.0 не
// показывает gpt-6.1-sol, хотя его minimal_client_version 0.153.0; 0.159.2 показывает.
export const CLIENT_VERSION = "0.159.2";
const REFRESH_SKEW_S = 300; // рефрешим за 5 мин до exp (как окно codex CLI)
const FORCE_REFRESH_COOLDOWN_MS = 60_000;

const defaultDir = dataDir;

// exp (unix-секунды) из access_token; 0 если нет клейма.
export function jwtExp(jwt: string): number {
  try {
    return Number(parseJwt(jwt).exp) || 0;
  } catch {
    return 0;
  }
}

const AUTH_TIMEOUT_MS = 30_000;

async function refresh(
  refreshToken: string | undefined,
): Promise<TokenResponse> {
  const signal = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok)
      throw new Error(
        `token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    const body = (await res.json()) as TokenResponse; // { id_token?, access_token, refresh_token? }
    // Ответ без access_token — ОТКАЗ обновления, а не новый вход: записать его значит
    // стереть рабочий файл входа, потребовать `iva login` на следующем вызове и отправить
    // провайдеру заголовок "Bearer undefined" (PBT-DS1-P F2). Пустая строка — такой же
    // отказ: заголовок без токена не работает.
    const accessToken =
      typeof body?.access_token === "string" ? body.access_token.trim() : "";
    if (!accessToken)
      throw new Error(
        "token refresh returned no access_token; the stored login was kept — run `iva login` if this repeats",
      );
    return { ...body, access_token: accessToken };
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        `Codex не ответил при обновлении токена за ${AUTH_TIMEOUT_MS / 1000} с`,
        { cause: error },
      );
    throw error;
  }
}

// ── getAccessToken: свежий токен для каждого запроса ────────────────────────
// Дедуп рефреша в пределах процесса (модель зовётся конкурентно). Кросс-процессный
// рейс (CLI login + сервер) маловероятен и самолечится: при провале рефреша
// перечитываем файл — вдруг другой процесс уже обновил.
let refreshInFlight: Promise<CodexAuth> | null = null;
let lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

type AccessToken = { accessToken: string; accountId: string | null };

function accessTokenFrom(auth: CodexAuth): AccessToken {
  return { accessToken: auth.access_token, accountId: auth.accountId };
}

function accessTokenIsFresh(accessToken: string): boolean {
  return jwtExp(accessToken) - REFRESH_SKEW_S > Math.floor(Date.now() / 1000);
}

async function refreshAccessToken(
  auth: CodexAuth,
  dataDir: string,
  rereadMustDiffer: boolean,
): Promise<CodexAuth> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const next = toAuth(await refresh(auth.refresh_token), auth);
        writeAuth(next, dataDir);
        return next;
      } catch (err) {
        const reread = readAuth(dataDir); // мог обновить другой процесс
        if (
          reread?.access_token &&
          accessTokenIsFresh(reread.access_token) &&
          (!rereadMustDiffer || reread.access_token !== auth.access_token)
        )
          return reread;
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export async function getAccessToken(
  dataDir = defaultDir(),
): Promise<AccessToken> {
  const auth = readAuth(dataDir);
  if (!auth?.access_token) throw new Error("not logged in — run `iva login`");
  if (accessTokenIsFresh(auth.access_token)) return accessTokenFrom(auth);
  return accessTokenFrom(await refreshAccessToken(auth, dataDir, false));
}

// Бэкенд может отвергнуть токен раньше JWT exp. Один forced refresh на минуту
// даёт ходу одну попытку самолечения, но не бомбит auth.openai.com.
export async function forceRefreshAccessToken(
  dataDir = defaultDir(),
): Promise<AccessToken> {
  const auth = readAuth(dataDir);
  if (!auth?.access_token) throw new Error("not logged in — run `iva login`");
  if (refreshInFlight) return accessTokenFrom(await refreshInFlight);

  const now = Date.now();
  if (now - lastForcedRefreshAt < FORCE_REFRESH_COOLDOWN_MS)
    return accessTokenFrom(auth);
  lastForcedRefreshAt = now;
  return accessTokenFrom(await refreshAccessToken(auth, dataDir, true));
}

// Заголовки авторизации для вызова Codex-бэкенда (/responses, /models).
export async function codexAuthHeaders(
  dataDir = defaultDir(),
): Promise<Record<string, string>> {
  const { accessToken, accountId } = await getAccessToken(dataDir);
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    originator: ORIGINATOR,
    "User-Agent": `${ORIGINATOR}/${CLIENT_VERSION}`,
  };
  if (accountId) h["ChatGPT-Account-ID"] = accountId;
  return h;
}
