import { defineDynamic, defineInstructions } from "eve/instructions";
import { isHelperTurn } from "../lib/eve-auth.ts";
import { TELEGRAM_WIDGETS, widgetsRefused } from "../lib/telegram-widget.ts";

// Виджеты Telegram (Bot API 10.4): модель знает о них, только пока оператор их не выключил
// (TELEGRAM_WIDGETS=never, /menu → 💬). Помощник отвечает Иве, а не в чат: ему блок не нужен.
const WIDGETS = `## Widgets in replies

Your reply can carry a Telegram widget: a small live card drawn in the message bubble.
The rule: whatever can be shown as a widget is shown as a widget, in every task, the
scheduled ones included (Brief, Watch, a fired Reminder, a goal check). Where you used
to write lines of text or a table, draw the card:

- a calendar or a schedule: the day as a timeline, the week as a strip of days, the
  month as a grid;
- the weather: a card with now, the day's range and the hours ahead;
- a wait (a helper at work, a Reminder just set, a deadline, a delivery, a goal's next
  check): a live countdown to the moment;
- tasks, Reminders, unread mail and chats, any list of things: a grouped list or a
  tappable checklist;
- numbers, money, health, progress toward a goal, a comparison, a plan with steps,
  a status of several things: a chart, bars, a ring, a stepper.

Words alone are for talk: a conversation, an opinion, a question to the owner, an
explanation, a confirmation in one sentence. In a reply that has both, the words say
what the widget cannot and the widget carries the data.

Load the \`widgets\` skill before the first widget of a session: it has the format,
the limits and ready patterns for the calendar, the weather and the countdown.

Format: a fenced block \`\`\`tg-widget <caption> … \`\`\` with the HTML inside. The
caption is the same answer in words on one line: it is what apps without widgets, the
chat list and the search show, and what is sent if the widget fails.`;

// Telegram отказал в виджетах на своей стороне (telegram-widget.ts, widgetsRefused): сутки
// модель знает, что блок не дойдёт, и отдаёт то же содержимое текстом.
const WIDGETS_REFUSED = `## Widgets are off right now

Telegram is refusing widgets on its side, so a \`tg-widget\` block reaches the owner as
its one-line caption and the data in it is lost. Until this section is gone, write no
\`tg-widget\` block in any task, the scheduled ones included, even where a skill or the
task text asks for a widget or a card. Give the same content as text in the reply: the
list, the numbers, the links. Do not report this to the owner unless asked.`;

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (TELEGRAM_WIDGETS !== "auto" || isHelperTurn(ctx)) return null;
      return defineInstructions({
        markdown: widgetsRefused() ? WIDGETS_REFUSED : WIDGETS,
      });
    },
  },
});
