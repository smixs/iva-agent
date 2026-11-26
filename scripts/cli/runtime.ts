import { stableNodeExecutable } from "../lib/node-executable.ts";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { formatEnvLine, writeEnvAtomicSync } from "../lib/env-file.ts";
import { resolveDataDir } from "../../packages/data-dir/index.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { real } from "../lib/version-layout.ts";
import { parseVersionName } from "../lib/version-store.ts";
import { resolveUv } from "../lib/userbot-deps.ts";
import { serviceManager } from "../lib/service-manager.ts";
import { runLaunchd } from "../lib/launchd.ts";

type CaptureOptions = Omit<SpawnSyncOptions, "encoding"> & {
  readonly encoding?: BufferEncoding;
};

type CaptureResult = {
  readonly code: number;
  readonly out: string;
  readonly err: string;
};

type EnvValues = Record<string, string>;

/**
 * Child PATH must keep the caller's order when it already carries a Node bin directory.
 * Stabilization can move that directory from a versioned Cellar path to an `opt` link,
 * so either one counts: prepending again would push an earlier executable override
 * behind it and change which command a child actually runs.
 */
export function childPath(
  path: string | undefined,
  nodeBinDir: string,
  originalNodeBinDir = nodeBinDir,
): string {
  const entries = (path || "").split(":").filter(Boolean);
  return entries.includes(nodeBinDir) || entries.includes(originalNodeBinDir)
    ? entries.join(":")
    : [nodeBinDir, ...entries].join(":");
}

type RuntimeColors = {
  readonly g: string;
  readonly y: string;
  readonly r: string;
  readonly c: string;
  readonly b: string;
  readonly d: string;
  readonly x: string;
};

/** Create the shared, side-effect-free-at-import runtime used by the Iva CLI. `gitHead` —
 * из имени каталога версии: своего .git нет, и git поднялся бы к чужому дереву выше. */
export function createCliRuntime(root: string) {
  const ROOT = root;
  // Through the symlink: on the immutable layout `<root>/.env` points at the
  // installation's own file, and an atomic write would otherwise replace the link
  // with a copy that the next version never sees.
  const ENV_PATH = real(join(ROOT, ".env"));
  const UNIT_DIR = join(
    homedir(),
    serviceManager() === "launchd"
      ? "Library/LaunchAgents"
      : ".config/systemd/user",
  );
  const NODE = stableNodeExecutable(process.execPath);
  const NODE_BIN_DIR = dirname(NODE);
  const ORIGINAL_NODE_BIN_DIR = dirname(process.execPath);
  const NPM = existsSync(join(NODE_BIN_DIR, "npm"))
    ? join(NODE_BIN_DIR, "npm")
    : "npm";
  // Child processes need the same node/npm the CLI itself runs on, so NODE_BIN_DIR goes
  // in front — but only when PATH carries neither it nor the directory the caller's
  // executable came from. Prepending it a second time silently reorders PATH: with a
  // system Node in /usr/bin, /usr/bin jumps ahead of whatever the caller put first, so a
  // stub placed earlier in PATH stops winning. That is how
  // `scripts/cli/services-entrypoints.test.ts` reached the real systemctl instead of its
  // own fake and drove live user units. Homebrew stabilization can rename that directory,
  // so the original one is just as strong a reason to leave PATH alone.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ASSISTANT_DATA_DIR: dataDirAbs(),
    PATH: childPath(process.env.PATH, NODE_BIN_DIR, ORIGINAL_NODE_BIN_DIR),
  };

  const SERVICES = ["iva.service", "iva-telegram-poll.service"];
  // Brain — the deterministic nightly vault care (CONTEXT.md). One oneshot service
  // driven by one timer; the rollups it follows are in-process eve schedules.
  const BRAIN_SERVICE = "iva-brain.service";
  const BRAIN_TIMER = "iva-brain.timer";
  const UPDATE_TIMER = "iva-update-check.timer";
  const TIMERS = [BRAIN_TIMER, UPDATE_TIMER];

  const SVC_USERBOT = "iva-telegram-userbot.service";
  const USERBOT_DIR = join(ROOT, "services/telegram-userbot");
  const VENV_PY = join(USERBOT_DIR, ".venv/bin/python");
  const TOKEN_FILE = join(dataDirAbs(), "telegram-userbot.token");

  const DEFAULT_PORT = "8723";

  const C: RuntimeColors =
    process.env.NO_COLOR || process.env.TERM === "dumb"
      ? { g: "", y: "", r: "", c: "", b: "", d: "", x: "" }
      : {
          g: "\x1b[32m",
          y: "\x1b[33m",
          r: "\x1b[31m",
          c: "\x1b[36m",
          b: "\x1b[1m",
          d: "\x1b[2m",
          x: "\x1b[0m",
        };
  const ok = (message: string): void => console.log(`${C.g}✓${C.x} ${message}`);
  const warn = (message: string): void =>
    console.log(`${C.y}!${C.x} ${message}`);
  const bad = (message: string): void =>
    console.log(`${C.r}✗${C.x} ${message}`);
  const step = (message: string): void =>
    console.log(`${C.b}${C.c}▸ ${message}${C.x}`);

  function run(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions = {},
  ) {
    return spawnSync(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: childEnv,
      ...options,
    });
  }

  function cap(
    command: string,
    args: readonly string[],
    options: CaptureOptions = {},
  ): CaptureResult {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnv,
      ...options,
    });
    return {
      code: result.status ?? 1,
      out: (result.stdout || "").trim(),
      err: (
        result.stderr ||
        (command === "lsof" ? result.error?.message : "") ||
        ""
      ).trim(),
    };
  }

  const hasSystemd = (): boolean => serviceManager() !== null;
  const scQ = (...args: string[]): CaptureResult => {
    if (serviceManager() !== "launchd")
      return cap("systemctl", ["--user", ...args]);
    const result = runLaunchd(args, { unitDir: UNIT_DIR });
    return { ...result, err: result.err ?? "" };
  };
  const systemd = createSystemdControl({
    run: (args) => scQ(...args),
    manager: serviceManager() ?? "systemd",
  });
  // On the immutable layout there is no working tree to ask: the commit a version
  // was built from is part of its directory name.
  const gitHead = (): string =>
    parseVersionName(basename(real(ROOT)))?.sha ||
    cap("git", ["rev-parse", "--short", "HEAD"]).out ||
    "";

  /**
   * `.env` читается ТЕМ ЖЕ парсером, что и сам процесс: сервис стартует через
   * `node --env-file=.env` (package.json, deploy/*.service), и `util.parseEnv` — ровно его
   * разбор. Своя регулярка клала в значение инлайн-комментарий целиком
   * (`KEY=secret # note` → `secret # note`) и видела только первую строку многострочного
   * значения в кавычках, поэтому половина ключа уезжала мимо любого списка вырезания (T21).
   * Битая строка бросает, как и у `node --env-file`: молча продолжать значит читать
   * установку не так, как её читает сервис.
   */
  function readEnv(): EnvValues {
    if (!existsSync(ENV_PATH)) return {};
    const env: EnvValues = {};
    for (const [key, value] of Object.entries(
      parseEnv(readFileSync(ENV_PATH, "utf8")),
    ))
      if (typeof value === "string") env[key] = value;
    return env;
  }

  function dataDirAbs(env: Partial<EnvValues> = readEnv()): string {
    return resolveDataDir(ROOT, env.ASSISTANT_DATA_DIR);
  }

  async function confirm(question: string, defaultValue = false) {
    if (!process.stdin.isTTY) return defaultValue;
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = (
      await readline.question(
        `${question} ${defaultValue ? "[Y/n]" : "[y/N]"} `,
      )
    )
      .trim()
      .toLowerCase();
    readline.close();
    return answer ? answer.startsWith("y") : defaultValue;
  }

  function requireSystemd(): void {
    if (serviceManager() === "launchd") {
      const result = runLaunchd(["daemon-reload"], { unitDir: UNIT_DIR });
      if (result.code !== 0) {
        bad(result.out);
        process.exit(1);
      }
    }
    if (!hasSystemd()) {
      bad("systemd unavailable — this command only works on a Linux server");
      process.exit(1);
    }
  }

  // Через formatEnvLine, как и остальные писатели: `iva userbot creds` кладёт сюда
  // api_hash прямо из рук владельца, и значение вне безопасного подмножества обязано
  // получить отказ, а не лечь в файл огрызком.
  function writeEnvVars(vars: Readonly<Record<string, unknown>>): void {
    const lines = new Map(
      Object.entries(vars).map(([key, value]) => [
        key,
        formatEnvLine(key, String(value)),
      ]),
    );
    const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
      if (key && Object.hasOwn(vars, key)) {
        const replacement = lines.get(key);
        if (replacement !== undefined) {
          out.push(replacement);
          lines.delete(key);
        }
        continue;
      }
      out.push(line);
    }
    while (out.length && out.at(-1) === "") out.pop();
    for (const line of lines.values()) out.push(line);
    writeEnvAtomicSync(ENV_PATH, `${out.join("\n")}\n`);
  }

  return {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NODE,
    NODE_BIN_DIR,
    NPM,
    childEnv,
    uvExecutable: () => resolveUv(childEnv.PATH, homedir()),
    SERVICES,
    BRAIN_SERVICE,
    BRAIN_TIMER,
    UPDATE_TIMER,
    TIMERS,
    SVC_USERBOT,
    USERBOT_DIR,
    VENV_PY,
    TOKEN_FILE,
    DEFAULT_PORT,
    C,
    ok,
    warn,
    bad,
    step,
    run,
    cap,
    hasSystemd,
    scQ,
    systemd,
    gitHead,
    readEnv,
    dataDirAbs,
    confirm,
    requireSystemd,
    writeEnvVars,
  };
}
