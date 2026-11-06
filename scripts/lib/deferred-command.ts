import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { z } from "zod";
const requestSchema = z.object({
  id: z.string().uuid(),
  argv: z.array(z.string()).min(1),
  createdAt: z.string().datetime(),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional(),
  launchedAt: z.number().optional(),
  result: z.boolean().optional(),
  reportAttempts: z.number().int().nonnegative().optional(),
});
const resultText = (ok: boolean) => (ok ? "выполнено" : "ошибка выполнения");
const pendingPath = (dir: string) => join(dir, "deferred-command.json");
const activePath = (dir: string) => join(dir, "deferred-command.active.json");
const identity = (pid: number) =>
  execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { TZ: "UTC", LC_ALL: "C" },
  }).trim();
const store = () => import("#lib/json-store.ts");
async function save(file: string, value: unknown) {
  const { saveJsonAtomic } = await store();
  await saveJsonAtomic(file, value, { mode: 0o600 });
}
async function locked<T>(dir: string, work: () => Promise<T>) {
  const { acquireLock, releaseLock } = await store();
  const file = `${pendingPath(dir)}.lock`,
    token = await acquireLock(file);
  try {
    return await work();
  } finally {
    releaseLock(file, token);
  }
}
async function quarantine(
  file: string,
  record: unknown,
  reason: unknown,
  log = console.error,
) {
  const { quarantineDamagedRecord } = await import("#lib/damaged-record.ts");
  quarantineDamagedRecord(
    file,
    { reason: String(reason), record, label: "deferred" },
    log,
  );
  fs.rmSync(file);
}
async function read(file: string, log = console.error) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  try {
    return requestSchema.parse(JSON.parse(raw));
  } catch (error) {
    await quarantine(file, raw, error, log);
    return null;
  }
}
export function deferrable(argv: readonly string[]): boolean {
  return (
    !argv.includes("--help") &&
    !argv.includes("-h") &&
    "restart stop update rollback reset config".split(" ").includes(argv[0])
  );
}
export function fromTurn(dir: string, argv: readonly string[]) {
  if (process.env.IVA_AGENT_TURN !== "1") return null;
  if (
    argv[0] === "plugin" &&
    "trust enable update sync install-proposal".split(" ").includes(argv[1])
  ) {
    console.error("это ставится по тапу владельца: iva plugin propose <папка>");
    process.exitCode = 1;
    return Promise.resolve();
  }
  return deferrable(argv)
    ? deferCommand(dir, argv).then((ok) => {
        if (!ok) process.exitCode = 1;
      })
    : null;
}
export async function deferCommand(dir: string, argv: readonly string[]) {
  return locked(dir, async () => {
    const existing =
      (await read(activePath(dir))) ?? (await read(pendingPath(dir)));
    if (existing) {
      const same = JSON.stringify(existing.argv) === JSON.stringify(argv);
      console.log(same ? "Уже принято." : "Отказ: другая команда ожидает.");
      return same;
    }
    await save(pendingPath(dir), {
      id: randomUUID(),
      argv,
      createdAt: new Date().toISOString(),
    });
    console.log(`${argv.join(" ")} выполнится сразу после конца этого хода`);
    return true;
  });
}
export async function activityBusy(dir: string) {
  const { listChatStatuses } = await import("#lib/run-status.ts");
  const { readHelpers } = await import("#lib/helper-store.ts");
  const helpers = (await readHelpers(join(dir, "helpers.json"))).rows;
  return (
    listChatStatuses().some(
      ({ status }) => status.status === "running" || status.compacting === true,
    ) || helpers.some((row) => row.run !== null)
  );
}
export async function executeDeferred(dir: string, root: string, id: string) {
  const request = await locked(dir, async () => {
    const pending = await read(activePath(dir));
    if (
      !pending ||
      pending.id !== id ||
      pending.pid ||
      pending.result !== undefined
    )
      return null;
    const owned = {
      ...pending,
      pid: process.pid,
      startedAt: identity(process.pid),
    };
    await save(activePath(dir), owned);
    return owned;
  });
  if (!request) return;
  while (await activityBusy(dir))
    await new Promise((resolve) => setTimeout(resolve, 250));
  const output = join(dir, `deferred-command.${id}.log`);
  const env = { ...process.env, ASSISTANT_DATA_DIR: dir, IVA_AGENT_TURN: "" };
  const cli = (argv: readonly string[]) =>
    new Promise<boolean>((resolve) => {
      const fd = fs.openSync(output, "a", 0o600);
      try {
        const child = spawn(
          process.execPath,
          [join(root, "bin/iva.mjs"), ...argv],
          { cwd: root, env, stdio: ["ignore", fd, fd] },
        );
        child.once("error", () => resolve(false));
        child.once("close", (code) => resolve(code === 0));
      } finally {
        fs.closeSync(fd);
      }
    });
  const result = await cli(request.argv);
  if (!result) console.error("deferred command failed:", output);
  await save(activePath(dir), { ...request, result });
  if (await cli(["notify", `${request.argv[0]}: ${resultText(result)}.`]))
    fs.rmSync(activePath(dir));
  else console.error("deferred command report pending:", id);
}
type DeferredIo = {
  busy: () => boolean;
  launch: (argv: readonly string[]) => Promise<{ ok: boolean; msg: string }>;
  report: (text: string) => Promise<unknown>;
  log?: (...parts: unknown[]) => void;
};
async function activeOutstanding(dir: string, io: DeferredIo) {
  const log = io.log ?? console.error;
  const report = async (active: z.infer<typeof requestSchema>) => {
    const outcome =
      active.result === undefined
        ? "исполнение не подтверждено; проверь iva status"
        : resultText(active.result);
    active.reportAttempts = (active.reportAttempts ?? 0) + 1;
    await save(activePath(dir), active);
    try {
      await io.report(`${active.argv.join(" ")}: ${outcome}.`);
    } catch (error) {
      if (active.reportAttempts < 10) throw error;
      await quarantine(
        activePath(dir),
        active,
        `report failed after ${active.reportAttempts} attempts: ${String(error)}`,
        log,
      );
      return;
    }
    fs.rmSync(activePath(dir));
  };
  return locked(dir, async () => {
    const active = await read(activePath(dir), log);
    if (!active) return false;
    try {
      if (
        active.pid &&
        process.kill(active.pid, 0) &&
        active.startedAt === identity(active.pid)
      )
        return true;
    } catch (error) {
      log("deferred command owner:", String(error));
    }
    if (!active.pid && Date.now() - (active.launchedAt ?? 0) < 60000)
      return true;
    await report(active);
    return false;
  });
}
export async function reconcileDeferred(dir: string, io: DeferredIo) {
  const log = io.log ?? console.error;
  try {
    if (await activeOutstanding(dir, io)) return true;
    if (io.busy() || (await activityBusy(dir)))
      return fs.existsSync(pendingPath(dir));
    const request = await locked(dir, async () => {
      const pending = await read(pendingPath(dir), log);
      if (!pending || fs.existsSync(activePath(dir))) return null;
      await save(pendingPath(dir), { ...pending, launchedAt: Date.now() });
      fs.renameSync(pendingPath(dir), activePath(dir));
      return pending;
    });
    if (!request) return false;
    const result = await io.launch(["_deferred", request.id]);
    if (!result.ok) throw Error(result.msg);
    return true;
  } catch (error) {
    log("deferred command:", String(error));
    return false;
  }
}
