import { verifyTelegramRequest } from "eve/channels/telegram";
import type { AttachSessionFn } from "eve/channels";
import { cancelEveTurn } from "./eve-cancel.ts";

export const TELEGRAM_CANCEL_ROUTE = "/eve/v1/telegram/cancel";

/**
 * Собственный адрес cancel-роута для самовызова из канала (кнопка ⏹ Стоп в
 * webhook-режиме). Правило хоста — копия `scripts/poller/config.ts`: authored tree не
 * может импортировать из `scripts/`, поэтому копии пришпилены тестом
 * (`scripts/poller/config.test.ts`), как и остальные общие константы шва.
 */
export function localCancelUrl(env: NodeJS.ProcessEnv = process.env): string {
  return localChannelUrl(TELEGRAM_CANCEL_ROUTE, env);
}

/** Адрес собственного роута канала по тому же правилу хоста (cancel, compact). */
export function localChannelUrl(
  route: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = (
    env.ASSISTANT_HOST ?? `http://127.0.0.1:${env.IVA_PORT ?? "8723"}`
  ).replace(/\/$/, "");
  return `${host}${route}`;
}

/**
 * Authenticated Telegram-owned turn cancellation endpoint — путь кнопки ⏹ Стоп
 * и команды /stop. `attachSession` pins the request to the exact session that
 * wrote the current run status.
 *
 * Отмена живёт в роуте, а не в обработчике callback_query: публичный cancel eve
 * отдаётся только через RouteHandlerArgs. Мост зовёт роут напрямую, тем же
 * секретом вебхука, что и /eve/v1/telegram/reset.
 */
export async function handleTelegramCancelRequest(
  req: Request,
  attachSession: AttachSessionFn,
  secretToken?: string,
): Promise<Response> {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(raw) as {
      sessionId?: unknown;
      turnId?: unknown;
    } | null;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return new Response("sessionId is required", { status: 400 });
  }
  const turnId = body?.turnId;
  if (
    turnId !== undefined &&
    (typeof turnId !== "string" || turnId.length === 0)
  ) {
    return new Response("turnId must be a non-empty string", { status: 400 });
  }

  const result = await cancelEveTurn(attachSession, { sessionId, turnId });
  return Response.json({ ok: true, ...result });
}
