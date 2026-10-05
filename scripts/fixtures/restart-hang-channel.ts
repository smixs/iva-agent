import { defineChannel, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "#lib/eve-compact.ts";
import { setChatStatus } from "#lib/run-status.ts";
import { chatTakeOverPatch } from "#lib/telegram-turn-start.ts";

function authorized(request: Request): boolean {
  const expected = process.env.ASSISTANT_BEARER;
  return Boolean(
    expected &&
    extractBearerToken(request.headers.get("authorization")) === expected,
  );
}

export default defineChannel({
  routes: [
    POST("/restart-hang/send", async (request, { from }) => {
      if (!authorized(request))
        return new Response("unauthorized", { status: 401 });
      const body = (await request.json()) as {
        address?: unknown;
        message?: unknown;
      };
      if (typeof body.address !== "string" || typeof body.message !== "string")
        return new Response("invalid body", { status: 400 });
      const session = await from(body.address).send(body.message, {
        auth: null,
      });
      return Response.json({ sessionId: session.id });
    }),
    POST("/eve/v1/telegram/reset", (request, args) =>
      handleTelegramResetRequest(
        request,
        args,
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      ),
    ),
  ],
  events: {
    // Свёртка между ходами, как её делает канал Telegram: на парковке занять чат и,
    // не выходя из обработчика, дождаться ответа штатного роута eve. Включается файлом
    // data/compact-on-waiting; исход и время ожидания пишутся в журнал теста.
    async "session.waiting"(_data, _channel, ctx) {
      const dir = process.env.ASSISTANT_DATA_DIR ?? "data";
      const flag = join(dir, "compact-on-waiting");
      if (!existsSync(flag)) return;
      rmSync(flag);
      setChatStatus(
        "1:",
        chatTakeOverPatch({ sessionId: ctx.session.id, compacting: true }),
      );
      const startedAt = Date.now();
      let outcome: string;
      try {
        outcome = String(
          await requestSessionCompact({
            url: localSessionCompactUrl(ctx.session.id),
            bearer: process.env.ASSISTANT_BEARER ?? "",
          }),
        );
      } catch (error) {
        outcome = `threw: ${String(error)}`;
      }
      appendFileSync(
        join(dir, "restart-hang-compact.jsonl"),
        `${JSON.stringify({ outcome, ms: Date.now() - startedAt })}\n`,
      );
    },
    "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      const message = (data.message ?? "").trim();
      if (!message) return;
      const dir = process.env.ASSISTANT_DATA_DIR ?? "data";
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, "restart-hang-replies.jsonl"),
        `${JSON.stringify({ sessionId: ctx.session.id, message })}\n`,
      );
    },
  },
});
