import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  allTelegramBotTokens,
  botIdFromToken,
  botIdFromUpdate,
  botScopedKey,
  configuredTelegramBots,
  parseBotScopedKey,
  parseColleagueBotTokens,
  resolveTelegramBot,
  tagUpdateWithBot,
  TELEGRAM_BOT_ID_FIELD,
  TELEGRAM_BOT_ID_HEADER,
  type TelegramBotConfig,
} from "../../packages/telegram-bots/index.ts";
import { parseOffsetFile, serializeOffsetFile } from "../lib/offset-store.ts";
import {
  enqueueQueueFile,
  loadQueueFile,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import { collectorKeyFor } from "../lib/telegram-collect.ts";
import { botOffsetFile } from "./config.ts";
import { deliver } from "./deliver.ts";
import { admitTelegramUpdate, inboxKeyFor } from "./inbox.ts";
import { chatKey, loadOffset, saveOffset } from "./offset.ts";
import {
  acquireTelegramProcessLock,
  assertTelegramProcessLease,
} from "./process-lock.ts";
import { runBotPollLoop } from "./main.ts";
import { scanOutbound } from "#lib/security-gate.ts";

const SEED = 20_261_126;

const IVA_BOT: TelegramBotConfig = {
  botId: "111111111",
  token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  username: "iva_main_bot",
  isPrimary: true,
};

const COLLEAGUE_BOT: TelegramBotConfig = {
  botId: "222222222",
  token: "222222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  username: "critic_colleague_bot",
  isPrimary: false,
};

const SECOND_COLLEAGUE: TelegramBotConfig = {
  botId: "333333333",
  token: "333333333:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  username: "coder_colleague_bot",
  isPrimary: false,
};

let guardSeq = 0;

async function tempDirWithLease(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "iva-multi-bot-"));
  const lease = await acquireTelegramProcessLock({
    testGuard: {
      identity: `multibot-${process.pid}-${++guardSeq}`,
      directory: join(dir, ".guard"),
    },
  });
  t.after(async () => {
    await lease.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, lease };
}

function makeMessageUpdate(
  updateId: number,
  chatId: number,
  text: string,
  fromId = 42,
): TelegramQueueUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000,
      chat: { id: chatId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Owner" },
      text,
    },
  };
}

void test(`property: colleague token parsing deduplicates by botId and never overrides primary (seed ${SEED})`, () => {
  const botIdArb = fc.integer({ min: 10_000, max: 999_999_999 }).map(String);
  const secretArb = fc.stringMatching(/^[A-Za-z0-9_-]{16,35}$/);
  const userArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{4,20}$/);

  fc.assert(
    fc.property(
      botIdArb,
      secretArb,
      fc.array(
        fc.tuple(fc.option(userArb, { nil: undefined }), botIdArb, secretArb),
        { maxLength: 8 },
      ),
      (primaryId, primarySecret, rawColleagues) => {
        const primaryToken = `${primaryId}:${primarySecret}`;
        const raw = rawColleagues
          .map(([user, id, secret]) =>
            user ? `${user}=${id}:${secret}` : `${id}:${secret}`,
          )
          .join(",");
        const bots = configuredTelegramBots({
          TELEGRAM_BOT_TOKEN: primaryToken,
          TELEGRAM_BOT_USERNAME: "iva_main_bot",
          TELEGRAM_COLLEAGUE_BOT_TOKENS: raw,
        });
        assert.equal(bots[0]?.isPrimary, true);
        assert.equal(bots[0]?.botId, primaryId);
        const ids = bots.map((b) => b.botId);
        assert.equal(
          new Set(ids).size,
          ids.length,
          "duplicate botId survived parsing",
        );
        for (const colleague of bots.slice(1)) {
          assert.equal(colleague.isPrimary, false);
          assert.notEqual(colleague.botId, primaryId);
          assert.equal(botIdFromToken(colleague.token), colleague.botId);
        }
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

void test(`property: botScopedKey and parseBotScopedKey round-trip and are idempotent (seed ${SEED})`, () => {
  const botIdArb = fc.integer({ min: 1, max: 999_999_999 }).map(String);
  const keyArb = fc
    .tuple(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
    )
    .map(([chat, thread]) => `${chat}:${thread ?? ""}`);

  fc.assert(
    fc.property(botIdArb, keyArb, (botId, baseKey) => {
      const scoped = botScopedKey(baseKey, botId);
      assert.equal(scoped, `bot:${botId}:${baseKey}`);
      assert.equal(botScopedKey(scoped, botId), scoped);
      assert.deepEqual(parseBotScopedKey(scoped), { botId, key: baseKey });
      assert.equal(botScopedKey(baseKey, null), baseKey);
      assert.equal(botScopedKey(baseKey, botId, botId), baseKey);
      assert.deepEqual(parseBotScopedKey(baseKey), {
        botId: null,
        key: baseKey,
      });
    }),
    { seed: SEED, numRuns: 300 },
  );
});

void test("parseColleagueBotTokens ignores malformed entries without dropping valid colleagues", () => {
  const parsed = parseColleagueBotTokens(
    `garbage,0:zero,no_colon,${IVA_BOT.token},critic_bot=${COLLEAGUE_BOT.token},dup=${COLLEAGUE_BOT.token},${SECOND_COLLEAGUE.token}`,
    IVA_BOT.botId,
  );
  assert.deepEqual(parsed, [
    {
      botId: COLLEAGUE_BOT.botId,
      token: COLLEAGUE_BOT.token,
      username: "critic_bot",
      isPrimary: false,
    },
    {
      botId: SECOND_COLLEAGUE.botId,
      token: SECOND_COLLEAGUE.token,
      isPrimary: false,
    },
  ]);
  assert.equal(
    resolveTelegramBot("999999999", {
      TELEGRAM_BOT_TOKEN: IVA_BOT.token,
      TELEGRAM_COLLEAGUE_BOT_TOKENS: COLLEAGUE_BOT.token,
    }),
    null,
  );
});

void test("colleague message arrives with its bot tag and isolated inbox/chat keys even with identical chat_id and update_id", async (t) => {
  const { dir } = await tempDirWithLease(t);
  const inboxFile = join(dir, "telegram-inbox.json");
  const allowed = new Set(["42"]);

  const primaryUpdate = makeMessageUpdate(7, 42, "hello iva");
  const colleagueUpdate = makeMessageUpdate(7, 42, "hello colleague");

  const r1 = await admitTelegramUpdate(primaryUpdate, {
    allowedUserIds: allowed,
    bot: IVA_BOT,
    enqueueImpl: (key, candidate) =>
      enqueueQueueFile(inboxFile, key, candidate, { strict: true }),
    logImpl: () => {},
  });
  const r2 = await admitTelegramUpdate(colleagueUpdate, {
    allowedUserIds: allowed,
    bot: COLLEAGUE_BOT,
    colleaguesEnabledImpl: () => true,
    enqueueImpl: (key, candidate) =>
      enqueueQueueFile(inboxFile, key, candidate, { strict: true }),
    logImpl: () => {},
  });

  assert.equal(r1, "owned");
  assert.equal(r2, "owned");

  const loaded = (await loadQueueFile(inboxFile, { strict: true })).document;
  assert.deepEqual(Object.keys(loaded.queues).sort(), [
    "42::42",
    `bot:${COLLEAGUE_BOT.botId}:42::42`,
  ]);

  const primaryStored = loaded.queues["42::42"][0]?.update;
  const colleagueStored =
    loaded.queues[`bot:${COLLEAGUE_BOT.botId}:42::42`][0]?.update;

  assert.ok(primaryStored);
  assert.ok(colleagueStored);
  assert.equal(botIdFromUpdate(primaryStored), null);
  assert.equal(botIdFromUpdate(colleagueStored), COLLEAGUE_BOT.botId);
  assert.equal(
    colleagueStored.message?.[TELEGRAM_BOT_ID_FIELD],
    COLLEAGUE_BOT.botId,
  );
  assert.equal(chatKey(primaryStored), "42:");
  assert.equal(chatKey(colleagueStored), `bot:${COLLEAGUE_BOT.botId}:42:`);
  assert.equal(collectorKeyFor(primaryStored), "42::42");
  assert.equal(
    collectorKeyFor(colleagueStored),
    `bot:${COLLEAGUE_BOT.botId}:42::42`,
  );
  assert.equal(
    inboxKeyFor(colleagueStored),
    `bot:${COLLEAGUE_BOT.botId}:42::42`,
  );
});

void test("lagging or stalled bot does not delay another bot polling in the same process", async (t) => {
  const { dir, lease } = await tempDirWithLease(t);
  const ivaOffsetFile = botOffsetFile(IVA_BOT, dir);
  const colleagueOffsetFile = botOffsetFile(COLLEAGUE_BOT, dir);

  let releaseSlowIva!: () => void;
  let ivaPollStarted!: () => void;
  const ivaStarted = new Promise<void>((resolve) => {
    ivaPollStarted = resolve;
  });
  const ivaHold = new Promise<void>((resolve) => {
    releaseSlowIva = resolve;
  });

  let keepRunningIva = true;
  let keepRunningColleague = true;
  const admittedUpdates: TelegramQueueUpdate[] = [];
  let colleagueWoke = 0;

  const ivaLoop = runBotPollLoop({
    bot: IVA_BOT,
    initialOffset: 100,
    assertLease: () => {
      assert.ok(lease);
    },
    shouldContinue: () => keepRunningIva,
    tgImpl: async (method) => {
      assert.equal(method, "getUpdates");
      ivaPollStarted();
      await ivaHold;
      keepRunningIva = false;
      return { ok: true, result: [] };
    },
    saveOffsetImpl: (next) => saveOffset(next, { file: ivaOffsetFile }),
    sleepImpl: () => Promise.resolve(),
    logImpl: () => {},
  });

  // Ensure Iva's getUpdates is actively blocked BEFORE Colleague starts.
  await ivaStarted;

  const colleagueLoop = runBotPollLoop({
    bot: COLLEAGUE_BOT,
    initialOffset: 5,
    assertLease: () => {
      assert.ok(lease);
    },
    colleaguesEnabledImpl: () => true,
    colleagueCompleteImpl: () => true,
    shouldContinue: () => keepRunningColleague,
    tgImpl: (_method, body, options) => {
      assert.equal(options?.token, COLLEAGUE_BOT.token);
      assert.equal((body as { offset: number }).offset, 5);
      keepRunningColleague = false;
      return Promise.resolve({
        ok: true,
        result: [makeMessageUpdate(5, 42, "ping colleague while iva hangs")],
      });
    },
    processUpdateImpl: async (update, offset) => {
      const tagged = tagUpdateWithBot(update, COLLEAGUE_BOT);
      admittedUpdates.push(tagged);
      const next = offset + 1;
      await saveOffset(next, { file: colleagueOffsetFile });
      return { offset: next, ingressBlocked: false };
    },
    saveOffsetImpl: (next) => saveOffset(next, { file: colleagueOffsetFile }),
    onUpdates: () => {
      colleagueWoke += 1;
    },
    sleepImpl: () => Promise.resolve(),
    logImpl: () => {},
  });

  // Colleague finishes completely while Iva's getUpdates is STILL unresolved!
  const colleagueResult = await colleagueLoop;
  assert.equal(colleagueResult.offset, 6);
  assert.equal(colleagueWoke, 1);
  assert.equal(admittedUpdates.length, 1);
  assert.equal(botIdFromUpdate(admittedUpdates[0]), COLLEAGUE_BOT.botId);
  assert.deepEqual(
    parseOffsetFile(await readFile(colleagueOffsetFile, "utf8")),
    { offset: 6 },
  );

  // Now release Iva's stalled getUpdates and confirm its offset never moved.
  releaseSlowIva();
  const ivaResult = await ivaLoop;
  assert.equal(ivaResult.offset, 100);
});

void test("colleague offset initialization waits for enablement and retries without stopping the loop", async () => {
  let enabled = false;
  let initAttempts = 0;
  let running = true;
  const events: string[] = [];

  const result = await runBotPollLoop({
    bot: COLLEAGUE_BOT,
    initialOffset: 0,
    assertLease: () => {},
    colleaguesEnabledImpl: () => enabled,
    colleagueCompleteImpl: () => true,
    initializeOffsetImpl: () => {
      events.push("init");
      initAttempts += 1;
      if (initAttempts === 1) {
        return Promise.reject(new Error("bad colleague token"));
      }
      return Promise.resolve(10);
    },
    shouldContinue: () => running,
    tgImpl: (method, body, options) => {
      assert.equal(method, "getUpdates");
      assert.equal(options?.token, COLLEAGUE_BOT.token);
      events.push(`poll:${String((body as { offset: number }).offset)}`);
      running = false;
      return Promise.resolve({ ok: true, result: [] });
    },
    sleepImpl: () => {
      events.push(enabled ? "sleep:enabled" : "sleep:disabled");
      if (!enabled) enabled = true;
      return Promise.resolve();
    },
    logImpl: () => {},
  });

  assert.equal(result.offset, 10);
  assert.deepEqual(events, [
    "sleep:disabled",
    "init",
    "sleep:enabled",
    "init",
    "poll:10",
  ]);
});

void test("lease loss during lazy colleague initialization stops before the first getUpdates", async (t) => {
  const { lease } = await tempDirWithLease(t);
  const telegramCalls: string[] = [];
  let running = true;

  await assert.rejects(
    runBotPollLoop({
      bot: COLLEAGUE_BOT,
      initialOffset: 0,
      assertLease: () => assertTelegramProcessLease(lease),
      colleaguesEnabledImpl: () => true,
      colleagueCompleteImpl: () => true,
      initializeOffsetImpl: async () => {
        await lease.close();
        return 10;
      },
      shouldContinue: () => running,
      tgImpl: (method) => {
        telegramCalls.push(method);
        running = false;
        return Promise.resolve({ ok: true, result: [] });
      },
      sleepImpl: () => Promise.resolve(),
      logImpl: () => {},
    }),
    /active process lease/u,
  );
  assert.deepEqual(telegramCalls, []);
});

void test("per-bot restart preserves independent offsets under one process lock", async (t) => {
  const { dir, lease } = await tempDirWithLease(t);
  assert.ok(lease);
  const ivaOffsetFile = botOffsetFile(IVA_BOT, dir);
  const colOffsetFile = botOffsetFile(COLLEAGUE_BOT, dir);

  // Existing installation: Iva already has offset 50; Colleague is brand new.
  await writeFile(ivaOffsetFile, serializeOffsetFile(50), { mode: 0o600 });

  assert.deepEqual(await loadOffset({ file: ivaOffsetFile }), { offset: 50 });
  assert.deepEqual(await loadOffset({ file: colOffsetFile }), { offset: null });

  // Colleague saves its own offset 12; Iva advances to 55.
  await saveOffset(12, { file: colOffsetFile });
  await saveOffset(55, { file: ivaOffsetFile });

  // Simulated restart: both resume from their own persisted offsets.
  assert.deepEqual(await loadOffset({ file: ivaOffsetFile }), { offset: 55 });
  assert.deepEqual(await loadOffset({ file: colOffsetFile }), { offset: 12 });
});

void test("deliver forwards colleague bot id in X-Iva-Telegram-Bot-Id header and omits it for primary", async () => {
  const savedFetch = globalThis.fetch;
  const seenHeaders: Array<Record<string, string>> = [];
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    seenHeaders.push({ ...(init?.headers as Record<string, string>) });
    return Promise.resolve(
      new Response(null, {
        status: 204,
        headers: { "x-iva-telegram-acceptance": "turn" },
      }),
    );
  };

  try {
    const primaryRes = await deliver(makeMessageUpdate(1, 42, "hi iva"), {
      retry: false,
    });
    const colleagueRes = await deliver(
      tagUpdateWithBot(makeMessageUpdate(2, 42, "hi critic"), COLLEAGUE_BOT),
      { retry: false },
    );
    assert.equal(primaryRes, true);
    assert.equal(colleagueRes, true);
    assert.equal(seenHeaders[0]?.[TELEGRAM_BOT_ID_HEADER], undefined);
    assert.equal(seenHeaders[1]?.[TELEGRAM_BOT_ID_HEADER], COLLEAGUE_BOT.botId);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

void test("outbound security gate redacts standalone colleague tokens from TELEGRAM_COLLEAGUE_BOT_TOKENS", () => {
  const savedPrimary = process.env.TELEGRAM_BOT_TOKEN;
  const savedColleagues = process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS;
  const customColleagueToken = "222222222:short-colleague-secret";
  process.env.TELEGRAM_BOT_TOKEN = IVA_BOT.token;
  process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS = `critic=${customColleagueToken}`;
  try {
    assert.ok(allTelegramBotTokens(process.env).includes(customColleagueToken));
    const scanned = scanOutbound(
      `oops leaked colleague token ${customColleagueToken} here`,
    );
    assert.equal(scanned.clean, false);
    assert.equal(scanned.text.includes(customColleagueToken), false);
    assert.equal(TELEGRAM_BOT_ID_HEADER, "x-iva-telegram-bot-id");
  } finally {
    if (savedPrimary === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedPrimary;
    if (savedColleagues === undefined)
      delete process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS;
    else process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS = savedColleagues;
  }
});
