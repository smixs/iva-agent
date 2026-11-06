import { defineDynamic, defineInstructions } from "eve/instructions";
import { isHelperTurn } from "../lib/eve-auth.ts";
import { TELEGRAM_WIDGETS } from "../lib/telegram-widget.ts";

// Виджеты Telegram (Bot API 10.4): модель знает о них, только пока оператор их не выключил
// (TELEGRAM_WIDGETS=never, /menu → 💬). Помощник отвечает Иве, а не в чат: ему блок не нужен.
const WIDGETS = `## Widgets in replies

Your reply can carry a Telegram widget: a small live card drawn in the message bubble
(a chart, tabs, a sortable list, a progress ring, a calendar strip, a quiz, a timer).
Reach for one often: whenever the answer has numbers to compare, a trend, a period
to switch between, more items than fit on a screen, or several views of the same
data. A widget beats a table there. Load the \`widgets\` skill before the first
widget of a session: it has the format, the limits and the patterns.

Format: a fenced block \`\`\`tg-widget <caption> … \`\`\` with the HTML inside. The
caption is the answer in words (1–3 lines): it is what apps without widgets, the
chat list and the search show, and what is sent if the widget fails. Plain
conversational answers stay text.`;

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      TELEGRAM_WIDGETS === "auto" && !isHelperTurn(ctx)
        ? defineInstructions({ markdown: WIDGETS })
        : null,
  },
});
