import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  humanizeProviderError,
  interruptedTurnText,
} from "../../agent/lib/error-humanizer.ts";
import {
  escHtml,
  htmlToPlain,
  richQuoteLine,
} from "../../agent/lib/telegram-format.ts";

// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает в отчёте строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь их вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
const RUNS = { numRuns: 500 };

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

function parseRequestBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Expected a JSON object request body");
  return Object.fromEntries(Object.entries(parsed));
}

function captureRequest(
  url: URL | RequestInfo,
  options?: RequestInit,
): CapturedRequest {
  const body = options?.body;
  if (typeof body !== "string")
    throw new TypeError("Expected a JSON request body");
  const requestUrl =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return { url: requestUrl, body: parseRequestBody(body) };
}

void test("rich 400 keeps the quoted question and button labels on the HTML wire", async () => {
  const question = "Что значит **цена** & `код` _имя_ C:\\tmp?";
  const quote = richQuoteLine(question, 120);
  const button =
    '<tg-button type="callback_data" data="Повторить">Повторить</tg-button>';
  for (const [markdown, expected] of [
    [
      `> ${quote}\n\n<tg-button-row>${button}</tg-button-row>`,
      `<blockquote>${escHtml(question)}</blockquote>`,
    ],
    [
      interruptedTurnText({
        question,
        media: false,
        group: false,
        data: "Повторить",
      }).ru,
      escHtml(`«${question}»`),
    ],
    [
      humanizeProviderError({
        message: "StreamTruncated: broke off",
        details: { answerStarted: true },
        provider: "claude",
        question,
      }).ru,
      escHtml(`«${question}»`),
    ],
  ]) {
    const requests: CapturedRequest[] = [];
    const { sendTelegramHtml } = await import("./telegram-send.ts");
    const result = await sendTelegramHtml("test-bot", "test-chat", markdown, {
      rich: true,
      fetchImpl: (url, options) => {
        requests.push(captureRequest(url, options));
        return Promise.resolve(
          new Response("rich unsupported", {
            status: requests.length === 1 ? 400 : 200,
          }),
        );
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.fellBack, true);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.endsWith("/sendRichMessage"));
    assert.deepEqual(requests[0].body.rich_message, { markdown });
    assert.ok(requests[1].url.endsWith("/sendMessage"));
    assert.equal(requests[1].body.parse_mode, "HTML");
    assert.equal(requests[1].body.chat_id, "test-chat");
    const html = requests[1].body.text;
    assert.ok(typeof html === "string");
    assert.ok(html.includes(expected), html);
    assert.ok(html.includes("<b>Повторить</b>"), html);
    assert.doesNotMatch(html, /tg-button/u);
    assert.ok(htmlToPlain(html).includes(question));
  }
});

void test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[0].body.chat_id, "test-chat");
  assert.equal(requests[0].body.text, "[REDACTED]");
  assert.equal("disable_notification" in requests[0].body, false);
});

void test("a scheduled model reply keeps quiet delivery through the plain fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(
      new Response(requests.length === 1 ? "bad entities" : "", {
        status: requests.length === 1 ? 400 : 200,
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    "<!-- iva:silent -->\nОтчёт по расписанию",
  );

  assert.deepEqual(result, { ok: true, fellBack: true, error: "" });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.body.disable_notification, true);
    assert.doesNotMatch(String(request.body.text), /iva:silent/u);
  }
  assert.equal("parse_mode" in requests[1].body, false);
});

void test("telegram-send keeps redaction when retrying a rejected HTML message", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    const status = requests.length === 1 ? 400 : 200;
    return Promise.resolve(
      new Response(status === 400 ? "bad entities" : "", { status }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: true, error: "" });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[1].body.chat_id, "test-chat");
  assert.equal(requests[1].body.text, "[REDACTED]");
  assert.equal("parse_mode" in requests[1].body, false);
});

// Отчёт из нескольких чанков: хватает, чтобы отличить «оборвались» от «долбим дальше».
const MULTI_CHUNK_REPORT = Array.from(
  { length: 400 },
  (_, i) => `line ${i} of the report`,
).join("\n\n");

void test("telegram-send stops the report when Telegram rejects a chunk", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    const status = requests.length === 1 ? 429 : 200;
    return Promise.resolve(
      new Response(status === 429 ? "too many requests" : "", { status }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    MULTI_CHUNK_REPORT,
  );

  assert.deepEqual(result, {
    ok: false,
    fellBack: false,
    error: "429: too many requests",
  });
  // Bot API уже во flood control — оставшиеся чанки не отправляются.
  assert.equal(requests.length, 1);
});

void test("telegram-send stops the report when the plain retry fails", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(
      new Response(requests.length === 1 ? "bad entities" : "bot was blocked", {
        status: 400,
      }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    MULTI_CHUNK_REPORT,
  );

  assert.deepEqual(result, {
    ok: false,
    fellBack: true,
    error: "plain retry 400: bot was blocked",
  });
  assert.equal(requests.length, 2);
  assert.equal("parse_mode" in requests[1].body, false);
});

void test("telegram-send delivers every chunk when Telegram accepts them", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    MULTI_CHUNK_REPORT,
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.ok(requests.length > 1);
  assert.ok(String(requests.at(-1)?.body.text).includes("line 399"));
});

void test("telegram-send fails an empty report without calling Telegram", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  for (const report of ["", "   ", "\n\t \n"]) {
    const result = await sendTelegramHtml("test-bot", "test-chat", report);
    assert.deepEqual(result, {
      ok: false,
      fellBack: false,
      error: "nothing delivered: empty rendering",
    });
  }
  assert.deepEqual(requests, []);
});

void test("a rich post goes to sendRichMessage, gated, with silent and thread fields", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramRich } = await import("./telegram-send.ts");
  const result = await sendTelegramRich(
    "test-bot",
    "test-chat",
    `текст ![](https://example.com/a.jpg) api_key=${"x".repeat(24)}`,
    { silent: true, threadId: "17" },
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.deepEqual(
    requests.map((request) => request.url),
    ["https://api.telegram.org/bottest-bot/sendRichMessage"],
  );
  assert.deepEqual(requests[0].body, {
    chat_id: "test-chat",
    rich_message: {
      markdown: "текст ![](https://example.com/a.jpg) [REDACTED]",
    },
    disable_notification: true,
    message_thread_id: "17",
  });
});

void test("a refused rich post fails loudly and sends nothing instead", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("rich unsupported", { status: 400 }));
  };
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((argument) => String(argument)).join(" "));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const { sendTelegramRich } = await import("./telegram-send.ts");
  const result = await sendTelegramRich("test-bot", "test-chat", "**пост**");

  assert.deepEqual(result, {
    ok: false,
    fellBack: false,
    error: "400: rich unsupported",
  });
  // Ровно один вызов Bot API: HTML-фолбэка у поста нет, иначе владелец получил бы
  // куски без картинок и отчёт об успехе.
  assert.deepEqual(
    requests.map((request) => request.url),
    ["https://api.telegram.org/bottest-bot/sendRichMessage"],
  );
  assert.ok(
    logged.some((line) => line.includes("пост не отправлен")),
    "отказ обязан быть виден в stderr",
  );
});

void test("telegram-send never throws on a report that is not a string", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml("test-bot", "test-chat", { report: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.fellBack, false);
  assert.ok(result.error.length > 0);
  assert.deepEqual(requests, []);
});

type RetryAfter =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid-json" }
  | {
      readonly kind: "value";
      readonly value: string | number | boolean | null;
    };

type HttpOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "throw"; readonly message: string }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly retryAfter: RetryAfter;
    };

const retryAfterArbitrary: fc.Arbitrary<RetryAfter> = fc.oneof(
  fc.constant({ kind: "missing" } as const),
  fc.constant({ kind: "invalid-json" } as const),
  fc.record({
    kind: fc.constant("value" as const),
    value: fc.oneof(
      fc.string({ maxLength: 16 }),
      fc.integer({ min: -60, max: 60 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
    ),
  }),
);

const httpOutcomeArbitrary: fc.Arbitrary<HttpOutcome> = fc.oneof(
  fc.constant({ kind: "ok" } as const),
  fc.record({
    kind: fc.constant("throw" as const),
    message: fc.string({ maxLength: 30 }),
  }),
  fc.record({
    kind: fc.constant("status" as const),
    status: fc.integer({ min: 400, max: 599 }),
    retryAfter: retryAfterArbitrary,
  }),
);

function responseBody(outcome: Extract<HttpOutcome, { kind: "status" }>) {
  if (outcome.status !== 429) return `status ${outcome.status}`;
  if (outcome.retryAfter.kind === "invalid-json") return "{";
  if (outcome.retryAfter.kind === "missing") return "{}";
  return JSON.stringify({
    parameters: { retry_after: outcome.retryAfter.value },
  });
}

function isRetryable(outcome: HttpOutcome): boolean {
  return (
    outcome.kind === "throw" ||
    (outcome.kind === "status" &&
      (outcome.status >= 500 || [408, 425, 429].includes(outcome.status)))
  );
}

function expectedRetryAfterMs(outcome: HttpOutcome): number | undefined {
  if (
    outcome.kind !== "status" ||
    outcome.status !== 429 ||
    outcome.retryAfter.kind !== "value"
  )
    return undefined;
  const value = outcome.retryAfter.value;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(30_000, seconds * 1000);
}

function expectedPolicy(outcomes: readonly HttpOutcome[]) {
  const attempts: Array<{
    readonly plain: boolean;
    readonly outcome: HttpOutcome;
  }> = [];
  const delays: number[] = [];
  let cursor = 0;

  const run = (plain: boolean): "ok" | "plain" | "failed" => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = outcomes[cursor++];
      attempts.push({ plain, outcome });
      if (outcome.kind === "ok") return "ok";
      if (isRetryable(outcome) && attempt < 3) {
        delays.push(expectedRetryAfterMs(outcome) ?? 1000 * 2 ** (attempt - 1));
        continue;
      }
      if (!plain && outcome.kind === "status" && outcome.status === 400)
        return "plain";
      return "failed";
    }
    return "failed";
  };

  const html = run(false);
  if (html !== "plain")
    return { attempts, delays, fellBack: false, ok: html === "ok" };
  const plain = run(true);
  return { attempts, delays, fellBack: true, ok: plain === "ok" };
}

void test("a transient 5xx is retried and the second attempt delivers", async () => {
  const outcomes: HttpOutcome[] = [
    {
      kind: "status",
      status: 503,
      retryAfter: { kind: "missing" },
    },
    { kind: "ok" },
  ];
  const delays: number[] = [];
  let calls = 0;

  const result = await (
    await import("./telegram-send.ts")
  ).sendTelegramHtml("test-bot", "test-chat", "remember this", {
    retryTransient: true,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    fetchImpl: () => {
      const outcome = outcomes[calls++];
      return Promise.resolve(
        new Response(outcome.kind === "status" ? responseBody(outcome) : "", {
          status: outcome.kind === "status" ? outcome.status : 200,
        }),
      );
    },
  });

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
});

void test("omitted and false retryTransient preserve the original single attempt", async () => {
  const { sendTelegramHtml } = await import("./telegram-send.ts");
  for (const retryTransient of [undefined, false] as const) {
    let calls = 0;
    const result = await sendTelegramHtml(
      "test-bot",
      "test-chat",
      "remember this",
      {
        ...(retryTransient === undefined ? {} : { retryTransient }),
        fetchImpl: () => {
          calls++;
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        },
      },
    );

    assert.deepEqual(result, {
      ok: false,
      fellBack: false,
      error: "503: unavailable",
    });
    assert.equal(calls, 1);
  }
});

void test("property: transient retry is bounded, classified and timed", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(httpOutcomeArbitrary, { minLength: 6, maxLength: 6 }),
      async (outcomes) => {
        const expected = expectedPolicy(outcomes);
        const calls: Array<{ readonly plain: boolean }> = [];
        const delays: number[] = [];
        let thrown: unknown;
        let result:
          { ok: boolean; fellBack: boolean; error: string } | undefined;

        try {
          result = await (
            await import("./telegram-send.ts")
          ).sendTelegramHtml("test-bot", "test-chat", "remember this", {
            retryTransient: true,
            sleep: (ms) => {
              delays.push(ms);
              return Promise.resolve();
            },
            fetchImpl: (_url, options) => {
              const { body } = captureRequest(_url, options);
              calls.push({ plain: !("parse_mode" in body) });
              const outcome = outcomes[calls.length - 1];
              if (outcome.kind === "throw")
                return Promise.reject(new Error(outcome.message));
              if (outcome.kind === "ok")
                return Promise.resolve(new Response("", { status: 200 }));
              return Promise.resolve(
                new Response(responseBody(outcome), { status: outcome.status }),
              );
            },
          });
        } catch (error) {
          thrown = error;
        }

        assert.equal(thrown, undefined);
        assert.ok(result);
        assert.equal(result.ok, expected.ok);
        assert.equal(result.fellBack, expected.fellBack);
        assert.deepEqual(
          calls.map(({ plain }) => plain),
          expected.attempts.map(({ plain }) => plain),
        );
        assert.ok(calls.filter(({ plain }) => !plain).length <= 3);
        assert.ok(calls.filter(({ plain }) => plain).length <= 3);
        assert.deepEqual(delays, expected.delays);

        for (const [index, attempt] of expected.attempts.entries()) {
          const { outcome, plain } = attempt;
          if (outcome.kind === "ok") assert.equal(index, calls.length - 1);
          if (
            outcome.kind === "status" &&
            [401, 403, 404].includes(outcome.status)
          )
            assert.equal(index, calls.length - 1);
          if (
            outcome.kind === "status" &&
            !isRetryable(outcome) &&
            (plain || outcome.status !== 400)
          )
            assert.equal(index, calls.length - 1);
        }
      },
    ),
    RUNS,
  );
});

// Предложение плагина на проводе: кнопка доходит в обоих стилях меню владельца, и тот же
// outbound-Gate снимает секрет из команды плагина до Bot API.
void test("sendTelegramScreen carries the button in the owner's menu style, through the Gate", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "iva-screen-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  t.after(() => {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(data, { recursive: true, force: true });
  });
  const { sendTelegramScreen } = await import("./telegram-send.ts");
  const requests: CapturedRequest[] = [];
  const fetchImpl = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const markdown = `Plugin relay asks to be installed. It will run: mcp x: run api_key=${"x".repeat(24)}.\n\n<tg-button type="callback_data" style="success" data="iva_plugin:ok:0123456789ab">Install</tg-button>`;

  // classic по умолчанию: текст и inline-клавиатура.
  assert.deepEqual(
    await sendTelegramScreen("bot", "42", markdown, { fetchImpl }),
    {
      ok: true,
      error: "",
    },
  );
  writeFileSync(join(data, "settings.json"), '{"menuStyle":"rich"}');
  await sendTelegramScreen("bot", "42", markdown, { fetchImpl });

  const [classic, rich] = requests;
  assert.equal(classic.url, "https://api.telegram.org/botbot/sendMessage");
  assert.equal(classic.body.chat_id, "42");
  assert.deepEqual(
    (classic.body.reply_markup as { inline_keyboard: unknown }).inline_keyboard,
    [
      [
        {
          text: "Install",
          callback_data: "iva_plugin:ok:0123456789ab",
          style: "success",
        },
      ],
    ],
  );
  assert.doesNotMatch(JSON.stringify(classic.body), /x{24}/u);
  assert.equal(rich.url, "https://api.telegram.org/botbot/sendRichMessage");
  const richMarkdown = (rich.body.rich_message as { markdown: string })
    .markdown;
  assert.match(richMarkdown, /data="iva_plugin:ok:0123456789ab"/u);
  assert.doesNotMatch(richMarkdown, /x{24}/u);
});

void test("sendTelegramScreen reports a refusal instead of falling back to text without the button", async () => {
  const { sendTelegramScreen } = await import("./telegram-send.ts");
  const result = await sendTelegramScreen("bot", "42", "Plugin relay", {
    fetchImpl: () =>
      Promise.resolve(new Response("Bad Request", { status: 400 })),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /^400/u);
});
