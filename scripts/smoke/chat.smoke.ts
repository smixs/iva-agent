import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import {
  createHarness,
  kill,
  message,
  OWNER,
  NOW,
  smokeParameters,
  waitFor,
} from "./harness.ts";

void test(
  "S-chat-notice-reply: own watchdog quote and immediate progress before tools finish",
  { timeout: 120_000 },
  async (t) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let releaseProgress = () => {};
    const progressReady = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    t.after(() => releaseProgress());
    let clockFile = "";
    const h = await createHarness(
      t,
      [
        {
          kind: "tool",
          name: "bash",
          arguments: '{"command":"true"}',
          text: "<!-- iva:silent -->\nI am checking the failed schedule.",
          waitFor: progressReady,
        },
        {
          kind: "tool",
          name: "bash",
          arguments: '{"command":"true"}',
          text: "More details about the schedule.",
        },
        { kind: "text", text: "WATCHDOG_EXPLAINED", waitFor: held },
        { kind: "text", text: "FOREIGN_QUOTE_EXPLAINED" },
      ],
      async (app, env) => {
        clockFile = join(app, "data/progress-clock");
        await writeFile(clockFile, "0");
        env.IVA_TEST_CLOCK_FILE = clockFile;
      },
    );
    await writeFile(
      join(h.app, "data/jobs.json"),
      JSON.stringify([
        {
          name: "memory-night",
          startedAt: Date.parse(NOW) - 60_000,
          finishedAt: Date.parse(NOW) - 59_000,
          ok: false,
          error: "overloaded",
          exitCode: 1,
          tail: "",
          acked: false,
          wake: null,
        },
      ]),
    );
    const watchdog = h.start(["scripts/jobs/watchdog.ts"]);
    assert.deepEqual(await once(watchdog, "exit"), [0, null]);
    const sends = () =>
      h.telegram.requests.filter((r) => r.method === "sendMessage");
    assert.equal(sends().length, 1);
    const notice = String(sends()[0].body.text);
    assert.match(notice, /Night memory.*the model is overloaded/u);
    assert.match(notice, /next night will retry.*iva doctor/su);
    assert.match(
      await readFile(join(h.app, "vault/daily/2026-06-15.md"), "utf8"),
      /\[assistant:jobs-watchdog\]/u,
    );
    // The fake Telegram server assigned id 101 to the real watchdog send.
    const update = message(401, "what is this?");
    h.telegram.rejectNext("sendRichMessageDraft", 400);
    const startedAt = performance.now();
    h.telegram.push({
      ...update,
      message: {
        ...update.message,
        reply_to_message: {
          message_id: 101,
          from: { id: 987654321, is_bot: true, first_name: "Smoke" },
          chat: update.message.chat,
          text: notice,
        },
      },
    });
    await waitFor(() => h.provider.requests.length === 1);
    // turn.started has reached the provider; cross the 10s threshold before message.completed.
    await writeFile(clockFile, "11000");
    releaseProgress();
    await waitFor(() =>
      sends().some((r) => r.body.text === "I am checking the failed schedule."),
    );
    const firstMessageMs = performance.now() - startedAt;
    assert.ok(firstMessageMs < 60_000, `first message: ${firstMessageMs}ms`);
    // Keep the final provider response held: drafts and final-only delivery cannot pass.
    await waitFor(() => h.provider.requests.length === 3);
    const wire = h.provider.requests[0] as { messages: { content: unknown }[] };
    const content = wire.messages
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    const quoteLine = content
      .split("\n")
      .find((line) => line.startsWith('{"type":"telegram_reply"'));
    assert.ok(quoteLine, "the provider receives the reply context");
    const quote = JSON.parse(quoteLine) as { text: string };
    assert.equal(quote.text, notice);
    assert.match(content, /"source":"assistant"/u);
    assert.match(content, /"untrusted":false/u);
    assert.doesNotMatch(content, /"untrusted":true/u);
    assert.equal(
      sends().length,
      2,
      "one watchdog and one progress despite two intermediate texts",
    );
    assert.equal(String(sends()[1].chat), String(OWNER));
    assert.equal(sends()[1].body.disable_notification, true);
    release();
    await waitFor(() =>
      sends().some((r) => r.body.text === "WATCHDOG_EXPLAINED"),
    );
    await settledChat(h);
    const foreign = message(402, "explain this foreign quote");
    h.telegram.push({
      ...foreign,
      message: {
        ...foreign.message,
        reply_to_message: {
          message_id: 42,
          from: { id: 999, is_bot: true, username: "smoke_bot" },
          text: "FOREIGN_QUOTE_MARKER",
        },
      },
    });
    await waitFor(() =>
      sends().some((r) => r.body.text === "FOREIGN_QUOTE_EXPLAINED"),
    );
    assert.match(JSON.stringify(h.provider.requests[3]), /untrusted\\":true/u);
    t.diagnostic(
      `watchdog reply first durable message: ${firstMessageMs.toFixed(0)}ms (threshold 60000ms)`,
    );
    await h.saveEvidence("notice-reply");
    h.pass();
  },
);

void test(
  "S-chat-reply: one reply and one provider request despite repeated updates",
  { timeout: 180_000 },
  async (t) => {
    smokeParameters();
    const h = await createHarness(t, [
      { kind: "text", text: "SMOKE_CHAT_REPLY" },
    ]);
    const update = message(102, "smoke unique question");
    h.telegram.push(update);
    const replies = () =>
      h.telegram.requests.filter(
        (r) => r.method === "sendMessage" && r.body.text === "SMOKE_CHAT_REPLY",
      );
    await waitFor(() => replies().length === 1);
    await waitFor(async () => {
      const ledger = JSON.parse(
        await readFile(
          join(h.app, "data/completed-updates.json"),
          "utf8",
        ).catch(() => "{}"),
      ) as { updates?: number[] };
      return ledger.updates?.includes(102);
    });
    // A late HTTP retry must cross the completed-update fence, even after Bridge ownership ended.
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await h.post("/eve/v1/telegram/accepted", update);
      assert.equal(
        response.headers.get("x-iva-telegram-acceptance"),
        "handled",
      );
    }
    const cursor = h.telegram.requests.length;
    h.telegram.push(
      update,
      { ...update, message: { ...update.message, message_id: 101 } },
      update,
    );
    // Replay a completed update with stale message metadata. A new, unseen update_id
    // is a new input, even if a fake server violates the requested offset.
    // Next getUpdates proves the injected batch has passed through the real Bridge.
    await waitFor(
      () =>
        h.telegram.requests
          .slice(cursor)
          .filter((r) => r.method === "getUpdates").length >= 2,
    );
    assert.equal(h.provider.requests.length, 1);
    assert.equal(replies().length, 1);
    assert.equal(String(replies()[0].chat), String(OWNER));
    assert.equal(
      h.telegram.requests.filter((r) => r.method === "sendMessage").length,
      1,
    );
    assert.match(
      JSON.stringify(h.provider.requests[0]),
      /smoke unique question/u,
    );
    assert.equal(replies()[0].topic, undefined);
    h.pass();
  },
);

void test(
  "S-chat-overload: recovery and exhaustion of provider 429",
  { timeout: 120_000 },
  async (t) => {
    smokeParameters();
    const h = await createHarness(t, [
      { kind: "overloaded" },
      { kind: "text", text: "OVERLOAD_RECOVERED" },
      { kind: "overloaded", times: 3 },
      { kind: "text", text: "SESSION_STILL_ALIVE" },
    ]);
    const sends = () =>
      h.telegram.requests.filter((r) => r.method === "sendMessage");
    h.telegram.push(message(201, "recover from one overloaded response"));
    await waitFor(() =>
      sends().some((r) => r.body.text === "OVERLOAD_RECOVERED"),
    );
    assert.equal(
      h.provider.requests.length,
      2,
      "one 429 causes exactly two HTTP requests",
    );
    const log = () => readFile(join(h.root, "process.log"), "utf8");
    const recoveryLog = await log();
    assert.match(recoveryLog, /model call failed transiently.*retrying/u);
    assert.match(recoveryLog, /delayMs: 5000/u);
    assert.equal(sends().length, 1);
    await settledChat(h);

    h.telegram.push(message(202, "exhaust the provider attempts"));
    await waitFor(() => sends().length >= 2, 35_000);
    const failure = sends()[1];
    assert.match(
      String(failure.body.text),
      /(?:limit exhausted|failure on its side)/iu,
    );
    assert.match(
      String(failure.body.text),
      /(?:wait|write again|switch models)/iu,
    );
    assert.equal(String(failure.chat), String(OWNER));
    assert.equal(
      h.provider.requests.length,
      5,
      "exhaustion takes exactly three requests",
    );
    assert.match(
      await log(),
      /model call failed.*parking session for retry by the user/u,
    );
    assert.match(await log(), /delayMs: 15000/u);
    await settledChat(h);

    h.telegram.push(message(203, "answer after the failed turn"));
    await waitFor(() =>
      sends().some((r) => r.body.text === "SESSION_STILL_ALIVE"),
    );
    assert.equal(h.provider.requests.length, 6);
    assert.equal(
      sends().length,
      3,
      "one recovered reply, one failure notice, one next reply",
    );
    assert.equal(
      sends().filter((r) => r.body.text === failure.body.text).length,
      1,
    );
    await h.saveEvidence("overload");
    h.pass();
  },
);

void test(
  "S-chat-reset: reset and ExactCut after Bridge interruption",
  { timeout: 120_000 },
  async (t) => {
    smokeParameters();
    let releaseProvider = () => {};
    const held = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    t.after(() => releaseProvider());
    const h = await createHarness(
      t,
      [
        { kind: "text", text: "BEFORE_RESET_REPLY" },
        { kind: "text", text: "INTERRUPTED_REPLY", waitFor: held },
        { kind: "text", text: "AFTER_RESET_REPLY" },
        { kind: "text", text: "EXACTCUT_VERIFIED" },
      ],
      async (app, env) => {
        // Delay the real resolver at the same boundary as telegram-reset-{restart,mixed}.
        // The route, sessions, storage, HTTP requests and Bridge commands remain real.
        const preload = join(app, "reset-delay.ts");
        await writeFile(preload, resetDelaySource);
        env.NODE_OPTIONS += ` --import=${preload}`;
      },
    );
    assert.equal(
      await readFile(join(h.app, "reset-hook-ready"), "utf8"),
      "ready",
    );
    const sends = () =>
      h.telegram.requests.filter((r) => r.method === "sendMessage");
    h.telegram.push(message(301, "BEFORE_RESET_PRIVATE_MARKER"));
    await waitFor(() =>
      sends().some((r) => r.body.text === "BEFORE_RESET_REPLY"),
    );
    await settledChat(h);
    h.telegram.push(message(302, "OLD_BUSY_PRIVATE_MARKER"));
    await waitFor(() => h.provider.requests.length === 2);
    const recordFile = join(
      h.app,
      "data/run-status.d",
      Buffer.from(`${OWNER}:`).toString("base64url") + ".json",
    );
    const record = async () =>
      JSON.parse(await readFile(recordFile, "utf8")) as { sessionId: string };
    const previousId = (await record()).sessionId;
    assert.ok(previousId);
    await kill(h.bridge);

    // A recovery request from the old Bridge already read an address-only intent.
    // This is the real queue operation used by the historical recovery writer.
    await writeFile(join(h.app, "reset-arm"), "armed");
    const old = h.start([
      "--input-type=module",
      "--eval",
      `
      const q = await import('./scripts/poller/main.ts');
      await q.performScopedReset('${OWNER}:', {address:{chatId:'${OWNER}'}},
        {clearQueue:true,discardThroughUpdateId:303});
    `,
    ]);
    await waitFor(() =>
      readFile(join(h.app, "reset-entered"), "utf8").catch(() => ""),
    );
    assert.equal(
      (await readdir(join(h.app, "data/telegram-reset-intents"))).length,
      1,
    );
    await kill(old, "SIGKILL");
    assert.equal(old.signalCode, "SIGKILL");

    // Force the mixed ordering: the restarted Bridge handles a new /new before
    // its scan of the older intent. Both paths execute real product operations.
    const reset = message(304, "/new");
    const recovered = h.start([
      "--input-type=module",
      "--eval",
      `
      const q = await import('./scripts/poller/main.ts');
      await q.processTelegramUpdate(${JSON.stringify(reset)}, 304);
      await import('./scripts/smoke/bridge.ts');
    `,
    ]);
    await waitFor(() =>
      h.telegram.requests.some(
        (r) =>
          r.method === "editMessageText" &&
          String(r.body.text).includes("New conversation ready"),
      ),
    );
    const confirmations = () =>
      h.telegram.requests.filter(
        (r) =>
          r.method === "editMessageText" &&
          String(r.body.text).includes("New conversation ready"),
      );
    assert.equal(confirmations().length, 1);
    const pending = sends().filter((r) =>
      String(r.body.text).includes("Starting a new conversation"),
    );
    assert.equal(
      pending.length,
      1,
      "one confirmation message, edited in place",
    );
    assert.ok(Number.isSafeInteger(confirmations()[0].body.message_id));
    assert.match(
      await readFile(join(h.root, "process.log"), "utf8"),
      new RegExp(`reset for chat ${OWNER}: -> reset \\(${previousId}\\)`, "u"),
    );
    releaseProvider();

    h.telegram.push(message(305, "AFTER_RESET_PRIVATE_MARKER"));
    await waitFor(() =>
      sends().some((r) => r.body.text === "AFTER_RESET_REPLY"),
    );
    assert.doesNotMatch(
      JSON.stringify(h.provider.requests[2]),
      /BEFORE_RESET_PRIVATE_MARKER|OLD_BUSY_PRIVATE_MARKER/u,
    );
    assert.match(
      JSON.stringify(h.provider.requests[2]),
      /AFTER_RESET_PRIVATE_MARKER/u,
    );

    await writeFile(join(h.app, "reset-release"), "release");
    await waitFor(
      async () =>
        (await readFile(join(h.app, "reset-outcomes"), "utf8").catch(() => ""))
          .trim()
          .split("\n").length === 2,
    );
    assert.deepEqual(
      (await readFile(join(h.app, "reset-outcomes"), "utf8"))
        .trim()
        .split("\n"),
      ["reset", "no_active_session"],
      "ExactCut: late address reset is inert after sessionId reset",
    );
    await settledChat(h);
    h.telegram.push(message(306, "verify the post-cut conversation"));
    await waitFor(() =>
      sends().some((r) => r.body.text === "EXACTCUT_VERIFIED"),
    );
    assert.match(
      JSON.stringify(h.provider.requests[3]),
      /AFTER_RESET_PRIVATE_MARKER/u,
    );
    assert.equal(confirmations().length, 1);
    assert.equal(h.provider.requests.length, 4);
    assert.equal(recovered.exitCode, null);
    await h.saveEvidence("reset");
    h.pass();
  },
);

// Test preload: wrap the installed eve resolver, preserving its real implementation.
// Fail loudly if the installed export changes; a missed interception must never pass.
const resetDelaySource = `
import {registerHooks} from 'node:module';
import {existsSync, writeFileSync, appendFileSync} from 'node:fs';
let intercepted = false;
globalThis.smokeResetDelay = async (resolve, address) => {
  if (existsSync('reset-arm') && !intercepted) {
    intercepted = true;
    writeFileSync('reset-entered', address);
    await new Promise(done => {
      const timer = setInterval(() => {
        if (existsSync('reset-release')) { clearInterval(timer); done(); }
      }, 25);
    });
  }
  return resolve(address);
};
const json = Response.json;
Response.json = function(value, init) {
  if (value?.ok === true && ['reset','no_active_session'].includes(value.status))
    { appendFileSync('reset-outcomes', value.status + '\\n'); console.error('[smoke] reset response:', value.status); }
  return json.call(this, value, init);
};
registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/channel/channel-operations.js') || url.endsWith('/_libs/eve+zod.mjs')) {
    const source = String(result.source);
    if (!source.includes('function createChannelOperations(')) throw Error('Missing real resolver export');
    writeFileSync('reset-hook-ready', 'ready');
    return {...result, source: source.replace('function createChannelOperations(', 'function originalOperations(') +
      '\\nfunction createChannelOperations(input) { const ops = originalOperations(input); const resolve = ops.resolveSession.bind(ops); return {...ops, resolveSession: address => globalThis.smokeResetDelay(resolve, address)}; }'};
  }
  return result;
}});
`;

async function settledChat(h: Awaited<ReturnType<typeof createHarness>>) {
  const recordFile = join(
    h.app,
    "data/run-status.d",
    Buffer.from(`${OWNER}:`).toString("base64url") + ".json",
  );
  await waitFor(
    async () =>
      (JSON.parse(await readFile(recordFile, "utf8")) as { status: string })
        .status === "idle",
  );
  const cursor = h.telegram.requests.length;
  await waitFor(
    () =>
      h.telegram.requests.slice(cursor).filter((r) => r.method === "getUpdates")
        .length >= 2,
  );
}
