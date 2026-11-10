import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  TELEGRAM_RESET_INTENT_VERSION,
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "./telegram-reset-intent.ts";

async function intentDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-reset-intent-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "intents");
}

void test("reset intent persists, loads, clears, and tolerates missing paths", async (t) => {
  const directory = await intentDirectory(t);
  assert.deepEqual(await loadTelegramResetIntents(directory), []);

  const intent = await persistTelegramResetIntent(directory, "42:", {
    now: () => 1234,
    nonce: () => "fixed",
    discardThroughUpdateId: 88,
  });
  assert.deepEqual(intent, {
    version: TELEGRAM_RESET_INTENT_VERSION,
    chatKey: "42:",
    requestedAt: 1234,
    discardThroughUpdateId: 88,
  });
  assert.deepEqual(await loadTelegramResetIntents(directory), [intent]);

  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(directory, `${Buffer.from("42:").toString("base64url")}.json`),
        "utf8",
      ),
    ),
    {
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey: "42:",
      requestedAt: 1234,
      discardThroughUpdateId: 88,
    },
  );

  await clearTelegramResetIntent(directory, "42:");
  await clearTelegramResetIntent(directory, "42:");
  assert.deepEqual(await loadTelegramResetIntents(directory), []);
});

void test("reset intent loader skips invalid records", async (t) => {
  const directory = await intentDirectory(t);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "bad.json"), "{}", "utf8");
  const errors: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  });

  assert.deepEqual(await loadTelegramResetIntents(directory), []);
  assert.match(errors[0], /cannot load Telegram reset intent .*bad\.json/u);
});

// Releases through 0.5.11 wrote this field into every intent.
void test("reset intent loader accepts and strips the retired routing field", async (t) => {
  const directory = await intentDirectory(t);
  const chatKey = "7:";
  const legacyField = "continuationToken";
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${Buffer.from(chatKey).toString("base64url")}.json`),
    JSON.stringify({
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey,
      [legacyField]: "legacy-value",
      requestedAt: 7,
    }),
    "utf8",
  );

  assert.deepEqual(await loadTelegramResetIntents(directory), [
    { version: TELEGRAM_RESET_INTENT_VERSION, chatKey, requestedAt: 7 },
  ]);
});

void test("reset intent loader skips a filename that does not match the chat", async (t) => {
  const directory = await intentDirectory(t);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "wrong.json"),
    JSON.stringify({
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey: "private:7",
      requestedAt: 7,
    }),
    "utf8",
  );

  const errors: string[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  });
  assert.deepEqual(await loadTelegramResetIntents(directory), []);
  assert.match(errors[0], /filename does not match its chat key/u);
});
