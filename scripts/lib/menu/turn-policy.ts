// Экран обработки новых сообщений. Настройка читается каналом перед каждой отправкой,
// поэтому переключение действует сразу и не требует рестарта.
import { readSettings, writeSettings } from "#lib/settings.ts";
import { button, buttonRow, menuBackLine } from "../telegram-buttons.ts";

const PARENT = "gm";

type TurnPolicy = "queue" | "steer";
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
};

function currentPolicy(): TurnPolicy {
  return readSettings().turnPolicy === "steer" ? "steer" : "queue";
}

function isTurnPolicy(value: unknown): value is TurnPolicy {
  return value === "queue" || value === "steer";
}

export default {
  parent: PARENT,
  render(_state: MenuState, ctx: MenuContext) {
    const current = currentPolicy();
    const T = ctx.tr;
    const option = (value: TurnPolicy, english: string, russian: string) =>
      button(
        `${current === value ? "✓" : "○"} ${T(english, russian)}`,
        `iva_menu:turn:set:${value}`,
      );
    const text = [
      `# ${T("🔀 New messages", "🔀 Новые сообщения")}`,
      buttonRow([
        option("queue", "Queue", "Очередь"),
        option("steer", "Interrupt", "Перебивать"),
      ]),
      menuBackLine(ctx, PARENT),
    ];
    return { text: text.join("\n\n") };
  },
  async on(
    verb: string,
    args: string[],
    state: MenuState,
    ctx: MenuContext,
  ): Promise<void> {
    if (verb !== "set" || args.length !== 1 || !isTurnPolicy(args[0])) return;
    writeSettings({ turnPolicy: args[0] });
    await ctx.show(state, "turn");
  },
};
