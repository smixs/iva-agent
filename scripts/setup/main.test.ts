/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns the registrations. */
// Характеризация мастера установки как процесса: настоящий scripts/setup/main.ts, ответы по
// сценарию, конфигурация во временной папке, сеть подменена фикстурой. Полный протокол
// диалога сверяется с эталоном в scripts/fixtures/setup-wizard/: вопросы, их порядок,
// значения по умолчанию и то, что Enter оставляет текущее значение. Разрез мастера на шаги
// обязан пройти этот тест без правки эталона.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FETCH_FIXTURE = fileURLToPath(
  new URL("../fixtures/setup-wizard-fetch.ts", import.meta.url),
);
// Эталон протокола. `WRITE_GOLDEN=1` переписывает его текущим поведением — только осознанно,
// когда вопрос мастера меняется намеренно.
function assertGolden(name: string, actual: string): void {
  const path = fileURLToPath(
    new URL(`../fixtures/setup-wizard/${name}.txt`, import.meta.url),
  );
  if (process.env.WRITE_GOLDEN === "1") writeFileSync(path, actual);
  assert.equal(actual, readFileSync(path, "utf8"));
}

type WizardResult = {
  readonly transcript: string;
  readonly candidate: string | null;
};

async function freePort(): Promise<number> {
  const listener = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "0.0.0.0", () =>
      resolve((listener.address() as net.AddressInfo).port),
    );
  });
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

// Протокол без цветов, с ответами в строке вопроса и портом под именем: порт берётся свободный
// при каждом запуске.
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "gu");

// Случайные секреты мастера заменяются раньше порта: в них могут встретиться его цифры.
function normalise(text: string, port: number): string {
  return text
    .replace(/^(ASSISTANT_BEARER)=(?!b{43}$)\S{43}$/mu, "$1=<BEARER>")
    .replace(/^(TELEGRAM_WEBHOOK_SECRET_TOKEN)=[0-9a-f]{48}$/mu, "$1=<SECRET>")
    .replace(ANSI_COLOUR, "")
    .replaceAll(String(port), "<PORT>");
}

async function driveWizard(
  t: TestContext,
  options: {
    readonly source: string | null;
    readonly answers: readonly string[];
    readonly port: number;
    readonly language?: string;
    readonly stopAt?: RegExp;
  },
): Promise<WizardResult> {
  const root = await mkdtemp(join(tmpdir(), "iva-setup-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "source.env");
  const candidate = join(root, "candidate.env");
  if (options.source === DIRECTORY) mkdirSync(input);
  else if (options.source !== null) writeFileSync(input, options.source);
  const child = spawn(
    process.execPath,
    ["--import", FETCH_FIXTURE, join(REPO, "scripts/setup/main.ts")],
    {
      cwd: REPO,
      // Свой сеанс без управляющего терминала: мастер читает ответы из stdin, а не из /dev/tty.
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        IVA_CONFIG_INPUT: input,
        IVA_CONFIG_OUTPUT: candidate,
        IVA_CONFIG_STAGING: "1",
        ...(options.language ? { AGENT_LANGUAGE: options.language } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let transcript = "";
  let next = 0;
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      transcript += text;
      if (options.stopAt?.test(transcript)) {
        child.kill("SIGKILL");
        return;
      }
      // Вопрос — это запись, оканчивающаяся на ": " (строки console.log кончаются переводом).
      if (text.endsWith(": ") && next < options.answers.length) {
        const answer = options.answers[next];
        next += 1;
        transcript += `${answer}⏎\n`;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      transcript += `[stderr] ${chunk.toString()}`;
    });
    child.on("close", () => resolve());
  });
  clearTimeout(timer);
  return {
    transcript: normalise(transcript, options.port),
    candidate: existsSync(candidate)
      ? normalise(readFileSync(candidate, "utf8"), options.port)
      : null,
  };
}

const DIRECTORY = "\0directory";
const BEARER = `ASSISTANT_BEARER=${"b".repeat(43)}`;

function completeOpencode(port: number): string {
  return [
    "AGENT_LANGUAGE=en",
    "MODEL_PROVIDER=opencode",
    "OPENCODE_API_KEY=oc-key-123456",
    "OPENCODE_MODEL=deepseek-v4-pro",
    "OPENCODE_VISION_MODEL=deepseek-v4-pro",
    "OPENCODE_CONTEXT_WINDOW=131072",
    "TELEGRAM_BOT_TOKEN=123:tg-token",
    "TELEGRAM_BOT_USERNAME=ivabot",
    "TELEGRAM_WEBHOOK_SECRET_TOKEN=hook-secret",
    "TELEGRAM_ALLOWED_USER_IDS=11,22",
    "TELEGRAM_DIGEST_CHAT_ID=11",
    "DEEPGRAM_LANGUAGE=multi",
    "SEARCH_PROVIDER=tavily",
    "MEMORY_SEARCH_MODE=grep",
    "ASSISTANT_TIMEZONE=Europe/Berlin",
    "ASSISTANT_VAULT_DIR=vault",
    "ASSISTANT_DATA_DIR=data",
    `IVA_PORT=${port}`,
    `ASSISTANT_HOST=http://127.0.0.1:${port}`,
    BEARER,
    "CUSTOM_EXTRA=kept",
    "",
  ].join("\n");
}

test("fresh setup: every question in order, defaults, and the written .env", async (t) => {
  const port = await freePort();
  const result = await driveWizard(t, {
    source: null,
    port,
    answers: [
      "1", // Language -> English
      "2", // Provider -> OpenCode
      "oc-key-123456", // OpenCode API key
      "", // Model number -> default
      "", // Text protocol -> chat-completions
      "", // Vision model number -> default
      "", // Vision protocol -> chat-completions
      "", // Deepgram key -> skip
      "", // Search provider -> tavily
      "", // tavily key -> skip
      "", // Enable hybrid memory? -> no
      "123:tg-token", // Bot token -> getMe says @ivabot
      "", // Sent the bot a message? -> getUpdates is refused by the fixture
      "42", // Telegram ID by hand
      "", // Timezone -> Asia/Almaty
      "", // Vault directory -> vault
      String(port), // eve-server port
    ],
  });
  assert.ok(result.candidate, result.transcript);
  assert.match(result.transcript, /Ready — settings validated for apply/);
  assertGolden("fresh.transcript", result.transcript);
  assertGolden("fresh.env", result.candidate ?? "");
});

test("reconfigure: Enter at every question keeps the current value", async (t) => {
  const port = await freePort();
  const source = completeOpencode(port);
  const result = await driveWizard(t, {
    source,
    port,
    language: "en",
    answers: [
      "y", // Reconfigure from scratch?
      "", // Provider -> current (OpenCode)
      "", // OpenCode API key -> keep
      "", // Model -> current
      "", // Text protocol -> current
      "", // Vision -> current
      "", // Vision protocol -> current
      "", // Deepgram -> skip
      "", // Search provider -> current
      "", // tavily key -> skip
      "", // hybrid -> no
      "", // Bot token -> keep
      "", // Timezone -> current
      "", // Vault -> current
      "", // Port -> current
    ],
  });
  assert.ok(result.candidate, result.transcript);
  assert.match(result.transcript, /Ready — settings validated for apply/);
  assertGolden("reconfigure.transcript", result.transcript);
  assertGolden("reconfigure.env", result.candidate ?? "");
});

test("complete configuration: one question, nothing written when nothing changed", async (t) => {
  const port = await freePort();
  const result = await driveWizard(t, {
    source: completeOpencode(port),
    port,
    language: "en",
    answers: ["n"],
  });
  assertGolden("keep.transcript", result.transcript);
  assert.equal(result.candidate, null);
});

test("Russian: «2.» picks Russian and «да» reconfigures", async (t) => {
  const port = await freePort();
  const result = await driveWizard(t, {
    source: completeOpencode(port).replace(
      "AGENT_LANGUAGE=en",
      "AGENT_LANGUAGE=ru",
    ),
    port,
    answers: ["2.", "да"],
    stopAt: /Провайдер \(1\/2\/3\/4\/5\/6\/7\) \[2\]: $/u,
  });
  assert.match(result.transcript, /Iva будет отвечать по-русски/u);
  assert.match(result.transcript, /Идём по шагам\./u);
  assert.equal(result.candidate, null);
});

test("failure: an unreadable source .env aborts the wizard with its reason", async (t) => {
  const port = await freePort();
  const result = await driveWizard(t, {
    // A directory in place of the file: reading it fails with EISDIR, not ENOENT.
    source: DIRECTORY,
    port,
    language: "en",
    answers: [],
  });
  assert.match(result.transcript, /\[stderr\] Настройка прервана: EISDIR/u);
  assert.equal(result.candidate, null);
});
