// Движок вложенного inline-меню (/menu). Живёт в мосте (out-of-band): работает, пока
// агент занят, ничего не стоит по токенам, деплой = рестарт только iva-telegram-poll.
//
// Экраны — отдельные модули scripts/lib/menu/<name>; каждый экспортит по умолчанию
// { parent, render(st, ctx) -> {text, rows}, on(verb, args, st, ctx), texts? }. Реестр
// импортируется статически (SCREENS ниже), но createMenu({screens}) позволяет его
// подменить — так юнит-тест проверяет ЛОГИКУ движка, не завися от контента экранов.
//
// Грамматика callback_data: "iva_menu:<sid>:<verb>[:<arg>[:<arg>]]" — ASCII, только
// enum/индексы, <=64 байта (тот же принцип, что m:<index> в /model). Никаких user data.
// sid: r, разделы gm gc gmem gcon gsch gsys, экраны srch rich voice lang chr core ub gws col cron ntc sk st turn svc (+псевдо mdl/thk — хендофф в визарды).
// verbs: o(навигация) x(закрыть) pg:<n> rf(обновить) + data-вербы экрана (set key rs go
// q:<i>:<v> skip fin redo apply do; ntc: ins:<0|0930|1130|1730>).

import { getLang } from "#lib/i18n.ts";
import type { TelegramFlowState } from "../tg-flow.ts";
import {
  button,
  type RichButton,
  type RichButtonStyle,
} from "../telegram-buttons.ts";
import type {
  TelegramCallbackQuery as CallbackQuery,
  TelegramId,
  TelegramQueueMessage as TelegramMessage,
  TelegramQueueUpdate,
} from "../telegram-queue.ts";
import { isPrivateTelegramChat } from "#lib/telegram-private-chat.ts";

import root from "./root.ts";
import {
  modelGroup,
  chatGroup,
  memoryGroup,
  connectionsGroup,
  scheduleGroup,
  systemGroup,
} from "./groups.ts";
import search from "./search.ts";
import rich from "./rich.ts";
import voice from "./voice.ts";
import lang from "./lang.ts";
import character from "./character.ts";
import core from "./core.ts";
import userbot from "./userbot.ts";
import gws from "./gws.ts";
import colleagues from "./colleagues.ts";
import crons from "./crons.ts";
import notices from "./notices.ts";
import skills from "./skills.ts";
import status from "./status.ts";
import turnPolicy from "./turn-policy.ts";
import service from "./service.ts";

type MaybePromise<T> = T | Promise<T>;
// Старый ряд экрана: пока экраны не переписаны на rich (D3), они отдают движку
// "{text, callback_data}"; ряд доезжает до текста через legacyRows в tg-flow.
// ctx.btn уже возвращает rich-строку — в старом ряду её место держит тип RichButton.
type MenuButton = { text: string; callback_data: string };
type MenuAwaitText = { kind: string; secret: boolean; [key: string]: unknown };
type MenuState = TelegramFlowState;
type MenuFlows = {
  get(chatId: TelegramId, userId: TelegramId): MenuState | null;
  start(
    chatId: TelegramId,
    userId: TelegramId,
    flow: string,
    extra: Record<string, unknown>,
  ): MenuState;
  touch(state: MenuState): void;
  screen(
    state: MenuState,
    text: string,
    rows?: Array<MenuButton[]>,
  ): Promise<void>;
  end(state: MenuState, text: string): Promise<void>;
};
type TelegramTransport = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
type MenuDeps = {
  allowed?: ReadonlySet<string>;
  deliver(update: TelegramQueueUpdate): MaybePromise<unknown>;
  admitSynthetic(update: TelegramQueueUpdate): MaybePromise<boolean>;
  handleModelCmd(
    chatId: number,
    userId: TelegramId,
    options: { msgId?: number },
  ): MaybePromise<unknown>;
  handleThinkCmd(
    chatId: number,
    userId: TelegramId,
    options: { msgId?: number },
  ): MaybePromise<unknown>;
  reply(chatId: number, text: string): MaybePromise<unknown>;
  [key: string]: unknown;
};
type MenuContext = {
  flows: MenuFlows;
  tg: TelegramTransport;
  deps: MenuDeps;
  lang: string;
  tr: (english: string, russian: string) => string;
  getLang: () => string;
  btn: (
    text: string,
    callbackData: string,
    style?: RichButtonStyle,
  ) => RichButton;
  show: (state: MenuState, screen: string) => Promise<void>;
  backRow: (screen: string) => RichButton[];
};
type MenuCallbackEvent = {
  updateId: number;
  callbackId: string;
  chatId: number;
  messageId: number;
  userId: string;
};
// text — markdown rich-сообщения; кнопки экран ставит в него сам (button()). Пока экран
// отдаёт старый rows, движок сам дописывает его в текст шимом legacyRows — поле rows
// уйдёт, когда D3 перепишет экраны.
type MenuView = { text: string; rows?: Array<MenuButton[]> };
type MenuScreen = {
  render?: (
    state: MenuState,
    context: MenuContext,
  ) => MaybePromise<MenuView | null | undefined>;
  on?: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
    event?: MenuCallbackEvent,
  ) => MaybePromise<unknown>;
  recover?: (
    verb: string,
    args: string[],
    event: MenuCallbackEvent,
    context: MenuContext,
  ) => MaybePromise<unknown>;
  texts?: Record<
    string,
    (
      text: string,
      message: TelegramMessage,
      state: MenuState,
      context: MenuContext,
    ) => MaybePromise<unknown>
  >;
};
type ScreenRegistry = Record<string, unknown>;
type MenuOptions = {
  flows: MenuFlows;
  tg: TelegramTransport;
  deps: MenuDeps;
  screens?: ScreenRegistry;
};
type OpenOptions = { msgId?: number };

function isMenuAwaitText(value: unknown): value is MenuAwaitText {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { secret?: unknown }).secret === "boolean"
  );
}

function telegramCallOk(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

// sid → экранный модуль. Псевдо-sid mdl/thk сюда не входят: это хендофф в визарды
// /model//think (обрабатывается в onCallback ниже до диспатча на экран).
export const SCREENS = {
  r: root,
  gm: modelGroup,
  gc: chatGroup,
  gmem: memoryGroup,
  gcon: connectionsGroup,
  gsch: scheduleGroup,
  gsys: systemGroup,
  srch: search,
  rich,
  voice,
  lang,
  chr: character,
  core,
  ub: userbot,
  gws,
  col: colleagues,
  cron: crons,
  ntc: notices,
  sk: skills,
  st: status,
  turn: turnPolicy,
  svc: service,
};

const PREFIX = "iva_menu:";
// Навигационные вербы «усыновляют» протухшее сообщение: все они — чистые функции от
// .env/settings/fs, потому меню само-чинится после рестарта моста или тапа по старому меню.
const NAV_VERBS = new Set(["o", "pg", "rf"]);

export function createMenu({
  flows,
  tg,
  deps,
  screens = SCREENS,
}: MenuOptions) {
  // ctx.lang — снимок языка на момент взаимодействия. tr/getLang берут его, а НЕ глобальный
  // getLang напрямую: сразу после смены языка кнопкой lang.on обновляет ctx.lang, и root
  // перерисовывается уже на новом языке (глобальный mtime-кэш i18n догоняет за ~2с).
  // Ни одной module-level const с переведённой строкой — правило репо соблюдено.
  const ctx: MenuContext = {
    tg,
    deps,
    flows,
    lang: "ru",
    tr: (en, ru) => (ctx.lang === "ru" ? ru : en),
    getLang: () => ctx.lang,
    btn: (text, data, style) => button(text, data, style),
    // Переключить экран и перерисовать. Страницу НЕ сбрасывает — этим управляет вызывающий
    // (движок сбрасывает page на o-верб; экраны, зовущие show для под-экранов, — сами).
    show: async (st, sid) => {
      st.screen = sid;
      await renderScreen(st);
    },
    // Ряд «назад»: в корень — «‹ Меню», иначе «‹ Назад». Кнопка статическая (o-верб) —
    // возврат работает даже когда стейт потерян (усыновление в onCallback).
    backRow: (sid) => [
      ctx.btn(
        sid === "r" ? ctx.tr("‹ Menu", "‹ Меню") : ctx.tr("‹ Back", "‹ Назад"),
        `${PREFIX}${sid}:o`,
      ),
    ],
  };

  // sid → экран ТОЛЬКО по своим ключам таблицы экранов: иначе sid из Object.prototype
  // (constructor, toString, __proto__, valueOf) находит наследованное значение и мусор
  // из кнопки считается живым экраном.
  function screenAt(sid: unknown): MenuScreen | undefined {
    if (typeof sid !== "string" || !Object.hasOwn(screens, sid))
      return undefined;
    return screens[sid] as MenuScreen | undefined;
  }

  // Обработчик ввода экрана — тоже только по своему ключу: унаследованный
  // Object.constructor функцией является, обработчиком ввода — нет.
  function textHandlerAt(mod: MenuScreen | undefined, kind: string) {
    const texts = mod?.texts;
    if (!texts || !Object.hasOwn(texts, kind)) return undefined;
    const handler: unknown = texts[kind];
    return typeof handler === "function" ? texts[kind] : undefined;
  }

  async function renderScreen(st: MenuState) {
    const mod = screenAt(st.screen);
    if (!mod || typeof mod.render !== "function") return;
    const view = await mod.render(st, ctx);
    if (!view) return;
    await flows.screen(st, view.text, view.rows);
  }

  // "iva_menu:srch:set:tavily" -> { sid:"srch", verb:"set", args:["tavily"] }.
  // "iva_menu:mdl" -> { sid:"mdl", verb:undefined, args:[] }.
  function parse(data: string) {
    const parts = data.slice(PREFIX.length).split(":");
    return { sid: parts[0], verb: parts[1], args: parts.slice(2) };
  }

  async function onCallback(cq: CallbackQuery, sourceUpdateId?: number) {
    const chatId = cq.message?.chat?.id;
    const userId = String(cq.from?.id ?? "");
    const messageId = cq.message?.message_id;
    ctx.lang = getLang();
    // Мёртвый экран: тост «устарело» уходит прямо в ack (второй answerCallbackQuery
    // Telegram уже не примет), а меню ниже открывается заново на корне. Верб x — закрытие,
    // у него свой финальный текст, тост там противоречил бы ему.
    let staleToast: string | null = null;
    let foreignAwait = false;
    if (typeof cq.data === "string" && cq.data.startsWith(PREFIX)) {
      const early = parse(cq.data);
      const handoff = early.sid === "mdl" || early.sid === "thk";
      const known = handoff || Boolean(screenAt(early.sid));
      if (!known && early.verb !== "x")
        staleToast = ctx.tr(
          "Menu expired — shown again.",
          "Меню устарело — открыто заново.",
        );
      // Ожидание ввода принадлежит тому flow, который его поставил: визард /model//think
      // ждёт свой секрет в СВОЁМ сообщении. Меню не забирает ни это ожидание, ни общий
      // слот — иначе ключ ушёл бы обычной доставкой в eve и остался в чате. Тап гасим
      // тостом и больше ничего не делаем; хендофф mdl/thk и закрытие x идут своей
      // дорогой и слот не портят.
      const slot = chatId === undefined ? null : flows.get(chatId, userId);
      foreignAwait = Boolean(
        slot && slot.flow !== "menu" && isMenuAwaitText(slot.awaitText),
      );
      if (foreignAwait && !handoff && early.verb !== "x")
        staleToast = ctx.tr(
          "Finish the input you started, or send /menu again.",
          "Заверши начатый ввод или отправь /menu заново.",
        );
    }
    // Гасим спиннер кнопки СРАЗУ (mirror handleWizardCallback :562) — дальше можно не спешить.
    await tg("answerCallbackQuery", {
      callback_query_id: cq.id,
      ...(staleToast ? { text: staleToast } : {}),
    }).catch(() => {});
    if (!isPrivateTelegramChat(cq.message?.chat)) return true;
    // Не-allowlisted тап глотаем ПОСЛЕ ack (mirror :563): флоу существует только у того,
    // кто прошёл гейт /menu, поэтому чужой тап и так не имеет стейта — но глушим явно.
    const allowed = deps.allowed;
    if (!allowed || allowed.size === 0 || !allowed.has(userId)) return true;
    if (typeof cq.data !== "string" || !cq.data.startsWith(PREFIX)) return true;
    if (chatId === undefined || messageId === undefined) return true;

    const { sid, verb, args } = parse(cq.data);
    const event =
      Number.isSafeInteger(sourceUpdateId) && typeof cq.id === "string"
        ? {
            updateId: sourceUpdateId!,
            callbackId: cq.id,
            chatId,
            messageId,
            userId,
          }
        : null;

    // Псевдо-sid: хендофф в существующие визарды. newWizard внутри заменит flow-слот
    // (single-flow), а визард отрисуется в ЭТО же сообщение (msgId меню).
    if (sid === "mdl") {
      await deps.handleModelCmd(chatId, userId, { msgId: messageId });
      return true;
    }
    if (sid === "thk") {
      await deps.handleThinkCmd(chatId, userId, { msgId: messageId });
      return true;
    }

    // Закрытие: снять стейт и переписать сообщение финальным текстом — он идёт без кнопок,
    // и кнопки прежнего экрана (они были частью его текста) исчезают вместе с ним.
    if (verb === "x") {
      const st = flows.get(chatId, userId);
      const closed = ctx.tr("Menu closed.", "Меню закрыто.");
      if (st && st.flow === "menu" && st.msgId === messageId) {
        // Закрывают ТЕКУЩЕЕ меню: end редактирует то же сообщение и снимает стейт.
        await flows.end(st, closed);
      } else {
        // Закрывают старое/протухшее сообщение (msgId не совпал): правим именно его, а
        // активный menu-стейт в другом сообщении не трогаем.
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          rich_message: { markdown: closed },
        }).catch(() => {});
      }
      return true;
    }

    // Ждущий чужой flow (см. ранний тост): слот не наш, ожидание не наше — выходим.
    if (foreignAwait) return true;

    let st = flows.get(chatId, userId);
    const fresh = Boolean(st && st.flow === "menu" && st.msgId === messageId);
    const mod = screenAt(sid);
    // Ждущий ввод переезжает на усыновляемое сообщение только внутри СВОЕГО flow и только
    // к экрану, который его принимает своим texts[kind]. Чужой flow сюда не доходит
    // (выход выше), совпадение имени kind владением не считается.
    const keptAwait =
      !fresh &&
      NAV_VERBS.has(verb) &&
      st?.flow === "menu" &&
      isMenuAwaitText(st.awaitText)
        ? st.awaitText
        : null;
    const carriesAwait =
      keptAwait !== null && textHandlerAt(mod, keptAwait.kind) !== undefined;
    // Мёртвый sid (кнопка из прошлой раскладки меню, мусор в callback_data) и ожидание,
    // которое экрану-получателю обработать нечем: меню открывается заново на корне, тост
    // «устарело» для мёртвого экрана уже ушёл в ack. Живое menu-состояние при этом НЕ
    // вытесняется и его ожидание НЕ переезжает: корень рисуется в том сообщении, которым
    // меню владеет, а ожидание снимается, как на любом нав-вербе. Иначе стейт вместе с
    // awaitText уехал бы на чужой экран, обработчика этому ожиданию там нет — и следующее
    // ОБЫЧНОЕ сообщение перехватывалось бы как креденшл (secret:true — ещё и удалялось
    // из чата) вместо доставки в eve.
    if (!mod || (keptAwait !== null && !carriesAwait)) {
      const target =
        st && st.flow === "menu"
          ? st
          : flows.start(chatId, userId, "menu", {
              screen: "r",
              page: 0,
              msgId: messageId,
            });
      flows.touch(target);
      target.awaitText = null;
      target.page = 0;
      await ctx.show(target, "r");
      return true;
    }
    let adopted = false;
    if (!fresh) {
      if (NAV_VERBS.has(verb)) {
        // Усыновить сообщение: создать стейт, привязанный к тапнутому message_id,
        // и отрендерить. Ожидание ввода вытесненного стейта забираем с собой, когда этот
        // экран им владеет: иначе следующий секрет прошёл бы мимо перехвата и ушёл в eve.
        st = flows.start(chatId, userId, "menu", {
          screen: sid,
          page: 0,
          msgId: messageId,
          ...(carriesAwait ? { awaitText: keptAwait } : {}),
        });
        adopted = true;
      } else {
        if (event && typeof mod.recover === "function") {
          const recovered = await mod.recover(verb, args, event, ctx);
          if (recovered !== undefined) return recovered;
        }
        // Data-верб без живого стейта (рестарт моста / тап по старому меню): мид-флоу данные
        // потеряны — честно говорим «устарело» (mirror :567-570).
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          rich_message: {
            markdown: ctx.tr(
              "Menu expired — send /menu",
              "Меню устарело — отправь /menu заново",
            ),
          },
        }).catch(() => {});
        return true;
      }
    }

    const active = st!;
    flows.touch(active); // активные квиз/интервью не протухают на полуслове; заброшенное меню — за 15 мин
    // Любой возврат/обновление экрана (‹ Назад, ‹ Меню, Отмена=o, пагинация, refresh) снимает
    // ждущий ввод: иначе следующее ОБЫЧНОЕ сообщение перехватится как креденшл (secret:true —
    // ещё и удалится из чата). Ручная чистка в search.render остаётся как защита в глубину.
    // Усыновление — не отказ от ввода: awaitText, забранный у вытесненного стейта, живёт дальше.
    if (NAV_VERBS.has(verb) && !adopted) active.awaitText = null;

    if (verb === "o") {
      active.page = 0;
      await ctx.show(active, sid);
      return true;
    }
    if (verb === "pg") {
      active.screen = sid;
      active.page = Number.parseInt(args[0], 10) || 0;
      await renderScreen(active);
      return true;
    }
    if (verb === "rf") {
      active.screen = sid;
      await renderScreen(active);
      return true;
    }

    // Data-верб — экрану sid (тапнутая кнопка принадлежит ему). Экран сам решает, что
    // отрисовать (ctx.show / flows.screen / awaitText). Ошибки экрана НЕ роняют мост:
    // onCallback вызывается из моста через .catch (см. handleControl-интеграцию).
    active.screen = sid;
    if (typeof mod.on === "function") {
      const handled = await mod.on(verb, args, active, ctx, event ?? undefined);
      if (handled === "retry") return "retry";
      if (handled === false) return false;
    }
    return true;
  }

  // Перехват текста, пока экран ждёт ввод (st.awaitText установлен ЭКРАНОМ). Секрет
  // (apikey/ubcred/gwsjson) удаляется ДО всего остального — значение не уходит в eve/лог/reply.
  // Отказ secret вне лички — на этапе установки awaitText (обязанность экрана); сюда доходит
  // только уже разрешённый ввод.
  // opts.skipDelete — the caller has ALREADY removed the message and CONFIRMED the deletion succeeded
  // (the bridge deletes a secret file, checks the result, and only then downloads + delivers the
  // content here). Callers must never set it without a confirmed deletion — otherwise a still-visible
  // secret would be processed. When set, we don't try to delete a second time.
  async function onText(
    msg: TelegramMessage,
    st: MenuState,
    opts: { skipDelete?: boolean } = {},
  ) {
    ctx.lang = getLang();
    const a = isMenuAwaitText(st?.awaitText) ? st.awaitText : null;
    if (!a) return true;
    const chatId = msg.chat?.id;
    if (chatId === undefined) return true;
    if (!isPrivateTelegramChat(msg.chat)) return true;
    const text = (msg.text || "").trim();
    flows.touch(st);
    // Команда прерывает ожидание: молча висящий промпт пригласил бы вставить ключ позже,
    // когда его уже некому перехватить (:666-668). Команду не удаляем — это не секрет.
    if (text.startsWith("/")) {
      await flows.end(
        st,
        ctx.tr(
          "Cancelled — no longer waiting for input.",
          "Отменено — ожидание ввода снято.",
        ),
      );
      return true;
    }
    if (a.secret && !opts.skipDelete) {
      // delete-message-FIRST (:512-515). При провале удаления — предупреждение как в мосте;
      // текст ошибки НИКОГДА не содержит значение ключа.
      const del = await tg("deleteMessage", {
        chat_id: chatId,
        message_id: msg.message_id,
      });
      if (!telegramCallOk(del)) {
        await deps.reply(
          chatId,
          ctx.tr(
            "Couldn't delete your message — please delete it manually.",
            "Не смог удалить сообщение — удали его вручную.",
          ),
        );
      }
    }
    const handler = textHandlerAt(screenAt(st.screen), a.kind);
    if (handler === undefined) {
      await flows.end(
        st,
        ctx.tr(
          "Input handler is unavailable — flow reset.",
          "Обработчик ввода недоступен — флоу сброшен.",
        ),
      );
      return true;
    }
    await handler(text, msg, st, ctx);
    return true;
  }

  // /menu: заводит свежий стейт и рисует root. opts.msgId (опц.) — редактировать существующее
  // сообщение вместо нового (напр. возврат из визарда). Двойной /menu заменяет стейт; старое
  // сообщение кнопок не теряет — бот снимал их editMessageReplyMarkup'ом, а rich-кнопка живёт
  // в самом тексте и без переписывания всего экрана не снимается. Тапы по старому меню
  // само-лечатся и без этого шага: нав-вербы усыновляют сообщение, data-вербы отвечают
  // «меню устарело», закрытие x редактирует именно это сообщение (см. onCallback).
  async function open(
    chatId: TelegramId,
    userId: TelegramId,
    opts: OpenOptions = {},
  ) {
    ctx.lang = getLang();
    const uid = String(userId);
    const st = flows.start(chatId, uid, "menu", {
      screen: "r",
      page: 0,
      msgId: opts.msgId ?? null,
    });
    await renderScreen(st);
    return st;
  }

  return { open, onCallback, onText };
}
