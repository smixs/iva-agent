/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  groupCoordKeyOf,
  isConfiguredPeerBot,
  parsePeerBotOrigin,
} from "../../packages/telegram-bots/index.ts";
import {
  assignmentPhase,
  claimInboundPeerAssignment,
  completeInboundPeerAssignment,
  listColleagueAssignments,
  parseAssignmentId,
  sendColleagueAssignment,
} from "./colleague-assignments.ts";
import { colleagueExecuteAsync } from "./colleague-tool.ts";
import {
  colleagueTeamMarkdown,
  withColleague,
  withColleaguesEnabled,
} from "./colleagues.ts";
import { updateSettings } from "./settings.ts";
import { parseTelegramQuiet } from "./telegram-delivery.ts";

const IVA_BOT_ID = "111111111";
const IVA_TOKEN = `${IVA_BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const CRITIC_BOT_ID = "222222222";
const CRITIC_TOKEN = `${CRITIC_BOT_ID}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
const CODER_BOT_ID = "333333333";
const CODER_TOKEN = `${CODER_BOT_ID}:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`;

function makeTestEnv(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: IVA_TOKEN,
    TELEGRAM_BOT_USERNAME: "iva_main_bot",
    TELEGRAM_COLLEAGUE_BOT_TOKENS: `critic_bot=${CRITIC_TOKEN},coder_bot=${CODER_TOKEN}`,
    TELEGRAM_ALLOWED_USER_IDS: "42",
    AGENT_LANGUAGE: "ru",
  };
}

function makeTempFiles() {
  const dir = mkdtempSync(join(tmpdir(), "iva-assignments-unit-"));
  const settingsFile = join(dir, "settings.json");
  const storeFile = join(dir, "colleague-assignments.json");
  updateSettings(
    () =>
      withColleague(
        withColleague(withColleaguesEnabled({}, true), {
          botId: CRITIC_BOT_ID,
          role: "critic",
          provider: "ollama",
          model: "deepseek-v4-pro",
          name: "Критик",
          username: "critic_bot",
        }),
        {
          botId: CODER_BOT_ID,
          role: "programmer",
          provider: "codex",
          model: "gpt-5.5",
          name: "Программист",
          username: "coder_bot",
        },
      ),
    settingsFile,
  );
  return {
    dir,
    settingsFile,
    storeFile,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("property: groupCoordKeyOf aligns all bots in the same group and ignores private chats (seed 20261126)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 9_999_999 }),
      fc.integer({ min: 1, max: 999_999_999 }),
      fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: undefined }),
      (botNum, chatAbs, thread) => {
        const botId = String(botNum);
        const threadPart = thread === undefined ? "" : String(thread);
        const groupBase = `-${chatAbs}:${threadPart}`;
        const groupBot = `bot:${botId}:${groupBase}`;
        assert.equal(
          groupCoordKeyOf(groupBase),
          `group:-${chatAbs}:${threadPart}`,
        );
        assert.equal(groupCoordKeyOf(groupBot), groupCoordKeyOf(groupBase));

        const privateBase = `${chatAbs}:${threadPart}`;
        const privateBot = `bot:${botId}:${privateBase}`;
        assert.equal(groupCoordKeyOf(privateBase), null);
        assert.equal(groupCoordKeyOf(privateBot), null);
      },
    ),
    { seed: 20261126, numRuns: 100 },
  );
});

test("property: parseTelegramQuiet matches only leading <!-- iva:none --> markers (seed 20261126)", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("", " ", "\n", "  \n"),
      fc.constantFrom("", "\n", "\r\n"),
      fc.string({ maxLength: 60 }),
      (lead, sep, note) => {
        const payload = `${lead}<!-- iva:none -->${sep}${note}`;
        const parsed = parseTelegramQuiet(payload);
        if (sep === "" && note.length > 0) {
          assert.equal(parsed.quiet, false);
        } else {
          assert.equal(parsed.quiet, true);
          assert.equal(parsed.note, note.trim());
        }
      },
    ),
    { seed: 20261126, numRuns: 100 },
  );
  assert.deepEqual(parseTelegramQuiet("<!-- iva:silent -->\nтихо"), {
    quiet: false,
    note: "",
  });
  assert.deepEqual(parseTelegramQuiet("Текст\n<!-- iva:none -->"), {
    quiet: false,
    note: "",
  });
});

test("isConfiguredPeerBot accepts configured peer bots and rejects self and unknown bots", () => {
  const env = makeTestEnv();
  assert.equal(
    isConfiguredPeerBot(CRITIC_BOT_ID, IVA_BOT_ID, env)?.botId,
    CRITIC_BOT_ID,
  );
  assert.equal(
    isConfiguredPeerBot(IVA_BOT_ID, CRITIC_BOT_ID, env)?.botId,
    IVA_BOT_ID,
  );
  assert.equal(isConfiguredPeerBot(IVA_BOT_ID, IVA_BOT_ID, env), null);
  assert.equal(isConfiguredPeerBot(CRITIC_BOT_ID, CRITIC_BOT_ID, env), null);
  assert.equal(isConfiguredPeerBot("999999999", IVA_BOT_ID, env), null);
  assert.deepEqual(
    parsePeerBotOrigin({ botId: CRITIC_BOT_ID, username: "@critic_bot" }),
    { botId: CRITIC_BOT_ID, username: "critic_bot" },
  );
  assert.equal(parsePeerBotOrigin({ botId: "bad" }), null);
});

test("sendColleagueAssignment sends Bot API DM and visible owner line in colleague chat, redacting secrets", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();
    const calls: Array<{
      readonly token: string;
      readonly method: string;
      readonly body: Record<string, unknown>;
    }> = [];
    let msgSeq = 100;
    const fetchImpl: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match, `unexpected Bot API URL: ${url}`);
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      calls.push({ token: match[1], method: match[2], body });
      msgSeq += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: msgSeq } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const sent = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: `Проверь архитектуру (не утекай токен ${CRITIC_TOKEN})`,
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(sent.ok, true);
    assert.equal(assignmentPhase(sent.assignment), "delivered");
    assert.equal(sent.assignment.ownerNotified, true);
    assert.equal(calls.length, 2);

    // 1. DM from Iva to Critic via Bot API
    assert.equal(calls[0]?.token, IVA_TOKEN);
    assert.equal(calls[0]?.method, "sendMessage");
    assert.equal(calls[0]?.body.chat_id, Number(CRITIC_BOT_ID));
    const dmText =
      typeof calls[0]?.body.text === "string" ? calls[0].body.text : "";
    assert.equal(parseAssignmentId(dmText), sent.assignment.id);
    assert.ok(dmText.includes("Проверь архитектуру"));
    assert.ok(!dmText.includes(CRITIC_TOKEN), "secret must be redacted in DM");

    // 2. Owner-visible line in Critic's private chat with owner
    assert.equal(calls[1]?.token, CRITIC_TOKEN);
    assert.equal(calls[1]?.method, "sendMessage");
    assert.equal(calls[1]?.body.chat_id, "42");
    const noticeText =
      typeof calls[1]?.body.text === "string" ? calls[1].body.text : "";
    assert.match(noticeText, /Поручение \(Ива \(@iva_main_bot\) → Критик/u);
    assert.ok(
      !noticeText.includes(CRITIC_TOKEN),
      "secret must be redacted in owner notice",
    );

    // Claiming on inbound does NOT send a duplicate owner notice; completing prevents replay.
    const claimed = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 101,
      text: dmText,
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(claimed.duplicate, false);
    assert.equal(calls.length, 2, "owner notice must not be sent twice");

    await completeInboundPeerAssignment(claimed.assignmentId, { storeFile });
    const replayed = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 101,
      text: dmText,
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(replayed.duplicate, true);
    assert.equal(assignmentPhase(replayed.record), "done");

    const rows = await listColleagueAssignments(storeFile);
    assert.equal(rows.length, 1);
  } finally {
    cleanup();
  }
});

test("sendColleagueAssignment rejects self-assignment, disabled option, unknown bot, and records DM failure", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();
    const selfRes = await sendColleagueAssignment({
      fromBotId: CRITIC_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "self",
      env,
      settingsFile,
      storeFile,
    });
    assert.equal(selfRes.ok, false);

    const unknownRes = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: "999999999",
      task: "unknown",
      env,
      settingsFile,
      storeFile,
    });
    assert.equal(unknownRes.ok, false);

    let callCount = 0;
    const failFetch: typeof fetch = () => {
      callCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: false, description: "Forbidden: bot blocked" }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const failed = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "check",
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl: failFetch,
    });
    assert.equal(failed.ok, false);
    assert.equal(callCount, 1, "failed DM must not send owner notice");
    assert.equal(failed.assignment?.phase, "failed");

    updateSettings((cur) => withColleaguesEnabled(cur, false), settingsFile);
    const disabledRes = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "off",
      env,
      settingsFile,
      storeFile,
    });
    assert.equal(disabledRes.ok, false);
  } finally {
    cleanup();
  }
});

test("colleagueExecuteAsync delegate works in Telegram turns and blocks Helper turns; team markdown lists roster", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      calls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const helperCtx = {
      session: {
        auth: {
          initiator: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: "helper" },
          },
          current: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: "helper" },
          },
        },
      },
    };
    const denied = await colleagueExecuteAsync(
      { action: "delegate", bot_id: CRITIC_BOT_ID, task: "check" },
      helperCtx,
      { env, settingsFile, storeFile, fetchImpl },
    );
    assert.equal(denied.ok, false);
    assert.equal(calls.length, 0);

    const groupCtx = {
      session: {
        auth: {
          initiator: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "supergroup", user_id: "42" },
          },
          current: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "supergroup", user_id: "42" },
          },
        },
      },
    };
    const ok = await colleagueExecuteAsync(
      {
        action: "delegate",
        bot_id: CODER_BOT_ID,
        task: "Собери воспроизведение бага",
      },
      groupCtx,
      { env, settingsFile, storeFile, fetchImpl },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.assignment?.fromBotId, IVA_BOT_ID);
    assert.equal(ok.assignment?.toBotId, CODER_BOT_ID);
    assert.equal(calls.length, 2);

    const teamMd = colleagueTeamMarkdown(CRITIC_BOT_ID, env, settingsFile);
    assert.ok(teamMd.includes("<!-- iva:none -->"));
    assert.ok(teamMd.includes("no round limit"));
    assert.ok(teamMd.includes(CODER_BOT_ID));
    assert.ok(teamMd.includes("(you)"));
  } finally {
    cleanup();
  }
});

test("sendColleagueAssignment + claimInboundPeerAssignment send at most one owner notice in both delivery orders", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();

    // Order 1 (return #3a): DM is delivered and claimed+completed by receiver BEFORE
    // Bot API returns the sendMessage response to the sender.
    const callsOrder1: Array<{
      readonly kind: "bot-dm" | "owner-notice";
      readonly token: string;
      readonly chatId: string;
    }> = [];
    let msgSeq = 700;
    const fetchOrder1: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match);
      const token = match[1];
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      const chatId =
        typeof body.chat_id === "string" || typeof body.chat_id === "number"
          ? String(body.chat_id)
          : "";
      const text = typeof body.text === "string" ? body.text : "";
      const isDm = token === IVA_TOKEN && chatId === CRITIC_BOT_ID;
      callsOrder1.push({
        kind: isDm ? "bot-dm" : "owner-notice",
        token,
        chatId,
      });
      msgSeq += 1;
      const myMsgId = msgSeq;
      if (isDm) {
        const claimed = await claimInboundPeerAssignment({
          fromBotId: IVA_BOT_ID,
          toBotId: CRITIC_BOT_ID,
          messageId: myMsgId,
          text,
          ownerChatId: "42",
          env,
          settingsFile,
          storeFile,
          fetchImpl: fetchOrder1,
        });
        assert.equal(claimed.duplicate, false);
        await completeInboundPeerAssignment(claimed.assignmentId, { storeFile });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: myMsgId } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const sent1 = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "Проверь порядок доставки до ответа отправителю",
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl: fetchOrder1,
    });
    assert.equal(sent1.ok, true);
    assert.equal(sent1.assignment.ownerNotified, true);
    assert.equal(sent1.assignment.phase, "done");
    assert.deepEqual(
      callsOrder1.map((c) => c.kind),
      ["bot-dm", "owner-notice"],
      "receiver-first delivery must still emit exactly one owner-notice",
    );

    // Order 2: sender has claimed owner-notice and its HTTP request is still in-flight
    // when receiver calls claimInboundPeerAssignment concurrently.
    const callsOrder2: Array<{ readonly kind: "bot-dm" | "owner-notice" }> = [];
    let dmTextOrder2 = "";
    let releaseSenderNotice!: () => void;
    const senderNoticeStarted = new Promise<void>((resolve) => {
      let resolved = false;
      releaseSenderNotice = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
    });
    let allowSenderNoticeFinish!: () => void;
    const waitSenderNoticeFinish = new Promise<void>((resolve) => {
      allowSenderNoticeFinish = resolve;
    });

    const fetchOrder2: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match);
      const token = match[1];
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      const chatId =
        typeof body.chat_id === "string" || typeof body.chat_id === "number"
          ? String(body.chat_id)
          : "";
      const isDm = token === IVA_TOKEN && chatId === CRITIC_BOT_ID;
      callsOrder2.push({ kind: isDm ? "bot-dm" : "owner-notice" });
      msgSeq += 1;
      if (isDm) {
        dmTextOrder2 = typeof body.text === "string" ? body.text : "";
      } else {
        releaseSenderNotice();
        await waitSenderNoticeFinish;
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: msgSeq } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const senderPromise = sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "Конкурентная проверка слота уведомления владельца",
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl: fetchOrder2,
    });
    await senderNoticeStarted;
    const concurrentClaim = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 999,
      text: dmTextOrder2,
      ownerChatId: "42",
      env,
      settingsFile,
      storeFile,
      fetchImpl: fetchOrder2,
    });
    assert.equal(concurrentClaim.duplicate, false);
    allowSenderNoticeFinish();
    const sent2 = await senderPromise;
    assert.equal(sent2.ok, true);
    assert.equal(sent2.assignment.ownerNotified, true);
    assert.deepEqual(
      callsOrder2.map((c) => c.kind),
      ["bot-dm", "owner-notice"],
      "in-flight sender owner-notice must prevent duplicate receiver owner-notice",
    );
  } finally {
    cleanup();
  }
});

test("owner notice uses the owner's private chat instead of digest chat, including receiver-first delivery", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = {
      ...makeTestEnv(),
      TELEGRAM_DIGEST_CHAT_ID: "-100998",
    };
    const calls: Array<{
      readonly token: string;
      readonly chatId: string;
      readonly text: string;
    }> = [];
    let msgSeq = 900;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match, `unexpected Bot API URL: ${url}`);
      const token = match[1];
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      const chatId =
        typeof body.chat_id === "string" || typeof body.chat_id === "number"
          ? String(body.chat_id)
          : "";
      const text = typeof body.text === "string" ? body.text : "";
      calls.push({ token, chatId, text });
      msgSeq += 1;
      const messageId = msgSeq;
      if (token === IVA_TOKEN && chatId === CRITIC_BOT_ID) {
        const claimed = await claimInboundPeerAssignment({
          fromBotId: IVA_BOT_ID,
          toBotId: CRITIC_BOT_ID,
          messageId,
          text,
          env,
          settingsFile,
          storeFile,
          fetchImpl,
        });
        assert.equal(claimed.duplicate, false);
        await completeInboundPeerAssignment(claimed.assignmentId, { storeFile });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: messageId } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const sent = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "Проверь адрес строки владельцу при отдельном digest-чате",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });

    assert.equal(sent.ok, true);
    const ownerNotices = calls.filter((call) => call.token === CRITIC_TOKEN);
    assert.equal(ownerNotices.length, 1);
    assert.equal(ownerNotices[0]?.chatId, "42");
    assert.equal(
      calls.some((call) => call.chatId === "-100998"),
      false,
      "owner notice must not use TELEGRAM_DIGEST_CHAT_ID",
    );
    assert.equal(
      ownerNotices.some(
        (call) => call.chatId === IVA_BOT_ID || call.chatId === CRITIC_BOT_ID,
      ),
      false,
      "owner notice must not be sent to a bot chat",
    );
  } finally {
    cleanup();
  }
});

test("confirmed 429 owner-notice rejection releases the claim and a receiver pass retries it exactly once", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();
    let dmText = "";
    let ownerNoticeAttempts = 0;
    let acceptedOwnerNotices = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match, `unexpected Bot API URL: ${url}`);
      const token = match[1];
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      const chatId =
        typeof body.chat_id === "string" || typeof body.chat_id === "number"
          ? String(body.chat_id)
          : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (token === IVA_TOKEN && chatId === CRITIC_BOT_ID) {
        dmText = text;
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1001 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(token, CRITIC_TOKEN);
      assert.equal(chatId, "42");
      ownerNoticeAttempts += 1;
      if (ownerNoticeAttempts === 1) {
        return new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      acceptedOwnerNotices += 1;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1002 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const sent = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "Проверь повтор строки владельцу после подтверждённого 429",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.assignment.ownerNotified, false);
    assert.notEqual(
      sent.assignment.ownerNoticeClaimed,
      true,
      "confirmed rejection must release the owner-notice CAS slot",
    );
    assert.equal(ownerNoticeAttempts, 1);
    assert.notEqual(dmText, "");

    const firstClaim = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 1001,
      text: dmText,
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(firstClaim.duplicate, false);
    await completeInboundPeerAssignment(firstClaim.assignmentId, { storeFile });
    const secondClaim = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 1001,
      text: dmText,
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });

    assert.equal(secondClaim.duplicate, true);
    assert.equal(ownerNoticeAttempts, 2);
    assert.equal(acceptedOwnerNotices, 1);
    const rows = await listColleagueAssignments(storeFile);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ownerNotified, true);
    assert.equal(rows[0]?.ownerNoticeClaimed, true);
  } finally {
    cleanup();
  }
});

test("uncertain owner-notice failure keeps the claim and receiver pass does not duplicate the line", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = makeTestEnv();
    let dmText = "";
    let ownerNoticeAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match, `unexpected Bot API URL: ${url}`);
      const token = match[1];
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      const chatId =
        typeof body.chat_id === "string" || typeof body.chat_id === "number"
          ? String(body.chat_id)
          : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (token === IVA_TOKEN && chatId === CRITIC_BOT_ID) {
        dmText = text;
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1101 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(token, CRITIC_TOKEN);
      assert.equal(chatId, "42");
      ownerNoticeAttempts += 1;
      throw new TypeError("socket hang up");
    };

    const sent = await sendColleagueAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      task: "Проверь, что обрыв сети не освобождает слот строки владельцу",
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.assignment.ownerNotified, false);
    assert.equal(sent.assignment.ownerNoticeClaimed, true);
    assert.equal(ownerNoticeAttempts, 1);

    const firstClaim = await claimInboundPeerAssignment({
      fromBotId: IVA_BOT_ID,
      toBotId: CRITIC_BOT_ID,
      messageId: 1101,
      text: dmText,
      env,
      settingsFile,
      storeFile,
      fetchImpl,
    });
    assert.equal(firstClaim.duplicate, false);
    assert.equal(ownerNoticeAttempts, 1);
    assert.equal(firstClaim.record.ownerNotified, false);
    assert.equal(firstClaim.record.ownerNoticeClaimed, true);
  } finally {
    cleanup();
  }
});

test("colleagueExecuteAsync delegate defaults owner notice to the configured owner chat, not digest or group user id", async () => {
  const { settingsFile, storeFile, cleanup } = makeTempFiles();
  try {
    const env = {
      ...makeTestEnv(),
      TELEGRAM_ALLOWED_USER_IDS: "42,43",
      TELEGRAM_DIGEST_CHAT_ID: "-100998",
    };
    const calls: Array<{ readonly token: string; readonly chatId: string }> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const match = /\/bot([^/]+)\/([A-Za-z0-9_]+)$/u.exec(url);
      assert.ok(match, `unexpected Bot API URL: ${url}`);
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      calls.push({
        token: match[1],
        chatId:
          typeof body.chat_id === "string" || typeof body.chat_id === "number"
            ? String(body.chat_id)
            : "",
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const groupCtx = {
      session: {
        auth: {
          initiator: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "supergroup", user_id: "43" },
          },
          current: {
            authenticator: "telegram-webhook",
            principalType: "user",
            attributes: { chat_type: "supergroup", user_id: "43" },
          },
        },
      },
    };

    const result = await colleagueExecuteAsync(
      { action: "delegate", bot_id: CODER_BOT_ID, task: "Собери факты" },
      groupCtx,
      { env, settingsFile, storeFile, fetchImpl },
    );

    assert.equal(result.ok, true);
    const ownerNotice = calls.find((call) => call.token === CODER_TOKEN);
    assert.equal(ownerNotice?.chatId, "42");
    assert.equal(
      calls.some((call) => call.chatId === "-100998" || call.chatId === "43"),
      false,
      "automatic delegation must not use digest chat or group user id as owner chat",
    );
  } finally {
    cleanup();
  }
});
