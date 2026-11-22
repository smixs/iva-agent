/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the fetch double keeps the async boundary. */
// Шов /compact: команда моста зовёт роут канала POST /eve/v1/telegram/compact, роут
// разрешает сессию и ставит ей пометку свёртки штатным POST eve
// /eve/v1/session/:id/compact под общим токеном. Саму свёртку делает eve перед следующим
// шагом модели — канал чат под неё не занимает и историю не трогает. Двойник стоит только
// на внешних границах: Bot API, роут и сессия eve; запись чата — настоящий файл.
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { Session } from "eve/channels";

const dataDir = mkdtempSync(join(tmpdir(), "iva-compact-route-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "12345:compact-test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "compact-test-secret";
process.env.TELEGRAM_BOT_USERNAME = "my_bot";
process.env.ASSISTANT_BEARER = "compact-test-bearer";
delete process.env.ASSISTANT_HOST;
delete process.env.IVA_PORT;
after(() => rmSync(dataDir, { recursive: true, force: true }));

// Сессия eve, которую роут разрешит по адресу чата.
let resolvedSessionId: string | null = "session-1";
// Что отвечает eve на POST compact: приняла (202), сессии нет (200), отказала (4xx), сбой (5xx).
let compactStatus: "accepted" | "no_active_session" | "refused" | "broken" =
  "accepted";
const compactCalls: { sessionId: string; auth: string | null }[] = [];

const COMPACT_URL =
  /^http:\/\/127\.0\.0\.1:8723\/eve\/v1\/session\/([^/]+)\/compact$/u;
globalThis.fetch = async (url, init = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the double reads whatever the caller passes.
  const href = String(url);
  const compact = COMPACT_URL.exec(href);
  if (compact) {
    compactCalls.push({
      sessionId: decodeURIComponent(compact[1] ?? ""),
      auth: new Headers(init.headers).get("authorization"),
    });
    if (compactStatus === "refused")
      return new Response("unauthorized", { status: 401 });
    if (compactStatus === "broken")
      return new Response("dispatcher failed", { status: 500 });
    return compactStatus === "accepted"
      ? Response.json(
          { ok: true, sessionId: compact[1], status: "accepted" },
          { status: 202 },
        )
      : Response.json({ ok: true, status: "no_active_session" });
  }
  return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1 } } });
};

const channelModule = "../agent/channels/telegram.ts?compact-test";
const [{ default: channel }, { TELEGRAM_COMPACT_ROUTE }, runStatus] =
  await Promise.all([
    import(channelModule) as Promise<
      typeof import("../agent/channels/telegram.ts")
    >,
    import("../agent/lib/telegram-compact-route.ts"),
    import("../agent/lib/run-status.ts"),
  ]);
const route = (path: string) => {
  const found = channel.routes.find((candidate) => candidate.path === path);
  if (!found || found.transport === "websocket")
    throw new Error(`Telegram channel did not expose ${path}`);
  return found;
};
const compactRoute = route(TELEGRAM_COMPACT_ROUTE);
const unused = () => {
  throw new Error("not used by this path");
};

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const compactRequest = (body: unknown, secret = SECRET) =>
  compactRoute.handler(
    new Request(`http://127.0.0.1:8723${TELEGRAM_COMPACT_ROUTE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      attachSession: (id) => ({ id }) as Session,
      resolveSession: async () =>
        resolvedSessionId ? ({ id: resolvedSessionId } as Session) : undefined,
      from: unused,
      to: unused,
      params: {},
      waitUntil: unused,
      requestIp: "127.0.0.1",
    },
  );

const target = { address: { chatId: "977" } };

beforeEach(() => {
  compactCalls.length = 0;
  resolvedSessionId = "session-1";
  compactStatus = "accepted";
});

test("/compact ставит сессии пометку POST-ом к eve с общим токеном и отвечает о следующем ответе", async () => {
  const response = await compactRequest({ chatKey: "977:", target });
  const body = (await response.json()) as { text: string };
  assert.deepEqual(compactCalls, [
    { sessionId: "session-1", auth: "Bearer compact-test-bearer" },
  ]);
  assert.match(body.text, /compress/i);
});

test("/compact без секрета и с неверным телом отвергается до разрешения сессии", async () => {
  assert.equal(
    (await compactRequest({ chatKey: "977:", target }, "wrong-secret")).status,
    401,
  );
  assert.equal(compactCalls.length, 0);
  assert.equal((await compactRequest({ chatKey: "not-a-key" })).status, 400);
  assert.equal(compactCalls.length, 0);
});

test("property: произвольный неверный ключ отвергается до POST к eve", () => {
  fc.assert(
    fc.asyncProperty(
      fc.string().filter((key) => !/^-?\d+:\d*$/u.test(key)),
      async (key) => {
        const response = await compactRequest({ chatKey: key, target });
        assert.equal(response.status, 400);
      },
    ),
  );
});

test("/compact после /new (отметка resetAt в записи чата): пометки нет", async () => {
  runStatus.setChatStatus("977:", { resetAt: Date.now() });
  const response = await compactRequest({ chatKey: "977:", target });
  const body = (await response.json()) as { text: string };
  assert.equal(compactCalls.length, 0);
  assert.match(body.text, /nothing to compress/i);
  runStatus.setChatStatus("977:", { resetAt: null });
});

test("/compact без живой сессии: пометки нет", async () => {
  resolvedSessionId = null;
  const response = await compactRequest({ chatKey: "977:", target });
  const body = (await response.json()) as { text: string };
  assert.equal(compactCalls.length, 0);
  assert.match(body.text, /nothing to compress/i);
});

test("/compact: eve сессию не нашла или отказала — владелец слышит «не подтверждено»", async () => {
  for (const status of ["no_active_session", "refused", "broken"] as const) {
    compactStatus = status;
    const response = await compactRequest({ chatKey: "977:", target });
    const body = (await response.json()) as { text: string };
    assert.match(body.text, /couldn't be confirmed/i, status);
  }
});
