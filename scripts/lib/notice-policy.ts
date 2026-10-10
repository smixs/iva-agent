// Политика Notice — всё, что Iva говорит сама, без хода пользователя (CONTEXT.md). Здесь
// правила двух видов (ADR-0007); Watch и Brief живут в scripts/proactive/ (ADR-0020):
//   • Report — плановая сводка (ночные отчёты памяти). По умолчанию выключен,
//     включается тумблером в /menu → 🔔 Уведомления.
//   • Alert (алерт) — проблема, с которой владельцу надо что-то сделать: brain, предложение
//     обновиться.
//     Не выключается — и потому обязан говорить, что делать, и не повторяться чаще раза
//     в неделю на одну и ту же проблему.
//
// Не путать с соседним `notice.ts`: тот — путь к outbound-Gate (redactNotice), этот —
// решение, говорить ли вообще. Каждая отправка отсюда всё равно уходит через шов
// вызывающего, а значит через Gate.
//
// Здесь только политика: кому и когда можно говорить. Транспорт приносит вызывающий
// (у моста, ночного brain и апдейтера он разный), поэтому каждая отправка — колбэк.
//
// Модуль обязан РАБОТАТЬ на установке без authored tree: ночной brain и проверка обновлений —
// юниты, которые работают на половине установки, и дроссель алертов нужен там больше всего.
// Поэтому из `agent/` берутся ровно две вещи — резолвер языка и замок состояния дросселя
// (#lib/fs-atomic.ts), обе динамическим импортом и fail-open; всё остальное здесь на node:fs. Сторожит это «островной» прогон в notice-policy.test.ts
// (модуль копируется в каталог без алиаса `#lib`), а не authored-tree-guard: тот следит за
// обратным направлением — чтобы agent/ не тянул scripts/.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type Translate = (english: string, russian: string) => string;
type Language = "en" | "ru";
type Env = Record<string, string | undefined>;

// Один и тот же вопрос «на каком языке говорить» решает резолвер из authored tree
// (settings.language → AGENT_LANGUAGE → ru). Без дерева остаётся его же последний шаг —
// env: молчать или гадать хуже, чем сказать по-русски на русской установке.
type LangResolver = { getLang: () => Language };

export async function noticeLang(
  env: Env = process.env,
  load: () => Promise<LangResolver> = () => import("#lib/i18n.ts"),
): Promise<Language> {
  try {
    return (await load()).getLang();
  } catch (error) {
    console.error("[notices] language resolver unavailable:", error);
    return env.AGENT_LANGUAGE === "en" ? "en" : "ru";
  }
}

/** Пара литералов на месте вызова — идиома репо (agent/lib/i18n.ts), без словарей. */
export async function noticeTranslator(
  env: Env = process.env,
  load?: () => Promise<LangResolver>,
): Promise<Translate> {
  const lang = await noticeLang(env, load);
  return (english, russian) => (lang === "ru" ? russian : english);
}

// ── Report: отчёты памяти ────────────────────────────────────────────────────────────────
// Ключ settings — объект, а не голый флаг, чтобы соседние
// настройки отчётов не пришлось заводить новым ключом верхнего уровня.
export function memoryReportsEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const reports = (settings as { memoryReports?: unknown }).memoryReports;
  if (typeof reports !== "object" || reports === null) return false;
  return (reports as { enabled?: unknown }).enabled === true;
}

/**
 * «На каком языке писать» — одна формулировка на все плановые ходы (ночная свёртка,
 * Watch и Brief). Общая функция, а не копия строки: разъехаться им нельзя, иначе
 * половина плановых сообщений снова уедет на язык инструкции.
 */
export function writtenInLanguage(tr: Translate): string {
  return `written in ${tr("English", "Russian")}`;
}

/**
 * Кнопки пункта Watch (ADR-0020) на языке владельца: подпись и слово, с которого начинается
 * `data` — `<слово>: <имя>`. Промпт Watch даёт их модели, а Bridge по тем же словам узнаёт
 * «Я в курсе» и гасит пункт сам, без хода модели: слова одни, разъехаться им нельзя.
 */
export function watchButtons(tr: Translate) {
  return [
    { label: tr("To tasks", "В задачи"), word: tr("To tasks", "В задачи") },
    {
      label: tr("Remind later", "Напомнить позже"),
      word: tr("Later", "Позже"),
    },
    { label: tr("Got it", "Я в курсе"), word: tr("Got it", "Я в курсе") },
  ] as const;
}

/**
 * `data` кнопки «Я в курсе»: ровно `<слово>: <имя>` на языке владельца и непустое имя. Другой
 * язык, другой регистр или пробел не тот — обычная кнопка модели.
 */
export function isGotItData(data: string, tr: Translate): boolean {
  const prefix = `${watchButtons(tr)[2].word}: `;
  return data.startsWith(prefix) && data.slice(prefix.length).trim() !== "";
}

/**
 * Хвост ночного промпта — та его часть, что описывает ДОСТАВКУ отчёта: язык, форму и
 * запрет доставить себя самому. Язык называется явно: без этого модель пишет отчёт на
 * языке инструкции, и пользователь получает половину сообщения по-английски.
 */
export function memoryReportTail(tr: Translate): string {
  return (
    `At the end, return a SHORT report, ${writtenInLanguage(tr)}. ` +
    `Plain text, no markdown tables. Write it in the first person, the way a person tells ` +
    `what they remembered in this pass: 3-5 short lines. ` +
    `Use everyday words only: no card operations (ADD/UPDATE/SUPERSEDE/NOOP), no field ` +
    `names, no file paths, no internal terms. ` +
    `Return the report as the final text of this turn. Do not send it anywhere yourself: ` +
    `no rich messages, no digest chat, no Telegram tools. ` +
    `Only the finished report, with no preamble or reasoning.`
  );
}

/** Факты ночи для Report: разобранные дни с выжимкой, Card, провалы. */
export type NightFacts = {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly gist: string;
  }>;
  readonly created: number;
  readonly updated: number;
  readonly failedDays: number;
  readonly problems: boolean;
};

const ruPlural = (n: number, one: string, few: string, many: string) => {
  const [d10, d100] = [n % 10, n % 100];
  if (d10 === 1 && d100 !== 11) return one;
  return d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14) ? few : many;
};

/** Report ночи: 2–5 строк от первого лица на языке владельца, собранных кодом из фактов
 * ночи. Служебных строк и путей нет; провалы — одной строкой. */
export function nightReport(tr: Translate, facts: NightFacts): string {
  const n = facts.days.length;
  const when = new Intl.DateTimeFormat(tr("en-US", "ru-RU"), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const human = (date: string) => when.format(new Date(`${date}T00:00:00Z`));
  const { created, updated, failedDays } = facts;
  const lines = [
    tr(
      `Last night I went through ${n} ${n === 1 ? "day" : "days"} of memory.`,
      `Ночью я разобрала ${n} ${ruPlural(n, "день", "дня", "дней")} памяти.`,
    ),
    created + updated
      ? tr(
          `New Cards: ${created}, updated: ${updated}.`,
          `Новых карточек: ${created}, дополнено: ${updated}.`,
        )
      : tr("No new facts for Cards.", "Новых фактов для карточек не было."),
    // Выжимка — слова модели: в Report она одна строка, иначе раздувает его за 5 строк.
    ...facts.days
      .slice(-2)
      .map((day) => ({ ...day, gist: day.gist.replace(/\s+/gu, " ").trim() }))
      .filter((day) => day.gist)
      .map((day) => `${human(day.date)}: ${day.gist}`),
  ];
  if (failedDays)
    lines.push(
      tr(
        `Not everything worked: ${failedDays} ${failedDays === 1 ? "day was" : "days were"} not processed, I will try again next night.`,
        `Не всё получилось: ${failedDays} ${ruPlural(failedDays, "день не разобран", "дня не разобраны", "дней не разобраны")}, попробую следующей ночью.`,
      ),
    );
  else if (facts.problems)
    lines.push(
      tr(
        "Some small changes were not saved; the details are in the service journal: iva logs.",
        "Часть мелких правок не записалась; подробности — в журнале: iva logs.",
      ),
    );
  return lines.join("\n");
}

/** Одноразовый Notice после апдейта: утро замолчало не потому, что что-то сломалось. */
export function memoryReportsOffNotice(tr: Translate): string {
  return tr(
    "Morning memory reports are now off by default. Turn them on: /menu → 🔔 Notices.",
    "Утренние отчёты памяти теперь выключены. Включить: /menu → 🔔 Уведомления.",
  );
}

/**
 * Ключ дросселя для «плагин выключен»: один на сборку, а не на плагин. Читают его и
 * апдейтер (снимает отметку, когда плагины снова собрались), и сама отправка.
 */
export const PLUGIN_ALERT_KEY = "plugin-build";

/** Ключ дросселя для «версия на заводской сборке»: суть — отпечаток файлов data/custom. */
export const CUSTOM_ALERT_KEY = "custom-build";

/**
 * Версия ушла на заводскую сборку: файлы владельца в data/custom с ней не собрались или
 * версия с ними не поднялась (ADR-0007: что сломалось, чем грозит, что сделать).
 * `firstLine` — первая строка ошибки; `null` — версию с этими файлами придержали, потому
 * что в прошлый раз она не поднялась.
 */
export function customStockAlert(
  tr: Translate,
  firstLine: string | null,
): string {
  // Точка в конце строки ошибки не удваивает точку текста.
  const why = (
    firstLine ??
    tr(
      "last time the version carrying them did not come up",
      "в прошлый раз версия с ними не поднялась",
    )
  ).replace(/\.$/u, "");
  return tr(
    `Iva is running the stock build: your files in data/custom do not build with this version — ${why}. The files are untouched; fix them and the next \`iva update\` puts them back.`,
    `Ива работает на заводской сборке: ваши файлы в data/custom не собрались с этой версией — ${why}. Файлы на месте; поправьте их, и следующее \`iva update\` поставит их снова.`,
  );
}

/**
 * Плагин с кодом не встал в версию, и Ива выключила его (ADR-0009). ОДИН текст на оба
 * канала: и на вывод апдейта, и в чат. Правило Alert (ADR-0007): что сломалось, чем
 * грозит, что сделать. Причина отказа остаётся в выводе — в чат идёт короткое.
 */
export function pluginsSwitchedOffAlert(
  tr: Translate,
  names: readonly string[],
): string {
  const listed = names.join(", ");
  const one = names[0] ?? "<name>";
  if (names.length === 1)
    return tr(
      `⚠️ Iva switched the plugin ${one} off: this version does not work with its code, so neither its code nor its skills are loaded. Everything else works as before. Update it and turn it back on:\niva plugin update ${one}\niva plugin enable ${one}`,
      `⚠️ Ива выключила плагин ${one}: с его кодом эта версия не работает, поэтому ни кода, ни скиллов плагина нет. Остальное работает как раньше. Обнови плагин и включи обратно:\niva plugin update ${one}\niva plugin enable ${one}`,
    );
  return tr(
    `⚠️ Iva switched these plugins off: ${listed}. This version does not work with their code, so neither their code nor their skills are loaded. Everything else works as before. Update and turn them back on one at a time — that way the one at fault is the one you see:\niva plugin update ${one}\niva plugin enable ${one}`,
    `⚠️ Ива выключила плагины: ${listed}. С их кодом эта версия не работает, поэтому ни кода, ни скиллов этих плагинов нет. Остальное работает как раньше. Обновляй и включай обратно по одному — тогда видно, какой из них виноват:\niva plugin update ${one}\niva plugin enable ${one}`,
  );
}

/** Ключ дросселя для «обновление выключило юзербот»: суть — причина (userbotOffReason). */
export const USERBOT_ALERT_KEY = "userbot-off";

/**
 * Суть Alert для дросселя: причина из reinstallUserbot одной строкой, без префикса
 * `userbot: ` и без точки в конце, поэтому одна причина в другой обёртке не говорит дважды.
 * В текст Alert причина не идёт (userbotOffAlert).
 */
export function userbotOffReason(reason: string): string {
  return reason
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:userbot:\s*)+/u, "")
    .replace(/[\s.]+$/u, "");
}

/**
 * Обновление выключило юзербот: его окружение не подготовилось или прокси не ответил (#273).
 * Вывод апдейта уже несёт причину и `iva userbot setup`, но кто обновлялся кнопкой в боте,
 * его не видит. Правило Alert (ADR-0007): что сломалось, чем грозит, что сделать — кнопкой
 * экрана /menu, а не командой терминала. Причина остаётся в выводе: в чат идут простые
 * слова, без её кодов и чужих фраз.
 */
export function userbotOffAlert(tr: Translate): string {
  return tr(
    "⚠️ Iva switched the userbot off: it did not come up after the update. While it is off, Iva cannot read or search your chats as your account; everything else works as before. Turn it back on: /menu → 📡 Userbot → «Turn on».",
    "⚠️ Ива выключила юзербот: после обновления он не запустился. Пока он выключен, Ива не читает и не ищет ваши чаты от вашего аккаунта; остальное работает как раньше. Включить обратно: /menu → 📡 Userbot → «Включить».",
  );
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

const REPORTS_OFF_MARKER = "notice-memory-reports-off.json";

/**
 * Гонялась ли ночная свёртка на этой установке раньше — по следам ЗАВЕРШЁННОГО прогона,
 * которых свежая установка к своей первой ночи иметь не может:
 *
 *   • файл сессии ЛЮБОГО периода (`data/rollup-session-*.json`) — он живёт, только пока
 *     идёт ход, и остаётся лишь после упавшего прогона, поэтому одного его мало;
 *   • запись периода в `data/rollup-status.json` С ПОЛЕМ ЗАВЕРШЕНИЯ (`lastFinishedAt` или
 *     `lastSuccessAt`). Одного имени периода мало: спавнер расписаний резервирует слот
 *     (`lastStartedAt`, `inProgressSince`, `ownerPid`) ДО запуска, и текущий, самый первый
 *     прогон читал бы собственную бронь как чужой прошлый успех;
 *   • дневные сводки в vault (`summaries/daily/*.md`) — их создаёт только свёртка;
 *     шаблон vault'а привозит каталог пустым.
 *
 * BEST-EFFORT, а не гарантия: установка ≤0.3.9 (курсоров тогда не было), у которой ещё и
 * vault не на месте, следов не оставит и Notice не получит. Цена ошибки в эту сторону —
 * молчание вместо объяснения; цена ошибки в другую — нотация свежему пользователю.
 * Записано в ADR-0007.
 */
export function rollupRanBefore(dataDir: string, vaultDir: string): boolean {
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return []; // каталога нет — следов тоже
    }
  };
  if (names(dataDir).some((name) => /^rollup-session-.+\.json$/.test(name)))
    return true;
  if (names(join(vaultDir, "summaries/daily")).some((n) => n.endsWith(".md")))
    return true;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dataDir, "rollup-status.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return false;
    return Object.entries(parsed).some(([name, entry]) => {
      if (!name.startsWith("memory-")) return false;
      if (typeof entry !== "object" || entry === null) return false;
      const { lastFinishedAt, lastSuccessAt } = entry as {
        lastFinishedAt?: unknown;
        lastSuccessAt?: unknown;
      };
      return (
        typeof lastFinishedAt === "number" || typeof lastSuccessAt === "number"
      );
    });
  } catch {
    return false;
  }
}

/**
 * Заявка на право сказать: атомарный O_EXCL. Две ночные свёртки (daily и weekly) стартуют
 * одна за другой, и проигравшая обязана молчать, а не повторять. Файл ещё и хранит принятое
 * решение — по нему видно, что именно было решено в ту единственную ночь.
 */
function claimOnce(
  path: string,
  payload: Record<string, string>,
): "claimed" | "taken" | "failed" {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(payload)}\n`);
    } finally {
      closeSync(fd);
    }
    return "claimed";
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "taken";
    console.error(`[notice-policy] could not claim ${path}:`, error);
    return "failed";
  }
}

export type ReportsOffNotice =
  "sent" | "not-needed" | "skipped" | "settled" | "failed";

/**
 * Владелец уже знает про тумблер: ключ `memoryReports` в settings пишет только экран
 * /menu → 🔔 Уведомления. Значит выключил отчёты он сам, и рассказывать ему об этом —
 * нотация на его собственное действие.
 */
export function ownerKnowsTheSwitch(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    Object.hasOwn(settings, "memoryReports")
  );
}

/**
 * Вопрос «сказать ли, что отчёты теперь выключены» решается РОВНО ОДИН РАЗ — в первый
 * прогон, где маркера ещё нет, — и решение записывается в сам маркер:
 *
 *   • владелец уже трогал тумблер (`ownerKnows`) — он в курсе, «not-needed»;
 *   • установка никогда не гоняла свёртку (`ranBefore` = false) — терять ей нечего,
 *     «not-needed», молчим НАВСЕГДА;
 *   • отчёт у установки был, но чата ещё нет (`send` = null) — «skipped»: к моменту, когда
 *     чат появится, новость уже несвежая, а решение всё равно закрыто;
 *   • иначе — Notice уходит.
 *
 * Решение записано, поэтому вторая ночь ничего не пересматривает: следы прежних прогонов к
 * тому времени появятся у всех, и без этой записи свежая установка получила бы notice про
 * отчёт, которого никогда не видела.
 *
 * КОМПРОМИСС: заявка подаётся ДО отправки, поэтому крэш между заявкой и доставкой теряет
 * Notice навсегда. Обратный порядок (сначала отправить, потом пометить) на гонке daily и
 * weekly дал бы дубль, а дубль хуже потери: пропавший Notice стоит одной строки в доке,
 * повторяющийся — доверия к тому, что Iva не спамит. Записано в ADR-0007.
 */
export async function settleReportsOffNotice({
  dataDir,
  ranBefore,
  ownerKnows = false,
  send,
}: {
  dataDir: string;
  ranBefore: boolean;
  ownerKnows?: boolean;
  /** null — чата нет: решение всё равно принимается, отправки не будет. */
  send: (() => Promise<boolean>) | null;
}): Promise<ReportsOffNotice> {
  const path = join(dataDir, REPORTS_OFF_MARKER);
  const decision: ReportsOffNotice =
    ownerKnows || !ranBefore ? "not-needed" : send ? "sent" : "skipped";
  const claim = claimOnce(path, {
    decision,
    at: new Date().toISOString(),
  });
  if (claim === "taken") return "settled";
  if (claim === "failed") return "failed"; // решим завтра, маркера всё ещё нет
  if (decision !== "sent" || !send) return decision;
  if (await send()) return "sent";
  try {
    rmSync(path, { force: true });
  } catch {
    /* заявка останется — Notice не повторится; молчать безопаснее, чем спамить */
  }
  return "failed";
}

export type ReportDelivery = {
  /** off — тумблер выключен; sent/failed — отчёт ушёл или не ушёл. */
  status: "off" | "sent" | "failed";
  /** Отчёт доехал без разметки: вызывающий подскажет модели формат на следующий раз. */
  fellBack: boolean;
  error: string;
  /** Судьба одноразового Notice о выключении; "not-asked" — отчёт был включён. */
  notice: ReportsOffNotice | "not-asked";
};

/**
 * Всё, что ночная свёртка говорит в чат по итогам прогона, — одним решением. За прогон
 * уходит РОВНО ОДНО сообщение: либо отчёт (если тумблер включён), либо — единственный раз
 * за жизнь установки — Notice о том, что отчёты выключены. Ни одного, если тумблер выключен
 * и вопрос уже закрыт.
 */
export async function deliverMemoryReport({
  dataDir,
  settings,
  ranBefore,
  report,
  tr,
  send,
}: {
  dataDir: string;
  settings: unknown;
  ranBefore: boolean;
  report: string;
  tr: Translate;
  /** null — чат не настроен: отчёту некуда ехать, но решение о Notice всё равно берётся. */
  send: {
    report: (
      text: string,
    ) => Promise<{ ok: boolean; fellBack: boolean; error: string }>;
    notice: (text: string) => Promise<{ ok: boolean }>;
  } | null;
}): Promise<ReportDelivery> {
  if (!memoryReportsEnabled(settings)) {
    const notice = await settleReportsOffNotice({
      dataDir,
      ranBefore,
      ownerKnows: ownerKnowsTheSwitch(settings),
      send: send
        ? async () => (await send.notice(memoryReportsOffNotice(tr))).ok
        : null,
    });
    return { status: "off", fellBack: false, error: "", notice };
  }
  if (!send)
    return {
      status: "failed",
      fellBack: false,
      error: "no chat configured",
      notice: "not-asked",
    };
  const sent = await send.report(report);
  return {
    status: sent.ok ? "sent" : "failed",
    fellBack: sent.fellBack,
    error: sent.error,
    notice: "not-asked",
  };
}

// ── Alert: алерт, который нельзя выключить ───────────────────────────────────────────────
export const ALERT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

type AlertRecord = { essence: string; lastSentAt: number };
export type AlertState = Record<string, AlertRecord>;

function alertStatePath(dataDir: string): string {
  return join(dataDir, "alert-state.json");
}

// Битый, недописанный или чужой формат состояния значит «слать»: fail-open. Замолчавшая
// алерт стоит дороже, чем увиденный дважды, поэтому непонятная запись просто теряется.
function readAlertState(dataDir: string): AlertState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(alertStatePath(dataDir), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  const state: AlertState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const { essence, lastSentAt } = value as {
      essence?: unknown;
      lastSentAt?: unknown;
    };
    if (
      typeof essence === "string" &&
      typeof lastSentAt === "number" &&
      Number.isFinite(lastSentAt)
    )
      state[key] = { essence, lastSentAt };
  }
  return state;
}

// Запись состояния — своя, из node:fs, а НЕ через #lib/fs-atomic.ts. Дроссель нужен ровно
// той установке, у которой authored tree сломан: там алерт `authored-tree` уходит каждую
// ночь, и статический импорт из agent/ упал бы вместе с ним — недельный дроссель умер бы там,
// где он нужнее всего. Механизм тот же (tmp + rename), три строки, зависимостей ноль.
function writeAlertState(dataDir: string, state: AlertState): boolean {
  const path = alertStatePath(dataDir);
  // Уникален на вызов, а не на миллисекунду. Живого бага здесь нет: записи синхронные, и
  // одному процессу поделить имя не с кем. Это дешёвая страховка на случай второго писателя
  // — цена ошибки на флаге "wx" была бы потерянной отметкой дросселя.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path);
    return true;
  } catch (error) {
    // Не записалось — алерт повторится завтра, а это безопасная сторона.
    console.error("[notice-policy] could not record the alert state:", error);
    try {
      rmSync(temp, { force: true });
    } catch {
      /* tmp уже забрал rename или его не удалось создать вовсе */
    }
    return false;
  }
}

// Писателей несколько (тик проактивности, мост, ночь, апдейтер), поэтому чтение-правка-запись
// идёт под замком — существующим из #lib/fs-atomic.ts. Загрузка ленивая, синхронная (require
// ESM без top-level await: модуль грузят и через require, scripts/check-update.mjs) и fail-open:
// без authored tree (островной прогон в тестах) замка нет и запись идёт как раньше — одна
// потерянная отметка там дешевле умершего дросселя.
type AlertLock = Pick<
  typeof import("#lib/fs-atomic.ts"),
  "acquireFileLockSync" | "releaseFileLock"
>;
let alertLockLib: AlertLock | null | undefined;
function alertLock(): AlertLock | null {
  if (alertLockLib === undefined)
    try {
      alertLockLib = createRequire(import.meta.url)(
        "#lib/fs-atomic.ts",
      ) as AlertLock;
    } catch {
      alertLockLib = null;
    }
  return alertLockLib;
}
/** Сколько ждать чужую запись состояния: сама запись — миллисекунды. */
const ALERT_LOCK_WAIT_MS = 1_000;

/**
 * Одна правка состояния дросселя под замком: прочитать, поменять, записать. `change` отвечает,
 * есть ли что писать. Замок не взят или запись не прошла — false. `afterRead` — шов теста
 * (второй писатель между чтением и записью).
 */
export function updateAlertState(
  dataDir: string,
  change: (state: AlertState) => boolean,
  afterRead?: () => void,
): boolean {
  const lock = lockAlertState(dataDir);
  if (lock === "refused") return false;
  try {
    const state = readAlertState(dataDir);
    afterRead?.();
    return change(state) ? writeAlertState(dataDir, state) : true;
  } finally {
    if (lock !== null) alertLock()?.releaseFileLock(lock);
  }
}

/** Замок состояния дросселя; null — без замка (нет authored tree), refused — не взят. */
function lockAlertState(
  dataDir: string,
):
  NonNullable<ReturnType<AlertLock["acquireFileLockSync"]>> | null | "refused" {
  const lib = alertLock();
  if (lib === null) return null;
  try {
    const lock = lib.acquireFileLockSync(join(dataDir, "alert-state.lock"), {
      timeoutMs: ALERT_LOCK_WAIT_MS,
    });
    if (lock !== null) return lock;
    console.error("[notice-policy] the alert state is busy, not recorded");
  } catch (error) {
    console.error("[notice-policy] could not lock the alert state:", error);
  }
  return "refused";
}

/**
 * Отметка дросселя: алерт с этим существом сказан сейчас. Одна запись на alertOnce и на сбой,
 * доставленный Watch (scripts/proactive/tick.ts); false — не записалась.
 */
export function recordAlert(
  dataDir: string,
  key: string,
  essence: string,
  now: number = Date.now(),
): boolean {
  return updateAlertState(dataDir, (state) => {
    state[key] = { essence, lastSentAt: now };
    return true;
  });
}

/**
 * Пора ли говорить: записи нет, существо проблемы сменилось, прошёл период
 * повтора (по умолчанию неделя) — или часы ушли назад (запись из будущего
 * иначе заглушила бы алерт навсегда).
 */
export function alertDue(
  dataDir: string,
  key: string,
  essence: string,
  now: number = Date.now(),
  repeatMs: number = ALERT_REPEAT_MS,
): boolean {
  const record = readAlertState(dataDir)[key];
  if (!record) return true;
  if (record.essence !== essence) return true;
  const elapsed = now - record.lastSentAt;
  return elapsed >= repeatMs || elapsed < 0;
}

/**
 * Алерт с дросселем. Состояние обновляется только после состоявшейся отправки:
 * неотправленный алерт не имеет права заглушить следующий.
 */
export async function alertOnce(
  dataDir: string,
  key: string,
  essence: string,
  send: () => Promise<boolean>,
  repeatMs: number = ALERT_REPEAT_MS,
): Promise<"sent" | "throttled" | "failed"> {
  if (!alertDue(dataDir, key, essence, Date.now(), repeatMs))
    return "throttled";
  if (!(await send())) return "failed";
  recordAlert(dataDir, key, essence);
  return "sent";
}

/** Проблема ушла: забыть её, чтобы завтрашний рецидив заговорил сразу, а не через неделю. */
export function alertResolved(dataDir: string, key: string): void {
  // Без записи нечего забывать — и незачем ни брать замок, ни трогать файл.
  if (!(key in readAlertState(dataDir))) return;
  updateAlertState(dataDir, (state) => {
    if (!(key in state)) return false;
    delete state[key];
    return true;
  });
}
