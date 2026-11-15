import { serviceManager } from "../lib/service-manager.ts";
import { execFile, spawn } from "node:child_process";
import { basename, join } from "node:path";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readEnvFresh } from "../lib/env-file.ts";
import {
  inspectUpstream,
  markVersionNotified,
  updateKeepsLine,
  updateOfferActionLines,
} from "../lib/update-check.ts";
import { modelSummary } from "../lib/model-summary.ts";
import { reporterFor } from "../lib/telegram-status.ts";
import { classifyRoot, upstreamQuery } from "../lib/version-layout.ts";
import { createVersionStore, updateRunning } from "../lib/version-store.ts";
import { readUpdateRun, type UpdateRun } from "../lib/update-run-journal.ts";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { getLang, tr } from "#lib/i18n.ts";
import {
  ALLOWED,
  DATA_DIR,
  ENV_PATH,
  NODE,
  ROOT,
  UPDATE_JOB_TTL_MS,
  log,
  sleep,
} from "./config.ts";
import { edit, reply, tg } from "./transport.ts";
import { parseUpdateCallbackData } from "./update-callback.ts";
import { isRecord } from "../../packages/guards/index.ts";
export { parseUpdateCallbackData } from "./update-callback.ts";

type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type UpdateCheckOptions = {
  /** The tree this bridge runs out of; on the immutable layout, `<home>/current`. */
  root?: string;
  inspectImpl?: (options: {
    root: string;
    head?: string;
  }) => Promise<UpdateInfo>;
  markNotifiedImpl?: (dataDir: string, version: string) => Promise<void>;
  envImpl?: () => Promise<NodeJS.ProcessEnv>;
  /** `/update --force`: rebuild the release that runs, with no question to upstream. */
  force?: boolean;
};
type TelegramMessage = { message_id: number };
type UpdateCallbackQuery = {
  id: string;
  from?: { id?: string | number };
  message?: { chat?: { id?: string | number }; message_id?: number };
  data: string;
};
type LaunchResult = { ok: boolean; msg: string };
type ErrorLike = { message?: unknown };

function messageEditSucceeded(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TelegramMessage).message_id === "number"
  );
}

// ── self-update (/update) ──────────────────────────────────────────────────
// Run `iva update` in its OWN transient systemd scope, so it survives the restart of
// THIS bridge (restartServices restarts iva-telegram-poll too — a plain child would be
// killed with us). --collect GC's the unit after exit. The updater reads a 0600 job
// file and posts each phase directly through Bot API, so no bridge process survives.
export function launchSelfUpdate(jobId: string): Promise<LaunchResult> {
  return launchIvaCommand("iva-self-update", [
    "update",
    "--telegram-job",
    jobId,
  ]);
}

/**
 * Any `iva` subcommand the bridge starts on the owner's tap, the way the self-update is
 * started: its own transient unit (or a detached process without systemd), so it survives
 * the restart of this bridge. The plugin installer (`iva plugin install-proposal`) is the
 * second one.
 */
export function launchIvaCommand(
  unitPrefix: string,
  ivaArgs: readonly string[],
): Promise<LaunchResult> {
  const command = [join(ROOT, "bin/iva.mjs"), ...ivaArgs];
  if (serviceManager() === "launchd") {
    return new Promise((resolve) => {
      const child = spawn(NODE, command, {
        cwd: ROOT,
        env: { ...process.env, ASSISTANT_DATA_DIR: DATA_DIR },
        detached: true,
        stdio: "ignore",
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true, msg: "detached" });
      });
      child.once("error", (error) =>
        resolve({ ok: false, msg: error.message }),
      );
    });
  }
  const args = [
    "--user",
    "--collect",
    `--unit=${unitPrefix}-${Date.now()}`,
    `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH || ""}`,
    `--setenv=ASSISTANT_DATA_DIR=${DATA_DIR}`,
    NODE,
    ...command,
  ];
  return new Promise<LaunchResult>((resolve) =>
    execFile("systemd-run", args, (err, out, e) => {
      // Без systemd (Docker, чужой супервизор) systemd-run нет вовсе: тогда обновлятор
      // запускается отсоединённым дочерним процессом. Он переживёт рестарт моста, потому
      // что ему не родитель, а своя сессия; рестарт сервисов обновлятор сам пропустит
      // (hasSystemd). Прецедент 13.09.2026: «Не удалось запустить обновление» ×3 в Docker.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const child = spawn(NODE, command, {
            cwd: ROOT,
            env: { ...process.env, ASSISTANT_DATA_DIR: DATA_DIR },
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          log(
            `systemd-run not found; ${unitPrefix} launched as a detached process`,
          );
          resolve({ ok: true, msg: "detached" });
        } catch (spawnError) {
          resolve({
            ok: false,
            msg: String((spawnError as ErrorLike).message ?? spawnError),
          });
        }
        return;
      }
      resolve({ ok: !err, msg: (e || out || "").toString().trim() });
    }),
  );
}

export async function handleUpdateCheck(
  chatId: string | number,
  {
    root = ROOT,
    inspectImpl = inspectUpstream,
    markNotifiedImpl = markVersionNotified,
    envImpl = () => readEnvFresh(ENV_PATH),
    force = false,
  }: UpdateCheckOptions = {},
): Promise<boolean> {
  const status = (await reply(
    chatId,
    force
      ? tr("◇ Rebuilding the current version", "◇ Пересобираю текущую версию")
      : tr("◇ Checking for updates", "◇ Проверяю обновления"),
    { silent: true },
  )) as TelegramMessage | null;
  if (!status || typeof status.message_id !== "number") return false;
  // The same rebuild `iva update --force` does on the server, asked from the chat: no
  // question to upstream, no offer to tap - the word was the confirmation.
  if (force) return startSelfUpdate(chatId, status.message_id, { force });
  let info;
  try {
    // The same question the daily check asks, and on a converted installation the
    // same two answers: a version has no `.git` of its own, and the mirror's HEAD
    // is upstream's, so the running commit has to be named.
    info = await inspectImpl(upstreamQuery(root));
  } catch {
    return messageEditSucceeded(
      await edit(
        chatId,
        status.message_id,
        tr(
          "⚠️ Couldn't check for updates",
          "⚠️ Не удалось проверить обновления",
        ),
      ),
    );
  }
  if (!info.hasCommitUpdate) {
    // Not modelSummary(process.env): the /model wizard edits .env at runtime and restarts
    // only the agent — this bridge keeps running, so its env snapshot may hold the old model.
    const model = modelSummary(await envImpl());
    return messageEditSucceeded(
      await edit(
        chatId,
        status.message_id,
        tr(
          `✅ You're up to date\n\nIva v${info.localVersion ?? "?"}\nModel: ${model.line}`,
          `✅ У вас актуальная версия\n\nIva v${info.localVersion ?? "?"}\nМодель: ${model.line}`,
        ),
      ),
    );
  }
  const bump =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.localVersion ?? "?"} → v${info.remoteVersion}`
      : tr(
          `v${info.localVersion ?? "?"} → newer build`,
          `v${info.localVersion ?? "?"} → новая сборка`,
        );
  // Кнопки предложения — строки самого сообщения (rich): каждая рядом со своим пояснением.
  // Тот же помощник собирает их для ежедневного Alert'а — одна формулировка на оба экрана.
  const target =
    info.remoteVersion && info.remoteVersion !== info.localVersion
      ? `v${info.remoteVersion}`
      : tr("a newer build", "новую сборку");
  const offered = await edit(
    chatId,
    status.message_id,
    tr(
      `⬆️ Update available\n\n${bump}\n${updateKeepsLine("en")}`,
      `⬆️ Доступно обновление\n\n${bump}\n${updateKeepsLine("ru")}`,
    ) + `\n\n${updateOfferActionLines(getLang(), target)}`,
  );
  const offerShown = messageEditSucceeded(offered);
  if (offerShown && info.hasVersionUpdate) {
    await markNotifiedImpl(DATA_DIR, info.remoteVersion).catch(
      (error: unknown) =>
        log("update notification state failed:", (error as ErrorLike).message),
    );
  }
  return offerShown;
}

const jobsDir = (): string => join(DATA_DIR, "update-jobs");

/**
 * Заявка на повтор - часть своего job, а не отдельный файл со своим возрастом: TTL
 * судит только job, а заявка уходит вместе с ним (или когда его уже нет). Иначе
 * восстановление файлов или сдвиг времён оставлял свежий job без заявки, и обрыв
 * повторялся второй раз - инвариант «один повтор» держался бы на двух mtime.
 */
async function removeStaleUpdateJobs(): Promise<void> {
  const jobs = jobsDir();
  let names;
  try {
    names = await readdir(jobs);
  } catch {
    return;
  }
  const marks = names.filter((name) => name.endsWith(RETRY_MARK_SUFFIX));
  const alive = new Set(
    names.filter((name) => !name.endsWith(RETRY_MARK_SUFFIX)),
  );
  await Promise.all(
    [...alive].map(async (name) => {
      const path = join(jobs, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs <= UPDATE_JOB_TTL_MS)
          return;
        await rm(path, { force: true });
        alive.delete(name);
      } catch {
        // Stale-job cleanup tolerates files disappearing or changing concurrently.
      }
    }),
  );
  await Promise.all(
    marks.map(async (name) => {
      if (alive.has(name.slice(0, -RETRY_MARK_SUFFIX.length))) return;
      try {
        await rm(join(jobs, name), { force: true });
      } catch {
        // Stale-job cleanup tolerates files disappearing or changing concurrently.
      }
    }),
  );
}

// Inline-button taps for the /update flow. Handled by the bridge; never delivered to eve.
export async function handleUpdateCallback(
  cq: UpdateCallbackQuery,
): Promise<boolean> {
  const parsed = parseUpdateCallbackData(cq.data);
  const senderId = cq.from?.id;
  const from = senderId === undefined ? null : String(senderId);
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id }); // spinner only; never primary proof
  if (parsed === null) {
    log("ignored invalid update callback data");
    return false;
  }
  if (from === null) return false;
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // explicit terminal drop for a known untrusted sender
  if (parsed.action === "skip") {
    // Правка несёт новый markdown целиком: кнопки предложения жили в тексте, а снимать
    // прежнюю клавиатуру (пустым рядом) больше не нужно — её просто нет.
    const edited = await edit(
      chatId as string | number,
      messageId as number,
      tr("– Update postponed", "– Обновление отложено"),
    );
    return messageEditSucceeded(edited);
  }
  return startSelfUpdate(chatId as string | number, messageId as number);
}

/**
 * One update job, from the file the updater reports to, to the launch. The button
 * and `/update --force` end here; `force` travels in the job file, not on the command
 * line, so the retry after an interruption rebuilds exactly what was asked.
 */
async function startSelfUpdate(
  chatId: string | number,
  messageId: number,
  { force = false }: { force?: boolean } = {},
): Promise<boolean> {
  const jobId = randomBytes(8).toString("hex");
  // Asked, never taken: the updater this launches owns the lock from end to end.
  // A lock claimed here on its behalf would outlive the launch - this bridge does
  // not release it, and it is restarted by the very update it is waiting for - so
  // one tap would answer "already running" to every update after it.
  if (updateRunning(DATA_DIR)) {
    const edited = await edit(
      chatId,
      messageId,
      tr("⚠️ An update is already running", "⚠️ Обновление уже идёт"),
    );
    return messageEditSucceeded(edited);
  }
  // The version that runs as the tap is made. What the update moves the box off
  // of, written down while the process that knows it is still alive: after the
  // restart nothing else can name it. A development checkout has no version and
  // simply leaves the field out.
  const currentAtStart = createVersionStore(
    classifyRoot(ROOT).home,
  ).currentName();
  await writeFileAtomic(
    join(jobsDir(), `${jobId}.json`),
    JSON.stringify({
      chatId,
      messageId,
      locale: getLang(),
      startedAt: new Date().toISOString(),
      ...(currentAtStart ? { currentAtStart } : {}),
      ...(force ? { force: true } : {}),
    }),
    { mode: 0o600 },
  );
  await edit(
    chatId,
    messageId,
    tr("◇ Starting the update", "◇ Запускаю обновление"),
  );
  const r = await launchSelfUpdate(jobId);
  if (!r.ok) {
    await rm(join(jobsDir(), `${jobId}.json`), { force: true });
    // systemd-run's own words go to the journal, and the first line reaches the chat:
    // without them «couldn't start» is undebuggable (13.09.2026, three users at once).
    const reason = r.msg.split("\n")[0].slice(0, 200);
    log("self-update launch failed:", r.msg || "(no output)");
    const failureNotice = await edit(
      chatId,
      messageId,
      `${tr("⚠️ Couldn't start the update", "⚠️ Не удалось запустить обновление")}${reason ? `\n\n${reason}` : ""}\n\n${tr("Run on the server: iva update", "Запустите на сервере: iva update")}`,
    );
    return messageEditSucceeded(failureNotice);
  }
  // The durable job now owns reconciliation and the updater process owns execution.
  return true;
}

// ── the last word on an update (reconciliation) ────────────────────────────
// The updater that installs a version dies with the restart it orders: its process
// is the retired version's. Whatever it still owed the chat it leaves in the job
// file, and this bridge - the process the restart brings up - is what says it.

/** How often a job with no outcome yet is looked at again. */
const WATCH_TICK_MS = 5_000;
/** How long after the lock goes a job is given to grow an outcome. */
const WATCH_GRACE_MS = 30_000;

type UpdateJob = {
  chatId?: string | number;
  messageId?: string | number;
  locale?: string;
  startedAt?: string;
  /** The version that ran when the tap was made; absent on a checkout. */
  currentAtStart?: string;
  outcome?: unknown;
};
type FinalVersions = { beforeVersion?: string; afterVersion: string };
type ReconcileOptions = {
  root?: string;
  tickMs?: number;
  graceMs?: number;
  /**
   * Как запускается повтор прерванного обновления. Без значения по умолчанию: молчаливый
   * боевой запуск делал бы любой тест, забывший подставить своё, настоящим самообновлением
   * того дерева, в котором он бежит.
   */
  launchImpl: (jobId: string) => Promise<LaunchResult>;
};
type VersionStore = ReturnType<typeof createVersionStore>;

async function readUpdateJob(path: string): Promise<UpdateJob | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // Gone, or never valid JSON: there is nothing to answer with.
  }
}

/** The final an updater wrote down, or null when it never got that far. */
function outcomeOf(job: UpdateJob): FinalVersions | null {
  const outcome = job.outcome;
  if (!isRecord(outcome)) return null;
  if (outcome.schema !== "iva-update-outcome/v1") return null;
  if (outcome.status !== "updated") return null;
  const { after, before } = outcome;
  if (typeof after !== "string" || !after) return null;
  return {
    afterVersion: after,
    beforeVersion: typeof before === "string" && before ? before : undefined,
  };
}

/**
 * The same final screen the updater would have shown, through the same reporter:
 * one vocabulary, one Gate, one set of retries. False keeps the job for the next
 * start of the bridge, with the six-hour TTL as the ceiling.
 */
async function deliverFinal(
  job: UpdateJob,
  versions: FinalVersions,
): Promise<boolean> {
  let reporter;
  try {
    const env = await readEnvFresh(ENV_PATH);
    reporter = reporterFor(job, env.TELEGRAM_BOT_TOKEN, env);
    if (!reporter) return false; // No chat, no message: nothing to answer.
    return await reporter.complete(versions);
  } catch (error) {
    log("update final delivery failed:", (error as ErrorLike).message);
    return false;
  } finally {
    reporter?.dispose();
  }
}

/**
 * The "did not finish" screen: a job whose updater left no verdict. Sent through the same
 * reporter and the same Gate as the ✅ one, and once - the file goes with it.
 */
async function deliverUnfinished(
  job: UpdateJob,
  beforeVersion: string,
  detail?: string,
): Promise<boolean> {
  let reporter;
  try {
    const env = await readEnvFresh(ENV_PATH);
    reporter = reporterFor(job, env.TELEGRAM_BOT_TOKEN, env);
    if (!reporter) return false; // No chat, no message: nothing to answer.
    return await reporter.unfinished(beforeVersion, detail);
  } catch (error) {
    log("update failure delivery failed:", (error as ErrorLike).message);
    return false;
  } finally {
    reporter?.dispose();
  }
}

/** The version that runs now, when it is not the one the tap was made on. */
function flippedTo(store: VersionStore, job: UpdateJob): string | null {
  if (typeof job.currentAtStart !== "string") return null;
  const current = store.currentName();
  return current && current !== job.currentAtStart ? current : null;
}

function finishedAfterStart(
  startedAt: string | undefined,
  settledAt: string | null,
): boolean {
  const started = Date.parse(startedAt ?? "");
  const settled = Date.parse(settledAt ?? "");
  return (
    Number.isFinite(started) && Number.isFinite(settled) && settled > started
  );
}

/**
 * A move that did not stick. A rollback settles the installation back onto the
 * version it started on (version-update.ts: recordLive(name, false), activate(back),
 * settle(back)), so the settle marker of a failed update is as fresh as a good one's
 * and says nothing about which way it went. Neither does the age of the directories:
 * activate() relinks state inside the version it turns on, so the build a rollback
 * lands back on is the freshest thing on disk and the running one at the same time.
 * What the rollback does leave is the build it came off - present, not running, and
 * on record as having taken the service down. That is the whole reading.
 *
 * Why any such build and not only a recent one: this is asked on one branch only -
 * a job too old to name the version it started on - and such a job comes from a
 * bridge that the update itself replaces, so it is answered once and then never
 * exists again; the six-hour TTL is its ceiling either way. A failure left on disk
 * by an older update therefore costs at most one spinner that expires, while a
 * rollback read as a success costs a "✅" on the version the update just failed to
 * leave. The conservative reading is the cheap one.
 */
function rolledBack(store: VersionStore, running: string): boolean {
  return store
    .list()
    .some((name) => name !== running && store.liveFailed(name));
}

/**
 * The file of a job whose final screen has already gone out. Delivery is the part
 * the chat sees and the part that must happen once; the file is bookkeeping behind
 * it. A jobs directory that refuses the unlink - read-only, or owned by someone
 * else - therefore costs a line in the journal and a file that waits for the TTL,
 * never a throw: the watcher that called this is done with the job either way, and
 * a throw would put it back on the loop to deliver the same final on every tick.
 */
async function dropDeliveredJob(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
    await rm(retryMark(path), { force: true });
  } catch (error) {
    log(
      "update job file left on disk after its final:",
      basename(path),
      (error as ErrorLike).message,
    );
  }
}

/**
 * A job whose updater never got to write its outcome down - killed between the
 * flip and the file. The installation itself is the only witness left, and a "✅"
 * invented without one is worse than the spinner it would replace: a job nothing
 * proves is left to the TTL rather than answered with a guess.
 */
/**
 * Итог, записанный журналом хода (specs/UpdateJob.tla): одна запись вместо четырёх
 * источников. `ok` — фаза "settled"/"done": она пишется после того, как кандидат ответил и
 * active.json назвал его. `unfinished` — ход закрыт отказом, и версия на месте.
 * `null` — ход ещё идёт (его повторяет retryInterruptedUpdate) или журнал про другую версию.
 */
function journalVerdict(
  journal: UpdateRun | null,
  moved: string,
):
  | { ok: true; before?: string }
  | { ok: false; before?: string; detail?: string }
  | null {
  if (!journal || journal.version !== moved) return null;
  const before = journal.outcome?.before ?? journal.from ?? undefined;
  if (journal.phase === "settled" || journal.phase === "done") {
    return journal.outcome &&
      journal.outcome.status !== "updated" &&
      journal.outcome.status !== "current"
      ? {
          ok: false,
          ...(before ? { before } : {}),
          ...(journal.outcome.message
            ? { detail: journal.outcome.message }
            : {}),
        }
      : { ok: true, ...(before ? { before } : {}) };
  }
  if (journal.phase === "rolledback" || journal.phase === "failed") {
    return {
      ok: false,
      ...(before ? { before } : {}),
      ...(journal.outcome?.message ? { detail: journal.outcome.message } : {}),
    };
  }
  return null;
}

async function concludeUpdateJob(
  path: string,
  job: UpdateJob,
  store: VersionStore,
  moved: string | null,
): Promise<void> {
  if (moved) {
    // С журналом хода исход читается из него одного: фаза "settled" пишется после ответа
    // кандидата и settle, поэтому «✅ старая → новая» отсюда не может обогнать ответ.
    const journal = readUpdateRun(store.layout.data);
    const verdict = journalVerdict(journal, moved);
    if (verdict?.ok) {
      if (
        await deliverFinal(job, {
          beforeVersion: verdict.before ?? job.currentAtStart,
          afterVersion: moved,
        })
      )
        await dropDeliveredJob(path);
      return;
    }
    if (verdict && !verdict.ok) {
      if (
        await deliverUnfinished(
          job,
          verdict.before ?? job.currentAtStart ?? moved,
          verdict.detail,
        )
      )
        await dropDeliveredJob(path);
      return;
    }
    if (journal?.version === moved) {
      // Ход ещё идёт: исход в журнале появится, и его прочтёт следующий тик или срок.
      log("update job waits for the run in its journal:", basename(path));
    }
    if (journal?.version === moved) return;
    // Ниже — ход, начатый версией без журнала (обновление с 0.5.0-0.5.11): исход
    // выводится из четырёх источников. Новый код этот путь не теряет, потому что такой
    // ход живёт до первого обновления с журналом.
    // An update is a move that finished onto a version that lives, off a version
    // that lived. Three questions, and a "✅" needs all three answered.
    //
    // Did the move finish? The settle marker is the last thing an update writes,
    // and it is written after the service has answered on its port (version-update.ts:
    // recordLive(name, true), then settle(name)). Everything between the flip and it -
    // the migrations, the vault cleanup, the restart, the health deadline - is where
    // an updater dies without leaving a verdict on anything: `current` is the new
    // build, no failure is on record, and the flip alone reads "✅ old → new" over an
    // agent that may be lying down. `settled() === moved` is what the installation
    // itself says about that, and the same marker `iva doctor` reads to report an
    // "update to X never finished". It also survives what the failure list does not:
    // that list keeps only the last few builds, so a verdict can be pushed out of it,
    // and a guard that only asks about failures goes blind exactly then.
    //
    // Is the version it stands on good? The marker alone does not say so. A rollback
    // settles the version it goes back to without ever proving it (version-update.ts:
    // activate(back), then settle(back), with no probe between), so the far end of a
    // rollback satisfies `settled() === moved` too - only the verdict on that version
    // rules out a "✅ old → new" over a box that does not answer.
    //
    // Is the version it came off good? A job written while the box already sat on a
    // half-installed build names that build as its start. The resumed run rolls back
    // off it - recordLive(new, false), activate(old), settle(old) - which moves
    // `current` to the old version and settles there, so `settled() === moved` holds
    // once more and the arrow drawn from it reads "✅ new → old": a downgrade sold as
    // an update. The verdict the rollback recorded on the version this job started on
    // is what catches that one.
    //
    // Neither verdict is read off the failures lying around on disk: rolledBack()
    // below asks whether anything not running ever took the service down, and after
    // an honest update the previous update's corpse is still there - that reading
    // would swallow a ✅ the user is owed. A job that named its version asks about
    // its own two ends and nothing else.
    const dead =
      store.liveFailed(moved) ||
      (typeof job.currentAtStart === "string" &&
        store.liveFailed(job.currentAtStart));
    if (dead || store.settled() !== moved) {
      log(
        dead
          ? "update job left for the ttl; an end of the move is on record as dead:"
          : "update job left for the ttl; the move onto this version never settled:",
        basename(path),
      );
      return;
    }
    if (
      await deliverFinal(job, {
        beforeVersion: job.currentAtStart,
        afterVersion: moved,
      })
    )
      await dropDeliveredJob(path);
    return;
  }
  // A job from a bridge that did not write down the version it started on. The
  // settle marker is all there is, and it can only say that a move finished -
  // so the user is told which version runs, without an arrow nobody can draw.
  // A move that finished by going back is still a finished move, and the marker
  // reads the same either way: a rollback has to be ruled out here, or the box
  // reports "✅ updated" on the version the update just failed to leave.
  const after = store.currentName() ?? store.settled();
  if (
    job.currentAtStart === undefined &&
    after &&
    !rolledBack(store, after) &&
    finishedAfterStart(job.startedAt, store.settledAt())
  ) {
    if (await deliverFinal(job, { afterVersion: after }))
      await dropDeliveredJob(path);
    return;
  }
  log(
    "update job left for the ttl; nothing proves the update finished:",
    basename(path),
  );
}

/**
 * One job with no outcome, watched until the installation says something about
 * it. Runs beside the polling loop: every tick is guarded, and a tick that throws
 * is a line in the journal, never a bridge that stopped answering messages.
 */
async function watchUpdateJob(
  path: string,
  snapshot: UpdateJob,
  {
    root,
    tickMs,
    graceMs,
  }: Required<Pick<ReconcileOptions, "root" | "tickMs" | "graceMs">>,
): Promise<void> {
  const store = createVersionStore(classifyRoot(root).home);
  const deadline = Date.now() + UPDATE_JOB_TTL_MS;
  let quietSince: number | null = null;
  while (Date.now() < deadline) {
    await sleep(tickMs);
    try {
      // The updater still holds the lock: it is alive and owes the chat nothing.
      if (updateRunning(DATA_DIR)) {
        quietSince = null;
        continue;
      }
      const job = await readUpdateJob(path);
      const outcome = job && outcomeOf(job);
      // A final that went out ends the watch, whatever the disk then says: the
      // unlink is bookkeeping (dropDeliveredJob swallows its failure), and a tick
      // that threw past this return would come back and say the same thing again -
      // every five seconds, for as long as the TTL allows.
      if (job && outcome) {
        if (await deliverFinal(job, outcome)) await dropDeliveredJob(path);
        return;
      }
      const moved = flippedTo(store, snapshot);
      // The file went with an updater that answered the chat itself: nothing was
      // installed, so nothing restarted, so the report went out the ordinary way.
      if (!job && !moved) {
        await rm(retryMark(path), { force: true }); // Заявка живёт не дольше своего job.
        return;
      }
      quietSince ??= Date.now();
      if (Date.now() - quietSince < graceMs) continue;
      await concludeUpdateJob(path, job ?? snapshot, store, moved);
      return;
    } catch (error) {
      log("update job watch failed:", (error as ErrorLike).message);
    }
  }
  // Срок вышел, пока ход шёл: задание получает итог «не завершилось», а не остаётся
  // крутилкой навсегда (specs/UpdateJob.tla, NoEndlessWatch).
  const running = store.currentName() ?? "the current version";
  if (await deliverUnfinished(snapshot, running)) await dropDeliveredJob(path);
  else log("update job watch gave up on:", basename(path));
}

/** The claim that an interrupted update was already restarted, beside its job file. */
const RETRY_MARK_SUFFIX = ".retried";
const retryMark = (path: string): string => `${path}${RETRY_MARK_SUFFIX}`;

/**
 * An update that was interrupted before it wrote anything down - the box lost power,
 * the process was killed - is started again, once. `runVersionUpdate` finishes whatever
 * the dead run left half-done, so the retry is the whole repair; the claim beside the
 * job file is what keeps it from becoming a loop, and a second break is left to the TTL
 * path below with the message it already has.
 *
 * Заявка создаётся с `wx` (O_EXCL) до запуска: два моста, читающие один job
 * одновременно, получают ровно одно обновление, второй - EEXIST. Обратный порядок
 * (запуск, потом заявка) стоил бы перезапуска обновления на каждом старте моста.
 */
async function retryInterruptedUpdate(
  path: string,
  job: UpdateJob,
  launch: (jobId: string) => Promise<LaunchResult>,
): Promise<boolean> {
  if (updateRunning(DATA_DIR)) return false; // Живой владелец лока: обновление идёт.
  try {
    await writeFile(retryMark(path), "", { flag: "wx", mode: 0o600 });
  } catch {
    return false; // Заявка уже стоит: обновление этого job повторяли.
  }
  const launched = await launch(basename(path, ".json"));
  if (!launched.ok) {
    log("interrupted update not restarted:", launched.msg || "(no output)");
    return false;
  }
  if (job.chatId !== undefined && job.messageId !== undefined)
    await edit(
      job.chatId,
      Number(job.messageId),
      tr(
        "◇ The update was interrupted, retrying",
        "◇ Обновление прервалось, повторяю",
      ),
    );
  return true;
}

/**
 * Answer every update the box has not answered yet. Called once at start, after
 * the stale-job sweep and before the first poll: a job with an outcome is a final
 * screen owed right now, and a job without one is watched in the background while
 * messages keep flowing. The watchers it returns are the caller's to await; the
 * bridge only counts them.
 */
export async function reconcileUpdateJobs({
  root = ROOT,
  tickMs = WATCH_TICK_MS,
  graceMs = WATCH_GRACE_MS,
  launchImpl,
}: ReconcileOptions): Promise<Promise<void>[]> {
  let names: string[];
  try {
    names = await readdir(jobsDir());
  } catch {
    return []; // No update was ever asked for on this box.
  }
  const watchers: Promise<void>[] = [];
  for (const name of names.filter((one) => one.endsWith(".json"))) {
    const path = join(jobsDir(), name);
    // One job's bad luck stays its own, exactly as in the stale sweep above. This
    // runs before deleteWebhook: a throw here is the bridge exiting into a systemd
    // restart, onto the same unreadable - or undeletable - file, forever. A chat
    // that never gets its final screen must not cost the box every other message.
    try {
      const job = await readUpdateJob(path);
      if (!job) continue;
      const outcome = outcomeOf(job);
      if (!outcome) {
        await retryInterruptedUpdate(path, job, launchImpl);
        watchers.push(watchUpdateJob(path, job, { root, tickMs, graceMs }));
        continue;
      }
      if (await deliverFinal(job, outcome)) {
        await rm(path, { force: true });
        await rm(retryMark(path), { force: true });
      } else log("update final undelivered; the job waits for the next start");
    } catch (error) {
      log("update job reconcile failed:", name, (error as ErrorLike).message);
    }
  }
  return watchers;
}

export { removeStaleUpdateJobs };
