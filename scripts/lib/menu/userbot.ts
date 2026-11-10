import { serviceManager } from "../service-manager.ts";
import { runLaunchd } from "../launchd.ts";
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable exec boundary source-compatible. */
// Экран «Userbot» меню (/menu → 📡). Статус личного userbot-прокси (Telegram) + подключение.
// Общая CLI/Telegram-проба проверяет systemd, health endpoint и авторизацию Telethon.
// Общий таймаут 1.5с: getUpdates-цикл нельзя блокировать дольше.
// Наличие creds — булевы TELEGRAM_API_ID/TELEGRAM_API_HASH из .env (значения не показываем).
//
// Секреты (api_id/api_hash) принимаются только в личке; сообщение с ними удаляет движок
// (secret:true) до texts.ubcred. Значения не попадают в лог/eve/текст. Пишем через upsertEnv.
// Включение — отсоединённый `iva userbot setup` (сборка venv медленная, до 3 мин): не ждём
// синхронно, показываем заглушку и перерисовываем экран по завершении.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readEnvValues, upsertEnv } from "../env-file.ts";
import { resolveDataDir } from "../data-dir.ts";
import { probeUserbotHealth } from "../userbot-health.ts";
import { button } from "../telegram-buttons.ts";

type ErrorLike = { code?: unknown; message?: unknown };
type Health = { state: string };
type MenuState = {
  chatId: number | string;
  userId: string;
  screen: string;
  data: { ub?: { apiId?: string } | null };
  awaitText?: { kind: string; secret: boolean; data: { step?: string } } | null;
};
type View = { text: string };
type MenuContext = {
  deps: {
    root: string;
    envPath: string;
    probeUserbotHealth?: (options: {
      root: string;
      dataDir?: string;
      port: string;
    }) => Promise<Health>;
    runUserbotSetup?: () => Promise<void>;
    log?: (...parts: unknown[]) => void;
  };
  flows: {
    get: (chatId: number | string, userId: string) => MenuState | null;
    screen: (state: MenuState, text: string) => Promise<unknown>;
  };
  tr: (en: string, ru: string) => string;
  show: (state: MenuState, screen: string) => Promise<unknown>;
};
type Exec = (
  file: string,
  args: string[],
  options: {
    timeout: number;
    encoding: "utf8";
    env?: NodeJS.ProcessEnv;
  },
  callback: (error: ErrorLike | null, stdout?: string) => void,
) => unknown;

const errorMessage = (error: unknown) => (error as ErrorLike).message;

const SID = "ub";
const PARENT = "r";
const SVC = "iva-telegram-userbot.service";

const isPrivate = (st: MenuState) => Number(st.chatId) > 0;

const backLine = (ctx: MenuContext) =>
  `${button(ctx.tr("‹ Menu", "‹ Меню"), `iva_menu:${PARENT}:o`)} — ${ctx.tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;
const cancelLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Cancel", "Отмена"), `iva_menu:${SID}:o`, "danger")} — ${ctx.tr(
    "leave the prompt without entering anything.",
    "выйти из ввода, ничего не меняя.",
  )}`;
const refreshLine = (ctx: MenuContext) =>
  `${button(ctx.tr("🔄 Refresh", "🔄 Обновить"), `iva_menu:${SID}:rf`, "success")} — ${ctx.tr(
    "check the state again.",
    "проверить состояние снова.",
  )}`;
const turnOffLine = (ctx: MenuContext) =>
  `${button(ctx.tr("Turn off", "Выключить"), `iva_menu:${SID}:do:off`, "danger")} — ${ctx.tr(
    "stop the userbot proxy.",
    "остановить userbot-прокси.",
  )}`;

function run(cmd: string, args: string[], timeout = 1500) {
  if (cmd === "systemctl" && serviceManager() === "launchd") {
    const result = runLaunchd(args.slice(1));
    return Promise.resolve({
      failed: result.code !== 0,
      code: result.code,
      stdout: result.out,
    });
  }
  return new Promise<{ failed: boolean; code: number; stdout: string }>(
    (resolve) => {
      execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout = "") =>
        resolve({
          failed: Boolean(err),
          code:
            typeof (err as ErrorLike | null)?.code === "number"
              ? Number((err as ErrorLike).code)
              : err
                ? 1
                : 0,
          stdout: String(stdout),
        }),
      );
    },
  );
}

export function runSetupCommand(
  bin: string,
  {
    exec = execFile as unknown as Exec,
    timeoutMs = 180_000,
    dataDir,
  }: { exec?: Exec; timeoutMs?: number; dataDir?: string } = {},
) {
  return new Promise<void>((resolve, reject) => {
    exec(
      process.execPath,
      [bin, "userbot", "setup"],
      {
        timeout: timeoutMs,
        encoding: "utf8",
        ...(dataDir
          ? { env: { ...process.env, ASSISTANT_DATA_DIR: dataDir } }
          : {}),
      },
      (error) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : 1;
          reject(new Error(`userbot setup failed (exit ${code})`));
          return;
        }
        resolve();
      },
    );
  });
}

async function probeStatus(
  ctx: MenuContext,
  env: Record<string, string | undefined>,
) {
  const probe = ctx.deps.probeUserbotHealth || probeUserbotHealth;
  return probe({
    root: ctx.deps.root,
    dataDir: resolveDataDir(ctx.deps.root, env.ASSISTANT_DATA_DIR),
    port: env.TELEGRAM_MCP_PORT || "8724",
  });
}

// Единая сборка карты — используется и render(), и async-перерисовкой после setup.
async function buildScreen(st: MenuState, ctx: MenuContext): Promise<View> {
  const T = ctx.tr;
  const env = await readEnvValues(ctx.deps.envPath);
  const hasCreds = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
  const status = await probeStatus(ctx, env);
  const head = T("📡 Telegram userbot", "📡 Telegram-userbot");
  const risk = T(
    "⚠️ Personal-account automation carries account-ban risk.",
    "⚠️ Автоматизация личного аккаунта несёт риск блокировки.",
  );
  const stateLabel =
    {
      off: T("off", "выкл"),
      starting: T("starting", "запускается"),
      unreachable: T("unreachable", "недоступен"),
      unauthorized: T("login required", "нужен вход"),
      ready: T("ready", "готов"),
    }[
      status.state as
        "off" | "starting" | "unreachable" | "unauthorized" | "ready"
    ] || T("unreachable", "недоступен");
  const statusLine = `${T("Status", "Статус")}: ${stateLabel}`;

  if (!hasCreds) {
    const text = [
      `# ${head}`,
      risk,
      statusLine,
      T(
        "No API credentials yet. Create an app at https://my.telegram.org (API development tools) — you'll get api_id and api_hash.",
        "Ключей ещё нет. Создай приложение на https://my.telegram.org (API development tools) — получишь api_id и api_hash.",
      ),
      `${button(T("Enter credentials", "Ввести ключи"), `iva_menu:${SID}:do:creds`)} — ${T(
        "enter api_id and api_hash in a private chat.",
        "ввести api_id и api_hash в личном чате.",
      )}`,
      backLine(ctx),
    ].join("\n\n");
    return { text };
  }

  if (status.state === "off") {
    const text = [
      `# ${head}`,
      risk,
      statusLine,
      T(
        "Credentials are set. Turn the proxy on — it builds a venv (up to ~3 min).",
        "Ключи заданы. Включи прокси — соберётся venv (до ~3 мин).",
      ),
      `${button(T("Turn on", "Включить"), `iva_menu:${SID}:do:setup`, "success")} — ${T(
        "start the proxy (builds a venv, up to ~3 min).",
        "запустить прокси (сборка venv, до ~3 мин).",
      )}`,
      refreshLine(ctx),
      backLine(ctx),
    ].join("\n\n");
    return { text };
  }

  if (status.state === "starting") {
    const text = [
      `# ${head}`,
      risk,
      statusLine,
      T(
        "The proxy service is still starting. Refresh in a moment.",
        "Прокси ещё запускается. Обнови через несколько секунд.",
      ),
      turnOffLine(ctx),
      refreshLine(ctx),
      backLine(ctx),
    ].join("\n\n");
    return { text };
  }

  if (status.state === "unreachable") {
    const text = [
      `# ${head}`,
      risk,
      statusLine,
      T(
        "The service is active, but its health endpoint did not answer. Run `iva userbot diagnose --json` for the fixed diagnostic.",
        "Сервис активен, но health endpoint не ответил. Запусти `iva userbot diagnose --json` для точной диагностики.",
      ),
      turnOffLine(ctx),
      refreshLine(ctx),
      backLine(ctx),
    ].join("\n\n");
    return { text };
  }

  const accountHint =
    status.state === "unauthorized"
      ? T(
          "Proxy is on, but the Telegram account is not connected. Message the bot: «connect my telegram» to scan a QR.",
          "Прокси включён, но аккаунт Telegram не подключён. Напиши боту: «подключи мой телеграм», чтобы отсканировать QR.",
        )
      : T(
          "Proxy and Telegram account are ready.",
          "Прокси и аккаунт Telegram готовы.",
        );
  const text = [
    `# ${head}`,
    risk,
    statusLine,
    accountHint,
    turnOffLine(ctx),
    refreshLine(ctx),
    backLine(ctx),
  ].join("\n\n");
  return { text };
}

// Приглашение ввести api_id или api_hash (двухшаговый секретный приём).
function promptCred(st: MenuState, ctx: MenuContext, step: string) {
  st.awaitText = { kind: "ubcred", secret: true, data: { step } };
  const head = `# 🔑 ${step === "api_id" ? "api_id" : "api_hash"}`;
  const ask =
    step === "api_id"
      ? ctx.tr(
          "Send your api_id (a number). I'll delete the message right away.",
          "Пришли api_id (число). Сообщение сразу удалю.",
        )
      : ctx.tr(
          "Now send your api_hash. I'll delete the message right away.",
          "Теперь пришли api_hash. Сообщение сразу удалю.",
        );
  return ctx.flows.screen(st, [head, ask, cancelLine(ctx)].join("\n\n"));
}

export default {
  parent: PARENT,

  render(st: MenuState, ctx: MenuContext) {
    return buildScreen(st, ctx);
  },

  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb !== "do") return ctx.show(st, SID);
    const step = args[0];

    if (step === "creds") {
      if (!isPrivate(st)) {
        st.awaitText = null;
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            "Credentials are secrets — open a private chat and enter them there.",
            "Ключи — это секрет. Открой личный чат и введи их там.",
          )}\n\n${backLine(ctx)}`,
        );
      }
      st.data.ub = {};
      return promptCred(st, ctx, "api_id");
    }

    if (step === "setup") {
      const bin = join(ctx.deps.root, "bin/iva.mjs");
      // Отсоединённо: НЕ ждём (venv-сборка до 3 мин заблокировала бы poll-цикл). Перерисуем
      // экран по завершении — только если пользователь всё ещё на нём.
      const setup =
        ctx.deps.runUserbotSetup ||
        (async () => {
          const env = await readEnvValues(ctx.deps.envPath);
          return runSetupCommand(bin, {
            dataDir: resolveDataDir(ctx.deps.root, env.ASSISTANT_DATA_DIR),
          });
        });
      setup()
        .then(async () => {
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            const v = await buildScreen(st, ctx);
            await ctx.flows.screen(st, v.text);
          }
        })
        .catch(async () => {
          ctx.deps.log?.("userbot setup failed");
          if (ctx.flows.get(st.chatId, st.userId) === st && st.screen === SID) {
            await ctx.flows.screen(
              st,
              [
                `# ${ctx.tr("📡 Telegram userbot", "📡 Telegram-userbot")}`,
                ctx.tr(
                  "Setup failed. Check the service logs, then try again.",
                  "Настройка завершилась с ошибкой. Проверь логи сервиса и повтори.",
                ),
                `${button(ctx.tr("Try again", "Повторить"), `iva_menu:${SID}:do:setup`)} — ${ctx.tr(
                  "run the proxy setup again.",
                  "запустить настройку прокси заново.",
                )}`,
                backLine(ctx),
              ].join("\n\n"),
            );
          }
        });
      return ctx.flows.screen(
        st,
        [
          `# ${ctx.tr("📡 Telegram userbot", "📡 Telegram-userbot")}`,
          ctx.tr(
            "◇ Setting up the userbot proxy…",
            "◇ Собираю userbot-прокси…",
          ),
          backLine(ctx),
        ].join("\n\n"),
      );
    }

    if (step === "off") {
      await run("systemctl", ["--user", "disable", "--now", SVC]);
      return ctx.show(st, SID);
    }
    return ctx.show(st, SID);
  },

  texts: {
    // Двухшаговый приём: сначала api_id (число), затем api_hash. Сообщения уже удалены движком.
    async ubcred(
      text: unknown,
      _msg: unknown,
      st: MenuState,
      ctx: MenuContext,
    ) {
      const value = String(text).trim();
      const step = st.awaitText?.data?.step;
      if (step === "api_id") {
        if (!/^\d+$/.test(value)) {
          return ctx.flows.screen(
            st,
            `${ctx.tr(
              "api_id must be a number. Send it again or cancel.",
              "api_id должен быть числом. Пришли ещё раз или отмени.",
            )}\n\n${cancelLine(ctx)}`,
          );
        }
        st.data.ub = { apiId: value };
        return promptCred(st, ctx, "api_hash");
      }
      // api_hash: у Telegram это 32 hex-символа; принимаем непустой токен без пробелов.
      if (!/^\S{8,}$/.test(value)) {
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            "That doesn't look like an api_hash. Send it again or cancel.",
            "Это не похоже на api_hash. Пришли ещё раз или отмени.",
          )}\n\n${cancelLine(ctx)}`,
        );
      }
      const apiId = st.data.ub?.apiId;
      st.awaitText = null;
      st.data.ub = null;
      try {
        await upsertEnv(ctx.deps.envPath, {
          TELEGRAM_API_ID: apiId ?? "",
          TELEGRAM_API_HASH: value,
        });
      } catch (error) {
        return ctx.flows.screen(
          st,
          `${ctx.tr(
            `Couldn't write .env: ${String(errorMessage(error))}`,
            `Не удалось записать .env: ${String(errorMessage(error))}`,
          )}\n\n${backLine(ctx)}`,
        );
      }
      // Ключи есть — экран покажет [Включить].
      return ctx.show(st, SID);
    },
  },
};
