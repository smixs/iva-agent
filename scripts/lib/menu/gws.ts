// Экран «Google» (gws) меню (/menu → 🔗). Подключение Google Workspace CLI `gws`.
// Источник правды по шагам/кодам — agent/skills/google-workspace.md (коды выхода gws:
// 0 ок · 1 ошибка API · 2 НЕ авторизован · 3 неверные аргументы; проверка подключения —
// `gws gmail +triage`). Проба execFile ограничена 1.5с и кэшируется на 60с (единственный
// getUpdates-цикл моста нельзя блокировать дольше).
//
// client_secret.json — секрет: принимаем текстом только в личке (сообщение удаляет движок,
// secret:true), содержимое НЕ печатаем/не логируем; пишем файл 0600.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import {
  startAuth,
  relayCode,
  extractCallbackQuery,
  gwsBin,
  childEnv,
  AUTH_SERVICES,
} from "./gws-auth.ts";
import { button } from "../telegram-buttons.ts";

const SID = "gws";
const PARENT = "r";
const CONFIG_DIR = join(homedir(), ".config/gws");
const SECRET_PATH = join(CONFIG_DIR, "client_secret.json");
const CACHE_TTL_MS = 60_000;
const SCOPES = AUTH_SERVICES.split(",").join(", ");
type AuthStatus = "missing" | "unauth" | "ok";
type GwsAuth = { pid?: number; port?: number; logPath?: string };
type AwaitText = {
  kind: string;
  secret: boolean;
  data?: Record<string, unknown>;
  file?: boolean;
};
type MenuState = {
  chatId: number;
  awaitText: AwaitText | null;
  gwsAuth?: GwsAuth | null;
};
type MenuContext = {
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screen: string) => Promise<void>;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
  };
};
type ClientSecret = {
  installed?: { client_id?: unknown };
  web?: { client_id?: unknown };
};
let cache: { at: number; status: AuthStatus | null } = { at: 0, status: null };

const isPrivate = (st: MenuState) => Number(st.chatId) > 0;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const backLine = (ctx: MenuContext) =>
  `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;
const cancelLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`, "danger")} — ${ctx.tr(
    "leave the login without changes.",
    "выйти из входа, ничего не меняя.",
  )}`;
const connectLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Connect", "Подключить"), `iva_menu:${SID}:do:connect`, "success")} — ${ctx.tr(
    "get a Google link and finish the login.",
    "получить ссылку Google и завершить вход.",
  )}`;
const checkLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Check again", "Проверить"), `iva_menu:${SID}:do:check`)} — ${ctx.tr(
    "re-probe the connection.",
    "проверить подключение заново.",
  )}`;

function errorMessage(error: unknown): string {
  return (error as { readonly message: string }).message;
}

// Проба авторизации. Возвращает "missing" (нет бинаря gws), "unauth" (код 2) или "ok".
// Неавторизованный gws выходит с кодом 2 сразу (без сети); авторизованный `+triage` может
// не уложиться в 1.5с — таймаут трактуем как «похоже, подключено» (код != 2).
function probeAuth(): Promise<AuthStatus> {
  return new Promise((resolve: (status: AuthStatus) => void) => {
    execFile(
      gwsBin(),
      ["gmail", "+triage"],
      { timeout: 1500, encoding: "utf8", env: childEnv() },
      (err) => {
        if (err && err.code === "ENOENT") return resolve("missing");
        const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
        resolve(code === 2 ? "unauth" : "ok");
      },
    );
  });
}

async function authStatus() {
  if (cache.status && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;
  const status = await probeAuth();
  cache = { at: Date.now(), status };
  return status;
}

const invalidate = () => (cache = { at: 0, status: null });

// Прибрать detached-процесс `gws auth login` и его temp-лог (в логе — OAuth-URL).
// Вызывается при повторном «Подключить», при возврате на экран с висящей авторизацией
// и после завершения обмена. Ограничение: если стейт меню испарился целиком (TTL
// tg-flow, рестарт моста), pid потерян — процесс доживает до собственного таймаута gws.
function reapAuth(st: MenuState) {
  const a = st.gwsAuth;
  st.gwsAuth = null;
  if (!a) return;
  if (a.pid) {
    try {
      process.kill(a.pid);
    } catch {
      /* уже завершился */
    }
  }
  if (a.logPath) rm(a.logPath, { force: true }).catch(() => {});
}

function instructions(ctx: MenuContext) {
  const T = ctx.tr;
  const text = [
    `# ${T("🔗 Google Workspace", "🔗 Google Workspace")}`,
    T(
      "No OAuth client yet. In a browser on your computer:",
      "OAuth-клиента ещё нет. В браузере на компьютере:",
    ),
    T(
      "1) console.cloud.google.com → create/pick a project.\n2) OAuth consent screen: External, add yourself to Test users.\n3) Credentials → Create → OAuth client ID → type Desktop app → Download JSON.",
      "1) console.cloud.google.com → создай/выбери проект.\n2) Экран согласия: External, добавь себя в Test users.\n3) Credentials → Create → OAuth client ID → тип Desktop app → скачай JSON.",
    ),
    T(
      "Then paste the downloaded JSON here.",
      "Затем пришли содержимое скачанного JSON сюда.",
    ),
    `${button(
      T("Send client JSON", "Прислать client JSON"),
      `iva_menu:${SID}:do:secret`,
    )} — ${T(
      "paste the JSON or attach the file in a private chat.",
      "вставить JSON или приложить файл в личном чате.",
    )}`,
    backLine(ctx),
  ].join("\n\n");
  return { text };
}

export default {
  parent: PARENT,

  async render(st: MenuState, ctx: MenuContext) {
    const T = ctx.tr;
    // Возврат на экран (отмена, «Назад») с незавершённой авторизацией: awaitText уже снят
    // движком, код принять некому — приберём процесс и лог, а не оставим их висеть.
    if (st.gwsAuth && st.awaitText?.kind !== "gwsauthcode") reapAuth(st);
    if (!existsSync(SECRET_PATH)) return instructions(ctx);

    const status = await authStatus();
    const head = `# ${T("🔗 Google Workspace", "🔗 Google Workspace")}`;

    if (status === "missing") {
      return {
        text: [
          head,
          T(
            "The gws CLI isn't available on the server.",
            "CLI `gws` не найден на сервере.",
          ),
          checkLine(ctx),
          backLine(ctx),
        ].join("\n\n"),
      };
    }
    if (status === "unauth") {
      const text = [
        head,
        T(
          "Client secret is in place, but gws isn't authorized yet.",
          "client_secret.json на месте, но gws ещё не авторизован.",
        ),
        T(
          "Tap «Connect» — I'll give you a Google link and finish the login for you.",
          "Нажми «Подключить» — дам ссылку на Google и завершу вход за тебя.",
        ),
        connectLine(ctx),
        checkLine(ctx),
        backLine(ctx),
      ].join("\n\n");
      return { text };
    }
    // ok. Probing only proves the token works, not which scopes it carries — a token issued before
    // a service was added to AUTH_SERVICES still probes as connected. So name the services the
    // login asks for and keep a re-login button here, the only way to pick up newly added ones.
    const text = [
      head,
      T(
        `✅ Google account connected. Login requests: ${SCOPES}.`,
        `✅ Google-аккаунт подключён. При входе запрашиваются: ${SCOPES}.`,
      ),
      T(
        "Connected before a service was added? Tap «Reconnect» to grant it.",
        "Подключался раньше, чем в список добавился сервис? Нажми «Переподключить», чтобы выдать права.",
      ),
      `${button(T("Reconnect", "Переподключить"), `iva_menu:${SID}:do:connect`)} — ${T(
        "log in again and grant the current service set.",
        "войти заново и выдать текущий набор прав.",
      )}`,
      checkLine(ctx),
      backLine(ctx),
    ].join("\n\n");
    return { text };
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "secret") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            "The client secret is sensitive — open a private chat and send it there.",
            "client_secret — секрет. Открой личный чат и пришли его там.",
          )}\n\n${backLine(ctx)}`,
        );
      }
      st.awaitText = { kind: "gwsjson", secret: true, data: {}, file: true };
      return ctx.flows.screen(
        st,
        [
          `# ${ctx.tr("🔑 Google client secret", "🔑 Google client secret")}`,
          ctx.tr(
            "Send client_secret.json — either paste its contents as text, or attach the .json file. I'll delete the message right away and store it securely.",
            "Пришли client_secret.json — вставь содержимое текстом ИЛИ прикрепи сам .json-файл. Сообщение сразу удалю, файл сохраню безопасно.",
          ),
          cancelLine(ctx),
        ].join("\n\n"),
      );
    }

    if (step === "connect") {
      const T = ctx.tr;
      reapAuth(st); // повторное «Подключить» не должно оставлять прежний detached-процесс
      const challenge = await startAuth();
      if (!challenge) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          [
            `# ${T("🔗 Google Workspace", "🔗 Google Workspace")}`,
            T(
              "Couldn't start gws auth — is the client secret valid? Try again.",
              "Не удалось запустить gws-авторизацию — проверь client_secret и попробуй снова.",
            ),
            connectLine(ctx),
            backLine(ctx),
          ].join("\n\n"),
        );
      }
      // pid и logPath — чтобы отмена/повтор могли убить процесс и удалить лог с OAuth-URL.
      st.gwsAuth = {
        pid: challenge.pid,
        port: challenge.port,
        logPath: challenge.logPath,
      };
      // secret:true — движок удалит сообщение с одноразовым code из чата после приёма.
      st.awaitText = { kind: "gwsauthcode", secret: true };
      const text = [
        `# ${T("🔗 Connecting Google", "🔗 Подключение Google")}`,
        T(
          "1) Open this link, pick your account and approve access:",
          "1) Открой ссылку, выбери аккаунт и подтверди доступ:",
        ),
        challenge.url,
        T(
          "2) Your browser will jump to a http://localhost:… page that WON'T load — that's expected. Copy the WHOLE URL from the address bar and paste it back here.",
          "2) Браузер перекинет на страницу http://localhost:… — она НЕ загрузится, это нормально. Скопируй ВЕСЬ URL из адресной строки и пришли сюда.",
        ),
        cancelLine(ctx),
      ].join("\n\n");
      return ctx.flows.screen(st, text);
    }

    if (step === "check") {
      invalidate();
      // Re-rendering the same status yields an identical message → Telegram "not modified" → the
      // tap looks like it did nothing. Flash a transient "checking…" first so the re-render always
      // differs and the result is visibly refreshed.
      await ctx.flows.screen(st, ctx.tr("⏳ Checking…", "⏳ Проверяю…"));
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Приём client_secret.json текстом. Сообщение уже удалено движком (secret:true).
    // Содержимое НЕ логируем/не печатаем в чат ни при каком исходе; файл пишем 0600.
    async gwsjson(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const raw = String(text).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            "Couldn't parse that as JSON. Send the file contents again or cancel.",
            "Не удалось разобрать JSON. Пришли содержимое файла ещё раз или отмени.",
          )}\n\n${cancelLine(ctx)}`,
        );
      }
      // Форма client_secret.json: корневой ключ installed (Desktop app) или web, с client_id.
      const candidate = parsed as ClientSecret | null | undefined;
      const node = candidate?.installed || candidate?.web;
      if (!node || typeof node.client_id !== "string" || !node.client_id) {
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            "That doesn't look like a client_secret.json (need an installed/web section with client_id). Send it again or cancel.",
            "Это не похоже на client_secret.json (нужен раздел installed/web с client_id). Пришли ещё раз или отмени.",
          )}\n\n${cancelLine(ctx)}`,
        );
      }
      st.awaitText = null;
      try {
        await writeFileAtomic(SECRET_PATH, raw, { mode: 0o600 });
      } catch (error) {
        const message = errorMessage(error);
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            `Couldn't save the file: ${message}`,
            `Не удалось сохранить файл: ${message}`,
          )}\n\n${backLine(ctx)}`,
        );
      }
      invalidate();
      return ctx.flows.screen(
        st,
        [
          ctx.tr(
            "Saved. Now tap «Connect» to log in.",
            "Сохранил. Теперь нажми «Подключить» для входа.",
          ),
          connectLine(ctx),
          backLine(ctx),
        ].join("\n\n"),
      );
    },

    // Приём redirect-URL из браузера после согласия Google. Достаём callback-запрос (в нём code)
    // и локально проигрываем его на loopback-слушателе gws на сервере → gws завершает обмен и
    // сохраняет токен. code одноразовый — сам URL/код не логируем и в чат не печатаем.
    async gwsauthcode(
      text: string,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const T = ctx.tr;
      const auth = st.gwsAuth;
      if (!auth?.port) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          [
            T(
              "That login session expired. Tap «Connect» to start over.",
              "Сессия входа истекла. Нажми «Подключить», чтобы начать заново.",
            ),
            connectLine(ctx),
            backLine(ctx),
          ].join("\n\n"),
        );
      }
      const query = extractCallbackQuery(text);
      if (!query) {
        return ctx.flows.screen(
          st,
          `${T(
            "Couldn't find an authorization code. Paste the whole redirect URL from the address bar, or cancel.",
            "Не нашёл код авторизации. Пришли ВЕСЬ redirect-URL из адресной строки или отмени.",
          )}\n\n${cancelLine(ctx)}`,
        );
      }
      st.awaitText = null;
      st.gwsAuth = null;
      // The pasted message is gone (secret) and relay+probe takes a couple of seconds — a brief
      // working indicator makes the process feel under control before the final status lands.
      await ctx.flows.screen(st, T("⏳ Working…", "⏳ Работаю…"));
      const relay = await relayCode(auth.port, query);
      // Обмен завершён (успех или нет): gws выходит сам, а вот temp-лог с OAuth-URL — наш.
      if (auth.logPath) rm(auth.logPath, { force: true }).catch(() => {});
      if (!relay.ok) {
        return ctx.flows.screen(
          st,
          [
            T(
              "Couldn't hand the code to gws (the login window likely timed out). Tap «Connect» to try again.",
              "Не удалось передать код gws (окно входа, вероятно, истекло по таймауту). Нажми «Подключить» и попробуй снова.",
            ),
            connectLine(ctx),
            backLine(ctx),
          ].join("\n\n"),
        );
      }
      await sleep(2500); // let gws exchange the code and write the token before we re-probe
      invalidate();
      // A final status is mandatory — always edit the menu message to an explicit outcome, so the
      // user never has to guess whether the login finished. (The op is short; no working spinner.)
      if ((await authStatus()) === "ok") {
        return ctx.flows.screen(
          st,
          `${T(
            `✅ Google account connected. Scopes: ${SCOPES}.`,
            `✅ Google-аккаунт подключён. Права: ${SCOPES}.`,
          )}\n\n${backLine(ctx)}`,
        );
      }
      return ctx.flows.screen(
        st,
        [
          T(
            "⚠️ Couldn't confirm the connection. Tap «Connect» to try again.",
            "⚠️ Не удалось подтвердить подключение. Нажми «Подключить» и попробуй снова.",
          ),
          connectLine(ctx),
          backLine(ctx),
        ].join("\n\n"),
      );
    },
  },
};
