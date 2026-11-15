import { logHint } from "../systemd-control.ts";
// Экран «🛠 Обслуживание»: доктор / чистка vault / ночной brain / обновление.
// Вся механика запуска и прогресса — svc-run.ts; здесь вьюхи, копирайт и гейты.
// Спека: notes/specs/2026-07-25-menu-service-design.md (вне публичного дерева, см. историю git).
//
// Вербы: c:<cmd> подтверждение (stateless-вьюха), go:<cmd> запуск, ab отмена,
// up — хендофф в существующий /update-флоу (deps.handleUpdateCheck).
// render сам решает, что показать: идёт процесс → прогресс; иначе список.
import { join } from "node:path";
import { readEnvValues } from "../env-file.ts";
import { updateRunning } from "../version-store.ts";
import { button } from "../telegram-buttons.ts";
import { menuStyle } from "../telegram-buttons.ts";
import { writeSettings } from "#lib/settings.ts";
import { betaOf, setBeta } from "../update-channel.ts";
import {
  LOADERS,
  currentRun,
  cancelRun,
  startProcess,
  startUnit,
  elapsed,
  tailText,
  type ExecFileImplementation,
  type RunOptions,
  type ServiceRun,
} from "./svc-run.ts";
import { resolveVaultDir } from "../../../packages/vault-dir/index.ts";
import { loadVaultPair, type VaultPair } from "../vault-pair.ts";

type ServiceCommand = "doc" | "cln" | "mem";
type ServiceStatus = "running" | "failed" | "cancelled" | "timeout" | "done";
type CommandSpec =
  | { kind: "proc"; argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
  | { kind: "unit"; unit: string };

export type MenuServiceView = { text: string };
export type MenuServiceState = {
  chatId: string | number;
  userId: string;
  screen: string;
  msgId: number;
};
type ServiceRunOverrides = Partial<
  Pick<
    RunOptions,
    "tickMs" | "timeoutMs" | "pollMs" | "spawnImpl" | "execFileImpl"
  >
>;
export type MenuServiceContext = {
  deps: {
    root: string;
    envPath: string;
    dataDir: string;
    svcSpec?: (cmd: ServiceCommand, ctx: MenuServiceContext) => CommandSpec;
    svcRun?: ServiceRunOverrides;
    handleUpdateCheck?: (chatId: string | number) => unknown;
  };
  flows: {
    get: (chatId: string | number, userId: string) => MenuServiceState | null;
    screen: (state: MenuServiceState, text: string) => Promise<unknown>;
  };
  tr: (english: string, russian: string) => string;
  show: (state: MenuServiceState, screen: string) => Promise<unknown>;
};

function backLine(ctx: MenuServiceContext): string {
  return `${button(ctx.tr("‹ Back", "‹ Назад"), "iva_menu:svc:o")} — ${ctx.tr(
    "back to the maintenance list.",
    "вернуться к списку обслуживания.",
  )}`;
}

const CMDS = new Set<ServiceCommand>(["doc", "cln", "mem"]);
const MEM_UNIT = "iva-brain.service";

const isServiceCommand = (cmd: string | undefined): cmd is ServiceCommand =>
  cmd !== undefined && CMDS.has(cmd as ServiceCommand);

const label = (cmd: ServiceCommand, T: MenuServiceContext["tr"]): string =>
  ({
    doc: T("🩺 Doctor", "🩺 Доктор"),
    cln: T("🧹 Vault cleanup", "🧹 Чистка vault"),
    mem: T("🌙 Brain (nightly care)", "🌙 Brain (ночной уход)"),
  })[cmd];

const describe = (cmd: ServiceCommand, T: MenuServiceContext["tr"]): string =>
  ({
    doc: T(
      "Diagnoses and auto-repairs the install: units, timers, port, .env, build.\nUsually 10–60 seconds (up to minutes if a rebuild is needed).",
      "Диагностика и авто-починка инсталляции: юниты, таймеры, порт, .env, сборка.\nОбычно 10–60 секунд (до минут, если нужна пересборка).",
    ),
    cln: T(
      "Streams every memory card and removes the description bloat from the 0.3.0 bug. Safe for card bodies.\nUsually under a minute; gigabyte files take longer.",
      "Проходит по карточкам памяти стримингом и убирает раздутые description из бага 0.3.0. Тела карточек не трогает.\nОбычно меньше минуты; гигабайтные файлы — дольше.",
    ),
    mem: T(
      "Runs the nightly brain now, without waiting for 05:00: commit what is uncommitted → link graph → CORE alert → git push.\nUsually under a minute.",
      "Запускает ночной уход за vault сейчас, не дожидаясь 05:00: коммит незакоммиченного → граф ссылок → Alert по CORE → git push.\nОбычно меньше минуты.",
    ),
  })[cmd];

// Командные строки. deps.svcSpec — тестовая подмена (argv на быстрые node -e).
// Экспортируется ради теста: реальный argv кнопки иначе ничем не покрыт (так и уехал
// в 0.3.2 путь в vault, которого у части юзеров не было).
export async function commandSpec(
  cmd: ServiceCommand,
  ctx: MenuServiceContext,
): Promise<CommandSpec> {
  if (ctx.deps.svcSpec) return ctx.deps.svcSpec(cmd, ctx);
  const root = ctx.deps.root;
  if (cmd === "doc")
    return {
      kind: "proc",
      argv: [process.execPath, join(root, "bin/iva.mjs"), "doctor"],
      cwd: root,
      env: {
        ...process.env,
        ASSISTANT_DATA_DIR: ctx.deps.dataDir,
      },
    };
  if (cmd === "cln") {
    const env = await readEnvValues(ctx.deps.envPath);
    const vaultDir = resolveVaultDir(root, env.ASSISTANT_VAULT_DIR);
    // Путь абсолютный: обновляемая установка не зависит от cwd vault.
    return {
      kind: "proc",
      argv: [
        process.execPath,
        join(root, "scripts/vault-cleanup.ts"),
        ".",
        "--apply",
      ],
      cwd: vaultDir,
    };
  }
  return { kind: "unit", unit: MEM_UNIT };
}

// Шаг берём СЫРЫМ, без markdown-экранирования: текст — вывод чужого процесса, и его
// проходит outbound-гейт (redactTelegramBody → security-gate) прямо на вызове Bot API.
// Экранирование ломает имена ключей (`api\_key=…` больше не находка для named_secret),
// то есть тихо сужает защиту; разметке в выводе доктора/чистки терять нечего.
function progressView(
  run: ServiceRun,
  ctx: MenuServiceContext,
): MenuServiceView {
  const T = ctx.tr;
  const step = run.lastLine || T("Working…", "Работаю…");
  const text = [
    `${LOADERS[run.cmd].alt} **${label(run.cmd, T)}** — ${elapsed(run)}`,
    step,
    `${button(T("✖ Cancel", "✖ Отменить"), "iva_menu:svc:ab", "danger")} — ${T(
      "stop the command.",
      "остановить команду.",
    )}`,
  ].join("\n\n");
  return { text };
}

// Финальная сводка. Чистка: парсим «cleanup (applied): N file(s), X bytes …» → файлы и МБ.
// Режим в выводе vault-cleanup.ts — applied/dry-run (не apply): ошибёшься — сводка молча
// деградирует до дежурного «Готово».
function summaryText(run: ServiceRun, ctx: MenuServiceContext): string {
  const T = ctx.tr;
  const name = label(run.cmd, T);
  const took = elapsed(run);
  if (run.status === "cancelled")
    return T(`✖ Cancelled: ${name} · ${took}`, `✖ Прервано: ${name} · ${took}`);
  if (run.status === "timeout") {
    if (run.cmd === "mem")
      return T(
        `⏳ Still running after ${took} — check: ${logHint(MEM_UNIT)}`,
        `⏳ Всё ещё идёт (${took}) — смотри: ${logHint(MEM_UNIT)}`,
      );
    return T(
      `⚠️ Timed out: ${name} · ${took}`,
      `⚠️ Не уложился в лимит: ${name} · ${took}`,
    );
  }
  const ok = run.status === "done";
  const cleanup = cleanupSummary(run, took, T);
  if (cleanup) return cleanup;
  if (run.cmd === "mem" && ok)
    return T(
      `✅ Memory cycle finished in ${took}`,
      `✅ Цикл памяти пройден за ${took}`,
    );
  const head = summaryHead(run, name, T);
  const tail = tailText(run);
  return tail ? `${head} · ${took}\n\n${tail}` : `${head} · ${took}`;
}

function cleanupSummary(
  run: ServiceRun,
  took: string,
  T: MenuServiceContext["tr"],
): string | null {
  if (run.cmd !== "cln" || run.status !== "done") return null;
  const m = run.tail
    .join("\n")
    .match(/cleanup \((?:applied|dry-run)\): (\d+) file\(s\), ([\d,]+) bytes/);
  if (m) {
    const files = Number(m[1]);
    const mb = (Number(m[2].replace(/,/g, "")) / 1e6).toFixed(files ? 1 : 0);
    return files
      ? T(
          `✅ Cleanup: ${files} file(s), ${mb} MB of garbage removed · ${took}`,
          `✅ Чистка: ${files} файл(ов), ${mb} МБ мусора убрано · ${took}`,
        )
      : T(
          `✅ Cleanup: vault is clean · ${took}`,
          `✅ Чистка: vault чистый · ${took}`,
        );
  }
  return null;
}

function summaryHead(
  run: ServiceRun,
  name: string,
  T: MenuServiceContext["tr"],
): string {
  const ok = run.status === "done";
  return run.cmd === "doc"
    ? ok
      ? T("✅ Diagnostics passed", "✅ Диагностика пройдена")
      : T("⚠️ Issues found", "⚠️ Есть проблемы")
    : ok
      ? T(`✅ Done: ${name}`, `✅ Готово: ${name}`)
      : T(`⚠️ Failed: ${name}`, `⚠️ Упало: ${name}`);
}

function lastRunLine(run: ServiceRun, ctx: MenuServiceContext): string {
  const T = ctx.tr;
  const icon = (
    {
      running: "•",
      done: "✅",
      failed: "⚠️",
      cancelled: "✖",
      timeout: "⏳",
    } satisfies Record<ServiceStatus, string>
  )[run.status];
  return T(
    `${icon} Last run: ${label(run.cmd, T)} · ${elapsed(run)}`,
    `${icon} Последний запуск: ${label(run.cmd, T)} · ${elapsed(run)}`,
  );
}

function idleView(
  _state: MenuServiceState,
  ctx: MenuServiceContext,
): MenuServiceView {
  const T = ctx.tr;
  const lines = [
    `# ${T("🛠 Maintenance", "🛠 Обслуживание")}`,
    T(
      "Diagnostics and upkeep for this install.",
      "Диагностика и уход за инсталляцией.",
    ),
  ];
  const run = currentRun();
  if (run && run.status !== "running") lines.push(lastRunLine(run, ctx));
  lines.push(
    `${button(label("doc", T), "iva_menu:svc:c:doc")} — ${T(
      "check and auto-repair the install.",
      "проверить и починить инсталляцию.",
    )}`,
    `${button(label("cln", T), "iva_menu:svc:c:cln")} — ${T(
      "strip the 0.3.0 bloat from memory cards.",
      "убрать раздутые описания из карточек памяти.",
    )}`,
    `${button(label("mem", T), "iva_menu:svc:c:mem")} — ${T(
      "run the nightly memory cycle now.",
      "запустить ночной цикл памяти сейчас.",
    )}`,
    `${button(T("🔄 Update", "🔄 Обновление"), "iva_menu:svc:up")} — ${T(
      "check for and install a new version.",
      "проверить и поставить новую версию.",
    )}`,
    updatesLine(ctx),
    menuStyle() === "rich"
      ? `${button(T("◀︎ Classic menu", "◀︎ Старое меню"), "iva_menu:svc:menu:classic")} — ${T(
          "buttons under the message, as before 0.4.2.",
          "кнопки под сообщением, как до 0.4.2.",
        )}`
      : `${button(T("✨ New menu", "✨ Новое меню"), "iva_menu:svc:menu:rich", "success")} — ${T(
          "buttons inside the message, tables; needs a Telegram client from August 2026.",
          "кнопки внутри сообщения, таблицы; нужен клиент Telegram от августа 2026.",
        )}`,
    `${button(T("‹ Menu", "‹ Меню"), "iva_menu:r:o")} — ${T(
      "back to the settings.",
      "вернуться в настройки.",
    )}`,
  );
  return { text: lines.join("\n\n") };
}

/** Одна кнопка бета-обновлений: показывает, что ставит обновление; нажатие переключает. */
function updatesLine(ctx: MenuServiceContext): string {
  const T = ctx.tr;
  const beta = betaOf(ctx.deps.root);
  const name = beta ? T("beta", "бета") : T("stable", "стабильные");
  return `${button(T(`🧪 Updates: ${name}`, `🧪 Обновления: ${name}`), "iva_menu:svc:beta")} — ${T(
    beta
      ? "every accepted change; tap for releases only."
      : "releases only; tap for every accepted change (beta).",
    beta
      ? "всё принятое сразу; нажми — только выпуски."
      : "только выпуски; нажми — всё принятое сразу (бета).",
  )}`;
}

/** Чистка трогает vault чужим процессом, а мост в это время свободен: правки владельца в
 * Obsidian ложатся рядом с её работой. Без пары коммитов они уехали бы в ночной `add -A`
 * неотличимо от результата чистки, поэтому чистка оформляется тем же швом, что и у
 * обновлятора. `spec.cwd` у неё — это и есть vault; нет каталога — оформлять нечего. */
async function cleanupPair(
  cmd: ServiceCommand,
  spec: CommandSpec,
): Promise<VaultPair | null> {
  if (cmd !== "cln" || spec.kind !== "proc" || !spec.cwd) return null;
  return await loadVaultPair("menu", spec.cwd);
}

/** Итог команды рисуем, только если юзер всё ещё на экране svc — иначе сводка ждёт в render. */
function summaryOnFinish(
  st: MenuServiceState,
  ctx: MenuServiceContext,
): (run: ServiceRun) => Promise<void> {
  return async (run) => {
    if (!(ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc"))
      return;
    await ctx.flows.screen(
      st,
      [summaryText(run, ctx), backLine(ctx)].join("\n\n"),
    );
  };
}

/** Коммит результата чистки — до сводки, и его не отменяет подменённый в тестах onFinish:
 * работу раннера в тесте подменяют, а след в истории vault остаётся тем же. */
function withCleanupCommit(
  opts: RunOptions,
  pair: VaultPair | null,
): RunOptions {
  if (pair === null) return opts;
  const inner = opts.onFinish;
  return {
    ...opts,
    onFinish: async (run) => {
      await pair.after();
      await inner?.(run);
    },
  };
}

async function startCommand(
  cmd: ServiceCommand,
  st: MenuServiceState,
  ctx: MenuServiceContext,
): Promise<unknown> {
  const T = ctx.tr;
  // Гейт 1: уже занято — показать прогресс текущего.
  const running = currentRun();
  if (running && running.status === "running") {
    const v = progressView(running, ctx);
    return ctx.flows.screen(
      st,
      [T("Already running:", "Уже идёт:"), v.text].join("\n\n"),
    );
  }
  // Гейт 2: идёт обновление — в репо чужим процессам нельзя.
  if (cmd !== "mem" && updateRunning(ctx.deps.dataDir)) {
    return ctx.flows.screen(
      st,
      [
        T(
          "⬆️ An update is in progress — try again after it finishes.",
          "⬆️ Идёт обновление — попробуй после его завершения.",
        ),
        backLine(ctx),
      ].join("\n\n"),
    );
  }
  const spec = await commandSpec(cmd, ctx);
  const over = ctx.deps.svcRun || {};
  const pair = await cleanupPair(cmd, spec);
  const opts = withCleanupCommit(
    {
      edit: (markdown) => ctx.flows.screen(st, markdown),
      chatId: st.chatId,
      messageId: st.msgId,
      attached: () =>
        ctx.flows.get(st.chatId, st.userId) === st && st.screen === "svc",
      progressView: (run) => progressView(run, ctx),
      onFinish: summaryOnFinish(st, ctx),
      ...over,
    },
    pair,
  );
  // Снимок «до» — перед процессом: правки владельца, сделанные после старта чистки, остаются
  // незакоммиченными и уезжают в ночной коммит, а не приписываются чистке.
  await pair?.before();
  const run =
    spec.kind === "unit"
      ? startUnit(cmd, spec, opts)
      : startProcess(cmd, spec, opts);
  if (!run) {
    // гонка: кто-то успел стартовать между гейтом и стартом
    const activeRun = currentRun();
    if (!activeRun) return;
    const v = progressView(activeRun, ctx);
    return ctx.flows.screen(
      st,
      [T("Already running:", "Уже идёт:"), v.text].join("\n\n"),
    );
  }
}

type Verb = (
  args: string[],
  st: MenuServiceState,
  ctx: MenuServiceContext,
) => unknown;

/** Глагол кнопки экрана → действие. */
const VERBS: Record<string, Verb> = {
  c: (args, st, ctx) =>
    isServiceCommand(args[0]) ? confirmView(args[0], st, ctx) : undefined,
  go: (args, st, ctx) =>
    isServiceCommand(args[0]) ? startCommand(args[0], st, ctx) : undefined,
  ab: (_args, st, ctx) =>
    cancelRun()
      ? ctx.flows.screen(st, ctx.tr("Stopping…", "Останавливаю…"))
      : ctx.show(st, "svc"), // нечего отменять — перерисовать текущее состояние
  up: (_args, st, ctx) => ctx.deps.handleUpdateCheck?.(st.chatId),
  menu: (args, st, ctx) => {
    if (args[0] !== "rich" && args[0] !== "classic") return undefined;
    writeSettings({ menuStyle: args[0] });
    return ctx.show(st, "r"); // корень сразу в новом стиле
  },
  beta: (_args, st, ctx) => {
    const result = setBeta(ctx.deps.root, !betaOf(ctx.deps.root));
    if (result === "ok") return ctx.show(st, "svc"); // ставится при следующем обновлении
    return ctx.flows.screen(
      st,
      result === "partial"
        ? ctx.tr(
            "The update setting may be partly written (git config failed). Tap again or run: iva beta / iva stable",
            "Настройка обновлений могла записаться частично (git config не прошёл). Нажми ещё раз или выполни: iva beta / iva stable",
          )
        : ctx.tr(
            "The update setting was not recorded (git config failed). Try again or run: iva beta",
            "Настройка обновлений не записана (git config не прошёл). Повтори или выполни: iva beta",
          ),
    );
  },
};

function confirmView(
  cmd: ServiceCommand,
  st: MenuServiceState,
  ctx: MenuServiceContext,
): unknown {
  const T = ctx.tr;
  return ctx.flows.screen(
    st,
    [
      `# ${label(cmd, T)}`,
      describe(cmd, T),
      `${button(T("▶ Run", "▶ Запустить"), `iva_menu:svc:go:${cmd}`)} — ${T(
        "start it now.",
        "запустить сейчас.",
      )}`,
      backLine(ctx),
    ].join("\n\n"),
  );
}

const service = {
  parent: "r",
  // eslint-disable-next-line @typescript-eslint/require-await -- async preserves the original synchronous run snapshot before returning a Promise.
  async render(
    st: MenuServiceState,
    ctx: MenuServiceContext,
  ): Promise<MenuServiceView> {
    const run = currentRun();
    return run && run.status === "running"
      ? progressView(run, ctx)
      : idleView(st, ctx);
  },
  on(
    verb: string,
    args: string[],
    st: MenuServiceState,
    ctx: MenuServiceContext,
  ): unknown {
    return Object.hasOwn(VERBS, verb) ? VERBS[verb](args, st, ctx) : undefined;
  },
};

export { type ExecFileImplementation };
export default service;
