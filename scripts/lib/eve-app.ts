// Одноразовое приложение Ивы для смоуков: те же деревья, что у рантайма, сборка и старт eve.
// Общая раскладка герметичных смоуков и live-turn.
import { spawn } from "node:child_process";
import { cp, mkdir, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_SOURCE_TREES } from "./custom-layer.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HEALTH_TIMEOUT_MS = 90_000;

type Note = (line: string) => void;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function prepareApp(sandbox: string): Promise<string> {
  const app = join(sandbox, "app");
  await mkdir(app, { recursive: true });
  // Деревья те же, что у промоутнутого рантайма; полноту списка держит страж.
  for (const dir of [...RUNTIME_SOURCE_TREES, "vault-template"]) {
    await cp(join(ROOT, dir), join(app, dir), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(ROOT, file), join(app, file));
  }
  // node_modules симлинком: npm ci отдельно проверяет разрешение зависимостей,
  // а здесь он бы стоил минуты и сотни мегабайт на каждый прогон.
  await symlink(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
  await mkdir(join(app, "data"), { recursive: true });
  return app;
}

function capture(stream: Readable, note: Note) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    lines.filter(Boolean).forEach(note);
  });
  stream.on("end", () => {
    if (pending) note(pending);
  });
}

export function runNode(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  note: Note,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    capture(child.stdout, note);
    capture(child.stderr, note);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`node ${args.join(" ")} exited with ${code}`)),
    );
  });
}

export function startEve(
  app: string,
  env: NodeJS.ProcessEnv,
  port: number,
  note: Note,
) {
  const child = spawn(
    process.execPath,
    [
      join(app, "node_modules/eve/bin/eve.js"),
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  capture(child.stdout, note);
  capture(child.stderr, note);
  return child;
}

export type EveProcess = ReturnType<typeof startEve>;

export async function stopEve(child: EveProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch {
    return;
  }
  // Окно graceful stop у самого eve — 5с; даём заметно больше, чтобы SIGKILL
  // не обрубал запись состояния .workflow-data на полпути.
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(resolve, 15000, "timeout");
  });
  const result = await Promise.race([gone, timer]);
  clearTimeout(timeout);
  if (result === "timeout") {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch (error) {
      // ESRCH: группа уже вышла сама между таймаутом и сигналом.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await gone;
  }
}

export async function waitForHealth(
  port: number,
  child: EveProcess,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `eve exited with ${child.exitCode} before becoming healthy`,
      );
    // Отказ соединения и таймаут - сервер ещё не поднялся, ждём дальше.
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `eve did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
  );
}
