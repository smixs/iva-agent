// Вопрос хода живёт в записи чата run-status: её читает и канал (цитата в сообщении об
// обрыве), и мост (полный вопрос по нажатию «Повторить»), и она переживает перезапуск.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "iva-turn-question-"));
process.env.ASSISTANT_DATA_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const { rememberTurnQuestion, turnQuestion, TURN_QUESTION_LIMIT } =
  await import("./turn-question.ts");
const { getChatStatus } = await import("./run-status.ts");

void test("the last accepted message of a chat is its question; a Try again tap keeps it", () => {
  rememberTurnQuestion("c-1:", { text: "  Первый вопрос ", media: false });
  rememberTurnQuestion("c-1:", { text: "Второй вопрос", media: false });
  assert.deepEqual(turnQuestion("c-1:"), {
    text: "Второй вопрос",
    media: false,
  });
  rememberTurnQuestion("c-1:", {
    text: "Повторить\n\n(кнопка под сообщением Ивы: «Связь оборвалась…»)",
    media: false,
  });
  assert.equal(turnQuestion("c-1:")?.text, "Второй вопрос");
  assert.equal(turnQuestion("c-2:"), undefined);
});

// Рецензия 07.10.2026: голос после текста оставлял старый вопрос, и «Повторить» отвечал
// не на то сообщение.
void test("a message without text drops the old question and keeps only the attachment mark", () => {
  rememberTurnQuestion("c-3:", { text: "Старый вопрос", media: false });
  rememberTurnQuestion("c-3:", { text: "   ", media: true });
  assert.deepEqual(turnQuestion("c-3:"), { text: "", media: true });
  rememberTurnQuestion("c-3:", { text: "", media: false });
  assert.equal(turnQuestion("c-3:"), undefined);
  assert.equal(getChatStatus("c-3:")?.turnQuestion, undefined);
});

void test("a caption with a photo is the question with the attachment mark; a long text is capped", () => {
  rememberTurnQuestion("c-4:", { text: "что на фото?", media: true });
  assert.deepEqual(turnQuestion("c-4:"), { text: "что на фото?", media: true });
  rememberTurnQuestion("c-4:", { text: "я".repeat(9000), media: false });
  assert.equal(
    Array.from(turnQuestion("c-4:")?.text ?? "").length,
    TURN_QUESTION_LIMIT,
  );
});

void test("writing the question does not touch updatedAt: it does not say the turn is alive", () => {
  rememberTurnQuestion("c-5:", { text: "раз", media: false });
  const before = getChatStatus("c-5:")?.updatedAt;
  rememberTurnQuestion("c-5:", { text: "два", media: false });
  assert.equal(getChatStatus("c-5:")?.updatedAt, before);
});

void test("the interrupted tap captures its question before another turn can replace it", async () => {
  const { claimInterruptedTap } = await import("./turn-question.ts");
  const { setChatStatus } = await import("./run-status.ts");
  setChatStatus("snapshot:", {
    status: "idle",
    turnQuestion: "original",
    restartRetryData: "token",
    restartRetryQuestion: "original",
    restartRetryMedia: false,
  });
  const accepted = claimInterruptedTap("snapshot:", "token", 17);
  setChatStatus("snapshot:", { turnQuestion: "next" });
  assert.deepEqual(accepted, { text: "original", media: false });
  assert.equal(claimInterruptedTap("snapshot:", "token", 18), null);
});
