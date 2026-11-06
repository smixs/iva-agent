// Stateless transport for the agent dispatcher. It never reads or writes Alert state.
import { ownerChat } from "./lib/notification-chat.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { isEntrypoint } from "./lib/version-layout.ts";

export async function sendModelAuthAlert(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const chat = ownerChat(env);
  if (text === "" || token === "" || chat === "") return false;
  return (
    await sendTelegramHtml(token, chat, text, {
      trace: { source: "model-auth" },
    })
  ).ok;
}
if (isEntrypoint(import.meta.url))
  process.exitCode = (await sendModelAuthAlert(process.argv[2] ?? "")) ? 0 : 1;
