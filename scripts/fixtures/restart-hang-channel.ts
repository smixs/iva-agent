import { defineChannel, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";
import {
  localSessionCompactUrl,
  requestSessionCompact,
} from "#lib/eve-compact.ts";
import { setChatStatus } from "#lib/run-status.ts";
import { chatTakeOverPatch } from "#lib/telegram-turn-start.ts";
import { handleTelegramCompactRequest } from "#lib/telegram-compact-route.ts";
import {
  closeIdleCompactionTurn,
  openIdleCompactionTurn,
  parkIdleCompactionTurn,
  startIdleCompaction,
} from "#lib/idle-compaction.ts";

const MATRIX_FIXTURE = Object.freeze({
  enabledFlag: "1",
  pollMs: 25,
  contextWindowTokens: 131_072,
  chatKey: "1:",
});

// Только матрица обрыва включает эти барьеры. Они останавливают настоящий обработчик
// до/после пересказа; родитель убивает всю группу процесса, не меняя код Ивы/eve.
async function checkpoint(point: string): Promise<void> {
  if (process.env.COMPACT_STEP1_MATRIX !== MATRIX_FIXTURE.enabledFlag) return;
  const dir = process.env.ASSISTANT_DATA_DIR ?? "data";
  appendFileSync(
    join(dir, "restart-hang-events.jsonl"),
    `${JSON.stringify({ point })}\n`,
  );
  const flag = join(dir, "restart-hang-barrier");
  if (!existsSync(flag) || readFileSync(flag, "utf8") !== point) return;
  writeFileSync(join(dir, "restart-hang-blocked"), point);
  while (existsSync(flag)) await setTimeout(MATRIX_FIXTURE.pollMs);
}

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
    POST("/eve/v1/telegram/compact", (request, args) =>
      handleTelegramCompactRequest(
        request,
        args,
        (key, sessionId) =>
          startIdleCompaction({
            sessionId,
            manual: true,
            claimImpl: () => {
              setChatStatus(
                key,
                chatTakeOverPatch({ sessionId, compacting: true }),
              );
              return true;
            },
            requestImpl: (id) =>
              requestSessionCompact({
                url: localSessionCompactUrl(id),
                bearer: process.env.ASSISTANT_BEARER ?? "",
              }),
            releaseImpl: () =>
              setChatStatus(key, { status: "idle", compacting: null }),
          }),
        process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      ),
    ),
  ],
  events: {
    "turn.started"(data, _channel, ctx) {
      if (process.env.COMPACT_STEP1_MATRIX !== MATRIX_FIXTURE.enabledFlag)
        return;
      openIdleCompactionTurn(ctx.session.id);
      setChatStatus(MATRIX_FIXTURE.chatKey, {
        ...chatTakeOverPatch({ sessionId: ctx.session.id }),
        turnId: data.turnId,
      });
    },
    "turn.completed"(_data, _channel, ctx) {
      if (process.env.COMPACT_STEP1_MATRIX !== MATRIX_FIXTURE.enabledFlag)
        return;
      closeIdleCompactionTurn(
        ctx.session.id,
        MATRIX_FIXTURE.contextWindowTokens,
      );
      setChatStatus(MATRIX_FIXTURE.chatKey, {
        status: "idle",
        compacting: null,
      });
    },
    async "compaction.requested"() {
      await checkpoint("before-summary");
    },
    async "compaction.completed"() {
      await checkpoint("after-summary");
    },
    // Свёртка между ходами, как её делает канал Telegram: на парковке занять чат и,
    // не выходя из обработчика, дождаться ответа штатного роута eve. Включается файлом
    // data/compact-on-waiting; исход и время ожидания пишутся в журнал теста.
    async "session.waiting"(_data, _channel, ctx) {
      const dir = process.env.ASSISTANT_DATA_DIR ?? "data";
      if (process.env.COMPACT_STEP1_MATRIX === MATRIX_FIXTURE.enabledFlag) {
        parkIdleCompactionTurn(ctx.session.id);
        await checkpoint("parked");
      }
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
