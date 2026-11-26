import { logHint } from "../lib/systemd-control.ts";
import {
  addTelegramQueueReceipt,
  TELEGRAM_ACCEPTANCE_KIND_HEADER,
  TELEGRAM_CLOSED_SESSION_KIND,
} from "#lib/telegram-acceptance-wire.ts";
import { classifyDeliverStatus } from "../lib/deliver-policy.ts";
import { tr } from "#lib/i18n.ts";
import {
  ROUTE,
  ACCEPTANCE_ROUTE,
  SECRET,
  ALLOWED,
  SETTLE_MS,
  sleep,
  log,
} from "./config.ts";
import { traceBridgeDelivery } from "#lib/trace.ts";
import { tg } from "./transport.ts";
import { chatKey } from "./offset.ts";
import type { TelegramQueueUpdate } from "../lib/telegram-queue.ts";
import {
  botIdFromUpdate,
  TELEGRAM_BOT_ID_HEADER,
} from "../../packages/telegram-bots/index.ts";

type TelegramUpdate = TelegramQueueUpdate;
type ErrorLike = { message?: unknown; name?: unknown };
export type DeliverOptions = {
  route?: string;
  acceptedStatus?: number;
  queueReceipt?: boolean;
  retry?: boolean;
  retryAcceptanceTimeout?: boolean;
  boundedAttempts?: number;
  timeoutMs?: number;
  onAcceptanceFailure?: (details: Record<string, unknown>) => Promise<unknown>;
};
const errorMessage = (error: unknown) => (error as ErrorLike).message;

// Deliver one update to the local eve (we mimic a webhook). Three failure classes (see
// deliver-policy.ts): retry — network/5xx/408/425/429, fast backoff, forever; config —
// 401/403/404 mean the secret/route is broken, messages must NOT be thrown away, so
// retry forever with a LONG backoff + alert the owner; bounded-class (other 4xx) — eve
// не даёт надёжного признака «апдейт битый навсегда» (тот же 409 может быть временным
// конфликтом хука), поэтому и эти статусы ретраятся, но ОГРАНИЧЕННО: BOUNDED_ATTEMPTS
// попыток за один проход. После этого durable caller сохраняет ownership для retry.
// Direct delivery keeps that policy. Durable queue replay opts into one bounded attempt
// per drain pass: its on-disk head is the retry mechanism, so one bad chat cannot starve
// other queues or Telegram polling.
// Returns true when eve accepted the update. False is never an acknowledgement:
// the caller must retain durable ownership or surface the failed synthetic action.
// "closed-session" — единственный терминальный исход: eve сообщила заголовком, что
// апдейт нельзя доставить никогда. Владелец обязан снять его с хранения, а не ретраить.
const CONFIG_RETRY_MS = 60_000;
const BOUNDED_ATTEMPTS = 30;
async function deliver(
  update: TelegramUpdate,
  {
    route: requestedRoute,
    acceptedStatus,
    queueReceipt: requestedQueueReceipt,
    retry = true,
    retryAcceptanceTimeout = retry,
    boundedAttempts = BOUNDED_ATTEMPTS,
    timeoutMs,
    onAcceptanceFailure,
  }: DeliverOptions = {},
) {
  // The authored acceptance wrapper observes onMessage/send(), but not
  // onCallbackQuery. Message updates therefore use the stronger route by default,
  // while genuine and synthetic callbacks keep the original webhook path.
  const route =
    requestedRoute ??
    (update?.message && !update?.callback_query ? ACCEPTANCE_ROUTE : ROUTE);
  const expectsAcceptance =
    acceptedStatus !== undefined || route === ACCEPTANCE_ROUTE;
  const expectedStatus =
    acceptedStatus ?? (expectsAcceptance ? 204 : undefined);
  const queueReceipt =
    requestedQueueReceipt ?? (expectsAcceptance && Boolean(update?.message));
  const outgoing = queueReceipt ? addTelegramQueueReceipt(update) : update;
  const botId = botIdFromUpdate(outgoing);
  const reportAcceptanceFailure = async (details: Record<string, unknown>) => {
    if (!onAcceptanceFailure) return;
    try {
      await onAcceptanceFailure(details);
    } catch (error) {
      log(
        "deliver: direct acceptance failure cleanup failed:",
        errorMessage(error),
      );
    }
  };
  for (let attempt = 1; ; attempt++) {
    let wait = Math.min(15000, 1000 * attempt);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET as string,
          ...(botId !== null ? { [TELEGRAM_BOT_ID_HEADER]: botId } : {}),
        },
        body: JSON.stringify(outgoing),
        ...(timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(timeoutMs) }),
      });
      const acceptanceKind = expectsAcceptance
        ? res.headers.get(TELEGRAM_ACCEPTANCE_KIND_HEADER)
        : null;
      // Терминальный класс: ответ на сообщение бота, чья сессия закрыта, и новым ходом
      // он тоже не прошёл. Повтор даст ту же ошибку вечно (issue #203) — доставка
      // кончается здесь, каким бы ни был режим ретрая.
      if (acceptanceKind === TELEGRAM_CLOSED_SESSION_KIND) {
        return TELEGRAM_CLOSED_SESSION_KIND;
      }
      if (
        res.ok &&
        (expectedStatus === undefined || res.status === expectedStatus) &&
        (!expectsAcceptance ||
          acceptanceKind === "turn" ||
          acceptanceKind === "handled")
      ) {
        return acceptanceKind === "handled" ? "handled" : true;
      }
      if (res.ok) {
        if (expectsAcceptance) {
          await reportAcceptanceFailure({
            attempt,
            kind: "protocol",
            status: res.status,
          });
        }
        if (!retry) {
          log(
            `deliver: acceptance route replied ${res.status} without a valid acceptance receipt; queue head retained`,
          );
          return false;
        }
      }
      if (expectsAcceptance && res.status === 503) {
        await reportAcceptanceFailure({
          attempt,
          kind: "dispatch",
          status: res.status,
        });
      }
      const cls = classifyDeliverStatus(res.status, {
        acceptance: expectsAcceptance,
      });
      if (!retry) {
        log(
          `deliver: eve replied ${res.status}; queue head retained for a later pass`,
        );
        return false;
      }
      if (cls === "bounded") {
        if (attempt < boundedAttempts) {
          log(
            `deliver: eve replied ${res.status} (attempt ${attempt}/${boundedAttempts}) — retrying (may be transient)`,
          );
          await sleep(wait);
          continue;
        }
        log(
          `deliver: eve replied ${res.status} ${boundedAttempts} times; giving up this pass; durable owner retains update ${String(update.update_id)}`,
        );
        await notifyDeliverProblem("retained", res.status);
        return false;
      }
      if (cls === "config") {
        // Не дропаем: это конфигурация сломана, а не апдейт. Длинный бэкофф, чтобы не
        // молотить, и алерт владельцу — чинить надо руками (secret/route).
        wait = CONFIG_RETRY_MS;
        await notifyDeliverProblem("config", res.status);
        log(
          `deliver: eve replied ${res.status} (config error, attempt ${attempt}) — retrying in ${wait / 1000}s`,
        );
      } else {
        log(
          `deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`,
        );
      }
    } catch (e) {
      const acceptanceTimeout =
        expectsAcceptance &&
        ((e as ErrorLike | null | undefined)?.name === "TimeoutError" ||
          (e as ErrorLike | null | undefined)?.name === "AbortError");
      if (acceptanceTimeout) {
        await reportAcceptanceFailure({
          attempt,
          kind: "timeout",
          status: "timeout",
        });
      }
      if (!retry) {
        log(
          `deliver: eve unavailable (${String(errorMessage(e))}); queue head retained for a later pass`,
        );
        return false;
      }
      if (acceptanceTimeout && !retryAcceptanceTimeout) {
        // A timed-out POST may still start later. Re-posting it could duplicate the
        // turn, so direct acceptance timeouts are definitive and never retried.
        log(
          `deliver: direct acceptance timed out after ${timeoutMs}ms; rejecting update ${String(update.update_id)} without retry`,
        );
        return false;
      }
      if (acceptanceTimeout) {
        if (attempt < boundedAttempts) {
          log(
            `deliver: acceptance timed out (attempt ${attempt}/${boundedAttempts}) — retrying`,
          );
          await sleep(wait);
          continue;
        }
        log(
          `deliver: acceptance timed out ${boundedAttempts} times; giving up this pass; durable owner retains update ${String(update.update_id)}`,
        );
        await notifyDeliverProblem("retained", "timeout");
        return false;
      }
      log(
        `deliver: eve unavailable (${String(errorMessage(e))}, attempt ${attempt}) — waiting for server`,
      );
    }
    await sleep(wait);
  }
}

// Владелец должен узнать и о retained-апдейте, и о конфиг-ошибке (secret/route).
// Один раз на процесс и класс — чтобы серия ошибок не превратилась в спам. Класс
// помечается «уведомлённым» только ПОСЛЕ успешной отправки: упавший sendMessage не
// должен навсегда лишать владельца алерта.
const deliverNotified = new Set();
async function notifyDeliverProblem(kind: string, status: unknown) {
  if (deliverNotified.has(kind)) return;
  const target = process.env.TELEGRAM_DIGEST_CHAT_ID || [...ALLOWED][0];
  if (!target) {
    log(
      "deliver notification skipped:",
      kind,
      "- no target (TELEGRAM_DIGEST_CHAT_ID / TELEGRAM_ALLOWED_USER_IDS)",
    );
    return;
  }
  const text =
    kind === "config"
      ? tr(
          `⚠️ Iva bridge can't deliver to eve: HTTP ${String(status)} — the webhook secret or route looks broken. Messages are queued (retrying every 60s). Check: ${logHint("iva-telegram-poll")}`,
          `⚠️ Мост Iva не может доставить в eve: HTTP ${String(status)} — похоже, разъехались webhook-секрет или маршрут. Сообщения не теряются (ретрай раз в 60с). Проверь: ${logHint("iva-telegram-poll")}`,
        )
      : tr(
          `⚠️ Iva bridge retained a Telegram update after repeated HTTP ${String(status)} rejections. It will retry from durable storage. Check the logs: ${logHint("iva-telegram-poll")}`,
          `⚠️ Мост Iva сохранил Telegram-апдейт после повторных отказов HTTP ${String(status)}. Доставка повторится из дюрабельного хранилища. Проверь логи: ${logHint("iva-telegram-poll")}`,
        );
  try {
    const res = await tg("sendMessage", { chat_id: target, text });
    if ((res as { ok?: unknown } | null)?.ok) deliverNotified.add(kind);
  } catch (e) {
    log("deliver notification failed:", errorMessage(e));
  }
}

// Время последней доставки по chat key — для паузы SETTLE_MS между апдейтами одного чата.
// МОДУЛЬ-уровень (не локальная в main): её обязан обновлять и синтетический deliver меню
// (дистилляция интервью), иначе реальное сообщение сразу после него ушло бы без паузы —
// в окно, пока eve ещё не записала run-status с первичным sessionId.
const lastDeliverAt = new Map<string, number>();

// Доставка с пейсингом: выдержать SETTLE_MS с последней доставки в этот чат, доставить,
// отметить время. ЕДИНЫЙ путь для главного цикла и для меню (deps.deliver) — оба делят
// lastDeliverAt, поэтому доставка из меню сдвигает паузу для следующего реального сообщения.
async function pacedDeliver(update: TelegramUpdate, options?: DeliverOptions) {
  const startedAt = Date.now();
  const deadline =
    options?.timeoutMs === undefined
      ? null
      : Date.now() + Math.max(0, options.timeoutMs);
  const key = chatKey(update);
  if (key !== null && SETTLE_MS > 0) {
    const prev = lastDeliverAt.get(key);
    if (prev !== undefined) {
      const wait = SETTLE_MS - (Date.now() - prev);
      if (wait > 0) {
        if (deadline !== null && wait >= deadline - Date.now()) return false;
        await sleep(wait);
      }
    }
  }
  const deliverOptions =
    deadline === null
      ? options
      : {
          ...options,
          timeoutMs: Math.max(1, Math.floor(deadline - Date.now())),
        };
  const accepted = await deliver(update, deliverOptions); // wait for delivery — ordered and lossless
  // Trace: чем кончилась отдача апдейта агенту. Один исход на одну доставку, включая
  // повторы очереди — их видно по одинаковому ключу апдейта (ADR-0010).
  traceBridgeDelivery(update, accepted, Date.now() - startedAt);
  if (key !== null) lastDeliverAt.set(key, Date.now());
  return accepted; // false is retained/not delivered and must never be acknowledged
}

export { deliver, notifyDeliverProblem, pacedDeliver };
