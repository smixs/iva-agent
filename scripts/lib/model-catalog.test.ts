import { test } from "node:test";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  MODEL_PROVIDER_NAMES,
  MODEL_PROVIDERS,
  resolveModelProvider,
} from "#lib/model-provider.ts";
import { ContextWindowConfigurationError } from "../../agent/lib/context-window.ts";
import {
  CATALOG,
  catalogModel,
  catalogProvider,
  normalizeBaseUrl,
  providerBase,
  providerEnvKeys,
  FALLBACK_EFFORTS,
  ModelCatalogError,
  fetchModelOptions,
} from "./model-catalog.ts";
import { modelSummary } from "./model-summary.ts";

// Каталог — вторая половина шва: по нему строятся кнопки /model, мастер и `iva doctor`
// (они грузятся на инсталле, где agent/ может не быть, ADR-0003), а принимает значение
// authored-резолвер. Разъедься перечни — мастер предложил бы провайдера, на котором
// рантайм откажется стартовать, или доктор объявил бы .env здоровым перед отказом.
// Порядок тоже общий: он же задаёт порядок имён в сообщении об отказе.
test("both trees accept exactly the same provider names, in the same order", () => {
  assert.deepEqual(Object.keys(CATALOG), [...MODEL_PROVIDER_NAMES]);
});

// Имён мало — разъехаться могут и значения. Каталог показывает дефолтную модель в мастере
// и в /menu, а берёт её рантайм из своей половины: разойдись они, пользователь согласился
// бы с одной моделью, а работала бы другая — тот же раскол, что и с именем провайдера.
test("both trees name the same model variable and the same default model", () => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const catalog = CATALOG[name];
    const authored = MODEL_PROVIDERS[name];
    assert.equal(catalog.modelVar, authored.modelVar, name);
    assert.equal(catalog.def, authored.defaultModel, name);
    // И то же самое с другого конца: пустой env обязан дать ровно дефолт каталога, а у
    // провайдера без дефолта (custom) — одинаково НЕ дать модель ни одной из половин.
    if (catalog.def === null) {
      assert.throws(() => resolveModelProvider({ MODEL_PROVIDER: name }), name);
      assert.equal(catalogModel(name, {}), undefined, name);
      continue;
    }
    assert.equal(
      resolveModelProvider({ MODEL_PROVIDER: name }).model,
      catalog.def,
      name,
    );
  }
  // Дефолта нет ровно у custom — иначе «модели не знаем» тихо расползлось бы по таблице.
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.filter((name) => CATALOG[name].def === null),
    ["custom"],
  );
});

// Vision-модель — вторая модель того же провайдера, и разъехаться ей нельзя ровно по той же
// причине: мастер предложил бы одну модель для фото, а описывала бы картинку другая.
// Подписки (codex, claude) своей переменной не имеют — обе половины обязаны молчать об этом
// одинаково: картинку смотрит та же модель, что ведёт ход.
test("both trees name the same vision variable and the same vision default", () => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const catalog = CATALOG[name];
    const authored = MODEL_PROVIDERS[name];
    assert.equal(catalog.visionVar, authored.visionModelVar, name);
    assert.equal(catalog.visionDef, authored.defaultVisionModel, name);
    // И с другого конца: пустой env даёт дефолт каталога, а у codex — текстовую модель.
    // custom без модели не разрешается вовсе — его случай проверен выше.
    if (catalog.def === null) continue;
    assert.equal(
      resolveModelProvider({ MODEL_PROVIDER: name }).visionModel,
      catalog.visionDef ?? catalog.def,
      name,
    );
  }
  // У custom переменная есть, а дефолта нет: картинку смотрит выбранная текстовая модель.
  assert.equal(
    resolveModelProvider({ MODEL_PROVIDER: "custom", CUSTOM_MODEL: "chat" })
      .visionModel,
    "chat",
  );
  // null стоит ровно у двух подписок — иначе «нет переменной» тихо расползлось бы по таблице.
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.filter((name) => CATALOG[name].visionVar === null),
    ["codex", "claude"],
  );
});

test("the catalog lookup takes exact names only", () => {
  for (const name of MODEL_PROVIDER_NAMES)
    assert.equal(catalogProvider(name), CATALOG[name]);
  for (const value of [
    "ollmaa",
    " ollama",
    "OLLAMA",
    "",
    "__proto__",
    "constructor",
    undefined,
  ])
    assert.equal(catalogProvider(value), undefined, JSON.stringify(value));
});

test("Codex catalog failure cannot create selectable fallback models", async () => {
  await assert.rejects(
    fetchModelOptions("codex", undefined, {
      listCodexCatalog: async () => {
        throw new Error("offline");
      },
    }),
    (error) =>
      error instanceof ModelCatalogError &&
      error.code === "catalog_unavailable",
  );
});

test("Ollama Cloud and OpenCode Go expose their OpenAI-compatible reasoning contract", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const options = await fetchModelOptions(provider, "test", {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "reasoning-model" }],
          }),
          { status: 200 },
        ),
    });
    assert.deepEqual(options, [
      {
        id: "reasoning-model",
        reasoningLevels: [...FALLBACK_EFFORTS],
      },
    ]);
  }
});

test("heterogeneous OpenRouter catalog does not invent reasoning choices", async () => {
  const options = await fetchModelOptions("openrouter", "unused");
  assert.ok(options.length > 0);
  assert.ok(options.every((option) => option.reasoningLevels.length === 0));
});

test("Requesty catalog is the pinned list, offline and without reasoning choices", async () => {
  const options = await fetchModelOptions("requesty", "unused", {
    fetchFn: async () => {
      throw new Error("no network expected");
    },
  });
  assert.deepEqual(
    options.map((option) => option.id),
    CATALOG.requesty.models,
  );
  assert.ok(options.every((option) => option.reasoningLevels.length === 0));
});

// ─── claude: список моделей отдаёт чужой CLI, а не сеть ─────────────────────────────
// Рукопожатие initialize отвечает пикером подписки. Когда CLI не ответил (нет бинаря,
// нет входа, чужой вывод) — остаётся вшитый список: это не отказ, а запасной путь, иначе
// владелец остался бы без модели во время настройки.
test("the claude catalog asks the CLI, and falls back to the pinned list", async () => {
  const live = await fetchModelOptions("claude", undefined, {
    listClaudeCatalog: async () => [
      { id: "claude-opus-5-5", label: "Opus 5.5", reasoningLevels: [] },
      { id: "claude-fable-5-1", label: "Fable 5.1", reasoningLevels: [] },
    ],
  });
  assert.deepEqual(live, [
    { id: "claude-opus-5-5", label: "Opus 5.5", reasoningLevels: [] },
    { id: "claude-fable-5-1", label: "Fable 5.1", reasoningLevels: [] },
  ]);
  // Окружение доезжает до рукопожатия: CLAUDE_COMMAND живёт в .env сервиса.
  let seen: unknown;
  await fetchModelOptions("claude", undefined, {
    claudeEnv: { CLAUDE_COMMAND: "/opt/claude" },
    listClaudeCatalog: async (env) => {
      seen = env;
      return [{ id: "claude-sonnet-5", reasoningLevels: [] }];
    },
  });
  assert.deepEqual(seen, { CLAUDE_COMMAND: "/opt/claude" });

  const fallback = await fetchModelOptions("claude", undefined, {
    listClaudeCatalog: async () => {
      throw new Error("no claude on this machine");
    },
  });
  assert.deepEqual(
    fallback.map((option) => option.id),
    CATALOG.claude.models,
  );
  assert.deepEqual(
    fallback.map((option) => option.label),
    ["Fable 5.1", "Opus 5.5", "Sonnet 5"],
  );
  // Вшитый список несёт те же уровни, что и живой: без CLI экран всё равно спросит уровень.
  for (const option of fallback)
    assert.deepEqual(
      option.reasoningLevels,
      ["low", "medium", "high", "xhigh", "max"],
      option.id,
    );
  // Вшитый список — те же три имени, что у экрана.
  assert.deepEqual(CATALOG.claude.models, [
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5",
  ]);
  assert.equal(CATALOG.claude.def, "claude-fable-5-1");
});

// Ключа нет нигде: ни переменной, ни vision-переменной. Подписка мультимодальна, как
// codex, — картинку смотрит выбранная текстовая модель.
test("the claude vendor holds no key and no vision variable", () => {
  assert.equal(CATALOG.claude.keyVar, null);
  assert.equal(CATALOG.claude.baseVar, null);
  assert.equal(CATALOG.claude.auth, "cli");
  assert.equal(CATALOG.claude.visionVar, null);
  assert.equal(CATALOG.claude.visionDef, null);
  assert.equal(providerBase(CATALOG.claude, {}), undefined);
});

// Один список обязательных ключей на доктора и мастера. Разъедься они — мастер объявил бы
// .env настроенным, а доктор на том же файле ругался бы (или наоборот, и никто бы не понял).
test("required env keys cover the key and the model, and codex asks for neither key", () => {
  assert.deepEqual(providerEnvKeys(CATALOG.ollama), [
    "OLLAMA_API_KEY",
    "OLLAMA_MODEL",
  ]);
  assert.deepEqual(providerEnvKeys(CATALOG.opencode), [
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
  ]);
  assert.deepEqual(providerEnvKeys(CATALOG.openrouter), [
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
  ]);
  assert.deepEqual(providerEnvKeys(CATALOG.requesty), [
    "REQUESTY_API_KEY",
    "REQUESTY_MODEL",
  ]);
  // codex входит по OAuth — ключа в .env нет вовсе.
  assert.deepEqual(providerEnvKeys(CATALOG.codex), ["CODEX_MODEL"]);
  // claude входит в чужом CLI на той же машине: в .env только имя модели, ни ключа,
  // ни адреса — ни того, ни другого Ива не хранит.
  assert.deepEqual(providerEnvKeys(CATALOG.claude), ["CLAUDE_MODEL"]);
  // custom: адрес обязателен наравне с моделью, ключ — нет (свой сервер живёт без него).
  assert.deepEqual(providerEnvKeys(CATALOG.custom), [
    "CUSTOM_BASE_URL",
    "CUSTOM_MODEL",
  ]);
  for (const name of MODEL_PROVIDER_NAMES) {
    const keys = providerEnvKeys(CATALOG[name]);
    assert.equal(keys.includes(CATALOG[name].modelVar), true, name);
    assert.equal(keys.includes(""), false, name);
  }
});

// Одна строка .env — один ответ. До этого их было три: рантайм отдавал пустую строку как
// есть, Статус подставлял дефолт, экран обновления рисовал «?». Матрица гоняет обе половины
// правила по мусорным значениям модели и требует совпадения символ в символ.
test("both trees answer one .env with one model, blank or padded", () => {
  const raws = [
    undefined,
    "",
    "   ",
    "\t\n",
    "deepseek-v4-pro",
    "  deepseek-v4-pro  ",
    "\tglm-5.2\n",
    "opencode-go/glm-5.2",
    "  opencode-go/glm-5.2  ",
    "vendor/model",
  ];
  for (const name of MODEL_PROVIDER_NAMES) {
    for (const raw of raws) {
      const env = raw === undefined ? {} : { [CATALOG[name].modelVar]: raw };
      const label = `${name} / ${JSON.stringify(raw)}`;
      let runtime: string | undefined;
      try {
        runtime = resolveModelProvider({ MODEL_PROVIDER: name, ...env }).model;
      } catch {
        // Рантайм отказался называть модель — каталог обязан отказаться тем же местом,
        // иначе экран показал бы имя, к которому агент даже не пойдёт.
        runtime = undefined;
      }
      assert.equal(catalogModel(name, env), runtime, label);
      // И оно никогда не пустое: провайдеру нельзя уйти без имени модели.
      assert.notEqual(catalogModel(name, env), "", label);
    }
  }
});

// ─── custom: адрес приходит из .env, а не из каталога ────────────────────────────────
// Единственный провайдер, чей base каталог не знает. Разъедься чтение адреса с рантаймом —
// мастер спрашивал бы модели у одного эндпоинта, а агент ходил бы к другому.

test("the custom base URL comes from .env, normalized, and nothing else does", () => {
  assert.equal(providerBase(CATALOG.ollama, {}), "https://ollama.com/v1");
  assert.equal(
    providerBase(CATALOG.ollama, { CUSTOM_BASE_URL: "https://evil.example" }),
    "https://ollama.com/v1",
  );
  assert.equal(providerBase(CATALOG.codex, {}), undefined);
  assert.equal(providerBase(CATALOG.custom, {}), undefined);
  assert.equal(
    providerBase(CATALOG.custom, {
      CUSTOM_BASE_URL: "  https://api.example.com/v1//  ",
    }),
    "https://api.example.com/v1",
  );
  // Мусор адресом не становится: без схемы fetch бросил бы «Failed to parse URL», и
  // мастер объявил бы это сбоем сети вместо опечатки в .env.
  for (const raw of [
    "",
    "   ",
    "api.example.com/v1",
    "ftp://api.example.com/v1",
    "https://",
    "не адрес",
  ])
    assert.equal(normalizeBaseUrl(raw), null, JSON.stringify(raw));
  assert.equal(
    normalizeBaseUrl("HTTP://127.0.0.1:11434/v1"),
    "HTTP://127.0.0.1:11434/v1",
  );
});

test("custom asks the endpoint it was given, without inventing an Authorization header", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  assert.deepEqual(
    await fetchModelOptions("custom", undefined, {
      base: "https://api.example.com/v1",
      fetchFn,
    }),
    // custom не обещает reasoning_effort — уровней у его моделей нет.
    [{ id: "local-model", reasoningLevels: [] }],
  );
  await fetchModelOptions("custom", "secret", {
    base: "https://api.example.com/v1",
    fetchFn,
  });
  assert.deepEqual(seen, [
    { url: "https://api.example.com/v1/models", auth: null },
    { url: "https://api.example.com/v1/models", auth: "Bearer secret" },
  ]);
});

test("custom without a base URL is a configuration refusal, not an empty list", async () => {
  await assert.rejects(
    fetchModelOptions("custom", "secret", {
      fetchFn: () => {
        throw new Error("must not reach the network");
      },
    }),
    (error) =>
      error instanceof ModelCatalogError && error.code === "base_missing",
  );
});

test("an unknown provider has no model at all", () => {
  for (const value of ["ollmaa", "OLLAMA", "", "__proto__"])
    assert.equal(catalogModel(value, { OLLAMA_MODEL: "x" }), undefined, value);
});

// Резолвер — не единственный, кто читает недоверенную строку из .env: по ней же ходят
// доктор, мастер, апдейт и экраны. Генератор перебирает вход, а не список.
// Провал печатает seed и path; fc.assert(prop, { seed, path }) повторяет прогон.
test("property: only the exact catalog names resolve to a provider", () => {
  const names: readonly string[] = MODEL_PROVIDER_NAMES;
  fc.assert(
    fc.property(
      fc
        .oneof(
          fc.string(),
          fc.string({ unit: "grapheme" }),
          fc.string({ unit: "binary" }),
          fc.constantFrom(
            "__proto__",
            "constructor",
            "prototype",
            "toString",
            "hasOwnProperty",
          ),
          fc
            .tuple(
              fc.constantFrom(" ", "", "\t"),
              fc.constantFrom(...MODEL_PROVIDER_NAMES),
              fc.constantFrom(" ", "", "\n"),
            )
            .map(([l, n, r]) => `${l}${n}${r}`),
        )
        .filter((value) => !names.includes(value)),
      (value) => {
        assert.equal(catalogProvider(value), undefined);
        assert.equal(catalogModel(value, { OLLAMA_MODEL: "x" }), undefined);
      },
    ),
    { numRuns: 500 },
  );
});

test("property: modelSummary returns a summary or the typed context-window error", () => {
  const anyValue = fc.option(fc.string({ unit: "binary" }), { nil: undefined });
  fc.assert(
    fc.property(
      fc.record(
        {
          MODEL_PROVIDER: anyValue,
          OLLAMA_MODEL: anyValue,
          OPENCODE_MODEL: anyValue,
          CODEX_MODEL: anyValue,
          OPENROUTER_MODEL: anyValue,
          OLLAMA_CONTEXT_WINDOW: anyValue,
        },
        { requiredKeys: [] },
      ),
      (env) => {
        let summary: ReturnType<typeof modelSummary>;
        try {
          summary = modelSummary(env);
        } catch (error) {
          assert.ok(error instanceof ContextWindowConfigurationError);
          return;
        }
        assert.equal(typeof summary.provider, "string");
        assert.equal(typeof summary.model, "string");
        assert.equal(summary.model.length > 0, true);
        assert.equal(summary.line, `${summary.provider} · ${summary.model}`);
        assert.equal(
          summary.contextWindow === null ||
            (typeof summary.contextWindow === "number" &&
              summary.contextWindow > 0),
          true,
        );
        // Известное имя — известная модель; неизвестное честно названо невалидным.
        const known = Boolean(catalogProvider(env.MODEL_PROVIDER ?? "ollama"));
        assert.equal(summary.provider.startsWith("invalid ("), !known);
      },
    ),
    { numRuns: 500 },
  );
});
