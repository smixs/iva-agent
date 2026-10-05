import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  startProvider,
} from "./fixtures/restart-app.ts";

void test(
  "startup retires a session killed mid-compaction, stays silent, and drains its queued message",
  {
    timeout: 180_000,
  },
  async (t) => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "iva-restart-mid-compaction-"),
    );
    // Ход отвечает сразу, а пересказ между ходами замирает в провайдере до перезапуска.
    const provider = await startProvider("CONTEXT CHECKPOINT COMPACTION");
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
    const env = envFor(sandbox, app, port, provider.baseUrl, bearer);
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
    // Канал на парковке сессии занимает чат и ждёт ответа роута свёртки внутри обработчика
    // (scripts/fixtures/restart-hang-channel.ts делает это теми же модулями, что канал Telegram).
    await writeFile(join(app, "data/compact-on-waiting"), "");
    const started = await post(port, bearer, "/restart-hang/send", {
      address: "1::",
      message: "remember the word aubergine",
    });
    assert.equal(started.status, 200);
    const { sessionId } = (await started.json()) as { sessionId: string };
    await replies(1, "the first turn did not complete");

    // Запрос пересказа дошёл до провайдера: eve приняла просьбу, пока обработчик её ждал, и
    // ручной compact нашёл модель шага (хунк patches/eve).
    await provider.blocked;
    const asked = JSON.parse(
      (await readFile(join(app, "data/restart-hang-compact.jsonl"), "utf8"))
        .trim()
        .split("\n")[0] ?? "{}",
    ) as { outcome?: string; ms?: number };
    assert.equal(asked.outcome, "true", "eve приняла просьбу");
    assert.ok(
      typeof asked.ms === "number" && asked.ms < 3_000,
      `ожидание ответа внутри обработчика парковки не виснет: ${String(asked.ms)} мс`,
    );
    assert.equal(status.getChatStatus("1:")?.sessionId, sessionId);
    assert.equal(status.getChatStatus("1:")?.compacting, true);
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

    await killEve(eve);
    await runNode(
      [join(app, "scripts/recover-interrupted-turns.ts")],
      app,
      env,
      () => {},
    );
    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

    // Восстановление само освободило запись пересказа: мосту нечего закрывать и не о чем
    // сообщать — запроса человека в пересказе не было.
    assert.equal(status.getChatStatus("1:")?.status, "idle");
    assert.equal(status.getChatStatus("1:")?.compacting, undefined);
    const notices: string[] = [];
    assert.equal(
      await queue.reapStaleRuns({
        sendImpl: (_key, text) => {
          notices.push(text);
          return Promise.resolve();
        },
        deleteMessageImpl: () => Promise.resolve(),
        logImpl: () => {},
      }),
      0,
    );
    assert.deepEqual(notices, []);
    assert.equal(
      (await queue.loadQueue({ strict: true })).queues["1:"]?.length,
      1,
    );

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
    });
    assert.equal(remaining, 0);
    await replies(2, "the queued message did not complete after restart");

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
