/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type StatusState = { chatId: number; userId: string; screen: string };
type View = { text: string };
type StatusScreen = {
  render: (state: StatusState, context: StatusContext) => Promise<View>;
};
type StatusContext = {
  deps: {
    root: string;
    envPath: string;
    dataDir: string;
    probeUserbotHealth: (options: {
      root: string;
      port: string;
    }) => Promise<{ state: string }>;
  };
  flows: {
    get: (chatId: number, userId: string) => StatusState | null;
    screen: (state: StatusState, text: string) => Promise<void>;
  };
  getLang: () => string;
  tr: (en: string, ru: string) => string;
};

const statusModulePath = "./status.ts";
const status = (await import(statusModulePath)) as { default: StatusScreen };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iva-menu-status-"));
  const envPath = join(root, ".env");
  await Promise.all([
    writeFile(join(root, "package.json"), '{"version":"0.3.11"}\n'),
    writeFile(
      envPath,
      "MODEL_PROVIDER=codex\nCODEX_MODEL=gpt-5\nSEARCH_PROVIDER=tavily\n",
    ),
  ]);
  return { root, envPath };
}

test("status renders fast fields before the asynchronous userbot probe settles", async () => {
  const { root, envPath } = await fixture();
  const pending = deferred<{ state: string }>();
  const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
  const edits: string[] = [];
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      probeUserbotHealth: () => pending.promise,
    },
    flows: {
      get: () => state,
      screen: async (_state, text) => {
        edits.push(text);
      },
    },
    getLang: () => "en",
    tr: (en) => en,
  };

  const initial = await status.default.render(state, context);
  assert.match(initial.text, /Iva v0\.3\.11/);
  assert.match(initial.text, /\| Context window \| 272k \|/);
  assert.match(initial.text, /\| Userbot \| … \|/);
  assert.equal(edits.length, 0);

  pending.resolve({ state: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits.length, 1);
  assert.match(edits[0] ?? "", /\| Userbot \| ready \|/);
});

test("status does not edit an expired menu after the asynchronous probe settles", async () => {
  const { root, envPath } = await fixture();
  const pending = deferred<{ state: string }>();
  const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
  let active: StatusState | null = state;
  let edits = 0;
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      probeUserbotHealth: () => pending.promise,
    },
    flows: {
      get: () => active,
      screen: async () => {
        edits += 1;
      },
    },
    getLang: () => "en",
    tr: (en) => en,
  };

  await status.default.render(state, context);
  active = { ...state };
  pending.resolve({ state: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(edits, 0);
});

// Пустая строка отдельным случаем: `MODEL_PROVIDER=` в .env — это заданное значение,
// которого рантайм не принимает, а не «переменной нет». Развернись предикат обратно в
// `||`, экран снова рапортовал бы про Ollama, пока агент лежит.
// Пробелов вокруг значения здесь нет намеренно, но осторожно с обобщением: парсеров .env
// в репозитории ДВА и ведут они себя по-разному. Этот экран читает через
// scripts/lib/env-file.ts, чей LINE_RE обрамляющие пробелы срезает, — до него они не
// доезжают. У мастера установки свой парсер (scripts/setup/config-file.ts), и совпадение их
// правил здесь не проверяется и не предполагается. Значение с пробелами ловит резолвер
// рантайма, который читает process.env напрямую и никакого парсера не проходит.
test("status surfaces an invalid model provider instead of presenting Ollama", async () => {
  for (const value of ["ollmaa", "OLLAMA", "ollama,opencode", ""]) {
    const { root, envPath } = await fixture();
    await writeFile(
      envPath,
      `MODEL_PROVIDER=${value}\nOLLAMA_MODEL=wrong-model\n`,
    );
    const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
    const context: StatusContext = {
      deps: {
        root,
        envPath,
        dataDir: join(root, "data"),
        probeUserbotHealth: async () => ({ state: "off" }),
      },
      flows: {
        get: () => null,
        screen: async () => undefined,
      },
      getLang: () => "en",
      tr: (en) => en,
    };

    const view = await status.default.render(state, context);
    assert.equal(
      view.text.includes(`| Model | invalid (${value}) · ? |`),
      true,
      view.text,
    );
    assert.doesNotMatch(view.text, /Model \| ollama|wrong-model/);
  }
});

test("status uses the shared Claude model window without a configured override", async () => {
  const { root, envPath } = await fixture();
  await writeFile(
    envPath,
    "MODEL_PROVIDER=claude\nCLAUDE_MODEL=claude-fable-5-1\n",
  );
  const state: StatusState = { chatId: 1, userId: "2", screen: "st" };
  const context: StatusContext = {
    deps: {
      root,
      envPath,
      dataDir: join(root, "data"),
      probeUserbotHealth: async () => ({ state: "off" }),
    },
    flows: { get: () => null, screen: async () => undefined },
    getLang: () => "ru",
    tr: (_en, ru) => ru,
  };
  const view = await status.default.render(state, context);
  assert.match(view.text, /\| Окно контекста \| 1M \|/);
});
