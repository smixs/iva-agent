/* eslint-disable @typescript-eslint/require-await -- Async test doubles exercise the production Promise boundary. */
/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { PROACTIVE_DEFAULTS } from "#lib/proactive-config.ts";
import { runProactiveTick, type TickDeps } from "./tick.ts";
import {
  initialState,
  readProactiveState,
  writeProactiveState,
} from "./state.ts";

const NOW = Date.UTC(2026, 10, 3, 10);
const MIN = 60_000;
const KEY = "tg:1234567890";
function harness(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iva-watch-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = {
    now: NOW,
    owner: NOW - 32 * MIN,
    peer: NOW - 26 * MIN,
    turns: 0,
    sends: 0,
    edits: [] as Array<{ ids: readonly number[]; text: string }>,
    logs: [] as string[],
    items: true,
    statePath: join(dir, "proactive.json"),
    deps: undefined as unknown as TickDeps,
  };
  h.deps = {
    config: () => ({
      ...PROACTIVE_DEFAULTS,
      staleMinutes: 0,
      quietFromHour: 0,
      quietToHour: 0,
      briefTimes: [],
    }),
    timeZone: "Asia/Tashkent",
    statePath: h.statePath,
    now: () => h.now,
    sources: [
      {
        name: "telegram",
        prefix: "tg:",
        check: async () => ({
          items: h.items
            ? [{ key: KEY, unread: 1, from: { username: "person_fixture" } }]
            : [],
          error: null,
        }),
        dialog: async () => ({ lastOwnerMs: h.owner, lastPeerMs: h.peer }),
      },
    ],
    runTurn: async () => {
      h.turns++;
      return {
        status: "completed",
        message: `<!-- iva:item ${KEY} -->\nQuestion`,
        feedback: async () => {},
      };
    },
    send: async () => {
      h.sends++;
      return { ok: true, error: "", messageIds: [91] };
    },
    closeSignal: async (ids, text) => {
      h.edits.push({ ids, text });
      return { ok: true, error: "" };
    },
    translate: async () => (_en, ru) => ru,
    log: (s) => h.logs.push(s),
  };
  return h;
}
async function seed(h: ReturnType<typeof harness>) {
  await writeProactiveState(h.statePath, {
    ...initialState(NOW),
    seen: {
      [KEY]: { firstSeenMs: NOW - 60 * MIN, unread: 1, reported: false },
    },
  });
}

test("owner wrote five minutes ago: no model wake or signal", async (t) => {
  const h = harness(t);
  await seed(h);
  h.owner = NOW - 5 * MIN;
  h.peer = NOW - MIN;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.equal(h.turns, 0);
  assert.equal(h.sends, 0);
});

test("question → delivered signal → owner reply: next tick edits once and survives restart", async (t) => {
  const h = harness(t);
  await seed(h);
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.equal(h.sends, 1);
  h.owner = NOW + 173_000;
  h.now = NOW + 30 * MIN;
  h.items = false;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.deepEqual(h.edits, [{ ids: [91], text: "✅ ответил в 15:02" }]);
  assert.equal(await runProactiveTick(h.now + 30 * MIN, h.deps), 0);
  assert.equal(h.edits.length, 1);
  assert.ok(readProactiveState(h.statePath));
});

test("an owner's later message makes an earlier peer question answered", async (t) => {
  const h = harness(t);
  await seed(h);
  h.owner = NOW - 20 * MIN;
  h.peer = NOW - 26 * MIN;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.equal(h.sends, 0);
  assert.equal(h.turns, 0);
});

test("property: delivery requires owner silence >=15min and a later peer question", async (t) => {
  const h = harness(t);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: -60 * MIN, max: MIN }),
      fc.integer({ min: -60 * MIN, max: MIN }),
      fc.integer({ min: -24 * 60 * MIN, max: 24 * 60 * MIN }),
      async (owner, peer, offset) => {
        await seed(h);
        h.now = NOW + offset;
        h.owner = h.now + owner;
        h.peer = h.now + peer;
        h.turns = 0;
        h.sends = 0;
        assert.equal(await runProactiveTick(h.now, h.deps), 0);
        const permitted = owner <= -15 * MIN && peer > owner;
        if (h.sends > 0) assert.ok(permitted);
        // Watch's existing half-hour schedule skips minute 30..59.
        if (new Date(h.now).getUTCMinutes() < 30)
          assert.equal(h.sends > 0, permitted);
      },
    ),
    { seed: 36693686, numRuns: 200 },
  );
});

test("owner reply during model turn is dropped by the fresh recheck", async (t) => {
  const h = harness(t);
  await seed(h);
  const original = h.deps.runTurn;
  const deps = {
    ...h.deps,
    runTurn: async (...args: Parameters<TickDeps["runTurn"]>) => {
      const reply = await original(...args);
      h.owner = NOW + MIN;
      h.now = NOW + 2 * MIN;
      return reply;
    },
  };
  assert.equal(await runProactiveTick(NOW, deps), 0);
  assert.equal(h.turns, 1);
  assert.equal(h.sends, 0);
});

test("signal without a later owner message stays untouched", async (t) => {
  const h = harness(t);
  await seed(h);
  assert.equal(await runProactiveTick(NOW, h.deps), 0);
  h.now += 30 * MIN;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.deepEqual(h.edits, []);
});

test("stale age is measured from the last owner message", async (t) => {
  const h = harness(t);
  await seed(h);
  h.owner = NOW - 20 * MIN;
  h.peer = NOW - 5 * MIN;
  const config = h.deps.config();
  assert.equal(
    await runProactiveTick(NOW, {
      ...h.deps,
      config: () => ({ ...config, staleMinutes: 30 }),
    }),
    0,
  );
  assert.equal(h.turns, 0);
});

test("missing message id is an error and creates no delivered signal", async (t) => {
  const h = harness(t);
  await seed(h);
  assert.equal(
    await runProactiveTick(NOW, {
      ...h.deps,
      send: async () => ({ ok: true, error: "" }),
    }),
    1,
  );
  assert.equal(readProactiveState(h.statePath)?.signals, undefined);
  assert.ok(h.logs.some((s) => s.includes("no message_id")));
});

test("unmarked and mixed-chat parts cannot bypass the live recheck", async (t) => {
  for (const message of [
    "Question",
    `<!-- iva:item ${KEY} --><!-- iva:item tg:2 -->\nQuestion`,
  ]) {
    const h = harness(t);
    await seed(h);
    const code = await runProactiveTick(NOW, {
      ...h.deps,
      runTurn: async () => ({
        status: "completed",
        message,
        feedback: async () => {},
      }),
    });
    assert.equal(code, 0);
    assert.equal(h.sends, 0);
  }
});

test("all parts of a signal retain their message ids", async (t) => {
  const h = harness(t);
  await seed(h);
  const message = `<!-- iva:item ${KEY} -->one\n<!-- iva:next -->\n<!-- iva:item ${KEY} -->two`;
  const deps = {
    ...h.deps,
    runTurn: async () => ({
      status: "completed" as const,
      message,
      feedback: async () => {},
    }),
    send: async () => ({ ok: true, error: "", messageIds: [++h.sends] }),
  };
  assert.equal(await runProactiveTick(NOW, deps), 0);
  assert.deepEqual(
    readProactiveState(h.statePath)?.signals?.[KEY].messageIds,
    [1, 2],
  );
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  assert.equal(await runProactiveTick(h.now, deps), 0);
  assert.deepEqual(h.edits[0].ids, [1, 2]);
});

test("failed close claim produces no edit; unknown close retries its frozen payload", async (t) => {
  const h = harness(t);
  await seed(h);
  await runProactiveTick(NOW, h.deps);
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  assert.equal(
    await runProactiveTick(h.now, {
      ...h.deps,
      writeState: async () => {
        throw new Error("disk full");
      },
    }),
    1,
  );
  assert.equal(h.edits.length, 0);
  let calls = 0;
  const deps = {
    ...h.deps,
    closeSignal: async () => {
      calls++;
      throw new Error("response lost");
    },
  };
  assert.equal(await runProactiveTick(h.now, deps), 1);
  assert.equal(await runProactiveTick(h.now + 30 * MIN, deps), 1);
  assert.equal(calls, 2);
  assert.equal(
    readProactiveState(h.statePath)?.signals?.[KEY].closeText,
    "✅ ответил в 15:01",
  );
});

test("history failure leaves a Telegram candidate quiet", async (t) => {
  const h = harness(t);
  await seed(h);
  const source = h.deps.sources[0];
  const deps = {
    ...h.deps,
    sources: [
      {
        ...source,
        dialog: async () => {
          throw new Error("offline");
        },
      },
    ],
  };
  assert.equal(await runProactiveTick(NOW, deps), 0);
  assert.equal(h.turns, 0);
  assert.equal(h.sends, 0);
});

test("F1 rejected edit recovers; a repeated identical edit has one external effect", async (t) => {
  const h = harness(t);
  await seed(h);
  await runProactiveTick(NOW, h.deps);
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  let requests = 0,
    effects = 0,
    visible = "";
  const { closeTelegramWatchSignal } = await import("../lib/telegram-send.ts");
  const payloads: unknown[] = [];
  const deps = {
    ...h.deps,
    closeSignal: (ids: readonly number[], text: string) =>
      closeTelegramWatchSignal(
        "fixture",
        "owner",
        { messageIds: ids, text },
        {
          fetchImpl: async (_url, init) => {
            requests++;
            assert.equal(typeof init?.body, "string");
            const body = JSON.parse(init?.body as string) as { text: string };
            payloads.push(body);
            if (requests === 1)
              return new Response("Too Many Requests", { status: 429 });
            if (body.text === visible)
              return new Response("Bad Request: message is not modified", {
                status: 400,
              });
            visible = body.text;
            effects++;
            // Applied remotely, response lost: retry is the same idempotent target and payload.
            throw new Error("response lost");
          },
        },
      ),
  };
  assert.equal(await runProactiveTick(h.now, deps), 1);
  assert.equal(await runProactiveTick(h.now + 30 * MIN, deps), 1);
  assert.equal(await runProactiveTick(h.now + 60 * MIN, deps), 0);
  assert.equal(await runProactiveTick(h.now + 120 * MIN, deps), 0);
  assert.equal(requests, 3);
  assert.equal(effects, 1);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[1], payloads[2]);
});

test("F2 live guard covers the real transport retry and fallback chunks", async (t) => {
  const h = harness(t);
  await seed(h);
  const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
  let requests = 0;
  const deps: TickDeps = {
    ...h.deps,
    send: (text, _source, options) =>
      sendTelegramHtml("fixture", "owner", text, {
        ...options,
        retryTransient: true,
        sleep: async () => {
          h.owner = NOW + 1000;
          h.now = NOW + 2000;
        },
        fetchImpl: async () => {
          requests++;
          if (requests === 1)
            return new Response(
              JSON.stringify({ parameters: { retry_after: 1 } }),
              { status: 429 },
            );
          throw new Error("a second HTTP attempt must be suppressed");
        },
      }),
  };
  assert.equal(await runProactiveTick(NOW, deps), 0);
  assert.equal(requests, 1);
  assert.equal(readProactiveState(h.statePath)?.signals, undefined);
});

test("F4 receipt survives a failed state projection and a fresh tick closes it", async (t) => {
  const h = harness(t);
  await seed(h);
  assert.equal(
    await runProactiveTick(NOW, {
      ...h.deps,
      writeState: async (path, state) => {
        if (state.signals?.[KEY]) throw new Error("state write failed");
        await writeProactiveState(path, state);
      },
    }),
    1,
  );
  assert.deepEqual(
    readProactiveState(h.statePath)?.signals?.[KEY].messageIds,
    [91],
  );
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.equal(h.edits.length, 1);
  assert.equal(
    readProactiveState(h.statePath)?.signals?.[KEY].status,
    "closed",
  );
  assert.equal(await runProactiveTick(h.now + 30 * MIN, h.deps), 0);
  assert.equal(h.edits.length, 1);
});

test("F5 history expansion covers the actual delivered interval in a busy group", async (t) => {
  const h = harness(t);
  await seed(h);
  await runProactiveTick(NOW, h.deps);
  h.owner = NOW + MIN;
  h.now += 60 * MIN;
  const { readDialog } = await import("./precheck.ts");
  const history = [
    ...Array.from({ length: 100 }, (_, i) => ({
      date: new Date(NOW + 30 * MIN + i * 1000).toISOString(),
      out: false,
    })),
    { date: new Date(h.owner).toISOString(), out: true },
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const limits: number[] = [];
  const source = h.deps.sources[0];
  const deps = {
    ...h.deps,
    sources: [
      {
        ...source,
        dialog: (_key: string, now: number, since?: number) =>
          readDialog(
            async (_name, args) => {
              limits.push(Number(args.limit));
              return JSON.stringify({
                results: history.slice(0, Number(args.limit)),
              });
            },
            KEY,
            now,
            since,
          ),
      },
    ],
  };
  assert.equal(await runProactiveTick(h.now, deps), 0);
  assert.equal(h.edits.length, 1);
  assert.deepEqual(limits.slice(0, 2), [100, 200]);
});

test("F4 process exit after durable receipt but before send returns is recovered", async (t) => {
  const h = harness(t);
  await seed(h);
  const stateModule = new URL("./state.ts", import.meta.url).href;
  const sendModule = new URL("../lib/telegram-send.ts", import.meta.url).href;
  const script = `import { recordSignalReceipt } from ${JSON.stringify(stateModule)};
    import { sendTelegramHtml } from ${JSON.stringify(sendModule)};
    await sendTelegramHtml("fixture", "owner", "notice", {
      fetchImpl: async () => new Response(JSON.stringify({ok:true,result:{message_id:91}})),
      onAcknowledged: id => { recordSignalReceipt(${JSON.stringify(h.statePath)}, ${JSON.stringify(KEY)}, id, ${NOW}); process.exit(91); }
    });`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 91, child.stderr);
  assert.deepEqual(
    readProactiveState(h.statePath)?.signals?.[KEY].messageIds,
    [91],
  );
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  assert.equal(await runProactiveTick(h.now, h.deps), 0);
  assert.equal(h.edits.length, 1);
});

test("F2 production main forwards admission into the real cron Outbox", async (t) => {
  const h = harness(t);
  await seed(h);
  const { main } = await import("./tick.ts");
  const oldDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = join(h.statePath, "..");
  t.after(() => {
    if (oldDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = oldDir;
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    h.owner = NOW + 1000;
    h.now = NOW + 2000;
    return new Response(JSON.stringify({ parameters: { retry_after: 1 } }), {
      status: 429,
    });
  });
  const overrides = {
    config: h.deps.config,
    statePath: h.statePath,
    sources: h.deps.sources,
    runTurn: h.deps.runTurn,
    translate: h.deps.translate,
    log: h.deps.log,
  };
  assert.equal(
    await main(
      {
        TELEGRAM_BOT_TOKEN: "fixture",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        ASSISTANT_TIMEZONE: "Asia/Tashkent",
      },
      overrides,
      () => h.now,
    ),
    0,
  );
  assert.equal(requests, 1);
});

test("F4 stale receipt never reopens a closed notice and compaction preserves its cursor", async (t) => {
  const h = harness(t);
  await seed(h);
  await runProactiveTick(NOW, h.deps);
  h.owner = NOW + MIN;
  h.now += 30 * MIN;
  await runProactiveTick(h.now, h.deps);
  const state = readProactiveState(h.statePath)!;
  assert.equal(state.signals?.[KEY].status, "closed");
  writeFileSync(
    `${h.statePath}.receipts`,
    JSON.stringify([{ seq: 1, key: KEY, id: 91, at: NOW }]),
  );
  assert.equal(
    readProactiveState(h.statePath)?.signals?.[KEY].status,
    "closed",
  );
  const { recordSignalReceipt } = await import("./state.ts");
  recordSignalReceipt(h.statePath, KEY, 92, h.now);
  const next = readProactiveState(h.statePath)!;
  assert.deepEqual(next.signals?.[KEY].messageIds, [92]);
  assert.equal(next.receiptCursor, 2);
  await writeProactiveState(h.statePath, next);
  assert.equal(existsSync(`${h.statePath}.receipts`), false);
});
