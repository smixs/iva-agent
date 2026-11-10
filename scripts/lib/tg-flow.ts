// Session-store для out-of-band диалогов Telegram (/model, /think, /menu и будущие
// флоу). Извлечено из scripts/poller/control.ts без изменения поведения:
// один слот на пару (chatId, userId), каждый флоу правит ОДНО своё сообщение.
//
// Общий стор — то, что делает однозначным «чей следующий текст в чате»: пока висит
// awaitText, ввод принадлежит текущему флоу этого пользователя, а не eve.
//
// Состояние живёт только в памяти этого процесса. Рестарт моста теряет его —
// протухший тап по кнопке ловится диспатчером как «диалог устарел».

import { legacyRows, screenPayload } from "./telegram-buttons.ts";

const TTL_MS = 15 * 60 * 1000; // как WIZARD_TTL_MS — совпадает с временем жизни codex device-code

export type TelegramFlowResponse = {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
};

export type TelegramFlowId = string | number;

type TelegramFlowTransport = (
  method: string,
  params: Record<string, unknown>,
) => Promise<TelegramFlowResponse>;

type TelegramKeyboard = Array<Array<Record<string, unknown>>>;

/**
 * Шаги мастера /model и /think (scripts/poller/wizards.ts), каждый — экран со своими
 * кнопками. Слот другого флоу (/menu) шага не имеет: `null`.
 */
export const WIZARD_STEPS = [
  "intro",
  "loading",
  "effort",
  "provider",
  "awaiting_base",
  "awaiting_model",
  "awaiting_key",
  "cli_status",
  "models",
  "model_error",
  "login",
  "saved",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export function isWizardStep(value: unknown): value is WizardStep {
  return (WIZARD_STEPS as readonly unknown[]).includes(value);
}

/**
 * Следующий текст в чате, который ждёт флоу, а не eve: `kind` называет поле, `secret` —
 * сообщение удаляется из чата до разбора.
 */
export type AwaitText = {
  kind: string;
  secret: boolean;
  data?: Record<string, unknown>;
  /** Ждёт файл, а не текст (JSON ключа Google Workspace). */
  file?: boolean;
};

export type TelegramFlowState = {
  flow: string;
  chatId: TelegramFlowId;
  userId: TelegramFlowId;
  createdAt: number;
  msgId: number | null;
  provider: unknown;
  modelOptions: unknown;
  model: unknown;
  efforts: unknown;
  effort: unknown;
  step: WizardStep | null;
  awaitText: AwaitText | null;
  screen: unknown;
  page: number;
  data: Record<string, unknown>;
  [key: string]: unknown;
};

type CreateFlowsOptions = {
  tg: TelegramFlowTransport;
  log?: () => void;
};

function messageResultSucceeded(value: TelegramFlowResponse): boolean {
  return (
    value.ok === true &&
    typeof (value.result as { message_id?: unknown } | undefined)
      ?.message_id === "number"
  );
}

// tg(method, params) -> { ok, result, description } (тонкая обёртка над Bot API моста).
// log принимается по контракту для будущих обработчиков; примитивы ниже не логируют —
// поведение обязано остаться дословным (тихий фолбэк при неудачной правке).
export function createFlows({ tg, log = () => {} }: CreateFlowsOptions) {
  void log;
  const flows = new Map<string, TelegramFlowState>(); // был `wizards`; ключ `${chatId}:${userId}`

  const key = (chatId: TelegramFlowId, userId: TelegramFlowId) =>
    `${chatId}:${userId}`;

  // getWizard :371 — TTL-очистка при чтении. Континуации (codex-login) сверяют
  // identity: `flows.get(...) !== st` истинно и когда слот заменён, и когда протух.
  function get(
    chatId: TelegramFlowId,
    userId: TelegramFlowId,
  ): TelegramFlowState | null {
    const k = key(chatId, userId);
    const st = flows.get(k);
    if (st && Date.now() - st.createdAt > TTL_MS) {
      flows.delete(k);
      return null;
    }
    return st ?? null;
  }

  // newWizard :383 — identity-replace: перезаписывает любой ждущий флоу этого юзера.
  // Осиротевшие async-континуации старого объекта сверяют identity против стора и
  // сами себя отбрасывают. extra подмешивает поля в свежий стейт (напр. msgId меню).
  function start(
    chatId: TelegramFlowId,
    userId: TelegramFlowId,
    flow: string,
    extra: Record<string, unknown> = {},
  ): TelegramFlowState {
    const st: TelegramFlowState = {
      flow,
      chatId,
      userId,
      createdAt: Date.now(),
      msgId: null,
      provider: null,
      modelOptions: null,
      model: null,
      efforts: null,
      effort: null,
      step: null,
      awaitText: null, // обобщение awaitKey (:388): { kind, secret, data }
      screen: null,
      page: 0,
      data: {},
      ...extra,
    };
    flows.set(key(chatId, userId), st);
    return st;
  }

  // Продлевает жизнь стейта. Зовёт только движок меню на каждом взаимодействии —
  // активные квиз/интервью не протухают на полуслове. Визарды /model//think НЕ
  // трогаются: их TTL намеренно равен времени жизни codex device-code.
  function touch(st: TelegramFlowState): void {
    st.createdAt = Date.now();
  }

  // wizScreen :393 — правит единственное сообщение флоу на месте (первый раз шлёт).
  // Экран — это rich message: markdown, кнопки живут в самом тексте, клавиатуры рядом нет.
  // Пока экраны отдают старые ряды, они доезжают до текста через legacyRows — шим
  // переходного периода, D3 снимет его вместе с рядами.
  async function screenWithResult(
    st: TelegramFlowState,
    markdown: string,
    rows?: TelegramKeyboard | null,
  ): Promise<boolean> {
    const payload = screenPayload(
      rows ? `${markdown}\n\n${legacyRows(rows)}` : markdown,
    );
    const rich = "rich_message" in payload;
    if (st.msgId) {
      const r = await tg("editMessageText", {
        chat_id: st.chatId,
        message_id: st.msgId,
        ...payload,
      });
      // «message is not modified» = двойной тап перерисовал тот же экран — это успех, не сбой.
      if (r.ok) return messageResultSucceeded(r);
      if (/not modified/i.test(r.description || "")) return true;
      // правка не удалась (сообщение слишком старое / удалено) — падаем на свежее сообщение
    }
    const r = await tg(rich ? "sendRichMessage" : "sendMessage", {
      chat_id: st.chatId,
      ...payload,
    });
    const succeeded = messageResultSucceeded(r);
    if (succeeded) st.msgId = r.result!.message_id;
    return succeeded;
  }

  async function screen(
    st: TelegramFlowState,
    text: string,
    rows?: TelegramKeyboard | null,
  ): Promise<void> {
    await screenWithResult(st, text, rows);
  }

  // endWizard :406 — снимает стейт и показывает финальный экран. НОВОЕ: опциональные
  // rows (терминальный экран может нести кнопку «‹ Меню» — возврат в меню; пока это
  // старый ряд, legacyRows в screenWithResult ставит её в текст).
  async function endWithResult(
    st: TelegramFlowState,
    text: string,
    rows?: TelegramKeyboard | null,
  ): Promise<boolean> {
    const succeeded = await screenWithResult(st, text, rows);
    if (succeeded) flows.delete(key(st.chatId, st.userId));
    return succeeded;
  }

  async function end(
    st: TelegramFlowState,
    text: string,
    rows?: TelegramKeyboard | null,
  ): Promise<void> {
    flows.delete(key(st.chatId, st.userId));
    await screen(st, text, rows);
  }

  return {
    key,
    get,
    start,
    touch,
    screen,
    end,
    screenWithResult,
    endWithResult,
  };
}
