// Точка входа дневного сторожа: `node --env-file-if-exists=.env scripts/jobs/watchdog.ts`.
// Запускает её расписание agent/schedules/jobs-watchdog.ts раз в сутки. Сообщение
// отправляет код (не агент): сторож существует ровно для случая, когда агент не отвечает.
import { dataDir } from "#lib/data-dir.ts";
import { runJobWatchdog } from "../lib/job-watchdog.ts";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { appendDaily } from "../../agent/lib/vault-daily.ts";
import { redactNotice } from "../../agent/lib/outbox.ts";

async function main(): Promise<void> {
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(process.env);
  await runJobWatchdog({
    dataDir: dataDir(),
    tr: await noticeTranslator(process.env),
    send: async (text) => {
      if (!token || !chat)
        throw new Error(
          "TELEGRAM_BOT_TOKEN or the owner chat is missing — run: iva doctor",
        );
      const result = await sendTelegramHtml(token, chat, text);
      if (result.ok) {
        try {
          appendDaily("[assistant:jobs-watchdog]", redactNotice(text));
        } catch (error) {
          // The message already reached Telegram: preserve the send result so
          // a diary failure cannot trigger another watchdog notification.
          console.error("watchdog: could not write the daily entry", error);
        }
      }
      return result.ok;
    },
  });
}

main().catch((error: unknown) => {
  console.error(
    `watchdog: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
