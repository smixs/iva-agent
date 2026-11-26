import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  envFor,
  killEve,
  post,
} from "./fixtures/restart-app.ts";

const SUMMARY_PROMPT = "CONTEXT CHECKPOINT COMPACTION";
const SUMMARY_ANSWER = "RESTARTED_SUMMARY";

// Провайдер как в матрице, но без барьеров: отвечает на всё и ведёт журнал запросов,
// чтобы тест видел, пришёл ли запрос пересказа после перезапуска.
async function startLoggingProvider(): Promise<{
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      requests.push(body);
      const summary = body.includes(SUMMARY_PROMPT);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const text = summary ? SUMMARY_ANSWER : "RECOVERED";
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-restart",
          object: "chat.completion.chunk",
          created: 1,
          model: "iva-restart",
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\ndata: [DONE]\n\n`,
      );
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
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

void test(
  "a compaction pass killed mid-flight frees the chat and the queued message drains",
  {
    timeout: 180_000,
  },
  async (t) => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "iva-restart-mid-compaction-"),
    );
    const provider = await startLoggingProvider();
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
    const env: NodeJS.ProcessEnv = {
      ...envFor(sandbox, app, port, provider.baseUrl, bearer),
      // Матричные барьеры не выставлены: чекпоинты только пишут журнал, а запись
      // статуса чата в канале включается тем же флагом.
      COMPACT_STEP1_MATRIX: "1",
    };
    Object.assign(process.env, {
      ASSISTANT_DATA_DIR: env.ASSISTANT_DATA_DIR,
      ASSISTANT_HOST: `http://127.0.0.1:${port}`,
      TELEGRAM_BOT_TOKEN: "73002:restart-test-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      TELEGRAM_ALLOWED_USER_IDS: "42",
    });
    const status = await import("../agent/lib/run-status.ts");
    const queue = await import("./poller/queue.ts");
    const routing = await import("./poller/routing.ts");
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
    const replyFile = join(app, "data/restart-hang-replies.jsonl");
    const replies = async (count: number, what: string) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const lines = (await readFile(replyFile, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean);
        if (lines.length >= count) return;
        if (Date.now() >= deadline) assert.fail(what);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);
    // На парковке канал ставит сессии пометку свёртки штатным роутом — без захвата чата;
    // саму свёртку сделает следующий шаг (scripts/fixtures/restart-hang-channel.ts).
    await writeFile(join(app, "data/compact-on-waiting"), "");
    const started = await post(port, bearer, "/restart-hang/send", {
      address: "1::",
      message: "remember the word aubergine",
    });
    assert.equal(started.status, 200);
    await replies(1, "the first turn did not complete");

    // Пометка принята и чат свободен — занятия записью running под свёртку больше нет.
    const compactFile = join(app, "data/restart-hang-compact.jsonl");
    {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const content = await readFile(compactFile, "utf8").catch(() => "");
        if (content.trim().length > 0) break;
        if (Date.now() >= deadline)
          assert.fail("the parked session did not take the /compact mark");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const asked = JSON.parse(
      (await readFile(compactFile, "utf8")).trim().split("\n")[0] ?? "{}",
    ) as { outcome?: string };
    assert.equal(asked.outcome, "true", "eve приняла пометку свёртки");
    await queue.enqueueTelegramQueueUpdate("1:", {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "answer after restart",
      },
    });

    // Следующее сообщение поднимает проход свёртки по пометке: emit
    // compaction.requested ждёт обработчик, а барьер внутри него подвешивает
    // проход посередине — запись running, тело прохода ещё не закончено.
    await writeFile(join(app, "data/restart-hang-barrier"), "before-summary");
    const second = await post(port, bearer, "/restart-hang/send", {
      address: "1::",
      message: "compact the word now",
    });
    assert.equal(second.status, 200);
    {
      const blockedFile = join(app, "data/restart-hang-blocked");
      const deadline = Date.now() + 30_000;
      for (;;) {
        const blocked = await readFile(blockedFile, "utf8").catch(() => "");
        if (blocked.trim() === "before-summary") break;
        if (Date.now() >= deadline)
          assert.fail("the marked step did not reach compaction.requested");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Обрыв посередине прохода: восстановление видит running, убирает мёртвый
    // workflow-стор и помечает ход прерванным — застрявшей свёртки не остаётся.
    await killEve(eve);
    await rm(join(app, "data/restart-hang-barrier"), { force: true });
    await runNode(
      [join(app, "scripts/recover-interrupted-turns.ts")],
      app,
      env,
      () => {},
    );
    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

    // Прерванный проход — честное прерывание хода с вопросом человека: жнец
    // просит повторить, молча проигранных записей не остаётся.
    const notices: string[] = [];
    assert.equal(
      await queue.reapStaleRuns({
        sendImpl: (_key, text) => {
          notices.push(text);
          return Promise.resolve();
        },
        logImpl: () => {},
      }),
      1,
    );
    assert.equal(notices.length, 1);

    const remaining = await routing.drainReadyQueueHeads({
      deliverImpl: async (update) => {
        const response = await post(port, bearer, "/restart-hang/send", {
          address: "1::",
          message: update.message?.text,
        });
        return response.ok;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
      pins: new Map(),
    });
    assert.equal(remaining, 0);
    await replies(2, "the queued message did not complete after restart");

    // Проход начался по пометке и был убит до вызова пересказа: журнал ровно из
    // одной точки, вызова модели-пересказчика не было.
    const compactions = (
      await readFile(join(app, "data/restart-hang-compactions.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { point: string }).point);
    assert.deepEqual(
      compactions,
      ["requested"],
      "проход начался по пометке и убит до вызова пересказа",
    );
    const summaries = provider.requests.filter((body) =>
      body.includes(SUMMARY_PROMPT),
    ).length;
    assert.equal(summaries, 0, "вызов пересказа убит барьером — провайдер его не видел");
    // replies(2) ждёт message.completed, который eve эмитит внутри emitStreamContent
    // до финализации шага и emitTurnEpilogue (turn.completed → setChatStatus("idle")).
    // Между этими событиями есть окно ~6–10 мс на обеих ветках Node (24 и 26), поэтому
    // освобождение чата ждём явно, а не читаем синхронно сразу за replies(2).
    {
      const deadline = Date.now() + 30_000;
      while (
        status.getChatStatus("1:")?.status !== "idle" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(status.getChatStatus("1:")?.status, "idle");

    const reset = await post(port, bearer, "/eve/v1/telegram/reset", {
      address: { chatId: "1" },
    });
    assert.equal(reset.status, 200);
    assert.equal(
      ((await reset.json()) as { status?: unknown }).status,
      "reset",
    );
  },
);
