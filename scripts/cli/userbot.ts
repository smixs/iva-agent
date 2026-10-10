import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  userbotSyncArgs,
  USERBOT_IMPORT_TIMEOUT_MS,
} from "../lib/userbot-deps.ts";
import {
  probeUserbotHealth,
  awaitUserbotHealth,
  userbotProxyReady,
  type UserbotHealth,
} from "../lib/userbot-health.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type CliSystemd = ReturnType<typeof createCliSystemd>;

export type UserbotRuntime = Pick<
  CliRuntime,
  | "ROOT"
  | "SVC_USERBOT"
  | "USERBOT_DIR"
  | "VENV_PY"
  | "TOKEN_FILE"
  | "ok"
  | "bad"
  | "step"
  | "run"
  | "cap"
  | "systemd"
  | "readEnv"
  | "dataDirAbs"
  | "writeEnvVars"
  | "uvExecutable"
>;

export interface EnsureUserbotVenvOptions {
  readonly quiet?: boolean;
  readonly requirementsPath?: string | null;
  readonly requireHashes?: boolean;
}

export interface RestartUserbotOptions extends EnsureUserbotVenvOptions {
  readonly knownActive?: boolean;
  /**
   * `iva restart`: a proxy that answers is left running. Its version is the same, and a
   * re-sync of a ready venv still fetches from the network, so offline it would only
   * switch a working userbot off.
   */
  readonly keepHealthy?: boolean;
}

interface UserbotFileSystem {
  exists(path: string): boolean;
  readUtf8(path: string | number): string;
  mkdir(path: string): void;
  writePrivate(path: string, data: string): void;
  chmodPrivate(path: string): void;
}

export interface UserbotDependencies {
  readonly readinessTimeoutMs?: number;
  readonly fileSystem?: Partial<UserbotFileSystem>;
  readonly randomHex?: (bytes: number) => string;
  readonly probeHealth?: (options: {
    readonly root: string;
    readonly dataDir: string;
    readonly port: string;
    readonly signal?: AbortSignal;
  }) => Promise<UserbotHealth>;
  readonly log?: (message: string) => void;
  readonly exit?: (code: number) => never;
}

const DEFAULT_FILE_SYSTEM: UserbotFileSystem = {
  exists: existsSync,
  readUtf8: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writePrivate: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
  chmodPrivate: (path) => chmodSync(path, 0o600),
};

export function createUserbotCommands(
  runtime: UserbotRuntime,
  systemdLifecycle: Pick<CliSystemd, "writeUnits">,
  dependencies: UserbotDependencies = {},
) {
  const {
    ROOT,
    SVC_USERBOT,
    USERBOT_DIR,
    VENV_PY,
    TOKEN_FILE,
    ok,
    bad,
    step,
    run,
    cap,
    systemd,
    readEnv,
    dataDirAbs,
    writeEnvVars,
  } = runtime;
  const fileSystem: UserbotFileSystem = {
    ...DEFAULT_FILE_SYSTEM,
    ...dependencies.fileSystem,
  };
  const randomHex =
    dependencies.randomHex ??
    ((bytes: number): string => randomBytes(bytes).toString("hex"));
  const probeHealth = dependencies.probeHealth ?? probeUserbotHealth;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const exit =
    dependencies.exit ?? ((code: number): never => process.exit(code));

  function ensureUserbotVenv({
    quiet = false,
    requirementsPath = join(USERBOT_DIR, "requirements.lock"),
    requireHashes = true,
  }: EnsureUserbotVenvOptions = {}): void {
    const uv = runtime.uvExecutable();
    if (!uv)
      throw new Error("userbot: uv не найден — повторно запусти install.sh");
    const options = {
      cwd: USERBOT_DIR,
      ...(quiet ? { stdio: "ignore" as const } : {}),
    };
    const must = (
      result: { readonly status?: number | null } | null | undefined,
      operation: string,
    ): void => {
      if ((result?.status ?? 1) !== 0)
        throw new Error(
          `userbot: ${operation} не удалось (exit ${result?.status ?? 1})`,
        );
    };
    const requirements = fileSystem.readUtf8(requirementsPath as string);
    const syncArgs = userbotSyncArgs({
      pythonPath: VENV_PY,
      requirementsFile: requirementsPath as string,
      requirementsText: requirements,
      requireHashes,
    });
    if (!fileSystem.exists(VENV_PY)) {
      if (!quiet) step("Создаю venv для userbot-прокси…");
      must(
        run(uv, ["venv", "--python", "3.12", ".venv"], options),
        "создание venv",
      );
      if (!fileSystem.exists(VENV_PY))
        throw new Error("userbot: venv не создан — проверь python3/uv");
    }
    if (!quiet) step("Синхронизирую зависимости userbot-прокси…");
    must(run(uv, syncArgs, options), "установка зависимостей");
    const check = cap(
      VENV_PY,
      ["-c", "import telethon, telegram_mcp, qrcode, mcp"],
      { ...options, timeout: USERBOT_IMPORT_TIMEOUT_MS },
    );
    if (check.code !== 0)
      throw new Error(
        `userbot: зависимости не импортируются — ${check.err.split("\n").pop() || "проверь requirements"}`,
      );
  }

  function ensureUserbotToken({
    quiet = false,
  }: { quiet?: boolean } = {}): void {
    if (fileSystem.exists(TOKEN_FILE)) return;
    fileSystem.mkdir(dirname(TOKEN_FILE));
    fileSystem.writePrivate(TOKEN_FILE, randomHex(24));
    try {
      fileSystem.chmodPrivate(TOKEN_FILE);
    } catch {
      // The token file is already created with mode 0600; chmod is best-effort.
    }
    if (!quiet) ok("Сгенерировал токен прокси (data/telegram-userbot.token).");
  }

  async function restartUserbotIfActive({
    quiet = false,
    knownActive = false,
    keepHealthy = false,
    requirementsPath = join(USERBOT_DIR, "requirements.lock"),
    requireHashes = true,
  }: RestartUserbotOptions = {}): Promise<UserbotHealth | null> {
    if (
      !knownActive &&
      !["active", "activating", "deactivating", "reloading"].includes(
        systemd.query("is-active", SVC_USERBOT).out,
      )
    )
      return null;
    if (keepHealthy) {
      const health = await currentHealth();
      if (userbotProxyReady(health)) return health;
    }
    if (!quiet) step("Обновляю userbot-прокси…");
    try {
      systemd.stop([SVC_USERBOT]);
      const stopped = systemd.query("is-active", SVC_USERBOT).out;
      if (!["inactive", "failed", "unknown"].includes(stopped))
        throw new Error(
          "userbot: service did not stop before dependency preparation",
        );
      ensureUserbotToken({ quiet });
      ensureUserbotVenv({ quiet, requirementsPath, requireHashes });
      const started = systemd.query("restart", SVC_USERBOT);
      if (started.code !== 0)
        throw new Error("userbot: restart failed (exit " + started.code + ")");
      const health = await awaitProxy();
      if (!quiet) ok("userbot-прокси перезапущен на новом коде");
      return health;
    } catch (error) {
      keepOff(error);
    }
  }

  function keepOff(original: unknown): never {
    try {
      systemd.disableNow([SVC_USERBOT]);
      const stopped = systemd.query("is-active", SVC_USERBOT).out;
      if (
        !["inactive", "failed", "unknown"].includes(stopped) ||
        systemd.isEnabled(SVC_USERBOT)
      )
        throw new Error(
          "userbot service remained active/enabled after disable",
        );
    } catch (cleanupError) {
      const message =
        original instanceof Error ? original.message : String(original);
      const cleanup =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      throw new AggregateError(
        [original, cleanupError],
        message + "; could not keep userbot off: " + cleanup,
        { cause: cleanupError },
      );
    }
    throw original;
  }

  function currentHealth(): Promise<UserbotHealth> {
    const env = readEnv();
    return probeHealth({
      root: ROOT,
      dataDir: dataDirAbs(env),
      port: env.TELEGRAM_MCP_PORT || "8724",
    });
  }

  async function diagnosticHealth(): Promise<UserbotHealth> {
    const health = await currentHealth();
    if (!userbotProxyReady(health)) return health;
    if (!fileSystem.exists(VENV_PY))
      return { state: "unreachable", reason: "venv_interpreter_missing" };
    const imports = cap(
      VENV_PY,
      ["-c", "import telethon, telegram_mcp, qrcode, mcp"],
      { cwd: USERBOT_DIR, timeout: USERBOT_IMPORT_TIMEOUT_MS },
    );
    return imports.code === 0
      ? health
      : { state: "unreachable", reason: "python_dependencies_unavailable" };
  }

  async function awaitProxy(): Promise<UserbotHealth> {
    const env = readEnv();
    const health = await awaitUserbotHealth(
      (signal) =>
        probeHealth({
          root: ROOT,
          dataDir: dataDirAbs(env),
          port: env.TELEGRAM_MCP_PORT || "8724",
          signal,
        }),
      dependencies.readinessTimeoutMs,
    );
    if (!userbotProxyReady(health))
      throw new Error("userbot: " + health.reason);
    return health;
  }

  async function cmdUserbot(args: readonly string[]): Promise<void> {
    const sub = args[0] || "status";
    if (sub === "creds") {
      let data = "";
      try {
        data = fileSystem.readUtf8(0);
      } catch {
        // Empty input falls through to the existing credential validation.
      }
      const [apiId, apiHash] = data
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!apiId || !apiHash) {
        bad(
          "stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)",
        );
        exit(1);
      }
      if (!/^\d+$/.test(apiId)) {
        bad("api_id должен быть числом");
        exit(1);
      }
      writeEnvVars({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
      ok("Ключи Telegram записаны в .env. Теперь: iva userbot setup");
      return;
    }
    if (sub === "setup") {
      const env = readEnv();
      if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
        bad(
          "Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,",
        );
        bad("впиши оба ключа в .env и запусти снова: iva userbot setup");
        exit(1);
      }
      const wasActive = [
        "active",
        "activating",
        "deactivating",
        "reloading",
      ].includes(systemd.query("is-active", SVC_USERBOT).out);
      let unitWritten = false;
      try {
        if (wasActive) {
          systemd.stop([SVC_USERBOT]);
          const stopped = systemd.query("is-active", SVC_USERBOT).out;
          if (!["inactive", "failed", "unknown"].includes(stopped))
            throw new Error(
              "userbot: service did not stop before dependency preparation",
            );
        }
        ensureUserbotToken();
        ensureUserbotVenv();
        systemdLifecycle.writeUnits();
        unitWritten = true;
        for (const action of ["enable", "restart"]) {
          const result = systemd.query(action, SVC_USERBOT);
          if (result.code !== 0)
            throw new Error(
              "userbot: " + action + " failed (exit " + result.code + ")",
            );
        }
        await awaitProxy();
      } catch (error) {
        if (unitWritten || wasActive || systemd.isEnabled(SVC_USERBOT))
          keepOff(error);
        throw error;
      }
      ok(
        "Userbot-прокси включён. Подключи аккаунт по QR через бота: напиши боту «подключи мой телеграм».",
      );
      ok("Статус: iva userbot status · выключить: iva userbot off");
      return;
    }
    if (sub === "off") {
      systemd.disableNow([SVC_USERBOT]);
      ok("Userbot-прокси остановлен и выключен.");
      return;
    }
    if (sub === "diagnose") {
      if (args[1] !== "--json") {
        bad("Использование: iva userbot diagnose --json");
        exit(1);
      }
      const health = await diagnosticHealth();
      log(JSON.stringify(health));
      return;
    }
    if (sub !== "status") {
      bad(`Неизвестная команда userbot: ${sub}`);
      exit(1);
    }
    const health = await diagnosticHealth();
    log(`${SVC_USERBOT}: ${health.state}`);
    log(
      `venv: ${fileSystem.exists(VENV_PY) ? "собран" : "нет — будет собран при setup"}`,
    );
    log(
      `токен: ${fileSystem.exists(TOKEN_FILE) ? "есть" : "нет — создастся при setup"}`,
    );
  }

  return {
    ensureUserbotVenv,
    ensureUserbotToken,
    restartUserbotIfActive,
    cmdUserbot,
  };
}

/**
 * Put the proxy on the code a version just installed. Its venv is built beside
 * that code, so a fresh version has none and the unit would exec an interpreter
 * that is not there. Never fatal: an integration that cannot be rebuilt is a
 * broken integration, not a failed update.
 */
export type UserbotRecovery =
  | { readonly status: "skipped" }
  | { readonly status: "ready"; readonly health: UserbotHealth }
  | { readonly status: "failed"; readonly reason: string };

export async function reinstallUserbot(
  runtime: UserbotRuntime,
  systemdLifecycle: Pick<CliSystemd, "writeUnits">,
  report: (message: string) => void,
  {
    knownActive = false,
    keepHealthy = false,
  }: Pick<RestartUserbotOptions, "knownActive" | "keepHealthy"> = {},
  dependencies: UserbotDependencies = {},
): Promise<UserbotRecovery> {
  try {
    const health = await createUserbotCommands(
      runtime,
      systemdLifecycle,
      dependencies,
    ).restartUserbotIfActive({
      quiet: true,
      knownActive,
      keepHealthy,
    });
    return health ? { status: "ready", health } : { status: "skipped" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    report(
      `the telegram userbot proxy did not come up: ${reason.replace(/\.$/u, "")}. Once that is fixed, turn it back on: iva userbot setup`,
    );
    return { status: "failed", reason };
  }
}
