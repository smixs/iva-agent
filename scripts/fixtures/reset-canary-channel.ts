// Сохранённая фикстура канала для проверок reset: тест копирует
// этот файл в одноразовое приложение как agent/channels/reset-canary.ts. Он существует
// только ради канарейки session reset. Реальный telegram-канал ходит в
// api.telegram.org; герметичный HTTP-набор проверяет настоящий Telegram route.
//
// Роуты повторяют пару from(address).send/reset. Смоук приходит после reset
// по тому же адресу и проверяет, что история не воскресла.
import { defineChannel, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function dataDir(): string {
  return process.env.ASSISTANT_DATA_DIR ?? "data";
}

function authorized(request: Request): boolean {
  const expected = process.env.ASSISTANT_BEARER;
  if (!expected) return false;
  return extractBearerToken(request.headers.get("authorization")) === expected;
}

async function readAddress(
  request: Request,
): Promise<{ address: string; message?: string } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const parsed = body as { address?: unknown; message?: unknown } | null;
  const address = parsed?.address;
  if (typeof address !== "string" || address.length === 0)
    return new Response("address is required", { status: 400 });
  const message = parsed?.message;
  if (message !== undefined && typeof message !== "string")
    return new Response("message must be a string", { status: 400 });
  return message === undefined ? { address } : { address, message };
}

export default defineChannel({
  routes: [
    POST("/replica/canary/send", async (request, { from }) => {
      if (!authorized(request))
        return new Response("unauthorized", { status: 401 });
      const parsed = await readAddress(request);
      if (parsed instanceof Response) return parsed;
      if (parsed.message === undefined)
        return new Response("message is required", { status: 400 });
      const session = await from(parsed.address).send(parsed.message, {
        auth: null,
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/replica/canary/reset", async (request, { from, resolveSession }) => {
      if (!authorized(request))
        return new Response("unauthorized", { status: 401 });
      const parsed = await readAddress(request);
      if (parsed instanceof Response) return parsed;
      const result = await from(parsed.address).reset({
        reason: "replica reset canary",
      });
      const active = await resolveSession(parsed.address);
      return Response.json({
        ...result,
        activeSessionAfterReset: active?.id ?? null,
      });
    }),
  ],
  events: {
    // Доставки наружу у канала нет: финальные реплики пишутся в лог, который читает смоук.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы, как в transcript-хуке.
    "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      const message = (data.message ?? "").trim();
      if (!message) return;
      const dir = dataDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, "replica-canary.jsonl"),
        `${JSON.stringify({ sessionId: ctx.session.id, message })}\n`,
        "utf8",
      );
    },
  },
});
