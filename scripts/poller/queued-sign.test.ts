// Знак очереди (лоадер под сообщением, которое ждёт за живым ходом) живёт в записи чата полями
// queued*. Bridge переводит запись в idle без хода-наследника в трёх местах: жнец протухшего
// хода, /new и сорвавшаяся прямая доставка. Везде знак уходит из чата и из записи
// (specs/IdleCompaction.tla, SignOwned).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Записи чата пишутся в настоящий run-status: каталог данных — временный, до импорта.
const dataDir = mkdtempSync(join(tmpdir(), "iva-queued-sign-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
const queue = await import("./queue.ts");

const SIGN = {
  queuedIngressId: "ingress-Q",
  queuedIngressAt: 1_000,
  queuedSessionId: "session-1",
};
const SIGN_FIELDS = Object.keys(SIGN);

const clearsSign = (patch: Record<string, unknown>) =>
  SIGN_FIELDS.every((field) => patch[field] === null);

void test("the reaper deletes the queued sign of the stale record it closes", async () => {
  const now = 2_000_000;
  let written: Record<string, unknown> = {};
  const reaped = await queue.reapStaleRuns({
    listStatusesImpl: () => [
      {
        chatKey: "1:",
        status: {
          status: "running",
          generation: 7,
          updatedAt: now - 31_000,
          sessionId: "session-1",
          statusMessageId: 77,
          ...SIGN,
        },
      },
    ],
    setStatusIfImpl: (_key, _expected, patch) => {
      written = patch;
      return { status: "idle" };
    },
    resetImpl: () => Promise.resolve(),
    sendImpl: () => Promise.resolve(),
    now: () => now,
    inFlight: new Map(),
    staleMs: 30_000,
    trImpl: (_en, ru) => ru,
    logImpl: () => {},
  });

  assert.equal(reaped, 1);
  assert.ok(clearsSign(written), JSON.stringify(written));
});

void test("/new deletes the queued sign together with the status message", async () => {
  const chatKey = "sign-reset:";
  const { setChatStatus, getChatStatus } = await import("#lib/run-status.ts");
  setChatStatus(chatKey, {
    status: "running",
    sessionId: "session-1",
    statusMessageId: 77,
    ...SIGN,
  });

  await queue.completeScopedResetState(chatKey, {});
  const after: Record<string, unknown> | null = getChatStatus(chatKey);
  assert.equal(after?.status, "idle");
  for (const field of SIGN_FIELDS)
    assert.equal(after?.[field], undefined, field);
});

void test("a failed direct delivery clears its early record and the queued sign on it", async () => {
  let written: Record<string, unknown> = {};
  const startedAt = 5_000;
  const cleared = await queue.clearFailedDirectIngress("1:", {
    baselineGeneration: 1,
    startedAt,
    statusImpl: () => ({
      status: "running",
      generation: 3,
      updatedAt: startedAt + 10,
      ingressId: "ingress-M",
      ingressAt: startedAt + 5,
      statusMessageId: 40,
      ...SIGN,
    }),
    setStatusIfImpl: (_key, _expected, patch) => {
      written = patch;
      return { status: "idle" };
    },
    now: () => startedAt + 20,
  });

  assert.equal(cleared, true);
  assert.ok(clearsSign(written), JSON.stringify(written));
});
