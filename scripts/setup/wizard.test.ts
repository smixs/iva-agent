/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns the registrations. */
// Мастер целиком in-process: настоящий диалог со сценарием ответов, шаги из steps.ts, сеть и
// запись .env — подмены. Как процесс мастер держит scripts/setup/main.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { PortChecker } from "../lib/ports.ts";
import { createDialog } from "./dialog.ts";
import type { Env, SetupBackend } from "./steps.ts";
import {
  abortReason,
  bearerOf,
  existingConfiguration,
  presetLanguage,
  providerDefault,
  providerFor,
  runWizard,
} from "./wizard.ts";

const SEED = 20260918;
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "gu");
const BEARER = "b".repeat(43);

type Selection = Parameters<SetupBackend["validateModelSelection"]>[0];

type Harness = {
  readonly screen: string[];
  readonly written: Env[];
  readonly validated: Selection[];
  readonly closed: () => number;
  readonly run: () => Promise<void>;
  readonly lang: () => string;
};

function wizard(
  existing: Env,
  answers: readonly string[],
  options: { env?: Env; codexLoggedIn?: boolean } = {},
): Harness {
  const queue = [...answers];
  const screen: string[] = [];
  const written: Env[] = [];
  const validated: Selection[] = [];
  let closed = 0;
  const plain = (text: unknown) => String(text).replace(ANSI_COLOUR, "");
  const dialog = createDialog(
    {
      question: (prompt) => {
        screen.push(`? ${plain(prompt)}`);
        const answer = queue.shift();
        if (answer === undefined)
          return Promise.reject(new Error(`no answer for: ${plain(prompt)}`));
        return Promise.resolve(answer);
      },
      print: (...args) => screen.push(args.map(plain).join(" ")),
      write: (text) => screen.push(plain(text)),
    },
    new PortChecker([
      { name: "free", check: () => Promise.resolve({ occupied: false }) },
    ]),
  );
  const backend: SetupBackend = {
    envValue: (name) => options.env?.[name],
    dataDirAbs: () => "/data",
    readAuth: () => null,
    listCodexModels: () => Promise.resolve([]),
    runBrowserLogin: () => Promise.reject(new Error("not used")),
    runDeviceCodeLogin: () => Promise.reject(new Error("not used")),
    fetchModels: () => Promise.resolve([]),
    validateModelSelection: (selection) => {
      validated.push(selection);
      return Promise.resolve({
        id: selection.model ?? "",
        reasoningLevels: [],
      });
    },
    writeEnv: (out) => {
      written.push({ ...out });
      return Promise.resolve();
    },
    ollamaModels: () => Promise.resolve(["deepseek-v4-pro", "qwen3-vl"]),
    opencodeCheck: () => Promise.resolve(null),
    opencodeModels: () => Promise.resolve(["deepseek-v4-pro"]),
    openrouterKeyCheck: () => Promise.resolve(null),
    openrouterModelCheck: () => Promise.resolve(null),
    requestyKeyCheck: () => Promise.resolve(null),
    requestyModelCheck: () => Promise.resolve(null),
    claudeCli: () =>
      Promise.resolve({
        installed: true,
        loggedIn: true,
        plan: "max",
        conflict: null,
        ready: true,
        hint: "",
      }),
    deepgramCheck: () => Promise.resolve(null),
    telegramGetMe: () => Promise.resolve({ username: "ivabot" }),
    fetchTelegramUserIds: () => Promise.resolve([{ id: "5", name: "Ann" }]),
  };
  return {
    screen,
    written,
    validated,
    closed: () => closed,
    lang: () => dialog.lang(),
    run: () =>
      runWizard({
        ctx: { ...dialog, ...backend },
        setLang: dialog.setLang,
        readExisting: () => Promise.resolve(existing),
        codexLoggedIn: () => options.codexLoggedIn ?? false,
        staging: false,
        closeInput: () => {
          closed += 1;
        },
      }),
  };
}

const complete: Env = {
  AGENT_LANGUAGE: "en",
  MODEL_PROVIDER: "opencode",
  OPENCODE_API_KEY: "oc-key",
  OPENCODE_MODEL: "deepseek-v4-pro",
  TELEGRAM_BOT_TOKEN: "123:t",
  TELEGRAM_ALLOWED_USER_IDS: "11",
  ASSISTANT_BEARER: BEARER,
};

test("fresh setup in Russian: every step runs in order and the answers are written", async () => {
  const h = wizard({}, [
    "2.", // язык — русский
    "", // провайдер — Ollama по умолчанию
    "ollama-key",
    "", // модель
    "", // vision
    "", // Deepgram — пропустить
    "", // поиск — tavily
    "", // ключ tavily — пропустить
    "", // hybrid — нет
    "123:t", // токен бота
    "", // написали боту
    "", // все найденные ID
    "", // часовой пояс
    "", // vault
    "", // порт
  ]);
  await h.run();
  assert.equal(h.lang(), "ru");
  assert.equal(h.written.length, 1);
  const out = h.written[0];
  assert.equal(out.AGENT_LANGUAGE, "ru");
  assert.equal(out.MODEL_PROVIDER, "ollama");
  assert.equal(out.OLLAMA_API_KEY, "ollama-key");
  assert.equal(out.TELEGRAM_ALLOWED_USER_IDS, "5");
  assert.equal(out.IVA_PORT, "8723");
  assert.match(out.ASSISTANT_BEARER, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(h.closed(), 1);
  const steps = h.screen.filter((line) => /Шаг \d\/5/u.test(line));
  assert.deepEqual(
    steps.map((line) => /Шаг (\d)/u.exec(line)?.[1]),
    ["1", "2", "3", "4", "5"],
  );
  assert.ok(
    h.screen.includes("  → Iva будет отвечать по-русски по умолчанию."),
  );
});

test("complete configuration kept: nothing asked but the one question, nothing written", async () => {
  const h = wizard(complete, ["n"], { env: { AGENT_LANGUAGE: "EN" } });
  await h.run();
  assert.equal(h.lang(), "en");
  assert.deepEqual(
    h.screen.filter((line) => line.startsWith("? ")),
    ["? \n  Reconfigure from scratch? (y/N): "],
  );
  assert.ok(h.screen.includes("  • Bot:       @?"));
  assert.ok(h.screen.includes("  • Deepgram:  multi   ·   TZ: ?"));
  assert.deepEqual(h.written, []);
  assert.deepEqual(h.validated, []);
  assert.equal(h.closed(), 1);
});

test("kept configuration that differs from the file is validated and written", async () => {
  const withoutBearer: Env = { ...complete };
  delete withoutBearer.ASSISTANT_BEARER;
  const h = wizard(withoutBearer, ["n"], { env: { AGENT_LANGUAGE: "en" } });
  await h.run();
  assert.equal(h.written.length, 1);
  assert.match(h.written[0].ASSISTANT_BEARER, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(h.validated.length, 1);
  assert.equal(h.validated[0].provider, "opencode");
  assert.equal(h.validated[0].model, "deepseek-v4-pro");
  assert.equal(h.validated[0].key, "oc-key");
  assert.equal(h.validated[0].dataDir, "/data");
  assert.equal(h.validated[0].base, "https://opencode.ai/zen/go/v1");
});

test("failure: an invalid provider is named and the wizard walks the steps", async () => {
  const h = wizard({ ...complete, MODEL_PROVIDER: "ollmaa" }, [], {
    env: { AGENT_LANGUAGE: "en" },
  });
  await assert.rejects(
    h.run(),
    /no answer for:\s+Provider \(1\/2\/3\/4\/5\/6\/7\) \[1\]: /u,
  );
  assert.ok(
    h.screen.some((line) => /MODEL_PROVIDER is invalid \(ollmaa\)/u.test(line)),
  );
  assert.ok(
    h.screen.some((line) => /Iva setup — entering secrets/u.test(line)),
  );
  assert.equal(h.closed(), 0);
});

test("existingConfiguration: codex needs a login, an empty provider is not ollama", () => {
  const codex = {
    ...complete,
    MODEL_PROVIDER: "codex",
    CODEX_MODEL: "gpt-5.5",
  };
  assert.equal(existingConfiguration(codex, () => false).isComplete, false);
  assert.equal(existingConfiguration(codex, () => true).isComplete, true);
  assert.equal(existingConfiguration(codex, () => true).provKey, null);

  const empty = existingConfiguration(
    { ...complete, MODEL_PROVIDER: "" },
    () => true,
  );
  assert.equal(empty.prov0, "");
  assert.equal(empty.cat0, undefined);
  assert.equal(empty.provModel, "OLLAMA_MODEL");
  assert.equal(empty.isComplete, false);

  const missing = existingConfiguration(
    { MODEL_PROVIDER: "opencode" },
    () => true,
  );
  assert.equal(missing.provModel, "OPENCODE_MODEL");
  assert.equal(missing.isComplete, false);
  assert.equal(existingConfiguration({}, () => true).prov0, "ollama");
});

test("bearerOf keeps a valid server key and issues a new one otherwise", () => {
  assert.equal(bearerOf({ ASSISTANT_BEARER: ` ${BEARER} ` }), BEARER);
  const fresh = bearerOf({ ASSISTANT_BEARER: "short" });
  assert.match(fresh, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(fresh, bearerOf({}));
});

test("presetLanguage takes en and ru in any case, nothing else", () => {
  assert.equal(presetLanguage("RU"), "ru");
  assert.equal(presetLanguage("en"), "en");
  assert.equal(presetLanguage("de"), null);
  assert.equal(presetLanguage(undefined), null);
});

test("abortReason: the error message, or the thrown value itself", () => {
  assert.equal(abortReason(new Error("EISDIR")), "EISDIR");
  assert.equal(abortReason("plain"), "plain");
  assert.equal(abortReason(null), null);
});

test(`provider menu: the default number picks the current provider back; any choice is a provider (seed ${SEED})`, () => {
  const providers = [
    "ollama",
    "opencode",
    "codex",
    "claude",
    "openrouter",
    "custom",
    "requesty",
  ];
  for (const provider of providers)
    assert.equal(providerFor(Number(providerDefault(provider))), provider);
  assert.equal(providerDefault("ollmaa"), "1");
  fc.assert(
    fc.property(fc.option(fc.integer(), { nil: null }), (choice) => {
      const provider = providerFor(choice);
      assert.ok(providers.includes(provider));
      if (choice === null || choice < 2 || choice > providers.length)
        assert.equal(provider, "ollama");
    }),
    { seed: SEED, numRuns: 300 },
  );
});
