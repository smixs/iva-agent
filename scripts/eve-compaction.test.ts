/* eslint-disable @typescript-eslint/require-await -- Model doubles implement the SDK Promise interface. */
// Граница с eve: проход свёртки перед шагом не теряет вопросы пользователя.
// Хвост держится только пока умещается рядом с головой пересказа; всё, что не
// умещается, уходит в старшую часть — и пересказчик её видит. Приёмка T90
// поймала потерю: крупный multipart-вопрос text+image молча выпадал, а
// возобновление реплеило прежний строковый вопрос (16.11.2026).
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { compactMessages } from "../node_modules/eve/dist/src/harness/compaction.js";

const CONFIG = {
  threshold: 104_857,
  recentWindowTokens: 20_000,
  summaryMaxOutputTokens: 8_192,
};

const summarizer = (summary: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: summary }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });

void test("свёртка крупного multipart-вопроса: запрос виден пересказчику и остаётся в истории", async () => {
  const model = summarizer("Old answer summarized.");
  const messages: ModelMessage[] = [
    { role: "user", content: "OLD_QUESTION" },
    { role: "assistant", content: "older answer ".repeat(40_000) },
    {
      role: "user",
      content: [
        { type: "text", text: "LATEST_MULTIPART_REQUEST: describe this image" },
        {
          type: "image",
          image: `data:image/jpeg;base64,${"A".repeat(600_000)}`,
          mediaType: "image/jpeg",
        },
      ],
    },
  ];

  const result = await compactMessages(messages, model, CONFIG);

  assert.ok(result !== null, "свёртка принята");
  assert.equal(model.doGenerateCalls.length, 1, "один вызов пересказа");
  const summaryPrompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
  const replacement = JSON.stringify(result);
  assert.ok(
    summaryPrompt.includes("LATEST_MULTIPART_REQUEST"),
    "пересказчик видел последний запрос",
  );
  assert.ok(
    summaryPrompt.includes("image/jpeg"),
    "вложение оставило след в транскрипте пересказа",
  );
  assert.ok(
    replacement.includes("LATEST_MULTIPART_REQUEST"),
    "запрос остался в истории отрисованным реплеем",
  );
  assert.ok(!replacement.includes("A".repeat(600_000)), "base64 не вернулся в историю");
  assert.ok(!replacement.includes("OLD_QUESTION"), "прежний вопрос не реплеится вместо нового");
});

void test("сокращение хвоста: вытесненный вопрос попадает в пересказ, последний остаётся дословно", async () => {
  const model = summarizer("Earlier questions summarized.");
  const earliest = `EARLIEST_QUESTION ${"x".repeat(400_000)}`;
  const messages: ModelMessage[] = [
    { role: "user", content: earliest },
    { role: "assistant", content: "answer one" },
    { role: "user", content: `MIDDLE_QUESTION ${"y".repeat(60_000)}` },
    { role: "assistant", content: "answer two" },
    { role: "user", content: "LATEST_QUESTION" },
  ];

  const result = await compactMessages(messages, model, CONFIG);

  assert.ok(result !== null, "свёртка принята");
  assert.equal(model.doGenerateCalls.length, 1, "один вызов пересказа");
  const summaryPrompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
  const replacement = JSON.stringify(result);
  assert.ok(
    summaryPrompt.includes("EARLIEST_QUESTION"),
    "вытесненный из хвоста вопрос представлен в пересказе",
  );
  assert.ok(replacement.includes("MIDDLE_QUESTION"), "средний вопрос остался дословно");
  assert.ok(replacement.includes("LATEST_QUESTION"), "последний вопрос остался дословно");
  assert.ok(
    !replacement.includes(earliest),
    "тело вытесненного вопроса не удерживается целиком",
  );
});
