// Replica-смоук: одноразовая полностью изолированная установка ивы + mock-провайдер.
// Проверяет то, что юнит-тесты не видят: прод-билд eve, старт сервера, первый реальный
// ответ через провайдера и restart/resume сессии. Ни .env, ни Telegram-токена, ни живого
// vault — только временная директория и закрытый allowlist переменных окружения.
// Запуск: npm run replica, локально после npm run build. По мотивам stabilization-форка
// mamysh/iva (PR #7), переписано под upstream.
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startMockOpenAiServer } from "./lib/mock-openai-server.ts";
import {
  freePort,
  prepareApp,
  runNode,
  startEve as startApp,
  stopEve,
  waitForHealth,
  type EveProcess,
} from "./lib/eve-app.ts";
import type {
  Client,
  ClientSession,
  ClientSessionState,
  MessageResponse,
  MessageResult,
} from "eve/client";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = "CEDAR-4729";
const RESET_MARKER = "CEDAR-5533";
const UPGRADE_MARKER = "CEDAR-8140";
// Ответ mock-провайдера, когда в транскрипте нет НИ ОДНОГО маркера CEDAR, то есть
// история сессии пуста (scripts/lib/mock-openai-server.ts).
const EMPTY_HISTORY_REPLY = "MISSING_MARKER";
// Версия, на которую подменяется eve в durable-логе канарейкой апгрейда.
const FORGED_EVE_VERSION = "0.0.0-forged";
const TURN_TIMEOUT_MS = 120_000;

let phase = "prepare";
function setPhase(name: string): void {
  phase = name;
  note(`[smoke] ${new Date().toISOString()} phase: ${name}`);
}
const logs: string[] = [];

function note(line: string): void {
  logs.push(line);
  if (logs.length > 400) logs.shift();
}

function replicaEnv({
  sandbox,
  app,
  port,
  mockBaseUrl,
  bearer,
}: {
  sandbox: string;
  app: string;
  port: number;
  mockBaseUrl: string;
  bearer: string;
}): NodeJS.ProcessEnv {
  // Закрытый allowlist: process.env НЕ спредится — ни секретов хоста, ни его настроек.
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    NODE_ENV: "production",
    PORT: String(port),
    IVA_PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: mockBaseUrl,
    OLLAMA_API_KEY: "replica-key",
    OLLAMA_MODEL: "iva-replica",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_BEARER: bearer,
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
  };
}

async function turnResult(
  response: MessageResponse,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  let result: MessageResult;
  try {
    result = await Promise.race([
      response.result(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          reject,
          timeoutMs,
          new Error(`turn timed out after ${timeoutMs / 1000}s`),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  note(`[smoke] turn done: ${JSON.stringify(result?.status)}`);
  if (result.status === "failed" || !result.message) {
    throw new Error(
      `turn failed: status=${result.status} message=${JSON.stringify(result.message ?? "")}`,
    );
  }
  return result.message.trim();
}

async function firstTurn(
  client: Client,
  prompt: string,
  ownedSessions: Set<ClientSession>,
): Promise<{ session: ClientSession; message: string }> {
  const { session, response } = await client.sessions.create({
    message: prompt,
  });
  ownedSessions.add(session);
  note(`[smoke] send accepted (session ${session.state.sessionId})`);
  return { session, message: await turnResult(response) };
}

async function turn(
  session: ClientSession,
  prompt: string,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<string> {
  const response = await session.send(prompt);
  note(`[smoke] send accepted (session ${session.state.sessionId})`);
  return turnResult(response, timeoutMs);
}

function resumeSession(
  client: Client,
  state: ClientSessionState,
): ClientSession {
  return client.sessions.attach(state.sessionId, {
    streamIndex: state.streamIndex,
  });
}

async function prepareReplica(sandbox: string): Promise<string> {
  const app = await prepareApp(sandbox);
  // Канал-фикстура живёт ТОЛЬКО в одноразовом приложении: он даёт смоуку тот же
  // send/reset, что зовёт telegram-мост. Пути роутов дублируются константами ниже —
  // разъехались, и смоук падает на 404, молча пройти не сможет.
  await cp(
    join(ROOT, "scripts/fixtures/reset-canary-channel.ts"),
    join(app, "agent/channels/reset-canary.ts"),
  );
  return app;
}

function errorDetail(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message ?? error;
}

// Роуты канала-фикстуры scripts/fixtures/reset-canary-channel.ts.
const CANARY_SEND_ROUTE = "/replica/canary/send";
const CANARY_RESET_ROUTE = "/replica/canary/reset";
const CANARY_REPLY_LOG = "replica-canary.jsonl";

async function canaryPost(
  { port, bearer }: { port: number; bearer: string },
  route: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${route} returned HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Ждёт финальную реплику канала-фикстуры для sessionId, считая только записи ПОСЛЕ
 * `fromLine`: второй ход той же сессии иначе прочитал бы ответ первого и любая проверка
 * истории стала бы вакуумной. Возвращает курсор для следующего ожидания.
 */
async function canaryReply(
  logPath: string,
  sessionId: string,
  fromLine: number,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<{ message: string; line: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let lines: string[] = [];
    try {
      lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    } catch {
      /* лог появляется вместе с первой завершённой репликой */
    }
    for (let i = fromLine; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]) as {
        sessionId?: unknown;
        message?: unknown;
      };
      if (entry.sessionId === sessionId && typeof entry.message === "string")
        return { message: entry.message.trim(), line: i + 1 };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `canary turn for session ${sessionId} did not complete within ${timeoutMs / 1000}s`,
  );
}

/**
 * Симулирует смену версии eve на месте. Шаги воркфлоу записаны в durable-лог вместе с
 * версией пакета (`step//eve@0.30.8//createSessionStep`), и при replay id сверяется
 * строкой с текущим потребителем, — значит ЛЮБОЙ апгрейд eve роняет припаркованный run
 * с CORRUPTED_EVENT_LOG. Переписав версию в логе, смоук получает ровно ту же расходимость,
 * что и настоящая переустановка, но без второй копии eve в песочнице.
 * Возвращает число переписанных файлов событий.
 */
async function forgeEveStepVersion(app: string): Promise<number> {
  const versionedStepId = /step\/\/eve@[^/"]+\/\//g;
  let rewritten = 0;
  for (const dataDir of [
    ".eve/.workflow-data",
    ".output/.eve/.workflow-data",
  ]) {
    const events = join(app, dataDir, "events");
    let files: string[];
    try {
      files = await readdir(events);
    } catch {
      continue; // этой сборкой такой каталог состояния не используется
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(events, file);
      const before = await readFile(path, "utf8");
      const after = before.replace(
        versionedStepId,
        `step//eve@${FORGED_EVE_VERSION}//`,
      );
      if (after === before) continue;
      await writeFile(path, after);
      rewritten++;
    }
  }
  return rewritten;
}

const RECALL = "What code did I ask you to remember? Reply with the code only.";

type CanaryTurn = (
  address: string,
  message: string,
) => Promise<{ sessionId: string; reply: string }>;

// Курсор лога общий на все ходы канала-фикстуры: ответ ищется только ПОСЛЕ прошлого.
function createCanaryTurn(
  canaryHttp: { port: number; bearer: string },
  canaryLog: string,
): CanaryTurn {
  let canaryLine = 0;
  return async (address, message) => {
    const from = canaryLine;
    const accepted = await canaryPost(canaryHttp, CANARY_SEND_ROUTE, {
      address,
      message,
    });
    const sessionId = accepted.sessionId;
    if (typeof sessionId !== "string" || !sessionId)
      throw new Error(
        `canary send returned no session id: ${JSON.stringify(accepted)}`,
      );
    const settled = await canaryReply(canaryLog, sessionId, from);
    canaryLine = settled.line;
    return { sessionId, reply: settled.message };
  };
}

type MockServer = Awaited<ReturnType<typeof startMockOpenAiServer>>;

interface Stack {
  sandbox: string;
  mock: MockServer;
  ownedSessions: Set<ClientSession>;
  eve: EveProcess | null;
}

interface Replica {
  stack: Stack;
  app: string;
  env: NodeJS.ProcessEnv;
  port: number;
  bearer: string;
  client: Client;
}

async function setupReplica(stack: Stack): Promise<Replica> {
  const app = await prepareReplica(stack.sandbox);
  const port = await freePort();
  const bearer = randomBytes(24).toString("hex");
  const env = replicaEnv({
    sandbox: stack.sandbox,
    app,
    port,
    mockBaseUrl: stack.mock.baseUrl,
    bearer,
  });
  await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, {
    mode: 0o600,
  });

  setPhase("vault");
  await runNode([join(app, "scripts/init-vault.mjs")], app, env, note);

  setPhase("build");
  await runNode(
    [join(app, "node_modules/eve/bin/eve.js"), "build"],
    app,
    env,
    note,
  );

  setPhase("start");
  stack.eve = startApp(app, env, port, note);
  await waitForHealth(port, stack.eve);

  // Тот же экземпляр eve, что и у реплики: её node_modules — симлинк на ROOT/node_modules.
  const { Client } = await import("eve/client");
  const client = new Client({
    host: `http://127.0.0.1:${port}`,
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async callback.
      bearer: async () => bearer,
    },
  });
  return { stack, app, env, port, bearer, client };
}

async function checkFirstReplyAndSeed(
  replica: Replica,
): Promise<{ session: ClientSession; savedState: ClientSessionState }> {
  setPhase("first-reply");
  const created = await firstTurn(
    replica.client,
    "Reply with a status word.",
    replica.stack.ownedSessions,
  );
  const session = created.session;
  const first = created.message;
  if (first !== "REPLICA_OK")
    throw new Error(`unexpected first reply: ${JSON.stringify(first)}`);

  setPhase("seed-marker");
  const remembered = await turn(session, `Remember this code: ${MARKER}`);
  if (remembered !== "REMEMBERED")
    throw new Error(`unexpected seed reply: ${JSON.stringify(remembered)}`);
  return { session, savedState: session.state };
}

interface ResetCanary {
  canaryTurn: CanaryTurn;
  canaryAddress: string;
  seed: { sessionId: string; reply: string };
}

// Канарейка reset: /new обязан реально чистить контекст по адресу Telegram.
// Проверка идёт через from(address).send/reset, как telegram-канал.
// Маркер сеется ДО рестарта: тогда положительный контроль
// ниже заодно жёстко проверяет, что durable-стейт .eve/.workflow-data пережил рестарт,
// — по пути канала, в отличие от мягкого клиентского резюма.
async function seedResetCanary(replica: Replica): Promise<ResetCanary> {
  setPhase("canary-seed");
  const canaryLog = join(replica.app, "data", CANARY_REPLY_LOG);
  const canaryAddress = `replica-canary:${randomBytes(6).toString("hex")}`;
  const canaryTurn = createCanaryTurn(
    { port: replica.port, bearer: replica.bearer },
    canaryLog,
  );

  const seed = await canaryTurn(
    canaryAddress,
    `Remember this code: ${RESET_MARKER}`,
  );
  if (seed.reply !== "REMEMBERED")
    throw new Error(
      `unexpected canary seed reply: ${JSON.stringify(seed.reply)}`,
    );
  return { canaryTurn, canaryAddress, seed };
}

async function restartReplica(replica: Replica): Promise<void> {
  setPhase("restart");
  await stopEve(replica.stack.eve);
  replica.stack.eve = startApp(replica.app, replica.env, replica.port, note);
  await waitForHealth(replica.port, replica.stack.eve);
}

async function checkPostRestart(replica: Replica): Promise<void> {
  setPhase("post-restart");
  const freshTurn = await firstTurn(
    replica.client,
    "Reply with a status word.",
    replica.stack.ownedSessions,
  );
  try {
    if (freshTurn.message !== "REPLICA_OK")
      throw new Error(
        `unexpected post-restart reply: ${JSON.stringify(freshTurn.message)}`,
      );
  } finally {
    await freshTurn.session.reset({ reason: "Replica smoke turn finished" });
    replica.stack.ownedSessions.delete(freshTurn.session);
  }
}

// Строгий резюм по сохранённым sessionId + streamIndex обязан пережить рестарт.
async function checkResume(
  replica: Replica,
  session: ClientSession,
  savedState: ClientSessionState,
): Promise<void> {
  setPhase("resume");
  const resumed = resumeSession(replica.client, savedState);
  const echo = await turn(resumed, RECALL);
  if (echo !== MARKER)
    throw new Error(`resume lost the marker: got ${JSON.stringify(echo)}`);
  await session.reset({ reason: "Replica smoke resume finished" });
  replica.stack.ownedSessions.delete(session);
  console.log("replica smoke: session resume across restart OK");
}

// Положительный контроль канарейки: тот же адрес обязан вернуть СВОЮ сессию,
// пережившую рестарт, и увидеть её историю. Без этого шага проверка после reset
// ничего не доказывает — пустой ответ вернула бы и любая посторонняя сессия.
async function checkResetCanary(
  replica: Replica,
  { canaryTurn, canaryAddress, seed }: ResetCanary,
): Promise<void> {
  setPhase("reset-canary");
  const before = await canaryTurn(canaryAddress, RECALL);
  if (before.sessionId !== seed.sessionId)
    throw new Error(
      `canary address did not resume its own session: ${before.sessionId} != ${seed.sessionId}`,
    );
  if (before.reply !== RESET_MARKER)
    throw new Error(
      `canary address could not reach its history before reset: ${JSON.stringify(before.reply)}`,
    );

  const resetResult = await canaryPost(
    { port: replica.port, bearer: replica.bearer },
    CANARY_RESET_ROUTE,
    { address: canaryAddress },
  );
  if (resetResult.status !== "reset")
    throw new Error(`unexpected reset status: ${JSON.stringify(resetResult)}`);
  if (resetResult.activeSessionAfterReset !== null)
    throw new Error(
      `reset left the address owned: ${JSON.stringify(resetResult)}`,
    );

  const after = await canaryTurn(canaryAddress, RECALL);
  if (after.sessionId === seed.sessionId)
    throw new Error(
      `reset did not retire the session: the address still resumes ${after.sessionId}`,
    );
  if (after.reply.includes(RESET_MARKER))
    throw new Error(
      `reset did not clear the context: history survived (${JSON.stringify(after.reply)})`,
    );
  console.log(
    `replica smoke: reset clears the context on the same address OK (before: ${before.reply}, after: ${after.reply})`,
  );
}

// Канарейка апгрейда. Каталог .eve/.workflow-data — installation-level состояние
// (scripts/lib/version-store.ts), он переживает `iva update` и достаётся новой версии
// ивы вместе с припаркованными разговорами. Шаги в нём приколочены к версии eve, так
// что смена версии гарантированно рушит replay припаркованного run.
//
// Исход апгрейда 0.29.5 → 0.30.8 подтверждён прогоном и прибит здесь намертво:
// старый адрес НЕ воскрешает свою сессию — на нём заводится свежая,
// её история пуста (маркера нет), и ничего из старой истории не протекает. Любой
// другой исход — регрессия, а не «тоже нормально».
//
// В настоящем апгрейде к смене версии шагов добавляется вторая причина: 0.30.5 увёл
// session controls и follow-up-сообщения в единый durable command inbox. Ad-hoc
// delivery-хук 0.29.5 (`src/execution/session-delivery-hook.js`) в 0.30.8 отсутствует,
// токен инбокса теперь выводится из sessionId (`eve:session:<id>:inbox`,
// `src/execution/session-command-token.js`). Смоук подделывает только версию шагов —
// этого достаточно, чтобы получить ту же расходимость без второй копии eve.
//
// Итог: припаркованные диалоги после апгрейда начинаются заново. Это осознанный
// размен, задокументирован в CHANGELOG 0.3.16.
//
// Идёт после канарейки reset, потому что подмена версии убивает все припаркованные сессии.
async function checkUpgradeCanary(
  replica: Replica,
  canaryTurn: CanaryTurn,
): Promise<void> {
  setPhase("upgrade-canary");
  const upgradeAddress = `replica-upgrade:${randomBytes(6).toString("hex")}`;
  const upgradeSeed = await canaryTurn(
    upgradeAddress,
    `Remember this code: ${UPGRADE_MARKER}`,
  );
  if (upgradeSeed.reply !== "REMEMBERED")
    throw new Error(
      `unexpected upgrade seed reply: ${JSON.stringify(upgradeSeed.reply)}`,
    );

  await stopEve(replica.stack.eve);
  const forged = await forgeEveStepVersion(replica.app);
  if (forged === 0)
    throw new Error(
      "upgrade canary forged nothing: no versioned eve step ids in the durable log",
    );
  note(`[smoke] forged the eve version in ${forged} event files`);
  replica.stack.eve = startApp(replica.app, replica.env, replica.port, note);
  await waitForHealth(replica.port, replica.stack.eve);

  const upgraded = await canaryTurn(upgradeAddress, RECALL);
  if (upgraded.sessionId === upgradeSeed.sessionId)
    throw new Error(
      `address still resumes its pre-upgrade session after the version change: ${upgraded.sessionId}`,
    );
  if (upgraded.reply.includes(UPGRADE_MARKER))
    throw new Error(
      `fresh post-upgrade session leaked the retired history: ${JSON.stringify(upgraded.reply)}`,
    );
  if (upgraded.reply !== EMPTY_HISTORY_REPLY)
    throw new Error(
      `fresh post-upgrade session did not start empty: ${JSON.stringify(upgraded.reply)}`,
    );
  console.log(
    `replica smoke: eve version change starts a fresh session on the same address, with no history carried over OK (reply: ${upgraded.reply})`,
  );
}

async function runSmoke(stack: Stack): Promise<void> {
  const replica = await setupReplica(stack);
  const { session, savedState } = await checkFirstReplyAndSeed(replica);
  const resetCanary = await seedResetCanary(replica);
  await restartReplica(replica);
  await checkPostRestart(replica);
  await checkResume(replica, session, savedState);
  await checkResetCanary(replica, resetCanary);
  await checkUpgradeCanary(replica, resetCanary.canaryTurn);

  if (stack.mock.requests.length < 3)
    throw new Error(
      `provider was barely exercised: ${stack.mock.requests.length} requests`,
    );
  console.log(
    `replica smoke: OK (provider requests: ${stack.mock.requests.length})`,
  );
}

function reportFailure(err: unknown, mock: MockServer): void {
  console.error(
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- preserve the original template coercion.
    `replica smoke FAILED at phase "${phase}": ${errorDetail(err)}`,
  );
  console.error(`provider requests so far: ${mock.requests.length}`);
  console.error("--- last child output ---");
  for (const line of logs.slice(-120)) console.error(line);
  process.exitCode = 1;
}

async function teardown(stack: Stack): Promise<unknown[]> {
  const resetResults = await Promise.allSettled(
    [...stack.ownedSessions].map((session) =>
      session.reset({ reason: "Replica smoke stopped" }),
    ),
  );
  await stopEve(stack.eve);
  await stack.mock.close();
  if (process.env.REPLICA_KEEP === "1")
    console.error(`sandbox kept: ${stack.sandbox}`);
  else await rm(stack.sandbox, { recursive: true, force: true });
  const resetErrors: unknown[] = [];
  for (const result of resetResults) {
    if (result.status === "rejected")
      resetErrors.push(result.reason as unknown);
  }
  return resetErrors;
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "iva-replica-"));
  const mock = await startMockOpenAiServer();
  const stack: Stack = {
    sandbox,
    mock,
    ownedSessions: new Set<ClientSession>(),
    eve: null,
  };
  let resetErrors: unknown[];
  try {
    await runSmoke(stack);
  } catch (err) {
    reportFailure(err, mock);
  } finally {
    resetErrors = await teardown(stack);
  }
  if (resetErrors.length > 0)
    throw new AggregateError(resetErrors, "replica smoke session reset failed");
}

await main();
