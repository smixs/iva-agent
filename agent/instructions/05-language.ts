import { defineDynamic, defineInstructions } from "eve/instructions";
import { resolveLang } from "../lib/i18n.ts";

// Язык ответов агента следует за настройкой интерфейса в /menu: кнопка пишет
// data/settings.json на лету, поэтому язык модели пересчитывается КАЖДЫЙ турн, а не
// захватывается на загрузке модуля (иначе замёрзнет до рестарта): resolveLang читает
// файл без кэша, в отличие от getLang. Персона в instructions.md остаётся
// языково-нейтральной — это по-прежнему единственный источник правды о языке вывода.

function languageMarkdown(): string {
  const rule =
    resolveLang() === "en"
      ? "Reply in English by default. If the user writes to you in another language, match theirs."
      : "Отвечай по-русски по умолчанию. Если пользователь пишет на другом языке — подстройся под него.";
  return `## Язык / Language\n${rule}`;
}

export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы смена языка в /menu применялась
    // со следующего сообщения без рестарта.
    "turn.started": () => defineInstructions({ markdown: languageMarkdown() }),
  },
});
