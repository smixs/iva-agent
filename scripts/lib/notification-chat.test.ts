import test from "node:test";
import assert from "node:assert/strict";
import { notificationChat } from "../../packages/notification-chat/index.ts";

void test("notification chat uses the configured digest chat", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_DIGEST_CHAT_ID: "99",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
    }),
    "99",
  );
});

void test("notification chat falls back to the first trusted user", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_DIGEST_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: " 1, 2",
    }),
    "1",
  );
});

void test("notification chat is empty without a digest chat or trusted user", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_DIGEST_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: "",
    }),
    "",
  );
});
