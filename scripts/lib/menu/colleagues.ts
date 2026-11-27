// Экран «🤝 Коллеги» (/menu → 🔗 Подключения → 🤝 Коллеги).
// Включает и выключает опцию коллег в data/settings.json (ключ `colleagues.enabled`,
// по умолчанию выключена, ADR-0030). Изменение действует сразу: мост и канал читают
// settings.json без перезапуска.
//
// Кнопки несут целевое значение (1/0), а не «переключи»: повторный тап по протухшему
// меню приводит к тому же состоянию. Правило репо: все подписи собираются в render().
import { join } from "node:path";
import {
  COLLEAGUE_ROLE_SPECS,
  parseColleaguesConfig,
  withColleaguesEnabled,
  type ColleagueEntry,
} from "#lib/colleagues.ts";
import { readSettings, updateSettings } from "#lib/settings.ts";
import {
  button,
  buttonRow,
  escapeRichText,
  menuBackLine,
} from "../telegram-buttons.ts";

const SID = "col";
const PARENT = "gcon";

type MenuState = { page?: number };
type MenuContext = {
  deps?: { dataDir?: string };
  tr: (english: string, russian: string) => string;
  getLang?: () => string;
  show: (state: MenuState, screen: string) => Promise<void>;
};

function settingsPath(ctx: MenuContext): string | undefined {
  const dir = ctx.deps?.dataDir;
  return typeof dir === "string" && dir.length > 0
    ? join(dir, "settings.json")
    : undefined;
}

function colleagueLine(entry: ColleagueEntry, ctx: MenuContext): string {
  const spec = COLLEAGUE_ROLE_SPECS[entry.role];
  const roleLabel = ctx.tr(spec.labelEn, spec.labelRu);
  const name = escapeRichText(entry.name ?? roleLabel);
  const providerModel = escapeRichText(`${entry.provider}/${entry.model}`);
  return `• ${name} (${escapeRichText(roleLabel)}) — ${providerModel}`;
}

export default {
  parent: PARENT,

  render(_state: MenuState, ctx: MenuContext) {
    const T = ctx.tr;
    const config = parseColleaguesConfig(
      readSettings(settingsPath(ctx)),
      () => {},
    );
    const entries = Object.values(config.items);
    const on = config.enabled;
    const status = on
      ? entries.length === 0
        ? T(
            "Colleagues: on. No colleagues added yet.",
            "Коллеги: вкл. Коллеги пока не добавлены.",
          )
        : [
            T("Colleagues: on.", "Коллеги: вкл."),
            ...entries.map((entry) => colleagueLine(entry, ctx)),
          ].join("\n")
      : [
          T(
            "Colleagues: off (default). Separate Telegram bots with roles and their own models.",
            "Коллеги: выкл (по умолчанию). Отдельные боты Telegram с ролями и своими моделями.",
          ),
          ...(entries.length > 0
            ? [
                T(
                  `Configured: ${entries.length} (paused while off).`,
                  `Настроено: ${entries.length} (на паузе, пока выключено).`,
                ),
              ]
            : []),
        ].join("\n");

    const text = [
      `# ${T("🤝 Colleagues", "🤝 Коллеги")}`,
      status,
      buttonRow([
        button(`${on ? "✓" : "○"} ${T("On", "Вкл")}`, `iva_menu:${SID}:set:1`),
        button(
          `${on ? "○" : "✓"} ${T("Off", "Выкл")}`,
          `iva_menu:${SID}:set:0`,
        ),
      ]),
      menuBackLine(ctx, PARENT),
    ].join("\n\n");
    return { text };
  },

  async on(
    verb: string,
    args: string[],
    state: MenuState,
    ctx: MenuContext,
  ): Promise<void> {
    if (verb !== "set" || args.length !== 1) return;
    if (args[0] !== "0" && args[0] !== "1") return;
    const enabled = args[0] === "1";
    updateSettings(
      (current) => withColleaguesEnabled(current, enabled),
      settingsPath(ctx),
    );
    await ctx.show(state, SID);
  },
};
