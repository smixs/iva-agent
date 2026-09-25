/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- legacy Node test registration and dynamic JavaScript bridge fixtures */
import "../fixtures/rich-menu-style.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import {
  CONTEXT_WINDOW_CONFIGURATION_ERROR,
  ContextWindowConfigurationError,
} from "../../agent/lib/context-window.ts";
import { SUMMARY_PROVIDER_NAMES, modelSummary } from "./model-summary.ts";
import { createTerminalProgress } from "./progress.ts";
import {
  createTelegramUpdateReporter,
  UPDATE_LOADER,
} from "./telegram-status.ts";
import { REPAIR_COMMAND } from "./update-check.ts";

type TelegramBody = {
  disable_notification?: boolean;
  message_id?: number;
  text?: string;
  rich_message?: { markdown?: string };
  entities?: { custom_emoji_id?: string }[];
  reply_markup?: {
    inline_keyboard: { text?: string; callback_data: string }[][];
  };
};
type TelegramCall = { method: string | undefined; body: TelegramBody };
// Финальные экраны обновления стали rich-сообщениями: markdown лежит в rich_message, а
// фазы по-прежнему едут обычным text. Читаем экран одним помощником, как его видит чат.
function screenOf(body?: TelegramBody): string {
  const markdown = body?.rich_message?.markdown;
  return typeof markdown === "string" ? markdown : (body?.text ?? "");
}
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<{
    ok?: boolean;
    result?: unknown;
    description?: string;
    parameters?: { retry_after?: number };
  }>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

test("modelSummary uses configured provider values without runtime defaults", () => {
  assert.deepEqual(
    modelSummary({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.5",
      CODEX_CONTEXT_WINDOW: "272000",
    }),
    {
      provider: "OpenAI",
      model: "gpt-5.5",
      contextWindow: 272000,
      line: "OpenAI · gpt-5.5",
    },
  );
});

test("modelSummary uses the exact context-window resolver", () => {
  const cases = [
    ["ollama", "OLLAMA_CONTEXT_WINDOW"],
    ["opencode", "OPENCODE_CONTEXT_WINDOW"],
    ["openrouter", "OPENROUTER_CONTEXT_WINDOW"],
    ["codex", "CODEX_CONTEXT_WINDOW"],
    ["requesty", "REQUESTY_CONTEXT_WINDOW"],
  ] as const;

  for (const [provider, variable] of cases) {
    assert.equal(
      modelSummary({ MODEL_PROVIDER: provider }).contextWindow,
      null,
    );
    assert.equal(
      modelSummary({ MODEL_PROVIDER: provider, [variable]: "1" }).contextWindow,
      1,
    );
    for (const raw of ["1.5", "1e3", " ", "9007199254740990.5"]) {
      assert.throws(
        () => modelSummary({ MODEL_PROVIDER: provider, [variable]: raw }),
        (error: unknown) => {
          assert.ok(error instanceof ContextWindowConfigurationError);
          assert.equal(error.code, CONTEXT_WINDOW_CONFIGURATION_ERROR);
          assert.equal(error.variable, variable);
          assert.equal(error.value, raw);
          return true;
        },
        `${provider}:${JSON.stringify(raw)}`,
      );
    }
  }
});

// Экран обновления показывает эту строку рядом с версией. Знай он свой набор имён —
// после опечатки он спокойно назвал бы Ollama, пока агент отказывается стартовать.
// Сверка идёт в ОБЕ стороны: лишний ключ здесь так же врёт, как недостающий.
test("modelSummary knows exactly the provider names the runtime accepts", () => {
  assert.deepEqual(
    [...SUMMARY_PROVIDER_NAMES].sort(),
    [...MODEL_PROVIDER_NAMES].sort(),
  );
  for (const name of MODEL_PROVIDER_NAMES) {
    assert.doesNotMatch(
      modelSummary({ MODEL_PROVIDER: name }).line,
      /invalid/,
      name,
    );
  }
  for (const value of ["ollmaa", " ollama", "OLLAMA", ""]) {
    assert.equal(
      modelSummary({ MODEL_PROVIDER: value }).line,
      `invalid (${value}) · ?`,
      JSON.stringify(value),
    );
  }
  // Отсутствие переменной — по-прежнему Ollama, а не отказ.
  assert.equal(modelSummary({}).provider, "Ollama");
});

test("terminal progress is deterministic outside a TTY", () => {
  let output = "";
  const stream = {
    isTTY: false,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({ stream, env: {} });
  progress.start("Saving changes");
  progress.done("Changes saved");
  progress.dispose();
  assert.equal(output, "◇ Saving changes\n✓ Changes saved\n");
});

test("terminal progress restores the cursor when disposed", () => {
  let output = "";
  const stream = {
    isTTY: true,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({
    stream,
    env: { TERM: "xterm" },
    intervalMs: 60_000,
  });
  progress.start("Building");
  progress.dispose();
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI hide-cursor sequence.
  assert.match(output, /\x1b\[\?25l/);
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI show-cursor sequence.
  assert.match(output, /\x1b\[\?25h/);
});

test("Telegram update edits one message through every phase and final result", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.done("fetch");
  await reporter.start("build");
  await reporter.done("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" });
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 3);
  assert.deepEqual(
    edits.map((call) => call.body.message_id),
    [100, 100, 100],
  );
  assert.deepEqual(
    edits.slice(0, 2).map((call) => call.body.entities?.[0]?.custom_emoji_id),
    [UPDATE_LOADER.customEmojiId, UPDATE_LOADER.customEmojiId],
  );
  assert.deepEqual(
    edits.slice(0, 2).map((call) => call.body.text),
    [
      `${UPDATE_LOADER.alt} Получаю обновление`,
      `${UPDATE_LOADER.alt} Собираю Iva`,
    ],
  );
  assert.match(screenOf(edits[2]?.body), /Iva обновлена/);
  assert.match(screenOf(edits[2]?.body), /OpenAI · gpt-5.5/);
  // Финал говорит ту же правду, что и предложение обновиться: настройки и скиллы на
  // месте, правки в коде Ивы не переносятся. Обещания сохранности правок тут нет.
  assert.match(
    screenOf(edits[2]?.body),
    /Настройки, память и ваши скиллы на месте\. Правки в коде Ивы не переносятся\./u,
  );
  assert.equal(edits[2].body.entities, undefined);
});

test("Telegram does not recreate phase messages after the active message was deleted", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText") {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: message to edit not found",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 200 } }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.start("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" });
  reporter.dispose();
  assert.equal(
    calls.filter((call) => call.method === "sendRichMessage").length,
    1,
    "only the final result is recreated",
  );
  // Английский финал - та же строка, ни слова о сохранённых правках.
  const recreated = calls.find((call) => call.method === "sendRichMessage");
  assert.match(
    screenOf(recreated?.body),
    /Settings, memory and your skills stay in place\. Edits to Iva's own code are not carried over\./u,
  );
});

test("Telegram retries 429 without downgrading the custom emoji and deduplicates phase edits", async () => {
  const calls: TelegramCall[] = [];
  let first = true;
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (first) {
      first = false;
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 1 } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.start("fetch");
  await reporter.done("fetch");
  await reporter.done("fetch");
  reporter.dispose();
  assert.equal(calls.length, 2, "one retry and no duplicate edit");
  assert.ok(
    calls.every(
      (call) =>
        call.body.entities?.[0].custom_emoji_id === UPDATE_LOADER.customEmojiId,
    ),
  );
});

test("Telegram falls back to a simple Unicode marker when custom emoji is unavailable", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    if (body.entities) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: custom emoji entities are not allowed",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.start("build");
  reporter.dispose();

  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.entities);
  assert.equal(
    calls[1].body.text,
    `${UPDATE_LOADER.fallback} Getting the update`,
  );
  assert.equal(calls[2].body.text, `${UPDATE_LOADER.fallback} Building Iva`);
  assert.equal(calls[1].body.entities, undefined);
  assert.equal(calls[2].body.entities, undefined);
});

test("Telegram preserves error-like status when selecting the custom emoji fallback", async () => {
  const calls: TelegramCall[] = [];
  const telegramError = {
    message: "Bad Request: custom emoji entities are not allowed",
    status: 400,
  };
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Telegram adapters may reject with a structural API error instead of an Error instance
    if (body.entities) throw telegramError;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  reporter.dispose();

  assert.equal(calls.length, 4);
  assert.ok(calls.slice(0, 3).every((call) => call.body.entities));
  assert.equal(calls[3].body.entities, undefined);
  assert.equal(
    calls[3].body.text,
    `${UPDATE_LOADER.fallback} Getting the update`,
  );
});

test("Telegram update failure replaces the active phase in the same message", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.fail("fetch", "v1");
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.deepEqual(
    calls.map((call) => call.body.message_id),
    [100, 100],
  );
  assert.match(screenOf(calls[1]?.body), /Couldn't get the update/);
  assert.match(screenOf(calls[1]?.body), /still running v1/);
});

test("Telegram says an update is already running in the message it was asked from", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.busy();
  reporter.dispose();

  assert.deepEqual(
    calls.map((call) => call.body.message_id),
    [100, 100],
  );
  assert.match(screenOf(calls[1]?.body), /Обновление уже идёт/u);
});

test("a final Telegram refuses to edit is sent as its own message", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls: TelegramCall[] = [];
  // Neither a deleted message nor a rate limit: a refusal this side has never
  // seen, which used to end the update with the phase still on screen.
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText")
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: FROZEN" }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 200 } }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(
    await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" }),
    true,
  );

  const sent = calls.filter((call) => call.method === "sendRichMessage");
  assert.equal(sent.length, 1, "the user is told the update finished");
  assert.match(screenOf(sent[0]?.body), /Iva updated/);
  assert.match(screenOf(sent[0]?.body), /v1 → v2/);
  assert.equal(sent[0]?.body.disable_notification, true);
  assert.ok(
    errors.some((line) =>
      /update status edit failed: 400 .*FROZEN/u.test(line),
    ),
    errors.join("\n"),
  );
});

test("a final that cannot be delivered at all is reported, not swallowed", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const fetchImpl: MockFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      ok: false,
      description: "Forbidden: bot was blocked",
    }),
  });
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(await reporter.complete({ afterVersion: "v2" }), false);

  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /update status edit failed: 403/u);
  assert.match(errors[1], /update status message failed: 403/u);
});

test("a version reported without the one before it names the version that runs", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(await reporter.complete({ afterVersion: "0.3.19-abc" }), true);

  const final = screenOf(calls.at(-1)?.body);
  assert.match(final, /Iva обновлена/u);
  assert.match(final, /Версия: 0\.3\.19-abc/u);
  assert.doesNotMatch(final, /→/u);
});

test("a refused phase edit is reported and the update carries on", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls: TelegramCall[] = [];
  let failing = true;
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (failing)
      return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, description: "Internal Server Error" }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);

  await reporter.start("build");
  failing = false;
  assert.equal(
    await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" }),
    true,
  );

  assert.ok(
    errors.some((line) => /update status edit failed: 500/u.test(line)),
    errors.join("\n"),
  );
  assert.match(screenOf(calls.at(-1)?.body), /Iva updated/);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
});

test("update callback is acknowledged before any message edit", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: string[] = [];
  mutableGlobal.fetch = async (url) => {
    calls.push(url.split("/").at(-1) ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?test=${Date.now()}`);
    await bridge.handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      data: "iva_update:skip",
      message: { chat: { id: 1 }, message_id: 2 },
    });
    assert.deepEqual(calls, ["answerCallbackQuery", "editMessageText"]);
    assert.deepEqual(
      bridge.resetMessageCopy(
        "/new",
        {
          MODEL_PROVIDER: "codex",
          CODEX_MODEL: "gpt-5.5",
          CODEX_CONTEXT_WINDOW: "272000",
        },
        "ru",
      ),
      {
        pending: "◇ Начинаю новый диалог",
        complete:
          "✨ Новый диалог готов\n\nМодель: OpenAI · gpt-5.5\nКонтекст очищен · окно 272k",
      },
    );
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("up-to-date check shows the model from fresh .env, not this process's snapshot", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousEnv = Object.fromEntries(
    [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "MODEL_PROVIDER",
      "OPENCODE_MODEL",
    ].map((k) => [k, process.env[k]]),
  );
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  // The bridge's snapshot is stale: the /model wizard rewrote .env after this process started.
  process.env.MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL = "stale-model";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 10 } }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?fresh=${Date.now()}`);
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: false,
        localVersion: "1.2.3",
      }),
      envImpl: async () => ({
        MODEL_PROVIDER: "codex",
        CODEX_MODEL: "fresh-model",
      }),
    });
    const edit = calls.find((call) => call.method === "editMessageText");
    assert.match(screenOf(edit?.body), /OpenAI · fresh-model/);
  } finally {
    mutableGlobal.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("manual update offer keeps commit-based behavior and marks a stable release as shown", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result:
          method === "sendMessage" ? { message_id: 10 } : { message_id: 10 },
      }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?manual=${Date.now()}`);
    const marked: string[] = [];
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: true,
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
      }),
      markNotifiedImpl: async (_dataDir: string, version: string) =>
        marked.push(version),
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "editMessageText"],
    );
    // Предложение обновления — rich: обе кнопки стоят в markdown, а не в клавиатуре.
    assert.deepEqual(
      [...screenOf(calls[1]?.body).matchAll(/data="([^"]+)"/gu)].map(
        (match) => match[1],
      ),
      ["iva_update:do", "iva_update:skip"],
    );
    assert.deepEqual(marked, ["1.2.4"]);
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("a post-commit failure reaches the chat with its secret redacted", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  const planted = `api_key=${"z".repeat(24)}`;

  await reporter.postCommitFailure(`systemctl refused: ${planted}`);
  reporter.dispose();

  const text = screenOf(calls.at(-1)?.body);
  assert.match(text, /systemctl refused: \[REDACTED\]/);
  assert.doesNotMatch(text, /zzzz/);
});

// The build output an update dumps into the chat carries whatever the build printed -
// including a key in the shape this installation's provider actually issues.
test("a build failure carrying a real key shape is redacted the same way", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  const key = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;

  await reporter.postCommitFailure(
    `npm run build\n  provider check failed: ${key}\n  exit 1`,
  );
  reporter.dispose();

  const text = screenOf(calls.at(-1)?.body);
  assert.match(text, /provider check failed: \[REDACTED\]/);
  assert.doesNotMatch(text, /sk-or-v1|4f9c1e77/);
});

// Реальный репортер, а не заглушка из теста апдейта: текст отказа собирается ЗДЕСЬ и берёт
// язык из job.locale — языка того, кто нажал /update, — а не из AGENT_LANGUAGE процесса CLI.
test("the update reporter refuses a bad provider in the language of the job", async () => {
  for (const [locale, expected] of [
    ["ru", /Сначала почини MODEL_PROVIDER в \.env \(iva config\)/u],
    ["en", /Fix MODEL_PROVIDER in \.env first \(iva config\)/u],
  ] as const) {
    const calls: TelegramCall[] = [];
    const fetchImpl: MockFetch = async (url, init) => {
      calls.push({
        method: url.split("/").at(-1),
        body: JSON.parse(init.body) as TelegramBody,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const reporter = createTelegramUpdateReporter({
      token: "token",
      job: { chatId: 1, messageId: 100, locale },
      env: {},
      fetchImpl,
    });
    assert.ok(reporter);

    await reporter.badProvider("ollmaa", "ollama, opencode, codex, openrouter");

    const text = screenOf(calls.at(-1)?.body);
    assert.match(text, expected, locale);
    assert.match(text, /"ollmaa"/u, locale);
    assert.match(text, /ollama, opencode, codex, openrouter/u, locale);
    // Это финальный экран: он не должен остаться под лоадером фазы.
    assert.doesNotMatch(text, /Building Iva|Собираю Iva/u, locale);
  }
});

// Терминал причину падения печатал всегда, чат — нет: приходило голое «Couldn't build Iva»
// и «Retry: /update», по которому пользователь жал обновление снова и снова. Хвост причины
// (сообщение ошибки или конец health-лога) теперь едет вместе с отказом.
test("a failed build tells the chat why, redacted and trimmed", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({
      method: url.split("/").at(-1),
      body: JSON.parse(init.body) as TelegramBody,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  await reporter.fail(
    "build",
    "0.3.19",
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config',
  );

  const text = screenOf(calls.at(-1)?.body);
  assert.match(text, /Couldn't build Iva/u);
  assert.match(text, /Invalid MODEL_PROVIDER "ollmaa"/u);
  assert.match(text, /iva config/u);
  assert.match(text, /0\.3\.19/u);
});

test("a failure detail is capped and passes the outbound gate", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({
      method: url.split("/").at(-1),
      body: JSON.parse(init.body) as TelegramBody,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  // Хвост лога с ключом внутри: в чат уходит конец, и секрет в нём не переживает гейт.
  const secret = `sk-or-v1-${"a".repeat(48)}`;
  await reporter.fail("build", "0.3.19", `${"x".repeat(2000)}\nkey ${secret}`);

  const text = screenOf(calls.at(-1)?.body);
  assert.equal(text.includes(secret), false);
  assert.equal(text.length < 900, true, String(text.length));

  // Без причины сообщение остаётся ровно таким, каким было.
  await reporter.fail("build", "0.3.19");
  const plain = screenOf(calls.at(-1)?.body);
  assert.match(plain, /Couldn't build Iva/u);
  assert.doesNotMatch(plain, /xxxx/u);
});

// Команда репейра — единственное, что пользователю остаётся сделать, поэтому она обязана
// доехать до чата целиком: без обрезки хвостом, без разметки и на языке того, кто нажал.
test("the update reporter hands the repair command to the chat whole", async () => {
  for (const [locale, expected] of [
    ["ru", /Ваша Iva \(0\.3\.20\) слишком старая, чтобы обновиться сама\./u],
    ["en", /Your Iva \(0\.3\.20\) is too old to update itself\./u],
  ] as const) {
    const calls: TelegramCall[] = [];
    const fetchImpl: MockFetch = async (url, init) => {
      calls.push({
        method: url.split("/").at(-1),
        body: JSON.parse(init.body) as TelegramBody,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const reporter = createTelegramUpdateReporter({
      token: "token",
      job: { chatId: 1, messageId: 100, locale },
      env: {},
      fetchImpl,
    });
    assert.ok(reporter);

    await reporter.updaterTooOld("0.3.20");

    const body = calls.at(-1)?.body ?? {};
    const text = screenOf(body);
    assert.match(text, expected, locale);
    assert.equal(text.includes(REPAIR_COMMAND), true, text);
    // Ни parse_mode, ни entities: любая разметка съела бы часть команды.
    assert.equal("parse_mode" in body, false, locale);
    assert.equal(body.entities, undefined, locale);
    // Это финальный экран, а не фаза под лоадером.
    assert.doesNotMatch(text, /Building Iva|Собираю Iva/u, locale);
    assert.doesNotMatch(text, /Retry: \/update|Повторить: \/update/u, locale);
  }
});
