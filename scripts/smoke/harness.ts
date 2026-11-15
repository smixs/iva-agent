import "../fixtures/no-host-anthropic.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { text } from "node:stream/consumers";
import { after, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import {
  type runNode,
  freePort,
  prepareApp,
  startEve,
  type EveProcess,
} from "../lib/eve-app.ts";
import { rebaseBuildOutput } from "../lib/custom-layer.ts";
import {
  startMockOpenAiServer,
  type MockStep,
} from "../lib/mock-openai-server.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const diskTmp = process.env.TMPDIR ?? join(ROOT, ".scratch/smoke/tmp");
export const NOW = "2026-06-15T12:00:00.000Z";
export const OWNER = 12345;
export const TOKEN = "987654321:smoke-only";
export const SECRET = "smoke-webhook-secret";

/** Retry a condition until its deadline; never replace observable readiness with a delay. */
export function waitFor<T>(
  condition: () => T | Promise<T>,
  timeoutMs = 30_000,
): Promise<NonNullable<T>> {
  return new Promise((resolve, reject) => {
    let checking = false;
    const deadline = setTimeout(() => {
      clearInterval(tick);
      reject(
        new Error(`Smoke condition did not become true within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await condition();
        if (result) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve(result);
        }
      } catch (error) {
        clearInterval(tick);
        clearTimeout(deadline);
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    };
    const tick = setInterval(() => {
      void check();
    }, 25);
    void check();
  });
}

import { smokeParameters } from "./pbt.ts";
export { smokeParameters } from "./pbt.ts";

export async function smokeProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IAsyncProperty<Ts> | fc.IProperty<Ts>,
) {
  await fc.assert(property, smokeParameters());
}

export type BotRequest = {
  method: string;
  body: Record<string, unknown>;
  raw: string;
  chat: unknown;
  topic: unknown;
};
export async function startTelegram(log: string) {
  const requests: BotRequest[] = [];
  const refusals: { method: string; status: number }[] = [];
  const batches: unknown[][] = [];
  let pending: ServerResponse | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let messageId = 100;
  const answer = (res: ServerResponse, result: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  };
  const flush = () => {
    if (!pending) return;
    clearTimeout(deadline);
    const res = pending;
    pending = undefined;
    answer(res, batches.shift() ?? []);
  };
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await text(req);
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const method = req.url?.split("/").pop() ?? "";
      const entry = {
        method,
        body,
        raw,
        chat: body.chat_id,
        topic: body.message_thread_id,
      };
      requests.push(entry);
      appendFileSync(log, JSON.stringify(entry) + "\n");
      if (refusals[0]?.method === method) {
        const refusal = refusals.shift()!;
        res.writeHead(refusal.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: refusal.status,
            description: "smoke Bot API refusal",
          }),
        );
        return;
      }
      if (method === "getUpdates") {
        if (pending) throw new Error("Concurrent getUpdates");
        pending = res;
        res.on("close", () => {
          if (pending === res) {
            pending = undefined;
            clearTimeout(deadline);
          }
        });
        if (batches.length) flush();
        // End each long poll to let the real Bridge drain its durable inbox.
        else deadline = setTimeout(flush, 100);
      } else if (method === "getMe")
        answer(res, {
          id: 987654321,
          is_bot: true,
          first_name: "Smoke",
          username: "smoke_bot",
        });
      else if (/^(send|edit)/u.test(method))
        answer(res, {
          message_id: ++messageId,
          date: Date.parse(NOW) / 1000,
          chat: { id: body.chat_id, type: "private" },
          text: body.text,
        });
      else answer(res, true);
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Bot API failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    rejectNext: (method: string, status: number) =>
      refusals.push({ method, status }),
    push: (...updates: unknown[]) => {
      batches.push(updates);
      flush();
    },
    close: async () => {
      clearTimeout(deadline);
      pending = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function environment(
  root: string,
  app: string,
  port: number,
  provider: string,
  telegram: string,
): NodeJS.ProcessEnv {
  const imports = [
    join(ROOT, "scripts/fixtures/shifted-clock.ts"),
    join(ROOT, "scripts/smoke/telegram-wire.ts"),
  ];
  return {
    PATH: join(root, "bin") + ":" + (process.env.PATH ?? ""),
    SMOKE_UNIT_STATE: join(root, "units.json"),
    SMOKE_UNIT_LOG: join(root, "units.jsonl"),
    HOME: root,
    TMPDIR: join(root, "tmp"),
    TZ: "UTC",
    NODE_ENV: "production",
    NODE_DISABLE_COMPILE_CACHE: "1",
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_cache: join(root, "npm-cache"),
    NODE_OPTIONS: imports
      .map((file) => `--import=${pathToFileURL(file).href}`)
      .join(" "),
    IVA_TEST_NOW: NOW,
    PORT: String(port),
    IVA_PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: provider,
    OLLAMA_API_KEY: "smoke-key",
    OLLAMA_MODEL: "iva-smoke",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_BEARER: "smoke-bearer-" + "a".repeat(40),
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
    AGENT_LANGUAGE: "en",
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_BOT_USERNAME: "smoke_bot",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: SECRET,
    TELEGRAM_ALLOWED_USER_IDS: String(OWNER),
    TELEGRAM_CHAT_ID: String(OWNER),
    TELEGRAM_COLLECT_QUIET_MS: "0",
    TELEGRAM_POLL_SETTLE_MS: "0",
    TELEGRAM_RICH_REPLIES: "never",
    SMOKE_TELEGRAM_URL: telegram,
    SMOKE_ALLOWED_ORIGINS: JSON.stringify([
      new URL(provider).origin,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]),
    SMOKE_NETWORK_LOG: join(root, "network-denied.log"),
  };
}

// Workers of one node --test invocation share one build, even at concurrency=2.
const cache = join(diskTmp, `iva-smoke-build-${process.ppid}`);
const doneDir = join(cache, "done");
const workerDir = join(cache, "workers");
const suite = /^(smoke|smoke:full)$/u.test(
  process.env.npm_lifecycle_event ?? "",
);
const suiteParticipants = suite
  ? (
      await Promise.all(
        (await readdir(new URL("./", import.meta.url)))
          .filter((name) => name.endsWith(".smoke.ts"))
          .map(async (name) =>
            (await readFile(new URL(name, import.meta.url), "utf8")).includes(
              "./harness.ts",
            )
              ? name
              : null,
          ),
      )
    ).filter((name): name is string => name !== null)
  : [];
await mkdir(doneDir, { recursive: true });
await mkdir(workerDir, { recursive: true });
await writeFile(join(workerDir, basename(process.argv[1])), "active");
after(async () => {
  await writeFile(join(doneDir, basename(process.argv[1])), "done");
  const completed: string[] = await readdir(doneDir).catch(() => []);
  const participants = suite ? suiteParticipants : await readdir(workerDir);
  if (participants.every((name) => completed.includes(name))) {
    const failed = await readFile(join(cache, "failed"), "utf8").catch(
      () => "",
    );
    if (!failed) await rm(cache, { recursive: true, force: true });
    else console.error(`Smoke build evidence: ${cache}`);
  }
});
async function builtApp(
  env: NodeJS.ProcessEnv,
  run: typeof runNode,
): Promise<string> {
  const app = join(cache, "app");
  const owner = await mkdir(join(cache, "building")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      return false;
    },
  );
  if (owner) {
    try {
      await prepareApp(cache);
      await mkdir(join(cache, "tmp"), { recursive: true });
      console.log("smoke build: one production build for this suite");
      const buildEnv = {
        ...env,
        HOME: cache,
        TMPDIR: join(cache, "tmp"),
        ASSISTANT_DATA_DIR: join(app, "data"),
        ASSISTANT_VAULT_DIR: join(app, "vault"),
      };
      const note = (line: string) =>
        appendFileSync(join(cache, "build.log"), line + "\n");
      await run([join(app, "scripts/build.ts")], app, buildEnv, note);
      await writeFile(join(cache, "ready"), "ready");
    } catch (error) {
      await writeFile(join(cache, "build-error"), String(error));
      throw error;
    }
  } else {
    await waitFor(async () => {
      const failed = await readFile(join(cache, "build-error"), "utf8").catch(
        () => "",
      );
      if (failed) throw new Error(failed);
      return readFile(join(cache, "ready"), "utf8").catch(() => "");
    }, 120_000);
  }
  return app;
}

export async function kill(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
) {
  if (!child.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  const done = exited
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await done;
}

export async function createHarness(
  t: TestContext,
  steps: MockStep[] = [],
  beforeStart?: (app: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  await mkdir(diskTmp, { recursive: true });
  const root = await mkdtemp(join(diskTmp, "iva-smoke-"));
  await mkdir(join(root, "tmp"));
  await mkdir(join(root, "bin"));
  await symlink(
    join(ROOT, "scripts/smoke/systemctl.ts"),
    join(root, "bin/systemctl"),
  );
  await writeFile(join(root, "units.json"), "{}");
  const children: ChildProcess[] = [];
  const start = (
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    note: (line: string) => void,
  ) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => note(chunk.toString()));
    const abort = () => {
      void kill(child).catch((error: unknown) => note(String(error)));
    };
    t.signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => t.signal.removeEventListener("abort", abort));
    return child;
  };
  const run: typeof runNode = async (args, cwd, env, note) => {
    const child = start(args, cwd, env, note);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Child failed: ${args[0]} code=${code} signal=${signal}`,
              ),
            ),
      );
    });
  };
  const resources: {
    provider?: Awaited<ReturnType<typeof startMockOpenAiServer>>;
    telegram?: Awaited<ReturnType<typeof startTelegram>>;
  } = {};
  let passed = false;
  t.after(async () => {
    await Promise.all(children.map((child) => kill(child)));
    await Promise.all([
      resources.provider?.close(),
      resources.telegram?.close(),
    ]);
    if (resources.provider)
      await writeFile(
        join(root, "provider.json"),
        JSON.stringify(resources.provider.requests, null, 2),
      );
    const denied = await readFile(
      join(root, "network-denied.log"),
      "utf8",
    ).catch(() => "");
    if (passed && !denied) await rm(root, { recursive: true, force: true });
    else {
      await writeFile(join(cache, "failed"), "scenario failed");
      console.error(`Smoke evidence: ${root}`);
    }
    if (denied) throw new Error(denied);
  });
  const provider = (resources.provider = await startMockOpenAiServer(
    steps,
    (request) =>
      appendFileSync(
        join(root, "provider.jsonl"),
        JSON.stringify(request) + "\n",
      ),
  ));
  const telegram = (resources.telegram = await startTelegram(
    join(root, "telegram.jsonl"),
  ));
  const port = await freePort();
  const app = join(root, "app");
  const env = environment(root, app, port, provider.baseUrl, telegram.url);
  const source = await builtApp(env, run);
  await cp(source, app, { recursive: true, dereference: false });
  rebaseBuildOutput({
    outputDir: join(app, ".output"),
    buildRoot: source,
    appRoot: app,
  });
  await mkdir(join(app, "data"), { recursive: true });
  const note = (line: string) =>
    appendFileSync(join(root, "process.log"), line + "\n");
  await writeFile(
    join(app, ".env"),
    `ASSISTANT_BEARER=${env.ASSISTANT_BEARER}\n`,
    { mode: 0o600 },
  );
  await beforeStart?.(app, env);
  await run([join(app, "scripts/init-vault.mjs")], app, env, note);
  await writeFile(join(app, "data/telegram-offset.json"), '{"offset":0}');
  const eve: EveProcess = startEve(app, env, port, note);
  children.push(eve);
  await waitFor(async () => {
    if (eve.exitCode !== null || eve.signalCode)
      throw new Error("eve exited before health");
    return (
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null)
    )?.ok;
  }, 60_000);
  const bridge = start([join(app, "scripts/smoke/bridge.ts")], app, env, note);
  await waitFor(() => {
    if (bridge.exitCode !== null || bridge.signalCode)
      throw new Error("Bridge exited before getUpdates");
    return telegram.requests.some((request) => request.method === "getUpdates");
  });
  return {
    run: (args: string[]) => run(args, app, env, note),
    start: (args: string[]) => start(args, app, env, note),
    root,
    app,
    env,
    port,
    provider,
    telegram,
    eve,
    bridge,
    saveEvidence: async (name: string) => {
      if (!process.env.SMOKE_EVIDENCE_DIR) return;
      const destination = join(process.env.SMOKE_EVIDENCE_DIR, name);
      await mkdir(destination, { recursive: true });
      for (const file of ["process.log", "provider.jsonl", "telegram.jsonl"])
        await cp(join(root, file), join(destination, file));
    },
    pass: () => {
      passed = true;
    },
    post: async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": SECRET,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response;
    },
  };
}

export function message(
  updateId: number,
  value = "smoke question",
  messageId = updateId,
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Date.parse(NOW) / 1000,
      from: { id: OWNER, is_bot: false, first_name: "Owner" },
      chat: { id: OWNER, type: "private" },
      text: value,
    },
  };
}
