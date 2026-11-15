// Вход по подписке OpenAI (ChatGPT Plus/Pro/Team) — как в официальном codex CLI: device-code
// и browser-PKCE потоки, которые СОЗДАЮТ data/codex-auth.json, плюс каталог моделей подписки
// для мастеров /model и setup. Остаётся в scripts/, потому что `iva login` обязан работать на
// инсталле без авторского дерева — см. docs/tech-debt.md.
//
// Вторая половина — agent/lib/codex-auth.ts: рефреш токена и заголовки запроса, то есть
// всё, что нужно самому агенту в рантайме. Импортировать её отсюда на этапе загрузки нельзя
// (её тут может не быть — мастер setup грузится и на инсталле без agent/). Общее у половин —
// файл токена и протокольные константы — лежит в packages/codex-auth и грузится без
// авторского дерева. Каталог моделей нужен только на полном инсталле, и его половину
// заголовков подтягивает ленивый импорт внутри самого вызова.
// Чистый ESM, только node-builtins (crypto/fs/http/child_process).
//
// Протокол (reverse-engineered из openai/codex, публичный client_id):
//   auth-домен  https://auth.openai.com     device-code + browser-PKCE
//   API-домен   https://chatgpt.com/backend-api/codex   /models
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import {
  accountFromIdToken,
  authFilePath,
  CLIENT_ID,
  type CodexAuth,
  ISSUER,
  ORIGINATOR,
  readAuth,
  toAuth,
  TOKEN_URL,
  type TokenResponse,
  writeAuth,
} from "../../packages/codex-auth/index.ts";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "../../packages/reasoning-levels/index.ts";
import { resolveDataDir } from "../../packages/data-dir/index.ts";

// Мастер setup спрашивает «вход уже есть?» и печатает план подписки — на инсталле, где
// авторского дерева может не быть. Битый файл читается как «входа нет».
export { authFilePath, type CodexAuth, readAuth };

export interface LoginOptions {
  dataDir?: string;
  log?: (message: string) => void;
  open?: boolean;
  lang?: string;
}

export interface CodexModelCatalogEntry {
  id: string;
  reasoningLevels: string[];
}

export interface CodexModelCatalogOptions {
  dataDir?: string;
  fetchFn?: typeof fetch;
  authHeadersFn?: (dataDir?: string) => Promise<Record<string, string>>;
}

type JsonRecord = Record<string, unknown>;
type LoginPort = { server: Server; port: number };

const SCOPE = "openid profile email offline_access";
const DEVICE_PORT = 1455; // codex-совместимый redirect-порт (fallback 1457)
const FALLBACK_PORT = 1457;

const b64url = (buf: string | Buffer) => Buffer.from(buf).toString("base64url");
const defaultDir = () => resolveDataDir(process.cwd());
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 30_000;
// Язык подсказок входа (en по умолчанию — как у codex CLI). Мастер/CLI прокидывают lang.
const tr = (lang: string, en: string, ru: string) => (lang === "ru" ? ru : en);

function pkce() {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── обмен кода и refresh (общий /oauth/token) ──────────────────────────────
async function exchangeCode({
  code,
  verifier,
  redirectUri,
}: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });
    const res = await fetch(TOKEN_URL, {
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok)
      throw new Error(
        `token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    return (await res.json()) as TokenResponse; // { id_token, access_token, refresh_token }
  } catch (error) {
    if (error instanceof Error && /^(Timeout|Abort)Error$/.test(error.name))
      throw new Error("Codex не ответил при входе за 30 с", { cause: error });
    throw error;
  }
}

// ── device-code flow (headless-friendly, по ссылке) ────────────────────────
export async function runDeviceCodeLogin({
  dataDir = defaultDir(),
  log = console.log,
  lang = "en",
}: LoginOptions = {}): Promise<CodexAuth> {
  try {
    const api = `${ISSUER}/api/accounts`;
    const uc = await fetch(`${api}/deviceauth/usercode`, {
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!uc.ok)
      throw new Error(
        `device usercode failed: ${uc.status} ${(await uc.text()).slice(0, 200)}`,
      );
    const { device_auth_id, user_code, interval } = (await uc.json()) as {
      device_auth_id: string;
      user_code: string;
      interval: unknown;
    };

    log(
      `\n  1. ${tr(lang, "Open this link in a browser (any device):", "Открой в браузере (на любом устройстве):")}  ${ISSUER}/codex/device`,
    );
    log(
      `  2. ${tr(lang, "Enter this one-time code (expires in 15 min):", "Введи одноразовый код (живёт 15 минут):")}   ${user_code}\n`,
    );
    log(`  ${tr(lang, "Waiting for confirmation…", "Жду подтверждения…")}`);

    const pollMs = Math.max(Number(interval) || 5, 1) * 1000;
    const deadline = Date.now() + 15 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline)
        throw new Error("device auth timed out (15 min)");
      const r = await fetch(`${api}/deviceauth/token`, {
        signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id, user_code }),
      });
      if (r.ok) {
        const { authorization_code, code_verifier } = (await r.json()) as {
          authorization_code: string;
          code_verifier: string;
        };
        const tokens = await exchangeCode({
          code: authorization_code,
          verifier: code_verifier,
          redirectUri: `${ISSUER}/deviceauth/callback`,
        });
        const auth = toAuth(tokens);
        writeAuth(auth, dataDir);
        return auth;
      }
      if (r.status !== 403 && r.status !== 404)
        throw new Error(`device auth failed: ${r.status}`);
      await new Promise((res) => setTimeout(res, pollMs));
    }
  } catch (error) {
    if (error instanceof Error && /^(Timeout|Abort)Error$/.test(error.name))
      throw new Error("Codex не ответил при входе за 30 с", { cause: error });
    throw error;
  }
}

// ── browser-PKCE flow (локальный сервер + авто-открытие браузера) ───────────
function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const cmd =
    process.platform === "darwin" ? "open" : win ? "start" : "xdg-open";
  // win32: `start` берёт первый аргумент как заголовок окна, а в authorize-URL есть `&` →
  // передаём пустой заголовок "" перед URL, иначе cmd.exe не откроет ссылку.
  const args = win ? ["", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: win }).unref();
  } catch {
    /* нет графики (headless) — пользователь откроет ссылку сам */
  }
}

export async function runBrowserLogin({
  dataDir = defaultDir(),
  log = console.log,
  open = true,
  lang = "en",
}: LoginOptions = {}): Promise<CodexAuth> {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(32));
  const port = await listenFirstFree([DEVICE_PORT, FALLBACK_PORT]);
  const redirectUri = `http://localhost:${port.port}/auth/callback`;
  const authorizeUrl =
    `${ISSUER}/oauth/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: ORIGINATOR,
    }).toString();

  log(
    `\n  ${tr(lang, "Open this in a browser and sign in to OpenAI:", "Открой в браузере и войди в OpenAI:")}\n  ${authorizeUrl}\n`,
  );
  if (open) openBrowser(authorizeUrl);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        port.server.close();
        reject(new Error("browser login timed out (10 min)"));
      },
      10 * 60 * 1000,
    );

    port.server.on("request", (req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://localhost:${port.port}`);
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const done = (code: number, msg: string): void => {
          res
            .writeHead(code, { "Content-Type": "text/html; charset=utf-8" })
            .end(`<h3>${msg}</h3>`);
        };
        try {
          if (url.searchParams.get("state") !== state)
            throw new Error("state mismatch");
          const err = url.searchParams.get("error");
          if (err) throw new Error(`OAuth error: ${err}`);
          const code = url.searchParams.get("code");
          if (!code) throw new Error("missing authorization code");
          const auth = toAuth(
            await exchangeCode({ code, verifier, redirectUri }),
          );
          writeAuth(auth, dataDir);
          done(
            200,
            tr(
              lang,
              "Signed in — you can close this tab and return to the terminal.",
              "Готово — вход выполнен. Можно закрыть вкладку и вернуться в терминал.",
            ),
          );
          clearTimeout(timer);
          port.server.close();
          resolve(auth);
        } catch (e) {
          done(
            400,
            `${tr(lang, "Sign-in error", "Ошибка входа")}: ${(e as Error).message}`,
          );
          clearTimeout(timer);
          port.server.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  });
}

// Пытается слушать порты по списку, возвращает первый свободный { server, port }.
function listenFirstFree(ports: readonly number[]): Promise<LoginPort> {
  return new Promise<LoginPort>((resolve, reject) => {
    const tryPort = (i: number): void => {
      if (i >= ports.length)
        return reject(new Error("no free login port (1455/1457 busy)"));
      const server = createServer();
      server.once("error", () => tryPort(i + 1));
      server.listen(ports[i], "127.0.0.1", () =>
        resolve({ server, port: ports[i] }),
      );
    };
    tryPort(0);
  });
}

export async function login(
  mode: "device" | "browser" = "device",
  opts: LoginOptions = {},
): Promise<CodexAuth> {
  return mode === "browser" ? runBrowserLogin(opts) : runDeviceCodeLogin(opts);
}

// ── модели подписки и их reasoning levels (один запрос /models) ────────────
// Telegram строит оба экрана из одного ответа. Мастер установки использует тонкий
// listCodexModels() ниже и не платит вторым запросом за тот же каталог.
const MODEL_LIST_KEYS = /^(models?|model_presets|presets|items|data)$/i;
const CANONICAL_REASONING_LEVELS = new Set(CANONICAL_REASONING_EFFORTS);

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(node: unknown, key: string): unknown {
  return node && typeof node === "object"
    ? (node as JsonRecord)[key]
    : undefined;
}

function modelId(node: unknown, parentKey: string): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const primary =
    cleanString(objectValue(node, "model")) ||
    cleanString(objectValue(node, "slug"));
  if (primary) return primary;
  // `id`/`name` are documented fallbacks, but only inside a model-list wrapper:
  // arbitrary metadata such as tiers:[{id:"flex"}] must not become a model button.
  if (MODEL_LIST_KEYS.test(parentKey || ""))
    return (
      cleanString(objectValue(node, "id")) ||
      cleanString(objectValue(node, "name"))
    );
  return null;
}

function reasoningLevels(node: unknown): { levels: string[]; live: boolean } {
  const supported = objectValue(node, "supported_reasoning_levels");
  if (!Array.isArray(supported)) {
    return { levels: [...FALLBACK_REASONING_EFFORTS], live: false };
  }
  const levels = supported
    .map((level): string | null => {
      if (typeof level === "string")
        return cleanString(level)?.toLowerCase() || null;
      return (
        cleanString(objectValue(level, "effort"))?.toLowerCase() ||
        cleanString(objectValue(level, "level"))?.toLowerCase() ||
        cleanString(objectValue(level, "id"))?.toLowerCase() ||
        cleanString(objectValue(level, "name"))?.toLowerCase() ||
        null
      );
    })
    .filter(
      (level): level is string =>
        level !== null && CANONICAL_REASONING_LEVELS.has(level),
    );
  const unique = [...new Set(levels)];
  return unique.length
    ? { levels: unique, live: true }
    : { levels: [...FALLBACK_REASONING_EFFORTS], live: false };
}

// Pure parser kept separate from auth/network so malformed and future wrapper
// shapes can be covered without credentials. Quotes and Unicode in IDs remain
// untouched; buttons carry only their numeric index.
export function parseCodexModelCatalog(
  json: unknown,
): CodexModelCatalogEntry[] {
  const found = new Map<string, CodexModelCatalogEntry & { live: boolean }>();
  function walk(node: unknown, parentKey = ""): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        const stringId = MODEL_LIST_KEYS.test(parentKey)
          ? cleanString(item)
          : null;
        if (stringId && !found.has(stringId)) {
          found.set(stringId, {
            id: stringId,
            reasoningLevels: [...FALLBACK_REASONING_EFFORTS],
            live: false,
          });
        } else {
          walk(item, parentKey);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    const id = modelId(node, parentKey);
    if (id) {
      const { levels, live } = reasoningLevels(node);
      const previous = found.get(id);
      if (!previous || (!previous.live && live)) {
        found.set(id, { id, reasoningLevels: levels, live });
      }
    }
    for (const [key, value] of Object.entries(node as JsonRecord)) {
      if (key !== "supported_reasoning_levels") walk(value, key);
    }
  }
  walk(json, Array.isArray(json) ? "models" : "");
  return [...found.values()]
    .map(({ id, reasoningLevels }) => ({ id, reasoningLevels }))
    .sort((a, b) => compareModelDesc(a.id, b.id));
}

// Заголовки и адрес бэкенда берём из authored tree в момент вызова, а не на загрузке:
// модуль грузит `iva login` на инсталле, где каталога agent/ может не быть, а список моделей
// спрашивают только мастера /model и setup — то есть на полном инсталле.
export async function listCodexModelCatalog({
  dataDir = defaultDir(),
  fetchFn = fetch,
  authHeadersFn,
}: CodexModelCatalogOptions = {}): Promise<CodexModelCatalogEntry[]> {
  const { CLIENT_VERSION, CODEX_BASE_URL, codexAuthHeaders } =
    await import("#lib/codex-auth.ts");
  const headers = await (authHeadersFn ?? codexAuthHeaders)(dataDir);
  const res = await fetchFn(
    `${CODEX_BASE_URL}/models?client_version=${CLIENT_VERSION}`,
    {
      headers,
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok)
    throw new Error(
      `list models failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  const json: unknown = await res.json();
  const catalog = parseCodexModelCatalog(json);
  if (!catalog.length)
    throw new Error(
      `models endpoint returned no usable models — raw: ${JSON.stringify(json).slice(0, 500)}`,
    );
  return catalog;
}

export async function listCodexModels(
  opts: CodexModelCatalogOptions = {},
): Promise<string[]> {
  return (await listCodexModelCatalog(opts)).map((entry) => entry.id);
}

// «Новые сверху»: сравниваем числовую версию в slug (gpt-5.1 → 5.1), при равенстве — по имени.
function compareModelDesc(a: string, b: string): number {
  const ver = (s: string): number =>
    parseFloat((String(s).match(/(\d+(?:\.\d+)?)/) || [])[1] || "0");
  return ver(b) - ver(a) || String(a).localeCompare(String(b));
}

// ── self-check (node scripts/lib/codex-oauth.ts) — без сети ────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (c: unknown, m: string): void => {
    if (!c) throw new Error(`self-check FAIL: ${m}`);
  };
  // PKCE: challenge = base64url(sha256(verifier))
  const { verifier, challenge } = pkce();
  assert(
    challenge === b64url(createHash("sha256").update(verifier).digest()),
    "pkce S256",
  );
  assert(!/[+/=]/.test(challenge), "challenge is base64url");
  // JWT parse: собираем фейковый id_token с клеймом auth
  const header = b64url(JSON.stringify({ alg: "none" }));
  const payload = b64url(
    JSON.stringify({
      exp: 9999999999,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc_1",
        chatgpt_plan_type: "pro",
      },
    }),
  );
  const jwt = `${header}.${payload}.sig`;
  assert(accountFromIdToken(jwt).accountId === "acc_1", "accountId");
  assert(accountFromIdToken(jwt).planType === "pro", "planType");
  assert(
    accountFromIdToken("garbage").accountId === null,
    "bad id_token → null",
  );
  // Разбор списка моделей: model/slug/id/name, сортировка и защита от metadata id.
  const parsed = parseCodexModelCatalog({
    result: {
      items: [
        { model: "gpt-5" },
        { slug: "gpt-5.1" },
        { id: "preset-x" },
        { name: "gpt-6" },
      ],
    },
    tiers: [{ id: "flex" }],
  });
  assert(parsed[0].id === "gpt-6", `newest first, got ${parsed[0]?.id}`);
  assert(
    parsed.some((entry) => entry.id === "gpt-5"),
    "keeps gpt-5",
  );
  assert(
    !parsed.some((entry) => entry.id === "flex"),
    "ignores non-model metadata arrays",
  );
  assert(
    tr("ru", "en", "ру") === "ру" && tr("en", "en", "ру") === "en",
    "tr lang",
  );
  console.log("codex-oauth self-check ok");
}
