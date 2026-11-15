// Экран «Память» (core memory) меню (/menu → 💾). Показывает выдержку из vault/CORE.md и
// проводит интервью из 6 свободных вопросов. Мост НЕ дистиллирует сам: он сохраняет сырые
// ответы (core-interview.ts → vault/core-interview.md) и отдаёт их иве синтетическим
// сообщением buildDistillMessage — она своими инструментами ужимает их в ядро и обновляет
// vault/CORE.md (лимит 1200 симв. — забота модели). Так формат ядра не знает ни мост, ни экран.
//
// ВАЖНО про синтетический deliver: он идёт в eve в обход busy-гейта моста
// (scripts/poller/control.ts).
// Если по чату уже идёт ход, второй синтетический апдейт конфликтует с активной сессией.
// Поэтому перед deliver ОБЯЗАТЕЛЬНА проверка isRunning(chatKey): занято → не доставляем, а
// честно говорим сохранить и повторить, когда ива освободится.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  INTERVIEW,
  saveInterview,
  buildDistillMessage,
  readInterviewRecovery,
} from "../core-interview.ts";
import { isRunning, chatKeyOf } from "#lib/run-status.ts";
import {
  VaultDirError,
  resolveVaultDir,
} from "../../../packages/vault-dir/index.ts";
import { button, escapeRichText, menuBackLine } from "../telegram-buttons.ts";
import { readSettings, writeSettings } from "#lib/settings.ts";

const SID = "core";
const PARENT = "r";
const EXCERPT_LIMIT = 400;

type Lang = "en" | "ru";
type Interview = {
  i: number;
  qa: Array<{ q: string; a: string }>;
  chat: Record<string, unknown> | null;
  from: Record<string, unknown> | null;
  threadId: number | null;
};
type MenuState = {
  chatId: number;
  userId: string;
  msgId?: number | null;
  data: { iv?: Interview };
  awaitText: {
    kind: string;
    secret: boolean;
    data: Record<string, unknown>;
  } | null;
};
type CallbackIdentity = {
  updateId: number;
  callbackId: string;
  chatId: number;
  messageId: number;
  userId: string;
};
type RecoveryRecord = {
  version: 1;
  source: CallbackIdentity;
  update: SyntheticUpdate;
};
type SyntheticUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: Record<string, unknown>;
    from: Record<string, unknown>;
    text: string;
    message_thread_id?: number;
  };
};
type MenuContext = {
  deps: {
    deliver: (update: SyntheticUpdate) => Promise<unknown>;
    admitSynthetic: (update: SyntheticUpdate) => Promise<boolean>;
    log?: (...parts: unknown[]) => void;
  };
  getLang: () => string;
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
  };
};

function errorMessage(error: unknown): string {
  return (error as { readonly message: string }).message;
}

function identityId(value: unknown, fallback: string | number): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return `${value}`;
  return `${fallback}`;
}

function legacySyntheticIdentity(
  st: MenuState,
  iv: Interview,
  text: string,
): number {
  const digest = createHash("sha256")
    .update("iva-core-distillation/v1\0")
    .update(identityId(iv.chat?.id, st.chatId))
    .update("\0")
    .update(identityId(iv.from?.id, st.userId))
    .update("\0")
    .update(String(iv.threadId ?? ""))
    .update("\0")
    .update(text)
    .digest();
  return digest.readUIntBE(0, 6) || 1;
}

function callbackSyntheticIdentity(source: CallbackIdentity): number {
  const digest = createHash("sha256")
    .update("iva-core-distillation/callback/v1\0")
    .update(String(source.updateId))
    .update("\0")
    .update(source.callbackId)
    .update("\0")
    .update(String(source.chatId))
    .update("\0")
    .update(String(source.messageId))
    .update("\0")
    .update(source.userId)
    .digest();
  return digest.readUIntBE(0, 6) || 1;
}

function validCallbackIdentity(value: unknown): value is CallbackIdentity {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Partial<CallbackIdentity>;
  return (
    Number.isSafeInteger(source.updateId) &&
    typeof source.callbackId === "string" &&
    source.callbackId.length > 0 &&
    source.callbackId.length <= 256 &&
    Number.isSafeInteger(source.chatId) &&
    Number.isSafeInteger(source.messageId) &&
    typeof source.userId === "string" &&
    source.userId.length > 0
  );
}

function sameCallbackIdentity(
  left: CallbackIdentity,
  right: CallbackIdentity,
): boolean {
  return (
    left.updateId === right.updateId &&
    left.callbackId === right.callbackId &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.userId === right.userId
  );
}

function recoveryRecord(
  value: unknown,
  expected: CallbackIdentity,
): RecoveryRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<RecoveryRecord>;
  if (
    candidate.version !== 1 ||
    !validCallbackIdentity(candidate.source) ||
    !sameCallbackIdentity(candidate.source, expected) ||
    typeof candidate.update !== "object" ||
    candidate.update === null
  ) {
    return null;
  }
  const update = candidate.update;
  const identity = callbackSyntheticIdentity(expected);
  if (
    update.update_id !== -identity ||
    update.message?.message_id !== identity ||
    !Number.isSafeInteger(update.message?.date) ||
    typeof update.message?.text !== "string" ||
    typeof update.message?.chat !== "object" ||
    update.message.chat === null ||
    typeof update.message?.from !== "object" ||
    update.message.from === null
  ) {
    return null;
  }
  return candidate as RecoveryRecord;
}

async function readMatchingRecovery(
  source: CallbackIdentity,
): Promise<RecoveryRecord | null> {
  return recoveryRecord(
    await readInterviewRecovery(resolveVaultDir(process.cwd())),
    source,
  );
}

async function admitOrRetry(update: SyntheticUpdate, ctx: MenuContext) {
  try {
    return (await ctx.deps.admitSynthetic(update)) === true ? true : "retry";
  } catch (error) {
    ctx.deps.log?.("core synthetic admission error:", errorMessage(error));
    return "retry";
  }
}

async function coreExcerpt(): Promise<{
  text: string | null;
  error: string | null;
}> {
  try {
    const text = (
      await readFile(join(resolveVaultDir(process.cwd()), "CORE.md"), "utf8")
    ).trim();
    if (!text) return { text: null, error: null };
    return {
      text:
        text.length > EXCERPT_LIMIT
          ? `${text.slice(0, EXCERPT_LIMIT).trimEnd()}…`
          : text,
      error: null,
    };
  } catch (error) {
    // Неверная настройка вольта — это не «ядро пусто»: экран обязан назвать причину.
    if (error instanceof VaultDirError)
      return { text: null, error: error.message };
    return { text: null, error: null }; // файла нет / нет доступа — ядро пусто
  }
}

// Экран одного вопроса интервью: ставит awaitText{kind:"interview"} (движок отдаст следующий
// текст в texts.interview) и показывает кнопки [Пропустить]/[Завершить]. Ответы не секретны —
// движок их не удаляет; в eve/дневник они не попадают, только в vault через saveInterview.
function renderInterviewQuestion(st: MenuState, ctx: MenuContext) {
  const iv = st.data.iv;
  if (!iv) return ctx.show(st, SID);
  const i = iv.i;
  const lang: Lang = ctx.getLang() === "en" ? "en" : "ru";
  const q = INTERVIEW[i];
  st.awaitText = { kind: "interview", secret: false, data: {} };
  const text = [
    `# ${ctx.tr(
      `💾 Core memory · ${i + 1}/${INTERVIEW.length}`,
      `💾 Память · ${i + 1}/${INTERVIEW.length}`,
    )}`,
    q.text[lang] ?? q.text.ru,
    ctx.tr(
      "Reply with text, or skip / finish below.",
      "Ответь текстом, или пропусти / заверши кнопкой ниже.",
    ),
    `${button(ctx.tr("Skip", "Пропустить"), `iva_menu:${SID}:skip`)} — ${ctx.tr(
      "leave this one and move on.",
      "оставить этот вопрос и идти дальше.",
    )}`,
    `${button(ctx.tr("Finish", "Завершить"), `iva_menu:${SID}:fin`)} — ${ctx.tr(
      "stop here and send what you've answered.",
      "остановиться и отдать уже отвеченное.",
    )}`,
    menuBackLine(ctx, PARENT),
  ].join("\n\n");
  return ctx.flows.screen(st, text);
}

// Записать ответ (или пропуск) и перейти к следующему вопросу; после последнего — завершить.
function advance(st: MenuState, ctx: MenuContext, answer: string) {
  const iv = st.data.iv;
  if (!iv) return ctx.show(st, SID);
  const i = iv.i;
  const lang: Lang = ctx.getLang() === "en" ? "en" : "ru";
  iv.qa.push({
    q: INTERVIEW[i].text[lang] ?? INTERVIEW[i].text.ru,
    a: answer,
  });
  iv.i = i + 1;
  if (iv.i < INTERVIEW.length) return renderInterviewQuestion(st, ctx);
  return finish(st, ctx);
}

// Завершение: сохранить сырой архив и (если ива свободна) отдать ответы на дистилляцию.
async function finish(
  st: MenuState,
  ctx: MenuContext,
  source?: CallbackIdentity,
) {
  st.awaitText = null;
  const iv: Interview = st.data.iv ?? {
    i: 0,
    qa: [],
    chat: null,
    from: null,
    threadId: null,
  };
  const qa = iv.qa;
  const lang: Lang = ctx.getLang() === "en" ? "en" : "ru";
  if (source) {
    try {
      const existing = await readMatchingRecovery(source);
      if (existing) return admitOrRetry(existing.update, ctx);
    } catch (error) {
      ctx.deps.log?.("core recovery read error:", errorMessage(error));
      return "retry";
    }
  }

  const threadId = iv.threadId;
  const from = iv.from ?? { id: Number(st.userId), is_bot: false };
  const chat = iv.chat ?? {
    id: st.chatId,
    type: Number(st.chatId) > 0 ? "private" : "supergroup",
  };
  const text = buildDistillMessage(qa, lang);
  const identity = source
    ? callbackSyntheticIdentity(source)
    : legacySyntheticIdentity(st, iv, buildDistillMessage(qa, "en"));
  const message = {
    message_id: identity,
    date: Math.floor(identity / 100_000) || 1,
    chat,
    from,
    text,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  };
  const update = { update_id: -identity, message };
  const record: RecoveryRecord | undefined = source
    ? { version: 1, source, update }
    : undefined;
  try {
    await saveInterview(resolveVaultDir(process.cwd()), qa, record);
  } catch (error) {
    const message = errorMessage(error);
    return ctx.flows.screen(
      st,
      `${ctx.tr(
        `Couldn't save the interview: ${message}`,
        `Не удалось сохранить интервью: ${message}`,
      )}\n\n${menuBackLine(ctx, PARENT)}`,
    );
  }

  // chatKey как у continuation-hook eve: threadId берём из реального сообщения ответа, если
  // оно было (иначе главный чат). Занятость проверяем ПЕРЕД deliver — иначе HookConflict.
  const key = chatKeyOf(st.chatId, threadId);
  if (isRunning(key)) {
    return ctx.flows.screen(
      st,
      `${ctx.tr(
        "Answers saved to vault/core-interview.md. Iva is busy right now — send her «update your memory core» once she's free.",
        "Ответы сохранены в vault/core-interview.md. Ива сейчас занята — напиши ей «обнови ядро памяти», когда освободится.",
      )}\n\n${menuBackLine(ctx, PARENT)}`,
    );
  }

  // Синтетическое сообщение «от имени юзера» (как /stop синтезирует callback в
  // scripts/poller/control.ts).
  // Реальные chat/from стэшим из ответа интервью; при пустом интервью синтезируем из st.
  let delivered: unknown;
  try {
    delivered = await ctx.deps.deliver(update);
  } catch (error) {
    ctx.deps.log?.("core deliver error:", errorMessage(error));
  }
  if (delivered === true) {
    await ctx.flows.screen(
      st,
      `${ctx.tr(
        "Sent to Iva — she'll distill your answers into the memory core and confirm.",
        "Передал иве — она сожмёт ответы в ядро памяти и подтвердит.",
      )}\n\n${menuBackLine(ctx, PARENT)}`,
    );
    return true;
  }
  const admitted = await admitOrRetry(update, ctx);
  return source ? admitted : admitted === true;
}

export default {
  parent: PARENT,

  async render(st: MenuState, ctx: MenuContext) {
    const excerpt = await coreExcerpt();
    const T = ctx.tr;
    // Тексты ошибок — не данные пользователя: их не экранируем (обратный слэш в имени
    // переменной сломал бы и сырой текст, и outbound-гейт, который читает ту же строку).
    const body = excerpt.error
      ? `${T("Vault is misconfigured:", "Хранилище не настроено:")} ${excerpt.error}`
      : excerpt.text
        ? `${T("Current core:", "Текущее ядро:")}\n\n${escapeRichText(excerpt.text)}`
        : T("The memory core is empty.", "Ядро памяти пусто.");
    const configured = (
      readSettings().memory as { night?: unknown } | undefined
    )?.night;
    const nightOn = configured !== "off";
    const text = [
      `# ${T("💾 Memory core", "💾 Ядро памяти")}`,
      body,
      `${button(T("Take the interview", "Пройти интервью"), `iva_menu:${SID}:go`)} — ${T(
        "the interview asks 6 questions; Iva turns your answers into the core.",
        "интервью — 6 вопросов; ответы ива сама превратит в ядро.",
      )}`,
      `${button(
        nightOn
          ? T("🌙 Night: on", "🌙 Ночь: вкл")
          : T("🌙 Night: off", "🌙 Ночь: выкл"),
        `iva_menu:${SID}:night`,
      )} — ${T("toggle code-driven nightly memory.", "включить или остановить ночную память.")}`,
      menuBackLine(ctx, PARENT),
    ].join("\n\n");
    return { text };
  },

  async on(
    ...input: [string, string[], MenuState, MenuContext, CallbackIdentity?]
  ) {
    const [verb, _args, st, ctx, event] = input;
    void _args;
    if (verb === "night") {
      const current = readSettings();
      const memory =
        typeof current.memory === "object" && current.memory !== null
          ? (current.memory as Record<string, unknown>)
          : {};
      writeSettings({
        memory: { ...memory, night: memory.night === "off" ? "on" : "off" },
      });
      return ctx.show(st, SID);
    }
    if (verb === "go") {
      st.data.iv = { i: 0, qa: [], chat: null, from: null, threadId: null };
      return renderInterviewQuestion(st, ctx);
    }
    if (!st.data.iv) return ctx.show(st, SID); // skip/fin без активного интервью — назад в выдержку
    if (verb === "skip") return advance(st, ctx, ""); // пустой ответ = пропуск (архив покажет прочерк)
    if (verb === "fin") return finish(st, ctx, event);
    return ctx.show(st, SID);
  },

  async recover(
    verb: string,
    _args: string[],
    source: CallbackIdentity,
    ctx: MenuContext,
  ) {
    if (verb !== "fin") return undefined;
    try {
      const record = await readMatchingRecovery(source);
      if (!record) return "retry";
      return admitOrRetry(record.update, ctx);
    } catch (error) {
      ctx.deps.log?.("core recovery read error:", errorMessage(error));
      return "retry";
    }
  },

  texts: {
    // Свободный ответ на вопрос интервью (не секрет — движок не удаляет). Стэшим реальные
    // chat/from/thread для будущего синтетического deliver, пишем ответ, идём дальше.
    async interview(
      text: unknown,
      msg: {
        chat: Record<string, unknown>;
        from: Record<string, unknown>;
        message_thread_id?: number;
      },
      st: MenuState,
      ctx: MenuContext,
    ) {
      if (!st.data.iv) return ctx.show(st, SID);
      st.data.iv.chat = msg.chat;
      st.data.iv.from = msg.from;
      st.data.iv.threadId = msg.message_thread_id ?? null;
      return advance(st, ctx, String(text).trim());
    },
  },
};
