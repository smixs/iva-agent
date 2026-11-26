/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import {
  TELEGRAM_BOT_ID_HEADER,
  type TelegramBotConfig,
} from "../packages/telegram-bots/index.ts";
import { createColleagueCommand } from "./cli/colleagues.ts";
import { createCliRuntime } from "./cli/runtime.ts";

// Isolated runtime dirs before importing authored modules.
const root = mkdtempSync(join(tmpdir(), "iva-colleagues-e2e-"));
const dataPath = join(root, "data");
const vaultPath = join(root, "vault");
mkdirSync(dataPath, { recursive: true });
mkdirSync(vaultPath, { recursive: true });

const IVA_BOT_ID = "111111111";
const IVA_TOKEN = `${IVA_BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const CRITIC_BOT_ID = "222222222";
const CRITIC_TOKEN = `${CRITIC_BOT_ID}:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
const CODER_BOT_ID = "333333333";
const CODER_TOKEN = `${CODER_BOT_ID}:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`;
const SECRETARY_BOT_ID = "444444444";
const SECRETARY_TOKEN = `${SECRETARY_BOT_ID}:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD`;
const WEBHOOK_SECRET = "colleagues-e2e-secret";

// Local OpenAI-compatible mock server to prove model selection on the wire!
const wireRequests: Array<{
  readonly path: string;
  readonly model: unknown;
  readonly tools: readonly string[];
}> = [];
const mockServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  req.on("end", () => {
    const parsed = JSON.parse(raw || "{}") as {
      model?: unknown;
      tools?: Array<{ function?: { name?: string } }>;
    };
    wireRequests.push({
      path: req.url ?? "",
      model: parsed.model,
      tools: (parsed.tools ?? [])
        .map((tool) => tool.function?.name ?? "")
        .filter(Boolean)
        .sort(),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mock-resp",
        created: 0,
        model: typeof parsed.model === "string" ? parsed.model : "unknown",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
});
await new Promise<void>((resolve) =>
  mockServer.listen(0, "127.0.0.1", resolve),
);
mockServer.unref();
after(() => {
  mockServer.close();
});
const mockPort = (mockServer.address() as AddressInfo).port;
const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;

process.env.ASSISTANT_DATA_DIR = dataPath;
process.env.ASSISTANT_VAULT_DIR = vaultPath;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.AGENT_LANGUAGE = "ru";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = IVA_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = "iva_main_bot";
process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS = [
  `critic_bot=${CRITIC_TOKEN}`,
  `coder_bot=${CODER_TOKEN}`,
  `secretary_bot=${SECRETARY_TOKEN}`,
].join(",");
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "iva-primary-model";
process.env.OLLAMA_BASE_URL = mockBaseUrl;
process.env.OLLAMA_API_KEY = "ollama-test-key";
process.env.CUSTOM_BASE_URL = `${mockBaseUrl}/custom`;
process.env.CUSTOM_MODEL = "colleague-custom-model";
process.env.CUSTOM_API_KEY = "custom-test-key";
process.env.ASSISTANT_BEARER = "test-bearer-secret";
// The bridge regression test drives the real collector through main(); zero quiet keeps it fast.
process.env.TELEGRAM_COLLECT_QUIET_MS = "0";

process.on("exit", () => {
  mockServer.close();
  rmSync(root, { recursive: true, force: true });
});

const [
  { stepModelChoice },
  { makeTextModel },
  { MODEL_PROVIDER_NAMES },
  {
    COLLEAGUE_ROLES,
    isColleaguesEnabled,
    parseColleaguesConfig,
    readColleague,
    withColleague,
    withColleaguesEnabled,
  },
  { colleagueExecute },
  colleagueInstructionModule,
  personaInstructionModule,
  transcriptHookModule,
  { createTelegramChannel },
  { TELEGRAM_ACCEPTANCE_ROUTE },
  { default: writeCardTool },
  { default: memorySearchTool },
  { default: remindTool },
  { add: addReminder, fireDue, list: listReminders },
  { runReminderFire },
  { admitTelegramUpdate },
  { main: runPollerMain, runBotPollLoop },
  { acquireTelegramProcessLock },
  { enqueueQueueFile },
  { chatKeyOf, getChatStatus },
] = await Promise.all([
  import("../agent/agent.ts"),
  import("../agent/provider.ts"),
  import("#lib/model-provider.ts"),
  import("#lib/colleagues.ts"),
  import("#lib/colleague-tool.ts"),
  import("../agent/instructions/01-colleague.ts"),
  import("../agent/instructions/25-persona.ts"),
  import("../agent/hooks/transcript.ts"),
  import("../agent/channels/telegram.ts"),
  import("#lib/telegram-acceptance.ts"),
  import("../agent/tools/write_card.ts"),
  import("../agent/tools/memory_search.ts"),
  import("../agent/tools/remind.ts"),
  import("#lib/reminder-store.ts"),
  import("./reminders/fire.ts"),
  import("./poller/inbox.ts"),
  import("./poller/main.ts"),
  import("./poller/process-lock.ts"),
  import("./lib/telegram-queue.ts"),
  import("#lib/run-status.ts"),
]);

const settingsFile = join(dataPath, "settings.json");

function writeRawSettings(obj: Record<string, unknown>): void {
  writeFileSync(settingsFile, JSON.stringify(obj), { mode: 0o600 });
}

function makeOwnerAuth(botId?: string, chatId = "42") {
  const attributes: Record<string, string> = {
    chat_id: chatId,
    chat_type: "private",
    message_id: "1",
    user_id: "42",
    ...(botId ? { bot_id: botId } : {}),
  };
  const principal = {
    authenticator: "telegram-webhook",
    principalType: "user",
    principalId: "telegram:42",
    issuer: "telegram",
    attributes,
  };
  return { initiator: principal, current: principal };
}

function createStubBotApi() {
  const calls: Array<{
    readonly token: string;
    readonly method: string;
    readonly body: Record<string, unknown>;
  }> = [];
  const stubFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /\/bot([^/]+)\/([^/?]+)/u.exec(url);
    assert.ok(match, `unexpected Bot API URL: ${url}`);
    const [, token, method] = match;
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ token, method, body });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: calls.length,
            chat: { id: 42, type: "private" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return { calls, stubFetch };
}

function createRouteHarness() {
  const sent: Array<{
    readonly address: string;
    readonly message: unknown;
    readonly auth: unknown;
    readonly state: TelegramChannelState | undefined;
  }> = [];
  const byAddress = new Map<string, Session>();
  let seq = 0;

  const args = {
    from: (address: string) => ({
      send: (
        message: unknown,
        options?: { auth?: unknown; state?: TelegramChannelState },
      ) => {
        sent.push({
          address,
          message,
          auth: options?.auth,
          state: options?.state,
        });
        let session = byAddress.get(address);
        if (!session) {
          session = { id: `sess-${++seq}` } as unknown as Session;
          byAddress.set(address, session);
        }
        return Promise.resolve(session);
      },
      respond: () => Promise.reject(new Error("unexpected respond")),
      cancel: () => Promise.resolve({ status: "no_active_turn" as const }),
      clear: () => Promise.resolve({ status: "cleared" as const }),
      compact: () => Promise.resolve({ status: "compacted" as const }),
      reset: () => Promise.resolve({ status: "reset" as const }),
    }),
    resolveSession: (address: string) =>
      Promise.resolve(byAddress.get(address)),
    attachSession: (sessionId: string) =>
      ({ id: sessionId }) as unknown as Session,
    waitUntil: () => {},
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  return { args, sent, byAddress };
}

function webhookRequest(
  path: string,
  payload: Record<string, unknown>,
  botId?: string,
): Request {
  return new Request(`http://127.0.0.1:8723${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
      ...(botId ? { [TELEGRAM_BOT_ID_HEADER]: botId } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- Пункт 1: опция выключена по умолчанию, при выключенной опции сообщения ботам коллег не обрабатываются ---
test("п.1: clean configuration has colleagues disabled and blocks colleague messages in Bridge and Channel", async (t) => {
  // Чистая конфигурация: settings.json отсутствует.
  rmSync(settingsFile, { force: true });
  assert.equal(isColleaguesEnabled(settingsFile), false);

  const criticBot: TelegramBotConfig = {
    botId: CRITIC_BOT_ID,
    token: CRITIC_TOKEN,
    username: "critic_bot",
    isPrimary: false,
  };
  const ivaBot: TelegramBotConfig = {
    botId: IVA_BOT_ID,
    token: IVA_TOKEN,
    username: "iva_main_bot",
    isPrimary: true,
  };
  const update = {
    update_id: 101,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "hello critic while disabled",
    },
  };

  // Bridge inbox drops colleague update while still admitting Iva update.
  const inboxFile = join(dataPath, "inbox-disabled-test.json");
  const colleagueAdmission = await admitTelegramUpdate(update, {
    allowedUserIds: new Set(["42"]),
    bot: criticBot,
    colleaguesEnabledImpl: () => isColleaguesEnabled(settingsFile),
    enqueueImpl: (key, candidate) =>
      enqueueQueueFile(inboxFile, key, candidate, { strict: true }),
    logImpl: () => {},
  });
  assert.equal(colleagueAdmission, "terminal-drop");

  const ivaAdmission = await admitTelegramUpdate(update, {
    allowedUserIds: new Set(["42"]),
    bot: ivaBot,
    colleaguesEnabledImpl: () => isColleaguesEnabled(settingsFile),
    enqueueImpl: (key, candidate) =>
      enqueueQueueFile(inboxFile, key, candidate, { strict: true }),
    logImpl: () => {},
  });
  assert.equal(ivaAdmission, "owned");

  // Bridge poll loop does not call getUpdates for colleague while option is off.
  const guardDir = mkdtempSync(join(tmpdir(), "iva-col-lock-"));
  const lease = await acquireTelegramProcessLock({
    testGuard: { identity: `col-off-${process.pid}`, directory: guardDir },
  });
  t.after(async () => {
    await lease.close();
    rmSync(guardDir, { recursive: true, force: true });
  });
  let loops = 0;
  let tgCalls = 0;
  await runBotPollLoop({
    bot: criticBot,
    initialOffset: 1,
    assertLease: () => {},
    colleaguesEnabledImpl: () => isColleaguesEnabled(settingsFile),
    shouldContinue: () => loops++ < 2,
    tgImpl: () => {
      tgCalls += 1;
      return Promise.resolve({ ok: true, result: [] });
    },
    sleepImpl: () => Promise.resolve(),
    logImpl: () => {},
  });
  assert.equal(tgCalls, 0, "disabled colleague bot must not poll Telegram");

  // Channel acceptance does not start a session for colleague when option is off (both missing and enabled:false).
  const { stubFetch } = createStubBotApi();
  const channel = createTelegramChannel({
    api: { fetch: stubFetch },
    env: () => process.env,
  });
  const acceptedRoute = channel.routes.find(
    (r) =>
      r.transport !== "websocket" &&
      r.method === "POST" &&
      r.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptedRoute && acceptedRoute.transport !== "websocket");

  for (const state of ["clean", "explicit-false"] as const) {
    if (state === "explicit-false") {
      writeRawSettings({ colleagues: { enabled: false, items: {} } });
    }
    const harness = createRouteHarness();
    const res = await acceptedRoute.handler(
      webhookRequest(TELEGRAM_ACCEPTANCE_ROUTE, update, CRITIC_BOT_ID),
      harness.args,
    );
    assert.equal(res.status, 204);
    assert.equal(harness.sent.length, 0, `colleague turn started in ${state}`);
  }
});

// Мост, запущенный с выключенной опцией, обязан принять апдейт коллеги
// после `iva colleague on` без ручного перезапуска.
test("п.1 regression: bridge started with colleagues off accepts a colleague update after iva colleague on", async (t) => {
  writeRawSettings({ colleagues: { enabled: false, items: {} } });

  // Изолированное состояние Bridge внутри общего временного data/ этого тест-файла.
  for (const name of readdirSync(dataPath)) {
    if (
      /^telegram-(queue|inbox|offset|backlog)/u.test(name) ||
      name === "telegram-offsets.d"
    ) {
      rmSync(join(dataPath, name), { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(dataPath, "telegram-offset.json"),
    JSON.stringify({ offset: 1 }),
    {
      mode: 0o600,
    },
  );
  // No telegram-offsets.d directory and no cursor files: first activation must
  // create the cursor directory itself. The regression must prove that
  // `iva colleague on` does not drop the pending Telegram queue while initializing it.

  const guardDir = mkdtempSync(join(tmpdir(), "iva-col-main-lock-"));
  const lease = await acquireTelegramProcessLock({
    testGuard: {
      identity: `col-main-${process.pid}`,
      directory: guardDir,
    },
  });
  t.after(async () => {
    await lease.close();
    rmSync(guardDir, { recursive: true, force: true });
  });

  const colleagueUpdate = {
    update_id: 6201,
    message: {
      message_id: 620,
      date: 1_700_000_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "hello critic after enabling without restart",
    },
  };
  const botApiCalls: Array<{
    readonly token: string;
    readonly method: string;
    readonly body: Record<string, unknown>;
  }> = [];
  const acceptedRequests: Array<{
    readonly headers: Record<string, unknown>;
    readonly body: string;
  }> = [];
  let colleagueUpdateServed = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const botApi = /\/bot([^/]+)\/([^/?]+)/u.exec(url);
    if (url.startsWith("https://api.telegram.org/bot") && botApi) {
      const [, token, method] = botApi;
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      botApiCalls.push({ token, method, body });
      if (method === "getUpdates") {
        if (
          token === CRITIC_TOKEN &&
          !colleagueUpdateServed &&
          isColleaguesEnabled(settingsFile)
        ) {
          colleagueUpdateServed = true;
          return Promise.resolve(
            jsonResponse({ ok: true, result: [colleagueUpdate] }),
          );
        }
        return new Promise((resolve) => {
          setTimeout(() => resolve(jsonResponse({ ok: true, result: [] })), 10);
        });
      }
      return Promise.resolve(jsonResponse({ ok: true, result: true }));
    }
    if (url === "http://127.0.0.1:8723/eve/v1/telegram/accepted") {
      acceptedRequests.push({
        headers: { ...((init?.headers ?? {}) as Record<string, unknown>) },
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { "x-iva-telegram-acceptance": "turn" },
        }),
      );
    }
    return originalFetch(input, init);
  };

  const mainErrors: Error[] = [];
  const mainOutcome = runPollerMain({
    acquireProcessLockImpl: () => Promise.resolve(lease),
  }).then(
    () => {
      mainErrors.push(
        new Error("telegram-poll main returned without a lease loss"),
      );
    },
    (error: unknown) => {
      mainErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    },
  );

  try {
    // Ждём первый опрос Ивы: к этому моменту выбор bots при старте уже произошёл
    // при colleagues.enabled=false. Затем владелец включает опцию без перезапуска.
    await waitForCondition(
      () =>
        botApiCalls.some(
          (call) => call.token === IVA_TOKEN && call.method === "getUpdates",
        ),
      2_000,
      "primary bot startup poll",
    );
    assert.equal(
      botApiCalls.some((call) => call.token === CRITIC_TOKEN),
      false,
      "colleague bot touched Telegram while the option was still off",
    );

    const cliRoot = mkdtempSync(join(tmpdir(), "iva-cli-col-main-"));
    try {
      writeFileSync(
        join(cliRoot, ".env"),
        `ASSISTANT_DATA_DIR=${dataPath}\nMODEL_PROVIDER=ollama\n`,
      );
      const cmdColleague = createColleagueCommand(createCliRuntime(cliRoot));
      await cmdColleague(["on"]);
    } finally {
      rmSync(cliRoot, { recursive: true, force: true });
    }
    assert.equal(isColleaguesEnabled(settingsFile), true);

    await waitForCondition(
      () => acceptedRequests.length > 0,
      8_000,
      "colleague update acceptance after enabling the option",
    );
    assert.equal(
      botApiCalls.some(
        (call) => call.token === CRITIC_TOKEN && call.method === "getUpdates",
      ),
      true,
      "colleague bot never polled Telegram after iva colleague on",
    );
    const accepted = acceptedRequests[0];
    assert.equal(
      accepted?.headers[TELEGRAM_BOT_ID_HEADER],
      CRITIC_BOT_ID,
      "acceptance request lost the colleague bot id header",
    );
    assert.match(
      accepted?.body ?? "",
      /hello critic after enabling without restart/u,
    );
  } finally {
    await lease.close();
    await Promise.race([
      mainOutcome,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    globalThis.fetch = originalFetch;
    assert.equal(
      mainErrors.length,
      1,
      "telegram-poll main did not stop after closing its lease",
    );
    assert.match(mainErrors[0]?.message ?? "", /active process lease/u);
  }
});

// --- Пункт 2: роль из четырёх + своя модель любого провайдера MODEL_PROVIDER_NAMES (идёт на модели коллеги, а не Ивы) ---
test("п.2: colleague turn runs on its own provider/model and role instruction, not Iva's model", async () => {
  writeRawSettings(
    withColleague(withColleaguesEnabled({}, true), {
      botId: CRITIC_BOT_ID,
      role: "critic",
      provider: "custom",
      model: "critic-custom-model-v1",
    }),
  );

  // Verify every provider in MODEL_PROVIDER_NAMES is supported by stepModelChoice.
  for (const provider of MODEL_PROVIDER_NAMES) {
    const choice = stepModelChoice(
      {
        session: {
          id: `sess-${provider}`,
          auth: makeOwnerAuth(CRITIC_BOT_ID),
        },
      },
      {
        readColleague: () => ({
          botId: CRITIC_BOT_ID,
          role: "critic",
          provider,
          model: `model-for-${provider}`,
        }),
      },
    );
    assert.equal(choice.provider, provider);
    assert.equal(choice.model, `model-for-${provider}`);
  }

  // Real wire check: Iva sends to ollama/iva-primary-model, Critic sends to custom/critic-custom-model-v1!
  wireRequests.length = 0;
  const ivaChoice = stepModelChoice({
    session: { id: "sess-iva", auth: makeOwnerAuth() },
  });
  const criticChoice = stepModelChoice({
    session: { id: "sess-critic", auth: makeOwnerAuth(CRITIC_BOT_ID) },
  });
  assert.equal(ivaChoice.provider, "ollama");
  assert.equal(ivaChoice.model, "iva-primary-model");
  assert.equal(criticChoice.provider, "custom");
  assert.equal(criticChoice.model, "critic-custom-model-v1");

  const ivaModel = makeTextModel({
    provider: ivaChoice.provider,
    model: ivaChoice.model,
    sessionId: ivaChoice.sessionId,
    chatModelSeesImages: () => Promise.resolve(false),
  });
  const criticModel = makeTextModel({
    provider: criticChoice.provider,
    model: criticChoice.model,
    sessionId: criticChoice.sessionId,
    chatModelSeesImages: () => Promise.resolve(false),
  });

  await ivaModel.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping iva" }] }],
  });
  await criticModel.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "ping critic" }] },
    ],
  });

  assert.equal(wireRequests.length, 2);
  assert.equal(wireRequests[0]?.path, "/v1/chat/completions");
  assert.equal(wireRequests[0]?.model, "iva-primary-model");
  assert.equal(wireRequests[1]?.path, "/v1/custom/chat/completions");
  assert.equal(wireRequests[1]?.model, "critic-custom-model-v1");

  // Role dynamic instruction injects role for colleague and nothing for Iva; PERSONA skips colleague.
  const turnHandler = (
    colleagueInstructionModule.default as unknown as {
      events: {
        "turn.started": (
          e: unknown,
          ctx: { session: { auth: ReturnType<typeof makeOwnerAuth> } },
        ) => { markdown?: string } | null;
      };
    }
  ).events["turn.started"];
  const personaHandler = (
    personaInstructionModule.default as unknown as {
      events: {
        "turn.started": (
          e: unknown,
          ctx: { session: { auth: ReturnType<typeof makeOwnerAuth> } },
        ) => { markdown?: string } | null;
      };
    }
  ).events["turn.started"];

  assert.equal(turnHandler({}, { session: { auth: makeOwnerAuth() } }), null);
  const criticInst = turnHandler(
    {},
    { session: { auth: makeOwnerAuth(CRITIC_BOT_ID) } },
  );
  assert.ok(criticInst?.markdown?.includes("Critic"));
  assert.ok(criticInst?.markdown?.includes("custom/critic-custom-model-v1"));
  assert.equal(
    personaHandler({}, { session: { auth: makeOwnerAuth(CRITIC_BOT_ID) } }),
    null,
  );
  assert.equal(COLLEAGUE_ROLES.length, 4);
});

// --- Пункт 3: модель коллеги меняют и Ива (инструментом), и владелец (CLI) ---
test("п.3: Iva changes colleague model via tool and owner changes it via CLI", async () => {
  writeRawSettings(
    withColleague(withColleaguesEnabled({}, true), {
      botId: CODER_BOT_ID,
      role: "programmer",
      provider: "ollama",
      model: "deepseek-v4-pro",
    }),
  );

  // 1) Ива меняет модель инструментом colleague.
  const byIva = colleagueExecute(
    {
      action: "set_model",
      bot_id: CODER_BOT_ID,
      provider: "openrouter",
      model: "openai/gpt-5.1",
    },
    { session: { auth: makeOwnerAuth() } },
    { settingsFile },
  );
  assert.equal(byIva.ok, true);
  assert.equal(
    readColleague(CODER_BOT_ID, settingsFile)?.provider,
    "openrouter",
  );
  assert.equal(
    readColleague(CODER_BOT_ID, settingsFile)?.model,
    "openai/gpt-5.1",
  );
  assert.equal(
    stepModelChoice({
      session: { id: "sess-coder-1", auth: makeOwnerAuth(CODER_BOT_ID) },
    }).model,
    "openai/gpt-5.1",
  );

  // 2) Владелец меняет модель через CLI `iva colleague model`.
  const cliRoot = mkdtempSync(join(tmpdir(), "iva-cli-col-"));
  try {
    writeFileSync(
      join(cliRoot, ".env"),
      `ASSISTANT_DATA_DIR=${dataPath}\nMODEL_PROVIDER=ollama\n`,
    );
    const runtime = createCliRuntime(cliRoot);
    const cmdColleague = createColleagueCommand(runtime);
    await cmdColleague(["model", CODER_BOT_ID, "claude", "claude-sonnet-5-5"]);
    const afterOwner = readColleague(CODER_BOT_ID, settingsFile);
    assert.equal(afterOwner?.provider, "claude");
    assert.equal(afterOwner?.model, "claude-sonnet-5-5");
    const choice = stepModelChoice({
      session: { id: "sess-coder-2", auth: makeOwnerAuth(CODER_BOT_ID) },
    });
    assert.equal(choice.provider, "claude");
    assert.equal(choice.model, "claude-sonnet-5-5");

    // Владелец также может выключать/включать опцию через `iva colleague off/on`.
    await cmdColleague(["off"]);
    assert.equal(isColleaguesEnabled(settingsFile), false);
    await cmdColleague(["on"]);
    assert.equal(isColleaguesEnabled(settingsFile), true);
    assert.equal(
      parseColleaguesConfig(
        JSON.parse(readFileSync(settingsFile, "utf8")),
        () => {},
      ).items[CODER_BOT_ID]?.model,
      "claude-sonnet-5-5",
    );
  } finally {
    rmSync(cliRoot, { recursive: true, force: true });
  }
});

// --- Пункт 4: у каждого коллеги личный чат с владельцем и своя переписка (не смешивается с Ивой) ---
test("п.4: each colleague has its own private conversation isolated from Iva's session and daily transcript", async () => {
  writeRawSettings(
    withColleague(withColleaguesEnabled({}, true), {
      botId: CRITIC_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "deepseek-v4-pro",
    }),
  );
  rmSync(join(vaultPath, "daily"), { recursive: true, force: true });

  const { stubFetch } = createStubBotApi();
  const channel = createTelegramChannel({
    api: { fetch: stubFetch },
    env: () => process.env,
  });
  const acceptedRoute = channel.routes.find(
    (r) =>
      r.transport !== "websocket" &&
      r.method === "POST" &&
      r.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptedRoute && acceptedRoute.transport !== "websocket");

  const harness = createRouteHarness();

  const ivaRes = await acceptedRoute.handler(
    webhookRequest(TELEGRAM_ACCEPTANCE_ROUTE, {
      update_id: 701,
      message: {
        message_id: 71,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Owner" },
        text: "IVA_PRIVATE_SECRET_MESSAGE",
      },
    }),
    harness.args,
  );
  const criticRes = await acceptedRoute.handler(
    webhookRequest(
      TELEGRAM_ACCEPTANCE_ROUTE,
      {
        update_id: 701,
        message: {
          message_id: 72,
          date: 1_700_000_000,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Owner" },
          text: "CRITIC_PRIVATE_SECRET_MESSAGE",
        },
      },
      CRITIC_BOT_ID,
    ),
    harness.args,
  );

  assert.equal(ivaRes.status, 204);
  assert.equal(criticRes.status, 204);
  assert.equal(harness.sent.length, 2);

  // Separate Eve session addresses & session IDs for the same owner private chat 42!
  const ivaAddr = harness.sent[0].address;
  const criticAddr = harness.sent[1].address;
  assert.notEqual(ivaAddr, criticAddr);
  assert.equal(criticAddr, `bot:${CRITIC_BOT_ID}:${ivaAddr}`);
  assert.notEqual(
    harness.byAddress.get(ivaAddr)?.id,
    harness.byAddress.get(criticAddr)?.id,
  );

  // Assistant replies through transcript hook: Iva writes to daily/, colleague does NOT pollute Iva's daily/.
  const onMessageCompleted = (
    transcriptHookModule.default as {
      events: {
        "message.completed": (
          event: { data: { finishReason: string; message: string } },
          ctx: {
            channel: { kind: string };
            session: {
              parent?: unknown;
              auth: ReturnType<typeof makeOwnerAuth>;
            };
          },
        ) => void;
      };
    }
  ).events["message.completed"];

  onMessageCompleted(
    { data: { finishReason: "stop", message: "IVA_REPLY_SECRET" } },
    { channel: { kind: "telegram" }, session: { auth: makeOwnerAuth() } },
  );
  onMessageCompleted(
    { data: { finishReason: "stop", message: "CRITIC_REPLY_SECRET" } },
    {
      channel: { kind: "telegram" },
      session: { auth: makeOwnerAuth(CRITIC_BOT_ID) },
    },
  );

  const dailyDir = join(vaultPath, "daily");
  assert.ok(existsSync(dailyDir));
  const dailyText = readdirSync(dailyDir)
    .map((f) => readFileSync(join(dailyDir, f), "utf8"))
    .join("\n");
  assert.ok(dailyText.includes("IVA_PRIVATE_SECRET_MESSAGE"));
  assert.ok(dailyText.includes("IVA_REPLY_SECRET"));
  assert.equal(
    dailyText.includes("CRITIC_PRIVATE_SECRET_MESSAGE"),
    false,
    "colleague incoming message leaked into Iva daily transcript",
  );
  assert.equal(
    dailyText.includes("CRITIC_REPLY_SECRET"),
    false,
    "colleague reply leaked into Iva daily transcript",
  );
});

// --- Пункт 5: общая база заметок (Vault) — карточка, записанная коллегой, видна Иве ---
test("п.5: Vault is shared — a Card written by a colleague is visible to Iva via memory_search", async () => {
  // Коллега записывает Card через write_card.
  const writeResult = await (
    writeCardTool as {
      execute: (
        input: unknown,
        ctx: unknown,
      ) => Promise<{ ok?: boolean; file?: string }>;
    }
  ).execute(
    {
      operation: "fact",
      type: "project",
      title: "Colleague Shared Note Alpha",
      text: "Критик зафиксировал архитектурный риск X-909",
      description: "Общий проект для проверки памяти Vault",
    },
    { session: { id: "sess-critic", auth: makeOwnerAuth(CRITIC_BOT_ID) } },
  );
  assert.equal(writeResult.ok, true);

  // Ива ищет в том же Vault через memory_search и видит запись коллеги!
  const searchResult = await (
    memorySearchTool as unknown as {
      execute: (
        input: unknown,
        ctx: unknown,
      ) => Promise<{ hits: Array<{ file?: string; snippet?: string }> }>;
    }
  ).execute(
    { query: "X-909" },
    { session: { id: "sess-iva", auth: makeOwnerAuth() } },
  );
  assert.ok(
    searchResult.hits.some(
      (hit) =>
        (hit.file ?? "").includes("colleague-shared-note-alpha") ||
        (hit.snippet ?? "").includes("X-909"),
    ),
    `Iva did not see colleague's card: ${JSON.stringify(searchResult)}`,
  );
});

// --- Пункт 6: права коллеги — все инструменты Ивы (набор инструментов коллеги равен набору Ивы) ---
test("п.6: colleague receives the exact same toolset as Iva", async () => {
  const toolsDir = new URL("../agent/tools/", import.meta.url);
  const allToolNames = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.replace(/\.ts$/u, ""))
    .sort();
  assert.ok(allToolNames.includes("colleague"));
  assert.ok(allToolNames.includes("write_card"));
  assert.ok(allToolNames.includes("memory_search"));
  assert.ok(allToolNames.includes("remind"));
  assert.ok(allToolNames.includes("bash"));

  const wireToolDefs = allToolNames.map((name) => ({
    type: "function" as const,
    name,
    inputSchema: { type: "object" as const, properties: {} },
  }));

  writeRawSettings(
    withColleague(withColleaguesEnabled({}, true), {
      botId: CRITIC_BOT_ID,
      role: "critic",
      provider: "custom",
      model: "critic-custom-model-v1",
    }),
  );

  wireRequests.length = 0;
  const ivaChoice = stepModelChoice({
    session: { id: "sess-iva-tools", auth: makeOwnerAuth() },
  });
  const criticChoice = stepModelChoice({
    session: { id: "sess-critic-tools", auth: makeOwnerAuth(CRITIC_BOT_ID) },
  });
  const ivaModel = makeTextModel({
    provider: ivaChoice.provider,
    model: ivaChoice.model,
    sessionId: ivaChoice.sessionId,
    chatModelSeesImages: () => Promise.resolve(false),
  });
  const criticModel = makeTextModel({
    provider: criticChoice.provider,
    model: criticChoice.model,
    sessionId: criticChoice.sessionId,
    chatModelSeesImages: () => Promise.resolve(false),
  });

  await ivaModel.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "tools iva" }] }],
    tools: wireToolDefs,
  });
  await criticModel.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "tools critic" }] },
    ],
    tools: wireToolDefs,
  });

  assert.equal(wireRequests.length, 2);
  assert.deepEqual(
    wireRequests[1]?.tools,
    wireRequests[0]?.tools,
    "colleague toolset must equal Iva toolset",
  );
  assert.deepEqual(wireRequests[1]?.tools, allToolNames);
});

// --- Пункт 7: свои расписания у коллег — напоминание коллеги срабатывает в его чате от его бота ---
test("п.7: colleague reminder stores botId, runs its task turn with colleague header, and delivers from colleague bot", async () => {
  writeRawSettings(
    withColleague(withColleaguesEnabled({}, true), {
      botId: SECRETARY_BOT_ID,
      role: "secretary",
      provider: "custom",
      model: "secretary-model-v1",
    }),
  );
  rmSync(join(dataPath, "reminders.json"), { force: true });
  rmSync(join(dataPath, "reminder-content.json"), { force: true });

  // 1) Коллега ставит напоминание через инструмент remind (text).
  const added = await (
    remindTool as {
      execute: (
        input: unknown,
        ctx: unknown,
      ) => Promise<{ ok: boolean; reminder?: { id: string; bot_id?: string } }>;
    }
  ).execute(
    {
      action: "add",
      content: "text",
      text: "Напоминание от Секретаря",
      at: "in 10m",
    },
    {
      session: { id: "sess-sec", auth: makeOwnerAuth(SECRETARY_BOT_ID, "42") },
    },
  );
  assert.equal(added.ok, true);
  assert.ok(added.reminder?.id);
  const textId = added.reminder.id;
  assert.equal(added.reminder.bot_id, SECRETARY_BOT_ID);

  // Также проверим task-напоминание с немедленным сроком.
  const now = Date.now() + 20 * 60_000;
  await addReminder({
    id: "r-col-task",
    text: "Собери короткую сводку задач",
    content: "task",
    chat: { id: "42", threadId: null, botId: SECRETARY_BOT_ID },
    schedule: { kind: "at", atMs: now - 1000 },
  });

  const due = await fireDue(now, 10);
  assert.deepEqual(due.map((r) => r.id).sort(), ["r-col-task", textId].sort());

  // Проверим доставку text-напоминания от токена коллеги.
  const delivered: Array<{
    readonly token: string;
    readonly chat: string;
    readonly text: string;
  }> = [];
  const fakeSend: typeof import("./lib/telegram-send.ts").sendTelegramHtml = (
    token,
    chat,
    text,
  ) => {
    delivered.push({ token, chat, text: String(text) });
    return Promise.resolve({ ok: true, fellBack: false, error: "" });
  };

  assert.equal(
    await runReminderFire(textId, {
      env: process.env,
      send: fakeSend,
      log: () => {},
    }),
    0,
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.token, SECRETARY_TOKEN);
  assert.equal(delivered[0]?.chat, "42");
  assert.equal(delivered[0]?.text, "Напоминание от Секретаря");

  // Проверим task-напоминание: передаёт заголовок X-Iva-Telegram-Bot-Id, клеймит чат коллеги, отправляет токеном коллеги!
  let seenBotHeader: string | undefined;
  let claimedColleagueChatKey: string | null = null;
  assert.equal(
    await runReminderFire("r-col-task", {
      env: process.env,
      send: fakeSend,
      runTurn: async (_prompt, clientOptions, deps) => {
        seenBotHeader = clientOptions.headers?.[TELEGRAM_BOT_ID_HEADER];
        if (deps?.watch) {
          await deps.watch.claim("sess-rem-col");
          const colStatus = getChatStatus(
            chatKeyOf("42", null, SECRETARY_BOT_ID),
          );
          const ivaStatus = getChatStatus(chatKeyOf("42", null, null));
          claimedColleagueChatKey =
            colStatus?.sessionId === "sess-rem-col" &&
            ivaStatus?.sessionId !== "sess-rem-col"
              ? chatKeyOf("42", null, SECRETARY_BOT_ID)
              : null;
          deps.watch.release("sess-rem-col");
        }
        return {
          status: "completed",
          message: "Сводка от Секретаря готова",
          feedback: () => Promise.resolve(),
        };
      },
      log: () => {},
    }),
    0,
  );
  assert.equal(seenBotHeader, SECRETARY_BOT_ID);
  assert.equal(claimedColleagueChatKey, `bot:${SECRETARY_BOT_ID}:42:`);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]?.token, SECRETARY_TOKEN);
  assert.equal(delivered[1]?.chat, "42");
  assert.equal(delivered[1]?.text, "Сводка от Секретаря готова");

  const stored = await listReminders();
  assert.equal(stored.find((r) => r.id === "r-col-task")?.delivered, true);
  assert.equal(stored.find((r) => r.id === textId)?.delivered, true);

  // При выключенной опции коллег напоминание коллеги не уходит.
  writeRawSettings(withColleaguesEnabled({}, false));
  await addReminder({
    id: "r-col-off",
    text: "Не должно уйти при выключенной опции",
    content: "text",
    chat: { id: "42", threadId: null, botId: SECRETARY_BOT_ID },
    schedule: { kind: "at", atMs: now - 500 },
  });
  await fireDue(now, 10);
  assert.equal(
    await runReminderFire("r-col-off", {
      env: process.env,
      send: fakeSend,
      log: () => {},
    }),
    0,
  );
  assert.equal(delivered.length, 2);
  const offRow = (await listReminders()).find((r) => r.id === "r-col-off");
  assert.equal(offRow?.delivered, false);
  assert.match(offRow?.error ?? "", /disabled/u);
});
