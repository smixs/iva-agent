// Живой ход дня: одноразовая установка Ивы, настоящий провайдер, полный набор тулов на проводе.
// Юнит-тесты и герметичные смоуки (mock-провайдер) не видят, что провайдер отвергнет запрос: так 0.4.9-beta.1
// ушла с write_card, чья схема роняла каждый ход. Ход просит запомнить факт, поэтому модель
// получает все тулы и вызывает write_card; зачёт - ответ пришёл и Card с фактом лежит в vault.
// Запуск только на c1 (живой путь Ивы - там), с провайдером и моделью установки:
//   cd ~/iva/current && set -a && . ~/iva/.env && set +a && PATH=$HOME/.local/bin:$PATH npm run live-turn
// Другой провайдер - переопределить MODEL_PROVIDER и его *_MODEL перед npm run.
// Ключ OpenAI API для прогонов не использовать: подписка через codex - да, токены по ключу - нет.
// Ключи и модель берутся из окружения по списку ниже; остальное окружение не передаётся.
import { pathToFileURL } from "node:url";
import { statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  freePort,
  prepareApp,
  runNode,
  startEve,
  stopEve,
  waitForHealth,
  type EveProcess,
} from "./lib/eve-app.ts";
import { carryCodexLogin } from "./lib/live-codex-auth.ts";
import { resolveDataDir } from "../packages/data-dir/index.ts";

const PROVIDER_ENV =
  /^(MODEL_PROVIDER|HELPER_MODEL|THINKING_EFFORT|(OLLAMA|OPENCODE|OPENROUTER|CODEX|CLAUDE|CUSTOM)_[A-Z_]+)$/u;
const MARK = randomBytes(3).toString("hex");
const FACT = `кот Барсик-${MARK} любит рыбу`;
const TURN_TIMEOUT_MS = 240_000;

export const liveTurnHeaders = (helper = false): Record<string, string> =>
  helper ? { "x-iva-turn": "helper", "x-iva-helper": `h-${MARK}` } : {};
export function helperWireResult(
  chat: readonly string[],
  helper: readonly string[],
) {
  const first = (logs: readonly string[]) => {
    const line = logs.find((line) => line.startsWith("LIVE_HELPER_WIRE "));
    if (!line) throw new Error("provider wire missing");
    return JSON.parse(line.slice(17)) as {
      model: string;
      tools: number;
      hash: string;
      helperBlock: boolean;
    };
  };
  const normal = first(chat),
    background = first(helper);
  if (
    !Number.isSafeInteger(normal.tools) ||
    normal.tools <= 0 ||
    !/^[0-9a-f]{64}$/u.test(normal.hash) ||
    background.helperBlock !== true ||
    normal.tools !== background.tools ||
    normal.hash !== background.hash
  )
    throw new Error("helper wire differs from chat or helper block is missing");
  return { model: background.model, tools: background.tools };
}

async function cardsWith(vault: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(join(vault, "cards"), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(entry.parentPath, entry.name);
    if ((await readFile(file, "utf8")).includes(needle)) hits.push(file);
  }
  return hits;
}

function liveEnv(app: string, port: number, bearer: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    // claude берёт вход из HOME хоста. Вход codex лежит в data/codex-auth.json установки:
    // его копирует carryCodexLogin, остальных данных Ивы хоста здесь нет.
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    NODE_ENV: "production",
    PORT: String(port),
    IVA_PORT: String(port),
    ASSISTANT_BEARER: bearer,
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => PROVIDER_ENV.test(key)),
    ),
  };
}

/** Вход codex из данных установки (ASSISTANT_DATA_DIR или ./data) во временную Иву. */
async function carryLogin(app: string): Promise<void> {
  const missing = await carryCodexLogin(
    process.env.MODEL_PROVIDER,
    resolveDataDir(process.cwd()),
    join(app, "data"),
  );
  if (missing !== null) throw new Error(missing);
}

export async function prepareLiveApp(
  sandbox: string,
  note: (line: string) => void,
) {
  const app = await prepareApp(sandbox);
  const port = await freePort();
  const bearer = randomBytes(24).toString("hex");
  const env = liveEnv(app, port, bearer);
  if (process.env.LIVE_TURN_KIND === "helper") env.IVA_LIVE_WIRE = "1";
  await carryLogin(app);
  await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, {
    mode: 0o600,
  });
  await runNode([join(app, "scripts/init-vault.mjs")], app, env, note);
  await runNode(
    [join(app, "node_modules/eve/bin/eve.js"), "build"],
    app,
    env,
    note,
  );
  return { app, env, port, bearer };
}

async function startLiveApp(sandbox: string, note: (line: string) => void) {
  const { app, env, port, bearer } = await prepareLiveApp(sandbox, note);
  const eve = startEve(app, env, port, note);
  return { eve, port, bearer, vault: join(app, "vault") };
}

async function dayTurn(
  port: number,
  bearer: string,
  helper: boolean,
): Promise<string> {
  const { Client } = await import("eve/client");
  const client = new Client({
    host: `http://127.0.0.1:${port}`,
    headers: liveTurnHeaders(helper),
    // eslint-disable-next-line @typescript-eslint/require-await -- eve ждёт async-колбэк.
    auth: { bearer: async () => bearer },
  });
  const { session, response } = await client.sessions.create({
    message: `Запомни в память: ${FACT}. Сохрани это как Card и ответь одним словом «готово».`,
  });
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    response.result(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(reject, TURN_TIMEOUT_MS, new Error("turn timeout"));
    }),
  ]).finally(() => clearTimeout(timer));
  await session.reset({ reason: "live turn done" }).catch(() => undefined);
  const reply = result.message?.trim() ?? "";
  if (result.status === "failed" || reply === "")
    throw new Error(`turn failed: status=${result.status}`);
  return reply;
}

/** Card с фактом; без неё - ошибка со списком того, что ход записал в vault. */
async function factCards(vault: string, since: number, reply: string) {
  const cards = await cardsWith(vault, MARK);
  if (cards.length > 0) return cards.length;
  const written = (
    await readdir(vault, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => statSync(file).mtimeMs >= since)
    .map((file) => file.slice(vault.length + 1));
  throw new Error(
    `no Card with the fact; vault changes: ${JSON.stringify(written)}; reply: ${reply.slice(0, 200)}`,
  );
}

function liveModel() {
  const provider = process.env.MODEL_PROVIDER;
  if (!provider) throw new Error("MODEL_PROVIDER is required");
  return {
    provider,
    model: process.env[`${provider.toUpperCase()}_MODEL`] ?? "default",
  };
}

async function main(): Promise<void> {
  const { provider, model } = liveModel();
  const sandbox = await mkdtemp(join(tmpdir(), "iva-live-"));
  const logs: string[] = [];
  const note = (line: string) => logs.push(line);
  let eve: EveProcess | null = null;
  try {
    const live = await startLiveApp(sandbox, note);
    eve = live.eve;
    await waitForHealth(live.port, eve);
    const since = Date.now();
    const reply = await dayTurn(live.port, live.bearer, false);
    const cards = await factCards(live.vault, since, reply);
    if (process.env.LIVE_TURN_KIND === "helper") {
      const before = logs.length;
      await dayTurn(live.port, live.bearer, true);
      const wire = helperWireResult(logs.slice(0, before), logs.slice(before));
      console.log(
        `live turn OK: ${provider} ${wire.model}; helper tools ${wire.tools} (same as chat: yes); helper block yes`,
      );
      return;
    }
    console.log(
      `live turn OK: ${provider} ${model}; Card ${cards}; reply ${JSON.stringify(reply.slice(0, 80))}`,
    );
  } catch (error) {
    console.error(`live turn FAILED: ${provider} ${model}: ${String(error)}`);
    for (const line of logs.slice(-60)) console.error(line);
    process.exitCode = 1;
  } finally {
    await stopEve(eve);
    if (process.env.LIVE_KEEP === "1")
      console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
