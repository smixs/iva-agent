/* eslint-disable @typescript-eslint/require-await -- Async test doubles exercise the production Promise boundary. */
/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const KEY = "tg:5398450157";
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
            ? [{ key: KEY, unread: 1, from: { username: "SafiaCMO" } }]
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

test("failed close claim produces no edit; unknown close is never replayed", async (t) => {
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
  assert.equal(calls, 1);
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
