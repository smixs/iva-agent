import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createHarness,
  message,
  OWNER,
  smokeParameters,
  waitFor,
} from "./harness.ts";

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
      message(101, update.message.text, update.message.message_id),
      update,
    );
    // Next getUpdates proves the entire injected batch has passed through the real Bridge.
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

void test.todo("S-chat-overload: recovery and exhaustion of provider 429");
void test.todo("S-chat-reset: reset and ExactCut after Bridge interruption");
