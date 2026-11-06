import { randomInt } from "node:crypto";
import { chatKeyOf, getChatStatus, setChatStatusIf } from "./run-status.ts";
import { scanOutbound } from "./security-gate.ts";
import { traceOutboundGate, traceWithScope } from "./trace.ts";
import { parseTelegramDelivery } from "./telegram-delivery.ts";
import { tr } from "./i18n.ts";

export const DRAFT_INTERVAL_MS = 1_000;
export const DRAFT_REFRESH_MS = 20_000;
export const TYPING_INTERVAL_MS = 4_500;
export const DRAFT_TIMEOUT_MS = 10_000;

export type TelegramDraftHandle = {
  readonly chatId: string;
  readonly messageThreadId?: number;
  request(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }>;
};
type Identity = { sessionId: string; turnId: string; draftId: number };
type Status = Record<string, unknown> | null;
type Action = {
  callId: string;
  toolName?: string;
  kind?: string;
  input?: unknown;
};

/** The two temporary Bot API methods have a deadline; final Outbox requests retain their own policy. */
export function telegramDraftFetch(fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) => {
    const send = fetchImpl ?? globalThis.fetch;
    const url = input instanceof Request ? input.url : String(input);
    if (!/\/(sendRichMessageDraft|sendChatAction)(?:\?|$)/u.test(url))
      return send(input, init);
    const deadline = AbortSignal.timeout(DRAFT_TIMEOUT_MS);
    const existing =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return send(input, {
      ...init,
      signal: existing ? AbortSignal.any([existing, deadline]) : deadline,
    });
  };
}

/** Render only completed tokens, strip delivery markup, and reopen the fence at the tail cut. */
export function draftText(text: string, complete: boolean): string {
  if (!complete)
    text = text.slice(
      0,
      Math.max(
        text.lastIndexOf(" "),
        text.lastIndexOf("\n"),
        text.lastIndexOf("\t"),
      ) + 1,
    );
  text = parseTelegramDelivery(text).text;
  text = text
    .replace(/<tg-button(?=[\s>])[^>]*>([\s\S]*?)<\/tg-button>/gi, "[$1]")
    .replace(/<\/?tg-button-row\b[^>]*>/gi, "");
  const unfinished = text.search(/<tg-button\b[\s\S]*$/iu);
  if (unfinished >= 0) text = text.slice(0, unfinished);
  const start = text.lastIndexOf("<");
  if (
    start >= 0 &&
    ["<!-- iva:silent -->", "<tg-button", "<tg-button-row"].some((marker) =>
      marker.startsWith(text.slice(start)),
    )
  )
    text = text.slice(0, start);
  if (text.length > 3500) {
    let cut = text.length - 3500;
    if (/[\uDC00-\uDFFF]/u.test(text[cut] ?? "")) cut++;
    let fence: { line: string; marker: string } | undefined;
    for (const line of text.slice(0, cut).split("\n")) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (!match) continue;
      const marker = match[1];
      if (fence === undefined) {
        if (marker[0] === "`" && match[2].includes("`")) continue;
        fence = { line: line.trim(), marker };
      } else if (
        marker[0] === fence.marker[0] &&
        marker.length >= fence.marker.length &&
        match[2].trim() === ""
      )
        fence = undefined;
    }
    text = `${fence === undefined ? "" : `${fence.line}\n`}…${text.slice(cut)}`;
  }
  return text.trim();
}

function toolHint(action: Action, cleanArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(cleanArgs) as Record<string, unknown>;
  } catch {
    /* redacted JSON can be incomplete */
  }
  const name = action.toolName ?? action.kind ?? "tool";
  const command =
    name === "bash" && typeof args?.command === "string" ? args.command : "";
  // Recognize literal prefixes only; unknown syntax keeps just the tool name.
  const prefix =
    /^\s*(?:(?:[A-Za-z_]\w*=(?:"[^"\\$`]*"|'[^']*'|[^\s"';&|$`()<>]+)\s+|cd\s+(?:--\s+)?(?:"[^"\\$`]*"|'[^']*'|[^\s"';&|$`()<>]+)\s*&&\s*|(?:[A-Za-z0-9_./+-]+\/)?(?:env(?:\s+-i)?\s+|timeout(?:\s+--foreground)?\s+\d+(?:\.\d+)?[smhd]?\s+|sudo(?:\s+-(?:[nEH]|u\s+[A-Za-z0-9_-]+))*\s+))\s*)*/u;
  const head =
    /^\s*(?:"([^"\\$`]+)"|'([^']+)'|([A-Za-z0-9_./+-]+))(?=\s|[;&|]|$)/u.exec(
      command.replace(prefix, ""),
    );
  const word = head?.[1] ?? head?.[2] ?? head?.[3] ?? "";
  const program = /^[A-Za-z0-9_./ +-]+$/u.test(word)
    ? (word.split("/").pop() ?? "")
    : "";
  const detail = /^(?!(?:cd|env|sudo|timeout)$)[A-Za-z_][\w.+-]*$/u.test(
    program,
  )
    ? `: ${program}`
    : "";
  let line = `${name}${detail}`.replace(/\s+/gu, " ").trim().slice(0, 60);
  if (/[\uD800-\uDBFF]$/u.test(line)) line = line.slice(0, -1);
  const escaped = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;");
  return `⚙ <code>${escaped}</code>`;
}

export class TelegramDraftStream {
  readonly chatKey: string;
  readonly #tg: TelegramDraftHandle;
  readonly #matches: (status: Status) => boolean;
  readonly #getStatus: () => Status;
  readonly #identity?: Identity;
  readonly #now: () => number;
  readonly #onLost: () => void;
  #closed = false;
  #enabled: boolean;
  #shown = false;
  #failures = 0;
  #step = -1;
  #text = "";
  #complete = false;
  #tools = new Map<string, string>();
  #flagged = false;
  #latest = "";
  #sent?: string;
  #sentAt = -Infinity;
  #pauseUntil = 0;
  #inFlight?: Promise<void>;
  #typing?: ReturnType<typeof setInterval>;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    tg: TelegramDraftHandle,
    options: {
      identity?: Identity;
      enabled?: boolean;
      matches: (status: Status) => boolean;
      getStatus?: () => Status;
      now?: () => number;
      onLost?: () => void;
    },
  ) {
    this.#tg = tg;
    this.chatKey = chatKeyOf(tg.chatId, tg.messageThreadId);
    this.#identity = options.identity;
    this.#enabled = options.enabled === true;
    this.#matches = options.matches;
    this.#getStatus =
      options.getStatus ??
      (() => getChatStatus(chatKeyOf(tg.chatId, tg.messageThreadId)));
    this.#now = options.now ?? Date.now;
    this.#onLost = options.onLost ?? (() => {});
    this.#tick();
    if (this.#closed) return;
    this.#typing = setInterval(() => this.#tick(), TYPING_INTERVAL_MS).unref();
    this.#push();
  }

  get closed(): boolean {
    return this.#closed;
  }

  #tick(): void {
    if (this.#closed) return;
    try {
      if (!this.#matches(this.#getStatus())) {
        this.#onLost();
        void this.close(0);
        return;
      }
    } catch {
      this.#onLost();
      void this.close(0);
      return;
    }
    void this.#tg
      .request("sendChatAction", {
        chat_id: this.#tg.chatId,
        action: "typing",
        ...(this.#tg.messageThreadId === undefined
          ? {}
          : { message_thread_id: this.#tg.messageThreadId }),
      })
      .catch(() => {});
  }

  #guard(text: string): string {
    const guard = scanOutbound(text);
    if (!guard.clean && !this.#flagged && this.#identity) {
      this.#flagged = true;
      traceWithScope(
        {
          turn: this.#identity.turnId,
          session: this.#identity.sessionId,
          source: "telegram",
        },
        () => traceOutboundGate(false, guard.findings, text.length, guard.text),
      );
    }
    return guard.text;
  }

  #selectStep(step: number): void {
    if (step === this.#step) return;
    this.#step = step;
    this.#text = "";
    this.#complete = false;
  }

  append(step: number, delta: string): void {
    if (this.#closed || step < this.#step) return;
    this.#selectStep(step);
    this.#text += delta;
    this.#push();
  }

  completeStep(step: number, text: string): void {
    if (this.#closed || step < this.#step) return;
    this.#selectStep(step);
    this.#text = text;
    this.#complete = true;
    this.#push();
  }

  requested(step: number, actions: readonly Action[]): void {
    if (this.#closed || step < this.#step) return;
    this.#selectStep(step);
    for (const action of actions)
      this.#tools.set(
        action.callId,
        toolHint(
          action,
          JSON.stringify(action.input ?? {}, (_key, value: unknown) =>
            typeof value === "string" ? this.#guard(value) : value,
          ),
        ),
      );
    this.#push();
  }

  result(callId: string): void {
    this.#tools.delete(callId);
    this.#push();
  }

  #push(): void {
    if (this.#closed || !this.#enabled) return;
    const body = draftText(this.#guard(this.#text), this.#complete);
    const hint = this.#tools.values().next().value;
    this.#latest =
      [body, hint].filter(Boolean).join("\n\n") ||
      `<tg-thinking>${tr("Thinking…", "Думаю…")}</tg-thinking>`;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#closed || !this.#enabled || this.#inFlight || this.#timer) return;
    const changed = this.#latest !== this.#sent;
    const due = changed
      ? this.#sentAt + DRAFT_INTERVAL_MS
      : this.#sentAt + DRAFT_REFRESH_MS;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (this.#closed || !this.#enabled) return;
        this.#sentAt = this.#now();
        this.#inFlight = this.#send(this.#latest).finally(() => {
          this.#inFlight = undefined;
          this.#schedule();
        });
      },
      Math.max(0, due - this.#now(), this.#pauseUntil - this.#now()),
    ).unref();
  }

  async #send(markdown: string): Promise<void> {
    try {
      const response = await this.#tg.request("sendRichMessageDraft", {
        chat_id: this.#tg.chatId,
        draft_id: this.#identity?.draftId,
        rich_message: { markdown },
        can_stop: true,
      });
      const body = response.body as {
        ok?: boolean;
        error_code?: number;
        parameters?: { retry_after?: number };
      } | null;
      if (response.ok && body?.ok !== false) {
        this.#shown = true;
        this.#failures = 0;
        this.#sent = markdown;
      } else if (body?.error_code === 429) {
        this.#sent = undefined;
        this.#pauseUntil =
          this.#now() + Math.max(1, body.parameters?.retry_after ?? 1) * 1000;
      } else if (!this.#shown || ++this.#failures >= 3) this.#enabled = false;
    } catch {
      this.#sent = undefined;
      /* A network failure skips this frame; the deadline is on api.fetch. */
    }
  }

  async close(waitMs = DRAFT_TIMEOUT_MS): Promise<number> {
    this.#closed = true;
    clearInterval(this.#typing);
    clearTimeout(this.#timer);
    this.#typing = undefined;
    this.#timer = undefined;
    if (this.#inFlight && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#inFlight,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs).unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.#pauseUntil;
  }
}

const turns = new Map<string, TelegramDraftStream>();
const accepted = new Map<
  string,
  { ingressId: string; stream: TelegramDraftStream }
>();
const turnKey = (sessionId: string, turnId: string) =>
  JSON.stringify([sessionId, turnId]);

export function startTelegramAcceptedTyping(
  tg: TelegramDraftHandle,
  ingressId: string,
): void {
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  void accepted.get(key)?.stream.close(0);
  const stream = new TelegramDraftStream(tg, {
    matches: (st) =>
      st?.status === "running" &&
      st.ingressId === ingressId &&
      st.sessionId === undefined,
    onLost: () => {
      if (accepted.get(key)?.ingressId === ingressId) accepted.delete(key);
    },
  });
  if (!stream.closed) accepted.set(key, { ingressId, stream });
}

export function closeTelegramAcceptedTyping(
  tg: TelegramDraftHandle,
  ingressId?: string,
): void {
  const key = chatKeyOf(tg.chatId, tg.messageThreadId);
  const known = accepted.get(key);
  if (!known || (ingressId !== undefined && known.ingressId !== ingressId))
    return;
  void known.stream.close(0);
  accepted.delete(key);
}

export function telegramDraftTurn(
  tg: TelegramDraftHandle,
  sessionId: string,
  turnId: string,
  enabled: boolean,
  identity?: Identity,
  published = true,
): TelegramDraftStream | undefined {
  const key = turnKey(sessionId, turnId);
  const known = turns.get(key);
  if (known) return known;
  const chatKey = chatKeyOf(tg.chatId, tg.messageThreadId);
  // A workflow resumed after process restart can emit deltas without another turn.started.
  if (!identity) {
    const st = getChatStatus(chatKey);
    if (
      st?.status !== "running" ||
      st.sessionId !== sessionId ||
      st.turnId !== turnId
    )
      return;
    identity = { sessionId, turnId, draftId: randomInt(1, 2 ** 31) };
    if (
      !setChatStatusIf(
        chatKey,
        { status: "running", sessionId, turnId },
        { draftId: identity.draftId },
      )
    )
      return;
  }
  closeTelegramAcceptedTyping(tg);
  const pair = identity;
  const snapshot = published ? undefined : getChatStatus(chatKey);
  const stream = new TelegramDraftStream(tg, {
    identity: pair,
    enabled,
    onLost: () => {
      const lost = turns.get(key);
      void lost?.close().then(() => {
        if (turns.get(key) === lost) turns.delete(key);
      });
    },
    matches: (st) =>
      published
        ? st?.status === "running" &&
          st.sessionId === pair.sessionId &&
          st.turnId === pair.turnId &&
          st.draftId === pair.draftId
        : [
            "status",
            "sessionId",
            "turnId",
            "draftId",
            "resetAt",
            "ingressId",
          ].every((field) => st?.[field] === snapshot?.[field]),
  });
  if (!stream.closed) turns.set(key, stream);
  return stream;
}

export async function closeTelegramDraftTurn(
  sessionId: string,
  turnId?: string,
  waitMs = DRAFT_TIMEOUT_MS,
  forget = false,
): Promise<void> {
  for (const [key, stream] of turns) {
    const [session, turn] = JSON.parse(key) as [string, string];
    if (session !== sessionId || (turnId !== undefined && turn !== turnId))
      continue;
    const pauseUntil = await stream.close(waitMs);
    if (forget) {
      if (waitMs < DRAFT_TIMEOUT_MS)
        void stream.close().then(() => {
          if (turns.get(key) === stream) turns.delete(key);
        });
      else turns.delete(key);
    }
    if (waitMs === DRAFT_TIMEOUT_MS && pauseUntil > Date.now())
      await new Promise<void>((resolve) =>
        setTimeout(resolve, pauseUntil - Date.now()),
      );
  }
}

export async function closeTelegramDraftChat(
  tg: TelegramDraftHandle,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await closeTelegramDraftTurn(sessionId, turnId);
  for (const stream of turns.values()) {
    if (
      stream.chatKey !== chatKeyOf(tg.chatId, tg.messageThreadId) ||
      !stream.closed
    )
      continue;
    const pauseUntil = await stream.close();
    if (pauseUntil > Date.now())
      await new Promise<void>((resolve) =>
        setTimeout(resolve, pauseUntil - Date.now()),
      );
  }
}

export async function finishTelegramStatus(
  channel: { telegram: TelegramDraftHandle },
  sessionId: string,
  mode: "completed" | "cancelled" | "failed",
  turnId?: string,
  keepBusy = false,
): Promise<boolean> {
  await closeTelegramDraftTurn(
    sessionId,
    turnId,
    mode === "cancelled" ? 2_000 : DRAFT_TIMEOUT_MS,
    true,
  );
  return Boolean(
    setChatStatusIf(
      chatKeyOf(channel.telegram.chatId, channel.telegram.messageThreadId),
      { sessionId, ...(turnId === undefined ? {} : { turnId }) },
      {
        status: "idle",
        sessionId: null,
        turnId: null,
        draftId: null,
        compacting: null,
        ingressId: null,
        ingressAt: null,
        turnAt: null,
        firstOutputAt: null,
        latencyLogged: null,
        ...(keepBusy ? { status: "running", sessionId, compacting: true } : {}),
      },
    ),
  );
}
