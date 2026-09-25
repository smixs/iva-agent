/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and async stubs preserve production signatures. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createConfigCommand } from "./config.ts";
import { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type RuntimeRun = CliRuntime["run"];

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function result(status: number | null): ReturnType<RuntimeRun> {
  return { status } as ReturnType<RuntimeRun>;
}

test("--recover preserves recovery ordering and never creates a setup candidate", async (t) => {
  const root = await sandbox(t);
  const events: unknown[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => {
      events.push("require-systemd");
    },
    ok: (message) => {
      events.push(["ok", message]);
    },
    run: () => {
      throw new Error("setup must not run during recovery-only mode");
    },
    systemd: {
      ...base.systemd,
      restart: (services) => {
        events.push(["restart", services]);
      },
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: (options) => {
        events.push(["write-units", options]);
        return [];
      },
    },
    {
      recoverConfigTransaction: async (target, options = {}) => {
        events.push(["recover", target]);
        await options.restart?.(target.services);
        return true;
      },
    },
  );

  await cmdConfig(["ignored", "--recover"]);

  assert.deepEqual(events, [
    "require-systemd",
    ["recover", { envPath: join(root, ".env"), services: runtime.SERVICES }],
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["ok", "Recovered the previous configuration and restarted services"],
  ]);
});

test("--recover reports an absent journal without touching setup or systemd", async (t) => {
  const root = await sandbox(t);
  const messages: string[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    ok: (message) => messages.push(message),
    run: () => {
      throw new Error("setup must not run during recovery-only mode");
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: () => {
        throw new Error("units must not change without a recovery journal");
      },
    },
    { recoverConfigTransaction: async () => false },
  );

  await cmdConfig(["--recover"]);

  assert.deepEqual(messages, ["No pending configuration recovery"]);
});

test("setup failures preserve status coercion and always remove the candidate", async (t) => {
  const root = await sandbox(t);
  const savedExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = savedExitCode;
  });
  const candidates: string[] = [];
  let status: number | null = 7;
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (command, args, options) => {
      assert.equal(command, base.NODE);
      assert.deepEqual(args, ["scripts/setup.mjs"]);
      const candidate = options?.env?.IVA_CONFIG_OUTPUT;
      assert.equal(typeof candidate, "string");
      candidates.push(candidate as string);
      assert.equal(existsSync(dirname(candidate as string)), true);
      return result(status);
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    { recoverConfigTransaction: async () => false },
  );

  process.exitCode = undefined;
  await cmdConfig();
  assert.equal(process.exitCode, 7);
  assert.equal(existsSync(dirname(candidates[0])), false);

  status = null;
  process.exitCode = undefined;
  await cmdConfig();
  assert.equal(process.exitCode, 1);
  assert.equal(existsSync(dirname(candidates[1])), false);
});

test("a declined candidate is removed without parsing or applying it", async (t) => {
  const root = await sandbox(t);
  let candidatePath = "";
  const warnings: string[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (_command, _args, options) => {
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      return result(0);
    },
    confirm: async (question, defaultValue) => {
      assert.equal(question, "Apply settings and restart services now?");
      assert.equal(defaultValue, true);
      return false;
    },
    warn: (message) => warnings.push(message),
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    {
      recoverConfigTransaction: async () => false,
      applyConfigTransaction: async () => {
        throw new Error("declined configuration must not be applied");
      },
    },
  );

  await cmdConfig();

  assert.deepEqual(warnings, ["Configuration unchanged"]);
  assert.equal(existsSync(dirname(candidatePath)), false);
});

test("a valid candidate continues after recovery with exact transaction and restart order", async (t) => {
  const root = await sandbox(t);
  const events: unknown[] = [];
  const nextText = [
    "MODEL_PROVIDER=codex",
    "CODEX_MODEL=gpt-5",
    "IVA_PORT=08723",
    "ASSISTANT_DATA_DIR=nested/data",
    "",
  ].join("\n");
  let candidatePath = "";
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => {
      events.push("require-systemd");
    },
    run: (command, args, options) => {
      events.push(["run", command, args]);
      assert.equal(options?.env?.PATH, base.childEnv.PATH);
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      writeFileSync(candidatePath, nextText);
      return result(0);
    },
    confirm: async (question, defaultValue) => {
      events.push(["confirm", question, defaultValue]);
      return true;
    },
    systemd: {
      ...base.systemd,
      restart: (services) => {
        events.push(["restart", services]);
      },
    },
    ok: (message) => {
      events.push(["ok", message]);
    },
  };
  const cmdConfig = createConfigCommand(
    runtime,
    {
      writeUnits: (options) => {
        events.push(["write-units", options]);
        return [];
      },
    },
    {
      recoverConfigTransaction: async (target, options = {}) => {
        events.push("recover");
        await options.restart?.(target.services);
        return true;
      },
      applyConfigTransaction: async (target, options = {}) => {
        events.push(["apply", target, existsSync(candidatePath)]);
        writeFileSync(target.envPath, target.nextText);
        await options.restart?.(target.services);
        await options.health?.(target.healthUrl);
        return { committed: true };
      },
      probeEveHealth: async (url) => {
        events.push(["health", url]);
      },
      refreshDataDirShim: (dataDir) => {
        events.push(["refresh-shim", dataDir]);
      },
    },
  );

  await cmdConfig();

  assert.deepEqual(events, [
    "require-systemd",
    "recover",
    ["refresh-shim", join(root, "data")],
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["ok", "Recovered the previous configuration and restarted services"],
    ["run", base.NODE, ["scripts/setup.mjs"]],
    ["confirm", "Apply settings and restart services now?", true],
    [
      "apply",
      {
        envPath: join(root, ".env"),
        nextText,
        selection: {
          provider: "codex",
          model: "gpt-5",
          key: undefined,
          dataDir: join(root, "nested/data"),
          // Адрес есть только у custom; у остальных он вшит в каталог.
          base: undefined,
        },
        services: runtime.SERVICES,
        healthUrl: "http://127.0.0.1:8723/eve/v1/health",
      },
      true,
    ],
    ["refresh-shim", join(root, "nested/data")],
    ["write-units", { ensureBearer: false }],
    ["restart", runtime.SERVICES],
    ["health", "http://127.0.0.1:8723/eve/v1/health"],
    ["ok", "Configuration applied; agent and Telegram bridge are active"],
  ]);
  assert.equal(existsSync(dirname(candidatePath)), false);
});

test("invalid candidate metadata and apply failures propagate after cleanup", async (t) => {
  const root = await sandbox(t);
  const cases = [
    {
      text: "MODEL_PROVIDER=invalid\nIVA_PORT=8723\n",
      message: "candidate configuration has an invalid model provider",
    },
    {
      text: "MODEL_PROVIDER=codex\nIVA_PORT=65536\n",
      message: "candidate configuration has an invalid IVA_PORT",
    },
  ];

  for (const testCase of cases) {
    let candidatePath = "";
    const base = createCliRuntime(root);
    const runtime: CliRuntime = {
      ...base,
      requireSystemd: () => undefined,
      run: (_command, _args, options) => {
        candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
        writeFileSync(candidatePath, testCase.text);
        return result(0);
      },
      confirm: async () => true,
    };
    const cmdConfig = createConfigCommand(
      runtime,
      { writeUnits: () => [] },
      {
        recoverConfigTransaction: async () => false,
        applyConfigTransaction: async () => {
          throw new Error("invalid candidates must fail before apply");
        },
      },
    );

    await assert.rejects(cmdConfig(), new RegExp(testCase.message, "u"));
    assert.equal(existsSync(dirname(candidatePath)), false);
  }

  let candidatePath = "";
  const applyError = new Error("transaction failed");
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    run: (_command, _args, options) => {
      candidatePath = String(options?.env?.IVA_CONFIG_OUTPUT);
      writeFileSync(candidatePath, "MODEL_PROVIDER=codex\nIVA_PORT=8723\n");
      return result(0);
    },
    confirm: async () => true,
  };
  const cmdConfig = createConfigCommand(
    runtime,
    { writeUnits: () => [] },
    {
      recoverConfigTransaction: async () => false,
      applyConfigTransaction: async () => {
        throw applyError;
      },
    },
  );

  await assert.rejects(cmdConfig(), (error) => error === applyError);
  assert.equal(existsSync(dirname(candidatePath)), false);
});

// Настоящий прогон мастера, которого `iva config` и запускает. Раньше его нельзя было
// прогнать иначе как подсунув .env в рабочее дерево, поэтому ветка «уже настроена» дожила
// до релиза с дырой: при MODEL_PROVIDER=ollmaa карты промахивались, ключ выпадал из
// обязательных, мастер печатал «Iva is already configured» и выходил по дефолтному «нет».
// IVA_CONFIG_INPUT даёт ему фикстуру вместо живой конфигурации машины.
//
// Процесс останавливается на первом же вопросе (stdin открыт, но пуст) — до сети дело не
// доходит: всё, что проверяется, напечатано раньше.
async function fixtureEnv(provider: string): Promise<string> {
  const listener = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "0.0.0.0", () =>
      resolve((listener.address() as net.AddressInfo).port),
    );
  });
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  return [
    `MODEL_PROVIDER=${provider}`,
    "OLLAMA_API_KEY=key",
    "OLLAMA_MODEL=deepseek-v4-pro",
    "DEEPGRAM_API_KEY=dg",
    "TELEGRAM_BOT_TOKEN=tg",
    "TELEGRAM_ALLOWED_USER_IDS=1",
    "TELEGRAM_BOT_USERNAME=ivabot",
    `IVA_PORT=${port}`,
    "AGENT_LANGUAGE=en",
    `ASSISTANT_BEARER=${"b".repeat(43)}`,
    "",
  ].join("\n");
}

async function runWizard(
  t: TestContext,
  provider: string,
  stopAt: RegExp,
  answers: readonly string[] = [],
  patchFixture: (text: string) => string = (text) => text,
): Promise<{ candidate: string; output: string }> {
  const root = await sandbox(t);
  const input = join(root, "fixture.env");
  const candidate = join(root, "candidate.env");
  writeFileSync(input, patchFixture(await fixtureEnv(provider)));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const fetchFixture = fileURLToPath(
    new URL("../fixtures/setup-wizard-fetch.ts", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", fetchFixture, join(repo, "scripts/setup/main.ts")],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NO_COLOR: "1",
        AGENT_LANGUAGE: "en",
        IVA_CONFIG_INPUT: input,
        IVA_CONFIG_OUTPUT: candidate,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let answerIndex = 0;
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  await new Promise<void>((resolve) => {
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      if (answerIndex < answers.length && text.endsWith(": ")) {
        child.stdin.write(`${answers[answerIndex]}\n`);
        answerIndex += 1;
      }
      if (stopAt.test(output)) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", () => resolve());
  });
  clearTimeout(timer);
  return { candidate, output };
}

test("the setup wizard treats an invalid provider as unconfigured, not as complete", async (t) => {
  // Пустое значение отдельным случаем: ключ в .env есть, значение пустое. Рантайм, доктор,
  // статус и апдейт его отвергают, а мастер с `||` схлопывал его в ollama и объявлял
  // сломанный .env настроенным — то есть ровно в починке и молчал.
  for (const value of ["ollmaa", "OLLAMA", ""]) {
    const { output } = await runWizard(
      t,
      value,
      /Provider \(1\/2\/3\/4\/5\/6\/7\)/u,
    );

    assert.doesNotMatch(output, /already configured/u, value);
    assert.doesNotMatch(output, /Reconfigure from scratch/u, value);
    assert.match(
      output,
      new RegExp(`MODEL_PROVIDER is invalid \\(${value}\\)`),
      value,
    );
    // И он именно СПРАШИВАЕТ провайдера, а не проходит мимо шага.
    assert.match(output, /Provider \(1\/2\/3\/4\/5\/6\/7\)/u, value);
  }
});

// Контроль: на исправной конфигурации мастер по-прежнему коротко подтверждает и предлагает
// ничего не трогать. Без него тест выше проходил бы и на мастере, сломанном вообще.
test("the setup wizard still short-circuits on a complete configuration", async (t) => {
  const { output } = await runWizard(t, "ollama", /Reconfigure from scratch/u);

  assert.match(output, /Iva is already configured/u);
  assert.match(output, /Provider: ollama/u);
  assert.doesNotMatch(output, /MODEL_PROVIDER is invalid/u);
});

// Это полный прогон реального процесса мастера, а не только резолвера.
// OpenCode выбран: его и Deepgram проверки пропускают сбой сети.
// Проверки Ollama и OpenRouter без сети зациклили бы мастер.
test("the setup wizard writes grep without leaking host secrets", async (t) => {
  const hostSecrets = {
    TAVILY_API_KEY: "host-only-tavily-secret",
    DEEPGRAM_API_KEY: "host-only-deepgram-secret",
  } as const;
  const originalSecrets = Object.fromEntries(
    Object.keys(hostSecrets).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, hostSecrets);
  t.after(() => {
    for (const [key, value] of Object.entries(originalSecrets)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { candidate, output } = await runWizard(
    t,
    "invalid",
    /Ready — settings validated for apply/u,
    [
      "2", // Provider (1/2/3/4/5/6/7) -> OpenCode
      "test-key", // Paste the OpenCode API key
      "", // Model number -> default (deepseek-v4-pro)
      "", // Vision model (photos) -> default from the same live list
      "", // Paste the Deepgram API key -> keep fixture dg
      "", // Recognition language (multi = auto ru/uz/en) -> default (multi)
      "", // Search provider (number) -> default (tavily)
      "", // tavily API key -> skip
      "y", // Enable hybrid memory?
      "", // Embedding provider (number) -> default (jina)
      "", // jina API key -> empty
      "", // Paste the Bot token -> keep fixture tg
      "", // Timezone (IANA, e.g. Asia/Almaty, Asia/Tashkent, Europe/Berlin) -> default (Asia/Almaty)
      "", // Vault directory (memory + git backup) -> default (vault)
      "", // Local eve-server port -> default (fixture IVA_PORT)
    ],
  );
  assert.ok(existsSync(candidate), output);
  const candidateText = readFileSync(candidate, "utf8");

  assert.equal(
    /^MEMORY_SEARCH_MODE=.*$/mu.exec(candidateText)?.[0],
    "MEMORY_SEARCH_MODE=grep",
    output,
  );
  for (const secret of Object.values(hostSecrets)) {
    assert.equal(candidateText.includes(secret), false);
  }
  // Vision-модель — вторая строка того же провайдера, и стоит она вплотную к своей
  // текстовой: .env читают глазами, и разнесённые по файлу настройки одного провайдера
  // ищутся дольше, чем правятся.
  assert.match(
    candidateText,
    /^OPENCODE_MODEL=.*\nOPENCODE_VISION_MODEL=.+$/mu,
    output,
  );
  assert.match(
    output,
    /No key — hybrid skipped\. Memory search stays on free BM25\. Enable later: iva config\./u,
  );
});

// Мастер судит о существующей настройке тем же разбором, каким `.env` прочитает сам
// агент. Ключ, начинающийся с решётки, для процесса пуст — значит настройка не полная,
// и мастер обязан спросить провайдера заново, а не объявить всё готовым.
test("the setup wizard sees the key the agent process will get, not the file text", async (t) => {
  const { output } = await runWizard(
    t,
    "ollama",
    /Provider \(1\/2\/3\/4\/5\/6\)|Reconfigure from scratch/u,
    [],
    (text) => text.replace("OLLAMA_API_KEY=key", "OLLAMA_API_KEY=#secret"),
  );

  assert.doesNotMatch(output, /Iva is already configured/u, output);
  assert.match(output, /Provider \(1\/2\/3\/4\/5\/6\/7\)/u, output);
});

// Полный прогон: владелец вставляет ключ с решёткой — сервис и команда прочитали бы
// его по-разному. Мастер обязан переспросить прямо на этом шаге, а не упасть в конце
// прогона, потеряв все ответы, и записать годный ключ так, чтобы процесс получил его целиком.
test("the setup wizard re-asks on an unstorable answer instead of losing the run", async (t) => {
  const { candidate, output } = await runWizard(
    t,
    "invalid",
    /Ready — settings validated for apply/u,
    [
      "2", // Provider (1/2/3/4/5/6/7) -> OpenCode
      "ab#cd", // Paste the OpenCode API key -> hash: .env cannot hold it, ask again
      "sk-live_ABC-123.xyz", // …and this one both parsers read the same way
      "", // Model number -> default (deepseek-v4-pro)
      "", // Vision model (photos) -> default from the same live list
      "", // Paste the Deepgram API key -> keep fixture dg
      "", // Recognition language (multi = auto ru/uz/en) -> default (multi)
      "", // Search provider (number) -> default (tavily)
      "ab#cd", // tavily API key -> идёт мимо askRequired, через обычный ask: тоже переспрос
      "sk-tav-123", // …и годный ключ
      "n", // Enable hybrid memory?
      "", // Paste the Bot token -> keep fixture tg
      "", // Timezone -> default (Asia/Almaty)
      "", // Vault directory (memory + git backup) -> default (vault)
      "", // Local eve-server port -> default (fixture IVA_PORT)
    ],
  );
  assert.match(output, /cannot hold it/u, output);
  assert.ok(existsSync(candidate), output);

  // Эталон — сам рантайм: агент стартует через `node --env-file=.env`.
  const seen = execFileSync(
    process.execPath,
    [
      `--env-file=${candidate}`,
      "-e",
      'process.stdout.write(process.env.OPENCODE_API_KEY ?? "")',
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  assert.equal(seen, "sk-live_ABC-123.xyz", readFileSync(candidate, "utf8"));

  // Второй переспрос — на ключе, который спрашивает обычный ask(), а не askRequired:
  // именно по этому пути негодное значение раньше доживало до конца прогона и роняло его.
  const text = readFileSync(candidate, "utf8");
  assert.match(text, /^TAVILY_API_KEY=sk-tav-123$/mu, text);
  assert.equal(
    (output.match(/cannot hold it/gu) ?? []).length,
    2,
    `переспросов должно быть два (askRequired и ask): ${output}`,
  );
});

// N1: негодное приходит не с клавиатуры, а из уже лежащего .env. Прогон обязан
// дойти до конца: терять все ответы владельца на последнем шаге нельзя.
for (const [what, patch] of [
  [
    "значение вне латиницы",
    (text: string) => `${text}ASSISTANT_VAULT_DIR=вольт\n`,
  ],
  [
    "значение с краевым пробелом",
    (text: string) => `${text}ASSISTANT_VAULT_DIR="my vault "\n`,
  ],
  ["чужое имя ключа", (text: string) => `${text}my.key=1\n`],
] as const) {
  test(`the setup wizard finishes when the existing .env carries ${what}`, async (t) => {
    const { candidate, output } = await runWizard(
      t,
      "invalid",
      /Ready — settings validated for apply|Setup aborted/u,
      [
        "2", // Provider -> OpenCode
        "sk-opencode-1", // its key
        "", // Model number -> default
        "", // Vision model -> default
        "", // Deepgram key -> keep fixture
        "", // Recognition language -> default
        "", // Search provider -> default
        "", // tavily key -> skip
        "n", // hybrid memory?
        "", // Bot token -> keep fixture
        "", // Timezone -> default
        "", // Vault directory -> Enter: подставляется значение из .env
        "", // Port -> default
      ],
      patch,
    );
    assert.doesNotMatch(output, /Setup aborted/u, output);
    assert.ok(existsSync(candidate), `кандидат не записан:\n${output}`);
  });
}

// N7/N8: строку, которую нельзя записать в безопасном подмножестве, мастер не выписывает
// дословно. Для значения с переносом строки «как есть» вообще не перенос: строка
// разваливается надвое, и вторая половина становится настоящей переменной — так в приёмке
// молча подменился ASSISTANT_DATA_DIR. Поэтому такая строка выбрасывается, а ключ
// называется вслух: смолчать о выброшенной строке владельца нельзя.
for (const [what, patch, key] of [
  [
    "значение с переносом строки",
    (text: string) =>
      `${text}OTHER="one\nASSISTANT_DATA_DIR=/tmp/pwned\ntwo"\n`,
    "OTHER",
  ],
  ["чужое имя ключа", (text: string) => `${text}my.key=1\n`, "my.key"],
] as const) {
  test(`the setup wizard drops ${what} from the existing .env and names the key`, async (t) => {
    const { candidate, output } = await runWizard(
      t,
      "invalid",
      /Ready — settings validated for apply|Setup aborted/u,
      [
        "2", // Provider -> OpenCode
        "sk-opencode-1", // its key
        "", // Model number -> default
        "", // Vision model -> default
        "", // Deepgram key -> keep fixture
        "", // Recognition language -> default
        "", // Search provider -> default
        "", // tavily key -> skip
        "n", // hybrid memory?
        "", // Bot token -> keep fixture
        "", // Timezone -> default
        "", // Vault directory -> default
        "", // Port -> default
      ],
      patch,
    );
    assert.doesNotMatch(output, /Setup aborted/u, output);
    assert.ok(existsSync(candidate), `кандидат не записан:\n${output}`);

    const text = readFileSync(candidate, "utf8");

    // Эталон — сам рантайм. В файле не должно появиться переменной, которой владелец не
    // задавал: каталог данных обязан остаться тем, что мастер выбрал сам.
    const seen = execFileSync(
      process.execPath,
      [
        `--env-file=${candidate}`,
        "-e",
        'process.stdout.write(process.env.ASSISTANT_DATA_DIR ?? "")',
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(seen, "data", text);

    assert.ok(
      !text.split("\n").some((line) => line.startsWith(`${key}=`)),
      `строка ${key} всё-таки записана:\n${text}`,
    );

    // Предупреждение обязано назвать ключ: иначе владелец не узнает, что строки не стало.
    assert.ok(
      output.includes(`Dropped ${key}`),
      `мастер не назвал выброшенный ключ ${key}:\n${output}`,
    );
  });
}

// IVA_CONFIG_INPUT существует ради одного: прогнать мастера против фикстуры в тесте.
// Унаследованный из окружения оператора он молча подменил бы источник — мастер прочитал бы
// чужой файл и записал бы результат поверх живого .env установки. `iva config` снимает его.
test("iva config never lets an inherited fixture seed replace the live .env", async (t) => {
  // Мастер «отказался» ниже, и команда выставляет process.exitCode — вернуть как было.
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  const root = await sandbox(t);
  const seen: Record<string, string | undefined>[] = [];
  const base = createCliRuntime(root);
  const runtime: CliRuntime = {
    ...base,
    requireSystemd: () => undefined,
    childEnv: { ...base.childEnv, IVA_CONFIG_INPUT: "/tmp/somebody-elses.env" },
    run: (_command, _args, options) => {
      seen.push({ ...options?.env });
      return result(1); // Мастер «отказался» — дальше идти незачем.
    },
    confirm: async () => true,
  };

  await createConfigCommand(runtime, { writeUnits: () => [] })([]);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].IVA_CONFIG_INPUT, undefined);
  // А выход и остальное окружение на месте.
  assert.equal(typeof seen[0].IVA_CONFIG_OUTPUT, "string");
  assert.equal(seen[0].PATH, base.childEnv.PATH);
});
