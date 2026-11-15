import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freePort,
  prepareApp,
  runNode,
  startEve,
  stopEve,
  waitForHealth,
  type EveProcess,
} from "./lib/eve-app.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
import { envFor, post } from "./fixtures/restart-app.ts";

// Жалоба 25.10 «Стоп не останавливает ход»: исходная последовательность на настоящем
// процессе eve — ход идёт (запрос к модели в полёте), «стоп» уходит тем же проводом, что
// и на бою (POST на cancel-роут канала с парой sessionId/turnId из записи хода). Исход
// проверяется на провайдере: если ход не остановился, запрос к модели дожил бы до ответа.
const MARK_A = "STOP_MARK_A";
const MARK_B = "STOP_MARK_B";

function completion(text: string): string {
  const chunk = (content: string, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-stop",
      object: "chat.completion.chunk",
      created: 1,
      model: "iva-stop",
      choices: [
        {
          index: 0,
          delta: content ? { content } : {},
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  return `${chunk(text, null)}${chunk("", "stop")}data: [DONE]\n\n`;
}

// Провайдер замирает на первом запросе с каждым взведённым маркером: маркер остаётся
// в истории сессии после отмены, поэтому без разрядки он вешал бы и следующий ход.
// Считает запросы и два факта по заблокированным: сколько уехало в полёт (blocked)
// и сколько клиент оборвал (aborted — сигнал отмены дошёл до транспорта).
async function startBlockingProvider(marks: string[]): Promise<{
  baseUrl: string;
  waitRequests(n: number): Promise<void>;
  waitBlocked(n: number): Promise<void>;
  waitAborted(n: number): Promise<void>;
  alive: () => boolean;
  close(): Promise<void>;
}> {
  const armed = new Set(marks);
  let requests = 0;
  let blocked = 0;
  let aborted = 0;
  const watchers: Array<() => void> = [];
  const bump = () => {
    for (const wake of watchers.splice(0)) wake();
  };
  const waitFor = (at: () => number, n: number) =>
    new Promise<void>((resolve) => {
      if (at() >= n) return resolve();
      watchers.push(function check() {
        if (at() >= n) return resolve();
        watchers.push(check);
      });
    });
  let blockedSocket: Socket | null = null;
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      requests++;
      bump();
      const mark = marks.find((m) => armed.has(m) && body.includes(m));
      if (mark !== undefined) {
        armed.delete(mark);
        blockedSocket = request.socket;
        blockedSocket.on("close", () => {
          aborted++;
          bump();
        });
        blocked++;
        bump();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completion("RECOVERED"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    waitRequests: (n) => waitFor(() => requests, n),
    waitBlocked: (n) => waitFor(() => blocked, n),
    waitAborted: (n) => waitFor(() => aborted, n),
    alive: () => blockedSocket !== null && !blockedSocket.destroyed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Запись хода канала restart-hang (COMPACT_STEP1_MATRIX=1): то, что мост читает для
// пары sessionId/turnId перед POST отмены, — и её переход в idle после терминала хода,
// после которого очередь моста вообще доставляет следующее сообщение.
async function waitForRunStatus<T>(
  dir: string,
  pick: (record: {
    sessionId?: unknown;
    turnId?: unknown;
    status?: unknown;
  }) => T | null,
): Promise<T> {
  const statusDir = join(dir, "run-status.d");
  const deadline = Date.now() + 30_000;
  let lastSeen: unknown = null;
  for (;;) {
    for (const name of await readdir(statusDir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(
        await readFile(join(statusDir, name), "utf8"),
      ) as { sessionId?: unknown; turnId?: unknown; status?: unknown };
      lastSeen = record;
      const hit = pick(record);
      if (hit) return hit;
    }
    if (Date.now() >= deadline)
      assert.fail(
        `run-status record did not reach the wanted state in 30s; last seen: ${JSON.stringify(lastSeen)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const waitForRunningTurn = (dir: string) =>
  waitForRunStatus(dir, (record) =>
    typeof record.sessionId === "string" && typeof record.turnId === "string"
      ? { sessionId: record.sessionId, turnId: record.turnId }
      : null,
  );

const waitForIdle = (dir: string) =>
  waitForRunStatus(dir, (record) =>
    record.status === "idle" && record.turnId === undefined
      ? { status: "idle" }
      : null,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const inTime = <T>(what: string, promise: Promise<T>, ms = 60_000) =>
  Promise.race([
    promise,
    sleep(ms).then(() => assert.fail(`${what} did not happen in ${ms}ms`)),
  ]);

void test(
  "«стоп» посреди хода обрывает запрос к модели; «стоп» с чужой парой — нет",
  { timeout: 240_000 },
  async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "iva-stop-mid-turn-"));
    const provider = await startBlockingProvider([MARK_A, MARK_B]);
    let eve: EveProcess | null = null;
    t.after(async () => {
      await stopEve(eve);
      await provider.close();
      await rm(sandbox, { recursive: true, force: true });
    });

    const app = await prepareApp(sandbox);
    await cp(
      join(ROOT, "scripts/fixtures/restart-hang-channel.ts"),
      join(app, "agent/channels/restart-hang.ts"),
    );
    const port = await freePort();
    const bearer = randomBytes(24).toString("hex");
    const env = {
      ...envFor(sandbox, app, port, provider.baseUrl, bearer),
      COMPACT_STEP1_MATRIX: "1",
    };
    await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, {
      mode: 0o600,
    });
    await runNode([join(app, "scripts/init-vault.mjs")], app, env, () => {});
    await runNode(
      [join(app, "node_modules/eve/bin/eve.js"), "build"],
      app,
      env,
      () => {},
    );

    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

    const dumpSession = async (sessionId: string) => {
      const events = await readFile(
        join(app, "data/restart-hang-events.jsonl"),
        "utf8",
      ).catch(() => "(none)");
      console.error(`events: ${events.trimEnd().replace(/\n/g, " | ")}`);
      const stream = await fetch(
        `http://127.0.0.1:${port}/eve/v1/session/${sessionId}/stream`,
        { headers: { authorization: `Bearer ${bearer}` } },
      );
      const reader = stream.body?.getReader();
      const chunks: string[] = [];
      const until = Date.now() + 5_000;
      while (reader && Date.now() < until) {
        const part = await Promise.race([
          reader.read(),
          sleep(500).then(() => null),
        ]);
        if (!part || part.done) break;
        chunks.push(new TextDecoder().decode(part.value));
      }
      await reader?.cancel().catch(() => {});
      console.error(`session stream:\n${chunks.join("")}`);
    };

    const scenario = async () => {
      // ── Исходная последовательность: ход идёт, «стоп» — ход останавливается ──
      const first = await post(port, bearer, "/restart-hang/send", {
        address: "1::",
        message: MARK_A,
      });
      assert.equal(first.status, 200);
      const { sessionId } = (await first.json()) as { sessionId: string };
      await inTime("model request in flight", provider.waitBlocked(1));
      t.diagnostic("turn A blocked mid-model-call");
      const running = await waitForRunningTurn(join(app, "data"));
      assert.equal(running.sessionId, sessionId);
      t.diagnostic(`run-status ${JSON.stringify(running)}`);

      // Провод настоящего моста: requestTurnCancel шлёт sessionId + turnId из записи
      // секретом вебхука; cancelEveTurn добавляет tasks: true внутри роута.
      const cancel = await post(port, bearer, "/eve/v1/telegram/cancel", {
        sessionId: running.sessionId,
        turnId: running.turnId,
      });
      assert.equal(cancel.status, 200);
      const accepted = (await cancel.json()) as { status?: unknown };
      assert.equal(accepted.status, "accepted");

      // «Стоп не останавливает ход» не воспроизводится: запрос к модели оборван —
      // работа прекратилась, а не доехала до ответа фоном.
      await inTime("model call aborted", provider.waitAborted(1));
      assert.equal(provider.alive(), false);
      t.diagnostic("model call aborted by cancel");

      // Ход доехал до терминала: запись вернулась в idle — именно здесь очередь моста
      // начинает доставку следующего сообщения.
      await waitForIdle(join(app, "data"));
      t.diagnostic("run-status back to idle (turn.completed fired)");
      await sleep(3_000); // workflow уходит на парковку ожидания следующей доставки

      // Чат не завис: следующее сообщение — новый ход, провайдер отвечает. Провод —
      // штатный роут сессии eve (session.send, тот же dispatch, что и у webhook-доставки
      // моста): ход после отмены должен уйти к модели и ответить.
      const next = await post(
        port,
        bearer,
        `/eve/v1/session/${sessionId}`,
        { message: "after stop" },
      );
      assert.equal(next.status, 202);
      try {
        await inTime("next turn's model request", provider.waitRequests(2));
      } catch (error) {
        await dumpSession(sessionId);
        throw error;
      }
      t.diagnostic("turn after stop reached the provider");
      const replyFile = join(app, "data/restart-hang-replies.jsonl");
      const replyDeadline = Date.now() + 30_000;
      for (;;) {
        const lines = await readFile(replyFile, "utf8").catch(() => "");
        if (lines.includes("RECOVERED")) break;
        if (Date.now() >= replyDeadline)
          assert.fail("the turn after the stop did not complete");
        await sleep(100);
      }
      t.diagnostic("turn after stop completed");

      // ── Отделение от «стопа по устаревшей паре»: молчаливый no-op по дизайну ──
      const second = await post(port, bearer, `/eve/v1/session/${sessionId}`, {
        message: MARK_B,
      });
      assert.equal(second.status, 202);
      await inTime("turn B blocked mid-model-call", provider.waitBlocked(2));
      t.diagnostic("turn B blocked mid-model-call");

      // Тот же провод, но пара turnId чужая (устаревший черновик/запись): команда
      // принята, а живой ход не тронут — запрос к модели ещё висит.
      const stale = await post(port, bearer, "/eve/v1/telegram/cancel", {
        sessionId,
        turnId: "turn-stale",
      });
      assert.equal(stale.status, 200);
      assert.equal(
        ((await stale.json()) as { status?: unknown }).status,
        "accepted",
      );
      await sleep(2_000);
      assert.equal(
        provider.alive(),
        true,
        "стоп по чужой паре не должен обрывать живой ход",
      );
      t.diagnostic("stale-turnId cancel was a no-op");

      // Правильный «стоп» тем же проводом ход всё-таки снимает.
      const proper = await post(port, bearer, "/eve/v1/telegram/cancel", {
        sessionId,
      });
      assert.equal(proper.status, 200);
      assert.equal(
        ((await proper.json()) as { status?: unknown }).status,
        "accepted",
      );
      await inTime("turn B aborted", provider.waitAborted(2));
      t.diagnostic("turn B aborted by cancel");
    };
    await scenario();
  },
);
