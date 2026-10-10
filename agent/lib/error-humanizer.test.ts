/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { humanizeProviderError } from "./error-humanizer.ts";

const REAL_LIMIT_ERROR =
  "AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: 5-hour usage limit reached. Resets in 3hr 59min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_.../go";
const REAL_UPSTREAM_ERROR =
  "AI_APICallError: Error from provider (Console Go): Upstream request failed";

test("humanizes the production usage-limit error and preserves its reset interval", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_LIMIT_ERROR }), {
    en: "Provider limit exhausted - resets in 3hr 59min; wait or switch models: /model",
    ru: "Лимит провайдера исчерпан - сброс через 3hr 59min; подожди или смени модель: /model",
  });
});

test("humanizes the production upstream failure", () => {
  assert.deepEqual(humanizeProviderError({ message: REAL_UPSTREAM_ERROR }), {
    en: "The provider has a failure on its side. Write again in a couple of minutes.",
    ru: "У провайдера сбой. Напиши ещё раз через пару минут.",
  });
});

test("recognizes limits from prose, structured statusCode details and reset text", () => {
  assert.equal(
    humanizeProviderError({
      message: "Request rejected",
      details: {
        statusCode: 429,
        upstreamMessage: "Rate limit. Resets in 12 min",
      },
    }).ru,
    "Лимит провайдера исчерпан - сброс через 12 min; подожди или смени модель: /model",
  );
  assert.equal(
    humanizeProviderError({ message: "rate_limit_exceeded" }).en,
    "Provider limit exhausted - wait or switch models: /model",
  );
});

test("recognizes exhausted balance or plan", () => {
  for (const input of [
    { message: "insufficient credits" },
    { message: "Account billing is inactive" },
    { message: "Request failed", details: { statusCode: 402 } },
  ]) {
    assert.deepEqual(humanizeProviderError(input), {
      en: "Provider balance/plan exhausted - top up or switch models: /model",
      ru: "Баланс/тариф провайдера исчерпан - пополни или смени модель: /model",
    });
  }
});

test("refused credentials say who refused and where to fix it, without repeats", () => {
  for (const input of [
    { message: "Invalid API key" },
    { message: "Unauthorized" },
    { message: "Request rejected", details: '{"statusCode":403}' },
    {
      message: "api.anthropic.com did not finish the response (HTTP 401)",
      details: { attempts: 1 },
    },
  ]) {
    assert.deepEqual(humanizeProviderError({ ...input, provider: "claude" }), {
      en: "Anthropic did not accept the key or login. Check it in /menu and write again.",
      ru: "Anthropic не принял ключ или вход. Проверь его в /menu и напиши ещё раз.",
    });
  }
  assert.equal(
    humanizeProviderError({ message: "Unauthorized" }).ru,
    "Провайдер не принял ключ или вход. Проверь его в /menu и напиши ещё раз.",
  );
});

// Ночь c1 07.10.2026 дословно: eve повторила шаг три раза, связь так и не вернулась.
const C1_BREAK =
  "api.anthropic.com did not finish the response (the stream broke off before message_stop): API Error: Connection to the API was lost (StreamTruncated)";

test("a broken connection after all attempts names the provider and the repeats", () => {
  assert.deepEqual(
    humanizeProviderError({
      message: C1_BREAK,
      details: { attempts: 3, errorId: "e-1" },
      provider: "claude",
    }),
    {
      en: "The connection to Anthropic broke off. I tried again 2 times, it did not work. Write again.",
      ru: "Связь с Anthropic оборвалась, повторила 2 раза, не получилось. Напиши ещё раз.",
    },
  );
  for (const message of [
    "Request timeout",
    "read ECONNRESET",
    "connect ETIMEDOUT",
    "TypeError: fetch failed",
    "The response stream was aborted",
    "terminated",
  ]) {
    assert.equal(
      humanizeProviderError({ message, provider: "codex" }).ru,
      "Связь с OpenAI оборвалась. Напиши ещё раз.",
    );
  }
});

test("a stream broken in the middle of the answer offers one Try again button", () => {
  const text = humanizeProviderError({
    message: C1_BREAK,
    details: { attempts: 1, answerStarted: true, errorId: "e-2" },
    provider: "claude",
  });
  assert.equal(
    text.ru,
    'Связь с Anthropic оборвалась на середине ответа на твоё сообщение. Повторить?\n\n<tg-button-row><tg-button type="callback_data" data="Повторить">Повторить</tg-button></tg-button-row>',
  );
  assert.match(
    text.en,
    /in the middle of the answer to your message\. Try again\?/u,
  );
  assert.match(text.en, /data="Try again">Try again</u);
});

test("provider-side failures and no network at all say what to do", () => {
  for (const input of [
    { message: "The service is overloaded" },
    { message: "Internal Server Error" },
    { message: "Provider returned a 5xx response" },
    { message: "Request failed", details: { upstreamStatusCode: 503 } },
  ]) {
    assert.equal(
      humanizeProviderError({
        ...input,
        details: input.details,
        provider: "ollama",
      }).ru,
      "У Ollama сбой. Напиши ещё раз через пару минут.",
    );
  }
  assert.equal(
    humanizeProviderError({
      message: "getaddrinfo ENOTFOUND api.openai.com",
      details: { attempts: 3 },
      provider: "codex",
    }).ru,
    "Не могу достучаться до OpenAI: у сервера нет связи с ним, повторила 2 раза, не получилось. Проверь интернет на сервере и напиши ещё раз.",
  );
});

test("Russian count agrees with the number of repeats", () => {
  const ru = (attempts: number) =>
    humanizeProviderError({ message: "terminated", details: { attempts } }).ru;
  assert.match(ru(2), /повторила 1 раз,/u);
  assert.match(ru(3), /повторила 2 раза,/u);
  assert.match(ru(6), /повторила 5 раз,/u);
  assert.match(ru(13), /повторила 12 раз,/u);
  assert.match(ru(23), /повторила 22 раза,/u);
  for (const attempts of [0, 1, -1, 1.5, Number.NaN])
    assert.equal(
      ru(attempts),
      "Связь с провайдером оборвалась. Напиши ещё раз.",
    );
});

test("context overflow names the way out", () => {
  for (const message of [
    "context length exceeded",
    "too many tokens in prompt",
    "maximum context window reached",
  ]) {
    assert.deepEqual(humanizeProviderError({ message }), {
      en: "The conversation got too long for the model. /new starts over.",
      ru: "Разговор стал слишком длинным для модели. /new начнёт заново.",
    });
  }
});

test("an unknown failure is told in words, the provider text stays out of the chat", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 8 }), (raw) => {
      const message = `Q${raw}\nsecond line`;
      const text = humanizeProviderError({
        message,
        details: { errorId: "e-77", diagnostic: raw },
      });
      for (const said of [text.en, text.ru]) {
        assert.equal(said.includes("e-77"), false);
        assert.equal(said.includes("second line"), false);
      }
    }),
  );
  assert.deepEqual(
    humanizeProviderError({
      message:
        "AI_RetryError: Failed after 2 attempts. Last error: Provider returned a strange response",
      provider: "openrouter",
    }),
    {
      en: "I could not answer: OpenRouter returned something I could not read. Write again; if it repeats, /new starts over.",
      ru: "Не получилось ответить: OpenRouter вернул ответ, который я не разобрала. Напиши ещё раз; если повторится, /new начнёт заново.",
    },
  );
  // Без имени провайдера слово стоит посреди фразы со строчной, в начале — с заглавной.
  assert.equal(
    humanizeProviderError({ message: "strange" }).ru,
    "Не получилось ответить: провайдер вернул ответ, который я не разобрала. Напиши ещё раз; если повторится, /new начнёт заново.",
  );
});

test("a tool schema the provider rejects names the plugin switch, not the schema", () => {
  // Дословно из пакета t0uchY 13.09.2026: OpenAI отверг весь запрос из-за одного инструмента.
  const text = humanizeProviderError({
    message:
      "AI_APICallError: Invalid JSON schema: regex lookaround is not supported. Found at $.properties.attendees.items.pattern.",
    details: { statusCode: 400, upstreamType: "invalid_request_error" },
  });
  assert.match(text.ru, /attendees\.items\.pattern/u);
  assert.match(text.ru, /data\/custom\/agent\/tools/u);
  assert.match(text.en, /iva plugin disable/u);
});

// Если оборвался первый запрос хода, вопроса владельца в истории нет: сообщение цитирует его
// само, и нажатие «Повторить» приносит модели текст сообщения вместе с вопросом (мост, w6).
test("a mid-answer break quotes the owner's question, cut to 120 characters", () => {
  const short = humanizeProviderError({
    message: "terminated",
    details: { answerStarted: true },
    provider: "claude",
    question: "Какая погода\nв Ташкенте?",
  });
  assert.match(
    short.ru,
    /^Связь с Anthropic оборвалась на середине ответа на «Какая погода в Ташкенте\?»\. Повторить\?/u,
  );
  assert.match(
    short.en,
    /in the middle of the answer to «Какая погода в Ташкенте\?»\. Try again\?/u,
  );
  const long = humanizeProviderError({
    message: "terminated",
    details: { answerStarted: true },
    question: "а".repeat(200),
  });
  assert.match(long.ru, new RegExp(`«${"а".repeat(119)}…»`, "u"));
});

test("the quote cannot open a tag or markup in the rich message", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 300 }), (question) => {
      const text = humanizeProviderError({
        message: "terminated",
        details: { answerStarted: true },
        question,
      }).ru;
      assert.equal((text.match(/<tg-button[\s>]/gu) ?? []).length, 1);
      assert.equal((text.match(/<\/tg-button>/gu) ?? []).length, 1);
      assert.equal((text.match(/</gu) ?? []).length, 4);
      const quote = /на «([\s\S]*)»\. Повторить/u.exec(text)?.[1] ?? "";
      assert.doesNotMatch(quote.replace(/\\./gu, ""), /[\\*_#|`[\]()~$]/u);
      assert.doesNotMatch(quote, /\n/u);
    }),
  );
});

// Рецензия 07.10.2026: текст выбирался по номерам строк стека в details (`:429:` давал
// «лимит», `:502:` — «сбой у провайдера»). Распознаётся только сообщение, коды статуса и
// тексты ответа API.
test("stack line numbers and ids in details never pick the text", () => {
  for (const line of [429, 402, 401, 403, 502]) {
    const text = humanizeProviderError({
      message: "Something odd happened",
      details: {
        errorId: `e-${line}`,
        stack: `Error: x\n    at run (file:///srv/iva/tool-loop.js:${line}:17)`,
        responseBodySnippet: `{"line":${line}}`,
      },
      provider: "claude",
    });
    assert.match(text.ru, /^Не получилось ответить: Anthropic вернул/u);
  }
  assert.match(
    humanizeProviderError({
      message: "Request rejected",
      details: { statusCode: 429 },
    }).ru,
    /^Лимит провайдера исчерпан/u,
  );
  assert.match(
    humanizeProviderError({
      message: "Request rejected",
      details: { apiErrorMessage: "overloaded_error" },
      provider: "claude",
    }).ru,
    /^У Anthropic сбой/u,
  );
});

test("a silent model gets its own text, not a provider failure", () => {
  for (const message of [
    "Model produced no output for 90s",
    "Claude CLI produced nothing for 180s",
  ]) {
    const text = humanizeProviderError({
      message,
      details: {
        code: "MODEL_FIRST_CHUNK_TIMEOUT",
        stack: "at x (tool-loop.js:502:9)",
        attempts: 3,
      },
      provider: "claude",
    });
    assert.equal(
      text.ru,
      "Anthropic долго не отвечает, повторила 2 раза, не получилось. Напиши ещё раз через пару минут или смени модель: /model.",
    );
    assert.match(text.en, /^Anthropic takes too long to answer\./u);
  }
});

test("a provider wait over a minute says to come back in a couple of minutes", () => {
  const text = humanizeProviderError({
    message: "Service unavailable",
    details: { statusCode: 503, providerWaitMs: 600_000, attempts: 1 },
    provider: "codex",
  });
  assert.equal(
    text.ru,
    "OpenAI просит подождать дольше минуты. Попробуй через пару минут.",
  );
});

test("a group gets no quote; an attachment asks to send it again instead of a button", () => {
  const base = {
    message: "terminated",
    details: { answerStarted: true },
    provider: "claude",
  };
  const group = humanizeProviderError({
    ...base,
    question: "секрет группы",
    group: true,
  });
  assert.equal(
    group.ru.split("\n")[0],
    "Связь с Anthropic оборвалась на середине ответа на твоё сообщение. Повторить?",
  );
  assert.doesNotMatch(group.ru, /секрет/u);
  assert.match(group.ru, /<tg-button /u);
  const voice = humanizeProviderError({ ...base, media: true });
  assert.equal(
    voice.ru,
    "Связь с Anthropic оборвалась на середине ответа на твоё сообщение с вложением. Пришли его ещё раз.",
  );
  const photo = humanizeProviderError({
    ...base,
    question: "что на фото?",
    media: true,
  });
  assert.equal(
    photo.ru,
    "Связь с Anthropic оборвалась на середине ответа на «что на фото?». Пришли сообщение с вложением ещё раз.",
  );
  assert.doesNotMatch(photo.en + voice.en, /tg-button/u);
});

test("the quote escapes every rich markup character", () => {
  const text = humanizeProviderError({
    message: "terminated",
    details: { answerStarted: true },
    question: "a`b[c](d)~e$f",
  }).ru;
  assert.match(text, /«a\\`b\\\[c\\\]\\\(d\\\)\\~e\\\$f»/u);
});

// Обрыв посреди ответа eve теперь повторяет сама; кнопка — исход после трёх попыток, и
// сообщение говорит, что повторы уже были.
test("after three mid-answer breaks the notice says how many times Iva tried", () => {
  const text = humanizeProviderError({
    message: "terminated",
    details: { answerStarted: true, attempts: 3 },
    provider: "claude",
    question: "Какая погода?",
  });
  assert.equal(
    text.ru.split("\n")[0],
    "Связь с Anthropic оборвалась на середине ответа на «Какая погода?», повторила 2 раза, не получилось. Повторить?",
  );
  assert.equal(
    text.en.split("\n")[0],
    "The connection to Anthropic broke off in the middle of the answer to «Какая погода?». I tried again 2 times, it did not work. Try again?",
  );
});

// MODEL_PROVIDER с именем метода Object доставал метод вместо имени, и сообщение о сбое
// падало на capital(): владелец не узнавал о сбое вовсе.
test("a provider named like an Object method is told as «провайдер», the notice does not throw", () => {
  for (const provider of [
    "valueOf",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    assert.deepEqual(
      humanizeProviderError({ message: "Unauthorized", provider }),
      {
        en: "The provider did not accept the key or login. Check it in /menu and write again.",
        ru: "Провайдер не принял ключ или вход. Проверь его в /menu и напиши ещё раз.",
      },
    );
  }
});
