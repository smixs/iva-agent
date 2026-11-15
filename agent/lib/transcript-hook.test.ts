/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Хук транскрипта (agent/hooks/transcript.ts): финальный ответ Ивы идёт в дневной файл
// Vault, а ответ планового хода Watch или Brief `QUIET` («писать не о чем») — нет. Тест лежит
// в agent/lib: eve считает хуком каждый файл в agent/hooks (см. trace-hook.test.ts).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

const vault = mkdtempSync(join(tmpdir(), "iva-transcript-hook-"));
const previousVault = process.env.ASSISTANT_VAULT_DIR;
const previousTimeZone = process.env.ASSISTANT_TIMEZONE;
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.ASSISTANT_TIMEZONE = "UTC";
after(() => {
  if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
  else process.env.ASSISTANT_VAULT_DIR = previousVault;
  if (previousTimeZone === undefined) delete process.env.ASSISTANT_TIMEZONE;
  else process.env.ASSISTANT_TIMEZONE = previousTimeZone;
  rmSync(vault, { recursive: true, force: true });
});

function resetDaily(t: TestContext): void {
  rmSync(join(vault, "daily"), { recursive: true, force: true });
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-11T08:15:00Z"),
  });
}

await import("../../scripts/lib/ts-esm-hooks.ts");
const hook = (await import("../hooks/transcript.ts")).default as unknown as {
  events: Record<
    string,
    (
      event: { data: Record<string, unknown> },
      ctx: Record<string, unknown>,
    ) => void
  >;
};

const chatContext = {
  session: { id: "chat-1", turn: { id: "turn-1", sequence: 1 } },
  channel: { kind: "channel:telegram" },
};
const reminderContext = {
  session: {
    id: "reminder-1",
    turn: { id: "turn-1", sequence: 0 },
    auth: {
      initiator: {
        authenticator: "iva-bearer",
        attributes: { iva_turn: "reminder" },
      },
    },
  },
  channel: { kind: "http" },
};
const childContext = {
  session: {
    id: "child-1",
    turn: { id: "turn-0", sequence: 0 },
    parent: {
      callId: "call-1",
      rootSessionId: "chat-1",
      sessionId: "chat-1",
      turn: { id: "turn-1", sequence: 1 },
    },
  },
  channel: { kind: "subagent" },
};

const completed = (
  message: string,
  finishReason = "stop",
  ctx: Record<string, unknown> = chatContext,
) =>
  hook.events["message.completed"]?.({ data: { message, finishReason } }, ctx);

const daily = () => {
  const dir = join(vault, "daily");
  return existsSync(dir)
    ? readdirSync(dir)
        .map((file) => readFileSync(join(dir, file), "utf8"))
        .join("")
    : "";
};

for (const kind of ["cli", "http"]) {
  test(`root ${kind} service replies stay out of the day`, (t) => {
    resetDaily(t);
    completed("служебный ответ", "stop", {
      ...chatContext,
      channel: { kind },
    });
    assert.equal(daily(), "");
  });
}

test("HTTP background replies require a recognized bearer turn", (t) => {
  resetDaily(t);
  for (const initiator of [
    { authenticator: "iva-bearer", attributes: {} },
    { authenticator: "iva-bearer", attributes: { iva_turn: "unknown" } },
    { authenticator: "local-dev", attributes: { iva_turn: "watch" } },
  ]) {
    completed("служебный ответ API", "stop", {
      ...reminderContext,
      session: { ...reminderContext.session, auth: { initiator } },
    });
  }
  assert.equal(daily(), "");
});

for (const turn of ["watch", "brief", "insight", "signal", "alert"]) {
  test(`${turn} replies are written to the day`, (t) => {
    resetDaily(t);
    completed(`видимый ответ ${turn}`, "stop", {
      ...reminderContext,
      session: {
        ...reminderContext.session,
        auth: {
          initiator: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: turn },
          },
        },
      },
    });
    assert.match(daily(), new RegExp(`\\[iva\\]\\nвидимый ответ ${turn}`));
  });
}

test("child text is skipped while chat and Reminder Turns are written", (t) => {
  resetDaily(t);
  completed("сырой ответ помощника", "stop", childContext);
  completed("ответ в чате", "stop", chatContext);
  completed("напоминание", "stop", reminderContext);

  assert.doesNotMatch(daily(), /сырой ответ помощника/u);
  assert.match(daily(), /\[iva\]\nответ в чате/u);
  assert.match(daily(), /\[iva\]\nнапоминание/u);
  assert.equal(daily().match(/## 08:15 \[iva\]/gu)?.length, 2);
});

test("QUIET after trim is not written to the day; an ordinary reply is", (t) => {
  resetDaily(t);
  completed("QUIET");
  completed("  QUIET\n");
  completed("");
  assert.equal(daily(), "");
  completed("Иван ждёт ответа.\n<!-- iva:next -->\nВторое");
  assert.match(daily(), /\[iva\]\nИван ждёт ответа\./u);
  completed("QUIET, но не совсем");
  assert.match(daily(), /QUIET, но не совсем/u);
  assert.equal(daily().match(/## \d\d:\d\d \[iva\]/gu)?.length, 2);
});

test("an intermediate step before a tool call is still skipped", (t) => {
  resetDaily(t);
  const before = daily();
  completed("думаю…", "tool-calls");
  assert.equal(daily(), before);
});

test("helper text is skipped and an ordinary chat still writes", (t) => {
  resetDaily(t);
  completed("helper private result", "stop", {
    session: {
      auth: {
        initiator: {
          authenticator: "iva-bearer",
          attributes: { iva_turn: "helper" },
        },
      },
    },
  });
  assert.equal(daily(), "");
  completed("chat reply");
  assert.match(daily(), /chat reply/);
});

test("a widget reaches the day as its caption, not its code", (t) => {
  resetDaily(t);
  completed(
    "Итог недели.\n\n```tg-widget Расходы: 32 тыс.\n<div>x</div><script>1</script>\n```",
  );
  const day = daily();
  assert.match(day, /Итог недели\.\n\n\[widget\] Расходы: 32 тыс\./);
  assert.ok(!day.includes("<script>"), day);
});
