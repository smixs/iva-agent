import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  commandFile,
  commandLog,
  list,
  recordDelivery,
  ReminderNotFoundError,
  COMMAND_TIMEOUT_MS,
  commandTimeoutMs,
  clearCommandAlert,
} from "#lib/reminder-store.ts";
import { dataDir } from "#lib/data-dir.ts";
import { alertOnce, alertResolved } from "../lib/notice-policy.ts";
import { ownerChat } from "../lib/notification-chat.ts";
import { sendTelegramHtml } from "../lib/telegram-send.ts";
import { redactNotice } from "../lib/notice.ts";
import { isEntrypoint } from "../lib/version-layout.ts";

const MAX_LOG = 32_000;
export async function runCommand(
  command: string,
  root: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ ok: boolean; error: string | null; output: string }> {
  if (timeoutMs <= 0) return { ok: false, error: "timeout", output: "" };
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, {
      cwd: root,
      shell:
        ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path)) ?? true,
      env: { ...process.env, IVA_AGENT_TURN: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          output = `${output}\nprocess group: ${String(error)}`.slice(-MAX_LOG);
        }
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ ok: false, error: "timeout", output });
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-MAX_LOG);
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, output });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const error = code === 0 ? null : `exit ${code ?? signal}`;
      resolve({ ok: error === null, error, output });
    });
  });
}

export async function runCommandFire(
  id: string,
  options: {
    root?: string;
    timeoutMs?: number;
    firedAt?: number;
    send?: typeof sendTelegramHtml;
  } = {},
): Promise<number> {
  const file = commandFile();
  const row = (await list(file)).find((candidate) => candidate.id === id);
  if (
    !row ||
    row.firedAt === null ||
    (options.firedAt !== undefined && row.firedAt !== options.firedAt)
  )
    return 2;
  const result = await runCommand(
    row.text,
    options.root ?? process.cwd(),
    options.timeoutMs ??
      (options.firedAt === undefined
        ? commandTimeoutMs(row)
        : row.firedAt + commandTimeoutMs(row) - Date.now()),
  );
  const log = commandLog(id);
  let previous = "";
  try {
    previous = readFileSync(log, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const fact = await recordDelivery(
      id,
      { firedAt: row.firedAt, delivered: result.ok, error: result.error },
      {
        file,
        onRecord: () => {
          writeFileSync(
            log,
            (
              previous +
              `\n${new Date().toISOString()} ${id} ${result.error ?? "ok"}\n${result.output}`
            ).slice(-MAX_LOG),
            { mode: 0o600 },
          );
        },
      },
    );
    if (fact.firedAt !== row.firedAt) return 0;
  } catch (error) {
    if (error instanceof ReminderNotFoundError) return 0;
    throw error;
  }
  const key = `schedule-${id}`;
  if (result.ok) alertResolved(dataDir(), key);
  else
    await alertOnce(dataDir(), key, result.error ?? "error", async () => {
      const chat = ownerChat(process.env);
      if (!chat) return false;
      return (
        await (options.send ?? sendTelegramHtml)(
          process.env.TELEGRAM_BOT_TOKEN ?? "",
          chat,
          await redactNotice(
            `Задача «${(await redactNotice(row.text)).replace(/\s+/gu, " ").slice(0, 60)}» не выполнилась: ${result.error?.startsWith("timeout") ? `не уложилась в ${commandTimeoutMs(row) / 60_000} мин` : "завершилась с ошибкой"}. Журнал: list`,
          ),
        )
      ).ok;
    });
  if (!(await list(file)).some((candidate) => candidate.id === id))
    await clearCommandAlert(id);
  return 0;
}
if (isEntrypoint(import.meta.url))
  process.exit(
    await runCommandFire(process.argv[2] ?? "", {
      firedAt: Number(process.argv[3]),
    }),
  );
