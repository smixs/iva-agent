// Корневой экран /menu: одна rich-карта — заголовок, затем строка с кнопкой на каждый
// раздел. Пояснения к рядам убраны по решению владельца 2026-09-22: экран — только
// заголовок и кнопки. Все кнопки несут либо навигацию (o-верб к под-экрану), либо
// хендофф (mdl/thk), либо закрытие (r:x) — их целиком обрабатывает движок, поэтому on()
// тут пустой.
//
// Правило репо: ни одной module-level const с переведённой строкой — все подписи собираются
// в render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { button, type RichButtonStyle } from "../telegram-buttons.ts";
import { menuStyle } from "../telegram-buttons.ts";

interface RootContext {
  tr: (english: string, russian: string) => string;
}

type RootState = Record<string, unknown>;

export default {
  parent: null,
  render(_state: RootState, ctx: RootContext) {
    const T = ctx.tr;
    const item = (label: string, data: string, style?: RichButtonStyle) =>
      button(label, data, style);
    const text = [
      `# ${T("⚙️ Settings", "⚙️ Настройки")}`,
      item(T("🧠 Model", "🧠 Модель"), "iva_menu:mdl"),
      item(T("🤔 Thinking", "🤔 Размышления"), "iva_menu:thk"),
      item(T("🔍 Search", "🔍 Поиск"), "iva_menu:srch:o"),
      item(T("💬 Rich replies", "💬 Богатые ответы"), "iva_menu:rich:o"),
      item(T("🎤 Voice", "🎤 Голос"), "iva_menu:voice:o"),
      item(T("🌐 Language", "🌐 Язык"), "iva_menu:lang:o"),
      item(T("🎭 Character", "🎭 Характер"), "iva_menu:chr:o"),
      item(T("💾 Memory", "💾 Память"), "iva_menu:core:o"),
      item(T("📡 Userbot", "📡 Userbot"), "iva_menu:ub:o"),
      item(T("🔗 Google", "🔗 Google"), "iva_menu:gws:o"),
      item(T("⏰ Timers", "⏰ Кроны"), "iva_menu:cron:o"),
      item(T("🔔 Notices", "🔔 Уведомления"), "iva_menu:ntc:o"),
      item(T("🧩 Skills", "🧩 Скиллы"), "iva_menu:sk:o"),
      item(T("📊 Status", "📊 Статус"), "iva_menu:st:o"),
      item(T("🔀 New messages", "🔀 Новые сообщения"), "iva_menu:turn:o"),
      item(T("🛠 Maintenance", "🛠 Обслуживание"), "iva_menu:svc:o"),
      // Новое (rich) меню носит внизу выход в старое: кому не зашло, вернётся одним тапом.
      ...(menuStyle() === "rich"
        ? [
            item(
              T("◀︎ Classic menu", "◀︎ Старое меню"),
              "iva_menu:svc:menu:classic",
            ),
          ]
        : []),
      item(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x", "danger"),
    ];
    return { text: text.join("\n\n") };
  },
  on(...args: unknown[]) {
    void args;
  },
};
