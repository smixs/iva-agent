// Rollup: one parameterized script for all periods (daily → weekly → monthly → yearly).
// Run by the in-process eve schedules in agent/schedules/memory-*.ts, drives Iva
// via eve/client (like scripts/daily-digest.ts), and posts a report to Telegram for daily/weekly.
//
//   node --env-file=.env scripts/memory/rollup.ts <daily|weekly|monthly|yearly>
//
// Requires: a running agent (eve start) and a vault to write into. The processing rules
// (scripts/memory/instructions/) ship with the repo. Date is in ASSISTANT_TIMEZONE.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientSession, type MessageResult } from "eve/client";
import { CORE_CAP } from "#lib/core-cap.ts";
import { coreDamage, setLastDayPointer } from "#lib/core-clamp.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { commitVaultWrite } from "#lib/vault-commit.ts";
import { tr } from "#lib/i18n.ts";
import { readSettings } from "#lib/settings.ts";
import {
  alertOnce,
  alertResolved,
  coreDamageAlert,
  CORE_DAMAGE_ALERT_KEY,
  deliverMemoryReport,
  hasTextSubstance,
  memoryReportTail,
  memoryReportsEnabled,
  rollupRanBefore,
} from "../lib/notice-policy.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { resolveTimeZone } from "../lib/timezone.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { readCore } from "./read-core.ts";
import {
  cancelTurnAndConfirmQuietly,
  canRetryFresh,
  cancelTurnQuietly,
  isSessionNotActiveError,
  resolveTurnTimeoutMs,
  withTurnTimeout,
} from "../lib/rollup-turn.ts";
import {
  attachRollupNonce,
  drainStreamBefore,
  isOwnTurnResult,
  parsePersistedRollupSession,
  sentNotBeforeIso,
} from "../lib/rollup-stale-cursor.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";

type Period = "daily" | "weekly" | "monthly" | "yearly";

const PERIODS: readonly Period[] = ["daily", "weekly", "monthly", "yearly"];
// process.argv: [node, script, <period>] — the period is the first CLI argument.
const period = process.argv[2] as Period | undefined;

if (!period || !PERIODS.includes(period)) {
  console.error(`Usage: rollup.ts <${PERIODS.join("|")}>`);
  process.exit(1);
}

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BEARER = process.env.ASSISTANT_BEARER; // needed if the prod eve channel requires auth
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = notificationChat();
// Absolute, like the instructions above: the prompt hands these paths to the model as
// read_file/write_file targets, and read_file resolves a RELATIVE path against the vault
// root — a "vault/daily/…" string would come back as vault/vault/daily/… and ENOENT.
let vaultCache: string | null = null;
// Лениво: неверная настройка вольта всплывает на первом использовании, где её ловит
// граница процесса — одна строка причины и код 1, а не стек на импорте модуля.
const VAULT = (): string => (vaultCache ??= vaultDirOrExit());
const TZ = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);
// Format rules and the memory-processor prompts live in the repo, not in the vault: they
// are product, and must update with it instead of rotting inside every user's vault.
// Absolute, so the agent can read them whatever its working directory is.
const INSTRUCTIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "instructions",
);

// daily/weekly may carry a Report to Telegram; monthly/yearly are silent by design (vault
// only). Whether the Report actually goes out is the owner's switch, read at the end of the
// run — a toggle flipped tonight applies tonight, with no restart (ADR-0007).

const REPORTS_TO_TELEGRAM: Record<Period, boolean> = {
  daily: true,
  weekly: true,
  monthly: false,
  yearly: false,
};

// Current date in the user's timezone (iva.service sets TZ from .env, but we hedge anyway).
function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Shift an ISO date (YYYY-MM-DD) by N days; arithmetic in UTC, no DST edge cases.
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// We take the target period as COMPLETED: schedules fire at the start of a new period
// (daily ≈04:00, weekly on Mon, monthly on the 1st, yearly on Jan 1), so we process
// the PREVIOUS period, not the empty current one (now is the current local date).
function buildPrompt(p: Period, now: string): string {
  const [y, m] = now.split("-").map(Number);
  const yesterday = shiftDate(now, -1);
  const prevMonth =
    m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const prevYear = String(y - 1);

  const intro =
    `You are processing long-term memory (vault: ${VAULT()}). It is now ${now} (${TZ}). ` +
    `Work strictly by the format rules in ${INSTRUCTIONS}/rules/ and the memory-processor ` +
    `instructions in ${INSTRUCTIONS}/memory-processor/. ` +
    `Do not invent facts — take them from the source files. `;

  // Delivery half of the prompt: language, human wording, no self-delivery. Built per call,
  // so a language switched in /menu applies to the next night without a restart.
  const tail = memoryReportTail(tr);

  switch (p) {
    case "daily":
      return (
        intro +
        `Process the raw transcript of the completed day (${VAULT()}/daily/${yesterday}.md): ` +
        `extract entities and create/update autograph cards. Prefer the write_card tool over write_file ` +
        `for cards — it enforces the schema. For each fact choose one operation: ADD (new), ` +
        `UPDATE (existing subject, compatible new fact), SUPERSEDE (contradicts the Compiled Truth), ` +
        `or NOOP (already known). Pass history_entry only for SUPERSEDE, never for ADD, UPDATE, or NOOP. ` +
        `On SUPERSEDE: REWRITE the card's Compiled Truth (frontmatter + top description) to the new fact ` +
        `and pass the OLD value through history_entry as a single dated line 'YYYY-MM-DD: fact' — ` +
        `the fact the card holds now, matched against the card's body ('Owner: Alice.' becomes ` +
        `'2026-07-31: Owner: Alice'; a summary is refused) — the fact's own date, not today's; ` +
        `write_card owns the '## History' section. ` +
        `A card 'body' is facts only, with no H1/H2 headings: write_card builds the card ` +
        `structure itself (the title, '## Log', '## Related', '## History') and refuses a body ` +
        `that carries a heading of its own. ` +
        `Never leave two contradictory Compiled Truths; History is append-only, never edited. ` +
        `Tag each fact's certainty with 'confidence:' — EXTRACTED (user stated it directly) or ` +
        `INFERRED (you deduced it). ` +
        `Emotional venting and momentary states ("I'm useless", "wasted the whole day", tiredness, ` +
        `frustration) are NEVER identity-level facts: never put them into CORE or entity cards. ` +
        `At most mention them as a dated mood line in the daily-summary, or — only if clearly worth ` +
        `keeping — a note card with status: archived. ` +
        `First read ${VAULT()}/.graph/supersede-candidates.json (the deterministic conflict scan) and ` +
        `resolve every listed same-entity conflict by superseding the stale card. ` +
        `Then assemble a daily-summary for ${yesterday} with the day's topics and MOC links down to the cards ` +
        `and to the raw transcript daily/${yesterday}.md. ` +
        `Then ${VAULT()}/CORE.md, per the ${INSTRUCTIONS}/rules/core-format.md rule. If the day produced ` +
        `no new durable fact, preference, goal or behavioral lesson, do not open or write CORE.md. ` +
        `Otherwise edit only the affected lines; never rewrite the file; keep every existing section, ` +
        `including ones not in the template. The pointer to the last day is set by code — leave it alone. ` +
        `Keep the file ≤~${CORE_CAP} characters — compress on overflow, don't bloat. ` +
        `Separately, reflect on the day's interactions: for each notable exchange judge the outcome — ` +
        `useful, dead_end, or corrected (user corrected you, asked again, or was dissatisfied). ` +
        `When a corrected/dead_end outcome reveals a REPEATABLE behavioral lesson (not a one-off fix), ` +
        `add/refine ONE dated line in the CORE Preferences section (e.g. '- 2026-07: отвечать короче, ` +
        `без преамбул') so you don't repeat it. Keep lessons recency-ordered, drop the stalest when the ` +
        `section grows; a lesson consistently honored for weeks can be dropped. Skip this whole step if ` +
        `the day held no corrections (no-op — don't invent lessons). ` +
        tail
      );
    case "weekly":
      return (
        intro +
        `Assemble a weekly-summary for the completed week (7 days ending ${yesterday}): ` +
        `read the daily-summaries of those 7 days, pull out cross-cutting topics and the week's takeaways, ` +
        `create a weekly-summary with MOC links down to those daily-summaries. ` +
        tail
      );
    case "monthly":
      return (
        intro +
        `Assemble a monthly-summary for the completed month ${prevMonth}: ` +
        `read the weekly-summaries of month ${prevMonth}, pull out the main topics and the month's takeaways, ` +
        `create a monthly-summary with MOC links down to the weekly summaries. ` +
        tail
      );
    case "yearly":
      return (
        intro +
        `Assemble a yearly-summary for the completed year ${prevYear}: ` +
        `read the monthly-summaries of year ${prevYear}, pull out the main topics and the year's takeaways, ` +
        `create a yearly-summary with MOC links down to the monthly summaries. ` +
        tail
      );
  }
}

const client = new Client({
  host: HOST,
  ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
});

// Session REUSE, not a fresh session per night. eve backs every client session with a
// workflowEntry run in .eve/.workflow-data. Rollup deliberately does not reset its session
// when one scheduled call ends: the next call resumes the same context. One persistent
// session per period caps that at one running workflow. Rotation stays RARE because every
// rotation retires that reusable context. Abandoned sessions are logged to
// data/rollup-abandoned.jsonl and reset best-effort when abandoned. The fixed session ID
// lives in data/ and update quarantine retires it with the matching workflow.
const DATA_DIR = resolveDataDir(process.cwd());
const SESSION_FILE = join(DATA_DIR, `rollup-session-${period}.json`);
// 14 days, not 90. The session carries the whole history of previous rollups, and the
// daily one reuses it every single night: at 90 days the nightly turn opened with ~three
// months of prior rollup transcript — tens of thousands of tokens of context the night's
// actual job never reads, paid for on every run and slowest exactly where the box is
// weakest. 14 days keeps the anti-leak compromise above intact (one abandoned run per
// period per fortnight, ~26 a year instead of ~4) and cuts the carried history by roughly
// an order of magnitude. Cost is deliberate and bounded; `iva reset` still clears them.
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
// Did a rollup ever run on this installation? Read here, before this run leaves traces of
// its own, and read from every trace at once (session files of all four periods, the schedule
// status file, daily summaries in the vault) — one session file is not enough; dropHungSession
// deletes it. It separates an installation that used to get the morning report from a fresh
// one, which has nothing to miss and must hear nothing. Best-effort by design: ADR-0007.
const RAN_BEFORE = rollupRanBefore(DATA_DIR, VAULT());

async function loadSession(): Promise<{
  readonly sessionId: string;
  readonly createdAt: number;
} | null> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    // The eve <=0.30 file stored `{state:{...},createdAt}`. It is intentionally
    // incompatible: attaching its opaque cursor would revive a pre-migration session.
    const saved = parsePersistedRollupSession(parsed);
    if (!saved) return null;
    if (Date.now() - saved.createdAt > SESSION_TTL_MS) {
      logAbandoned(saved.sessionId, "ttl-rotation");
      await resetAbandonedSession(saved.sessionId, "ttl-rotation");
      return null;
    }
    return saved;
  } catch (error) {
    console.error(
      `rollup ${period}: сохранённая сессия не прочиталась, начинаю заново: ${String(error)}`,
    );
    return null;
  }
}

// Курсор потока не персистим: после рестарта #2461 обходится штатным bounded-drain
// от нуля до хвоста. На диске остаётся только стабильный ID и TTL.
function saveSession(sessionId: string, createdAt: number): void {
  writeFileAtomicSync(SESSION_FILE, JSON.stringify({ sessionId, createdAt }));
}

// Брошенные сессии (ротация/несовместимый курсор) — в журнал: их run-обёртки остаются
// в сторе до ближайшего `iva reset`, и по журналу видно, чьи они.
function logAbandoned(sessionId: string, reason: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(
      join(DATA_DIR, "rollup-abandoned.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        period,
        reason,
        sessionId,
      }) + "\n",
      "utf8",
    );
  } catch {
    /* журнал не должен ронять ночь */
  }
}

async function resetAbandonedSession(
  sessionId: string,
  reason: string,
  attached?: ClientSession,
): Promise<void> {
  try {
    const abandoned = attached ?? client.sessions.attach(sessionId);
    await abandoned.reset({ reason: `Rollup abandoned: ${reason}` });
  } catch (error) {
    console.error(
      `rollup ${period}: could not reset abandoned session ${sessionId} (${reason}):`,
      error,
    );
  }
}

// Ход целиком (create/send + result) под таймаутом: резюм припаркованной сессии
// после рестарта сервера может виснуть молча (vercel/eve#1450).
const TURN_TIMEOUT_MS = resolveTurnTimeoutMs(
  process.env.ROLLUP_TURN_TIMEOUT_MS,
  {
    warn: (message) => console.error(`rollup ${period}: ${message}`),
  },
);
const guardedTurn = (
  session: ClientSession | undefined,
  prompt: string,
  label: string,
  onAccepted: (
    session: ClientSession,
    result: Promise<MessageResult>,
  ) => void = () => {},
) =>
  withTurnTimeout(
    async () => {
      const send = async () => {
        const sentNotBefore = sentNotBeforeIso();
        if (session) {
          return {
            response: await session.send(prompt),
            sentNotBefore,
            session,
          };
        }
        const created = await client.sessions.create({ message: prompt });
        return { ...created, sentNotBefore };
      };
      const sent = session
        ? await drainStreamBefore(
            session,
            send,
            (error) => {
              console.error(
                `rollup ${period}: ${label}: pre-send stream drain failed (${error.message}) — aborting send`,
              );
            },
            TURN_TIMEOUT_MS,
          )
        : await send();
      const result = sent.response.result();
      onAccepted(sent.session, result);
      return {
        result: await result,
        sentNotBefore: sent.sentNotBefore,
        session: sent.session,
      };
    },
    { timeoutMs: TURN_TIMEOUT_MS, label },
  );

// Зависший ход на сервере не останавливается сам. Поэтому ход гасим, сессию помечаем
// брошенной и удаляем её ID — завтра стартуем со свежей.
async function dropHungSession(
  hungSession: ClientSession,
  label: string,
): Promise<void> {
  await cancelTurnQuietly(hungSession);
  const reason = `${label}-timeout`;
  logAbandoned(hungSession.state.sessionId, reason);
  await resetAbandonedSession(hungSession.state.sessionId, reason, hungSession);
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    /* ID сессии — кэш, его потеря не должна ронять ночь */
  }
}

const CORE_PATH = join(VAULT(), "CORE.md");

// CORE как есть. Отсутствующий файл — пустое состояние первой ночи (ровно то, что видит
// динамическая инструкция CORE); любой другой отказ чтения остаётся громким.
function readCoreText(path: string): string {
  const read = readCore(path);
  if (read.state === "unreadable") throw read.error;
  return read.state === "valid" ? read.text : "";
}

const today = localDate();
const yesterday = shiftDate(today, -1);
// Снимок CORE ДО хода: файл правит сама ночь, и пропажу секции видно только сравнением
// с тем, что было. Читается всегда, даже если ночь CORE не откроет вовсе.
const coreBeforeTurn = period === "daily" ? readCoreText(CORE_PATH) : "";
const saved = await loadSession();
let sessionCreatedAt = saved?.createdAt ?? Date.now();
let session = saved ? client.sessions.attach(saved.sessionId) : undefined;
// Обход vercel/eve#2461: result() на резюмнутой сессии может вернуть чужой ход.
// Nonce делает промпт уникальным для этого Rollup; guardedTurn сдвигает курсор
// на хвост перед каждым send. Снять, когда eve свяжет result() с отправленным ходом.
const mainPrompt = attachRollupNonce(buildPrompt(period, today), randomUUID());
let result: MessageResult;
let sentNotBefore: string;
let acceptedTurnResult: Promise<MessageResult> | undefined;
try {
  const main = await guardedTurn(
    session,
    mainPrompt,
    "main-turn",
    (acceptedSession, turnResult) => {
      session = acceptedSession;
      acceptedTurnResult = turnResult;
    },
  );
  ({ result, sentNotBefore, session } = main);
} catch (e) {
  // The parked session may be gone (iva reset quarantined the store) or hung on resume —
  // fall back to a fresh one once only after proving the old turn cannot keep writing.
  const hung = (e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT";
  // Выход наверх роняет процесс и отпускает .memory.lock, а зависший ход продолжает писать
  // в vault — уже без всякой защиты от параллельного роллапа. Гасим и на терминальных путях.
  if (!saved) {
    if (hung && session) await cancelTurnQuietly(session);
    throw e;
  }
  // Даже отклонённый локально send мог дойти до сервера до сетевого обрыва. Перед retry
  // он требует no_active_turn либо turn.cancelled. Исключение — штатный 409 session_not_active.
  // Успешный cancel со статусом accepted сам по себе второго писателя не разрешает.
  const sessionNotActive = isSessionNotActiveError(e);
  const cancelConfirmed =
    !sessionNotActive && session
      ? await cancelTurnAndConfirmQuietly(session, acceptedTurnResult)
      : false;
  if (!canRetryFresh({ sessionNotActive, cancelConfirmed })) {
    console.error(
      `rollup ${period}: could not confirm cancellation of the unresolved turn — refusing fresh retry`,
    );
    logAbandoned(saved.sessionId, "cancel-unconfirmed");
    await resetAbandonedSession(saved.sessionId, "cancel-unconfirmed", session);
    throw e;
  }
  console.error(
    `rollup ${period}: parked session ${hung ? "hung" : "unusable"} (${(e as Error).message}) — starting fresh`,
  );
  const abandonReason = hung ? "resume-timeout" : "unusable-session";
  logAbandoned(saved.sessionId, abandonReason);
  await resetAbandonedSession(saved.sessionId, abandonReason, session);
  session = undefined;
  sessionCreatedAt = Date.now();
  // Ровно одна попытка: второй сбой уходит наверх и роняет юнит с ненулевым кодом.
  try {
    const retry = await guardedTurn(
      session,
      mainPrompt,
      "main-turn",
      (acceptedSession, turnResult) => {
        session = acceptedSession;
        acceptedTurnResult = turnResult;
      },
    );
    ({ result, sentNotBefore, session } = retry);
  } catch (retryError) {
    if (
      (retryError as { code?: string }).code === "ROLLUP_TURN_TIMEOUT" &&
      session
    )
      await cancelTurnQuietly(session);
    throw retryError;
  }
}
if (!session) throw new Error("rollup turn finished without a session");
const activeSession = session;
if (
  !isOwnTurnResult(result.events, {
    prompt: mainPrompt,
    sentNotBefore,
  })
) {
  const cancelConfirmed = await cancelTurnAndConfirmQuietly(
    activeSession,
    acceptedTurnResult,
  );
  if (!cancelConfirmed) {
    console.error(
      `rollup ${period}: result does not match the prompt just sent (stale stream cursor); cancellation was not confirmed — keeping session`,
    );
    logAbandoned(
      activeSession.state.sessionId,
      "stale-result-cancel-unconfirmed",
    );
    await resetAbandonedSession(
      activeSession.state.sessionId,
      "stale-result-cancel-unconfirmed",
      activeSession,
    );
    process.exit(1);
  }
  console.error(
    `rollup ${period}: result does not match the prompt just sent (stale stream cursor); cancellation confirmed — dropping session`,
  );
  logAbandoned(activeSession.state.sessionId, "stale-result");
  await resetAbandonedSession(
    activeSession.state.sessionId,
    "stale-result",
    activeSession,
  );
  try {
    rmSync(SESSION_FILE, { force: true });
  } catch {
    /* ID сессии — кэш, его потеря не должна ронять ночь */
  }
  process.exit(1);
}
saveSession(activeSession.state.sessionId, sessionCreatedAt);

// An interactive turn ends with status "waiting" (the session is ready for the next message),
// so we rely on the presence of text rather than a "completed" status.
if (result.status === "failed" || !result.message) {
  console.error(
    `rollup ${period}: agent returned no report (status=${result.status})`,
  );
  process.exit(1);
}

// Алерт владельцу тем же путём, что у brain: один дроссель на всю установку (ADR-0007),
// доставка — через шов наружу, который несёт и outbound-гейт.
async function alertOwner(
  key: string,
  essence: string,
  message: string,
): Promise<void> {
  const outcome = await alertOnce(DATA_DIR, key, essence, async () => {
    if (!BOT || !CHAT) {
      console.error(
        `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — alert not sent: ${message}`,
      );
      return false;
    }
    const sent = await sendTelegramHtml(BOT, CHAT, message, {
      trace: { session: activeSession.state.sessionId, source: "rollup" },
    });
    if (!sent.ok)
      console.error(`rollup ${period}: alert send failed: ${sent.error}`);
    return sent.ok;
  });
  if (outcome === "throttled")
    console.log(
      `rollup ${period}: ${key} is unchanged since the last alert — not repeated`,
    );
}

// Daily is the only rollup that touches CORE. Verify the actual file, not just the turn
// status: a lost section is rolled back here, the last-day pointer is written here, and
// one same-session correction of the cap is allowed — then fail loudly and leave brain as
// the deterministic 05:00 backstop.
if (period === "daily") {
  // A non-empty pre-existing vault may legitimately have no CORE. The turn starts from
  // the same empty state that the dynamic CORE instruction already documents and uses.
  let core = readCoreText(CORE_PATH);

  // Ход мог снести секцию целиком — в том числе пользовательскую, которой нет в шаблоне.
  // Это потеря данных, поэтому файл возвращается как был, и владелец слышит об этом:
  // молчаливый откат читался бы как «ночь ничего не записала» (ADR-0002, ADR-0007).
  const damage = coreDamage(coreBeforeTurn, core);
  if (damage.damaged) {
    writeFileAtomicSync(CORE_PATH, coreBeforeTurn);
    // Откат CORE - тоже правка памяти: без коммита ночной подметальщик сделал бы вид,
    // что модель ничего не теряла.
    await commitVaultWrite("file CORE.md: restore", [CORE_PATH], VAULT());
    core = coreBeforeTurn;
    const damagedHeadings = [
      ...damage.lostHeadings,
      ...damage.hollowedHeadings,
    ];
    const lost = damagedHeadings.map((h) => `## ${h}`).join(", ");
    console.error(
      `rollup daily: CORE.md lost ${lost || "all of its content"} during the turn — restored the pre-turn file`,
    );
    await alertOwner(
      CORE_DAMAGE_ALERT_KEY,
      damagedHeadings.join(",") || "emptied",
      coreDamageAlert(tr, damagedHeadings),
    );
  } else {
    alertResolved(DATA_DIR, CORE_DAMAGE_ALERT_KEY);
  }

  // Указатель на последний день ведёт код: дата известна точно, а модели тут нечего
  // решать — за неё она платила бы полным перезаписыванием файла. Пишем только если
  // строка реально изменилась, иначе день без новых фактов трогал бы vault впустую.
  const pointed = setLastDayPointer(core, yesterday);
  if (pointed !== core) {
    writeFileAtomicSync(CORE_PATH, pointed);
    await commitVaultWrite("file CORE.md: pointer", [CORE_PATH], VAULT());
    core = pointed;
  }

  if (core.length > CORE_CAP) {
    const oldLength = core.length;
    console.error(
      `rollup daily: CORE.md still exceeds the cap (${oldLength}/${CORE_CAP}); requesting one correction`,
    );
    // Таймаут здесь не заводит новую сессию: это просто «коррекция не удалась» — файл
    // перечитывается как есть, и дальше срабатывает существующая проверка капа.
    try {
      await guardedTurn(
        activeSession,
        `Re-open ${CORE_PATH}: it is ${oldLength} characters, above the hard ${CORE_CAP}-character cap. ` +
          "Compress it now per the core-format rule. Preserve every heading and the Pointers/Указатели " +
          "section; remove stale Preferences/Предпочтения first. Do not return until the file itself is within the cap.",
        "core-correction",
      );
      saveSession(activeSession.state.sessionId, sessionCreatedAt);
    } catch (e) {
      console.error(
        `rollup daily: CORE.md correction turn failed (${(e as Error).message})`,
      );
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT")
        await dropHungSession(activeSession, "core-correction");
    }
    const correctedCore = readCore(CORE_PATH);
    if (correctedCore.state === "unreadable") throw correctedCore.error;
    if (correctedCore.state === "missing") {
      console.error(
        "rollup daily: CORE.md disappeared during correction; refusing to accept data loss",
      );
      process.exit(1);
    }
    core = correctedCore.text;
    if (core.length > CORE_CAP) {
      console.error(
        `rollup daily: CORE.md remains over cap after one correction (${core.length}/${CORE_CAP}); ` +
          "brain will clamp it at 05:00",
      );
      process.exit(1);
    }
    console.log(
      `rollup daily: CORE.md compressed ${oldLength} → ${core.length} chars`,
    );
  }
}

console.log(`rollup ${period} (${today}):\n${result.message}`);

// Telegram report only for daily/weekly, and only when the owner turned Reports on. What
// leaves the chat is one decision, taken in the policy module and proven there by test:
// the report, or — once in the life of an installation that used to get it — the notice
// that reports are now off. Never both, never twice.
if (REPORTS_TO_TELEGRAM[period]) {
  const settings = readSettings();
  // markdown → Telegram-HTML conversion, chunking, the outbound Gate and the self-heal all
  // live in the shared seam. No token or chat means no seam — and the policy still decides
  // the one-time notice, so a chat configured later cannot revive a question already closed.
  const send =
    BOT && CHAT
      ? {
          // Ночной ход зовётся своим именем в журнале хода (ADR-0010): без источника
          // вьюер прочитал бы rollup как разговор в Telegram. Сессия — сквозная,
          // по ней читатель сшивает весь ночной ход.
          report: (text: string) =>
            sendTelegramHtml(BOT, CHAT, text, {
              trace: {
                session: activeSession.state.sessionId,
                source: "rollup",
              },
            }),
          notice: (text: string) =>
            sendTelegramHtml(BOT, CHAT, text, {
              trace: {
                session: activeSession.state.sessionId,
                source: "rollup",
              },
            }),
        }
      : null;
  if (!send && memoryReportsEnabled(settings)) {
    console.error(
      `rollup ${period}: no TELEGRAM_BOT_TOKEN/TELEGRAM_DIGEST_CHAT_ID — report not sent`,
    );
    process.exit(1);
  }
  // Шум-гейт: итог роллапа в чат уходит только если это осмысленный отчёт. Модель могла
  // вернуть "." (или другой короткий/знаковый мусор) — такой текст владельцу
  // не доставляем, роллап при этом считается успешным (память записана, код выходит 0).
  const reportText = (result.message as string).trim();
  if (reportText.length < 8 || !hasTextSubstance(reportText)) {
    console.log(
      `rollup ${period}: report is ${reportText.length} chars (substance=${hasTextSubstance(reportText)}), skipping chat delivery (noise guard)`,
    );
    process.exit(0);
  }
  const delivery = await deliverMemoryReport({
    dataDir: DATA_DIR,
    settings,
    ranBefore: RAN_BEFORE,
    report: result.message,
    tr,
    send,
  });
  if (delivery.status === "off") {
    if (delivery.notice === "sent")
      console.log(`rollup ${period}: told the chat that reports are now off`);
    if (delivery.notice === "failed")
      console.error(
        `rollup ${period}: could not deliver the reports-off notice`,
      );
    console.log(
      `rollup ${period}: memory reports are off — the report stays in the log`,
    );
    process.exit(0);
  }
  const r = delivery;
  if (r.fellBack) {
    // HTML didn't parse — the report went out flat. Give the agent feedback in the same
    // session so it formats the next report more simply (one turn, no resend).
    // ВАЖНО: дождаться конца хода, чтобы курсор активного клиента сдвинулся.
    // Best-effort ход: отчёт уже доставлен, поэтому сбой или таймаут здесь только логируем —
    // ронять из-за подсказки о форматировании всю ночь незачем.
    try {
      await guardedTurn(
        activeSession,
        `The last report failed Telegram parse_mode=HTML (${r.error}) and went out as flat text. ` +
          "Next time format it more simply: **bold**, `code`, lists — no raw HTML.",
        "format-feedback",
      );
      saveSession(activeSession.state.sessionId, sessionCreatedAt);
    } catch (e) {
      console.error(
        `rollup ${period}: format-feedback turn failed (${(e as Error).message})`,
      );
      if ((e as { code?: string }).code === "ROLLUP_TURN_TIMEOUT")
        await dropHungSession(activeSession, "format-feedback");
    }
  }
  if (r.status === "failed") {
    console.error(`rollup ${period}: Telegram send failed:`, r.error);
    process.exit(1);
  }
  console.log(`rollup ${period}: report sent to Telegram.`);
}

process.exit(0);
