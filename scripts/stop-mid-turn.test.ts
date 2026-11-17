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

// Жалоба 25.10 «не останавливаешься по кнопке Stop» (vault projects/iva.md:219, msg5403):
// вход Стопа прогоняется через настоящий handleControl моста — нативная ■ драфта
// (stopped_message_generation) и команда /stop. Мост читает пару sessionId/turnId из
// той же записи run-status, что и на бою, и шлёт реальный POST на cancel-роут канала
// (cancelImpl не подменяется). Факт остановки проверяется на провайдере — оборванный
// сокет запроса к модели — и по терминальному событию хода в журнале канала.
// Чего тест не проверяет: какая именно кнопка/команда была нажата 25.10 и какой
// провайдер тогда крутился на c1 — оба факта не восстановлены (см. .scratch/t93/TRACE.md).
const MARK_A = "STOP_MARK_A";
const MARK_B = "STOP_MARK_B";
const TG_SECRET = "restart-test-secret";
const CHAT = { id: 1, type: "private" };
const OWNER = { id: 1, is_bot: false };

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
// решения об отмене и для пары sessionId/turnId, — и её переход в idle после
// терминала хода, после которого очередь моста вообще доставляет следующее сообщение.
async function waitForRunStatus<T>(
  dir: string,
  pick: (record: {
    sessionId?: unknown;
    turnId?: unknown;
    draftId?: unknown;
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
      ) as {
        sessionId?: unknown;
        turnId?: unknown;
        draftId?: unknown;
        status?: unknown;
      };
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

type RunningTurn = { sessionId: string; turnId: string; draftId: number };

const waitForRunningTurn = (dir: string, excludeTurnId?: string) =>
  waitForRunStatus(dir, (record) =>
    typeof record.sessionId === "string" &&
    typeof record.turnId === "string" &&
    typeof record.draftId === "number" &&
    record.turnId !== excludeTurnId
      ? {
          sessionId: record.sessionId,
          turnId: record.turnId,
          draftId: record.draftId,
        }
      : null,
  );

const waitForIdle = (dir: string) =>
  waitForRunStatus(dir, (record) =>
    record.status === "idle" && record.turnId === undefined
      ? { status: "idle" }
      : null,
  );

type TurnEvent = { event?: unknown; turnId?: unknown; point?: unknown };

// Журнал терминальных событий хода, который ведёт канал-фикстура: turn.cancelled и
// turn.failed с turnId. Читается всегда, а не только при падении сценария, — именно
// он отличает «ход отменён» от «ход завершился/упал»: в idle запись уходит во всех
// трёх исходах.
async function readTurnEvents(dir: string): Promise<TurnEvent[]> {
  const file = join(dir, "restart-hang-events.jsonl");
  const lines = (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as TurnEvent);
}

function assertCancelledNotFailed(
  events: TurnEvent[],
  turnId: string,
): void {
  assert.ok(
    events.some((e) => e.event === "turn.cancelled" && e.turnId === turnId),
    `ожидали turn.cancelled для ${turnId}, журнал: ${JSON.stringify(events)}`,
  );
  const failed = events.filter((e) => e.event === "turn.failed");
  assert.equal(
    failed.length,
    0,
    `turn.failed не должен встречаться: ${JSON.stringify(failed)}`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const inTime = <T>(what: string, promise: Promise<T>, ms = 60_000) =>
  Promise.race([
    promise,
    sleep(ms).then(() => assert.fail(`${what} did not happen in ${ms}ms`)),
  ]);

type BridgeDeps = {
  replyImpl?: (chatId: number | undefined, text: string) => Promise<null>;
  ackImpl?: (id: string, text?: string) => Promise<unknown>;
};
type HandleControl = (
  update: Record<string, unknown>,
  deps?: BridgeDeps,
) => Promise<unknown>;

void test(
  "«стоп» через настоящий обработчик моста обрывает ход; «стоп» с чужим драфтом — нет",
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

    // Мост — тот же scripts/poller/control.ts, что крутится на бою. Его config и
    // run-status читают env на импорте, поэтому окружение поднимаем ДО загрузки
    // модуля: data-директория — та, куда пишет канал внутри eve; секрет и порт — те,
    // что у самой eve. cancelImpl не подменяем: POST на cancel-роут идёт настоящий.
    process.env.ASSISTANT_DATA_DIR = join(app, "data");
    process.env.IVA_PORT = String(port);
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = TG_SECRET;
    process.env.TELEGRAM_ALLOWED_USER_IDS = String(OWNER.id);
    process.env.TELEGRAM_BOT_TOKEN = "1:test-token";
    const { handleControl } = (await import("./poller/control.ts")) as unknown as {
      handleControl: HandleControl;
    };
    // Telegram-IO моста (answerCallbackQuery, ответы в чат) в hermetic-прогоне глушим;
    // они не часть пути отмены.
    const deps: BridgeDeps = {
      replyImpl: () => Promise.resolve(null),
      ackImpl: () => Promise.resolve(undefined),
    };
    let updateId = 1;
    // Нативная ■ драфта: Telegram присылает stopped_message_generation с draft_id.
    const draftStop = (draftId: number) =>
      handleControl(
        {
          update_id: updateId++,
          stopped_message_generation: { chat: CHAT, draft_id: draftId },
        },
        deps,
      );
    // Команда /stop: вторая дверь в тот же requestTurnCancel.
    const stopCommand = () => {
      const id = updateId++;
      return handleControl(
        {
          update_id: id,
          message: {
            message_id: id,
            date: 1,
            chat: CHAT,
            from: OWNER,
            text: "/stop",
          },
        },
        deps,
      );
    };

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
      // ── Исходная последовательность: ход идёт, нажата ■ — ход останавливается ──
      // Доставку сообщения делает вход фикстуры (в жалобе спорил не вход, а Стоп);
      // запись хода канал пишет штатную — именно её читает мост.
      const first = await post(port, bearer, "/restart-hang/send", {
        address: "1::",
        message: MARK_A,
      });
      assert.equal(first.status, 200);
      const { sessionId } = (await first.json()) as { sessionId: string };
      await inTime("model request in flight", provider.waitBlocked(1));
      const turnA: RunningTurn = await waitForRunningTurn(join(app, "data"));
      assert.equal(turnA.sessionId, sessionId);
      t.diagnostic(`turn A running: ${JSON.stringify(turnA)}`);

      // Тап по нативной ■ того драфта, что в записи хода. Путь целиком настоящий:
      // handleControl → handleTelegramDraftStop → requestTurnCancel → POST на
      // cancel-роут канала → session.cancel({tasks:true, turnId}).
      assert.equal(await draftStop(turnA.draftId), true);

      // «Стоп не останавливает ход» не воспроизводится: запрос к модели оборван —
      // работа прекратилась, а не доехала до ответа фоном.
      await inTime("model call aborted", provider.waitAborted(1));
      assert.equal(provider.alive(), false);
      t.diagnostic("model call aborted by draft stop");

      // Ход доехал до терминала ОТМЕНЫ: не completed и не failed — журнал событий
      // привязан к turnId этого хода. Запись в idle — следствие того же события.
      await waitForIdle(join(app, "data"));
      assertCancelledNotFailed(await readTurnEvents(join(app, "data")), turnA.turnId);
      t.diagnostic("turn A reached turn.cancelled, record idle");
      await sleep(3_000); // workflow уходит на парковку ожидания следующей доставки

      // Чат не завис: следующее сообщение — новый ход, провайдер отвечает. Провод —
      // штатный роут сессии eve (тот же dispatch, что и у webhook-доставки моста).
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

      // ── Отделение от «стопа по устаревшему драфту»: молчаливый no-op по дизайну ──
      const second = await post(port, bearer, `/eve/v1/session/${sessionId}`, {
        message: MARK_B,
      });
      assert.equal(second.status, 202);
      await inTime("turn B blocked mid-model-call", provider.waitBlocked(2));
      const turnB: RunningTurn = await waitForRunningTurn(
        join(app, "data"),
        turnA.turnId,
      );
      t.diagnostic(`turn B running: ${JSON.stringify(turnB)}`);

      // Второй тап по ■ старого (первого) драфта: запись уже зовёт другой драфт,
      // обработчик молча игнорирует — живой ход и его запрос к модели не тронуты.
      assert.equal(await draftStop(turnA.draftId), true);
      await sleep(2_000);
      assert.equal(
        provider.alive(),
        true,
        "стоп по чужому драфту не должен обрывать живой ход",
      );
      t.diagnostic("stale-draft stop was a no-op");

      // /stop — вторая дверь — тем же настоящим путём ход всё-таки снимает.
      assert.equal(await stopCommand(), true);
      await inTime("turn B aborted", provider.waitAborted(2));
      await waitForIdle(join(app, "data"));
      assertCancelledNotFailed(await readTurnEvents(join(app, "data")), turnB.turnId);
      t.diagnostic("turn B aborted via /stop command");
    };
    await scenario();
  },
);
