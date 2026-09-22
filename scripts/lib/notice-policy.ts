// Политика Notice — всё, что Iva говорит сама, без хода пользователя (CONTEXT.md). Видов
// ровно два, и у каждого своё правило (ADR-0007):
//   • Report — плановая сводка (отчёты памяти, утренний дайджест). По умолчанию выключен,
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
// Поэтому из `agent/` берётся ровно одно — резолвер языка, динамическим импортом и fail-open;
// всё остальное здесь на node:fs. Сторожит это «островной» прогон в notice-policy.test.ts
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
// Ключ settings — по образцу digestSchedule: объект, а не голый флаг, чтобы соседние
// настройки отчётов не пришлось заводить новым ключом верхнего уровня.
export function memoryReportsEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const reports = (settings as { memoryReports?: unknown }).memoryReports;
  if (typeof reports !== "object" || reports === null) return false;
  return (reports as { enabled?: unknown }).enabled === true;
}

/**
 * «На каком языке писать» — одна формулировка на оба плановых хода (ночная свёртка и
 * утренний дайджест). Общая функция, а не копия строки: разъехаться им нельзя, иначе
 * половина плановых сообщений снова уедет на язык инструкции.
 */
export function writtenInLanguage(tr: Translate): string {
  return `written in ${tr("English", "Russian")}`;
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

/** Ключ дросселя: ночная свёртка снесла кусок CORE, код вернул файл как было. */
export const CORE_DAMAGE_ALERT_KEY = "core-rollup-damage";

/**
 * Ночная свёртка потеряла секцию CORE (или обнулила файл), и код откатил CORE к состоянию
 * до хода (ADR-0002). Молчать нельзя: откат выглядит как «ночь ничего не записала», а
 * правило Alert (ADR-0007) требует сказать, что сломалось, чем грозит и что сделать.
 */
export function coreDamageAlert(
  tr: Translate,
  lostHeadings: readonly string[],
): string {
  const listed = lostHeadings.map((heading) => `«${heading}»`).join(", ");
  const what = lostHeadings.length
    ? tr(`dropped ${listed} from`, `потеряла ${listed} в`)
    : tr("emptied", "опустошила");
  return tr(
    `⚠️ Tonight's memory rollup ${what} CORE.md. CORE.md goes into every single turn, so the missing part would have fallen out of my memory. I restored the file as it was before tonight — the day's new facts are NOT in it. Open vault/CORE.md and add what tonight should have written.`,
    `⚠️ Ночная свёртка памяти ${what} CORE.md. CORE.md уходит в каждый ход, поэтому пропавшее выпало бы из моей памяти. Я вернула файл в состояние до этой ночи — новых фактов дня в нём НЕТ. Открой vault/CORE.md и допиши то, что должна была записать эта ночь.`,
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
 *   • курсор сессии ЛЮБОГО периода (`data/rollup-session-*.json`) — его пишет сама свёртка
 *     после хода, но сносит dropHungSession, поэтому одного его мало;
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
type AlertState = Record<string, AlertRecord>;

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
// ночь, и импорт из agent/ упал бы вместе с ним — недельный дроссель умер бы там, где он
// нужнее всего. Механизм тот же (tmp + rename), три строки, зависимостей ноль.
function writeAlertState(dataDir: string, state: AlertState): void {
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
  } catch (error) {
    // Не записалось — алерт повторится завтра, а это безопасная сторона.
    console.error("[notice-policy] could not record the alert state:", error);
    try {
      rmSync(temp, { force: true });
    } catch {
      /* tmp уже забрал rename или его не удалось создать вовсе */
    }
  }
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
  const state = readAlertState(dataDir);
  state[key] = { essence, lastSentAt: Date.now() };
  writeAlertState(dataDir, state);
  return "sent";
}

/** Проблема ушла: забыть её, чтобы завтрашний рецидив заговорил сразу, а не через неделю. */
export function alertResolved(dataDir: string, key: string): void {
  const state = readAlertState(dataDir);
  if (!(key in state)) return; // нечего забывать — и незачем трогать файл
  delete state[key];
  writeAlertState(dataDir, state);
}

/**
 * Есть ли в тексте что-то осмысленное, кроме знаков препинания и пробелов.
 * Шум-гейт ночного отчёта: модель могла вернуть "." или другой короткий мусор —
 * такой текст владельцу не доставляем.
 */
export function hasTextSubstance(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
