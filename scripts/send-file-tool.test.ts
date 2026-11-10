import "./fixtures/no-host-env.ts";
import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolContext } from "eve/tools";

import type { SendFileAnswer } from "../agent/tools/send_file.ts";

// Тесты тулов живут в scripts/: файл рядом с тулами eve счёл бы ещё одним тулом и сборка
// упала бы. Хук резолвинга идёт первым — тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";

const vault = mkdtempSync(join(tmpdir(), "iva-send-file-vault-"));
mkdirSync(join(vault, "attachments", "2026-09-24"), { recursive: true });
writeFileSync(join(vault, "attachments", "2026-09-24", "report.pdf"), "%PDF-1");
process.env.ASSISTANT_VAULT_DIR = vault;
process.env.TELEGRAM_BOT_TOKEN = "123:secret";

const { default: sendFileTool, sendFile } =
  await import("../agent/tools/send_file.ts");

const REPO = resolve(import.meta.dirname, "..");
const turnCtx = (attributes: Record<string, unknown>) =>
  ({
    session: { auth: { current: { attributes } } },
  }) as unknown as ToolContext;
const noTurn = {} as unknown as ToolContext;

type Call = { url: string; method: string; form: FormData };

function stubFetch(
  t: TestContext,
  reply: unknown = { ok: true, result: { message_id: 77 } },
): Call[] {
  const calls: Call[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: { method: string; body: FormData }) => {
      calls.push({ url, method: init.method, form: init.body });
      return Promise.resolve(
        new Response(JSON.stringify(reply), { status: 200 }),
      );
    },
  );
  return calls;
}

function withChatEnv(
  t: TestContext,
  env: { digest?: string; allowed?: string },
): void {
  const before = {
    digest: process.env.TELEGRAM_DIGEST_CHAT_ID,
    allowed: process.env.TELEGRAM_ALLOWED_USER_IDS,
  };
  process.env.TELEGRAM_DIGEST_CHAT_ID = env.digest ?? "";
  process.env.TELEGRAM_ALLOWED_USER_IDS = env.allowed ?? "";
  t.after(() => {
    process.env.TELEGRAM_DIGEST_CHAT_ID = before.digest;
    process.env.TELEGRAM_ALLOWED_USER_IDS = before.allowed;
  });
}

const run = (input: { path: string; caption?: string }, ctx: ToolContext) =>
  sendFileTool.execute(input, ctx) as Promise<SendFileAnswer>;

const REFUSAL = /vault\/attachments\/<дата>\/.*send_file/;

void test("файл из Vault уходит документом в чат и тему хода", async (t) => {
  const calls = stubFetch(t);
  const answer = await run(
    { path: "attachments/2026-09-24/report.pdf", caption: "отчёт" },
    turnCtx({ chat_id: "-100500", message_thread_id: "12" }),
  );
  assert.deepEqual(answer, {
    ok: true,
    name: "report.pdf",
    bytes: 6,
    message_id: 77,
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.telegram.org/bot123:secret/sendDocument");
  assert.equal(call.method, "POST");
  assert.equal(call.form.get("chat_id"), "-100500");
  assert.equal(call.form.get("message_thread_id"), "12");
  assert.equal(call.form.get("caption"), "отчёт");
  const document = call.form.get("document");
  assert.ok(document instanceof File);
  assert.equal(document.name, "report.pdf");
  assert.equal(await document.text(), "%PDF-1");
});

void test("абсолютный путь в Vault доходит до файла, без caption и темы поля не шлются", async (t) => {
  const calls = stubFetch(t);
  const absolute = await run(
    { path: join(vault, "attachments", "2026-09-24", "report.pdf") },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(absolute.ok, true);
  assert.equal(calls[0].form.get("caption"), null);
  assert.equal(calls[0].form.get("message_thread_id"), null);
});

void test("файл из временного каталога ОС разрешён", async (t) => {
  stubFetch(t);
  const dir = mkdtempSync(join(tmpdir(), "iva-send-file-tmp-"));
  writeFileSync(join(dir, "out.csv"), "a,b");
  const answer = await run(
    { path: join(dir, "out.csv") },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(answer.ok, true);
});

void test("файл вне Vault и tmp - отказ с подсказкой, fetch не зовётся", async (t) => {
  const calls = stubFetch(t);
  for (const path of [join(REPO, "package.json"), join(REPO, ".env")]) {
    const answer = await run({ path }, turnCtx({ chat_id: "1" }));
    assert.equal(answer.ok, false);
    assert.match(answer.ok ? "" : answer.error, REFUSAL);
  }
  assert.equal(calls.length, 0);
});

void test("симлинк из Vault наружу - отказ по реальному пути", async (t) => {
  const calls = stubFetch(t);
  const link = join(vault, "attachments", "leak.json");
  symlinkSync(join(REPO, "package.json"), link);
  const answer = await run(
    { path: "attachments/leak.json" },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(answer.ok, false);
  assert.match(answer.ok ? "" : answer.error, REFUSAL);
  assert.equal(calls.length, 0);
});

void test("нет файла и каталог вместо файла - понятная ошибка", async (t) => {
  const calls = stubFetch(t);
  const missing = await run(
    { path: "attachments/2026-09-24/nope.pdf" },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /не найден/);
  const directory = await run(
    { path: "attachments/2026-09-24" },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(directory.ok, false);
  assert.match(directory.ok ? "" : directory.error, /каталог/);
  assert.equal(calls.length, 0);
});

void test("файл больше предела Bot API - отказ до отправки", async (t) => {
  const calls = stubFetch(t);
  const answer = await sendFile(
    { path: "attachments/2026-09-24/report.pdf" },
    { id: "1", threadId: null },
    { maxBytes: 5 },
  );
  assert.equal(answer.ok, false);
  assert.match(answer.ok ? "" : answer.error, /50 МБ/);
  assert.equal(calls.length, 0);
});

void test("без чата хода - чат уведомлений; нет и его - ошибка", async (t) => {
  const calls = stubFetch(t);
  withChatEnv(t, { allowed: "42, 43" });
  const answer = await run(
    { path: "attachments/2026-09-24/report.pdf" },
    noTurn,
  );
  assert.equal(answer.ok, true);
  assert.equal(calls[0].form.get("chat_id"), "42");

  withChatEnv(t, {});
  const orphan = await run(
    { path: "attachments/2026-09-24/report.pdf" },
    noTurn,
  );
  assert.equal(orphan.ok, false);
  assert.match(orphan.ok ? "" : orphan.error, /TELEGRAM_DIGEST_CHAT_ID/);
  assert.equal(calls.length, 1);
});

void test("ответ Telegram ok:false - {ok:false,error} с его текстом", async (t) => {
  stubFetch(t, {
    ok: false,
    error_code: 400,
    description: "Bad Request: chat not found",
  });
  const answer = await run(
    { path: "attachments/2026-09-24/report.pdf" },
    turnCtx({ chat_id: "1" }),
  );
  assert.deepEqual(answer, {
    ok: false,
    error: "Telegram: Bad Request: chat not found",
  });
});

void test("сбой сети - ошибка без токена, исключение наружу не летит", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(
      new Error("connect to https://api.telegram.org/bot123:secret failed"),
    ),
  );
  const answer = await run(
    { path: "attachments/2026-09-24/report.pdf" },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(answer.ok, false);
  assert.doesNotMatch(answer.ok ? "" : answer.error, /123:secret/);
});

void test("подпись проходит тот же гейт секретов, что Outbox", async (t) => {
  const calls = stubFetch(t);
  const secret = "sk-ant-api03-" + "A".repeat(40);
  const answer = await run(
    { path: "attachments/2026-09-24/report.pdf", caption: `ключ ${secret}` },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(answer.ok, true);
  const caption = calls[0]?.form.get("caption");
  assert.equal(typeof caption, "string");
  assert.ok(!(caption as string).includes(secret), caption as string);
});

void test("жёсткая ссылка на файл снаружи - отказ", async (t) => {
  const calls = stubFetch(t);
  // Снаружи Vault, но на его разделе: между разделами жёсткую ссылку не создать (EXDEV).
  const outside = mkdtempSync(join(tmpdir(), "iva-send-file-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "secret.env"), "TOKEN=1");
  const link = join(vault, "attachments", "hard.txt");
  linkSync(join(outside, "secret.env"), link);
  t.after(() => rmSync(link, { force: true }));
  const answer = await run(
    { path: "attachments/hard.txt" },
    turnCtx({ chat_id: "1" }),
  );
  assert.equal(answer.ok, false);
  assert.equal(calls.length, 0);
});

void test("копии .env и промпт CLI во временном каталоге не уходят", async (t) => {
  const calls = stubFetch(t);
  const dirs = ["iva-env.x1", "iva-config-x2", "iva-claude-x3"].map((name) =>
    mkdtempSync(join(tmpdir(), name)),
  );
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const files = [
    join(dirs[0], "env"),
    join(dirs[1], ".env"),
    join(dirs[2], "system.md"),
  ];
  for (const file of files) writeFileSync(file, "x");
  for (const path of files) {
    const answer = await run({ path }, turnCtx({ chat_id: "1" }));
    assert.equal(answer.ok, false, path);
    assert.match(answer.ok ? "" : answer.error, REFUSAL);
  }
  assert.equal(calls.length, 0);
});

void test("текстовый файл с секретом получает отказ до sendDocument", async (t) => {
  const secret = "fixtureFileBearerWithoutPrefix";
  const before = process.env.ASSISTANT_BEARER;
  process.env.ASSISTANT_BEARER = secret;
  t.after(() => {
    if (before === undefined) delete process.env.ASSISTANT_BEARER;
    else process.env.ASSISTANT_BEARER = before;
  });
  for (const [index, content] of [
    `ASSISTANT_BEARER=${secret}\n`,
    secret,
    `| ASSISTANT_BEARER | ${secret} |`,
  ].entries()) {
    await t.test(`secret document carrier ${index}`, async (t) => {
      const calls = stubFetch(t);
      writeFileSync(join(vault, "attachments", "notes.txt"), content);
      const answer = await run(
        { path: "attachments/notes.txt" },
        turnCtx({ chat_id: "1" }),
      );
      assert.equal(answer.ok, false, "secret document sent");
      assert.match(answer.ok ? "" : answer.error, /секрет/u);
      assert.equal(calls.length, 0);
    });
  }
});

void test("обычный текст и двоичный файл отправляются исходными байтами", async (t) => {
  const calls = stubFetch(t);
  const contents = [
    Buffer.from("Отчёт: всё готово\nuser@example.com"),
    Buffer.from([0, 255, 254, 1, 2]),
  ];
  for (const [index, bytes] of contents.entries()) {
    writeFileSync(join(vault, "attachments", "safe.dat"), bytes);
    const answer = await run(
      { path: "attachments/safe.dat" },
      turnCtx({ chat_id: "1" }),
    );
    assert.equal(answer.ok, true);
    const document = calls[index].form.get("document");
    assert.ok(document instanceof File);
    assert.deepEqual(Buffer.from(await document.arrayBuffer()), bytes);
  }
});
