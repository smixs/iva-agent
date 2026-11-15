// Один дом для authored-дерева и операционных скриптов: обе половины установки обязаны
// выбрать один и тот же чат.
// Адресаты сообщений Ивы без хода пользователя.
//   notificationChat — Report и предложения обновлений: TELEGRAM_DIGEST_CHAT_ID, иначе владелец.
//   ownerChat — личный чат владельца (первый id Allowlist): Watch, Brief, Signal, провал задания с кнопкой
//   «Починить». Туда идёт почта и переписка, а тап кнопки принимается только в личном чате.
export function notificationChat(
  env: Record<string, string | undefined> = process.env,
): string {
  const digest = String(env.TELEGRAM_DIGEST_CHAT_ID ?? "").trim();
  return digest || ownerChat(env);
}

export function ownerChat(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    String(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .find(Boolean) ?? ""
  );
}
