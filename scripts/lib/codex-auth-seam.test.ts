/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The Codex subscription is signed in by scripts/lib/codex-oauth.ts (`iva login` and the setup
// wizard, which both have to run on an install whose agent/ is missing) and used by
// agent/lib/codex-auth.ts (the agent refreshing the token before every model call). Neither
// half may import the other at load time; what they share — the OAuth constants, the token
// file path, its read, its atomic 0600 write and the id_token claim reader — is one module,
// packages/codex-auth. This test holds the two halves together on the wire: it signs in
// through the login half, reads the result back through the runtime half, checks the traffic
// against the shared constants, and watches the file system while each half writes the secret.
// What the runtime half does with the file afterwards (the refresh window, the refresh itself,
// its in-flight dedup and the re-read fallback) is `agent/lib/codex-auth.test.ts`.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  authFilePath as authoredAuthFilePath,
  type CodexAuth,
  codexAuthHeaders,
  readAuth as authoredReadAuth,
  writeAuth,
} from "#lib/codex-auth.ts";
import {
  CLIENT_ID,
  ISSUER,
  parseJwt,
  toAuth,
  TOKEN_URL,
} from "../../packages/codex-auth/index.ts";
import { authFilePath, readAuth, runDeviceCodeLogin } from "./codex-oauth.ts";

// `unknown`, not `object`: a payload that is a bare JSON string or number is exactly the
// shape both copies of parseJwt() have to survive identically.
const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const jwt = (payload: unknown): string =>
  [b64url({ alg: "none" }), b64url(payload), "signature"].join(".");

/** An id_token carrying the account claim, valid far past any refresh skew. */
const idToken = (): string =>
  jwt({
    exp: 9_999_999_999,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_seam",
      chatgpt_plan_type: "pro",
    },
  });

type TokenResponse = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
};

/** What the fake OpenAI hands back — recomputable, so the pin can rebuild it verbatim. */
const loginTokens = (): TokenResponse => ({
  id_token: idToken(),
  access_token: idToken(),
  refresh_token: "refresh-1",
});

function scratchDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-codex-seam-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type CapturedRequest = { url: string; body: string };

/**
 * Drives the device-code flow against a fake OpenAI, so nothing leaves the process, and
 * hands back every request it made — that traffic is what pins the OAuth constants.
 */
async function signIn(dataDir: string): Promise<CapturedRequest[]> {
  const tokens = loginTokens();
  const requests: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "object" && "url" in input ? input.url : String(input);
    // Both flows post strings (JSON or urlencoded); anything else is not a body we pin.
    requests.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.endsWith("/deviceauth/usercode"))
      return Promise.resolve(
        Response.json({
          device_auth_id: "dev-1",
          user_code: "CODE-1",
          interval: 0,
        }),
      );
    if (url.endsWith("/deviceauth/token"))
      return Promise.resolve(
        Response.json({ authorization_code: "auth-1", code_verifier: "ver-1" }),
      );
    if (url.endsWith("/oauth/token"))
      return Promise.resolve(Response.json(tokens));
    throw new Error(`unexpected request: ${url}`);
  };
  try {
    await runDeviceCodeLogin({ dataDir, log: () => {} });
  } finally {
    globalThis.fetch = realFetch;
  }
  return requests;
}

test("a login writes the token file the runtime half reads back", async (t) => {
  const dataDir = scratchDir(t);
  await signIn(dataDir);

  const stored = authoredReadAuth(dataDir);
  assert.equal(stored?.accountId, "acc_seam");
  assert.equal(stored?.planType, "pro");
  assert.equal(stored?.refresh_token, "refresh-1");
  assert.deepEqual(stored, toAuth(loginTokens()));

  // A fresh token needs no refresh, so the headers come straight off the stored file.
  const headers = await codexAuthHeaders(dataDir);
  assert.equal(headers.Authorization, `Bearer ${stored?.access_token}`);
  assert.equal(headers["ChatGPT-Account-ID"], "acc_seam");
});

test("both halves name, read and rewrite the same token file", async (t) => {
  const dataDir = scratchDir(t);
  const path = join(dataDir, "codex-auth.json");
  assert.equal(authFilePath(dataDir), path);
  assert.equal(authoredAuthFilePath(dataDir), path);

  // No file yet: the wizard asks "already signed in?" before any login ever happened.
  assert.equal(readAuth(dataDir), null);
  assert.equal(authoredReadAuth(dataDir), null);

  await signIn(dataDir);
  const afterLogin = readFileSync(path, "utf8");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readAuth(dataDir), authoredReadAuth(dataDir));

  // The runtime half rewrites the very same file on every refresh: widen it and prove the
  // rewrite restores both the bytes and the permissions the login half established.
  chmodSync(path, 0o644);
  const parsed = authoredReadAuth(dataDir);
  assert.ok(parsed);
  writeAuth(parsed, dataDir);
  assert.equal(readFileSync(path, "utf8"), afterLogin);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // A half-written token file reads as "not signed in" on both sides — the wizard then
  // offers a login instead of announcing a configured install.
  writeFileSync(path, '{"access_token": "trunc', "utf8");
  assert.equal(readAuth(dataDir), null);
  assert.equal(authoredReadAuth(dataDir), null);
});

// ── the secret on the wire ────────────────────────────────────────────────────
// What the file system sees while a half stores the token. The secret is written to a
// sibling temp file that is 0600 from the moment it exists — whatever the umask — and
// complete before it is renamed over the token file; the token file itself is never opened
// for writing, so a concurrent reader meets the old login or the new one and nothing between.

type Rename = {
  from: string;
  to: string;
  mode: number;
  staged: unknown;
  before: string | null;
};

/** Runs `write` with umask 0 and records every write and rename under `dataDir`. */
async function watchTokenWrites(
  dataDir: string,
  write: () => Promise<unknown>,
): Promise<{ written: string[]; renames: Rename[] }> {
  const written: string[] = [];
  const renames: Rename[] = [];
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const readOrNull = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  mock.method(fs, "writeFileSync", ((path, ...rest) => {
    if (typeof path === "string" && path.startsWith(dataDir))
      written.push(path);
    return realWrite(path, ...rest);
  }) as typeof fs.writeFileSync);
  mock.method(fs, "renameSync", ((from, to) => {
    renames.push({
      from: String(from),
      to: String(to),
      mode: statSync(from).mode & 0o777,
      staged: JSON.parse(readFileSync(from, "utf8")),
      before: readOrNull(String(to)),
    });
    return realRename(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
  const umask = process.umask(0);
  try {
    await write();
  } finally {
    process.umask(umask);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  return { written, renames };
}

function assertAtomicSecretWrite(
  dataDir: string,
  seen: { written: string[]; renames: Rename[] },
  before: string | null,
): void {
  const path = join(dataDir, "codex-auth.json");
  assert.equal(seen.renames.length, 1, "one rename per stored login");
  const [rename] = seen.renames;
  assert.equal(rename.to, path);
  assert.equal(
    dirname(rename.from),
    dataDir,
    "temp file sits beside the token",
  );
  assert.deepEqual(
    seen.written,
    [rename.from],
    "the secret is written to the temp file only, never to the token file",
  );
  assert.equal(rename.mode, 0o600, "temp file is 0600 under umask 0");
  assert.equal(
    rename.before,
    before,
    "the token file is whole until the rename",
  );
  assert.deepEqual(rename.staged, authoredReadAuth(dataDir));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dataDir), ["codex-auth.json"]);
}

test("the login half stores the secret atomically and 0600", async (t) => {
  const dataDir = scratchDir(t);
  const seen = await watchTokenWrites(dataDir, () => signIn(dataDir));
  assertAtomicSecretWrite(dataDir, seen, null);
});

test("the runtime half refreshes the secret atomically and 0600", async (t) => {
  const dataDir = scratchDir(t);
  await signIn(dataDir);
  // An expired access_token makes the next request refresh and rewrite the file.
  const expired: CodexAuth = {
    ...toAuth(loginTokens()),
    access_token: jwt({ exp: 1 }),
  };
  writeAuth(expired, dataDir);
  const path = join(dataDir, "codex-auth.json");
  chmodSync(path, 0o644);
  const before = readFileSync(path, "utf8");
  const refreshed = jwt({ exp: 9_999_999_999, label: "refreshed" });
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (input: RequestInfo | URL) => {
    assert.equal(input, TOKEN_URL);
    return Promise.resolve(Response.json({ access_token: refreshed }));
  };

  const seen = await watchTokenWrites(dataDir, () => codexAuthHeaders(dataDir));
  assertAtomicSecretWrite(dataDir, seen, before);
  assert.equal(authoredReadAuth(dataDir)?.access_token, refreshed);
});

test("the login half signs in with the constants the runtime half refreshes against", async (t) => {
  const requests = await signIn(scratchDir(t));
  const requestTo = (suffix: string): CapturedRequest => {
    const found = requests.find((request) => request.url.endsWith(suffix));
    assert.ok(found, `no request to ${suffix}`);
    return found;
  };
  const usercode = requestTo("/deviceauth/usercode");
  assert.equal(usercode.url, `${ISSUER}/api/accounts/deviceauth/usercode`);
  assert.equal(
    (JSON.parse(usercode.body) as { client_id: string }).client_id,
    CLIENT_ID,
  );
  const exchange = requestTo("/oauth/token");
  assert.equal(exchange.url, TOKEN_URL);
  assert.equal(new URLSearchParams(exchange.body).get("client_id"), CLIENT_ID);
});

// ── what a token response becomes on disk ─────────────────────────────────────
// One function builds the stored login for both the first sign-in and the hourly refresh;
// a silent change here breaks one of them, and nobody notices until the token expires.

interface AuthCase {
  name: string;
  tokens: TokenResponse;
  prev?: Partial<CodexAuth>;
  stored: CodexAuth;
}

const STORED: Partial<CodexAuth> = {
  id_token: idToken(),
  refresh_token: "refresh-old",
  accountId: "acc_seam",
  planType: "pro",
};

const claimToken = (auth: unknown): string =>
  jwt({ exp: 9_999_999_999, "https://api.openai.com/auth": auth });

const ROTATED = claimToken({
  chatgpt_account_id: "acc_next",
  chatgpt_plan_type: "team",
});
const CLAIMLESS = jwt({ exp: 9_999_999_999 });
const WRONG_TYPES = claimToken({
  chatgpt_account_id: 42,
  chatgpt_plan_type: "",
});

/** The stored login after a refresh that changed nothing but the access_token. */
const kept = (accessToken: string, idTokenNow = idToken()): CodexAuth => ({
  id_token: idTokenNow,
  access_token: accessToken,
  refresh_token: "refresh-old",
  accountId: "acc_seam",
  planType: "pro",
});

const AUTH_FIXTURES: AuthCase[] = [
  {
    name: "fresh login: everything comes off the wire",
    tokens: {
      id_token: idToken(),
      access_token: "at-1",
      refresh_token: "rt-1",
    },
    stored: { ...kept("at-1"), refresh_token: "rt-1" },
  },
  {
    // The hourly refresh: the endpoint answers with one field and the rest has to survive.
    name: "refresh: only access_token, the file carries the rest",
    tokens: { access_token: "at-2" },
    prev: STORED,
    stored: kept("at-2"),
  },
  {
    // The endpoint may answer without a token at all. The stored one has to survive: the
    // login half writes the file of the very same shape the refresh writes back.
    name: "an answer without access_token keeps the stored one",
    tokens: { access_token: "" },
    prev: { ...STORED, access_token: "at-stored" },
    stored: kept("at-stored"),
  },
  {
    name: "refresh: the response rotates id_token and refresh_token",
    tokens: { id_token: ROTATED, access_token: "at-3", refresh_token: "rt-3" },
    prev: STORED,
    stored: {
      id_token: ROTATED,
      access_token: "at-3",
      refresh_token: "rt-3",
      accountId: "acc_next",
      planType: "team",
    },
  },
  {
    // A new id_token without the claim keeps the stored account: ChatGPT-Account-ID is how
    // the subscription backend knows the account, and one silent claim-less answer must not
    // strip it until the next login (blind QA v3). A token that names an account still wins.
    name: "refresh: a claimless id_token keeps the stored account",
    tokens: { id_token: CLAIMLESS, access_token: "at-4" },
    prev: STORED,
    stored: kept("at-4", CLAIMLESS),
  },
  {
    name: "refresh: an unparsable id_token keeps the stored account",
    tokens: { id_token: "garbage", access_token: "at-5" },
    prev: STORED,
    stored: kept("at-5", "garbage"),
  },
  {
    // Non-string claims are the shape a provider change would arrive in: they read as "no
    // account" rather than a number stringified into a header, and the account on disk stays.
    name: "claims of the wrong type keep the stored account",
    tokens: { id_token: WRONG_TYPES, access_token: "at-6" },
    prev: STORED,
    stored: kept("at-6", WRONG_TYPES),
  },
  {
    name: "an empty id_token is no id_token: the stored account stays",
    tokens: { id_token: "", access_token: "at-7" },
    prev: STORED,
    stored: kept("at-7"),
  },
  {
    name: "nothing stored and nothing but an access_token returned",
    tokens: { access_token: "at-8" },
    stored: {
      id_token: undefined,
      access_token: "at-8",
      refresh_token: undefined,
      accountId: null,
      planType: null,
    },
  },
  {
    name: "an empty refresh_token does not overwrite the stored one",
    tokens: { access_token: "at-9", refresh_token: "" },
    prev: STORED,
    stored: kept("at-9"),
  },
];

for (const { name, tokens, prev, stored } of AUTH_FIXTURES)
  test(`toAuth: ${name}`, () => {
    assert.deepEqual(toAuth(tokens, prev), stored);
  });

test("parseJwt reads the payload segment and throws on anything else", () => {
  assert.deepEqual(parseJwt(idToken()), {
    exp: 9_999_999_999,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_seam",
      chatgpt_plan_type: "pro",
    },
  });
  assert.equal(parseJwt(jwt("строка")), "строка");
  assert.deepEqual(parseJwt(`a.${b64url({ exp: 1 })}`), { exp: 1 });
  assert.deepEqual(parseJwt(`a.${b64url({ exp: 1 })}.c.d`), { exp: 1 });
  for (const token of ["", "garbage", ".", "..", "a..c"])
    assert.throws(() => parseJwt(token), /malformed JWT/u, token);
  for (const token of ["a.b.c", "a.%%%.c"])
    assert.throws(() => parseJwt(token), SyntaxError, token);
});
