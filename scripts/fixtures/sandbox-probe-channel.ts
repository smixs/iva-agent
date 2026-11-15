import { defineChannel, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";

// Тестовый канал для регрессий жизненного цикла sandbox-сессий just-bash.
// /sandbox-probe/send заводит настоящий ход. turn.started открывает sandbox
// через ctx.getSandbox() — тот же путь, по которому сессию создают встроенные
// механизмы eve (sandbox-инструменты, staging вложений) — и пишет маркер,
// только если его ещё нет: переживший рестарт каталог отвечает reattached.
// message.completed перечитывает маркер в конце хода. /telegram/reset
// штатно завершает сессию — её run-владелец уходит в конечное состояние.
const MARKER_PATH = "/workspace/marker.txt";

function authorized(request: Request): boolean {
  const expected = process.env.ASSISTANT_BEARER;
  return Boolean(
    expected &&
    extractBearerToken(request.headers.get("authorization")) === expected,
  );
}

function note(entry: Record<string, unknown>): void {
  const dir = process.env.ASSISTANT_DATA_DIR ?? "data";
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "sandbox-probe.jsonl"), `${JSON.stringify(entry)}\n`);
}

export default defineChannel({
  routes: [
    POST("/sandbox-probe/send", async (request, { from }) => {
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
    async "turn.started"(_data, _channel, ctx) {
      try {
        const sandbox = await ctx.getSandbox();
        let marker: string | null = null;
        try {
          marker = await sandbox.readTextFile({ path: MARKER_PATH });
        } catch {
          marker = null;
        }
        if (marker === null) {
          await sandbox.writeTextFile({
            path: MARKER_PATH,
            content: ctx.session.id,
          });
          note({ event: "opened", sessionId: ctx.session.id, reattached: false });
        } else {
          note({ event: "opened", sessionId: ctx.session.id, reattached: true, marker });
        }
      } catch (error) {
        note({ event: "opened", sessionId: ctx.session.id, error: String(error) });
      }
    },
    async "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      try {
        const sandbox = await ctx.getSandbox();
        let marker: string;
        try {
          marker =
            (await sandbox.readTextFile({ path: MARKER_PATH })) ?? "unreadable";
        } catch (error) {
          marker = `unreadable: ${String(error)}`;
        }
        note({ event: "completed", sessionId: ctx.session.id, marker });
      } catch (error) {
        note({ event: "completed", sessionId: ctx.session.id, error: String(error) });
      }
    },
  },
});
