import { isHelperTurn } from "../lib/eve-auth.ts";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveTimeZone } from "@iva/timezone";
import { resolveLang } from "../lib/i18n.ts";

// Динамическая инструкция: каждый ход приносит текущие дату/время в часовом поясе
// пользователя user-сообщением в историю. Не в system: system входит в кэшируемый префикс
// запроса, и смена минуты в нём заново записывала бы в кэш весь запрос (#236); строка в
// истории только дописывается. Локаль следует за языком интерфейса (кнопка в /menu
// пишет data/settings.json на лету), поэтому язык пересчитывается КАЖДЫЙ турн, а не
// захватывается на загрузке модуля: resolveLang читает файл без кэша.
const TIMEZONE = resolveTimeZone(process.env.ASSISTANT_TIMEZONE);

function nowMarkdown(): string {
  const lang = resolveLang();
  const locale = lang === "en" ? "en-US" : "ru-RU";
  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  return lang === "en"
    ? `Current user date and time: ${formatted}, timezone ${TIMEZONE}.`
    : `Текущая дата и время пользователя: ${formatted}, часовой пояс ${TIMEZONE}.`;
}

export default defineDynamic({
  events: {
    // turn.started — пересчитывается на каждом турне, чтобы время и локаль не «застывали».
    "turn.started": (_event, ctx) =>
      isHelperTurn(ctx)
        ? null
        : defineInstructions({ content: nowMarkdown(), role: "user" }),
  },
});
