// Процесс Bridge для scripts/telegram-reset-restart.test.ts: два процесса по очереди.
// old — пишет очередь чата и исполняет /new: намерение сброса с отсечкой, затем запрос в
// маршрут агента (ответ приходит от родителя, где живёт агент).
// recovery — то, что делает новый Bridge после перезапуска: сверка того же намерения
// (scripts/poller/queue.ts) и доставка из очереди чата.
// Запрос агента к этим процессам не привязан: сброс исполняет родитель, как живой eve.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, dataDir, role] = process.argv.slice(2);
if (!root || !dataDir || !role) {
  throw new Error("usage: child <root> <data-dir> <old|recovery>");
}

process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";

// Модули моста грузятся по пути: их типы здесь не импортируются, нужна только форма вызовов.
type BridgeModule = {
  writeQueueAtomic: (queue: unknown) => Promise<void>;
  performScopedReset: (
    chatKey: string,
    target: unknown,
    options: Record<string, unknown>,
  ) => Promise<void>;
  reconcileScopedResetIntents: (
    options: Record<string, unknown>,
  ) => Promise<number>;
  drainReadyQueueHeads: (options: Record<string, unknown>) => Promise<number>;
};

const load = async (path: string): Promise<unknown> =>
  await import(pathToFileURL(join(root, path)).href);

await load("scripts/lib/ts-esm-hooks.ts");
const queue = (await load("scripts/poller/main.ts")) as BridgeModule;

const CHAT_KEY = "42:";
const item = (updateId: number) => ({
  version: 1,
  updateId,
  enqueuedAt: 1,
  update: {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: `text-${updateId}`,
    },
  },
});

// Запрос в маршрут агента живёт в родителе; здесь только передача и ожидание ответа.
const remote = (target: unknown) =>
  new Promise((resolve) => {
    process.once("message", resolve);
    process.send?.({ kind: "remote", target });
  });

if (role === "old") {
  await queue.writeQueueAtomic({
    version: 1,
    queues: { [CHAT_KEY]: [item(100), item(102)] },
  });
  await queue.performScopedReset(
    CHAT_KEY,
    { address: { chatId: "42" } },
    {
      clearQueue: true,
      discardThroughUpdateId: 101,
      requestResetImpl: ({ target }: { target: unknown }) => remote(target),
      logImpl: () => {},
    },
  );
} else {
  await queue.reconcileScopedResetIntents({
    requestResetImpl: ({ target }: { target: unknown }) => remote(target),
    logImpl: () => {},
  });
  await queue.drainReadyQueueHeads({
    deliverImpl: (update: { update_id: number }) => {
      process.send?.({ kind: "delivered", id: update.update_id });
      return Promise.resolve(true);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
    pins: new Map(),
  });
  process.send?.({ kind: "done" });
  process.disconnect();
}
