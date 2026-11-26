// Экраны шести разделов стартового меню /menu (решение владельца 26.11.2026):
// 🧠 Модель, 💬 Общение, 💾 Память, 🔗 Подключения, ⏰ Расписание, 🛠 Система.
// Каждый раздел собирает свои кнопки в render() через ctx.tr (правило репо: ни одной
// module-level const с переведённой строкой) и ведёт обратно в корень через «‹ Меню».
import {
  button,
  menuBackLine,
  menuStyle,
  type RichButtonStyle,
} from "../telegram-buttons.ts";

interface GroupContext {
  tr: (english: string, russian: string) => string;
}

type GroupState = Record<string, unknown>;

interface GroupItem {
  readonly en: string;
  readonly ru: string;
  readonly data: string;
  readonly style?: RichButtonStyle;
}

interface GroupScreen {
  readonly parent: "r";
  render(state: GroupState, ctx: GroupContext): { text: string };
  on(...args: unknown[]): void;
}

function makeGroup(
  titleEn: string,
  titleRu: string,
  items: (ctx: GroupContext) => readonly GroupItem[],
): GroupScreen {
  return {
    parent: "r",
    render(_state: GroupState, ctx: GroupContext) {
      const T = ctx.tr;
      const lines = [
        `# ${T(titleEn, titleRu)}`,
        ...items(ctx).map((entry) =>
          button(T(entry.en, entry.ru), entry.data, entry.style),
        ),
        menuBackLine(ctx, "r"),
      ];
      return { text: lines.join("\n\n") };
    },
    on(...args: unknown[]) {
      void args;
    },
  };
}

/** 🧠 Модель: модель, размышления, поиск, новые сообщения. */
export const modelGroup = makeGroup("🧠 Model", "🧠 Модель", () => [
  { en: "🧠 Model", ru: "🧠 Модель", data: "iva_menu:mdl" },
  { en: "🤔 Thinking", ru: "🤔 Размышления", data: "iva_menu:thk" },
  { en: "🔍 Search", ru: "🔍 Поиск", data: "iva_menu:srch:o" },
  { en: "🔀 New messages", ru: "🔀 Новые сообщения", data: "iva_menu:turn:o" },
]);

/** 💬 Общение: богатые ответы, голос, язык, характер. */
export const chatGroup = makeGroup("💬 Chat", "💬 Общение", () => [
  { en: "💬 Rich replies", ru: "💬 Богатые ответы", data: "iva_menu:rich:o" },
  { en: "🎤 Voice", ru: "🎤 Голос", data: "iva_menu:voice:o" },
  { en: "🌐 Language", ru: "🌐 Язык", data: "iva_menu:lang:o" },
  { en: "🎭 Character", ru: "🎭 Характер", data: "iva_menu:chr:o" },
]);

/** 💾 Память: память, скиллы. */
export const memoryGroup = makeGroup("💾 Memory", "💾 Память", () => [
  { en: "💾 Memory", ru: "💾 Память", data: "iva_menu:core:o" },
  { en: "🧩 Skills", ru: "🧩 Скиллы", data: "iva_menu:sk:o" },
]);

/** 🔗 Подключения: Google, Userbot, 🤝 Коллеги. */
export const connectionsGroup = makeGroup(
  "🔗 Connections",
  "🔗 Подключения",
  () => [
    { en: "🔗 Google", ru: "🔗 Google", data: "iva_menu:gws:o" },
    { en: "📡 Userbot", ru: "📡 Userbot", data: "iva_menu:ub:o" },
    { en: "🤝 Colleagues", ru: "🤝 Коллеги", data: "iva_menu:col:o" },
  ],
);

/** ⏰ Расписание: кроны, уведомления. */
export const scheduleGroup = makeGroup("⏰ Schedule", "⏰ Расписание", () => [
  { en: "⏰ Timers", ru: "⏰ Кроны", data: "iva_menu:cron:o" },
  { en: "🔔 Notices", ru: "🔔 Уведомления", data: "iva_menu:ntc:o" },
]);

/** 🛠 Система: статус, обслуживание, старое/новое меню. */
export const systemGroup = makeGroup("🛠 System", "🛠 Система", () => [
  { en: "📊 Status", ru: "📊 Статус", data: "iva_menu:st:o" },
  { en: "🛠 Maintenance", ru: "🛠 Обслуживание", data: "iva_menu:svc:o" },
  menuStyle() === "rich"
    ? {
        en: "◀︎ Classic menu",
        ru: "◀︎ Старое меню",
        data: "iva_menu:svc:menu:classic",
      }
    : {
        en: "✨ New menu",
        ru: "✨ Новое меню",
        data: "iva_menu:svc:menu:rich",
        style: "success",
      },
]);
