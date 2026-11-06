// Вход по подписке OpenAI (ChatGPT Plus/Pro/Team) — как в официальном codex CLI: device-code
// и browser-PKCE потоки, которые СОЗДАЮТ data/codex-auth.json, плюс каталог моделей подписки
// для мастеров /model и setup. Остаётся в scripts/, потому что `iva login` обязан работать на
// инсталле без авторского дерева — см. docs/tech-debt.md.
//
// Вторая половина шва — agent/lib/codex-auth.ts: рефреш токена и заголовки запроса, то есть
// всё, что нужно самому агенту в рантайме. Импортировать её отсюда на этапе загрузки нельзя
// (её тут может не быть — мастер setup грузится и на инсталле без agent/), поэтому
// протокольные константы, путь к файлу токена, его чтение, атомарная запись и разбор
// id_token повторены здесь самодостаточно; расхождение ловит
// scripts/lib/codex-auth-seam.test.ts. Каталог моделей нужен только на полном инсталле, и его
// половину заголовков подтягивает ленивый импорт внутри самого вызова.
// Чистый ESM, только node-builtins (crypto/fs/http/child_process).
//
// Протокол (reverse-engineered из openai/codex, публичный client_id):
//   auth-домен  https://auth.openai.com     device-code + browser-PKCE
//   API-домен   https://chatgpt.com/backend-api/codex   /models
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { CodexAuth } from "#lib/codex-auth.ts";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.ts";
import { resolveDataDir } from "./data-dir.ts";

export type { CodexAuth };

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
type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
};
type LoginPort = { server: Server; port: number };

// Протокольные константы OAuth, повторённые из agent/lib/codex-auth.ts (см. шапку). Экспорт —
// ради шва: scripts/lib/codex-auth-seam.test.ts сверяет обе копии, иначе ротация client_id на
// одной стороне оставила бы сьют зелёным и сломала вход или почасовой рефреш.
export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // публичный client_id Codex CLI
export const TOKEN_URL = `${ISSUER}/oauth/token`;
const SCOPE = "openid profile email offline_access";
export const ORIGINATOR = "codex_cli_rs";
const DEVICE_PORT = 1455; // codex-совместимый redirect-порт (fallback 1457)
const FALLBACK_PORT = 1457;

const b64url = (buf: string | Buffer) => Buffer.from(buf).toString("base64url");
const defaultDir = () => resolveDataDir(process.cwd());
const MODELS_FETCH_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 30_000;
// Язык подсказок входа (en по умолчанию — как у codex CLI). Мастер/CLI прокидывают lang.
const tr = (lang: string, en: string, ru: string) => (lang === "ru" ? ru : en);

// ── файл токена (копия из agent/lib/codex-auth.ts: агент читает и перезаписывает тот же файл) ──
export function authFilePath(dataDir = defaultDir()): string {
  return join(dataDir, "codex-auth.json");
}

// Мастер setup спрашивает «вход уже есть?» и печатает план подписки, а запускают его в том
// числе install.sh и `iva config` — на инсталле, где авторского дерева может не быть. Битый
// файл читается как «входа нет»: перелогиниться мастер и так предложит.
export function readAuth(dataDir = defaultDir()): CodexAuth | null {
  try {
    return JSON.parse(readFileSync(authFilePath(dataDir), "utf8")) as CodexAuth;
  } catch {
    return null;
  }
}

// Атомарная запись 0600 (temp + rename) — секрет не должен мелькнуть с широкими правами,
// а конкурентный read не должен поймать полу-записанный файл.
function writeAuth(auth: CodexAuth, dataDir: string): void {
  const file = authFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// parseJwt и toAuth ниже экспортируются ради шва — их точные копии живут в
// agent/lib/codex-auth.ts, а scripts/lib/codex-auth-seam.test.ts гоняет обе на общих
// фикстурах: разъехавшийся разбор клеймов или сборка объекта хранилища ломают либо вход,
// либо почасовой рефреш, и молча.
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
