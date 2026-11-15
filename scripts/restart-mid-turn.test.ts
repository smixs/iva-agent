import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
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
  "startup retires a killed mid-turn session and drains its queued message",
  {
    timeout: 180_000,
  },
  async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "iva-restart-mid-turn-"));
    const provider = await startProvider();
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

    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);
    // The owner's next message goes to the interrupted session itself: without
    // recovery its inbox lock survives the kill and the next turn never starts.
    const started = await post(port, bearer, "/restart-hang/send", {
      address: "1::",
      message: "BLOCK_UNTIL_RESTART",
    });
    assert.equal(started.status, 200);
    const { sessionId } = (await started.json()) as { sessionId: string };
    await provider.blocked;
    status.setChatStatus("1:", {
      status: "running",
      sessionId,
      turnId: "turn-before-restart",
    });
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
    const recovery = join(app, "scripts/recover-interrupted-turns.ts");
    if (existsSync(recovery)) {
      await runNode([recovery], app, env, () => {});
    }
    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

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
    assert.match(
      notices[0],
      /Предыдущий ход оборвался|previous turn was interrupted/iu,
    );
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
      pins: new Map(),
    });
    assert.equal(remaining, 0);
    const replyFile = join(app, "data/restart-hang-replies.jsonl");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const lines = await readFile(replyFile, "utf8").catch(() => "");
      if (lines.includes("RECOVERED")) break;
      if (Date.now() >= deadline) assert.fail("next message did not complete");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

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
