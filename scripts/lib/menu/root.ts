// Корневой экран /menu: шесть разделов (решение владельца 26.11.2026) — Модель, Общение,
// Память, Подключения, Расписание, Система — плюс закрытие. Все прежние 16 пунктов, новый
// переключатель «Коллеги» и переключение старого/нового меню разложены внутри этих шести
// разделов (scripts/lib/menu/groups.ts). Пояснения к рядам убраны (2026-09-22).
//
// Правило репо: ни одной module-level const с переведённой строкой — все подписи собираются
// в render() через ctx.tr, иначе язык замёрзнет до рестарта.
import { button, type RichButtonStyle } from "../telegram-buttons.ts";

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
      item(T("🧠 Model", "🧠 Модель"), "iva_menu:gm:o"),
      item(T("💬 Chat", "💬 Общение"), "iva_menu:gc:o"),
      item(T("💾 Memory", "💾 Память"), "iva_menu:gmem:o"),
      item(T("🔗 Connections", "🔗 Подключения"), "iva_menu:gcon:o"),
      item(T("⏰ Schedule", "⏰ Расписание"), "iva_menu:gsch:o"),
      item(T("🛠 System", "🛠 Система"), "iva_menu:gsys:o"),
      item(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x", "danger"),
    ];
    return { text: text.join("\n\n") };
  },
  on(...args: unknown[]) {
    void args;
  },
};
