import {
  renderTelegramInputRequest,
  registerTelegramFreeformPrompt,
  splitTelegramMessageText,
  telegramContinuationToken,
  type TelegramEventContext,
  type TelegramChannelState,
  type TelegramHandle,
} from "eve/channels/telegram";
import { redactNotice } from "./outbox.ts";
import { escHtml, mdToTelegramHtml } from "./telegram-format.ts";
import { tr } from "./i18n.ts";

type Request = Parameters<typeof renderTelegramInputRequest>[0];
type Resolution = {
  requestId: string;
  outcome: "answered" | "approved" | "denied" | "ignored" | "invalid";
  response?: { optionId?: string; text?: string };
};
type QuestionPreview = {
  messageId: string | number;
  prompt: string;
  labels: Record<string, string>;
  rich: boolean;
  settledStatus?: string;
};
export type QuestionState = TelegramChannelState & {
  questionPreviews?: Record<string, QuestionPreview>;
};
type Handle = Pick<TelegramHandle, "request" | "chatId" | "post"> &
  Partial<Pick<TelegramHandle, "messageThreadId">>;

const QUESTION_EDIT_TIMEOUT_MS = 5000;
const QUESTION_PREVIEW_PART_LIMIT = 16000;
class QuestionPostRejected extends Error {}
class QuestionMessageUnavailable extends Error {}
class QuestionStatusTooLong extends Error {}

function messageUnavailable(response: {
  status: number;
  description?: string;
}): boolean {
  return (
    response.status === 400 &&
    /message (?:to edit not found|can['’]t be edited|cannot be edited)/iu.test(
      response.description ?? "",
    )
  );
}

// Одна точка сроков Bot API для правок: сообщение-статус (channels/telegram.ts statusTransport) берёт её же.
export function transport(tg: Pick<Handle, "request">, deadline?: number) {
  return async (method: string, body: Record<string, unknown>) => {
    const remaining =
      deadline === undefined ? Infinity : deadline - performance.now();
    if (remaining <= 0) throw new Error("preview edit timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Awaited<ReturnType<TelegramHandle["request"]>>;
    try {
      response = await Promise.race([
        tg.request(
          method,
          body as NonNullable<Parameters<TelegramHandle["request"]>[1]>,
        ),
        new Promise<never>((_, reject) => {
          if (deadline !== undefined)
            timer = setTimeout(
              () => reject(new Error("preview edit timeout")),
              remaining,
            );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const payload = (response.body ?? {}) as {
      ok?: boolean;
      result?: {
        message_id?: number;
        chat?: { type?: TelegramChannelState["chatType"] };
      };
      description?: string;
    };
    return {
      ...payload,
      ok: response.ok && payload.ok !== false,
      status: response.status,
    };
  };
}

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;
type Continuation = TelegramEventContext["continuation"];
type ChatType = TelegramChannelState["chatType"];
type ReplyMarkup = ReturnType<typeof renderTelegramInputRequest>["replyMarkup"];
type DeliveryResponse = Awaited<ReturnType<ReturnType<typeof transport>>>;
type DeliveryOptions = {
  messageId?: string | number;
  rich: boolean;
  deadline?: number;
  onPosted?: (messageId: number, chatType: ChatType | undefined) => void;
};
/** How the question went out: the preview keeps exactly this text and kind. */
type Posted = { messageId: number | string; rich: boolean; prompt: string };

/** Keep question text literal in both Telegram representations. */
function literal(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+.!|<>~=$-]/gu, "\\$&");
}

/** The edit landed, or Telegram already shows exactly this text. */
function editLanded(response: DeliveryResponse): boolean {
  return (
    response.ok ||
    response.description?.includes("message is not modified") === true
  );
}

function questionRequestBody(
  tg: Handle,
  markdown: string,
  options: DeliveryOptions,
): Record<string, unknown> {
  const edit = options.messageId !== undefined;
  return {
    chat_id: tg.chatId,
    ...(!edit && tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
    ...(edit ? { message_id: options.messageId } : {}),
    ...(options.rich
      ? { rich_message: { markdown } }
      : {
          text: mdToTelegramHtml(markdown),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
    ...(edit ? { reply_markup: { inline_keyboard: [] } } : {}),
  };
}

/** Bot API answer → message id or a typed delivery error; no side effects. */
function questionResult(
  response: DeliveryResponse,
  messageId: string | number | undefined,
): number | string {
  if (messageId !== undefined) return editResult(response, messageId);
  if (response.ok && response.result?.message_id !== undefined)
    return response.result.message_id;
  // Only a definite unsupported/invalid Bot API request permits native fallback.
  // A timeout, network failure or missing id may already have posted the rich question.
  if (response.status === 400)
    throw new QuestionPostRejected("rich question rejected");
  throw new Error("question delivery failed");
}

function editResult(
  response: DeliveryResponse,
  messageId: string | number,
): string | number {
  if (editLanded(response)) return messageId;
  if (messageUnavailable(response))
    throw new QuestionMessageUnavailable(
      "question message is no longer editable",
    );
  if (
    response.status === 400 &&
    /(?:message(?: text)?|text) is too long/iu.test(response.description ?? "")
  )
    throw new QuestionStatusTooLong("question status cannot fit");
  throw new Error("question delivery failed");
}

/** Question delivery only: a failed edit never posts or repeats the accepted action. */
async function deliverQuestionMessage(
  tg: Handle,
  markdown: string,
  options: DeliveryOptions,
): Promise<number | string> {
  const edit = options.messageId !== undefined;
  const response = await transport(tg, options.deadline)(
    edit ? "editMessageText" : "sendRichMessage",
    questionRequestBody(tg, markdown, options),
  );
  const id = questionResult(response, options.messageId);
  if (!edit) options.onPosted?.(Number(id), response.result?.chat?.type);
  return id;
}

function richButtons(keyboard: Keyboard): string {
  return keyboard
    .map(
      (row) =>
        `<tg-button-row>${row
          .map(
            (button) =>
              `<tg-button type="callback_data" data="${button.callback_data}">${escHtml(button.text)}</tg-button>`,
          )
          .join("")}</tg-button-row>`,
    )
    .join("\n\n");
}

/**
 * Eve post() normally performs this. Raw rich posting needs the same public
 * state/continuation update so a group callback reaches its awaiting session.
 */
function groupAnchor(
  state: QuestionState,
  tg: Handle,
  id: number,
  returnedChatType: ChatType | undefined,
  continuation: Continuation | undefined,
): void {
  const chatType = state.chatType ?? returnedChatType;
  if (state.chatType === null && chatType !== undefined)
    state.chatType = chatType;
  if (chatType !== "group" && chatType !== "supergroup") return;
  state.conversationId = String(id);
  continuation?.rekey(
    telegramContinuationToken({
      chatId: state.chatId ?? tg.chatId,
      conversationId: id,
      messageThreadId: state.messageThreadId ?? undefined,
    }),
  );
}

/** Preserve Eve's literal text, ForceReply and long-message splitting behavior. */
async function postNative(
  tg: Handle,
  prompt: string,
  replyMarkup: ReplyMarkup,
): Promise<Posted> {
  const result = await tg.post({ text: prompt, reply_markup: replyMarkup });
  return {
    messageId: result.id,
    rich: false,
    prompt: literal(splitTelegramMessageText(prompt)[0]),
  };
}

/** Without public continuation routing, use Eve post() so group callbacks stay anchored. */
function richKeyboard(
  keyboard: Keyboard | undefined,
  state: QuestionState,
  options: QuestionOptions,
): Keyboard | undefined {
  return options.rich &&
    keyboard &&
    (options.continuation !== undefined || state.chatType === "private")
    ? keyboard
    : undefined;
}

async function postQuestion(
  prompt: string,
  replyMarkup: ReplyMarkup,
  keyboard: Keyboard | undefined,
  state: QuestionState,
  tg: Handle,
  options: QuestionOptions,
): Promise<Posted> {
  const buttons = richKeyboard(keyboard, state, options);
  if (!buttons) return postNative(tg, prompt, replyMarkup);
  const text = literal(prompt);
  try {
    const messageId = await deliverQuestionMessage(
      tg,
      `${text}\n\n${richButtons(buttons)}`,
      {
        rich: true,
        onPosted: (id, chatType) =>
          groupAnchor(state, tg, id, chatType, options.continuation),
      },
    );
    return { messageId, rich: true, prompt: text };
  } catch (error) {
    if (!(error instanceof QuestionPostRejected)) throw error;
    return postNative(tg, prompt, replyMarkup);
  }
}

function rememberPreview(
  state: QuestionState,
  request: Request,
  posted: Posted,
  keyboard: Keyboard | undefined,
): void {
  state.questionPreviews = {
    ...state.questionPreviews,
    [request.requestId]: {
      messageId: posted.messageId,
      rich: posted.rich,
      prompt: posted.prompt,
      labels: Object.fromEntries(
        (request.options ?? []).map(({ id }, index) => [
          id,
          keyboard?.flat()[index]?.text ?? "",
        ]),
      ),
    },
  };
}

export type QuestionOptions = {
  readonly rich?: boolean;
  readonly continuation?: Continuation;
};

/** The channel persists the preview reference with Eve's compact callback mapping. */
export async function postTelegramQuestion(
  request: Request,
  state: QuestionState,
  tg: Handle,
  options: QuestionOptions = {},
): Promise<void> {
  const rendered = renderTelegramInputRequest(request, state);
  const prompt = redactNotice(rendered.text);
  const keyboard = (
    rendered.replyMarkup as { inline_keyboard?: Keyboard } | undefined
  )?.inline_keyboard;
  const posted = await postQuestion(
    prompt,
    rendered.replyMarkup,
    keyboard,
    state,
    tg,
    options,
  );
  rememberPreview(state, request, posted, keyboard);
  if (rendered.freeformRequestId !== undefined || request.allowFreeform)
    registerTelegramFreeformPrompt(state, {
      messageId: String(posted.messageId),
      requestId: request.requestId,
    });
}

function previewFor(
  state: QuestionState,
  requestId: string,
): QuestionPreview | undefined {
  return state.questionPreviews &&
    Object.hasOwn(state.questionPreviews, requestId)
    ? state.questionPreviews[requestId]
    : undefined;
}

function dropCallbacks(state: QuestionState, requestId: string): void {
  for (const [id, response] of Object.entries(state.hitlCallbacks ?? {}))
    if (response.requestId === requestId) delete state.hitlCallbacks?.[id];
  for (const [id, pending] of Object.entries(
    state.pendingFreeformReplies ?? {},
  ))
    if (pending === requestId) delete state.pendingFreeformReplies?.[id];
}

/** Status of a settled question. Never renders freeform input: it may carry a credential. */
export function settledText(
  resolution: Resolution,
  labels: Readonly<Record<string, string>>,
): string {
  const option = resolution.response?.optionId;
  if (["ignored", "invalid"].includes(resolution.outcome))
    return tr("Question closed", "Вопрос закрыт");
  if (option !== undefined && Object.hasOwn(labels, option))
    return `${tr("Selected", "Выбрано")}: ${labels[option]}`;
  return resolution.outcome === "denied"
    ? tr("Request declined", "Запрос отклонён")
    : tr("Answer received", "Ответ принят");
}

/** Only the authoritative input.resolved event may settle the preview. */
export async function settleTelegramQuestions(
  resolutions: readonly Resolution[],
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  for (const resolution of resolutions) {
    const preview = previewFor(state, resolution.requestId);
    if (!preview || preview.settledStatus) continue;
    dropCallbacks(state, resolution.requestId);
    preview.settledStatus = literal(
      redactNotice(settledText(resolution, preview.labels)),
    );
  }
  await flushSettledTelegramQuestions(state, tg);
}

function retire(
  state: QuestionState,
  requestId: string,
  preview: QuestionPreview,
): void {
  if (state.questionPreviews?.[requestId] === preview)
    delete state.questionPreviews[requestId];
}

/**
 * One failed delivery per lifecycle. Rotate the retained preview so another
 * accepted question gets the next pass, without another queue or state field.
 * False when the preview is no longer retained.
 */
function rotate(
  state: QuestionState,
  requestId: string,
  preview: QuestionPreview,
): boolean {
  if (state.questionPreviews?.[requestId] !== preview) return false;
  const pending = { ...state.questionPreviews };
  delete pending[requestId];
  state.questionPreviews = { ...pending, [requestId]: preview };
  return true;
}

async function removeNativeKeyboard(
  state: QuestionState,
  tg: Handle,
  requestId: string,
  preview: QuestionPreview,
  error: unknown,
  deadline: number,
): Promise<void> {
  try {
    const removed = await transport(tg, deadline)("editMessageReplyMarkup", {
      chat_id: tg.chatId,
      message_id: preview.messageId,
      reply_markup: { inline_keyboard: [] },
    });
    // A definite text-cap rejection cannot recover by repeating the same edit.
    // Retire only after button removal is confirmed, or the message is unavailable.
    if (
      messageUnavailable(removed) ||
      (error instanceof QuestionStatusTooLong && editLanded(removed))
    )
      retire(state, requestId, preview);
  } catch {
    /* Delivery runs again when the turn completes or resumes. */
  }
}

/** One preview edit; false — the preview moved to the end and this pass is over. */
async function settlePreview(
  state: QuestionState,
  tg: Handle,
  requestId: string,
  preview: QuestionPreview,
  deadline: number,
): Promise<boolean> {
  try {
    await deliverQuestionMessage(
      tg,
      `${preview.prompt}\n\n${preview.settledStatus}`,
      { messageId: preview.messageId, rich: preview.rich, deadline },
    );
    retire(state, requestId, preview);
    return true;
  } catch (error) {
    if (
      preview.rich &&
      error instanceof QuestionStatusTooLong &&
      (preview.prompt.length > QUESTION_PREVIEW_PART_LIMIT ||
        (preview.settledStatus?.length ?? 0) > QUESTION_PREVIEW_PART_LIMIT)
    ) {
      // Shorten the display once; the accepted choice and its label stay intact.
      for (const key of ["prompt", "settledStatus"] as const) {
        const text = preview[key] ?? "";
        if (text.length > QUESTION_PREVIEW_PART_LIMIT)
          preview[key] = text
            .slice(0, QUESTION_PREVIEW_PART_LIMIT)
            .replace(/[\uD800-\uDBFF]$/u, "")
            .replace(/(?<!\\)((?:\\\\)*)\\$/u, "$1");
      }
      return settlePreview(state, tg, requestId, preview, deadline);
    }
    if (error instanceof QuestionMessageUnavailable) {
      retire(state, requestId, preview);
      return true;
    }
    console.error("[telegram] could not settle question preview");
    if (!preview.rich)
      await removeNativeKeyboard(
        state,
        tg,
        requestId,
        preview,
        error,
        deadline,
      );
    return !rotate(state, requestId, preview);
  }
}

/** Delivery recovery uses the accepted status, never the answer or business tool again. */
export async function flushSettledTelegramQuestions(
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  const deadline = performance.now() + QUESTION_EDIT_TIMEOUT_MS;
  for (const [requestId, preview] of Object.entries(
    state.questionPreviews ?? {},
  )) {
    if (performance.now() >= deadline) break;
    if (!preview.settledStatus) continue;
    if (!(await settlePreview(state, tg, requestId, preview, deadline))) break;
  }
}
