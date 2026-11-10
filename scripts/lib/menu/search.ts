import { restartFailure } from "../systemd-control.ts";
// Экран «Поиск» меню (/menu → 🔍). Выбор веб-провайдера + приём/смена API-ключа.
//
// Инварианты ключей (как у /model-визарда poller/wizards.ts): значение ключа
// НИКОГДА не попадает в лог/eve/текст ошибки. Удаление сообщения с ключом делает САМ
// движок (index.ts onText, secret:true) ДО вызова texts.apikey — здесь не дублируем.
// Секретный приём разрешаем только в личке (проверка при установке awaitText — обязанность
// экрана). Смена SEARCH_PROVIDER применяется инструментом лишь после рестарта iva.service
// (web_search.ts читает process.env), поэтому после записи предлагаем restart-offer —
// plain sc("restart","iva.service"), НИКОГДА restartAgent (диалоги в .workflow-data живы).

import { readEnvValues, upsertEnv } from "../env-file.ts";
import { SEARCH_CATALOG, checkSearchKey } from "../search-catalog.ts";
import { button, buttonRow } from "../telegram-buttons.ts";

const SID = "srch";
const PARENT = "r";
const DEFAULT_PROVIDER = "tavily"; // web_search.ts: провайдер по умолчанию, когда SEARCH_PROVIDER пуст

type Provider = keyof typeof SEARCH_CATALOG;
type AwaitText = {
  kind: string;
  secret: boolean;
  data: Record<string, string>;
};
type MenuState = { chatId: number; awaitText: AwaitText | null };
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

function backLine(ctx: MenuContext): string {
  return `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;
}

function cancelLine(ctx: MenuContext): string {
  return `${button(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`, "danger")} — ${ctx.tr(
    "leave the prompt without entering a key.",
    "выйти из ввода, ничего не меняя.",
  )}`;
}

// Telegram: id личных чатов положительны, групп/супергрупп — отрицательны. Секреты
// принимаем только в личке (в группе бот может не иметь прав на удаление, и ключ увидят
// посторонние). st не хранит chat.type, поэтому опираемся на знак chatId — надёжно.
const isPrivate = (st: MenuState) => Number(st.chatId) > 0;

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && Object.hasOwn(SEARCH_CATALOG, value);
}

// Текущий провайдер из .env (свежим чтением — снимок процесса устаревает после upsertEnv).
function currentProvider(env: Record<string, string>): Provider {
  const p = env.SEARCH_PROVIDER;
  return isProvider(p) ? p : DEFAULT_PROVIDER;
}

// Экран-приглашение ввести ключ: ставит awaitText (перехват следующего текста движком)
// и показывает, где взять ключ. secret:true — приём только в личке (иначе отказ).
async function promptKey(st: MenuState, ctx: MenuContext, provider: Provider) {
  const cat = SEARCH_CATALOG[provider];
  if (!cat) return ctx.show(st, SID);
  if (!isPrivate(st)) {
    st.awaitText = null;
    return ctx.flows.screen(
      st,
      `${ctx.tr(
        "API keys are secrets — open a private chat with me and set the search key there.",
        "Ключи — это секрет. Открой личный чат со мной и введи ключ поиска там.",
      )}\n\n${backLine(ctx)}`,
    );
  }
  st.awaitText = {
    kind: "apikey",
    secret: true,
    data: { provider, keyVar: cat.keyVar, returnScreen: SID },
  };
  const text = [
    `# ${ctx.tr(`${cat.label} search key`, `Ключ поиска ${cat.label}`)}`,
    ctx.tr(
      "Send it in the next message — I'll delete it from the chat right away.",
      "Пришли его следующим сообщением — я сразу удалю его из чата.",
    ),
    ctx.tr(`Get your key at ${cat.url}`, `Ключ можно получить на ${cat.url}`),
    cancelLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

// Экран «провайдер выбран — применить рестартом?»: после записи SEARCH_PROVIDER.
async function restartOffer(
  st: MenuState,
  ctx: MenuContext,
  provider: Provider,
) {
  const cat = SEARCH_CATALOG[provider];
  const label = cat ? cat.label : provider;
  const text = [
    `# ${ctx.tr("🔍 Web search", "🔍 Веб-поиск")}`,
    ctx.tr(
      `Search provider set: ${label}. It applies after an agent restart (the search tool reads it at startup).`,
      `Провайдер поиска: ${label}. Применится после перезапуска агента (инструмент поиска читает провайдера при старте).`,
    ),
    buttonRow([
      button(
        ctx.tr("Restart now", "Перезапустить сейчас"),
        `iva_menu:${SID}:rs:now`,
      ),
      button(ctx.tr("Later", "Позже"), `iva_menu:${SID}:rs:later`),
    ]),
    backLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

export default {
  parent: PARENT,

  // Список провайдеров: ✓ у текущего, 🔑 при наличии ключа (только булевы — значения ключей
  // наружу не выводим). Свежее чтение .env на каждый рендер — состояние всегда актуально.
  async render(st: MenuState, ctx: MenuContext): Promise<{ text: string }> {
    st.awaitText = null; // возврат на список снимает возможный ждущий ввод ключа
    const env = await readEnvValues(ctx.deps.envPath);
    const current = currentProvider(env);
    const text = [
      `# ${ctx.tr("🔍 Web search", "🔍 Веб-поиск")}`,
      ctx.tr(
        "Pick a provider. ✓ — current, 🔑 — its key is set. Tapping a provider without a key asks for one.",
        "Выбери провайдера. ✓ — текущий, 🔑 — ключ задан. Тап по провайдеру без ключа попросит его ввести.",
      ),
      ...Object.entries(SEARCH_CATALOG).map(([id, cat]) => {
        const mark = id === current ? "✓ " : "";
        const keyBadge = env[cat.keyVar] ? " 🔑" : "";
        const host = cat.url.replace(/^https?:\/\//, "");
        return `${button(`${mark}${cat.label}${keyBadge}`, `iva_menu:${SID}:set:${id}`)} — ${ctx.tr(
          `search via ${cat.label}; key at ${host}.`,
          `искать через ${cat.label}; ключ на ${host}.`,
        )}`;
      }),
      // Сменить ключ текущего провайдера (даже если он уже есть).
      `${button(ctx.tr("🔁 Change key", "🔁 Сменить ключ"), `iva_menu:${SID}:key:${current}`)} — ${ctx.tr(
        "enter a new key for the current provider.",
        "ввести новый ключ текущего провайдера.",
      )}`,
      backLine(ctx),
    ].join("\n\n");
    return { text };
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb === "set") {
      const provider = args[0];
      if (!isProvider(provider)) return ctx.show(st, SID);
      const cat = SEARCH_CATALOG[provider];
      const env = await readEnvValues(ctx.deps.envPath);
      if (!env[cat.keyVar]) return promptKey(st, ctx, provider); // нет ключа → приём
      await upsertEnv(ctx.deps.envPath, { SEARCH_PROVIDER: provider }); // ключ есть → просто переключаем
      return restartOffer(st, ctx, provider);
    }
    if (verb === "key") {
      // «Сменить ключ» — приём ключа для указанного провайдера независимо от наличия.
      const provider = isProvider(args[0])
        ? args[0]
        : currentProvider(await readEnvValues(ctx.deps.envPath));
      return promptKey(st, ctx, provider);
    }
    if (verb === "rs") {
      if (args[0] === "now") {
        // plain restart — не restartAgent(): смена конфигурации не «сброс», диалоги живут.
        const ok = await ctx.deps.sc("restart", "iva.service");
        return ctx.flows.end(
          st,
          ok
            ? ctx.tr(
                "♻️ Restarting the agent — the new provider is live in ~30s.",
                "♻️ Перезапускаю агента — новый провайдер активен через ~30 сек.",
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
      // later
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

  texts: {
    // Приём API-ключа поиска. Сообщение уже удалено движком (secret:true) до этого вызова.
    // Значение ключа не пишется в лог/reply/eve ни при каком исходе.
    async apikey(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const key = String(text).trim();
      const data = st.awaitText?.data ?? {};
      const provider = data.provider;
      // Не похоже на ключ (пробелы/слишком коротко) — обычный текст, набранный при ждущем
      // приглашении. Не храним, снимаем ожидание, чтобы чат снова работал.
      if (!/^\S{8,}$/.test(key) || !isProvider(provider)) {
        st.awaitText = null;
        return ctx.flows.end(
          st,
          ctx.tr(
            "That doesn't look like a key — the prompt is cleared, I deleted the message just in case.",
            "Это не похоже на ключ — ожидание снято, сообщение удалил на всякий случай.",
          ),
        );
      }
      const cat = SEARCH_CATALOG[provider];
      const err = await checkSearchKey(provider, key);
      if (err) {
        // Причина отказа не содержит значения ключа (см. checkSearchKey) — печатать безопасно.
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            `Key rejected (${err}). Send another key or go back.`,
            `Ключ не принят (${err}). Пришли другой ключ или вернись назад.`,
          )}\n\n${cancelLine(ctx)}`,
        );
      }
      st.awaitText = null;
      // Пишем ключ и провайдера вместе — переключение и ключ атомарны для юзера.
      await upsertEnv(ctx.deps.envPath, {
        [cat.keyVar]: key,
        SEARCH_PROVIDER: provider,
      });
      return restartOffer(st, ctx, provider);
    },
  },
};
