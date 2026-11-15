import { restartFailure } from "../systemd-control.ts";
// Экран «Богатые ответы» (/menu → 💬): тумблеры TELEGRAM_RICH_REPLIES и TELEGRAM_WIDGETS
// (виджеты Bot API 10.4 в пузыре, agent/lib/telegram-widget.ts).
// auto (дефолт) шлёт ответ с таблицей, чек-листом, свёрткой или формулой богатым сообщением
// Telegram, never держит такие ответы обычным текстом. Константу агент вычисляет при импорте
// (agent/lib/telegram-rich-replies.ts), поэтому новое значение ждёт перезапуска iva.service —
// предлагаем его сразу, как на экране поиска.
import { readEnvValues, upsertEnv } from "../env-file.ts";
import {
  button,
  buttonRow,
  escapeRichText,
  menuBackLine,
} from "../telegram-buttons.ts";

const SID = "rich";
const PARENT = "r";
const VAR = "TELEGRAM_RICH_REPLIES";
const WIDGETS = "TELEGRAM_WIDGETS";

type Mode = "auto" | "never";
type MenuState = { awaitText: unknown };
type MenuContext = {
  deps: {
    envPath: string;
    sc: (action: string, unit: string) => Promise<boolean>;
  };
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
    end: (state: MenuState, text: string) => Promise<void>;
  };
};

// Значение .env так, как его поймёт агент: пусто и auto — авто, never — обычный текст. Любое
// другое значение агент не примет вовсе (richRepliesMode бросает при импорте): показываем его
// как есть, чтобы причина отказа лежала в меню, а не искалась в журнале.
function configured(
  env: Record<string, string | undefined>,
  name: string = VAR,
): Mode | { raw: string } {
  const raw = (env[name] ?? "").trim();
  if (raw === "" || raw === "auto") return "auto";
  if (raw === "never") return "never";
  return { raw };
}

// Экран «режим записан — применить перезапуском?»: обе строки одинаково правят .env, а
// значение читает процесс агента, который стартует заново.
async function restartOffer(
  st: MenuState,
  ctx: MenuContext,
  mode: Mode,
  name: string = VAR,
) {
  const label =
    name === WIDGETS
      ? mode === "auto"
        ? ctx.tr("widgets on", "виджеты включены")
        : ctx.tr("widgets off", "виджеты выключены")
      : mode === "auto"
        ? ctx.tr("rich messages", "богатые сообщения")
        : ctx.tr("plain text", "обычный текст");
  const text = [
    `# ${ctx.tr("💬 Rich replies", "💬 Богатые ответы")}`,
    ctx.tr(
      `Reply mode: ${label}. It applies after an agent restart (the value is read as the agent starts).`,
      `Режим ответов: ${label}. Применится после перезапуска агента (значение читается при старте).`,
    ),
    buttonRow([
      button(
        ctx.tr("Restart now", "Перезапустить сейчас"),
        `iva_menu:${SID}:rs:now`,
      ),
      button(ctx.tr("Later", "Позже"), `iva_menu:${SID}:rs:later`),
    ]),
    menuBackLine(ctx, PARENT),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

export default {
  parent: PARENT,

  async render(st: MenuState, ctx: MenuContext) {
    st.awaitText = null; // возврат на экран снимает любой ждущий ввод этого меню
    const env = await readEnvValues(ctx.deps.envPath);
    const current = configured(env);
    const invalid = typeof current === "string" ? null : current.raw;
    const mode = typeof current === "string" ? current : null;
    const mark = (value: Mode) => (mode === value ? " ✓" : "");
    const widgets = configured(env, WIDGETS);
    const widgetsInvalid = typeof widgets === "string" ? null : widgets.raw;
    const widgetsMark = (value: Mode) => (widgets === value ? " ✓" : "");
    const text = [
      `# ${ctx.tr("💬 Rich replies", "💬 Богатые ответы")}`,
      ctx.tr(
        "Tables, task lists, folds, formulas and pictures go as a Telegram rich message. Buttons work either way: a reply with a button is always sent rich.",
        "Таблицы, чек-листы, свёртки, формулы и картинки уходят богатым сообщением Telegram. Кнопки работают в любом режиме: ответ с кнопкой всегда уходит богатым.",
      ),
      ...(invalid === null
        ? []
        : [
            ctx.tr(
              `⚠️ .env holds ${VAR}=${escapeRichText(invalid)} — Iva won't start on that value. Pick one of the two below.`,
              `⚠️ В .env стоит ${VAR}=${escapeRichText(invalid)} — с таким значением Ива не стартует. Выбери один из двух.`,
            ),
          ]),
      buttonRow([
        button(
          `${ctx.tr("Auto", "Авто")}${mark("auto")}`,
          `iva_menu:${SID}:set:auto`,
        ),
        button(
          `${ctx.tr("Plain text", "Только обычные")}${mark("never")}`,
          `iva_menu:${SID}:set:never`,
        ),
      ]),
      ctx.tr(
        "Widgets: Iva draws a live card right in the message: a chart, tabs, a list you can sort. Telegram apps without widgets show its caption.",
        "Виджеты: Ива рисует живую карточку прямо в сообщении: график, вкладки, список с сортировкой. Приложения Telegram без виджетов показывают её подпись.",
      ),
      ...(widgetsInvalid === null
        ? []
        : [
            ctx.tr(
              `⚠️ .env holds ${WIDGETS}=${escapeRichText(widgetsInvalid)} — Iva won't start on that value. Pick one of the two below.`,
              `⚠️ В .env стоит ${WIDGETS}=${escapeRichText(widgetsInvalid)} — с таким значением Ива не стартует. Выбери один из двух.`,
            ),
          ]),
      buttonRow([
        button(
          `${ctx.tr("Widgets on", "Виджеты вкл")}${widgetsMark("auto")}`,
          `iva_menu:${SID}:w:auto`,
        ),
        button(
          `${ctx.tr("Widgets off", "Виджеты выкл")}${widgetsMark("never")}`,
          `iva_menu:${SID}:w:never`,
        ),
      ]),
      menuBackLine(ctx, PARENT),
    ].join("\n\n");
    return { text };
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb === "set") {
      const value = args[0];
      if (value !== "auto" && value !== "never") return ctx.show(st, SID);
      await upsertEnv(ctx.deps.envPath, { [VAR]: value });
      return restartOffer(st, ctx, value);
    }
    if (verb === "w") {
      const value = args[0];
      if (value !== "auto" && value !== "never") return ctx.show(st, SID);
      await upsertEnv(ctx.deps.envPath, { [WIDGETS]: value });
      return restartOffer(st, ctx, value, WIDGETS);
    }
    if (verb === "rs") {
      if (args[0] === "now") {
        // plain restart — не restartAgent(): смена настройки не «сброс», диалоги живут.
        const ok = await ctx.deps.sc("restart", "iva.service");
        return ctx.flows.end(
          st,
          ok
            ? ctx.tr(
                "♻️ Restarting the agent — the new reply mode is live in ~30s.",
                "♻️ Перезапускаю агента — новый режим ответов активен через ~30 сек.",
              )
            : ctx.tr(
                restartFailure(
                  "⚠️ Couldn't restart (systemctl). Check the service on the server.",
                ),
                restartFailure(
                  "⚠️ Не удалось перезапустить (systemctl). Проверь сервис на сервере.",
                ),
              ),
        );
      }
      return ctx.flows.end(
        st,
        ctx.tr(
          "Saved. It'll apply on the next restart (/restart).",
          "Сохранил. Применится после перезапуска (/restart).",
        ),
      );
    }
    return ctx.show(st, SID);
  },
};
