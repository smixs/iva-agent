/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable fetch boundary source-compatible. */
// Просьба к eve пересказать историю сессии — штатный роут eve-канала
// POST /eve/v1/session/:sessionId/compact под общим токеном внутренних клиентов Ивы
// (agent/lib/eve-auth.ts). Событийные обработчики канала публичный compact() не получают,
// поэтому канал зовёт роут собственного процесса.
import { localChannelUrl } from "./telegram-cancel-route.ts";

/** Адрес роута свёртки сессии по правилу хоста собственных роутов канала. */
export const localSessionCompactUrl = (
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
) =>
  localChannelUrl(
    `/eve/v1/session/${encodeURIComponent(sessionId)}/compact`,
    env,
  );

type FetchResponse = { status: number };
type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponse>;

/**
 * true — eve приняла просьбу (202) и поставит пересказ за активным ходом.
 * false — eve отказала: сессии уже нет (200 no_active_session) или запрос отвергнут (4xx).
 * Исключение — исход неизвестен: ответа нет (таймаут, обрыв) или eve ответила сбоем
 * диспетчера (5xx), после которого просьба могла остаться в её очереди.
 */
export async function requestSessionCompact({
  url,
  bearer,
  fetchImpl = fetch as unknown as FetchImpl,
  timeoutMs = 5_000,
  logImpl = console.error,
}: {
  url: string;
  bearer: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  logImpl?: (...parts: unknown[]) => void;
}): Promise<boolean> {
  const { status } = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (status === 202) return true;
  if (status === 200) return false;
  if (status >= 400 && status < 500) {
    logImpl(`[telegram] eve отклонила свёртку сессии: HTTP ${String(status)}`);
    return false;
  }
  throw new Error(`eve compact route answered HTTP ${String(status)}`);
}
