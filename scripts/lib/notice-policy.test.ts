/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn as realSpawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ALERT_REPEAT_MS,
  alertDue,
  alertOnce,
  alertResolved,
  CUSTOM_ALERT_KEY,
  customStockAlert,
  deliverMemoryReport,
  memoryReportTail,
  memoryReportsEnabled,
  nightReport,
  noticeLang,
  ownerKnowsTheSwitch,
  noticeTranslator,
  recordAlert,
  rollupRanBefore,
  settleReportsOffNotice,
  updateAlertState,
  USERBOT_ALERT_KEY,
  userbotOffAlert,
  userbotOffReason,
  type ReportsOffNotice,
  type Translate,
} from "./notice-policy.ts";
import fc from "fast-check";
import { sendTelegramHtml } from "./telegram-send.ts";
import { runScheduledJob } from "#lib/schedule-runner.ts";
import { acquireFileLockSync, releaseFileLock } from "#lib/fs-atomic.ts";

const EN: Translate = (english) => english;
const RU: Translate = (_english, russian) => russian;

function dataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-notice-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Report: тумблер ──────────────────────────────────────────────────────────────────────
test("memory reports stay off for anything that is not an explicit true", () => {
  for (const settings of [
    undefined,
    null,
    42,
    "on",
    [],
    {},
    { memoryReports: null },
    { memoryReports: "on" },
    { memoryReports: [] },
    { memoryReports: {} },
    { memoryReports: { enabled: "true" } },
    { memoryReports: { enabled: 1 } },
    { memoryReports: { enabled: false } },
  ])
    assert.equal(
      memoryReportsEnabled(settings),
      false,
      `${JSON.stringify(settings)} must not switch reports on`,
    );

  assert.equal(
    memoryReportsEnabled({ memoryReports: { enabled: true } }),
    true,
  );
  assert.equal(
    memoryReportsEnabled({ language: "en", memoryReports: { enabled: true } }),
    true,
  );
});

// ── Report: язык и форма ночного отчёта ──────────────────────────────────────────────────
test("the report tail names the language and forbids self-delivery", () => {
  const en = memoryReportTail(EN);
  const ru = memoryReportTail(RU);
  assert.match(en, /written in English/);
  assert.match(ru, /written in Russian/);
  for (const tail of [en, ru]) {
    assert.match(tail, /first person/);
    assert.match(tail, /3-5 short lines/);
    assert.match(tail, /Do not send it anywhere yourself/);
    assert.match(tail, /no rich messages, no digest chat/);
  }
  // Инструкция «без внутренних терминов» — единственное место, где они названы.
  assert.equal(en.split("ADD").length - 1, 1);
});

// ── Notice: язык берётся у резолвера, без дерева — у env ──────────────────────────────────
test("the stock-build Alert says what broke, that the files are safe and what to do", () => {
  const line = "error TS1005: ';' expected.";
  const en = customStockAlert(EN, line);
  const ru = customStockAlert(RU, line);
  assert.equal(
    en,
    "Iva is running the stock build: your files in data/custom do not build with this version — error TS1005: ';' expected. The files are untouched; fix them and the next `iva update` puts them back.",
  );
  assert.equal(
    ru,
    "Ива работает на заводской сборке: ваши файлы в data/custom не собрались с этой версией — error TS1005: ';' expected. Файлы на месте; поправьте их, и следующее `iva update` поставит их снова.",
  );
  assert.match(
    customStockAlert(EN, null),
    /— last time the version carrying them did not come up\./u,
  );
  assert.match(
    customStockAlert(RU, null),
    /— в прошлый раз версия с ними не поднялась\./u,
  );
  // Слова Avoid из CONTEXT.md не идут владельцу.
  for (const text of [
    en,
    ru,
    customStockAlert(EN, null),
    customStockAlert(RU, null),
  ])
    assert.doesNotMatch(
      text,
      /билд|кастомизаци|digest|retry|warning|override|лимит/iu,
    );
  assert.equal(CUSTOM_ALERT_KEY, "custom-build");
});

// Обновление выключило юзербот (#273): кто обновлялся кнопкой в боте, вывода апдейта не видит.
test("the userbot Alert says it is off, what that costs and where to turn it back on", () => {
  const reason =
    "userbot: зависимости не импортируются — ModuleNotFoundError: telegram_mcp.";
  assert.equal(
    userbotOffAlert(RU, reason),
    "⚠️ Ива выключила юзербот: после обновления он не запустился — зависимости не импортируются — ModuleNotFoundError: telegram_mcp. Пока он выключен, Ива не читает и не ищет ваши чаты от вашего аккаунта; остальное работает как раньше. Включить обратно: /menu → 📡 Userbot → «Включить».",
  );
  assert.equal(
    userbotOffAlert(EN, "userbot: restart failed (exit 1)"),
    "⚠️ Iva switched the userbot off: it did not come up after the update — restart failed (exit 1). While it is off, Iva cannot read or search your chats as your account; everything else works as before. Turn it back on: /menu → 📡 Userbot → «Turn on».",
  );
  // Причины без слов: нет ни висячего тире, ни двойной точки.
  for (const empty of ["", "userbot: ", "  .  ", "\n"]) {
    assert.match(
      userbotOffAlert(EN, empty),
      /^⚠️ Iva switched the userbot off: it did not come up after the update\. While/u,
    );
    assert.match(
      userbotOffAlert(RU, empty),
      /^⚠️ Ива выключила юзербот: после обновления он не запустился\. Пока/u,
    );
  }
  // Причина в несколько строк — одна строка сообщения.
  assert.equal(userbotOffReason("userbot: a\n  b.\n"), "a b");
  assert.equal(userbotOffReason(reason), userbotOffReason(`${reason}\n`));
  // Слова Avoid из CONTEXT.md не идут владельцу. Проверяется текст Ивы, а не причина:
  // её слова — вывод чужой программы.
  for (const tr of [EN, RU])
    for (const why of ["", "X"])
      assert.doesNotMatch(
        userbotOffAlert(tr, why),
        /билд|кастомизаци|digest|retry|warning|override|лимит|ошибк|bridge|gateway|демон|воркер|sidecar|notification|пуш/iu,
      );
  assert.equal(USERBOT_ALERT_KEY, "userbot-off");
});

test("the userbot Alert keeps any reason on one line and names the screen (seed 20261010)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (raw) => {
      const why = userbotOffReason(raw);
      assert.doesNotMatch(why, /\s{2}|^\s|\s$|\n/u);
      assert.doesNotMatch(why, /^userbot:|\.$/u);
      for (const tr of [EN, RU]) {
        const text = userbotOffAlert(tr, raw);
        assert.ok(text.startsWith("⚠️ "), text);
        assert.ok(text.includes("/menu → 📡 Userbot → «"), text);
        // Причина стоит после тире и кончается одной точкой текста; без причины нет и тире.
        if (why) assert.ok(text.includes(`— ${why}. `), text);
        else assert.doesNotMatch(text, /—/u);
      }
    }),
    { seed: 20261010, numRuns: 200 },
  );
});

test("notice language comes from the tree, and falls back to the env without it", async () => {
  const broken = () => Promise.reject(new Error("no authored tree"));
  assert.equal(await noticeLang({}, broken), "ru");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "ru" }, broken), "ru");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "en" }, broken), "en");
  assert.equal(await noticeLang({ AGENT_LANGUAGE: "de" }, broken), "ru");
  // Дерево есть — его ответ важнее env.
  assert.equal(
    await noticeLang({ AGENT_LANGUAGE: "ru" }, () =>
      Promise.resolve({ getLang: () => "en" as const }),
    ),
    "en",
  );
  const tr = await noticeTranslator({ AGENT_LANGUAGE: "en" }, broken);
  assert.equal(tr("EN", "RU"), "EN");
});

// ── След прежних прогонов ────────────────────────────────────────────────────────────────
function vaultSummary(dir: string, name = "2026-08-11.md"): void {
  mkdirSync(join(dir, "summaries/daily"), { recursive: true });
  writeFileSync(join(dir, "summaries/daily", name), "# day\n");
}

test("a rollup that ran here before leaves a trace that survives its own cleanup", (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);

  // Свежая установка: каталог данных пуст, vault привезён шаблоном (пустой summaries/daily).
  mkdirSync(join(vault, "summaries/daily"), { recursive: true });
  writeFileSync(join(vault, "summaries/daily/.gitkeep"), "");
  writeFileSync(join(data, "settings.json"), "{}");
  writeFileSync(join(data, "tasks.json"), "[]");
  assert.equal(rollupRanBefore(data, vault), false);
  assert.equal(rollupRanBefore(join(data, "nope"), join(vault, "nope")), false);

  // Курсор любого периода — след.
  writeFileSync(join(data, "rollup-session-weekly.json"), "{}");
  assert.equal(rollupRanBefore(data, vault), true);

  // Файл сессии живёт только пока идёт ход — статус расписаний остаётся.
  rmSync(join(data, "rollup-session-weekly.json"));
  // Бронь текущего прогона (спавнер пишет её ДО запуска) следом не считается.
  writeFileSync(
    join(data, "rollup-status.json"),
    JSON.stringify({
      "memory-daily": {
        lastStartedAt: 1,
        inProgressSince: 1,
        ownerPid: process.pid,
      },
    }),
  );
  assert.equal(rollupRanBefore(data, vault), false);
  // Завершение — считается, и успехом, и провалом: прогон был.
  writeFileSync(
    join(data, "rollup-status.json"),
    JSON.stringify({ "memory-daily": { lastFinishedAt: 1, lastExitCode: 1 } }),
  );
  assert.equal(rollupRanBefore(data, vault), true);
  writeFileSync(
    join(data, "rollup-status.json"),
    JSON.stringify({ "memory-daily": { lastSuccessAt: 1 } }),
  );
  assert.equal(rollupRanBefore(data, vault), true);

  // Битый статус — не след; чужие записи в нём — тоже.
  writeFileSync(join(data, "rollup-status.json"), "{ not json");
  assert.equal(rollupRanBefore(data, vault), false);
  writeFileSync(
    join(data, "rollup-status.json"),
    JSON.stringify({ digest: { lastSuccessAt: 1 } }),
  );
  assert.equal(rollupRanBefore(data, vault), false);

  // Дневная сводка в vault — след даже с пустым data/ (обновление с версии без курсоров).
  vaultSummary(vault);
  assert.equal(rollupRanBefore(data, vault), true);
});

// ── Миграция: решение принимается один раз, на первой же ночи ────────────────────────────
// Ночь воспроизводится в том же порядке, что в rollup.ts: сначала читается след прежних
// прогонов, потом прогон оставляет СВОИ следы (курсор и запись в статусе расписаний), и
// только в конце решается судьба Notice. Без записанного решения вторая ночь свежей
// установки выглядит как старая — ровно та регрессия, ради которой это и проверяется.
type Night = { outcome: ReportsOffNotice; said: number };

async function night(
  data: string,
  vault: string,
  sent: string[],
  options: { chat?: boolean; ownerKnows?: boolean } = {},
): Promise<Night> {
  const { chat = true, ownerKnows = false } = options;
  const ranBefore = rollupRanBefore(data, vault);
  writeFileSync(
    join(data, "rollup-session-daily.json"),
    JSON.stringify({ state: {}, createdAt: Date.now() }),
  );
  writeFileSync(
    join(data, "rollup-status.json"),
    JSON.stringify({ "memory-daily": { lastSuccessAt: Date.now() } }),
  );
  const outcome = await settleReportsOffNotice({
    dataDir: data,
    ranBefore,
    ownerKnows,
    send: chat
      ? () => {
          sent.push("notice");
          return Promise.resolve(true);
        }
      : null,
  });
  return { outcome, said: sent.length };
}

function markerDecision(dir: string): string {
  const marker: unknown = JSON.parse(
    readFileSync(join(dir, "notice-memory-reports-off.json"), "utf8"),
  );
  return String((marker as { decision?: string }).decision);
}

test("a fresh installation is never told about a report it never had", async (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);
  const sent: string[] = [];

  const first = await night(data, vault, sent);
  const second = await night(data, vault, sent);
  const third = await night(data, vault, sent);

  assert.deepEqual(
    [first.outcome, second.outcome, third.outcome],
    ["not-needed", "settled", "settled"],
    "the answer is decided on night one and never revisited",
  );
  assert.equal(sent.length, 0, "not a single morning message");
  assert.equal(markerDecision(data), "not-needed");
});

test("a fresh installation whose chat is configured later still stays silent", async (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);
  const sent: string[] = [];

  // Первые две ночи бот ещё не настроен, поэтому отправлять некуда.
  const first = await night(data, vault, sent, { chat: false });
  await night(data, vault, sent, { chat: false });
  // Чат появился — но вопрос уже закрыт.
  const withChat = await night(data, vault, sent);

  assert.equal(first.outcome, "not-needed");
  assert.equal(withChat.outcome, "settled");
  assert.equal(sent.length, 0);
  assert.equal(markerDecision(data), "not-needed");
});

test("an installation that had the report hears once, then never again", async (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);
  const sent: string[] = [];
  // Свёртка гонялась до апдейта: её курсор лежит в data/.
  writeFileSync(join(data, "rollup-session-daily.json"), "{}");

  const first = await night(data, vault, sent);
  const second = await night(data, vault, sent);

  assert.deepEqual([first.outcome, second.outcome], ["sent", "settled"]);
  assert.equal(sent.length, 1, "one message, not one per night");
});

test("an old installation without a chat closes the question without a word", async (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);
  const sent: string[] = [];
  vaultSummary(vault); // отчёты у неё были

  const first = await night(data, vault, sent, { chat: false });
  const later = await night(data, vault, sent);

  assert.equal(first.outcome, "skipped");
  assert.equal(markerDecision(data), "skipped");
  assert.equal(later.outcome, "settled", "stale news is not delivered late");
  assert.equal(sent.length, 0);
});

test("an owner who switched the reports off himself gets no lecture about it", async (t) => {
  const data = dataDir(t);
  const vault = dataDir(t);
  const sent: string[] = [];
  vaultSummary(vault); // старая установка: отчёты у неё были

  const first = await night(data, vault, sent, { ownerKnows: true });
  const second = await night(data, vault, sent, { ownerKnows: true });

  assert.deepEqual([first.outcome, second.outcome], ["not-needed", "settled"]);
  assert.equal(sent.length, 0);
  assert.equal(markerDecision(data), "not-needed");
});

test("the switch itself is what tells us the owner knows about it", () => {
  assert.equal(
    ownerKnowsTheSwitch({ memoryReports: { enabled: false } }),
    true,
  );
  assert.equal(ownerKnowsTheSwitch({ memoryReports: {} }), true);
  assert.equal(ownerKnowsTheSwitch({ language: "ru" }), false);
  assert.equal(ownerKnowsTheSwitch({}), false);
  assert.equal(ownerKnowsTheSwitch(null), false);
  assert.equal(ownerKnowsTheSwitch("memoryReports"), false);
  // Унаследованное имя свойства — не выбор владельца.
  assert.equal(ownerKnowsTheSwitch({ toString: 1 }), false);
});

test("daily and weekly on the same night say it once between them", async (t) => {
  const dir = dataDir(t);
  let said = 0;
  const send = async () => {
    // Обе свёртки уже внутри отправки: заявку разрешает файловая система, а не порядок.
    await new Promise((resolve) => setTimeout(resolve, 5));
    said += 1;
    return true;
  };

  const outcomes = await Promise.all([
    settleReportsOffNotice({ dataDir: dir, ranBefore: true, send }),
    settleReportsOffNotice({ dataDir: dir, ranBefore: true, send }),
  ]);

  assert.deepEqual([...outcomes].sort(), ["sent", "settled"]);
  assert.equal(said, 1);
});

test("a notice that could not be delivered is said by the next night", async (t) => {
  const dir = dataDir(t);
  const marker = join(dir, "notice-memory-reports-off.json");

  assert.equal(
    await settleReportsOffNotice({
      dataDir: dir,
      ranBefore: true,
      send: () => Promise.resolve(false),
    }),
    "failed",
  );
  assert.equal(existsSync(marker), false, "the claim is given back");

  let said = 0;
  assert.equal(
    await settleReportsOffNotice({
      dataDir: dir,
      ranBefore: true,
      send: () => {
        said += 1;
        return Promise.resolve(true);
      },
    }),
    "sent",
  );
  assert.equal(said, 1);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
});

// ── Что уходит в чат по итогам прогона: ровно одно сообщение или ни одного ───────────────
// Транспорт настоящий (sendTelegramHtml → Outbox → Bot API), поймана только сеть: так видно
// и число сообщений, и их текст — то, что увидел бы владелец.
function telegramCalls(
  t: TestContext,
): Array<{ method: string; text: string }> {
  const calls: Array<{ method: string; text: string }> = [];
  const mutable = globalThis as unknown as { fetch: unknown };
  const previous = mutable.fetch;
  t.after(() => {
    mutable.fetch = previous;
  });
  mutable.fetch = (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { text?: string };
    calls.push({ method: url.split("/").at(-1) ?? "", text: body.text ?? "" });
    return Promise.resolve({ ok: true, status: 200, text: () => "" });
  };
  return calls;
}

function delivery(dir: string, settings: unknown, ranBefore: boolean) {
  return deliverMemoryReport({
    dataDir: dir,
    settings,
    ranBefore,
    report: "Запомнила три вещи про проект.",
    tr: RU,
    send: {
      report: (text) => sendTelegramHtml("token", "42", text),
      notice: (text) => sendTelegramHtml("token", "42", text),
    },
  });
}

test("a switched-on report goes out exactly once per run", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const result = await delivery(
    dir,
    { memoryReports: { enabled: true } },
    true,
  );

  assert.equal(result.status, "sent");
  assert.equal(result.notice, "not-asked");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  assert.match(calls[0].text, /Запомнила три вещи про проект/);
  assert.equal(existsSync(join(dir, "notice-memory-reports-off.json")), false);
});

test("a switched-off report on a fresh installation sends nothing at all", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const first = await delivery(dir, {}, false);
  const second = await delivery(dir, {}, true); // вторая ночь: курсор уже есть

  assert.equal(first.status, "off");
  assert.equal(first.notice, "not-needed");
  assert.equal(second.notice, "settled");
  assert.deepEqual(calls, [], "a fresh install says nothing in the morning");
});

test("a switched-off report on an old installation sends the notice, once", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  // Установка после апдейта: ключа memoryReports в settings ещё нет — тумблера владелец
  // не касался, отчёт у него был, и молчание нужно объяснить.
  const first = await delivery(dir, { language: "ru" }, true);
  const second = await delivery(dir, {}, true);

  assert.equal(first.notice, "sent");
  assert.equal(second.notice, "settled");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Утренние отчёты памяти теперь выключены/);
  assert.match(calls[0].text, /\/menu → 🔔 Уведомления/);
  assert.doesNotMatch(calls[0].text, /Запомнила три вещи/);
});

test("an owner who used the switch gets the report neither way", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  const result = await delivery(
    dir,
    { memoryReports: { enabled: false } },
    true,
  );

  assert.equal(result.status, "off");
  assert.equal(result.notice, "not-needed");
  assert.deepEqual(calls, [], "no lecture about his own tap");
});

test("a report carrying a secret is redacted on the way out", async (t) => {
  // Ночной отчёт пишет модель по чужому дню, поэтому он такой же рантайм-текст, как
  // алерты brain: доставка обязана идти через outbound-Gate (ADR-0005), а не мимо.
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  await deliverMemoryReport({
    dataDir: dir,
    settings: { memoryReports: { enabled: true } },
    ranBefore: true,
    report: "Разобрала день. Ключ password=hunter2hunter лежал в заметке.",
    tr: RU,
    send: {
      report: (text) => sendTelegramHtml("token", "42", text),
      notice: (text) => sendTelegramHtml("token", "42", text),
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Разобрала день/);
  assert.doesNotMatch(calls[0].text, /hunter2hunter/);
  assert.match(calls[0].text, /REDACTED/);
});

test("settings that are junk keep the report in the vault, not in the chat", async (t) => {
  const dir = dataDir(t);
  const calls = telegramCalls(t);

  for (const settings of [
    undefined,
    null,
    "on",
    42,
    [],
    { memoryReports: 1 },
  ]) {
    const result = await delivery(dir, settings, false);
    assert.equal(result.status, "off", `${JSON.stringify(settings)} is not on`);
  }
  assert.deepEqual(calls, []);
});

// ── Alert: дроссель ──────────────────────────────────────────────────────────────────────
function alertState(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
}

test("recordAlert: the one throttle writer says whether the mark was written (the Watch claim needs it)", (t) => {
  const dir = dataDir(t);
  const now = Date.UTC(2026, 9, 5, 12);
  assert.equal(recordAlert(dir, "failure:backup.service", "1", now), true);
  assert.equal(alertDue(dir, "failure:backup.service", "1", now + 1), false);
  assert.equal(alertDue(dir, "failure:backup.service", "2", now + 1), true);
  // Каталог данных — файл: записать некуда, отметки нет, отказ виден вызывающему.
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "");
  t.mock.method(console, "error", () => {});
  assert.equal(recordAlert(file, "failure:backup.service", "1", now), false);
});

test("an alert speaks once, then keeps quiet for a week", async (t) => {
  const dir = dataDir(t);
  let sent = 0;
  const send = () => {
    sent += 1;
    return Promise.resolve(true);
  };

  assert.equal(await alertOnce(dir, "vault-remote", "missing", send), "sent");
  assert.equal(
    await alertOnce(dir, "vault-remote", "missing", send),
    "throttled",
  );
  assert.equal(sent, 1);

  // Шесть дней спустя — ещё рано; семь — уже пора.
  const stored = alertState(dir);
  const record = stored["vault-remote"] as { lastSentAt: number };
  const sixDays = record.lastSentAt - 6 * 24 * 60 * 60 * 1000;
  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": { essence: "missing", lastSentAt: sixDays },
    }),
  );
  assert.equal(
    await alertOnce(dir, "vault-remote", "missing", send),
    "throttled",
  );

  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": {
        essence: "missing",
        lastSentAt: Date.now() - ALERT_REPEAT_MS,
      },
    }),
  );
  assert.equal(await alertOnce(dir, "vault-remote", "missing", send), "sent");
  assert.equal(sent, 2);
});

test("a different problem under the same key speaks at once", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];
  const send = (essence: string) => () => {
    sent.push(essence);
    return Promise.resolve(true);
  };

  await alertOnce(dir, "maintenance", "enforce", send("enforce"));
  assert.equal(
    await alertOnce(dir, "maintenance", "enforce", send("enforce")),
    "throttled",
  );
  assert.equal(
    await alertOnce(dir, "maintenance", "enforce,decay", send("enforce,decay")),
    "sent",
  );
  assert.deepEqual(sent, ["enforce", "enforce,decay"]);
});

test("a problem that came back after the fix speaks at once", async (t) => {
  const dir = dataDir(t);
  let sent = 0;
  const send = () => {
    sent += 1;
    return Promise.resolve(true);
  };

  await alertOnce(dir, "health-drop", "dropping", send);
  alertResolved(dir, "health-drop");
  assert.deepEqual(alertState(dir), {});
  assert.equal(await alertOnce(dir, "health-drop", "dropping", send), "sent");
  assert.equal(sent, 2);

  // Нечего забывать — файл не трогаем и не падаем.
  alertResolved(dir, "never-seen");
  assert.equal(Object.keys(alertState(dir)).length, 1);
});

test("the backup alerts forget the problem once the backup works again", async (t) => {
  const dir = dataDir(t);
  const sent: string[] = [];
  const send = (key: string) => () => {
    sent.push(key);
    return Promise.resolve(true);
  };

  for (const key of ["backup-scan", "backup-oversize"]) {
    await alertOnce(dir, key, "unreadable", send(key));
    assert.equal(
      await alertOnce(dir, key, "unreadable", send(key)),
      "throttled",
    );
    // Ночь, когда бэкап прошёл: проблема забыта.
    alertResolved(dir, key);
    // Назавтра сломалось снова — говорим сразу, а не через неделю.
    assert.equal(await alertOnce(dir, key, "unreadable", send(key)), "sent");
  }

  assert.deepEqual(sent, [
    "backup-scan",
    "backup-scan",
    "backup-oversize",
    "backup-oversize",
  ]);
});

test("an alert that never left does not silence the next run", async (t) => {
  const dir = dataDir(t);
  assert.equal(
    await alertOnce(dir, "backup-push", "auth", () => Promise.resolve(false)),
    "failed",
  );
  assert.equal(existsSync(join(dir, "alert-state.json")), false);
  assert.equal(
    await alertOnce(dir, "backup-push", "auth", () => Promise.resolve(true)),
    "sent",
  );
});

test("unreadable, half-written or foreign alert state means speak", (t) => {
  const dir = dataDir(t);
  const path = join(dir, "alert-state.json");
  const cases = [
    "",
    "{ not json",
    '{"vault-remote":{"essence":"missing"',
    "null",
    "[]",
    '"string"',
    '{"vault-remote":null}',
    '{"vault-remote":{"essence":"missing"}}',
    '{"vault-remote":{"essence":"missing","lastSentAt":"today"}}',
    `{"vault-remote":{"essence":"missing","lastSentAt":${Number.MAX_VALUE * 2}}}`,
  ];
  for (const text of cases) {
    writeFileSync(path, text);
    assert.equal(
      alertDue(dir, "vault-remote", "missing"),
      true,
      `state ${text} must fail open`,
    );
  }

  // Файла нет вовсе — тоже говорим.
  rmSync(path, { force: true });
  assert.equal(alertDue(dir, "vault-remote", "missing"), true);
});

test("a clock that jumped back cannot mute an alert forever", (t) => {
  const dir = dataDir(t);
  const now = Date.now();
  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "vault-remote": { essence: "missing", lastSentAt: now + ALERT_REPEAT_MS },
    }),
  );
  assert.equal(alertDue(dir, "vault-remote", "missing", now), true);
});

test("a custom repeat period re-arms sooner; the default stays a week", async (t) => {
  const dir = dataDir(t);
  const repeatMs = 10 * 60 * 1000;
  let sent = 0;
  const send = () => {
    sent += 1;
    return Promise.resolve(true);
  };

  assert.equal(
    await alertOnce(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      send,
      repeatMs,
    ),
    "sent",
  );
  assert.equal(sent, 1);

  const lastSentAt = (
    alertState(dir)["telegram-acceptance:k"] as { lastSentAt: number }
  ).lastSentAt;

  assert.equal(
    alertDue(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      lastSentAt + 5 * 60 * 1000,
      repeatMs,
    ),
    false,
  );
  assert.equal(
    alertDue(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      lastSentAt + 11 * 60 * 1000,
      repeatMs,
    ),
    true,
  );
  // Без своего периода через 11 минут всё ещё неделя — дроссель жив.
  assert.equal(
    alertDue(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      lastSentAt + 11 * 60 * 1000,
    ),
    false,
  );

  assert.equal(
    await alertOnce(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      send,
      repeatMs,
    ),
    "throttled",
  );
  writeFileSync(
    join(dir, "alert-state.json"),
    JSON.stringify({
      "telegram-acceptance:k": {
        essence: "message acceptance failed",
        lastSentAt: Date.now() - 11 * 60 * 1000,
      },
    }),
  );
  assert.equal(
    await alertOnce(
      dir,
      "telegram-acceptance:k",
      "message acceptance failed",
      send,
      repeatMs,
    ),
    "sent",
  );
  assert.equal(sent, 2);
});

test("the alert state is written atomically and stays private", async (t) => {
  const dir = dataDir(t);
  await alertOnce(dir, "core-cap", "clamped", () => Promise.resolve(true));
  const path = join(dir, "alert-state.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    readFileSync(path, "utf8").trim().slice(0, 1),
    "{",
    "the whole file, never half of it",
  );
  assert.equal(
    typeof (alertState(dir)["core-cap"] as { lastSentAt?: unknown }).lastSentAt,
    "number",
  );
});

// ── Язык живой установки: settings.language побеждает env ────────────────────────────────
// getLang кэширует язык на ~2с и читает settings.json от cwd, поэтому каждый сценарий —
// свежий процесс со своим data-каталогом (тот же приём, что в agent/lib/i18n.test.ts).
const PROBE = `
const policy = await import(process.env.__POLICY_URL);
const tr = await policy.noticeTranslator();
process.stdout.write(JSON.stringify({
  lang: await policy.noticeLang(),
  tail: policy.memoryReportTail(tr),
  migration: policy.memoryReportsOffNotice(tr),
}));
`;

function probe(settingsLanguage: string | null, agentLanguage: string) {
  const dir = mkdtempSync(join(tmpdir(), "iva-notice-lang-"));
  if (settingsLanguage !== null)
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ language: settingsLanguage }),
    );
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", PROBE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        __POLICY_URL: pathToFileURL(
          join(import.meta.dirname, "notice-policy.ts"),
        ).href,
        ASSISTANT_DATA_DIR: dir,
        AGENT_LANGUAGE: agentLanguage,
      },
    },
  );
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(output) as {
    lang: string;
    tail: string;
    migration: string;
  };
}

test("the switch in /menu decides the language of every notice, not the env", () => {
  const english = probe("en", "ru");
  assert.equal(english.lang, "en");
  assert.match(english.tail, /written in English/);
  assert.match(english.migration, /Morning memory reports are now off/);

  const russian = probe("ru", "en");
  assert.equal(russian.lang, "ru");
  assert.match(russian.tail, /written in Russian/);
  assert.match(russian.migration, /Утренние отчёты памяти теперь выключены/);

  // Настроек нет — остаётся env, потом дефолт.
  assert.equal(probe(null, "en").lang, "en");
  assert.equal(probe(null, "").lang, "ru");
});

// ── Первая ночь свежей установки, через НАСТОЯЩИЙ спавнер расписаний ─────────────────────
// Спавнер резервирует слот в data/rollup-status.json ДО запуска свёртки (lastStartedAt,
// inProgressSince, ownerPid). Если считать следом само имя периода, свежая установка
// прочитает собственную бронь как чужой прошлый прогон — и получит Notice в первую же ночь.
test("the very first scheduled run is not mistaken for a run that happened before", async (t) => {
  const home = dataDir(t);
  const data = join(home, "data");
  const vault = join(home, "vault");
  mkdirSync(join(vault, "summaries/daily"), { recursive: true });
  writeFileSync(join(vault, "summaries/daily/.gitkeep"), "");
  mkdirSync(data, { recursive: true });
  const calls = telegramCalls(t);

  const seen: boolean[] = [];
  const result = await runScheduledJob({
    name: "memory-daily",
    argv: ["scripts/memory/rollup.ts", "daily"],
    root: home,
    nodeBin: process.execPath,
    statusPath: join(data, "rollup-status.json"),
    log: () => {},
    // Здесь, вместо самой свёртки, стоит её первый шаг: прочитать след прежних прогонов.
    // К этому моменту бронь текущего прогона уже лежит в статус-файле.
    spawnImpl: (_cmd, _args, options) => {
      seen.push(rollupRanBefore(data, vault));
      return realSpawn(process.execPath, ["-e", "process.exit(0)"], options);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(seen, [false], "its own reservation is not a past run");

  // И решение, принятое с этим признаком, молчит.
  const delivery = await deliverMemoryReport({
    dataDir: data,
    settings: {},
    ranBefore: seen[0],
    report: "ночной отчёт",
    tr: RU,
    send: {
      report: (text) => sendTelegramHtml("token", "42", text),
      notice: (text) => sendTelegramHtml("token", "42", text),
    },
  });
  assert.equal(delivery.notice, "not-needed");
  assert.deepEqual(
    calls,
    [],
    "a fresh installation hears nothing on night one",
  );

  // Зато завершённый прогон — уже след: вторая ночь видит установку как гонявшую свёртку.
  assert.equal(rollupRanBefore(data, vault), true);
});

// ── Дроссель: несколько писателей ─────────────────────────────────────────────────────────
// alert-state.json пишут тик проактивности, мост, ночь и апдейтер. Чтение-правка-запись без замка
// теряла чужую отметку: оба читают {}, первый пишет {A}, второй {B} — A пропала, хотя оба
// ответили «записано».

test("alert state: a writer that read first does not erase what another wrote after its read (barrier after the read)", (t) => {
  const dir = dataDir(t);
  let inner: boolean | undefined;
  const outer = updateAlertState(
    dir,
    (state) => {
      state.a = { essence: "x", lastSentAt: 1 };
      return true;
    },
    () => {
      // Второй писатель приходит ровно между чтением и записью первого.
      inner = recordAlert(dir, "b", "y", 2);
    },
  );
  const state = JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(outer, true);
  assert.ok("a" in state);
  assert.ok(
    !(inner === true && !("b" in state)),
    "a writer told «recorded» must not be lost",
  );
});

test("alert state: recordAlert and alertResolved wait for the lock and refuse while it is held", (t) => {
  const dir = dataDir(t);
  recordAlert(dir, "old", "e", 1);
  const lock = acquireFileLockSync(join(dir, "alert-state.lock"));
  assert.ok(lock);
  try {
    assert.equal(recordAlert(dir, "k", "e", 2), false);
    alertResolved(dir, "old");
  } finally {
    releaseFileLock(lock);
  }
  const state = JSON.parse(
    readFileSync(join(dir, "alert-state.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state), ["old"]);
  assert.equal(recordAlert(dir, "k", "e", 2), true);
  alertResolved(dir, "old");
  assert.deepEqual(
    Object.keys(
      JSON.parse(readFileSync(join(dir, "alert-state.json"), "utf8")) as object,
    ),
    ["k"],
  );
});

// ── Дроссель без authored tree ───────────────────────────────────────────────────────────
// Установка со сломанным agent/ — ровно та, которой алерт нужен каждую ночь; если состояние
// дросселя писать через #lib/fs-atomic.ts, оно бы там не писалось вовсе. Модуль копируется в
// каталог со СВОИМ package.json, где алиаса #lib нет вообще: так проверяется, что политика
// живёт на одном node:fs.
const NO_TREE_PROBE = `
const policy = await import(process.env.__POLICY_URL);
const dir = process.env.__DATA_DIR;
const first = await policy.alertOnce(dir, "authored-tree", "unloadable", () => Promise.resolve(true));
const second = await policy.alertOnce(dir, "authored-tree", "unloadable", () => Promise.resolve(true));
process.stdout.write(JSON.stringify({
  first,
  second,
  lang: await policy.noticeLang({ AGENT_LANGUAGE: "en" }),
}));
`;

test("the weekly throttle works on an installation whose agent/ is gone", (t) => {
  const home = dataDir(t);
  const island = join(home, "island");
  const data = join(home, "data");
  mkdirSync(island, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(island, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    join(island, "notice-policy.ts"),
    readFileSync(join(import.meta.dirname, "notice-policy.ts"), "utf8"),
  );

  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", NO_TREE_PROBE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        __POLICY_URL: pathToFileURL(join(island, "notice-policy.ts")).href,
        __DATA_DIR: data,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const probe = JSON.parse(output) as {
    first: string;
    second: string;
    lang: string;
  };
  assert.equal(probe.first, "sent");
  assert.equal(
    probe.second,
    "throttled",
    "the throttle must survive without agent/",
  );
  assert.equal(probe.lang, "en", "the language falls back to the environment");
  const statePath = join(data, "alert-state.json");
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(
    typeof (state as Record<string, { lastSentAt?: unknown }>)["authored-tree"]
      .lastSentAt,
    "number",
  );
});

// Report ночи: при любых фактах 2–5 строк, провал — одна строка, дат ISO и служебного
// текста нет. Провал печатает seed; повтор: IVA_NIGHT_REPORT_SEED=<seed>.
const REPORT_SEED = Number(process.env.IVA_NIGHT_REPORT_SEED ?? 20_260_928);

test(`nightReport: форма при любых фактах (seed ${REPORT_SEED})`, () => {
  const date = fc
    .date({
      min: new Date("2020-01-01T00:00:00Z"),
      max: new Date("2030-12-31T00:00:00Z"),
      noInvalidDate: true,
    })
    .map((value) => value.toISOString().slice(0, 10));
  const facts = fc.record({
    days: fc.array(
      fc.record({ date, gist: fc.constantFrom("", "Запуск Авроры", "Week") }),
      { minLength: 1, maxLength: 6 },
    ),
    created: fc.nat(30),
    updated: fc.nat(30),
    failedDays: fc.nat(4),
    problems: fc.boolean(),
  });
  fc.assert(
    fc.property(facts, fc.constantFrom(EN, RU), (value, tr) => {
      const lines = nightReport(tr, value).split("\n");
      assert.ok(lines.length >= 2 && lines.length <= 5, lines.join("|"));
      assert.equal(
        lines.filter((line) => /\d{4}-\d{2}-\d{2}/u.test(line)).length,
        0,
      );
      const failure = /Not everything|Не всё|Some small|Часть мелких/u;
      const failures = lines.filter((line) => failure.test(line)).length;
      assert.equal(failures, value.failedDays || value.problems ? 1 : 0);
    }),
    { seed: REPORT_SEED, numRuns: 300 },
  );
});

// Выжимка дня — слова модели: переводы строк и пробелы в ней не раздувают Report. В Report она
// одна строка, повторные пробелы схлопнуты, Report остаётся в 2–5 строках.
test(`nightReport: выжимка дня — одна строка при любом тексте (seed ${REPORT_SEED})`, () => {
  const piece = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.constantFrom(
      "\n",
      "\r\n",
      "\r",
      "  ",
      "\t",
      "\u2028",
      "\u2029",
      "\n\n\n",
    ),
  );
  const gist = fc.array(piece, { maxLength: 8 }).map((parts) => parts.join(""));
  const facts = fc.record({
    days: fc.array(fc.record({ date: fc.constant("2026-09-26"), gist }), {
      minLength: 1,
      maxLength: 4,
    }),
    created: fc.nat(3),
    updated: fc.nat(3),
    failedDays: fc.nat(2),
    problems: fc.boolean(),
  });
  fc.assert(
    fc.property(facts, fc.constantFrom(EN, RU), (value, tr) => {
      const report = nightReport(tr, value);
      const lines = report.split("\n");
      assert.ok(lines.length >= 2 && lines.length <= 5, lines.join("|"));
      assert.doesNotMatch(report, /[\r\t\u2028\u2029]| {2}/u);
      const gists = value.days
        .slice(-2)
        .map((day) => day.gist.replace(/\s+/gu, " ").trim())
        .filter(Boolean);
      for (const one of gists)
        assert.ok(
          lines.some((line) => line.endsWith(`: ${one}`)),
          `${JSON.stringify(one)} в Report`,
        );
    }),
    { seed: REPORT_SEED, numRuns: 300 },
  );
});

test("nightReport: русские склонения дней", () => {
  const facts = (n: number, failed: number) => ({
    days: Array.from({ length: n }, () => ({ date: "2026-09-26", gist: "" })),
    created: 0,
    updated: 0,
    failedDays: failed,
    problems: false,
  });
  assert.match(
    nightReport(RU, facts(1, 0)),
    /^Ночью я разобрала 1 день памяти/u,
  );
  assert.match(nightReport(RU, facts(3, 0)), /разобрала 3 дня памяти/u);
  assert.match(nightReport(RU, facts(5, 0)), /разобрала 5 дней памяти/u);
  assert.match(nightReport(RU, facts(11, 0)), /разобрала 11 дней памяти/u);
  assert.match(nightReport(RU, facts(1, 2)), /2 дня не разобраны/u);
  assert.match(nightReport(EN, facts(2, 1)), /1 day was not processed/u);
});
