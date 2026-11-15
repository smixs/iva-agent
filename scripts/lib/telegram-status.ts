import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { modelSummary } from "./model-summary.ts";
import { redactTelegramBody } from "./notice.ts";
import { screenPayload } from "./telegram-buttons.ts";
import { updateKeepsLine, updaterTooOldMessage } from "./update-check.ts";

type UpdatePhase = "fetch" | "build";
type TelegramJob = {
  chatId: string | number;
  messageId: string | number;
  locale?: string;
};
type TelegramData = {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: { retry_after?: number };
};
type TelegramResponse = {
  ok: boolean;
  status: number;
  json(): Promise<TelegramData>;
};
type TelegramFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TelegramResponse>;
type TelegramError = Error & { status?: number };
type Reporter = {
  start(phase: UpdatePhase): Promise<void>;
  done(phase: UpdatePhase): Promise<void>;
  fail(
    phase: UpdatePhase,
    beforeVersion: string,
    detail?: string,
  ): Promise<void>;
  busy(): Promise<void>;
  /** Refusal before the first phase — the message carries what to fix, in the job's language. */
  badProvider(value: string, accepted: string): Promise<void>;
  /** Refusal before the first write: this tree is somebody's checkout, not an installation. */
  devCheckout(): Promise<void>;
  /** Refusal before the first write: this CLI is older than the release it fetched. */
  updaterTooOld(version: string): Promise<void>;
  postCommitFailure(message: string): Promise<void>;
  /** Отправлено ли «обновление не завершилось»: итог задания, у которого нет вердикта. */
  unfinished(beforeVersion: string, detail?: string): Promise<boolean>;
  /** Whether the user really got the final screen; false is a result to act on. */
  complete(versions: {
    beforeVersion?: string;
    afterVersion: string;
  }): Promise<boolean>;
  dispose(): void;
};

// Сколько причины доезжает в чат. Хвост, а не голова: у сборки и у health-пробы
// последние строки — это и есть отказ, а начало лога всегда одинаковое.
const FAIL_DETAIL_CHARS = 400;

// Animated triangle loader from https://t.me/addemoji/iconemoji1.
// Bots whose owner doesn't have Telegram Premium transparently fall back to ◇.
export const UPDATE_LOADER = {
  alt: "🔺",
  customEmojiId: "5980787993139481991",
  fallback: "◇",
};

const COPY = {
  en: {
    fetch: ["Getting the update", "Update received", "Couldn't get the update"],
    build: ["Building Iva", "Iva built", "Couldn't build Iva"],
    timerFailure:
      "Iva is ready, but the automatic update timer could not be activated",
    busy: "An update is already running",
    badProvider:
      "Fix MODEL_PROVIDER in .env first (iva config) — Iva won't start on this value",
    devCheckout:
      "this is a development checkout (.iva-dev): update it with git, build it with `npm run build`",
    final: "✅ Iva updated",
    unfinished: "⚠️ The update did not finish",
    failure: (version: string) =>
      `Iva is still running ${version}.\nYour settings, memory and skills are where they were.\nRetry: /update`,
  },
  ru: {
    fetch: [
      "Получаю обновление",
      "Обновление получено",
      "Не удалось получить обновление",
    ],
    build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
    timerFailure:
      "Iva готова, но таймер автоматических обновлений не удалось активировать",
    busy: "Обновление уже идёт",
    badProvider:
      "Сначала почини MODEL_PROVIDER в .env (iva config) — на этом значении Iva не стартует",
    devCheckout:
      "это чекаут разработчика (.iva-dev): обновляйся через git, собирай `npm run build`",
    final: "✅ Iva обновлена",
    unfinished: "⚠️ Обновление не завершилось",
    failure: (version: string) =>
      `Iva продолжает работать на ${version}.\nНастройки, память и ваши скиллы на месте.\nПовторить: /update`,
  },
};

export function createTelegramUpdateReporter({
  token,
  job,
  env,
  fetchImpl = fetch,
  sleepImpl,
}: {
  token?: string;
  job?: TelegramJob;
  env?: Record<string, string | undefined>;
  fetchImpl?: TelegramFetch;
  sleepImpl?: (ms: number) => Promise<void>;
} = {}): Reporter | null {
  if (!token || !job?.chatId || !job?.messageId) return null;
  const lang = job.locale === "ru" ? "ru" : "en";
  const copy = COPY[lang];
  const api = `https://api.telegram.org/bot${token}`;
  const activeJob = job;
  let currentMessageId: string | number | null = activeJob.messageId;
  let currentPhase: UpdatePhase | null = null;
  let lastPayload = "";
  let uiLost = false;
  let customEmojiSupported = true;
  const wait =
    sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // The update UI's only way to Telegram, so the outbound Gate stands here: the screens
  // above carry runtime data (the text systemd refused with, a failed build's output) and
  // must not each remember the Gate. The rule is in agent/lib/outbox.ts.
  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const gated = await redactTelegramBody(body);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${api}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(gated),
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await wait(250 * attempt);
        continue;
      }
      const data: TelegramData = await res.json().catch((): TelegramData => ({
        ok: false,
        description: `HTTP ${res.status}`,
      }));
      if (res.ok && data.ok) return data.result;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === 3) {
        const error: TelegramError = new Error(
          data.description || `Telegram ${res.status}`,
        );
        error.status = res.status;
        throw error;
      }
      const retryMs = Math.min(
        5000,
        Math.max(250, Number(data.parameters?.retry_after || 1) * 1000),
      );
      await wait(retryMs);
    }
    throw new Error("Telegram request failed");
  }

  async function edit(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: TelegramError }> {
    if (!currentMessageId) return { ok: false };
    const payload = JSON.stringify(body);
    if (payload === lastPayload) return { ok: true };
    try {
      await call("editMessageText", {
        chat_id: activeJob.chatId,
        message_id: currentMessageId,
        ...body,
      });
      lastPayload = payload;
      return { ok: true };
    } catch (caught) {
      const error = caught as TelegramError;
      if (/message is not modified/i.test(error.message)) {
        lastPayload = payload;
        return { ok: true };
      }
      if (
        /message to edit not found|message can't be edited/i.test(error.message)
      ) {
        currentMessageId = null;
        uiLost = true;
      }
      // Said out loud: a refused edit used to leave nothing behind but the phase
      // it never got past, and the journal of the run that lost the final screen
      // is where anyone looks first.
      console.error("update status edit failed:", error.status, error.message);
      return { ok: false, error };
    }
  }

  async function editActive(text: string): Promise<void> {
    if (customEmojiSupported) {
      const rich = {
        text: `${UPDATE_LOADER.alt} ${text}`,
        entities: [
          {
            type: "custom_emoji",
            offset: 0,
            length: UPDATE_LOADER.alt.length,
            custom_emoji_id: UPDATE_LOADER.customEmojiId,
          },
        ],
      };
      const result = await edit(rich);
      if (result.ok) return;
      if (!currentMessageId) return;
      if (result.error?.status !== 400) return;
      customEmojiSupported = false;
    }
    await edit({ text: `${UPDATE_LOADER.fallback} ${text}` });
  }

  /**
   * The screen the user is left with. Any refused edit is answered with a new
   * message, whatever the reason: a message Telegram will not let this process
   * edit is indistinguishable, from here, from one it lost - and both leave the
   * chat saying an update is still running.
   * Финал — rich message: кнопка «посмотреть конфликты» стоит в самом тексте, рядом со
   * своим пояснением, поэтому отдельной клавиатуры у финального экрана больше нет.
   */
  async function finish(
    markdown: string,
    { silent = false }: { silent?: boolean } = {},
  ): Promise<boolean> {
    const body = screenPayload(markdown);
    if ((await edit(body)).ok) return true;
    try {
      await call("rich_message" in body ? "sendRichMessage" : "sendMessage", {
        chat_id: activeJob.chatId,
        ...body,
        ...(silent ? { disable_notification: true } : {}),
      });
      return true;
    } catch (caught) {
      const error = caught as TelegramError;
      console.error(
        "update status message failed:",
        error.status,
        error.message,
      );
      return false;
    }
  }

  return {
    async start(phase: UpdatePhase) {
      currentPhase = phase;
      if (!uiLost) await editActive(copy[phase][0]);
    },
    done(phase: UpdatePhase) {
      // The next phase replaces this one in the same message. A transient
      // "done" edit would only add API traffic and flicker without preserving history.
      if (currentPhase !== phase) return Promise.resolve();
      currentPhase = null;
      return Promise.resolve();
    },
    // `detail` — почему именно не вышло: сообщение ошибки или хвост health-лога. В терминале
    // причина была всегда, а в чате оставалось голое «Не удалось собрать Iva» — и с ним
    // пользователь мог только жать /update по кругу. Хвост обрезан, и он проходит тот же
    // outbound-Gate, что и всё остальное (redactTelegramBody в call ниже).
    async fail(phase: UpdatePhase, beforeVersion: string, detail?: string) {
      const reason = copy[phase][2];
      currentPhase = null;
      const tail = (detail ?? "").trim().slice(-FAIL_DETAIL_CHARS);
      await finish(
        `⚠️ ${reason}${tail ? `\n\n${tail}` : ""}\n\n${copy.failure(beforeVersion)}`,
      );
    },
    // The tap that finds an update already running: the message it edited must
    // not be left saying the update is under way.
    async busy() {
      currentPhase = null;
      await finish(`⚠️ ${copy.busy}`);
    },
    // Отказ ещё до первой фазы (сломанная конфигурация): сообщение, с которого тап начался,
    // обязано сказать, что чинить, а не остаться на «Обновляю». Текст собирается ЗДЕСЬ, из
    // copy этого репортера: язык у него из job.locale — языка того, кто нажал, — а не из
    // AGENT_LANGUAGE процесса CLI, который на обоих путях апдейта может быть другим.
    async badProvider(value: string, accepted: string) {
      currentPhase = null;
      await finish(
        `⚠️ ${copy.badProvider}: ${JSON.stringify(value)} (${accepted})`,
      );
    },
    // Тап по /update в дереве, которое апдейтеру не принадлежит: сказать это в чат, а не
    // в терминал systemd-run. Иначе мост ждёт лока, которого не будет, и последнее, что
    // видит пользователь, — «Запускаю обновление» на шесть часов.
    async devCheckout() {
      currentPhase = null;
      await finish(`⚠️ ${copy.devCheckout}`);
    },
    // Отказ до первой записи: обновиться сама эта установка уже не может. Текст — тот же,
    // что уходит в терминал, и собирается ЗДЕСЬ, из языка того, кто нажал. Без parse_mode:
    // команда репейра обязана доехать до чата символ в символ.
    async updaterTooOld(version: string) {
      currentPhase = null;
      await finish(`⚠️ ${updaterTooOldMessage(version, lang)}`);
    },
    async postCommitFailure(message: string) {
      currentPhase = null;
      await finish(`⚠️ ${copy.timerFailure}\n\n${message}`);
    },
    // Задание обновления, у которого нет вердикта: обновлятор убит, повтор не прошёл, или
    // срок истёк. Крутилка в чате без этого остаётся навсегда, поэтому экран говорит, что
    // версия на месте и что чинить.
    async unfinished(beforeVersion: string, detail?: string) {
      currentPhase = null;
      const tail = (detail ?? "").trim().slice(-FAIL_DETAIL_CHARS);
      return await finish(
        `⚠️ ${copy.unfinished}${tail ? `\n\n${tail}` : ""}\n\n${copy.failure(beforeVersion)}`,
        { silent: true },
      );
    },
    // The version it started on is not always knowable by whoever delivers this:
    // the reconciler after a restart may have only the version that runs now,
    // and a number the user can read beats a pronoun or an invented arrow.
    async complete({
      beforeVersion,
      afterVersion,
    }: {
      beforeVersion?: string;
      afterVersion: string;
    }): Promise<boolean> {
      const model = modelSummary(env);
      const lines = [
        copy.final,
        "",
        beforeVersion
          ? `${beforeVersion} → ${afterVersion}`
          : `${lang === "ru" ? "Версия" : "Version"}: ${afterVersion}`,
        `${lang === "ru" ? "Модель" : "Model"}: ${model.line}`,
        // Ровно та же строка, что в предложении обновиться: что остаётся на месте и что
        // обновление не переносит. Иначе финал обещал бы сохранность правок в коде Ивы.
        updateKeepsLine(lang),
      ];
      return finish(lines.join("\n"), { silent: true });
    },
    dispose() {},
  };
}

/**
 * A reporter for a job read off disk. Both updaters load the same untrusted JSON,
 * so the cast that admits it lives here, next to the validation it stands on.
 */
export function reporterFor(
  job: unknown,
  token: string | undefined,
  env: Record<string, string | undefined>,
): Reporter | null {
  return createTelegramUpdateReporter({ token, job: job as TelegramJob, env });
}

export async function loadTelegramJob(
  dataDir: string,
  jobId: string | undefined,
): Promise<{ path: string; job: unknown } | null> {
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) return null;
  const path = join(dataDir, "update-jobs", `${jobId}.json`);
  try {
    return { path, job: JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return null;
  }
}

export async function removeTelegramJob(
  path: string | undefined,
): Promise<void> {
  if (path) await rm(path, { force: true }).catch(() => {});
}
