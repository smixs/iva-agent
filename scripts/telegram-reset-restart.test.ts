/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; the reset stand keeps asynchronous production boundaries. */
// Порядок из слепого критика (R1): запрос сброса, который агент принял от прежнего Bridge,
// переживает SIGKILL этого процесса и заканчивается позже восстановления. Восстановление
// (сверка намерения и доставка из очереди чата) уже положило сообщение 102 в новую сессию;
// поздний resolveSession отдаёт агенту эту же сессию, и сброс раньше стирал её.
// Держит specs/ResetIntent.tla, инвариант ExactCut: сообщение после отсечки остаётся.
// Агент — процесс теста (настоящий handleTelegramResetRequest маршрута), Bridge — два
// процесса-ребёнка по очереди, как в жизни: сначала убитый old, потом recovery.
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const ROOT = join(import.meta.dirname, "..");
const CHILD = join(
  import.meta.dirname,
  "fixtures/reset-bridge-restart-child.ts",
);
const SECRET = "test-secret";
const TIMEOUT_MS = 60_000;

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = SECRET;

type StoredSession = { id: string; messages: number[]; retired: boolean };

const dataDir = tempDir("iva-reset-restart-");
process.env.ASSISTANT_DATA_DIR = dataDir;

// Сессии чата: сброс выводит из строя ровно ту сессию, которую отдал resolveSession, а
// следующая доставка создаёт новую (в eve reset терминально закрывает сессию по её id).
const sessions: StoredSession[] = [];
const liveSession = (): StoredSession => {
  const last = sessions.at(-1);
  if (last === undefined || last.retired) {
    sessions.push({
      id: `session-${sessions.length + 1}`,
      messages: [],
      retired: false,
    });
  }
  return sessions.at(-1) as StoredSession;
};

const handleOf = (stored: StoredSession) =>
  ({
    id: stored.id,
    reset: async () => {
      stored.retired = true;
      stored.messages.length = 0;
      return { status: "reset" as const, previousSessionId: stored.id };
    },
  }) as Session;

// Позднее разрешение адреса у запроса прежнего Bridge: resolveSession ждёт, а владелец чата
// за это время меняется — как в живом eve (`runtime.resolveContinuation`).
let releaseLateResolve = () => {};
const lateResolve = new Promise<void>((resolve) => {
  releaseLateResolve = resolve;
});
let lateRequestAccepted = () => {};
const accepted = new Promise<void>((resolve) => {
  lateRequestAccepted = resolve;
});
let firstResolve = true;

const operations: Pick<RouteHandlerArgs, "attachSession" | "resolveSession"> = {
  attachSession: () => {
    throw new Error("the stand sends addresses, not session ids");
  },
  resolveSession: async (address: string) => {
    assert.equal(address, "42::", "the stand serves one private chat");
    if (firstResolve) {
      firstResolve = false;
      lateRequestAccepted();
      await lateResolve;
    }
    return handleOf(liveSession());
  },
};

const resetRequest = (target: unknown) =>
  handleTelegramResetRequest(
    new Request("http://iva.test/eve/v1/telegram/reset", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify(target),
    }),
    operations,
    SECRET,
  );

const bridge = (
  role: "old" | "recovery",
  onReset: (target: unknown) => void,
) => {
  const child = fork(CHILD, [ROOT, dataDir, role], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.on("message", (message: unknown) => {
    const event = message as { kind?: string; target?: unknown; id?: number };
    if (event.kind === "remote") onReset(event.target);
    if (event.kind === "delivered")
      liveSession().messages.push(event.id as number);
  });
  return child;
};

const killIfAlive = (child: ChildProcess) => {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
};

const exitCode = async (child: ChildProcess) => {
  if (child.exitCode !== null) return child.exitCode;
  const exit = (await once(child, "exit")) as [number | null];
  return exit[0];
};

test(
  "ResetIntent ExactCut: a reset accepted before the Bridge restart keeps the message delivered after the cut",
  { timeout: TIMEOUT_MS },
  async (t) => {
    let late: Promise<{ status?: string }> | undefined;
    const old = bridge("old", (target) => {
      // Запрос прежнего Bridge принят агентом и ждёт разрешения адреса.
      late = resetRequest(target).then(
        async (response) => (await response.json()) as { status?: string },
      );
    });
    t.after(() => killIfAlive(old));

    await accepted;
    old.kill("SIGKILL");
    await once(old, "exit");

    const recovery: ChildProcess = bridge("recovery", (target) => {
      void resetRequest(target).then(async (response) =>
        recovery.send((await response.json()) as Record<string, unknown>),
      );
    });
    t.after(() => killIfAlive(recovery));
    assert.equal(
      await exitCode(recovery),
      0,
      "the new Bridge finished its run",
    );

    assert.deepEqual(
      liveSession().messages.slice(),
      [102],
      "the message after the cut reached the new session before the late request ended",
    );

    releaseLateResolve();
    const lateResult = await late;
    assert.deepEqual(
      liveSession().messages,
      [102],
      "ExactCut: the late reset does not wipe the message delivered after the cut",
    );
    assert.equal(
      lateResult?.status,
      "no_active_session",
      "the late request does nothing: the chat was reset after it was accepted",
    );
  },
);
