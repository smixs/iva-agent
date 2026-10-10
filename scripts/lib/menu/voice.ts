// Экран «Голос» (/menu → 🎤): ключ Deepgram, язык распознавания голосовых и имена с терминами,
// которые Deepgram должен писать одинаково (DEEPGRAM_KEYTERMS).
//
// Инварианты ключа те же, что у экрана поиска (scripts/lib/menu/search.ts): значение никогда
// не попадает в лог/eve/текст ошибки, сообщение с ключом удаляет САМ движок (index.ts onText,
// secret:true) ДО вызова texts.deepgramkey, приём разрешён только в личке (проверка при установке
// awaitText — обязанность экрана). Все три настройки читает agent/transcribe.ts из окружения
// процесса, поэтому после записи предлагаем перезапуск iva.service.
//
// Имена и термины — не секрет: их ввод не удаляется из чата. Разбор списка один на оба конца:
// parseKeyterms и keytermsForRequest из agent/transcribe.ts (мост грузит авторское дерево).
//
// Живой проверки ключа, как checkSearchKey у поиска, здесь нет намеренно: у Deepgram в
// репозитории нет проверяющего хелпера, а плодить второй сетевой путь ради меню нечем —
// о неверном ключе скажет первый же голосовой по своему коду ошибки. Проверяется только
// форма: ключ и значение, которое .env сохранит целиком.
import {
  envValueRejection,
  readEnvValues,
  upsertEnv,
  type EnvValueRejection,
} from "../env-file.ts";
import {
  KEYTERMS_BYTES,
  keytermsForRequest,
  parseKeyterms,
} from "#transcribe.ts";
import { button, buttonRow, escapeRichText } from "./buttons.ts";

const SID = "voice";
const PARENT = "r";
const KEY_VAR = "DEEPGRAM_API_KEY";
const LANG_VAR = "DEEPGRAM_LANGUAGE";
const TERMS_VAR = "DEEPGRAM_KEYTERMS";
// Длинный список, вписанный в .env руками, не должен раздувать экран за предел сообщения.
const TERMS_SHOWN_CHARS = 300;
// Ровно те значения, что предлагает экран; всё прочее (напр. ru-RU) трансляция отдаёт как есть.
const LANGS = ["multi", "ru", "en", "uz"] as const;
type Language = (typeof LANGS)[number];
type AwaitText = { kind: string; secret: boolean };
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

const isLanguage = (value: unknown): value is Language =>
  LANGS.includes(value as Language);

// Язык из .env: пусто — multi (дефолт transcribe.ts). Любой другой код — законное значение
// (Deepgram понимает BCP-47), поэтому показываем его как есть, а не подменяем дефолтом.
function configuredLanguage(env: Record<string, string | undefined>): string {
  const raw = (env[LANG_VAR] ?? "").trim();
  return raw === "" ? "multi" : raw;
}

const languageLabel = (value: string, ctx: MenuContext) =>
  value === "multi"
    ? ctx.tr("Auto", "Авто")
    : value === "ru"
      ? "Русский"
      : value === "en"
        ? "English"
        : value === "uz"
          ? "Oʻzbek"
          : escapeRichText(value);

const backLine = (ctx: MenuContext) =>
  `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;

const cancelLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`, "danger")} — ${ctx.tr(
    "leave the prompt without changing anything.",
    "выйти из ввода, ничего не меняя.",
  )}`;

// Текущий список для экрана: через запятую, с обрезкой по длине; пусто — «нет».
function termsLabel(terms: string[], ctx: MenuContext): string {
  if (terms.length === 0) return ctx.tr("none", "нет");
  const joined = terms.join(", ");
  return escapeRichText(
    joined.length > TERMS_SHOWN_CHARS
      ? `${joined.slice(0, TERMS_SHOWN_CHARS)}… (${terms.length})`
      : joined,
  );
}

// Telegram: id личных чатов положительны, групп/супергрупп — отрицательны. Секреты
// принимаем только в личке (в группе бот может не иметь прав на удаление, и ключ увидят
// посторонние). st не хранит chat.type, поэтому опираемся на знак chatId — надёжно.
const isPrivate = (st: MenuState) => Number(st.chatId) > 0;

// Экран «настройка записана — применить перезапуском?». Все настройки экрана читает процесс
// агента при старте, поэтому путь один: запись в .env → этот экран. note — строка о том, что
// именно записано, когда это не очевидно из нажатой кнопки.
async function restartOffer(st: MenuState, ctx: MenuContext, note?: string) {
  const text = [
    `# ${ctx.tr("🎤 Voice", "🎤 Голос")}`,
    ...(note ? [note] : []),
    ctx.tr(
      "Saved. The agent reads voice settings as it starts, so this applies after a restart.",
      "Сохранил. Настройки голоса агент читает при старте, поэтому применится после перезапуска.",
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

// Экран-приглашение ввести ключ: ставит awaitText (перехват следующего текста движком) и
// говорит, что будет дальше. secret:true — приём только в личке (иначе отказ).
async function promptKey(st: MenuState, ctx: MenuContext) {
  if (!isPrivate(st)) {
    st.awaitText = null;
    return ctx.flows.screen(
      st,
      `${ctx.tr(
        "A key is a secret — open a private chat with me and set the Deepgram key there.",
        "Ключ — это секрет. Открой личный чат со мной и введи ключ Deepgram там.",
      )}\n\n${backLine(ctx)}`,
    );
  }
  st.awaitText = { kind: "deepgramkey", secret: true };
  const text = [
    `# ${ctx.tr("🎤 Deepgram key", "🎤 Ключ Deepgram")}`,
    ctx.tr(
      "Send it in the next message — I'll delete it from the chat right away. Create it at console.deepgram.com.",
      "Пришли его следующим сообщением — я сразу удалю его из чата. Ключ можно получить на console.deepgram.com.",
    ),
    cancelLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

// Приглашение прислать список имён и терминов. Ввод не секрет, поэтому secret:false; /menu
// открывается только в личке, а движок берёт текст только оттуда.
async function promptTerms(st: MenuState, ctx: MenuContext) {
  const env = await readEnvValues(ctx.deps.envPath);
  st.awaitText = { kind: "deepgramkeyterms", secret: false };
  const text = [
    `# ${ctx.tr("🎤 Names and terms", "🎤 Имена и термины")}`,
    ctx.tr(
      "Send the names and words Deepgram should spell your way, separated by commas, for example: OJ, Sonnet, Todoist. Only Latin letters fit in the settings. Deepgram charges a small per-minute extra for this. A single «-» clears the list.",
      "Пришли через запятую имена и слова, которые Deepgram должен писать как у тебя, например: OJ, Sonnet, Todoist. В настройках помещается только латиница. Deepgram берёт за это небольшую поминутную доплату. Один знак «-» очищает список.",
    ),
    `${ctx.tr("Now", "Сейчас")}: ${termsLabel(parseKeyterms(env[TERMS_VAR]), ctx)}.`,
    cancelLine(ctx),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

// Почему список не сохраняется — словами владельца. Значение в текст не попадает. too-long —
// первое же слово длиннее того, что Deepgram берёт в один запрос: сохранять было бы нечего.
function termsRejection(
  problem: EnvValueRejection | "too-long",
  ctx: MenuContext,
): string {
  if (problem === "too-long")
    return ctx.tr(
      `I can't save that list: one request to Deepgram takes up to ${KEYTERMS_BYTES} characters of names in all, and the first one alone is longer. Separate the names with commas.`,
      `Такой список не сохраню: в один запрос к Deepgram помещается до ${KEYTERMS_BYTES} знаков имён вместе, а первое уже длиннее. Раздели имена запятыми.`,
    );
  return problem === "non-ascii"
    ? ctx.tr(
        "I can't save that list: the settings file holds only Latin letters, digits, spaces and plain punctuation, and the list has Cyrillic or another script.",
        "Такой список не сохраню: в файл настроек помещаются только латиница, цифры, пробел и обычные знаки, а в списке есть кириллица или другая письменность.",
      )
    : ctx.tr(
        "I can't save that list: it has a character the settings file can't keep (# \" ' ` \\ or an invisible one).",
        "Такой список не сохраню: в нём знак, которого файл настроек не хранит (# \" ' ` \\ или невидимый символ).",
      );
}

export default {
  parent: PARENT,

  async render(st: MenuState, ctx: MenuContext) {
    st.awaitText = null; // возврат на экран снимает ждущий ввод ключа или списка
    const env = await readEnvValues(ctx.deps.envPath);
    const hasKey = Boolean(env[KEY_VAR]);
    const language = configuredLanguage(env);
    const terms = parseKeyterms(env[TERMS_VAR]);
    const text = [
      `# ${ctx.tr("🎤 Voice", "🎤 Голос")}`,
      `${ctx.tr("Deepgram key", "Ключ Deepgram")}: ${hasKey ? ctx.tr("set", "есть") : ctx.tr("not set", "нет")}.`,
      ...(hasKey
        ? []
        : [
            ctx.tr(
              "Voice notes aren't transcribed without a key.",
              "Без ключа голосовые не распознаются.",
            ),
          ]),
      `${ctx.tr("Language", "Язык")}: ${languageLabel(language, ctx)}.`,
      `${button(ctx.tr("🔑 Set the key", "🔑 Указать ключ"), `iva_menu:${SID}:key`)} — ${ctx.tr(
        "send the key in the next message, I'll delete it from the chat.",
        "пришли ключ следующим сообщением, я удалю его из чата.",
      )}`,
      buttonRow(
        LANGS.map((value) =>
          button(
            `${languageLabel(value, ctx)}${value === language ? " ✓" : ""}`,
            `iva_menu:${SID}:lang:${value}`,
          ),
        ),
      ),
      `${ctx.tr("Names and terms", "Имена и термины")}: ${termsLabel(terms, ctx)}.`,
      `${button(ctx.tr("✏️ Names and terms", "✏️ Имена и термины"), `iva_menu:${SID}:terms`)} — ${ctx.tr(
        "names and words Deepgram should spell your way.",
        "имена и слова, которые Deepgram должен писать как у тебя.",
      )}`,
      backLine(ctx),
    ].join("\n\n");
    return { text };
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb === "key") return promptKey(st, ctx);
    if (verb === "terms") return promptTerms(st, ctx);
    if (verb === "lang") {
      const value = args[0];
      if (!isLanguage(value)) return ctx.show(st, SID);
      // Смена языка уводит с приглашения вводить ключ: без этого следующий обычный текст
      // владельца был бы съеден как ключ (движок снимает ожидание только на нав-вербах).
      st.awaitText = null;
      await upsertEnv(ctx.deps.envPath, { [LANG_VAR]: value });
      return restartOffer(st, ctx);
    }
    if (verb === "rs") {
      if (args[0] === "now") {
        // plain restart — не restartAgent(): смена настройки не «сброс», диалоги живут.
        const ok = await ctx.deps.sc("restart", "iva.service");
        return ctx.flows.end(
          st,
          ok
            ? ctx.tr(
                "♻️ Restarting the agent — voice notes are transcribed in ~30s.",
                "♻️ Перезапускаю агента — голосовые распознаются через ~30 сек.",
              )
            : ctx.tr(
                "⚠️ Couldn't restart (systemctl). Check the service on the server.",
                "⚠️ Не удалось перезапустить (systemctl). Проверь сервис на сервере.",
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

  texts: {
    // Приём ключа Deepgram. Сообщение уже удалено движком (secret:true) до этого вызова.
    // Значение ключа не пишется в лог/reply/eve ни при каком исходе.
    async deepgramkey(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const value = String(text).trim();
      // Мало быть похожим на ключ: значение обязано выжить в .env целиком (его читают оба
      // парсера — systemd EnvironmentFile и node --env-file). Причина отказа не содержит
      // значения — только класс символа.
      const problem = envValueRejection(value);
      if (!/^\S{8,}$/.test(value) || problem) {
        st.awaitText = null;
        return ctx.flows.end(
          st,
          ctx.tr(
            "That key won't do: either it isn't a key, or it has a character .env can't keep (#, a quote, a space). The prompt is cleared, I deleted the message just in case.",
            "Такой ключ не приму: либо это не ключ, либо в нём символ, которого .env не сохранит (#, кавычка, пробел). Ожидание снято, сообщение удалил на всякий случай.",
          ),
        );
      }
      st.awaitText = null;
      await upsertEnv(ctx.deps.envPath, { [KEY_VAR]: value });
      return restartOffer(st, ctx);
    },

    // Приём списка имён и терминов. «-» или пустой список (одни запятые) убирают строку из .env.
    // Пишем только то, что уйдёт в запрос (keytermsForRequest: число слов и байты), и владелец
    // узнаёт об обрезке здесь, а не из журнала.
    async deepgramkeyterms(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      st.awaitText = null;
      // «-», тире и одни запятые разбираются в пустой список: в них нет ни буквы, ни цифры.
      const terms = parseKeyterms(String(text));
      if (terms.length === 0) {
        await upsertEnv(ctx.deps.envPath, { [TERMS_VAR]: null });
        return restartOffer(
          st,
          ctx,
          ctx.tr("The list is cleared.", "Список очищен."),
        );
      }
      const kept = keytermsForRequest(terms);
      const value = kept.join(",");
      const problem = kept.length === 0 ? "too-long" : envValueRejection(value);
      if (problem) {
        return ctx.flows.screen(
          st,
          [
            `# ${ctx.tr("🎤 Names and terms", "🎤 Имена и термины")}`,
            termsRejection(problem, ctx),
            `${button(ctx.tr("✏️ Try again", "✏️ Ввести заново"), `iva_menu:${SID}:terms`)} — ${ctx.tr(
              "send the list once more.",
              "прислать список ещё раз.",
            )}`,
            `${button(ctx.tr("‹ Voice", "‹ Голос"), `iva_menu:${SID}:o`)} — ${ctx.tr(
              "back to the voice settings, nothing changed.",
              "вернуться к настройкам голоса, ничего не меняя.",
            )}`,
          ].join("\n\n"),
        );
      }
      await upsertEnv(ctx.deps.envPath, { [TERMS_VAR]: value });
      const saved = `${ctx.tr("Names and terms", "Имена и термины")}: ${termsLabel(kept, ctx)}.`;
      const note =
        terms.length > kept.length
          ? `${saved} ${ctx.tr(
              `Kept the first ${kept.length} of ${terms.length}: a request carries no more.`,
              `Оставил первые ${kept.length} из ${terms.length}: больше в один запрос не уходит.`,
            )}`
          : saved;
      return restartOffer(st, ctx, note);
    },
  },
};
