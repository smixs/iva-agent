type TelegramChatLike = { readonly type?: unknown } | null | undefined;

export function isPrivateTelegramChat(chat: TelegramChatLike): boolean {
  return chat?.type === "private";
}
