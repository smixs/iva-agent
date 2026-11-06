import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type { TurnStreamEvent } from "../lib/reminder-turn.ts";
import { dispatchCli } from "./main.ts";
import {
  createRemindCommand,
  type RemindDependencies,
  type ReminderClientOptions,
  type ReminderTurn,
} from "./remind.ts";
import { createCliRuntime } from "./runtime.ts";

// REPRODUCING A FAILURE: fast-check prints
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Pass seed and path to fc.assert to replay the same generated case and shrink path.
const RUNS = { numRuns: 500 };
const ROOT = "/tmp/iva-cli-remind-test";

void test("iva remind delivers model buttons through sendRichMessage", async () => {
  const { sendTelegramHtml } = await import("../lib/telegram-send.ts");
  const text =
    '<tg-button-row><tg-button type="callback_data" data="Да">Да</tg-button></tg-button-row>';
  const requests: { url: string; body: unknown }[] = [];
  const remind = createRemindCommand(createCliRuntime(ROOT), {
    readEnv: () =>
      Promise.resolve({
        TELEGRAM_BOT_TOKEN: "test-bot",
        TELEGRAM_DIGEST_CHAT_ID: "555",
        ASSISTANT_BEARER: "test-bearer",
      }),
    runAgentTurn: () =>
      Promise.resolve({
        status: "completed",
        message: text,
        feedback: () => Promise.resolve(),
      }),
    send: (bot, chat, reply, options) =>
      sendTelegramHtml(bot, chat, reply, {
        ...options,
        fetchImpl: (url, init) => {
          const address =
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url;
          const body = init?.body;
          assert.ok(typeof body === "string");
          requests.push({
            url: address,
            body: JSON.parse(body),
          });
          return Promise.resolve(new Response("", { status: 200 }));
        },
      }),
  });
  await remind(["Пришли кнопку Да"]);
  assert.deepEqual(requests, [
    {
      url: "https://api.telegram.org/bottest-bot/sendRichMessage",
      body: { chat_id: "555", rich_message: { markdown: text } },
    },
  ]);
});

type AgentOutcome = "ok" | "empty" | "failed" | "throw";
type SendResult = { ok: boolean; fellBack: boolean; error: string };
type SendCall = readonly [
  bot: string,
  chat: string,
  text: unknown,
  options:
    { readonly retryTransient?: boolean; readonly rich?: boolean } | undefined,
];

// The turn reads its client's response as a stream, so a fake client answers with an async
// iterable of events plus eve's cooperative cancel and the session id a stop would use.
function fakeTurnResponse(events: readonly TurnStreamEvent[]) {
  let index = 0;
  return Object.assign(
    {
      [Symbol.asyncIterator]: (): AsyncIterator<TurnStreamEvent> => ({
        next: () => {
          const event = events[index];
          index += 1;
          return Promise.resolve(
            event === undefined
              ? { done: true, value: undefined }
              : { done: false, value: event },
          );
        },
      }),
    },
    { cancel: () => Promise.resolve(), sessionId: "sess-remind" },
  );
}

function remindCommand(
  agentOutcome: AgentOutcome,
  sendResult: SendResult = { ok: true, fellBack: false, error: "" },
  env: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
    ASSISTANT_BEARER: "bearer-from-dotenv",
  },
) {
  const sent: SendCall[] = [];
  const prompts: string[] = [];
  const feedback: string[] = [];
  const closed: string[] = [];
  const read: string[] = [];
  const messages: string[] = [];
  let feedbackError: Error | undefined;
  let closeError: Error | undefined;
  const base = createCliRuntime(ROOT);
  const dependencies: RemindDependencies = {
    readEnv: (path) => {
      read.push(path);
      return Promise.resolve(env);
    },
    send: (bot, chat, md, options) => {
      sent.push([bot, chat, md, options]);
      return Promise.resolve(sendResult);
    },
    runAgentTurn: async (prompt): Promise<ReminderTurn> => {
      prompts.push(prompt);
      if (agentOutcome === "throw")
        return Promise.reject(new Error("eve unavailable"));
      try {
        if (agentOutcome === "failed")
          return {
            status: "failed",
            message: "ignore me",
            feedback: async () => {},
          };
        if (agentOutcome === "empty")
          return { status: "waiting", message: "", feedback: async () => {} };
        return {
          status: "waiting",
          message: "Короткое напоминание",
          feedback: (message) => {
            if (feedbackError) return Promise.reject(feedbackError);
            feedback.push(message);
            return Promise.resolve();
          },
        };
      } finally {
        closed.push("closed");
        if (closeError) {
          // Mirrors production cleanup: a failed reset never changes the turn.
        }
      }
    },
  };
  const cmdRemind = createRemindCommand(
    {
      ...base,
      ok: (message) => {
        messages.push(message);
      },
    },
    dependencies,
  );
  return {
    cmdRemind,
    closed,
    envPath: base.ENV_PATH,
    failFeedback: (error: Error) => {
      feedbackError = error;
    },
    failClose: (error: Error) => {
      closeError = error;
    },
    feedback,
    messages,
    prompts,
    read,
    sent,
  };
}

void test("a failed agent turn sends the raw Reminder once", async () => {
  const remind = remindCommand("failed");

  await remind.cmdRemind(["Позвонить", "врачу"]);

  assert.deepEqual(remind.read, [remind.envPath]);
  assert.equal(remind.prompts.length, 1);
  assert.match(
    remind.prompts[0],
    /Reminder fired[\s\S]*Do not send anything yourself/u,
  );
  assert.deepEqual(remind.sent, [
    [
      "bot-token",
      "555",
      "⏰ Позвонить врачу",
      { retryTransient: true, rich: true },
    ],
  ]);
  assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
});

void test("a plain fallback reports formatting feedback to the same turn", async () => {
  const remind = remindCommand("ok", {
    ok: true,
    fellBack: true,
    error: "400: bad entities",
  });

  await remind.cmdRemind(["Проверить", "задачу"]);

  assert.equal(remind.sent[0][2], "Короткое напоминание");
  assert.deepEqual(remind.feedback, [
    "The last reminder failed Telegram parse_mode=HTML (400: bad entities) and was sent as plain text — " +
      "format more simply next time: **bold**, `code`, lists, no raw HTML.",
  ]);
});

void test("a lost feedback turn does not fail a delivered Reminder", async () => {
  const remind = remindCommand("ok", {
    ok: true,
    fellBack: true,
    error: "400: bad entities",
  });
  remind.failFeedback(new Error("eve went away"));

  await remind.cmdRemind(["Проверить", "задачу"]);

  assert.equal(remind.sent.length, 1);
  assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
});

void test("a refused Reminder send reports the Telegram error and exits one", async () => {
  const remind = remindCommand("ok", {
    ok: false,
    fellBack: false,
    error: "503: unavailable",
  });
  const events: string[] = [];

  await assert.rejects(
    dispatchCli(
      ["remind", "текст"],
      { remind: remind.cmdRemind },
      {
        bad: (message) => events.push(`bad:${message}`),
        help: assert.fail,
        exit: (code): never => {
          events.push(`exit:${code}`);
          throw new Error(`exit ${code}`);
        },
      },
    ),
    { message: "exit 1" },
  );

  assert.deepEqual(events, [
    "bad:Reminder Telegram send failed: 503: unavailable",
    "exit:1",
  ]);
  assert.equal(remind.sent.length, 1);
  assert.deepEqual(remind.closed, ["closed"]);
});

void test("a session reset failure does not fail a delivered Reminder", async () => {
  const sent: SendCall[] = [];
  const resetReasons: string[] = [];
  const messages: string[] = [];
  const base = createCliRuntime(ROOT);
  const cmdRemind = createRemindCommand(
    {
      ...base,
      ok: (message) => messages.push(message),
    },
    {
      createClient: () =>
        Promise.resolve({
          sessions: {
            create: () =>
              Promise.resolve({
                response: fakeTurnResponse([
                  {
                    type: "message.completed",
                    data: { message: "Короткое напоминание" },
                  },
                  { type: "session.waiting" },
                ]),
                session: {
                  send: () => Promise.resolve(),
                  cancel: () => Promise.resolve(),
                  reset: ({ reason }) => {
                    resetReasons.push(reason);
                    return Promise.reject(new Error("reset unavailable"));
                  },
                },
              }),
          },
        }),
      readEnv: () =>
        Promise.resolve({
          TELEGRAM_BOT_TOKEN: "bot-token",
          TELEGRAM_DIGEST_CHAT_ID: "555",
          ASSISTANT_BEARER: "bearer-from-dotenv",
        }),
      send: (bot, chat, md, options) => {
        sent.push([bot, chat, md, options]);
        return Promise.resolve({ ok: true, fellBack: false, error: "" });
      },
    },
  );

  await cmdRemind(["Проверить", "задачу"]);

  assert.deepEqual(resetReasons, ["Reminder finished"]);
  assert.deepEqual(sent, [
    [
      "bot-token",
      "555",
      "Короткое напоминание",
      { retryTransient: true, rich: true },
    ],
  ]);
  assert.deepEqual(messages, ["Reminder sent to Telegram"]);
});

void test("the eve client is built from .env, not process.env", async () => {
  const savedBearer = process.env.ASSISTANT_BEARER;
  const savedPort = process.env.IVA_PORT;
  process.env.ASSISTANT_BEARER = "bearer-from-process";
  process.env.IVA_PORT = "1111";
  try {
    const sent: SendCall[] = [];
    const messages: string[] = [];
    const captured: ReminderClientOptions[] = [];
    const base = createCliRuntime(ROOT);
    const cmdRemind = createRemindCommand(
      {
        ...base,
        ok: (message) => messages.push(message),
      },
      {
        readEnv: () =>
          Promise.resolve({
            TELEGRAM_BOT_TOKEN: "bot-token",
            TELEGRAM_DIGEST_CHAT_ID: "555",
            ASSISTANT_BEARER: "bearer-from-dotenv",
            IVA_PORT: "2222",
          }),
        createClient: (options) => {
          captured.push(options);
          return Promise.resolve({
            sessions: {
              create: () =>
                Promise.resolve({
                  response: fakeTurnResponse([
                    {
                      type: "message.completed",
                      data: { message: "Короткое напоминание" },
                    },
                    { type: "session.waiting" },
                  ]),
                  session: {
                    send: () => Promise.resolve(),
                    cancel: () => Promise.resolve(),
                    reset: () => Promise.resolve(),
                  },
                }),
            },
          });
        },
        send: (bot, chat, md, options) => {
          sent.push([bot, chat, md, options]);
          return Promise.resolve({ ok: true, fellBack: false, error: "" });
        },
      },
    );

    await cmdRemind(["Проверить", "задачу"]);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].host, "http://127.0.0.1:2222");
    assert.equal(await captured[0].auth.bearer(), "bearer-from-dotenv");
    assert.deepEqual(sent, [
      [
        "bot-token",
        "555",
        "Короткое напоминание",
        { retryTransient: true, rich: true },
      ],
    ]);
    assert.deepEqual(messages, ["Reminder sent to Telegram"]);
  } finally {
    if (savedBearer === undefined) delete process.env.ASSISTANT_BEARER;
    else process.env.ASSISTANT_BEARER = savedBearer;
    if (savedPort === undefined) delete process.env.IVA_PORT;
    else process.env.IVA_PORT = savedPort;
  }
});

void test("a missing token or chat fails before the agent turn", async () => {
  for (const { env, expected } of [
    {
      env: { TELEGRAM_DIGEST_CHAT_ID: "555" },
      expected: "TELEGRAM_BOT_TOKEN is missing — run: iva config",
    },
    {
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_USER_IDS: " , ",
      },
      expected:
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
    },
    {
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_DIGEST_CHAT_ID: "555",
        ASSISTANT_BEARER: " ",
      },
      expected: "ASSISTANT_BEARER is missing — run: iva doctor",
    },
  ]) {
    const remind = remindCommand(
      "ok",
      { ok: true, fellBack: false, error: "" },
      env,
    );

    await assert.rejects(remind.cmdRemind(["текст"]), { message: expected });
    assert.deepEqual(remind.read, [remind.envPath]);
    assert.deepEqual(remind.prompts, []);
    assert.deepEqual(remind.sent, []);
  }
});

void test("a lost agent turn names its cause on stderr and still delivers the raw text", async (t) => {
  const error = t.mock.method(console, "error");

  for (const { outcome, cause } of [
    { outcome: "throw", cause: /eve unavailable/u },
    { outcome: "failed", cause: /status "failed".*ignore me/u },
    { outcome: "empty", cause: /no text \(status "waiting"\)/u },
  ] as const) {
    error.mock.resetCalls();
    const remind = remindCommand(outcome);

    await remind.cmdRemind(["Позвонить", "врачу"]);

    assert.equal(error.mock.callCount(), 1);
    const line = error.mock.calls[0].arguments.map(String).join(" ");
    assert.match(line, /^remind: agent turn failed: /u);
    assert.match(line, cause);
    assert.deepEqual(remind.sent, [
      [
        "bot-token",
        "555",
        "⏰ Позвонить врачу",
        { retryTransient: true, rich: true },
      ],
    ]);
    assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
  }
});

const reminderText = fc
  .string({ minLength: 1, maxLength: 60, unit: "grapheme" })
  .filter((value) => value.trim().length > 0);
const agentOutcome = fc.constantFrom<AgentOutcome>(
  "ok",
  "empty",
  "failed",
  "throw",
);

void test("property: one content send chooses agent text or the raw fallback", async (t) => {
  const error = t.mock.method(console, "error");
  await fc.assert(
    fc.asyncProperty(
      reminderText,
      agentOutcome,
      fc.boolean(),
      async (generatedText, outcome, sendOk) => {
        error.mock.resetCalls();
        const remind = remindCommand(outcome, {
          ok: sendOk,
          fellBack: false,
          error: sendOk ? "" : "429: retry limit reached",
        });
        let thrown: unknown;

        try {
          await remind.cmdRemind([generatedText]);
        } catch (error) {
          thrown = error;
        }

        assert.equal(remind.sent.length, 1);
        assert.equal(remind.sent[0][3]?.retryTransient, true);
        const expectedText =
          outcome === "ok"
            ? "Короткое напоминание"
            : `⏰ ${generatedText.trim()}`;
        assert.equal(remind.sent[0][2], expectedText);
        assert.equal(
          String(remind.sent[0][2]).startsWith("⏰ "),
          outcome !== "ok",
        );
        assert.equal(thrown === undefined, sendOk);
        assert.equal(error.mock.callCount(), outcome === "ok" ? 0 : 1);
      },
    ),
    RUNS,
  );
});

const whitespaceText = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), {
    maxLength: 30,
  })
  .map((parts) => parts.join(""));

void test("property: empty Unicode whitespace fails before env, eve and Telegram", async () => {
  await fc.assert(
    fc.asyncProperty(whitespaceText, async (text) => {
      const remind = remindCommand("ok");

      await assert.rejects(remind.cmdRemind([text]), {
        message: "Nothing to send — usage: iva remind <text>",
      });
      assert.deepEqual(remind.read, []);
      assert.deepEqual(remind.prompts, []);
      assert.deepEqual(remind.sent, []);
    }),
    RUNS,
  );
});
