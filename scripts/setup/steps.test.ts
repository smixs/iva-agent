/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- стабы шагов отдают готовые промисы ради одного типа с боевыми функциями, тестами владеет node:test. */
// In-process проверки шагов мастера (B5): по одному happy и одному failure на шаг.
// Чёрный ящик scripts/cli/config.test.ts остаётся главной сеткой — здесь проверяется
// проводка шага: какие вопросы он задаёт, что уносит в .env и как называет отказ.
import assert from "node:assert/strict";
import test from "node:test";
import {
  askKeysSettings,
  askProviderSettings,
  askTelegramSettings,
  askVaultAndPort,
  writeSetupEnv,
  type Env,
  type SetupContext,
  type SetupState,
} from "./steps.ts";

/** Вход в чужой CLI есть: подписка, план и отсутствие чужой авторизации. */
const readyClaude = {
  installed: true,
  loggedIn: true,
  plan: "max",
  conflict: null,
  ready: true,
  hint: "",
};

function makeContext(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    t: (en: string) => en,
    lang: () => "en",
    print: () => undefined,
    write: () => undefined,
    ask: async () => "",
    askYesNo: async () => false,
    askRequired: async () => "value",
    mask: (value: string) => value,
    pickFromList: async (items) => {
      const first = items[0];
      if (!first) return "";
      return typeof first === "string" ? first : first.id;
    },
    pickPort: async (def: string) => def,
    head: () => undefined,
    hr: () => undefined,
    envValue: () => undefined,
    dataDirAbs: () => "/data",
    readAuth: () => null,
    listCodexModels: async () => [],
    runBrowserLogin: async () => {
      throw new Error("not used");
    },
    runDeviceCodeLogin: async () => {
      throw new Error("not used");
    },
    fetchModels: async () => [],
    validateModelSelection: async () => ({
      id: "test-model",
      reasoningLevels: [],
    }),
    writeEnv: async () => undefined,
    ollamaModels: async () => ["deepseek-v4-pro", "deepseek-v4-flash"],
    opencodeCheck: async () => null,
    opencodeModels: async () => ["deepseek-v4-pro"],
    openrouterKeyCheck: async () => null,
    openrouterModelCheck: async () => null,
    requestyKeyCheck: async () => null,
    requestyModelCheck: async () => null,
    claudeCli: async () => readyClaude,
    deepgramCheck: async () => null,
    telegramGetMe: async () => ({ username: "ivabot" }),
    fetchTelegramUserIds: async () => [],
    ...overrides,
  };
}

function state(
  provider: string,
  out: Env = {},
  existing: Env = {},
): SetupState {
  return { existing, out: { ...out }, provider };
}

test("шаг провайдера: happy — ключ, модель и vision попадают в ответы", async () => {
  const captured: Array<string | null> = [];
  const ctx = makeContext({
    askRequired: async (_label, options) => {
      captured.push((await options?.validate?.("ollama-key")) ?? null);
      return "ollama-key";
    },
    pickFromList: async (items, _current, recommended) => {
      const ids = items.map((item) =>
        typeof item === "string" ? item : item.id,
      );
      return ids.includes(recommended) ? recommended : (ids[0] ?? "");
    },
  });
  const s = state("ollama");
  await askProviderSettings(s, ctx);
  // Ключ проверен живым списком моделей: validator вернул null, а не отказ.
  assert.deepEqual(captured, [null]);
  assert.equal(s.out.OLLAMA_API_KEY, "ollama-key");
  assert.equal(s.out.OLLAMA_MODEL, "deepseek-v4-pro");
  assert.equal(s.out.OLLAMA_VISION_MODEL, "deepseek-v4-pro");
  assert.equal(s.out.OLLAMA_CONTEXT_WINDOW, "131072");
});

test("шаг провайдера: failure — отказ ключа возвращается словами, а не нулём", async () => {
  const captured: Array<string | null> = [];
  const ctx = makeContext({
    ollamaModels: async () => {
      throw Object.assign(new Error("key rejected"), { auth: true });
    },
    askRequired: async (_label, options) => {
      captured.push((await options?.validate?.("bad-key")) ?? null);
      return "bad-key";
    },
  });
  await askProviderSettings(state("ollama"), ctx);
  assert.equal(captured.length, 1);
  assert.match(String(captured[0]), /rejected the key/u);
});

test("шаг ключей: happy — Deepgram, поиск и память остаются на бесплатной базе", async () => {
  const ctx = makeContext({
    ask: async (question) =>
      question.includes("Deepgram API key")
        ? "dg-key"
        : question.includes("Recognition language")
          ? "ru"
          : "",
    askYesNo: async () => false,
  });
  const s = state("ollama");
  await askKeysSettings(s, ctx);
  assert.equal(s.out.DEEPGRAM_API_KEY, "dg-key");
  assert.equal(s.out.DEEPGRAM_LANGUAGE, "ru");
  assert.equal(s.out.SEARCH_PROVIDER, "tavily");
  assert.equal(s.out.TAVILY_API_KEY, "");
  assert.equal(s.out.MEMORY_SEARCH_MODE, "grep");
});

test("шаг ключей: Enter на ключе Deepgram — пропуск, язык не спрашивается, голос выключен", async () => {
  const asked: string[] = [];
  const printed: string[] = [];
  const ctx = makeContext({
    ask: async (question) => {
      asked.push(question);
      return "";
    },
    print: (line) => printed.push(String(line)),
    askYesNo: async () => false,
  });
  const s = state("ollama");
  await askKeysSettings(s, ctx);
  assert.equal(s.out.DEEPGRAM_API_KEY, "");
  assert.equal(s.out.DEEPGRAM_LANGUAGE, "multi");
  assert.ok(!asked.some((q) => q.includes("Recognition language")));
  assert.ok(printed.some((l) => /\/menu → 🎤 Voice/u.test(l)));
});

test("шаг ключей: failure — отказ Deepgram называет причину и просит ключ снова", async () => {
  const printed: string[] = [];
  let attempts = 0;
  const ctx = makeContext({
    deepgramCheck: async (key) =>
      key === "bad"
        ? "Deepgram rejected the key (401/403). Copy the key in full."
        : null,
    ask: async (question) => {
      if (!question.includes("Deepgram API key")) return "";
      attempts += 1;
      return attempts === 1 ? "bad" : "good";
    },
    print: (line) => printed.push(String(line)),
    askYesNo: async () => false,
  });
  const s = state("ollama");
  await askKeysSettings(s, ctx);
  assert.equal(attempts, 2);
  assert.equal(s.out.DEEPGRAM_API_KEY, "good");
  assert.ok(printed.some((l) => /Deepgram rejected the key/u.test(l)));
});

test("шаг Telegram: happy — токен даёт username, найденный ID идёт в доступ", async () => {
  const ctx = makeContext({
    askRequired: async (_label, options) => {
      assert.equal((await options?.validate?.("123:ABC")) ?? null, null);
      return "123:ABC";
    },
    fetchTelegramUserIds: async () => [{ id: "42", name: "Ann" }],
    ask: async () => "",
  });
  const s = state("ollama");
  await askTelegramSettings(s, ctx);
  assert.equal(s.out.TELEGRAM_BOT_TOKEN, "123:ABC");
  assert.equal(s.out.TELEGRAM_BOT_USERNAME, "ivabot");
  assert.equal(s.out.TELEGRAM_ALLOWED_USER_IDS, "42");
  assert.equal(s.out.TELEGRAM_DIGEST_CHAT_ID, "42");
  assert.match(s.out.TELEGRAM_WEBHOOK_SECRET_TOKEN, /^[0-9a-f]{48}$/u);
});

test("шаг Telegram: failure — отказ токена и недоступные апдейты ведут к ручному ID", async () => {
  const printed: string[] = [];
  const captured: Array<string | null> = [];
  let asked = 0;
  const ctx = makeContext({
    print: (...args: unknown[]) => printed.push(args.join(" ")),
    askRequired: async (_label, options) => {
      captured.push((await options?.validate?.("bad")) ?? null);
      return "bad";
    },
    telegramGetMe: async () => {
      throw new Error("Unauthorized");
    },
    fetchTelegramUserIds: async () => {
      throw new Error("network down");
    },
    ask: async () => {
      asked += 1;
      // Первый вопрос — «написали боту?», второй — ручной ID.
      return asked === 1 ? "" : "777";
    },
  });
  const s = state("ollama");
  await askTelegramSettings(s, ctx);
  assert.match(String(captured[0]), /Telegram rejected the token/u);
  assert.ok(
    printed.some((line) => line.includes("Couldn't fetch updates")),
    printed.join("\n"),
  );
  assert.equal(s.out.TELEGRAM_ALLOWED_USER_IDS, "777");
});

test("шаг вольта: happy — зона, вольт, порт и локальный host сходятся", async () => {
  const ctx = makeContext({
    ask: async (question) =>
      question.includes("Timezone") ? "Asia/Almaty" : "vault",
    pickPort: async () => "8723",
  });
  const s = state("ollama");
  await askVaultAndPort(s, ctx);
  assert.equal(s.out.ASSISTANT_TIMEZONE, "Asia/Almaty");
  assert.equal(s.out.ASSISTANT_VAULT_DIR, "vault");
  assert.equal(s.out.ASSISTANT_DATA_DIR, "data");
  assert.equal(s.out.IVA_PORT, "8723");
  assert.equal(s.out.ASSISTANT_HOST, "http://127.0.0.1:8723");
});

test("шаг вольта: failure — мусорная зона переспрашивается, а не пишется в .env", async () => {
  const printed: string[] = [];
  let asked = 0;
  const ctx = makeContext({
    print: (...args: unknown[]) => printed.push(args.join(" ")),
    ask: async (question) => {
      if (!question.includes("Timezone")) return "vault";
      asked += 1;
      return asked === 1 ? "Mars/Nowhere" : "Asia/Tashkent";
    },
    pickPort: async () => "8723",
  });
  const s = state("ollama");
  await askVaultAndPort(s, ctx);
  assert.equal(asked, 2, "мастер обязан переспросить зону");
  assert.equal(s.out.ASSISTANT_TIMEZONE, "Asia/Tashkent");
  assert.ok(
    printed.some((line) => line.includes("Unknown IANA timezone")),
    printed.join("\n"),
  );
});

test("шаг записи .env: happy — ключ провайдера доходит до писателя", async () => {
  const written: Env[] = [];
  const validated: string[] = [];
  const ctx = makeContext({
    writeEnv: async (out) => {
      written.push({ ...out });
    },
    validateModelSelection: async (options) => {
      validated.push(`${options.provider}/${options.model}`);
      return { id: "test-model", reasoningLevels: [] };
    },
  });
  const s = state(
    "ollama",
    {
      MODEL_PROVIDER: "ollama",
      OLLAMA_API_KEY: "ollama-key",
      OLLAMA_MODEL: "deepseek-v4-pro",
    },
    {},
  );
  await writeSetupEnv(s, ctx, false);
  assert.equal(validated.length, 1);
  assert.equal(validated[0], "ollama/deepseek-v4-pro");
  assert.equal(written.length, 1);
  assert.equal(written[0].OLLAMA_API_KEY, "ollama-key");
  assert.equal(written[0].OLLAMA_MODEL, "deepseek-v4-pro");
});

test("шаг записи .env: failure — отказ проверки модели роняет шаг, файл не пишется", async () => {
  let writes = 0;
  const ctx = makeContext({
    validateModelSelection: async () => {
      throw new Error("model is not available");
    },
    writeEnv: async () => {
      writes += 1;
    },
  });
  const s = state("ollama", { MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "gone" });
  await assert.rejects(
    () => writeSetupEnv(s, ctx, false),
    /model is not available/u,
  );
  assert.equal(writes, 0, ".env не должен писаться при отказе проверки");
});

// ─── claude: ключа нет, вход в чужом CLI ─────────────────────────────────────────────
// Шаг проверяет то, что мастер может проверить (статус CLI), называет команды для
// сервера и повторяет проверку. На экране — имя модели, в .env — её id.
test("the claude step shows the name and writes the canonical id", async () => {
  let shown: readonly (string | { id: string; label?: string })[] = [];
  const out = await askProviderSettings(
    { existing: {}, out: {}, provider: "claude" },
    makeContext({
      fetchModels: async () => ["claude-sonnet-5", "claude-fable-5-1"],
      pickFromList: async (items) => {
        shown = items;
        const first = items[0];
        if (!first) return "";
        return typeof first === "string" ? first : first.id;
      },
    }),
  );
  assert.deepEqual(shown, [
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
  ]);
  assert.equal(out.CLAUDE_MODEL, "claude-sonnet-5");
  assert.equal(out.CLAUDE_CONTEXT_WINDOW, "1000000");
});

test("a CLI that is not ready is named, and the check can be repeated", async () => {
  const printed: string[] = [];
  let asked = 0;
  let checks = 0;
  const ctx = makeContext({
    print: (...args: unknown[]) => printed.push(args.map(String).join(" ")),
    askYesNo: async () => {
      asked += 1;
      return true;
    },
    claudeCli: async () => {
      checks += 1;
      return checks === 1
        ? {
            installed: false,
            loggedIn: false,
            plan: "",
            conflict: null,
            ready: false,
            hint: `Claude Code CLI not found — install it on the server as iva: npm install -g --prefix ~/.local @anthropic-ai/claude-code`,
          }
        : readyClaude;
    },
    fetchModels: async () => ["claude-fable-5-1"],
  });

  const out = await askProviderSettings(
    { existing: {}, out: {}, provider: "claude" },
    ctx,
  );
  assert.equal(asked, 1);
  assert.equal(checks, 2);
  const screen = printed.join("\n");
  assert.match(
    screen,
    /npm install -g --prefix ~\/\.local @anthropic-ai\/claude-code/u,
  );
  assert.match(screen, /max/u, "план подписки не назван после входа");
  assert.equal(out.CLAUDE_MODEL, "claude-fable-5-1");
});

test("the setup summary and the final check know the claude vendor", async () => {
  const written: Record<string, string>[] = [];
  const validated: unknown[] = [];
  const out = await writeSetupEnv(
    {
      existing: {},
      out: { MODEL_PROVIDER: "claude", CLAUDE_MODEL: "claude-fable-5-1" },
      provider: "claude",
    },
    makeContext({
      writeEnv: async (env: Env) => {
        written.push({ ...env });
      },
      validateModelSelection: async (selection: unknown) => {
        validated.push(selection);
        return { id: "claude-fable-5-1", reasoningLevels: [] };
      },
    }),
    false,
  );
  assert.deepEqual(validated, [
    {
      provider: "claude",
      model: "claude-fable-5-1",
      key: undefined,
      dataDir: "/data",
      // Адреса у этого вендора нет вовсе: он ходит через CLI, а не в сеть.
      base: undefined,
    },
  ]);
  assert.equal(written.length, 1);
  assert.equal(out.CLAUDE_MODEL, "claude-fable-5-1");
});
