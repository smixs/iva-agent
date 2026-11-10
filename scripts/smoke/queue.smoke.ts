import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  Machine,
  step,
  SETTLE,
  updateIds,
  type Step,
} from "../fixtures/queue-drain-model.ts";
import { fc, smokeParameters } from "./pbt.ts";

type Model = Record<string, never>;
class Command implements fc.AsyncCommand<Model, Machine> {
  readonly action: Step;
  constructor(action: Step) {
    this.action = action;
  }
  check() {
    return true;
  }
  async run(_model: Model, real: Machine) {
    await real.step(this.action);
    real.check(this.action);
    assert.deepEqual(real.violations, []);
  }
  toString() {
    return JSON.stringify(this.action);
  }
}

await test("P-queue: QueueDrain commands preserve ownership and chat order across Bridge restarts", async () => {
  await fc.assert(
    fc.asyncProperty(
      updateIds,
      fc.commands([step.map((action) => new Command(action))], {
        maxCommands: 60,
      }),
      async (ids, commands) => {
        const real = new Machine("queue", ids);
        await fc.asyncModelRun(() => ({ model: {}, real }), commands);
        for (const action of SETTLE) await new Command(action).run({}, real);
        assert.equal(
          new Set([...real.seen, ...real.discarded]).size,
          real.arrived,
        );
      },
    ),
    smokeParameters(),
  );
});

await test("P-queue: duplicate replay and numeric id permutation preserve the final state", async () => {
  await fc.assert(
    fc.asyncProperty(
      updateIds,
      fc.array(
        fc.constantFrom<"plain" | "reply" | "tap">("plain", "reply", "tap"),
        { minLength: 1, maxLength: 7 },
      ),
      async (ids, kinds) => {
        const replay = async (
          numbers: readonly number[],
          duplicate: boolean,
        ) => {
          const real = new Machine("queue", numbers);
          await real.step({ t: "busy" });
          for (const [index, kind] of kinds.entries()) {
            const author = (index % 2) as 0 | 1;
            await real.step({ t: "arrive", author, kind });
            await real.step({ t: "route", author, outcome: "accept" });
            // A restart before inbox acknowledgement replays the exact same update.
            if (duplicate) {
              await real.step({ t: "restart" });
              await real.step({ t: "route", author, outcome: "accept" });
            }
            await real.step({ t: "inboxAck", author });
          }
          for (const action of SETTLE) {
            await real.step(action);
            real.check(action);
          }
          assert.deepEqual(real.violations, []);
          return {
            seen: [...real.seen],
            document: real.document,
            arrived: real.arrived,
          };
        };
        const baseline = await replay(ids, false);
        assert.deepEqual(await replay(ids, true), baseline);
        // Telegram ids carry identity, not FIFO order: relabel them to reversed/stale ids.
        assert.deepEqual(await replay([...ids].reverse(), true), baseline);
      },
    ),
    smokeParameters(),
  );
});

await test(
  "P-queue: offset follows durable ownership, SIGKILL and Bridge restart lose no burst input",
  { timeout: 15_000 },
  async (t) => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { existsSync, readFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const join: (...parts: string[]) => string = (...parts) =>
      path.join(...parts);
    const { setTimeout: delay } = await import("node:timers/promises");
    const { tempDir } = await import("../fixtures/temp-dir.ts");
    const dir = tempDir("iva-smoke-queue-offset-");
    const harness = join(
      import.meta.dirname,
      "../fixtures/telegram-poll-queue-harness.ts",
    );
    const child = spawn(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        harness,
        "burst-ownership-crash",
        dir,
        "none",
      ],
      {
        env: { ...process.env, TELEGRAM_COLLECT_QUIET_MS: "60000" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "ownership-ready"))) {
      assert.ok(child.exitCode === null && child.signalCode === null, stderr);
      assert.ok(Date.now() < deadline, `durable ownership deadline: ${stderr}`);
      await delay(10);
    }
    const offset = JSON.parse(
      readFileSync(join(dir, "telegram-offset.json"), "utf8"),
    ) as { offset: number };
    const inbox = JSON.parse(
      readFileSync(join(dir, "telegram-inbox.json"), "utf8"),
    ) as { queues: Record<string, { updateId: number }[]> };
    assert.equal(offset.offset, 103);
    assert.deepEqual(
      Object.values(inbox.queues)
        .flat()
        .map((item) => item.updateId)
        .sort(),
      [101, 102],
    );
    child.kill("SIGKILL");
    await exited;
    const resumed = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        harness,
        "restart-drain",
        dir,
        "none",
      ],
      {
        env: { ...process.env, TELEGRAM_COLLECT_QUIET_MS: "0" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(
      readFileSync(join(dir, "queue-harness-result.json"), "utf8"),
    ) as {
      deliveries: { update_id: number }[];
      inbox: unknown;
      queue: unknown;
    };
    assert.deepEqual(
      result.deliveries.map((item) => item.update_id),
      [101, 102],
    );
    assert.deepEqual(result.inbox, { version: 1, queues: {} });
    assert.deepEqual(result.queue, { version: 1, queues: {} });
  },
);

await test("P-queue: Bridge refuses offset advancement when durable admission fails", async () => {
  const { processTelegramUpdate } = await import("../poller/main.ts");
  const events: string[] = [];
  const update = {
    update_id: 101,
    message: {
      message_id: 101,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      text: "owned before offset",
    },
  };
  const result = await processTelegramUpdate(update, 100, {
    handleControlImpl: () => Promise.resolve(false),
    admitImpl: () => {
      events.push("ownership failed");
      return Promise.resolve("write-failed");
    },
    saveOffsetImpl: () => {
      events.push("offset");
      return Promise.resolve();
    },
    logImpl: () => {},
  });
  assert.deepEqual(events, ["ownership failed"]);
  assert.deepEqual(result, { offset: 100, ingressBlocked: true });
});

await test("P-queue: reordering independent chats and adding duplicate updates commutes", async () => {
  const { createQueueItem, enqueueItem } =
    await import("../lib/telegram-queue.ts");
  fc.assert(
    fc.property(updateIds, (ids) => {
      const inputs = [0, 1, 2, 3].map((index) => {
        const chatId = index < 2 ? 42 : 43;
        return {
          key: `${chatId}:`,
          update: {
            update_id: ids[index],
            message: {
              message_id: index + 1,
              date: 1,
              chat: { id: chatId, type: "private" },
              from: { id: chatId, is_bot: false },
              text: `part ${index}`,
            },
          },
        };
      });
      const enqueue = (order: number[]) => {
        let document: import("../lib/telegram-queue.ts").TelegramQueueDocument =
          { version: 1, queues: {} };
        for (const index of order) {
          const { key, update } = inputs[index];
          document = enqueueItem(
            document,
            key,
            createQueueItem(update, 1),
          ).document;
        }
        return document;
      };
      assert.deepEqual(
        enqueue([2, 2, 0, 0, 3, 3, 1, 1]),
        enqueue([0, 1, 2, 3]),
      );
    }),
    smokeParameters(),
  );
});
