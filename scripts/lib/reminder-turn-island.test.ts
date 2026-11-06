// Критерий C: и ход напоминания, и `iva remind` обязаны грузиться на установке, где agent/
// нет вовсе — ровно там они и нужны (`iva remind` приходит чинить сломанную установку).
// Проверка поведением, а не грепом: модули копируются в каталог со СВОИМ package.json, где
// алиаса `#lib` нет вовсе (образец — «островной» прогон в scripts/lib/notice-policy.test.ts),
// поэтому любой импорт из agent/lib падает на загрузке, а не проходит незамеченным.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "../..");

// Весь статический граф обоих входов: сам ход, его политика (node:fs) и то, что тянет CLI.
const ISLAND_FILES = [
  "packages/alert-state/index.ts",
  "scripts/lib/reminder-turn.ts",
  "scripts/lib/notice-policy.ts",
  "scripts/lib/env-file.ts",
  "scripts/lib/link-target.ts",
  "scripts/lib/notification-chat.ts",
  "scripts/cli/remind.ts",
];

const PROBE = `
const turn = await import(process.env.__TURN_URL);
const cli = await import(process.env.__CLI_URL);
const response = Object.assign(
  (async function* () {
    yield { type: "message.completed", data: { message: "ок" } };
    yield { type: "session.completed" };
  })(),
  { cancel: () => Promise.resolve(), sessionId: "island-sess" },
);
const createClient = () =>
  Promise.resolve({
    sessions: {
      create: () =>
        Promise.resolve({
          response,
          session: {
            send: () => Promise.resolve(),
            cancel: () => Promise.resolve(),
            reset: () => Promise.resolve(),
          },
        }),
    },
  });
const turnResult = await turn.runReminderTurn(
  "текст",
  { host: "http://127.0.0.1:1", auth: { bearer: () => Promise.resolve("b") } },
  { createClient, inactivityMs: 1000 },
);
const reported = [];
const cmd = cli.createRemindCommand(
  { ENV_PATH: "unused", ok: (message) => reported.push(message) },
  {
    readEnv: () =>
      Promise.resolve({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_DIGEST_CHAT_ID: "1",
        ASSISTANT_BEARER: "b",
      }),
    send: () => Promise.resolve({ ok: true, fellBack: false, error: "" }),
    runAgentTurn: () =>
      Promise.resolve({
        status: "waiting",
        message: "ок",
        feedback: () => Promise.resolve(),
      }),
  },
);
await cmd(["текст"]);
process.stdout.write(
  JSON.stringify({ status: turnResult.status, reported }),
);
`;

void test("ход и `iva remind` работают на установке без agent/", () => {
  const island = mkdtempSync(join(tmpdir(), "iva-remind-island-"));
  try {
    writeFileSync(
      join(island, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    for (const file of ISLAND_FILES) {
      const target = join(island, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(ROOT, file), "utf8"));
    }

    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", PROBE],
      {
        encoding: "utf8",
        cwd: island,
        env: {
          ...process.env,
          __TURN_URL: pathToFileURL(
            join(island, "scripts/lib/reminder-turn.ts"),
          ).href,
          __CLI_URL: pathToFileURL(join(island, "scripts/cli/remind.ts")).href,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    assert.deepEqual(JSON.parse(output), {
      status: "completed",
      reported: ["Reminder sent to Telegram"],
    });
  } finally {
    rmSync(island, { recursive: true, force: true });
  }
});
