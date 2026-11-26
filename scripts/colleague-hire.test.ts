/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import fc from "fast-check";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import secretKeyInventory from "../agent/skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import {
  redact,
  secretValuesFromEnv,
} from "../packages/secret-redaction/index.ts";
import {
  buildManagedBotHireUrl,
  configuredTelegramBots,
  isManagedBotUsername,
  liveTelegramEnv,
  normalizeManagedBotUsername,
  parseColleagueBotTokens,
  removeColleagueBotToken,
  suggestColleagueBotUsername,
  TELEGRAM_BOT_ID_HEADER,
  upsertColleagueBotToken,
  type TelegramBotConfig,
} from "../packages/telegram-bots/index.ts";
import { createColleagueCommand } from "./cli/colleagues.ts";
import { createCliRuntime } from "./cli/runtime.ts";
import {
  applyRandomColleagueAvatar,
  COLLEAGUE_AVATAR_SIZE,
  convertPngToJpeg640,
  jpegDimensions,
} from "./lib/colleague-avatar.ts";
import { parseEnvText } from "./lib/env-file.ts";
import {
  acquireFileLockSync,
  releaseFileLock,
  type FileLock,
} from "../agent/lib/fs-atomic.ts";
import {
  enqueueQueueFile,
  isTelegramQueueUpdate,
  parseTelegramUpdates,
  type TelegramQueueUpdate,
} from "./lib/telegram-queue.ts";

const SEED = Number(process.env.FC_SEED ?? 20_261_126);

// Isolated runtime dirs before importing authored modules.
const root = mkdtempSync(join(tmpdir(), "iva-colleague-hire-"));
const dataPath = join(root, "data");
const vaultPath = join(root, "vault");
const envPath = join(root, ".env");
mkdirSync(dataPath, { recursive: true });
mkdirSync(vaultPath, { recursive: true });

const IVA_BOT_ID = "111111111";
const IVA_TOKEN = `${IVA_BOT_ID}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const HIRED_BOT_ID = "555555555";
const HIRED_TOKEN = `${HIRED_BOT_ID}:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE`;
const ROTATED_HIRED_TOKEN = `${HIRED_BOT_ID}:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG`;
const SECOND_BOT_ID = "666666666";
const SECOND_TOKEN = `${SECOND_BOT_ID}:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF`;
const WEBHOOK_SECRET = "colleague-hire-webhook-secret";

writeFileSync(
  envPath,
  [
    "# Iva test secrets",
    `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}`,
    "TELEGRAM_BOT_USERNAME=iva_main_bot",
    `TELEGRAM_WEBHOOK_SECRET_TOKEN=${WEBHOOK_SECRET}`,
    "TELEGRAM_ALLOWED_USER_IDS=42",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

process.env.ASSISTANT_DATA_DIR = dataPath;
process.env.ASSISTANT_VAULT_DIR = vaultPath;
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.AGENT_LANGUAGE = "ru";
process.env.TELEGRAM_BOT_TOKEN = IVA_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = "iva_main_bot";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_ENV_FILE = envPath;
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "iva-primary-model";
delete process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS;

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const [
  {
    buildColleagueHireLink,
    COLLEAGUE_ROLES,
    colleagueAvatarPhase,
    colleagueProfileCopy,
    consumeColleagueHireProposal,
    parseColleaguesConfig,
    readColleagueHireProposals,
    withColleague,
    withColleagueHireProposal,
    withColleaguesEnabled,
  },
  { colleagueExecute },
  { createTelegramChannel },
  { TELEGRAM_ACCEPTANCE_ROUTE },
  { scanOutbound },
  { redactNotice },
  {
    handleManagedBotUpdate,
    parseManagedBotUpdate,
    reconcilePendingColleagueAvatars,
    reconcilePendingColleagueHires,
  },
  { handleControl },
  { processTelegramBatch, processTelegramUpdate, runBotPollLoop },
  { acquireTelegramProcessLock, assertTelegramProcessLease },
] = await Promise.all([
  import("#lib/colleagues.ts"),
  import("#lib/colleague-tool.ts"),
  import("../agent/channels/telegram.ts"),
  import("#lib/telegram-acceptance.ts"),
  import("#lib/security-gate.ts"),
  import("#lib/outbox.ts"),
  import("./poller/managed-bot.ts"),
  import("./poller/control.ts"),
  import("./poller/main.ts"),
  import("./poller/process-lock.ts"),
]);

// Minimal valid RGB PNG generator (pure Node zlib, zero external fixtures) for real PNG -> 640x640 JPG conversion.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crcBuf]);
}

function makeSolidPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * rowSize;
    raw[off] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = 54;
      raw[off + 2 + x * 3] = 138;
      raw[off + 3 + x * 3] = 210;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAMPLE_PNG = makeSolidPng(128, 128);

function makeOwnerPrivateCtx() {
  const principal = {
    authenticator: "telegram-webhook",
    principalType: "user",
    attributes: { chat_type: "private", chat_id: "42", user_id: "42" },
  };
  return { session: { auth: { initiator: principal, current: principal } } };
}

function makeGroupCtx() {
  const principal = {
    authenticator: "telegram-webhook",
    principalType: "user",
    attributes: { chat_type: "supergroup", chat_id: "-1001", user_id: "42" },
  };
  return { session: { auth: { initiator: principal, current: principal } } };
}

function createIpAsLogoStubFetch(options: {
  readonly available: boolean;
  readonly logos?: Array<{
    id: number;
    slug: string;
    name: string;
    category: string;
    image_url: string;
  }>;
  readonly onRpcBody?: (body: Record<string, unknown>) => void;
  readonly onPhotoUpload?: (info: {
    token: string;
    photoMeta: Record<string, unknown>;
    avatarBytes: Buffer;
  }) => void;
}): typeof fetch {
  const logos = options.logos ?? [
    {
      id: 777,
      slug: "pixel-otter",
      name: "Pixel Otter",
      category: "animals",
      image_url: "https://cdn.ipaslogo.com/logos/pixel-otter.png",
    },
    {
      id: 888,
      slug: "cosmic-fox",
      name: "Cosmic Fox",
      category: "animals",
      image_url: "https://cdn.ipaslogo.com/logos/cosmic-fox.png",
    },
  ];
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("visualskills.dev/ip-as-logo-app/")) {
      if (!options.available) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (url.endsWith(".js")) {
        return new Response('const k = "sb_publishable_StubKey_1234567890";', {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response(
        '<html><script src="assets/index-AbC123_xY.js"></script></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url.includes("/rest/v1/rpc/get_logos")) {
      if (!options.available) {
        return new Response("Unavailable", { status: 503 });
      }
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      options.onRpcBody?.(body);
      return new Response(JSON.stringify(logos), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://cdn.ipaslogo.com/logos/")) {
      if (!options.available) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(new Uint8Array(SAMPLE_PNG), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    const tgMatch = /\/bot([^/]+)\/setMyProfilePhoto$/u.exec(url);
    if (tgMatch) {
      const token = tgMatch[1];
      assert.ok(
        init?.body instanceof FormData,
        "setMyProfilePhoto must use multipart FormData",
      );
      const rawPhoto = init.body.get("photo");
      assert.equal(typeof rawPhoto, "string");
      const photoMeta = JSON.parse(rawPhoto as string) as Record<
        string,
        unknown
      >;
      const rawAttach =
        typeof photoMeta.photo === "string" ? photoMeta.photo : "";
      const attachField = rawAttach.replace(/^attach:\/\//u, "");
      const filePart = init.body.get(attachField);
      assert.ok(filePart instanceof Blob, "missing attached avatar file part");
      const avatarBytes = Buffer.from(await filePart.arrayBuffer());
      options.onPhotoUpload?.({ token, photoMeta, avatarBytes });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch URL in stub: ${url}`);
  };
}

let leaseSeq = 0;
async function tempLease(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-lease-"));
  const lease = await acquireTelegramProcessLock({
    testGuard: {
      identity: `hire-${process.pid}-${++leaseSeq}`,
      directory: join(dir, ".guard"),
    },
  });
  t.after(async () => {
    await lease.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, lease };
}

// --- Пункт 1: Ива предлагает коллегу ссылкой вида t.me/newbot/<бот Ивы>/<имя>bot?name=… ---
test("п.1: buildColleagueHireLink, colleague tool action=hire, and CLI build valid t.me/newbot links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-link-"));
  const settingsFile = join(dir, "settings.json");
  try {
    // 1. Default link per role.
    for (const role of COLLEAGUE_ROLES) {
      const link = buildColleagueHireLink({
        managerBotUsername: "@iva_main_bot",
        role,
        lang: "ru",
      });
      const parsed = new URL(link.url);
      assert.equal(parsed.origin, "https://t.me");
      assert.equal(
        parsed.pathname,
        `/newbot/iva_main_bot/iva_main_${role}_bot`,
      );
      assert.ok(isManagedBotUsername(link.botUsername));
      assert.equal(
        parsed.searchParams.get("name"),
        colleagueProfileCopy(role, "ru").name,
      );
    }

    // 2. Custom username normalization (appends _bot if omitted) and custom display name.
    const custom = buildColleagueHireLink({
      managerBotUsername: "iva_main_bot",
      role: "critic",
      username: "@my_sharp_critic",
      name: "Злой Критик & Ко",
    });
    assert.equal(custom.botUsername, "my_sharp_critic_bot");
    assert.equal(
      custom.url,
      "https://t.me/newbot/iva_main_bot/my_sharp_critic_bot?name=%D0%97%D0%BB%D0%BE%D0%B9%20%D0%9A%D1%80%D0%B8%D1%82%D0%B8%D0%BA%20%26%20%D0%9A%D0%BE",
    );
    assert.equal(
      new URL(custom.url).searchParams.get("name"),
      "Злой Критик & Ко",
    );

    // 3. Invalid inputs fail closed.
    assert.throws(
      () =>
        buildColleagueHireLink({
          managerBotUsername: "not_a_bot_name",
          role: "critic",
        }),
      /TELEGRAM_BOT_USERNAME/u,
    );
    assert.throws(
      () =>
        buildColleagueHireLink({
          managerBotUsername: "iva_main_bot",
          role: "critic",
          username: "../evil_bot",
        }),
      /Invalid colleague bot username/u,
    );
    assert.equal(normalizeManagedBotUsername("bad__double_bot"), null);
    assert.equal(normalizeManagedBotUsername("123digit_bot"), null);

    // 4. Tool action=hire works only in owner's private chat and saves a pending proposal.
    const groupDenied = colleagueExecute(
      { action: "hire", role: "critic" },
      makeGroupCtx(),
      {
        settingsFile,
        env: {
          TELEGRAM_BOT_USERNAME: "iva_main_bot",
          MODEL_PROVIDER: "ollama",
        },
      },
    );
    assert.equal(groupDenied.ok, false);
    assert.match(groupDenied.error, /private chat/u);

    const hiredOffer = colleagueExecute(
      {
        action: "hire",
        role: "programmer",
        name: "Кодер",
        username: "iva_dev_bot",
        provider: "codex",
        model: "gpt-5.5",
      },
      makeOwnerPrivateCtx(),
      {
        settingsFile,
        env: {
          TELEGRAM_BOT_USERNAME: "iva_main_bot",
          MODEL_PROVIDER: "ollama",
          AGENT_LANGUAGE: "ru",
        },
      },
    );
    assert.equal(hiredOffer.ok, true);
    assert.equal(
      hiredOffer.hire?.url,
      "https://t.me/newbot/iva_main_bot/iva_dev_bot?name=%D0%9A%D0%BE%D0%B4%D0%B5%D1%80",
    );
    assert.equal(hiredOffer.hire?.provider, "codex");
    assert.equal(hiredOffer.hire?.model, "gpt-5.5");

    const proposals = readColleagueHireProposals(
      JSON.parse(readFileSync(settingsFile, "utf8")) as unknown,
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.botUsername, "iva_dev_bot");
    assert.equal(proposals[0]?.role, "programmer");
    assert.equal(proposals[0]?.phase, "proposed");

    // 5. CLI `iva colleague hire` outputs the link and records a pending proposal.
    const cliRoot = join(dir, "cli-root");
    const cliData = join(cliRoot, "data");
    mkdirSync(cliData, { recursive: true });
    writeFileSync(
      join(cliRoot, ".env"),
      "TELEGRAM_BOT_USERNAME=iva_cli_bot\nMODEL_PROVIDER=ollama\n",
      { mode: 0o600 },
    );
    const runtime = createCliRuntime(cliRoot);
    const printed: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      const cmd = createColleagueCommand(runtime);
      await cmd(["hire", "researcher"]);
    } finally {
      console.log = origLog;
    }
    assert.ok(
      printed.some((line) =>
        line.startsWith(
          "https://t.me/newbot/iva_cli_bot/iva_cli_researcher_bot?name=",
        ),
      ),
      `CLI did not print hire URL: ${JSON.stringify(printed)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`property: buildManagedBotHireUrl always produces valid t.me/newbot URLs with round-tripping name (seed ${SEED})`, () => {
  const managerBaseArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{2,14}$/);
  const roleArb = fc.constantFrom(...COLLEAGUE_ROLES);
  const nameArb = fc.string({ minLength: 1, maxLength: 40 }).filter(
    (s) =>
      s.trim().length > 0 &&
      [...s].every((ch) => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      }),
  );

  fc.assert(
    fc.property(managerBaseArb, roleArb, nameArb, (managerBase, role, name) => {
      const managerUsername = `${managerBase}_bot`;
      const botUsername = suggestColleagueBotUsername(managerUsername, role);
      assert.equal(isManagedBotUsername(botUsername), true);
      const url = buildManagedBotHireUrl({
        managerBotUsername: managerUsername,
        botUsername,
        displayName: name,
      });
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://t.me");
      assert.equal(
        parsed.pathname,
        `/newbot/${managerUsername}/${botUsername}`,
      );
      assert.equal(parsed.searchParams.get("name"), name.trim());
    }),
    { seed: SEED, numRuns: 200 },
  );
});

// --- Пункт 2: По событию managed_bot Ива берёт токен (getManagedBotToken), кладёт в .env,
//     ставит имя и описание роли, коллега начинает принимать сообщения ---
test("п.2: managed_bot fetches token, stores it in .env beside TELEGRAM_BOT_TOKEN, sets profile, and colleague immediately accepts messages", async (t) => {
  const settingsFile = join(dataPath, "settings.json");
  const hireStateDir = join(dataPath, "colleague-hires-p2.d");
  rmSync(settingsFile, { force: true });
  rmSync(hireStateDir, { recursive: true, force: true });
  // Reset clean .env without colleague tokens.
  writeFileSync(
    envPath,
    [
      "# Existing comment survives",
      `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}`,
      "TELEGRAM_BOT_USERNAME=iva_main_bot",
      `TELEGRAM_WEBHOOK_SECRET_TOKEN=${WEBHOOK_SECRET}`,
      "TELEGRAM_ALLOWED_USER_IDS=42",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const localEnv: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: IVA_TOKEN,
    TELEGRAM_BOT_USERNAME: "iva_main_bot",
    MODEL_PROVIDER: "ollama",
    OLLAMA_MODEL: "iva-primary-model",
    AGENT_LANGUAGE: "ru",
  };

  // Step 1: Iva proposes hiring Critic with custom model.
  const offer = colleagueExecute(
    {
      action: "hire",
      role: "critic",
      name: "Критик",
      username: "iva_main_critic_bot",
      provider: "openrouter",
      model: "anthropic/claude-opus-4.5",
    },
    makeOwnerPrivateCtx(),
    { settingsFile, env: localEnv },
  );
  assert.equal(offer.ok, true);

  // Step 2: Telegram sends `managed_bot` update to Iva.
  const managedUpdate: TelegramQueueUpdate = {
    update_id: 901,
    managed_bot: {
      user: { id: 42, is_bot: false, first_name: "Sergei" },
      bot: {
        id: Number(HIRED_BOT_ID),
        is_bot: true,
        first_name: "Критик",
        username: "iva_main_critic_bot",
      },
    },
  };
  assert.equal(isTelegramQueueUpdate(managedUpdate), true);
  assert.ok(parseManagedBotUpdate(managedUpdate));
  const parsedBatch = parseTelegramUpdates([managedUpdate]);
  assert.ok(
    parsedBatch && parsedBatch.length === 1 && "update" in parsedBatch[0],
  );

  const botApiCalls: Array<{
    readonly method: string;
    readonly token: string | undefined;
    readonly body: Record<string, unknown>;
  }> = [];
  const ownerReplies: Array<{ chatId: number | string; text: string }> = [];
  const hiredBots: TelegramBotConfig[] = [];
  let uploadedPhotoBytes: Buffer | null = null;
  let uploadedPhotoMeta: Record<string, unknown> | null = null;

  const avatarFetch = createIpAsLogoStubFetch({
    available: true,
    onPhotoUpload: ({ token, photoMeta, avatarBytes }) => {
      assert.equal(token, HIRED_TOKEN);
      uploadedPhotoBytes = avatarBytes;
      uploadedPhotoMeta = photoMeta;
    },
  });

  // Unauthorized user must be ignored completely before any Bot API call.
  const unauthorized = await handleManagedBotUpdate(
    {
      update_id: 900,
      managed_bot: {
        user: { id: 99999, is_bot: false, first_name: "Stranger" },
        bot: {
          id: Number(HIRED_BOT_ID),
          is_bot: true,
          first_name: "Evil",
          username: "evil_bot",
        },
      },
    },
    {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath,
      settingsFile,
      env: localEnv,
      tgImpl: () => {
        throw new Error("must not call Bot API for unauthorized managed_bot");
      },
      logImpl: () => {},
    },
  );
  assert.equal(unauthorized.status, "ignored");

  // Authorized owner confirmation flows through handleControl -> handleManagedBotUpdate.
  const controlOutcomes: Array<
    Awaited<ReturnType<typeof handleManagedBotUpdate>>
  > = [];
  const handled = await handleControl(managedUpdate, {
    managedBotImpl: async (u) => {
      const result = await handleManagedBotUpdate(u, {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath,
        settingsFile,
        hireStateDir,
        env: localEnv,
        tgImpl: (method, body, options) => {
          botApiCalls.push({ method, token: options?.token, body });
          if (method === "getManagedBotToken") {
            return Promise.resolve({ ok: true, result: HIRED_TOKEN });
          }
          return Promise.resolve({ ok: true, result: true });
        },
        replyImpl: (chatId, text) => {
          ownerReplies.push({ chatId, text });
          return Promise.resolve({ message_id: 1 });
        },
        avatarDeps: { fetchImpl: avatarFetch, random: () => 0.1 },
        onColleagueHired: (bot) => hiredBots.push(bot),
        lang: () => "ru",
        logImpl: () => {},
      });
      controlOutcomes.push(result);
      return result;
    },
  });
  assert.equal(handled, true);
  assert.equal(controlOutcomes.length, 1);
  const controlOutcome = controlOutcomes[0];
  assert.equal(controlOutcome.status, "hired");
  assert.equal(controlOutcome.avatarSet, true);

  // Verify getManagedBotToken was called with primary Iva token and managed bot's user_id.
  const tokenCall = botApiCalls.find((c) => c.method === "getManagedBotToken");
  assert.ok(tokenCall);
  assert.equal(tokenCall.token, IVA_TOKEN);
  assert.deepEqual(tokenCall.body, { user_id: Number(HIRED_BOT_ID) });

  // Verify setMyName, setMyDescription, setMyShortDescription called with colleague's token.
  const nameCall = botApiCalls.find((c) => c.method === "setMyName");
  const descCall = botApiCalls.find((c) => c.method === "setMyDescription");
  const shortDescCall = botApiCalls.find(
    (c) => c.method === "setMyShortDescription",
  );
  assert.equal(nameCall?.token, HIRED_TOKEN);
  assert.equal(nameCall?.body.name, "Критик");
  assert.equal(descCall?.token, HIRED_TOKEN);
  assert.match(String(descCall?.body.description), /Критик/u);
  assert.equal(shortDescCall?.token, HIRED_TOKEN);
  assert.match(String(shortDescCall?.body.short_description), /Критик/u);

  // Verify avatar was uploaded as 640x640 JPG via setMyProfilePhoto.
  assert.deepEqual(uploadedPhotoMeta, {
    type: "static",
    photo: "attach://avatar",
  });
  assert.ok(uploadedPhotoBytes !== null);
  assert.deepEqual(jpegDimensions(uploadedPhotoBytes), {
    width: COLLEAGUE_AVATAR_SIZE,
    height: COLLEAGUE_AVATAR_SIZE,
  });

  // Verify token is stored in .env (0600) right next to TELEGRAM_BOT_TOKEN, preserving comments.
  const envRaw = readFileSync(envPath, "utf8");
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.ok(envRaw.includes("# Existing comment survives"));
  const parsedEnv = parseEnvText(envRaw);
  assert.equal(parsedEnv.TELEGRAM_BOT_TOKEN, IVA_TOKEN);
  const parsedColleagues = parseColleagueBotTokens(
    parsedEnv.TELEGRAM_COLLEAGUE_BOT_TOKENS,
    IVA_BOT_ID,
  );
  assert.equal(parsedColleagues.length, 1);
  assert.equal(parsedColleagues[0]?.botId, HIRED_BOT_ID);
  assert.equal(parsedColleagues[0]?.token, HIRED_TOKEN);
  assert.equal(parsedColleagues[0]?.username, "iva_main_critic_bot");

  // Verify settings.json has colleague configured, option enabled, avatarPhase="set", proposal consumed.
  const rawSettings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<
    string,
    unknown
  >;
  const cfg = parseColleaguesConfig(rawSettings, () => {});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
  assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "openrouter");
  assert.equal(cfg.items[HIRED_BOT_ID]?.model, "anthropic/claude-opus-4.5");
  assert.equal(colleagueAvatarPhase(cfg.items[HIRED_BOT_ID]), "set");
  assert.equal(readColleagueHireProposals(rawSettings).length, 0);

  // Verify owner received confirmation without token.
  assert.equal(ownerReplies.length, 1);
  assert.equal(ownerReplies[0]?.chatId, "42");
  assert.equal(ownerReplies[0]?.text.includes(HIRED_TOKEN), false);

  // Step 3: Newly hired colleague immediately receives messages in Bridge poll loop AND Eve Channel
  // picks up the new token from .env via liveTelegramEnv without restarting Eve!
  assert.equal(hiredBots.length, 1);
  const hiredBot = hiredBots[0];
  const { dir: leaseDir, lease } = await tempLease(t);
  const admittedUpdates: TelegramQueueUpdate[] = [];
  let pollCalls = 0;
  await runBotPollLoop({
    bot: hiredBot,
    initialOffset: 0,
    assertLease: () => assertTelegramProcessLease(lease),
    colleaguesEnabledImpl: () =>
      parseColleaguesConfig(
        JSON.parse(readFileSync(settingsFile, "utf8")) as unknown,
        () => {},
      ).enabled,
    colleagueCompleteImpl: () =>
      parseColleaguesConfig(
        JSON.parse(readFileSync(settingsFile, "utf8")) as unknown,
        () => {},
      ).items[HIRED_BOT_ID] !== undefined,
    tgImpl: (method, body, opts) => {
      assert.equal(opts?.token, HIRED_TOKEN);
      assert.equal(method, "getUpdates");
      assert.ok(
        Array.isArray((body as { allowed_updates?: unknown }).allowed_updates),
      );
      pollCalls += 1;
      if (pollCalls === 1) {
        return Promise.resolve({
          ok: true,
          result: [
            {
              update_id: 1001,
              message: {
                message_id: 55,
                date: 1_700_000_000,
                chat: { id: 42, type: "private" },
                from: { id: 42, is_bot: false, first_name: "Sergei" },
                text: "Привет, новый Критик!",
              },
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, result: [] });
    },
    processUpdateImpl: (u) => {
      admittedUpdates.push(u);
      return Promise.resolve({
        offset: u.update_id + 1,
        ingressBlocked: false,
      });
    },
    saveOffsetImpl: () => Promise.resolve(),
    sleepImpl: () => Promise.resolve(),
    shouldContinue: () => pollCalls < 1,
    logImpl: () => {},
  });
  assert.equal(admittedUpdates.length, 1);
  assert.equal(admittedUpdates[0]?.message?.text, "Привет, новый Критик!");

  // Even though process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS was NEVER set in Eve's process,
  // liveTelegramEnv reads the newly written .env and Channel accepts + routes the colleague update!
  assert.equal(process.env.TELEGRAM_COLLEAGUE_BOT_TOKENS, undefined);
  const channelCalls: Array<{ token: string; method: string }> = [];
  const channel = createTelegramChannel({
    api: {
      fetch: (input) => {
        const url = input instanceof Request ? input.url : String(input);
        const match = /\/bot([^/]+)\/([^/?]+)/u.exec(url);
        assert.ok(match);
        channelCalls.push({ token: match[1], method: match[2] });
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, result: { message_id: 77 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    },
  });
  const acceptanceRoute = channel.routes.find(
    (r) => r.transport !== "websocket" && r.path === TELEGRAM_ACCEPTANCE_ROUTE,
  );
  assert.ok(acceptanceRoute && acceptanceRoute.transport !== "websocket");
  const sentToEve: Array<{
    address: string;
    state: TelegramChannelState | undefined;
  }> = [];
  const routeArgs = {
    from: (address: string) => ({
      send: (_msg: unknown, opts?: { state?: TelegramChannelState }) => {
        sentToEve.push({ address, state: opts?.state });
        return Promise.resolve({ id: "sess-hired-1" } as unknown as Session);
      },
      respond: () => Promise.reject(new Error("unexpected")),
      cancel: () => Promise.resolve({ status: "no_active_turn" as const }),
      clear: () => Promise.resolve({ status: "cleared" as const }),
      compact: () => Promise.resolve({ status: "compacted" as const }),
      reset: () => Promise.resolve({ status: "reset" as const }),
    }),
    resolveSession: () => Promise.resolve(undefined),
    attachSession: (id: string) => ({ id }) as unknown as Session,
    waitUntil: () => {},
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  const webhookReq = new Request(
    `http://127.0.0.1:8723${TELEGRAM_ACCEPTANCE_ROUTE}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
        [TELEGRAM_BOT_ID_HEADER]: HIRED_BOT_ID,
      },
      body: JSON.stringify(admittedUpdates[0]),
    },
  );
  const webhookRes = await acceptanceRoute.handler(webhookReq, routeArgs);
  assert.equal(webhookRes.status, 204);
  assert.equal(sentToEve.length, 1);
  assert.ok(sentToEve[0]?.address.startsWith(`bot:${HIRED_BOT_ID}:`));
  assert.equal(
    (sentToEve[0]?.state as { botId?: string } | undefined)?.botId,
    HIRED_BOT_ID,
  );
  // Typing/early action used the colleague's token, not Iva's!
  assert.ok(channelCalls.every((c) => c.token === HIRED_TOKEN));
  assert.ok(existsSync(leaseDir));

  // Verify `iva colleague remove` also removes the token from .env (arbiter T909 D1393 п.B).
  const cliCmd = createColleagueCommand({
    ok: () => {},
    dataDirAbs: () => dataPath,
    readEnv: () => parseEnvText(readFileSync(envPath, "utf8")),
    ENV_PATH: envPath,
  });
  await cliCmd(["remove", HIRED_BOT_ID]);
  const envAfterRemove = parseEnvText(readFileSync(envPath, "utf8"));
  assert.equal(envAfterRemove.TELEGRAM_COLLEAGUE_BOT_TOKENS, undefined);
});

function makeManagedHireUpdate(
  updateId: number,
  botId: string,
  username: string,
  firstName = "Критик",
): TelegramQueueUpdate {
  return {
    update_id: updateId,
    managed_bot: {
      user: { id: 42, is_bot: false, first_name: "Sergei" },
      bot: {
        id: Number(botId),
        is_bot: true,
        first_name: firstName,
        username,
      },
    },
  };
}

function writeHireTestEnv(file: string, colleagueLine?: string): void {
  writeFileSync(
    file,
    [
      `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}`,
      "TELEGRAM_BOT_USERNAME=iva_main_bot",
      ...(colleagueLine === undefined
        ? []
        : [`TELEGRAM_COLLEAGUE_BOT_TOKENS=${colleagueLine}`]),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

const successfulAvatar = {
  ok: true as const,
  logo: {
    id: 1,
    name: "Test Talisman",
    category: "test",
    source: "unit-test",
  },
  jpegBytes: 640,
};

test("возврат 1: temporary getManagedBotToken failure holds the update and the same update hires after recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-retry-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath);
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      901,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    const firstSavedOffsets: number[] = [];
    const secondSavedOffsets: number[] = [];
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];
    let tokenCalls = 0;

    const controlImpl = (u: TelegramQueueUpdate) =>
      handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            env: localEnv,
            tgImpl: (method) => {
              if (method === "getManagedBotToken") {
                tokenCalls += 1;
                if (tokenCalls === 1) {
                  return Promise.reject(new Error("token API timeout"));
                }
                return Promise.resolve({ ok: true, result: HIRED_TOKEN });
              }
              return Promise.resolve({ ok: true, result: true });
            },
            replyImpl: (_chatId, text) => {
              ownerNotices.push(text);
              return Promise.resolve({ message_id: 1 });
            },
            applyAvatarImpl: () => Promise.resolve(successfulAvatar),
            onColleagueHired: (bot) => hiredBots.push(bot),
            lang: () => "ru",
            logImpl: () => {},
          }),
      });

    const first = await processTelegramUpdate(update, 901, {
      handleControlImpl: controlImpl,
      saveOffsetImpl: (next) => {
        firstSavedOffsets.push(next);
        return Promise.resolve();
      },
      logImpl: () => {},
    });
    assert.deepEqual(first, { offset: 901, ingressBlocked: true });
    assert.deepEqual(firstSavedOffsets, []);
    assert.equal(hiredBots.length, 0);
    assert.equal(ownerNotices.length, 0);

    const second = await processTelegramUpdate(update, 901, {
      handleControlImpl: controlImpl,
      saveOffsetImpl: (next) => {
        secondSavedOffsets.push(next);
        return Promise.resolve();
      },
      logImpl: () => {},
    });
    assert.deepEqual(second, { offset: 902, ingressBlocked: false });
    assert.deepEqual(secondSavedOffsets, [902]);
    assert.equal(tokenCalls, 2);
    assert.equal(hiredBots.length, 1);
    assert.equal(ownerNotices.length, 1);
    const cfg = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("возврат 2: repeated managed_bot keeps the existing role and disabled option, and does not consume another proposal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-repeat-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  try {
    let settings = withColleaguesEnabled({}, false);
    settings = withColleague(settings, {
      botId: HIRED_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "critic-model",
      name: "Критик",
      username: "iva_main_critic_bot",
      avatarPhase: "set",
      avatarLogoId: 10,
      avatarName: "Old Talisman",
    });
    settings = withColleagueHireProposal(
      settings,
      {
        botUsername: "iva_main_researcher_bot",
        role: "researcher",
        provider: "openrouter",
        model: "researcher-model",
        name: "Исследователь",
      },
      1_700_000_000_000,
    );
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });

    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      910,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    let avatarCalls = 0;
    const controlImpl = (u: TelegramQueueUpdate) =>
      handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            env: localEnv,
            tgImpl: (method) =>
              Promise.resolve(
                method === "getManagedBotToken"
                  ? { ok: true, result: HIRED_TOKEN }
                  : { ok: true, result: true },
              ),
            replyImpl: () => Promise.resolve({ message_id: 1 }),
            applyAvatarImpl: () => {
              avatarCalls += 1;
              return Promise.resolve(successfulAvatar);
            },
            now: () => 1_700_000_000_100,
            lang: () => "ru",
            logImpl: () => {},
          }),
      });

    const processed = await processTelegramUpdate(update, 910, {
      handleControlImpl: controlImpl,
      saveOffsetImpl: () => Promise.resolve(),
      logImpl: () => {},
    });
    assert.equal(processed.ingressBlocked, false);
    assert.equal(avatarCalls, 0);

    const rawSettings = JSON.parse(
      readFileSync(localSettings, "utf8"),
    ) as Record<string, unknown>;
    const cfg = parseColleaguesConfig(rawSettings, () => {});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
    assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "ollama");
    assert.equal(cfg.items[HIRED_BOT_ID]?.model, "critic-model");
    const proposals = readColleagueHireProposals(
      rawSettings,
      1_700_000_000_100,
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.role, "researcher");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("возврат 3: profile write failure blocks the success path and is completed when the same update is retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-profile-retry-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath);
  try {
    let settings = withColleaguesEnabled({}, false);
    settings = withColleagueHireProposal(
      settings,
      {
        botUsername: "iva_main_critic_bot",
        role: "critic",
        provider: "openrouter",
        model: "critic-model",
        name: "Критик",
      },
      1_700_000_000_000,
    );
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });

    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      920,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    const profileCalls: string[] = [];
    const savedOffsets: number[] = [];
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];

    const controlImpl = (u: TelegramQueueUpdate) =>
      handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            env: localEnv,
            tgImpl: (method) => {
              if (method === "getManagedBotToken") {
                return Promise.resolve({ ok: true, result: HIRED_TOKEN });
              }
              if (
                method === "setMyName" ||
                method === "setMyDescription" ||
                method === "setMyShortDescription"
              ) {
                profileCalls.push(method);
                if (profileCalls.length <= 3) {
                  return Promise.resolve({
                    ok: false,
                    description: "Bot API temporarily unavailable",
                  });
                }
              }
              return Promise.resolve({ ok: true, result: true });
            },
            replyImpl: (_chatId, text) => {
              ownerNotices.push(text);
              return Promise.resolve({ message_id: 1 });
            },
            applyAvatarImpl: () => Promise.resolve(successfulAvatar),
            onColleagueHired: (bot) => hiredBots.push(bot),
            now: () => 1_700_000_000_100,
            lang: () => "ru",
            logImpl: () => {},
          }),
      });
    const processOnce = () =>
      processTelegramUpdate(update, 920, {
        handleControlImpl: controlImpl,
        saveOffsetImpl: (next) => {
          savedOffsets.push(next);
          return Promise.resolve();
        },
        logImpl: () => {},
      });

    const first = await processOnce();
    assert.deepEqual(first, { offset: 920, ingressBlocked: true });
    assert.deepEqual(savedOffsets, []);
    assert.equal(hiredBots.length, 0);
    assert.equal(ownerNotices.length, 0);
    assert.equal(
      parseColleaguesConfig(readFileSync(localSettings, "utf8"), () => {})
        .items[HIRED_BOT_ID],
      undefined,
    );

    const second = await processOnce();
    assert.deepEqual(second, { offset: 921, ingressBlocked: false });
    assert.deepEqual(savedOffsets, [921]);
    assert.equal(hiredBots.length, 1);
    assert.equal(ownerNotices.length, 1);
    assert.equal(
      profileCalls.filter((method) => method === "setMyName").length,
      2,
    );
    const cfg = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
    assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "openrouter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T941: repeat after setMyName 503 completes the journaled researcher hire after proposal expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-t941-repeat-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    const ttlMs = 24 * 60 * 60 * 1000;
    const createdAt = 1_700_000_000_000;
    const beforeExpiry = createdAt + ttlMs - 1_000;
    let currentTime = beforeExpiry;
    let settings = withColleaguesEnabled({}, true);
    settings = withColleagueHireProposal(
      settings,
      {
        botUsername: "iva_main_helpers_bot",
        role: "researcher",
        provider: "openrouter",
        model: "approved-researcher-model",
        name: "Исследователь",
      },
      createdAt,
    );
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });

    const update = makeManagedHireUpdate(
      1100,
      HIRED_BOT_ID,
      "iva_main_helpers_bot",
      "Helper",
    );
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "fallback-ollama-model",
    };
    const profileCalls: {
      method: string;
      body: Record<string, unknown>;
    }[] = [];
    let setMyNameCalls = 0;
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath: localEnvPath,
      settingsFile: localSettings,
      hireStateDir,
      env: localEnv,
      tgImpl: (method: string, body: Record<string, unknown>) => {
        if (
          method === "setMyName" ||
          method === "setMyDescription" ||
          method === "setMyShortDescription"
        ) {
          profileCalls.push({ method, body });
        }
        if (method === "getManagedBotToken") {
          return Promise.resolve({ ok: true, result: HIRED_TOKEN });
        }
        if (method === "setMyName") {
          setMyNameCalls += 1;
          if (setMyNameCalls === 1) {
            return Promise.resolve({
              ok: false,
              error_code: 503,
              description: "Bot API temporarily unavailable",
            });
          }
        }
        return Promise.resolve({ ok: true, result: true });
      },
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      now: () => currentTime,
      lang: () => "ru" as const,
      logImpl: () => {},
    };

    const first = await handleManagedBotUpdate(update, deps);
    assert.equal(first.status, "failed");
    if (first.status === "failed") assert.equal(first.retry, true);
    assert.equal(
      parseColleaguesConfig(
        JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
        () => {},
      ).items[HIRED_BOT_ID],
      undefined,
    );

    currentTime = beforeExpiry + 3_000;
    const second = await handleManagedBotUpdate(update, deps);
    assert.equal(second.status, "hired");

    const rawSettings = JSON.parse(
      readFileSync(localSettings, "utf8"),
    ) as Record<string, unknown>;
    const cfg = parseColleaguesConfig(rawSettings, () => {});
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "researcher");
    assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "openrouter");
    assert.equal(cfg.items[HIRED_BOT_ID]?.model, "approved-researcher-model");
    assert.equal(cfg.items[HIRED_BOT_ID]?.name, "Исследователь");
    const rawColleagues = rawSettings.colleagues as
      Record<string, unknown> | undefined;
    assert.equal(rawColleagues?.pendingHires, undefined);
    const lastNameCall = [...profileCalls]
      .reverse()
      .find((call) => call.method === "setMyName");
    assert.equal(lastNameCall?.body.name, "Исследователь");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T941: background reconciliation completes the same journaled hire with the saved role and model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-t941-reconcile-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    const ttlMs = 24 * 60 * 60 * 1000;
    const createdAt = 1_700_000_000_000;
    const beforeExpiry = createdAt + ttlMs - 1_000;
    let settings = withColleaguesEnabled({}, true);
    settings = withColleagueHireProposal(
      settings,
      {
        botUsername: "iva_main_helpers_bot",
        role: "researcher",
        provider: "openrouter",
        model: "approved-researcher-model",
        name: "Исследователь",
      },
      createdAt,
    );
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });

    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "fallback-ollama-model",
    };
    let failFirstName = true;
    const tgImpl = (method: string) => {
      if (method === "getManagedBotToken") {
        return Promise.resolve({ ok: true, result: HIRED_TOKEN });
      }
      if (method === "setMyName" && failFirstName) {
        failFirstName = false;
        return Promise.resolve({
          ok: false,
          error_code: 503,
          description: "Bot API temporarily unavailable",
        });
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const first = await handleManagedBotUpdate(
      makeManagedHireUpdate(
        1100,
        HIRED_BOT_ID,
        "iva_main_helpers_bot",
        "Helper",
      ),
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        hireStateDir,
        env: localEnv,
        tgImpl,
        replyImpl: () => Promise.resolve({ message_id: 1 }),
        applyAvatarImpl: () => Promise.resolve(successfulAvatar),
        now: () => beforeExpiry,
        lang: () => "ru",
        logImpl: () => {},
      },
    );
    assert.equal(first.status, "failed");

    const afterExpiryAndRetryDelay = beforeExpiry + 31_000;
    const completed = await reconcilePendingColleagueHires({
      settingsFile: localSettings,
      envPath: localEnvPath,
      hireStateDir,
      env: localEnv,
      tgImpl,
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      now: () => afterExpiryAndRetryDelay,
      lang: () => "ru",
      logImpl: () => {},
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });

    const rawSettings = JSON.parse(
      readFileSync(localSettings, "utf8"),
    ) as Record<string, unknown>;
    const cfg = parseColleaguesConfig(rawSettings, () => {});
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "researcher");
    assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "openrouter");
    assert.equal(cfg.items[HIRED_BOT_ID]?.model, "approved-researcher-model");
    assert.equal(cfg.items[HIRED_BOT_ID]?.name, "Исследователь");
    const rawColleagues = rawSettings.colleagues as
      Record<string, unknown> | undefined;
    assert.equal(rawColleagues?.pendingHires, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T941: hire proposal boundary uses the exact username and the 24h deadline", () => {
  const ttlMs = 24 * 60 * 60 * 1000;
  const createdAt = 1_700_000_000_000;
  const settings = withColleagueHireProposal(
    withColleaguesEnabled({}, true),
    {
      botUsername: "iva_main_helpers_bot",
      role: "researcher",
      provider: "openrouter",
      model: "approved-researcher-model",
      name: "Исследователь",
    },
    createdAt,
  );

  const atDeadline = consumeColleagueHireProposal(
    settings,
    { username: "iva_main_helpers_bot" },
    createdAt + ttlMs,
  );
  assert.equal(atDeadline.proposal?.role, "researcher");
  assert.equal(atDeadline.proposal?.provider, "openrouter");
  assert.equal(atDeadline.proposal?.model, "approved-researcher-model");

  const afterDeadline = consumeColleagueHireProposal(
    settings,
    { username: "iva_main_helpers_bot" },
    createdAt + ttlMs + 1,
  );
  assert.equal(afterDeadline.proposal, null);

  const wrongUsername = consumeColleagueHireProposal(
    settings,
    { username: "iva_main_other_bot" },
    createdAt + 1_000,
  );
  assert.equal(wrongUsername.proposal, null);
});

test("возврат 4: concurrent avatar reconciliation shares one in-flight upload per colleague", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-avatar-single-flight-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  try {
    writeFileSync(
      localSettings,
      JSON.stringify({
        colleagues: {
          enabled: true,
          items: {
            [HIRED_BOT_ID]: {
              botId: HIRED_BOT_ID,
              role: "critic",
              provider: "ollama",
              model: "critic-model",
              username: "iva_main_critic_bot",
              avatarPhase: "pending",
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      MODEL_PROVIDER: "ollama",
    };
    let avatarCalls = 0;
    let releaseAvatar!: () => void;
    const avatarGate = new Promise<void>((resolve) => {
      releaseAvatar = resolve;
    });
    const deps = {
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      now: () => 1_700_000_000_000,
      applyAvatarImpl: () => {
        avatarCalls += 1;
        return avatarGate.then(() => successfulAvatar);
      },
      logImpl: () => {},
    };

    const first = reconcilePendingColleagueAvatars(deps);
    const second = reconcilePendingColleagueAvatars(deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(avatarCalls, 1);
    releaseAvatar();
    await Promise.all([first, second]);
    assert.equal(avatarCalls, 1);
    assert.equal(
      colleagueAvatarPhase(
        parseColleaguesConfig(
          JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
          () => {},
        ).items[HIRED_BOT_ID],
      ),
      "set",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("возврат 5: known colleague tokens are redacted from managed_bot and getUpdates error logs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-token-log-redaction-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  const previousEnvFile = process.env.IVA_ENV_FILE;
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const managedLogs: string[] = [];
    const failed = await handleManagedBotUpdate(
      makeManagedHireUpdate(930, HIRED_BOT_ID, "iva_main_critic_bot"),
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        env: localEnv,
        tgImpl: (method) => {
          if (method === "getManagedBotToken") {
            return Promise.reject(
              new Error(
                `timeout calling https://api.telegram.org/bot${HIRED_TOKEN}/getManagedBotToken`,
              ),
            );
          }
          return Promise.resolve({ ok: true, result: true });
        },
        logImpl: (...args: unknown[]) =>
          managedLogs.push(args.map(String).join(" ")),
      },
    );
    assert.equal(failed.status, "failed");
    assert.equal(managedLogs.join("\n").includes(HIRED_TOKEN), false);

    const pollLogs: string[] = [];
    const { lease } = await tempLease(t);
    let pollCalls = 0;
    process.env.IVA_ENV_FILE = localEnvPath;
    await runBotPollLoop({
      bot: {
        botId: SECOND_BOT_ID,
        token: SECOND_TOKEN,
        username: "iva_main_second_bot",
        isPrimary: false,
      },
      initialOffset: 0,
      assertLease: () => assertTelegramProcessLease(lease),
      colleaguesEnabledImpl: () => true,
      colleagueCompleteImpl: () => true,
      tgImpl: (method) => {
        if (method === "getUpdates") {
          pollCalls += 1;
          return Promise.resolve({
            ok: false,
            description: `upstream echoed ${HIRED_TOKEN}`,
          });
        }
        return Promise.resolve({ ok: true, result: true });
      },
      sleepImpl: () => Promise.resolve(),
      shouldContinue: () => pollCalls < 1,
      logImpl: (...args: unknown[]) =>
        pollLogs.push(args.map(String).join(" ")),
    });
    assert.equal(pollCalls, 1);
    assert.equal(pollLogs.join("\n").includes(HIRED_TOKEN), false);

    const controlLogs: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      controlLogs.push(args.map(String).join(" "));
    };
    try {
      const controlOutcome = await handleControl(
        { update_id: 931, managed_bot: {} },
        {
          managedBotImpl: () =>
            Promise.reject(
              new Error(`fatal managed bot failure with ${HIRED_TOKEN}`),
            ),
        },
      );
      assert.equal(controlOutcome, "retry");
    } finally {
      console.log = originalConsoleLog;
    }
    assert.equal(controlLogs.join("\n").includes(HIRED_TOKEN), false);
  } finally {
    if (previousEnvFile === undefined) delete process.env.IVA_ENV_FILE;
    else process.env.IVA_ENV_FILE = previousEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940: persistent temporary getManagedBotToken failure is bounded, releases ingress, and background reconciliation completes the hire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-token-defer-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const managed = makeManagedHireUpdate(
      1010,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    const ordinary = {
      update_id: 1011,
      message: {
        message_id: 11,
        date: 1,
        text: "hello",
        from: { id: 42, is_bot: false, first_name: "Sergei" },
        chat: { id: 42, type: "private" },
      },
    } as TelegramQueueUpdate;
    const managedLogs: string[] = [];
    const admitted: number[] = [];
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];
    let tokenCalls = 0;
    let tokenAvailable = false;
    const tgImpl = (method: string) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        if (!tokenAvailable) {
          return Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
        return Promise.resolve({ ok: true, result: HIRED_TOKEN });
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const controlImpl = (u: TelegramQueueUpdate) => {
      if (!u.managed_bot) return Promise.resolve(false);
      return handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            hireStateDir,
            env: localEnv,
            now: () => 1_700_000_000_100,
            tgImpl,
            logImpl: (...args: unknown[]) =>
              managedLogs.push(args.map(String).join(" ")),
          }),
      });
    };
    const processImpl = (u: TelegramQueueUpdate, current: number) =>
      processTelegramUpdate(u, current, {
        handleControlImpl: controlImpl,
        admitImpl: (candidate) => {
          admitted.push(candidate.update_id);
          return Promise.resolve("owned");
        },
        saveOffsetImpl: () => Promise.resolve(),
        logImpl: () => {},
      });

    let batch = { offset: 1010, ingressBlocked: false };
    for (let pass = 0; pass < 5 && batch.offset !== 1012; pass += 1) {
      batch = await processTelegramBatch(
        [{ update: managed }, { update: ordinary }],
        batch.offset,
        {
          processImpl,
          saveOffsetImpl: () => Promise.resolve(),
          logImpl: () => {},
        },
      );
    }

    assert.deepEqual(batch, { offset: 1012, ingressBlocked: false });
    assert.deepEqual(admitted, [1011]);
    assert.equal(tokenCalls, 3);
    assert.ok(
      managedLogs.some(
        (line) =>
          line.includes("update_id=1010") && line.includes("acknowledged"),
      ),
      `missing acknowledgement journal line with update_id: ${managedLogs.join("\n")}`,
    );
    const stateFile = join(hireStateDir, `${HIRED_BOT_ID}.json`);
    assert.equal(existsSync(stateFile), true);
    const durable = JSON.parse(readFileSync(stateFile, "utf8")) as {
      updateId?: number;
      attempts?: number;
    };
    assert.equal(durable.updateId, 1010);
    assert.equal(durable.attempts, 3);

    tokenAvailable = true;
    const completed = await reconcilePendingColleagueHires({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      hireStateDir,
      now: () => 1_700_000_600_200,
      tgImpl,
      replyImpl: (_chatId, text) => {
        ownerNotices.push(text);
        return Promise.resolve({ message_id: 1 });
      },
      onColleagueHired: (bot) => hiredBots.push(bot),
      lang: () => "ru",
      logImpl: () => {},
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(existsSync(stateFile), true);
    const completedState = JSON.parse(readFileSync(stateFile, "utf8")) as {
      phase?: string;
      updateId?: number;
    };
    assert.equal(completedState.phase, "completed");
    assert.equal(completedState.updateId, 1010);
    assert.equal(hiredBots.length, 1);
    assert.equal(ownerNotices.length, 1);
    const cfg = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
    const envAfter = parseEnvText(readFileSync(localEnvPath, "utf8"));
    assert.ok(
      envAfter.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(HIRED_TOKEN),
      "reconciliation must store the managed bot token in .env",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("последний круг A: permanent getManagedBotToken failure is acknowledged and the next message enters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-terminal-token-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath);
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const managed = makeManagedHireUpdate(
      1010,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    const ordinary = {
      update_id: 1011,
      message: {
        message_id: 11,
        date: 1,
        text: "hello",
        from: { id: 42, is_bot: false, first_name: "Sergei" },
        chat: { id: 42, type: "private" },
      },
    } as TelegramQueueUpdate;
    const managedLogs: string[] = [];
    const admitted: number[] = [];
    let tokenCalls = 0;
    const controlImpl = (u: TelegramQueueUpdate) => {
      if (!u.managed_bot) return Promise.resolve(false);
      return handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            env: localEnv,
            tgImpl: (method) => {
              if (method === "getManagedBotToken") {
                tokenCalls += 1;
                return Promise.resolve({
                  ok: false,
                  error_code: 400,
                  description: "Bad Request: bot not found",
                });
              }
              return Promise.resolve({ ok: true, result: true });
            },
            logImpl: (...args: unknown[]) =>
              managedLogs.push(args.map(String).join(" ")),
          }),
      });
    };
    const processImpl = (u: TelegramQueueUpdate, current: number) =>
      processTelegramUpdate(u, current, {
        handleControlImpl: controlImpl,
        admitImpl: (candidate) => {
          admitted.push(candidate.update_id);
          return Promise.resolve("owned");
        },
        saveOffsetImpl: () => Promise.resolve(),
        logImpl: () => {},
      });

    let batch = { offset: 1010, ingressBlocked: false };
    for (let pass = 0; pass < 3 && batch.offset !== 1012; pass += 1) {
      batch = await processTelegramBatch(
        [{ update: managed }, { update: ordinary }],
        batch.offset,
        {
          processImpl,
          saveOffsetImpl: () => Promise.resolve(),
          logImpl: () => {},
        },
      );
    }

    assert.deepEqual(batch, { offset: 1012, ingressBlocked: false });
    assert.deepEqual(admitted, [1011]);
    assert.equal(tokenCalls, 1);
    assert.ok(
      managedLogs.some(
        (line) => line.includes("update_id=1010") && line.includes("terminal"),
      ),
      `missing terminal journal line with update_id: ${managedLogs.join("\n")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 avatar-settings write failure releases ingress and keeps avatar retry available", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-avatar-settings-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  let avatarSettingsLock: FileLock | null = null;
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const managed = makeManagedHireUpdate(
      1010,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    const ordinary = {
      update_id: 1011,
      message: {
        message_id: 11,
        date: 1,
        text: "hello",
        from: { id: 42, is_bot: false, first_name: "Sergei" },
        chat: { id: 42, type: "private" },
      },
    } as TelegramQueueUpdate;
    const admitted: number[] = [];
    const controlImpl = (u: TelegramQueueUpdate) => {
      if (!u.managed_bot) return Promise.resolve(false);
      return handleControl(u, {
        managedBotImpl: (managedUpdate) =>
          handleManagedBotUpdate(managedUpdate, {
            allowedUserIds: new Set(["42"]),
            primaryBotId: IVA_BOT_ID,
            primaryBotToken: IVA_TOKEN,
            envPath: localEnvPath,
            settingsFile: localSettings,
            hireStateDir,
            env: localEnv,
            now: () => 1_700_000_000_100,
            tgImpl: () => Promise.resolve({ ok: true, result: HIRED_TOKEN }),
            applyAvatarImpl: () => {
              avatarSettingsLock = acquireFileLockSync(
                `${localSettings}.lock`,
                { mode: 0o600 },
              );
              assert.ok(avatarSettingsLock, "test must hold settings lock");
              return Promise.resolve(successfulAvatar);
            },
            replyImpl: () => Promise.resolve({ message_id: 1 }),
            logImpl: () => {},
          }),
      });
    };
    const processImpl = (u: TelegramQueueUpdate, current: number) =>
      processTelegramUpdate(u, current, {
        handleControlImpl: controlImpl,
        admitImpl: (candidate) => {
          admitted.push(candidate.update_id);
          return Promise.resolve("owned");
        },
        saveOffsetImpl: () => Promise.resolve(),
        logImpl: () => {},
      });

    const batch = await processTelegramBatch(
      [{ update: managed }, { update: ordinary }],
      1010,
      {
        processImpl,
        saveOffsetImpl: () => Promise.resolve(),
        logImpl: () => {},
      },
    );

    assert.deepEqual(batch, { offset: 1012, ingressBlocked: false });
    assert.deepEqual(admitted, [1011]);
    const beforeRetry = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    ).items[HIRED_BOT_ID];
    assert.ok(
      beforeRetry,
      "colleague settings must survive avatar state failure",
    );
    assert.equal(colleagueAvatarPhase(beforeRetry), "pending");

    if (avatarSettingsLock) {
      releaseFileLock(avatarSettingsLock);
      avatarSettingsLock = null;
    }
    const avatars = await reconcilePendingColleagueAvatars({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      now: () => 1_700_000_060_100,
      logImpl: () => {},
    });
    assert.deepEqual(avatars, { attempted: 1, succeeded: 1 });
    const afterRetry = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    ).items[HIRED_BOT_ID];
    assert.equal(colleagueAvatarPhase(afterRetry), "set");
  } finally {
    if (avatarSettingsLock) releaseFileLock(avatarSettingsLock);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 token rotation: reconciliation refreshes the managed token of an already configured colleague", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-token-rotation-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  try {
    let settings = withColleaguesEnabled({}, true);
    settings = withColleague(settings, {
      botId: HIRED_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "critic-model",
      name: "Критик",
      username: "iva_main_critic_bot",
      avatarPhase: "set",
    });
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      1150,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    let tokenCalls = 0;
    let tokenAvailable = false;
    const profileTokens: string[] = [];
    const tgImpl = (
      method: string,
      _body: Record<string, unknown>,
      options?: { token?: string },
    ) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        if (!tokenAvailable) {
          return Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
        return Promise.resolve({ ok: true, result: ROTATED_HIRED_TOKEN });
      }
      if (method.startsWith("setMy")) {
        const token = options?.token ?? "";
        profileTokens.push(token);
        if (token === HIRED_TOKEN) {
          return Promise.resolve({
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          });
        }
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath: localEnvPath,
      settingsFile: localSettings,
      hireStateDir,
      env: localEnv,
      now: () => 1_700_000_000_100,
      tgImpl,
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      lang: () => "ru" as const,
      logImpl: () => {},
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handleManagedBotUpdate(update, deps);
    }
    assert.equal(tokenCalls, 3);
    assert.equal(existsSync(join(hireStateDir, `${HIRED_BOT_ID}.json`)), true);

    tokenAvailable = true;
    const completed = await reconcilePendingColleagueHires({
      ...deps,
      now: () => 1_700_000_601_100,
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(tokenCalls, 4, "reconciliation must refresh the event token");
    assert.ok(profileTokens.length > 0);
    assert.ok(
      profileTokens.every((token) => token === ROTATED_HIRED_TOKEN),
      `profile write used stale token: ${profileTokens.join(",")}`,
    );
    const envAfter = parseEnvText(readFileSync(localEnvPath, "utf8"));
    assert.ok(
      envAfter.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(ROTATED_HIRED_TOKEN),
      "rotated token must replace the stale token in .env",
    );
    assert.equal(
      envAfter.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(HIRED_TOKEN),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 handoff: redelivery after background completion does not complete the hire twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-handoff-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      1200,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    let nowValue = 1_700_000_000_100;
    let tokenCalls = 0;
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];
    const tgImpl = (method: string) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
        return Promise.resolve({ ok: true, result: HIRED_TOKEN });
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath: localEnvPath,
      settingsFile: localSettings,
      hireStateDir,
      env: localEnv,
      now: () => nowValue,
      tgImpl,
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: (_chatId: number | string, text: string) => {
        ownerNotices.push(text);
        return Promise.resolve({ message_id: 1 });
      },
      onColleagueHired: (bot: TelegramBotConfig) => hiredBots.push(bot),
      lang: () => "ru" as const,
      logImpl: () => {},
    };

    const first = await handleManagedBotUpdate(update, deps);
    assert.equal(first.status, "failed");
    if (first.status === "failed") assert.equal(first.retry, true);
    nowValue += 31_000;
    const completed = await reconcilePendingColleagueHires(deps);
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(ownerNotices.length, 1);
    assert.equal(hiredBots.length, 1);

    const redelivered = await handleManagedBotUpdate(update, deps);
    assert.equal(redelivered.status, "ignored");
    assert.equal(ownerNotices.length, 1, "duplicate owner notification");
    assert.equal(hiredBots.length, 1, "duplicate colleague startup");
    assert.equal(tokenCalls, 2, "redelivery must not query Bot API again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 acceptor token refresh: profile-stage 401 makes reconciliation request the managed token again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-token-refresh-exact-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  try {
    let settings = withColleaguesEnabled({}, true);
    settings = withColleague(settings, {
      botId: HIRED_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "critic-model",
      name: "Критик",
      username: "iva_main_critic_bot",
      avatarPhase: "set",
    });
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      1250,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    let tokenCalls = 0;
    let oldProfileCalls = 0;
    const profileTokens: string[] = [];
    const tgImpl = (
      method: string,
      _body: Record<string, unknown>,
      options?: { token?: string },
    ) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return Promise.resolve({ ok: true, result: HIRED_TOKEN });
        }
        if (tokenCalls <= 3) {
          return Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
        return Promise.resolve({ ok: true, result: ROTATED_HIRED_TOKEN });
      }
      if (method.startsWith("setMy")) {
        const token = options?.token ?? "";
        profileTokens.push(token);
        if (token === HIRED_TOKEN) {
          oldProfileCalls += 1;
          return Promise.resolve({
            ok: false,
            error_code: oldProfileCalls <= 3 ? 503 : 401,
            description:
              oldProfileCalls <= 3
                ? "Bot API temporarily unavailable"
                : "Unauthorized",
          });
        }
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath: localEnvPath,
      settingsFile: localSettings,
      hireStateDir,
      env: localEnv,
      now: () => 1_700_000_000_100,
      tgImpl,
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      lang: () => "ru" as const,
      logImpl: () => {},
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handleManagedBotUpdate(update, deps);
    }
    assert.equal(tokenCalls, 3);

    const completed = await reconcilePendingColleagueHires({
      ...deps,
      now: () => 1_700_000_601_100,
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(
      tokenCalls,
      4,
      "reconciliation must refresh the managed token after 401",
    );
    assert.ok(
      profileTokens.some((token) => token === ROTATED_HIRED_TOKEN),
      `profile write did not use rotated token: ${profileTokens.join(",")}`,
    );
    const envAfter = parseEnvText(readFileSync(localEnvPath, "utf8"));
    assert.ok(
      envAfter.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(ROTATED_HIRED_TOKEN),
      "rotated token must reach .env",
    );
    assert.equal(
      envAfter.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(HIRED_TOKEN),
      false,
      "stale token must leave .env",
    );
    assert.equal(
      readFileSync(localSettings, "utf8").includes(HIRED_TOKEN),
      false,
      "stale token must not reach settings.json",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 acceptor live redelivery: handler and reconciliation are serialized per bot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-live-redelivery-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const update = makeManagedHireUpdate(
      1260,
      HIRED_BOT_ID,
      "iva_main_critic_bot",
    );
    let nowValue = 1_700_000_000_100;
    let tokenCalls = 0;
    let releaseToken!: (value: { ok: true; result: string }) => void;
    const gatedToken = new Promise<{ ok: true; result: string }>((resolve) => {
      releaseToken = resolve;
    });
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];
    const profileCalls: string[] = [];
    const tgImpl = (method: string) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          return Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          );
        }
        if (tokenCalls === 2) return gatedToken;
        return Promise.resolve({ ok: true, result: HIRED_TOKEN });
      }
      if (method.startsWith("setMy")) profileCalls.push(method);
      return Promise.resolve({ ok: true, result: true });
    };
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotId: IVA_BOT_ID,
      primaryBotToken: IVA_TOKEN,
      envPath: localEnvPath,
      settingsFile: localSettings,
      hireStateDir,
      env: localEnv,
      now: () => nowValue,
      tgImpl,
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: (_chatId: number | string, text: string) => {
        ownerNotices.push(text);
        return Promise.resolve({ message_id: 1 });
      },
      onColleagueHired: (bot: TelegramBotConfig) => hiredBots.push(bot),
      lang: () => "ru" as const,
      logImpl: () => {},
    };

    const first = await handleManagedBotUpdate(update, deps);
    assert.equal(first.status, "failed");
    nowValue += 31_000;
    const reconciliation = reconcilePendingColleagueHires(deps);
    while (tokenCalls < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const redelivery = handleManagedBotUpdate(update, deps);
    const redeliveryBeforeRelease = await Promise.race([
      redelivery.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 20);
      }),
    ]);
    releaseToken({ ok: true, result: HIRED_TOKEN });
    const [completed, redelivered] = await Promise.all([
      reconciliation,
      redelivery,
    ]);

    assert.equal(
      redeliveryBeforeRelease,
      "pending",
      "redelivery must wait for the in-flight reconciliation of the same bot",
    );
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(redelivered.status, "ignored");
    assert.equal(ownerNotices.length, 1, "duplicate owner notification");
    assert.equal(hiredBots.length, 1, "duplicate colleague startup");
    assert.equal(tokenCalls, 2, "redelivery must not query Bot API again");
    const finalState = JSON.parse(
      readFileSync(join(hireStateDir, `${HIRED_BOT_ID}.json`), "utf8"),
    ) as { phase?: string; updateId?: number };
    assert.equal(finalState.phase, "completed");
    assert.equal(finalState.updateId, 1260);
    const profileCallsBeforeRedelivery = profileCalls.length;
    assert.equal(profileCallsBeforeRedelivery, 3);
    const again = await handleManagedBotUpdate(update, deps);
    assert.equal(again.status, "ignored");
    assert.equal(
      profileCalls.length,
      profileCallsBeforeRedelivery,
      "profile writes must not grow after completed redelivery",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 arbiter token-stage write failure: reconciliation reuses the token already stored in .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-token-write-failure-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  mkdirSync(hireStateDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(
      join(hireStateDir, `${HIRED_BOT_ID}.json`),
      JSON.stringify({
        version: 1,
        phase: "token",
        botId: HIRED_BOT_ID,
        ownerUserId: "42",
        updateId: 1270,
        role: "critic",
        provider: "ollama",
        model: "critic-model",
        name: "Критик",
        username: "iva_main_critic_bot",
        attempts: 3,
        nextRetryAt: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    );
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    let tokenCalls = 0;
    const ownerNotices: string[] = [];
    const tgImpl = (method: string) => {
      if (method === "getManagedBotToken") {
        tokenCalls += 1;
        return Promise.resolve({ ok: true, result: HIRED_TOKEN });
      }
      return Promise.resolve({ ok: true, result: true });
    };
    const deps = {
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      hireStateDir,
      now: () => 1_700_000_601_100,
      tgImpl,
      replyImpl: (_chatId: number | string, text: string) => {
        ownerNotices.push(text);
        return Promise.resolve({ message_id: 1 });
      },
      lang: () => "ru" as const,
      logImpl: () => {},
    };

    chmodSync(hireStateDir, 0o500);
    const failedWrite = await reconcilePendingColleagueHires(deps);
    assert.deepEqual(failedWrite, { attempted: 1, completed: 0 });
    assert.equal(tokenCalls, 1);
    assert.ok(
      parseEnvText(
        readFileSync(localEnvPath, "utf8"),
      ).TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(HIRED_TOKEN),
      "first reconciliation must leave the fetched token in .env",
    );

    chmodSync(hireStateDir, 0o700);
    const completed = await reconcilePendingColleagueHires(deps);
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    assert.equal(
      tokenCalls,
      1,
      "token phase with a configured token must not query getManagedBotToken again",
    );
    const finalState = JSON.parse(
      readFileSync(join(hireStateDir, `${HIRED_BOT_ID}.json`), "utf8"),
    ) as { phase?: string; role?: string; model?: string; name?: string };
    assert.equal(finalState.phase, "completed");
    assert.equal(finalState.role, "critic");
    assert.equal(finalState.model, "critic-model");
    assert.equal(finalState.name, "Критик");
    assert.equal(ownerNotices.length, 1);
  } finally {
    chmodSync(hireStateDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 profile 401: a failed refresh is retried before the next profile write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-profile-401-"));
  const settingsFile = join(dir, "settings.json");
  const envPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(envPath);
  try {
    const env = { TELEGRAM_BOT_TOKEN: IVA_TOKEN, MODEL_PROVIDER: "ollama" };
    let at = 1_700_000_000_100;
    let tokenCalls = 0;
    let oldProfileCalls = 0;
    const deps = {
      allowedUserIds: new Set(["42"]),
      primaryBotToken: IVA_TOKEN,
      env,
      envPath,
      settingsFile,
      hireStateDir,
      now: () => at,
      lang: () => "ru" as const,
      logImpl: () => {},
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      tgImpl: (
        method: string,
        _body: Record<string, unknown>,
        options?: { token?: string },
      ) => {
        if (method === "getManagedBotToken") {
          tokenCalls += 1;
          if (tokenCalls === 2)
            return Promise.resolve({ ok: false, error_code: 503 });
          return Promise.resolve({
            ok: true,
            result: tokenCalls === 1 ? HIRED_TOKEN : ROTATED_HIRED_TOKEN,
          });
        }
        if (method.startsWith("setMy") && options?.token === HIRED_TOKEN) {
          oldProfileCalls += 1;
          return Promise.resolve({
            ok: false,
            error_code: at === 1_700_000_000_100 ? 503 : 401,
          });
        }
        return Promise.resolve({ ok: true });
      },
    };
    const first = await handleManagedBotUpdate(
      makeManagedHireUpdate(1271, HIRED_BOT_ID, "iva_main_critic_bot"),
      deps,
    );
    assert.equal(first.status, "failed");

    at += 31_000;
    assert.deepEqual(await reconcilePendingColleagueHires(deps), {
      attempted: 1,
      completed: 0,
    });
    assert.equal(tokenCalls, 2);
    const staleWrites = oldProfileCalls;
    assert.ok(staleWrites > 3, "the first reconciliation must see the 401");

    at += 121_000;
    assert.deepEqual(await reconcilePendingColleagueHires(deps), {
      attempted: 1,
      completed: 1,
    });
    assert.equal(tokenCalls, 3);
    assert.equal(oldProfileCalls, staleWrites);
    const after = parseEnvText(readFileSync(envPath, "utf8"));
    assert.equal(
      after.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(ROTATED_HIRED_TOKEN),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T940 rotated token survives a lost phase write and is reused from disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-rotated-write-"));
  const settingsFile = join(dir, "settings.json");
  const envPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  const stateFile = join(hireStateDir, `${HIRED_BOT_ID}.json`);
  writeHireTestEnv(envPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  try {
    writeFileSync(
      settingsFile,
      JSON.stringify(
        withColleague(withColleaguesEnabled({}, true), {
          botId: HIRED_BOT_ID,
          role: "critic",
          provider: "ollama",
          model: "critic-model",
          avatarPhase: "set",
        }),
      ),
    );
    const env = { TELEGRAM_BOT_TOKEN: IVA_TOKEN, MODEL_PROVIDER: "ollama" };
    let tokenCalls = 0;
    let available = false;
    const at = 1_700_000_000_100;
    const deps = {
      env,
      envPath,
      settingsFile,
      hireStateDir,
      allowedUserIds: new Set(["42"]),
      primaryBotToken: IVA_TOKEN,
      now: () => at,
      lang: () => "ru" as const,
      logImpl: () => {},
      tgImpl: (
        method: string,
        _body: Record<string, unknown>,
        options?: { token?: string },
      ) => {
        if (method === "getManagedBotToken") {
          tokenCalls += 1;
          return Promise.resolve(
            available
              ? { ok: true, result: ROTATED_HIRED_TOKEN }
              : { ok: false, error_code: 503 },
          );
        }
        if (
          method.startsWith("setMy") &&
          options?.token !== ROTATED_HIRED_TOKEN
        ) {
          return Promise.resolve({ ok: false, error_code: 401 });
        }
        return Promise.resolve({ ok: true });
      },
      replyImpl: () => Promise.resolve({ message_id: 1 }),
    };
    const failure = await handleManagedBotUpdate(
      makeManagedHireUpdate(1272, HIRED_BOT_ID, "iva_main_critic_bot"),
      deps,
    );
    assert.equal(failure.status, "failed");
    available = true;
    const due = at + 31_000;
    const rotatedOnDisk = () =>
      parseEnvText(
        readFileSync(envPath, "utf8"),
      ).TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(ROTATED_HIRED_TOKEN);
    const failedWrite = await reconcilePendingColleagueHires({
      ...deps,
      now: () => {
        if (rotatedOnDisk()) chmodSync(hireStateDir, 0o500);
        return due;
      },
    });
    assert.deepEqual(failedWrite, { attempted: 1, completed: 0 });
    assert.equal(rotatedOnDisk(), true);
    assert.equal(tokenCalls, 2);

    chmodSync(hireStateDir, 0o700);
    assert.deepEqual(
      await reconcilePendingColleagueHires({
        ...deps,
        env: { TELEGRAM_BOT_TOKEN: IVA_TOKEN, MODEL_PROVIDER: "ollama" },
        now: () => due,
      }),
      { attempted: 1, completed: 1 },
    );
    assert.equal(
      tokenCalls,
      2,
      "a fresh environment must reuse the rotated token",
    );
    const finalState = JSON.parse(readFileSync(stateFile, "utf8")) as {
      phase?: string;
    };
    assert.equal(finalState.phase, "completed");
  } finally {
    chmodSync(hireStateDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("последний круг A: successful token response without a token is terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-empty-token-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath);
  try {
    const logs: string[] = [];
    const outcome = await handleManagedBotUpdate(
      makeManagedHireUpdate(1040, HIRED_BOT_ID, "iva_main_critic_bot"),
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        env: {
          TELEGRAM_BOT_TOKEN: IVA_TOKEN,
          TELEGRAM_BOT_USERNAME: "iva_main_bot",
        },
        tgImpl: () => Promise.resolve({ ok: true, result: {} }),
        logImpl: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      },
    );
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.retry, false);
    assert.ok(
      logs.some(
        (line) => line.includes("update_id=1040") && line.includes("terminal"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("последний круг B1: incomplete hire does not start polling after restart and is completed without a repeated event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-durable-profile-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    let settings = withColleaguesEnabled({}, true);
    settings = withColleagueHireProposal(
      settings,
      {
        botUsername: "iva_main_critic_bot",
        role: "critic",
        provider: "openrouter",
        model: "critic-model",
        name: "Критик",
      },
      1_700_000_000_000,
    );
    writeFileSync(localSettings, JSON.stringify(settings), { mode: 0o600 });
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    let profileAttempts = 0;
    const first = await handleManagedBotUpdate(
      makeManagedHireUpdate(1020, HIRED_BOT_ID, "iva_main_critic_bot"),
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        env: localEnv,
        hireStateDir,
        now: () => 1_700_000_000_100,
        tgImpl: (method) => {
          if (method === "getManagedBotToken") {
            return Promise.resolve({ ok: true, result: HIRED_TOKEN });
          }
          if (method === "setMyName") {
            profileAttempts += 1;
            return Promise.resolve({
              ok: false,
              error_code: 503,
              description: "Bot API temporarily unavailable",
            });
          }
          return Promise.resolve({ ok: true, result: true });
        },
        applyAvatarImpl: () => Promise.resolve(successfulAvatar),
        replyImpl: () => Promise.resolve({ message_id: 1 }),
        lang: () => "ru",
        logImpl: () => {},
      },
    );
    assert.equal(first.status, "failed");
    if (first.status === "failed") assert.equal(first.retry, true);
    assert.equal(profileAttempts, 1);
    assert.equal(
      parseColleaguesConfig(
        JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
        () => {},
      ).items[HIRED_BOT_ID],
      undefined,
    );

    // Перезапуск: токен уже в .env, а записи роли ещё нет. Стартовый выбор ботов
    // обязан отложить такой незавершённый найм, а не начать опрос по одному токену.
    const envLine = parseEnvText(
      readFileSync(localEnvPath, "utf8"),
    ).TELEGRAM_COLLEAGUE_BOT_TOKENS;
    assert.ok(envLine?.includes(HIRED_TOKEN));
    const restartedEnv = {
      ...localEnv,
      TELEGRAM_COLLEAGUE_BOT_TOKENS: envLine,
    };
    const configured = configuredTelegramBots(restartedEnv);
    const mainModule =
      (await import("./poller/main.ts")) as typeof import("./poller/main.ts") & {
        selectStartupColleagueBots?: (
          bots: TelegramBotConfig[],
          settingsFile?: string,
        ) => TelegramBotConfig[];
      };
    assert.equal(typeof mainModule.selectStartupColleagueBots, "function");
    const startupColleagues = mainModule.selectStartupColleagueBots?.(
      configured,
      localSettings,
    );
    assert.deepEqual(startupColleagues, []);

    // Даже если токен незавершённого найма случайно попал в цикл напрямую,
    // сам цикл обязан ждать complete-записи роли/модели, а не опрашивать Telegram.
    const incompleteBot = configured.find((bot) => bot.botId === HIRED_BOT_ID);
    assert.ok(incompleteBot);
    let prematurePolls = 0;
    let loopChecks = 0;
    await runBotPollLoop({
      bot: incompleteBot,
      initialOffset: 0,
      assertLease: () => {},
      colleaguesEnabledImpl: () => true,
      tgImpl: (method) => {
        if (method === "getUpdates") prematurePolls += 1;
        return Promise.resolve({ ok: true, result: [] });
      },
      sleepImpl: () => Promise.resolve(),
      shouldContinue: () => {
        loopChecks += 1;
        return loopChecks <= 2;
      },
      logImpl: () => {},
    });
    assert.equal(prematurePolls, 0);

    const managedModule =
      (await import("./poller/managed-bot.ts")) as typeof import("./poller/managed-bot.ts") & {
        reconcilePendingColleagueHires?: (
          deps?: Record<string, unknown>,
        ) => Promise<{
          attempted: number;
          completed: number;
        }>;
      };
    assert.equal(
      typeof managedModule.reconcilePendingColleagueHires,
      "function",
    );
    const hiredBots: TelegramBotConfig[] = [];
    const ownerNotices: string[] = [];
    const completed = await managedModule.reconcilePendingColleagueHires?.({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: restartedEnv,
      hireStateDir,
      now: () => 1_700_000_060_100,
      tgImpl: (method: string) =>
        Promise.resolve(
          method === "getManagedBotToken"
            ? { ok: true, result: HIRED_TOKEN }
            : { ok: true, result: true },
        ),
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: (_chatId: number | string, text: string) => {
        ownerNotices.push(text);
        return Promise.resolve({ message_id: 1 });
      },
      onColleagueHired: (bot: TelegramBotConfig) => hiredBots.push(bot),
      lang: () => "ru",
      logImpl: () => {},
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    const cfg = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
    assert.equal(cfg.items[HIRED_BOT_ID]?.provider, "openrouter");
    assert.equal(cfg.items[HIRED_BOT_ID]?.model, "critic-model");
    assert.equal(hiredBots.length, 1);
    assert.equal(ownerNotices.length, 1);
    assert.equal(
      mainModule.selectStartupColleagueBots?.(configured, localSettings).length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("последний круг B2: settings failure is consumed without losing the hire and never turns a disabled existing colleague on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-durable-settings-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  const hireStateDir = join(dir, "colleague-hires.d");
  writeHireTestEnv(localEnvPath);
  try {
    let settings = withColleaguesEnabled({}, false);
    settings = withColleague(settings, {
      botId: HIRED_BOT_ID,
      role: "critic",
      provider: "ollama",
      model: "critic-model",
      name: "Критик",
      username: "iva_main_critic_bot",
      avatarPhase: "set",
    });
    const validSettings = JSON.stringify(settings);
    writeFileSync(localSettings, validSettings, { mode: 0o600 });
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    const outcome = await handleManagedBotUpdate(
      makeManagedHireUpdate(1030, HIRED_BOT_ID, "iva_main_critic_bot"),
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        env: localEnv,
        hireStateDir,
        now: () => 1_700_000_000_100,
        tgImpl: (method) => {
          if (method === "getManagedBotToken") {
            return Promise.resolve({ ok: true, result: HIRED_TOKEN });
          }
          if (method === "setMyShortDescription") {
            writeFileSync(localSettings, "{ corrupted settings", {
              mode: 0o600,
            });
          }
          return Promise.resolve({ ok: true, result: true });
        },
        applyAvatarImpl: () => Promise.resolve(successfulAvatar),
        replyImpl: () => Promise.resolve({ message_id: 1 }),
        lang: () => "ru",
        logImpl: () => {},
      },
    );
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.equal(
        outcome.retry,
        false,
        "corrupt settings must not pin the whole Telegram ingress forever",
      );
    }

    // Владелец чинит settings.json явно. Фоновая сверка доводит найм по durable
    // состоянию, но повтор не включёт опцию, которую владелец держал выключенной.
    writeFileSync(localSettings, validSettings, { mode: 0o600 });
    const managedModule =
      (await import("./poller/managed-bot.ts")) as typeof import("./poller/managed-bot.ts") & {
        reconcilePendingColleagueHires?: (
          deps?: Record<string, unknown>,
        ) => Promise<{
          attempted: number;
          completed: number;
        }>;
      };
    assert.equal(
      typeof managedModule.reconcilePendingColleagueHires,
      "function",
    );
    const completed = await managedModule.reconcilePendingColleagueHires?.({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      hireStateDir,
      now: () => 1_700_000_060_100,
      tgImpl: () => Promise.resolve({ ok: true, result: true }),
      applyAvatarImpl: () => Promise.resolve(successfulAvatar),
      replyImpl: () => Promise.resolve({ message_id: 1 }),
      lang: () => "ru",
      logImpl: () => {},
    });
    assert.deepEqual(completed, { attempted: 1, completed: 1 });
    const cfg = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    );
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.items[HIRED_BOT_ID]?.role, "critic");
    assert.equal(cfg.items[HIRED_BOT_ID]?.model, "critic-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("последний круг C: colleague token is redacted from polling initialization errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-init-log-redaction-"));
  const localEnvPath = join(dir, ".env");
  writeHireTestEnv(localEnvPath, `iva_main_critic_bot=${HIRED_TOKEN}`);
  const previousEnvFile = process.env.IVA_ENV_FILE;
  try {
    process.env.IVA_ENV_FILE = localEnvPath;
    const { lease } = await tempLease(t);
    const logs: string[] = [];
    let initCalls = 0;
    const tgStub = (method: string) => {
      if (method === "deleteWebhook") {
        return Promise.resolve({
          ok: false,
          description: `deleteWebhook failed upstream echoed ${HIRED_TOKEN}`,
        });
      }
      return Promise.resolve({ ok: true, result: true });
    };
    await runBotPollLoop({
      bot: {
        botId: HIRED_BOT_ID,
        token: HIRED_TOKEN,
        username: "iva_main_critic_bot",
        isPrimary: false,
      },
      initialOffset: 0,
      assertLease: () => assertTelegramProcessLease(lease),
      colleaguesEnabledImpl: () => true,
      colleagueCompleteImpl: () => true,
      initializeOffsetImpl: async () => {
        initCalls += 1;
        const response = (await tgStub("deleteWebhook")) as {
          ok: boolean;
          description?: string;
        };
        if (!response.ok) {
          throw new Error(`deleteWebhook failed: ${response.description}`);
        }
        return 0;
      },
      tgImpl: tgStub,
      sleepImpl: () => Promise.resolve(),
      shouldContinue: () => initCalls < 1,
      logImpl: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    });
    assert.equal(initCalls, 1);
    assert.equal(
      logs.join("\n").includes(HIRED_TOKEN),
      false,
      `initialization log leaked token:\n${logs.join("\n")}`,
    );
  } finally {
    if (previousEnvFile === undefined) delete process.env.IVA_ENV_FILE;
    else process.env.IVA_ENV_FILE = previousEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Пункт 3: Аватарка — случайный талисман ip-as-logo, JPG 640×640;
//     библиотека недоступна — бот без фото и повтор позже ---
test("п.3a: random ip-as-logo talisman converts to 640x640 JPG without role filter and uploads via setMyProfilePhoto", async () => {
  const rpcBodies: Record<string, unknown>[] = [];
  let uploadedBytes: Buffer | null = null;
  let uploadedMeta: Record<string, unknown> | null = null;

  const stubFetch = createIpAsLogoStubFetch({
    available: true,
    onRpcBody: (body) => rpcBodies.push(body),
    onPhotoUpload: ({ photoMeta, avatarBytes }) => {
      uploadedMeta = photoMeta;
      uploadedBytes = avatarBytes;
    },
  });

  const outcome = await applyRandomColleagueAvatar(SECOND_TOKEN, {
    fetchImpl: stubFetch,
    random: () => 0.75,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.logo.id, 888);
  assert.equal(outcome.logo.name, "Cosmic Fox");
  // Strictly random: empty p_search and p_sort="random" (no role coupling!).
  assert.equal(rpcBodies.length, 1);
  assert.equal(rpcBodies[0]?.p_search, "");
  assert.equal(rpcBodies[0]?.p_category, "all");
  assert.equal(rpcBodies[0]?.p_sort, "random");
  // Uploaded image is genuine 640x640 JPEG.
  assert.deepEqual(uploadedMeta, { type: "static", photo: "attach://avatar" });
  assert.ok(uploadedBytes !== null);
  assert.equal(uploadedBytes[0], 0xff);
  assert.equal(uploadedBytes[1], 0xd8);
  assert.deepEqual(jpegDimensions(uploadedBytes), {
    width: 640,
    height: 640,
  });

  // Also test converter failure falls back cleanly across local converters.
  await assert.rejects(
    () =>
      convertPngToJpeg640(SAMPLE_PNG, {
        runConverter: () => Promise.reject(new Error("missing binary")),
      }),
    /no image converter produced 640x640 JPEG/u,
  );
});

test("п.3b: when ip-as-logo is unavailable, colleague is hired without photo and later retry sets the avatar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-avatar-retry-"));
  const localSettings = join(dir, "settings.json");
  const localEnvPath = join(dir, ".env");
  writeFileSync(
    localEnvPath,
    `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}\nTELEGRAM_BOT_USERNAME=iva_main_bot\n`,
    { mode: 0o600 },
  );
  const localEnv: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: IVA_TOKEN,
    TELEGRAM_BOT_USERNAME: "iva_main_bot",
    MODEL_PROVIDER: "ollama",
  };
  let clock = 1_700_000_000_000;
  let libraryUp = false;
  let uploadedCount = 0;

  const toggleableFetch: typeof fetch = (input, init) =>
    createIpAsLogoStubFetch({
      available: libraryUp,
      onPhotoUpload: ({ avatarBytes }) => {
        uploadedCount += 1;
        assert.deepEqual(jpegDimensions(avatarBytes), {
          width: 640,
          height: 640,
        });
      },
    })(input, init);

  try {
    const ownerNotices: string[] = [];
    const hired = await handleManagedBotUpdate(
      {
        update_id: 950,
        managed_bot: {
          user: { id: 42, is_bot: false },
          bot: {
            id: Number(SECOND_BOT_ID),
            is_bot: true,
            first_name: "Секретарь",
            username: "iva_sec_bot",
          },
        },
      },
      {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: localEnvPath,
        settingsFile: localSettings,
        env: localEnv,
        tgImpl: (method) =>
          Promise.resolve(
            method === "getManagedBotToken"
              ? { ok: true, result: SECOND_TOKEN }
              : { ok: true, result: true },
          ),
        replyImpl: (_chatId, text) => {
          ownerNotices.push(text);
          return Promise.resolve({ message_id: 1 });
        },
        avatarDeps: { fetchImpl: toggleableFetch, random: () => 0.2 },
        now: () => clock,
        lang: () => "ru",
        logImpl: () => {},
      },
    );

    // Bot is hired and usable even though ip-as-logo returned 503!
    assert.equal(hired.status, "hired");
    assert.equal(hired.avatarSet, false);
    assert.equal(uploadedCount, 0);
    assert.match(ownerNotices[0] ?? "", /без фото/u);

    const beforeRetry = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    ).items[SECOND_BOT_ID];
    assert.equal(colleagueAvatarPhase(beforeRetry), "retry");
    assert.equal(beforeRetry?.avatarAttempts, 1);
    const dueAt = beforeRetry?.avatarNextRetryAt ?? 0;
    assert.ok(dueAt > clock);

    // Before backoff expires -> retry loop does nothing.
    const tooEarly = await reconcilePendingColleagueAvatars({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      avatarDeps: { fetchImpl: toggleableFetch, random: () => 0.2 },
      now: () => dueAt - 1,
      logImpl: () => {},
    });
    assert.deepEqual(tooEarly, { attempted: 0, succeeded: 0 });

    // Library recovers and backoff expires -> retry sets avatar and moves phase to "set".
    libraryUp = true;
    clock = dueAt + 1000;
    const retried = await reconcilePendingColleagueAvatars({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      avatarDeps: { fetchImpl: toggleableFetch, random: () => 0.2 },
      now: () => clock,
      logImpl: () => {},
    });
    assert.deepEqual(retried, { attempted: 1, succeeded: 1 });
    assert.equal(uploadedCount, 1);

    const afterRetry = parseColleaguesConfig(
      JSON.parse(readFileSync(localSettings, "utf8")) as unknown,
      () => {},
    ).items[SECOND_BOT_ID];
    assert.equal(colleagueAvatarPhase(afterRetry), "set");
    assert.equal(afterRetry?.avatarLogoId, 777);

    // Subsequent reconcile pass skips already-set colleague.
    const settled = await reconcilePendingColleagueAvatars({
      settingsFile: localSettings,
      envPath: localEnvPath,
      env: localEnv,
      avatarDeps: { fetchImpl: toggleableFetch, random: () => 0.2 },
      now: () => clock + 3_600_000,
      logImpl: () => {},
    });
    assert.deepEqual(settled, { attempted: 0, succeeded: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Пункт 4: Токен коллеги не попадает в журналы и исходящие сообщения ---
test("п.4: colleague token is inventoried in outbound-sensitive-keys.json and redacted from logs, errors, and outbound messages", async () => {
  // 1. Key is in outbound-sensitive-keys.json.
  assert.ok(
    secretKeyInventory.includes("TELEGRAM_COLLEAGUE_BOT_TOKENS"),
    "TELEGRAM_COLLEAGUE_BOT_TOKENS must be in outbound-sensitive-keys.json",
  );

  // 2. Write a colleague token (including a non-standard short-tail secret that generic regex wouldn't catch!)
  //    into .env and verify scanOutbound, redactNotice, and secretValuesFromEnv all catch it.
  const customColleagueToken = "777777777:ShortColleagueSecret123";
  const dir = mkdtempSync(join(tmpdir(), "iva-token-leak-"));
  const leakEnvPath = join(dir, ".env");
  const leakSettings = join(dir, "settings.json");
  const prevEnvFile = process.env.IVA_ENV_FILE;
  try {
    writeFileSync(
      leakEnvPath,
      [
        `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}`,
        `TELEGRAM_COLLEAGUE_BOT_TOKENS=sec_bot=${customColleagueToken},other_bot=${SECOND_TOKEN}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    process.env.IVA_ENV_FILE = leakEnvPath;

    const live = liveTelegramEnv(process.env, leakEnvPath);
    assert.ok(
      live.TELEGRAM_COLLEAGUE_BOT_TOKENS?.includes(customColleagueToken),
    );

    for (const carrier of [
      `token=${customColleagueToken}`,
      `https://api.telegram.org/bot${customColleagueToken}/sendMessage`,
      `TELEGRAM_COLLEAGUE_BOT_TOKENS=sec_bot=${customColleagueToken}`,
      encodeURIComponent(customColleagueToken),
      Buffer.from(customColleagueToken).toString("base64"),
      `plain ${SECOND_TOKEN}`,
    ]) {
      const gated = scanOutbound(carrier);
      assert.equal(gated.clean, false, `outbound gate missed: ${carrier}`);
      assert.equal(gated.text.includes(customColleagueToken), false);
      assert.equal(gated.text.includes(SECOND_TOKEN), false);

      const noticeGated = redactNotice(carrier);
      assert.equal(noticeGated.includes(customColleagueToken), false);
      assert.equal(noticeGated.includes(SECOND_TOKEN), false);

      const envSecrets = secretValuesFromEnv({
        TELEGRAM_COLLEAGUE_BOT_TOKENS: `sec_bot=${customColleagueToken},other_bot=${SECOND_TOKEN}`,
      });
      const logRedacted = redact(carrier, envSecrets);
      assert.equal(logRedacted.includes(customColleagueToken), false);
      assert.equal(logRedacted.includes(SECOND_TOKEN), false);
    }

    // 3. Even when Telegram API / avatar errors echo the colleague token back verbatim,
    //    handleManagedBotUpdate never logs it, never stores it in settings.json, and never sends it to owner!
    const logs: string[] = [];
    const notices: string[] = [];
    const localEnv: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: IVA_TOKEN,
      TELEGRAM_BOT_USERNAME: "iva_main_bot",
      MODEL_PROVIDER: "ollama",
    };
    writeFileSync(
      leakEnvPath,
      `TELEGRAM_BOT_TOKEN=${IVA_TOKEN}\nTELEGRAM_BOT_USERNAME=iva_main_bot\n`,
      { mode: 0o600 },
    );
    const managedUpdate = {
      update_id: 999,
      managed_bot: {
        user: { id: 42, is_bot: false },
        bot: {
          id: 777777777,
          is_bot: true,
          first_name: "Критик",
          username: "leak_test_bot",
        },
      },
    };
    let profileCalls = 0;
    const runHire = () =>
      handleManagedBotUpdate(managedUpdate, {
        allowedUserIds: new Set(["42"]),
        primaryBotId: IVA_BOT_ID,
        primaryBotToken: IVA_TOKEN,
        envPath: leakEnvPath,
        settingsFile: leakSettings,
        env: localEnv,
        tgImpl: (method) => {
          if (method === "getManagedBotToken") {
            return Promise.resolve({ ok: true, result: customColleagueToken });
          }
          if (
            method === "setMyName" ||
            method === "setMyDescription" ||
            method === "setMyShortDescription"
          ) {
            profileCalls += 1;
            if (profileCalls <= 3) {
              return Promise.resolve({
                ok: false,
                description: `upstream echoed ${customColleagueToken} and ${IVA_TOKEN}`,
              });
            }
          }
          return Promise.resolve({ ok: true, result: true });
        },
        replyImpl: (_chatId, text) => {
          notices.push(text);
          return Promise.resolve({ message_id: 1 });
        },
        applyAvatarImpl: (tok) =>
          Promise.resolve({
            ok: false,
            error: `avatar failed for https://api.telegram.org/bot${tok}/setMyProfilePhoto`,
          }),
        logImpl: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      });
    const firstOutcome = await runHire();
    assert.equal(firstOutcome.status, "failed");
    const outcome = await runHire();
    assert.equal(outcome.status, "hired");
    const allLogs = logs.join("\n");
    const allNotices = notices.join("\n");
    const settingsText = readFileSync(leakSettings, "utf8");
    assert.equal(
      allLogs.includes(customColleagueToken),
      false,
      "token leaked into logs",
    );
    assert.equal(
      allLogs.includes(IVA_TOKEN),
      false,
      "primary token leaked into logs",
    );
    assert.equal(
      allNotices.includes(customColleagueToken),
      false,
      "token leaked into reply",
    );
    assert.equal(
      settingsText.includes(customColleagueToken),
      false,
      "token leaked into settings.json",
    );
  } finally {
    if (prevEnvFile === undefined) delete process.env.IVA_ENV_FILE;
    else process.env.IVA_ENV_FILE = prevEnvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pure token upsert/remove helper round-trip checks.
test("upsertColleagueBotToken and removeColleagueBotToken maintain clean .env lists", () => {
  const a = upsertColleagueBotToken(
    undefined,
    { token: HIRED_TOKEN, username: "critic_bot" },
    IVA_BOT_ID,
  );
  assert.equal(a, `critic_bot=${HIRED_TOKEN}`);
  const b = upsertColleagueBotToken(
    a,
    { token: SECOND_TOKEN, username: "sec_bot" },
    IVA_BOT_ID,
  );
  assert.equal(b, `critic_bot=${HIRED_TOKEN},sec_bot=${SECOND_TOKEN}`);
  // Replacing token for existing botId updates in place without duplicates.
  const rotated = `${HIRED_BOT_ID}:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ`;
  const c = upsertColleagueBotToken(b, { token: rotated }, IVA_BOT_ID);
  assert.equal(c, `critic_bot=${rotated},sec_bot=${SECOND_TOKEN}`);
  const d = removeColleagueBotToken(c, HIRED_BOT_ID, IVA_BOT_ID);
  assert.equal(d, `sec_bot=${SECOND_TOKEN}`);
  assert.throws(
    () => upsertColleagueBotToken(d, { token: IVA_TOKEN }, IVA_BOT_ID),
    /matches primary/u,
  );
});

// Verify primary poll loop passes "managed_bot" in allowed_updates.
test("primary runBotPollLoop subscribes to managed_bot in allowed_updates", async (t) => {
  const { lease } = await tempLease(t);
  const seenAllowed: unknown[] = [];
  const primaryBot: TelegramBotConfig = {
    botId: IVA_BOT_ID,
    token: IVA_TOKEN,
    username: "iva_main_bot",
    isPrimary: true,
  };
  let calls = 0;
  await runBotPollLoop({
    bot: primaryBot,
    initialOffset: 10,
    assertLease: () => assertTelegramProcessLease(lease),
    tgImpl: (method, body) => {
      if (method === "getUpdates") {
        seenAllowed.push(
          (body as { allowed_updates?: unknown }).allowed_updates,
        );
        calls += 1;
      }
      return Promise.resolve({ ok: true, result: [] });
    },
    sleepImpl: () => Promise.resolve(),
    shouldContinue: () => calls < 1,
    logImpl: () => {},
  });
  assert.equal(seenAllowed.length, 1);
  assert.ok(
    Array.isArray(seenAllowed[0]) && seenAllowed[0].includes("managed_bot"),
    `primary getUpdates missing managed_bot: ${JSON.stringify(seenAllowed[0])}`,
  );

  // Check enqueueQueueFile still accepts regular updates cleanly after schema update.
  const dir = mkdtempSync(join(tmpdir(), "iva-hire-q-"));
  try {
    const qFile = join(dir, "q.json");
    await enqueueQueueFile(
      qFile,
      "42:",
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1_700_000_000,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false },
          text: "ping",
        },
      },
      { strict: true },
    );
    assert.ok(existsSync(qFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("colleague config stays disabled by default even after hiring proposals exist", () => {
  const proposed = withColleaguesEnabled({}, false);
  const cfg = parseColleaguesConfig(proposed, () => {});
  assert.equal(cfg.enabled, false);
});
