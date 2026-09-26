// Ядро middleware, который прикладывает картинку Vault к сообщению модели. Файлы сюда
// приходят инъекцией (readImage), поэтому тест идёт без файловой системы и без сети.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import fc from "fast-check";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
} from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { classifyModelCallError } from "../node_modules/eve/dist/src/harness/model-call-error.js";
import { CLAUDE_TOOL_NAME_MAX, ClaudeCliError } from "./lib/claude-cli.ts";
import { writeAuth, type CodexAuth, TOKEN_URL } from "./lib/codex-auth.ts";
import { MODEL_PROVIDERS, MODEL_PROVIDER_NAMES } from "./lib/model-provider.ts";

process.env.MODEL_PROVIDER = "ollama";
const {
  attachImagesMiddleware,
  attachVaultImages,
  codexFetch,
  MODEL_FIRST_CHUNK_TIMEOUT_MS,
  modelFirstChunkDeadlineMiddleware,
  reasoningReplayMiddleware,
  transientPreStreamRetryMiddleware,
  withReplayableReasoning,
} = await import("./provider.ts");
const { MAX_ATTACHED_IMAGES, MAX_IMAGE_BYTES } =
  await import("./lib/attachment-ref.ts");

type Prompt = Parameters<typeof attachVaultImages>[0];
type Message = Prompt[number];
type FilePart = {
  type: "file";
  mediaType: string;
  data: { type: "data"; data: Uint8Array };
};

const BYTES = new Uint8Array([1, 2, 3]);
const readImage = () => BYTES;
const REF = "attachments/2026-08-27/photo-082621.jpg";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_FETCH_TEST_EPOCH_MS = Date.now();

function providerError(
  statusCode: number,
  message = `HTTP ${statusCode}`,
  responseHeaders?: Record<string, string>,
) {
  return Object.assign(new Error(message), {
    isRetryable: true,
    responseHeaders,
    statusCode,
  });
}

const noDelay = () => Promise.resolve();

function codexAccessToken(nowMs: number, label: string): string {
  const b64url = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    b64url({ alg: "none" }),
    b64url({ exp: Math.floor(nowMs / 1000) + 3600, label }),
    "signature",
  ].join(".");
}

function userText(...texts: string[]): Message {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text" as const, text })),
  };
}

// Промпт в форме параметров middleware: остальные поля не нужны, важны только роли и текст.
type MiddlewareParams = Parameters<
  NonNullable<ReturnType<typeof attachImagesMiddleware>["transformParams"]>
>[0]["params"];

const middlewareParams = (text: string): MiddlewareParams => ({
  prompt: [userText(text)],
});

// Предикат для моделей, собранных в тестах заголовков: картинки в этих прогонах не едут.
const blindToImages = (): Promise<boolean> => Promise.resolve(false);

function filesOf(message: Message): FilePart[] {
  const content = (message as { content: { type: string }[] }).content;
  assert.ok(Array.isArray(content));
  return content.filter((part) => part.type === "file") as FilePart[];
}

function muteErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

function installCodexAuth(
  t: { after: (fn: () => void) => void },
  nowMs: number,
): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-codex-fetch-"));
  const prevDataDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(() => {
    if (prevDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const auth: CodexAuth = {
    id_token: "id-token",
    access_token: codexAccessToken(nowMs, "stored"),
    refresh_token: "refresh-token",
    accountId: "acc_test",
    planType: "pro",
  };
  writeAuth(auth, dir);
  return dir;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "object" && "url" in input
    ? input.url
    : String(input);
}

// Отказы шага claude рождаются в agent/lib/claude-cli.ts (нет бинаря, обрыв CLI, ошибка API
// подписки). Смысл проверки тот же, что у codex: ход чинится повтором и не отравляет сессию.
await test("ошибка шага claude не отравляет сессию", () => {
  const errors = [
    new ClaudeCliError(
      "Claude Code CLI not found (PATH: /usr/bin) — install it on the server as iva: npm install -g --prefix ~/.local @anthropic-ai/claude-code (or point CLAUDE_COMMAND at the binary)",
    ),
    new ClaudeCliError("API Error: 500 internal server error"),
    new ClaudeCliError("Claude CLI produced nothing for 180s"),
    new ClaudeCliError(
      "Claude returned a tool outside the current inventory: Bash",
    ),
  ];
  for (const error of errors) {
    assert.equal(classifyModelCallError(error), "recoverable", error.message);
  }
});

function assertCodexAuthExpired(error: unknown): true {
  assert.ok(error instanceof Error);
  assert.match(
    error.message,
    /^Codex auth rejected \(401 token_expired\); run `iva login`/u,
  );
  assert.equal((error as Error & { code?: string }).code, "CODEX_AUTH_EXPIRED");
  assert.equal(classifyModelCallError(error), "recoverable");
  return true;
}

function modelWithDelayedParts(
  parts: LanguageModelV4StreamPart[],
  delayMs: number | undefined,
  onSignal?: (signal: AbortSignal | undefined) => void,
) {
  return wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: (options) => {
        onSignal?.(options.abortSignal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              if (delayMs === undefined) {
                for (const part of parts) controller.enqueue(part);
                return;
              }
              timer = setTimeout(() => {
                for (const part of parts) controller.enqueue(part);
              }, delayMs);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
        } satisfies LanguageModelV4StreamResult);
      },
    }),
    middleware: modelFirstChunkDeadlineMiddleware,
  });
}

function streamPart(
  type: LanguageModelV4StreamPart["type"],
): LanguageModelV4StreamPart {
  switch (type) {
    case "stream-start":
      return { type, warnings: [] };
    case "response-metadata":
      return { type };
    case "text-start":
    case "reasoning-start":
      return { type, id: "part" };
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-delta":
      return { type, id: "part", delta: "x" };
    case "tool-input-start":
      return { type, id: "part", toolName: "tool" };
    case "tool-call":
      return { type, toolCallId: "call", toolName: "tool", input: "{}" };
    case "file":
      return {
        type,
        mediaType: "text/plain",
        data: { type: "data", data: "ZmlsZQ==" },
      };
    case "source":
      return {
        type,
        sourceType: "url",
        id: "source",
        url: "https://example.com",
      };
    default:
      throw new Error(`unsupported test stream part: ${type}`);
  }
}

await test("ссылка в user-сообщении превращается в file-part", () => {
  const [message] = attachVaultImages(
    [userText(`[photo] изображение (vault/${REF}) — приложено.`)],
    { readImage },
  );

  const files = filesOf(message);
  assert.equal(files.length, 1);
  assert.equal(files[0].mediaType, "image/jpeg");
  // filename провайдеры для картинок не читают — его в part нет.
  assert.equal("filename" in files[0], false);
  // Тегированная форма данных — то, что понимает спека провайдера v4.
  assert.deepEqual(files[0].data, { type: "data", data: BYTES });
  // Текст остаётся на месте и идёт ПЕРЕД картинкой.
  const content = (message as { content: { type: string }[] }).content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "file");
});

await test("две одинаковые ссылки дают одну картинку, две разные — две", () => {
  const [same] = attachVaultImages(
    [userText(`vault/${REF}`, `снова vault/${REF}`)],
    { readImage },
  );
  assert.equal(filesOf(same).length, 1);

  const [both] = attachVaultImages(
    [userText(`vault/${REF} и vault/attachments/2026-08-27/scan.png`)],
    { readImage },
  );
  assert.deepEqual(
    filesOf(both).map((f) => f.mediaType),
    ["image/jpeg", "image/png"],
  );
});

await test("чужие роли не трогаем: ссылка в ответе модели остаётся текстом", () => {
  const assistant: Message = {
    role: "assistant",
    content: [{ type: "text", text: `я сохранил vault/${REF}` }],
  };
  const system: Message = { role: "system", content: `vault/${REF}` };

  const prompt = attachVaultImages([system, assistant], { readImage });

  assert.equal(prompt[0], system);
  assert.equal(prompt[1], assistant);
});

await test("нечитаемый файл: сообщение уходит как было, ход не падает", (t) => {
  const logs = muteErrors(t);
  const message = userText(`vault/${REF}`);

  const prompt = attachVaultImages([message], {
    readImage: () => {
      throw new Error("ENOENT");
    },
  });

  assert.equal(prompt[0], message);
  assert.ok(
    logs.some(
      (line) => line.includes(REF) && line.includes("из Vault не прочитал"),
    ),
  );
});

await test("мусорный промпт не роняет middleware", () => {
  const garbage = [
    { role: "user" },
    { role: "user", content: "строка вместо частей" },
    { role: "user", content: [null, { type: "text" }, { type: "file" }] },
    null,
    "не сообщение",
  ] as unknown as Prompt;

  assert.deepEqual(attachVaultImages([], { readImage }), []);
  assert.deepEqual(attachVaultImages(garbage, { readImage }), garbage);
  assert.equal(
    attachVaultImages(undefined as unknown as Prompt, { readImage }),
    undefined,
  );
});

// Альбом Telegram — до десяти кадров, и каждый lead приезжает своим user-сообщением.
// Счётчик ниже этого числа резал бы кадры ТЕКУЩЕГО хода: ни пикселей, ни описания.
await test("все кадры альбома одного хода едут целиком", () => {
  const refs = [1, 2, 3, 4, 5].map(
    (n) => `attachments/2026-08-27/photo-${n}.jpg`,
  );
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    { readImage },
  );

  assert.deepEqual(
    prompt.map((message) => filesOf(message).length),
    [1, 1, 1, 1, 1],
  );
});

// Потолок реплея: запрос идёт на каждом шаге tool-loop, и без потолка история картинок
// переполняет окно. Едут последние MAX_ATTACHED_IMAGES, отрезанные называют себя.
await test("из истории длиннее потолка едут последние картинки", (t) => {
  const logs = muteErrors(t);
  const refs = Array.from(
    { length: MAX_ATTACHED_IMAGES + 2 },
    (_, n) => `attachments/2026-08-27/photo-${n}.jpg`,
  );
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    { readImage },
  );

  const attached = prompt.flatMap((message, index) =>
    filesOf(message).map(() => refs[index]),
  );
  assert.equal(attached.length, MAX_ATTACHED_IMAGES);
  assert.deepEqual(attached, refs.slice(-MAX_ATTACHED_IMAGES));
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some((line) => line.includes(cut) && line.includes("больше")),
      `отрезанная ${cut} не названа`,
    );
});

await test("повторная ссылка считается свежей, а не первой", () => {
  const old = "attachments/2026-08-21/old.jpg";
  const prompt = attachVaultImages(
    [
      userText(`vault/${old}`),
      userText("attachments/2026-08-22/b.jpg"),
      userText("attachments/2026-08-23/c.jpg"),
      userText("attachments/2026-08-24/d.jpg"),
      userText(`снова vault/${old}`),
    ],
    { readImage },
  );

  assert.equal(filesOf(prompt[0]).length, 0, "старое упоминание не приложено");
  assert.equal(filesOf(prompt[4]).length, 1, "последнее упоминание приложено");
});

await test("картинка сверх потолка не едет, соседняя едет", (t) => {
  const logs = muteErrors(t);
  const huge = "attachments/2026-08-27/huge.png";
  const prompt = attachVaultImages(
    [userText(`vault/${REF}`), userText(`vault/${huge}`)],
    {
      readImage: (path) =>
        path === huge ? new Uint8Array(MAX_IMAGE_BYTES + 1) : BYTES,
    },
  );

  assert.equal(filesOf(prompt[1]).length, 0);
  assert.equal(filesOf(prompt[0]).length, 1);
  assert.ok(logs.some((line) => line.includes("больше потолка")));
});

// Бюджет режет ХВОСТ, а не отдельные картинки: иначе выбор зависел бы от того, чей
// размер удачно совпал с остатком, и «средняя выпала, старая пролезла» никто не объяснит.
await test("на исчерпанном бюджете обрывается весь хвост, а не одна картинка", (t) => {
  const logs = muteErrors(t);
  const big = new Uint8Array(MAX_IMAGE_BYTES);
  const refs = ["a", "b", "c"].map((n) => `attachments/2026-08-27/${n}.jpg`);
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    {
      // Мелкая старая картинка формально влезла бы в остаток — и всё равно не едет.
      readImage: (rel) => (rel === refs[0] ? BYTES : big),
    },
  );

  assert.equal(filesOf(prompt[2]).length, 1, "свежая картинка проходит");
  assert.equal(filesOf(prompt[1]).length, 0, "на вторую бюджета уже нет");
  assert.equal(filesOf(prompt[0]).length, 0, "и всё, что старше, тоже не едет");
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some(
        (line) =>
          line.includes(cut) && line.includes("бюджет картинок исчерпан"),
      ),
      `пропуск ${cut} не назван`,
    );
});

// Ход без картинок не должен будить пробник: он ходит в сеть.
await test("промпт без ссылок уходит нетронутым и без похода в сеть", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("middleware не должен спрашивать провайдера");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const params = middlewareParams("привет, что там по задачам?");
  const middleware = attachImagesMiddleware(() => {
    throw new Error("предикат не должен спрашиваться без ссылок");
  });

  const result = await middleware.transformParams?.({
    type: "generate",
    params,
    model: {} as never,
  });

  assert.equal(result, params);
});

// Шов provider ↔ vision: предикат приходит параметром, а не импортом, и его ответ решает,
// дойдёт ли промпт до чтения Vault. Файл тут заведомо нечитаем, поэтому виден ровно шаг
// решения: слепой предикат до чтения не доводит, зрячий — доводит.
await test("предикат решает, дойдёт ли ссылка до чтения картинки", async (t) => {
  const logs = muteErrors(t);
  const ref = `vault/${REF}`;
  const run = (sees: boolean) =>
    attachImagesMiddleware(() => Promise.resolve(sees)).transformParams?.({
      type: "generate",
      params: middlewareParams(`посмотри ${ref}`),
      model: {} as never,
    });
  const readVault = () =>
    logs.some(
      (line) => line.includes(REF) && line.includes("из Vault не прочитал"),
    );

  await run(false);
  assert.equal(
    readVault(),
    false,
    "слепой предикат не доводит до чтения Vault",
  );
  await run(true);
  assert.ok(readVault(), "зрячий предикат доводит промпт до чтения Vault");
});

await test("transient pre-stream 500 errors retry before opening a stream", async () => {
  let calls = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        if (calls < 3) return Promise.reject(providerError(500));
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>(),
        } satisfies LanguageModelV4StreamResult);
      },
    }),
    middleware: transientPreStreamRetryMiddleware({
      retryDelaysMs: [0, 0, 0, 0, 0],
      sleep: noDelay,
    }),
  });
  await model.doStream({ prompt: [] });
  assert.equal(calls, 3);
});

await test("pre-stream 401 and quota 429 errors do not retry", async () => {
  for (const error of [
    providerError(401),
    providerError(429, "quota exceeded"),
  ]) {
    let calls = 0;
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doStream: () => {
          calls += 1;
          return Promise.reject(error);
        },
      }),
      middleware: transientPreStreamRetryMiddleware({
        retryDelaysMs: [0, 0, 0, 0, 0],
        sleep: noDelay,
      }),
    });
    await assert.rejects(
      Promise.resolve(model.doStream({ prompt: [] })),
      (received: unknown) => received === error,
    );
    assert.equal(calls, 1);
  }
});

await test("exhausted pre-stream 503 errors become non-retryable", async () => {
  const error = providerError(503, "Service Unavailable");
  let calls = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return Promise.reject(error);
      },
    }),
    middleware: transientPreStreamRetryMiddleware({
      retryDelaysMs: [0, 0, 0, 0, 0],
      sleep: noDelay,
    }),
  });
  await assert.rejects(
    Promise.resolve(model.doStream({ prompt: [] })),
    (received: unknown) => {
      assert.equal(received, error);
      assert.equal((received as { isRetryable?: boolean }).isRetryable, false);
      return true;
    },
  );
  assert.equal(calls, 6);
});

await test("aborting a pre-stream backoff does not open another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return Promise.reject(providerError(503));
      },
    }),
    middleware: transientPreStreamRetryMiddleware({
      retryDelaysMs: [0, 0, 0, 0, 0],
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    }),
  });
  const pending = Promise.resolve(
    model.doStream({
      prompt: [],
      abortSignal: controller.signal,
    }),
  );
  await waitForImmediate();
  controller.abort(new DOMException("Stopped", "AbortError"));
  await assert.rejects(pending, /Stopped/u);
  assert.equal(calls, 1);
});

await test("an error from an opened stream does not retry", async () => {
  const error = new Error("stream broke after headers");
  let calls = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        calls += 1;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.error(error);
            },
          }),
        } satisfies LanguageModelV4StreamResult);
      },
    }),
    middleware: transientPreStreamRetryMiddleware({
      retryDelaysMs: [0, 0, 0, 0, 0],
      sleep: noDelay,
    }),
  });
  const { stream } = await model.doStream({ prompt: [] });
  await assert.rejects(
    stream.getReader().read(),
    (received: unknown) => received === error,
  );
  assert.equal(calls, 1);
});

await test("метаданные без контента обрываются по deadline и не отравляют сессию", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let providerSignal: AbortSignal | undefined;
  const model = modelWithDelayedParts(
    [streamPart("stream-start")],
    undefined,
    (signal) => {
      providerSignal = signal;
    },
  );
  const { stream } = await model.doStream({ prompt: [] });
  const reader = stream.getReader();

  assert.deepEqual(await reader.read(), {
    done: false,
    value: { type: "stream-start", warnings: [] },
  });
  const pending = reader.read();
  const rejectsWithTimeout = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Model produced no output for 90s/u);
    assert.equal(
      (error as Error & { code?: string }).code,
      "MODEL_FIRST_CHUNK_TIMEOUT",
    );
    assert.equal(classifyModelCallError(error), "recoverable");
    return true;
  });
  t.mock.timers.tick(MODEL_FIRST_CHUNK_TIMEOUT_MS);
  await waitForImmediate();

  await rejectsWithTimeout;
  assert.equal(providerSignal?.aborted, true);
});

await test("поздний ошибочный stream не создаёт unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let resolveProvider!: (result: LanguageModelV4StreamResult) => void;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () =>
        new Promise<LanguageModelV4StreamResult>((resolve) => {
          resolveProvider = resolve;
        }),
    }),
    middleware: modelFirstChunkDeadlineMiddleware,
  });
  const result = Promise.resolve(model.doStream({ prompt: [] }));
  const rejectsWithTimeout = assert.rejects(result, (error: unknown) => {
    assert.equal(
      (error as Error & { code?: string }).code,
      "MODEL_FIRST_CHUNK_TIMEOUT",
    );
    return true;
  });

  await waitForImmediate();
  t.mock.timers.tick(MODEL_FIRST_CHUNK_TIMEOUT_MS);
  await waitForImmediate();
  await rejectsWithTimeout;
  resolveProvider({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        controller.error(new Error("provider stream already failed"));
      },
    }),
  });
  await waitForImmediate();

  assert.deepEqual(unhandled, []);
});

await test("контент до deadline проходит без изменений и снимает таймер", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delta = streamPart("text-delta");
  let providerSignal: AbortSignal | undefined;
  const model = modelWithDelayedParts(
    [delta],
    MODEL_FIRST_CHUNK_TIMEOUT_MS - 1,
    (signal) => {
      providerSignal = signal;
    },
  );
  const { stream } = await model.doStream({ prompt: [] });
  const reader = stream.getReader();
  const pending = reader.read();

  t.mock.timers.tick(MODEL_FIRST_CHUNK_TIMEOUT_MS - 1);
  await waitForImmediate();
  assert.deepEqual(await pending, { done: false, value: delta });
  t.mock.timers.tick(2);
  await waitForImmediate();

  assert.equal(providerSignal?.aborted, false);
  await reader.cancel();
});

const DEADLINE_SEED = 20_260_902;
const metadataPartType = fc.constantFrom<LanguageModelV4StreamPart["type"]>(
  "stream-start",
  "response-metadata",
);
const contentPartType = fc.constantFrom<LanguageModelV4StreamPart["type"]>(
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
  "tool-call",
  "tool-input-start",
  "text-start",
  "reasoning-start",
  "file",
  "source",
);

await test(`deadline зависит только от первого контента (seed ${DEADLINE_SEED})`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.oneof(metadataPartType, contentPartType), {
        maxLength: 12,
      }),
      fc.integer({ min: 0, max: MODEL_FIRST_CHUNK_TIMEOUT_MS + 1 }),
      async (types, firstPartOffset) => {
        const parts = types.map(streamPart);
        const hasContent = types.some((type) =>
          [
            "text-delta",
            "reasoning-delta",
            "tool-input-delta",
            "tool-call",
            "tool-input-start",
            "text-start",
            "reasoning-start",
            "file",
            "source",
          ].includes(type),
        );
        const shouldTimeOut =
          !hasContent || firstPartOffset >= MODEL_FIRST_CHUNK_TIMEOUT_MS;
        const model = modelWithDelayedParts(parts, firstPartOffset);
        const { stream } = await model.doStream({ prompt: [] });
        const reader = stream.getReader();
        const seen: LanguageModelV4StreamPart[] = [];
        let failure: unknown;
        const consuming = (async () => {
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) return;
              seen.push(part.value);
            }
          } catch (error) {
            failure = error;
          }
        })();

        if (firstPartOffset < MODEL_FIRST_CHUNK_TIMEOUT_MS) {
          t.mock.timers.tick(firstPartOffset);
          await waitForImmediate();
          t.mock.timers.tick(MODEL_FIRST_CHUNK_TIMEOUT_MS - firstPartOffset);
        } else {
          t.mock.timers.tick(MODEL_FIRST_CHUNK_TIMEOUT_MS);
        }
        await waitForImmediate();

        if (shouldTimeOut) {
          await consuming;
          assert.equal(
            (failure as Error & { code?: string })?.code,
            "MODEL_FIRST_CHUNK_TIMEOUT",
          );
        } else {
          assert.equal(failure, undefined);
          assert.deepEqual(seen, parts);
          await reader.cancel();
          await consuming;
        }
      },
    ),
    { seed: DEADLINE_SEED, numRuns: 100 },
  );
});

await test("codexFetch вырезает safety_identifier из тела /responses", async (t) => {
  installCodexAuth(t, Date.now());

  const originalFetch = globalThis.fetch;
  let capturedBody: string | undefined;
  const upstream = new Response(JSON.stringify({}), { status: 200 });
  globalThis.fetch = (_input, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : undefined;
    return Promise.resolve(upstream);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await codexFetch(
    new Request(CODEX_RESPONSES_URL, { method: "POST" }),
    {
      body: JSON.stringify({
        store: true,
        previous_response_id: "resp_123",
        safety_identifier: "user-abc",
        input: [],
      }),
    },
  );

  assert.ok(capturedBody !== undefined);
  const body = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal("safety_identifier" in body, false);
  assert.equal("previous_response_id" in body, false);
  assert.equal(body.store, false);
  assert.equal(response, upstream);
});

await test("codexFetch refreshes and retries auth failures once", async (t) => {
  let nowMs = CODEX_FETCH_TEST_EPOCH_MS;
  t.mock.method(Date, "now", () => nowMs);
  const dataDir = installCodexAuth(t, nowMs);
  const originalFetch = globalThis.fetch;
  let backendResponses: Response[] = [];
  let refreshResponses: Response[] = [];
  const backendAuthorizations: string[] = [];
  globalThis.fetch = (input, init) => {
    const isRefresh = requestUrl(input) === TOKEN_URL;
    if (!isRefresh)
      backendAuthorizations.push(
        new Headers(init?.headers).get("Authorization") ?? "",
      );
    const response = (isRefresh ? refreshResponses : backendResponses).shift();
    assert.ok(
      response,
      `unexpected ${isRefresh ? "refresh" : "backend"} request`,
    );
    return Promise.resolve(response);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const resetAuth = (): void => {
    nowMs += 61_000;
    writeAuth(
      {
        access_token: codexAccessToken(nowMs, "stored"),
        refresh_token: "refresh-token",
        accountId: "acc_test",
        planType: "pro",
      },
      dataDir,
    );
    backendAuthorizations.length = 0;
  };
  const refreshed = (): Response =>
    Response.json({ access_token: codexAccessToken(nowMs, "refreshed") });
  const request = (body: BodyInit | null | undefined = "{}") =>
    codexFetch(CODEX_RESPONSES_URL, { method: "POST", body });

  await t.test("token_expired refreshes and the retry succeeds", async () => {
    backendResponses = [
      Response.json({ error: { code: "token_expired" } }, { status: 401 }),
      Response.json({ ok: true }),
    ];
    refreshResponses = [refreshed()];
    assert.equal((await request()).status, 200);
    assert.equal(backendAuthorizations.length, 2);
    assert.notEqual(backendAuthorizations[0], backendAuthorizations[1]);
  });

  await t.test("a second 401 gives recoverable login guidance", async () => {
    resetAuth();
    backendResponses = [
      Response.json({ code: "invalid_token" }, { status: 401 }),
      Response.json({ code: "token_expired" }, { status: 401 }),
    ];
    refreshResponses = [refreshed()];
    await assert.rejects(request(), assertCodexAuthExpired);
    assert.equal(backendAuthorizations.length, 2);
  });

  await t.test("a failed refresh gives the same login guidance", async () => {
    resetAuth();
    backendResponses = [new Response("", { status: 401 })];
    refreshResponses = [new Response("revoked", { status: 401 })];
    await assert.rejects(request(), assertCodexAuthExpired);
    assert.equal(backendAuthorizations.length, 1);
  });

  await t.test(
    "a refresh without access_token does not retry with the old token",
    async () => {
      resetAuth();
      backendResponses = [
        Response.json({ error: { code: "token_expired" } }, { status: 401 }),
      ];
      refreshResponses = [Response.json({})];
      // Пустой ответ токен-эндпоинта — отказ, а не новый вход: бэкенд не должен получить
      // повторный запрос с прежним, уже отвергнутым Bearer.
      await assert.rejects(request(), assertCodexAuthExpired);
      assert.equal(backendAuthorizations.length, 1);
    },
  );

  await t.test("a non-reusable body is not retried", async () => {
    resetAuth();
    const upstream = Response.json(
      { error: { code: "token_expired" } },
      { status: 401 },
    );
    backendResponses = [upstream];
    refreshResponses = [];
    assert.equal(await request(null), upstream);
    assert.equal(backendAuthorizations.length, 1);
  });
});

// --- OpenCode Go: заголовки клиента ----------------------------------------------------------
// Go принимает запрос только со стабильным ID диалога (x-opencode-session) и своим User-Agent;
// без них — 4xx MissingSessionID на каждый ход. Остальные провайдеры заголовков не получают.
// Провайдер выбирается на загрузке модуля, поэтому Go — отдельный экземпляр модуля (query в
// specifier), с чистым окружением и без сети.
const SESSION_HEADER_SEED = 20260910;

type ChatModel = ReturnType<typeof makeTextModelOllama>;
const { makeTextModel: makeTextModelOllama } = await import("./provider.ts");

type ProviderModule = typeof import("./provider.ts");

async function loadOpencodeProvider(): Promise<ProviderModule> {
  const previous = {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  };
  process.env.MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_API_KEY = "sk-test";
  try {
    // Query в specifier даёт отдельный экземпляр модуля; TS такой путь не резолвит,
    // поэтому specifier — переменная, а форма модуля закреплена типом ниже.
    const specifier = "./provider.ts?provider=opencode";
    const loaded: unknown = await import(specifier);
    return loaded as ProviderModule;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Гонит один запрос через модель и возвращает заголовки, которые ушли бы провайдеру. */
async function requestHeadersOf(
  t: TestContext,
  model: ChatModel,
): Promise<Headers> {
  const originalFetch = globalThis.fetch;
  let captured: Headers | undefined;
  globalThis.fetch = (input, init) => {
    captured = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return Promise.resolve(chatCompletion());
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await generateText({ model, prompt: "ping", maxRetries: 0 });
  assert.ok(captured, "запрос к провайдеру не ушёл");
  return captured;
}

await test("Go: запрос несёт ID диалога сессии и User-Agent Ивы", async (t) => {
  const go = await loadOpencodeProvider();
  assert.equal(go.providerName, "opencode");
  const headers = await requestHeadersOf(
    t,
    go.makeTextModel({
      sessionId: "sess_01ABC",
      chatModelSeesImages: blindToImages,
    }),
  );
  assert.equal(headers.get("x-opencode-session"), "sess_01ABC");
  assert.equal(headers.get("user-agent"), go.IVA_USER_AGENT);
  assert.match(go.IVA_USER_AGENT, /^iva\/\d+\.\d+\.\d+/u);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
});

await test("Go без сессии: ID процесса, непустой и один на все вызовы", async (t) => {
  const go = await loadOpencodeProvider();
  const first = await requestHeadersOf(
    t,
    go.makeTextModel({ chatModelSeesImages: blindToImages }),
  );
  const second = await requestHeadersOf(
    t,
    go.makeTextModel({
      sessionId: "  ",
      chatModelSeesImages: blindToImages,
    }),
  );
  const id = first.get("x-opencode-session");
  assert.ok(id && id.length > 0);
  assert.equal(second.get("x-opencode-session"), id);
  assert.equal(id, go.providerRequestHeaders()?.["x-opencode-session"]);
});

await test("не-Go провайдер заголовков Go не шлёт", async (t) => {
  const ollama = await import("./provider.ts");
  assert.equal(ollama.providerName, "ollama");
  assert.equal(ollama.providerRequestHeaders("sess_01ABC"), undefined);
  const headers = await requestHeadersOf(
    t,
    makeTextModelOllama({
      sessionId: "sess_01ABC",
      chatModelSeesImages: blindToImages,
    }),
  );
  assert.equal(headers.get("x-opencode-session"), null);
  assert.notEqual(headers.get("user-agent"), ollama.IVA_USER_AGENT);
});

await test(`ID сессии уходит как есть, пустой заменяется ID процесса (seed ${SESSION_HEADER_SEED})`, async () => {
  const go = await loadOpencodeProvider();
  const processId = go.providerRequestHeaders()?.["x-opencode-session"] ?? "";
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9_:.-]{1,64}$/u), (id) => {
      // Пробелы по краям — не часть ID: заголовок несёт тот же ID, что и без них.
      assert.equal(
        go.providerRequestHeaders(` ${id}\n`)?.["x-opencode-session"],
        id,
      );
      assert.equal(go.providerRequestHeaders(id)?.["x-opencode-session"], id);
    }),
    { seed: SESSION_HEADER_SEED, numRuns: 200 },
  );
  fc.assert(
    fc.property(fc.stringMatching(/^[ \t\r\n\u00a0]{0,8}$/u), (blank) => {
      assert.equal(
        go.providerRequestHeaders(blank)?.["x-opencode-session"],
        processId,
      );
    }),
    { seed: SESSION_HEADER_SEED, numRuns: 50 },
  );
  assert.match(processId, /^iva-[0-9a-f-]{36}$/u);
});

// --- Провайдер отверг схему инструмента: повтор без lookaround-паттернов -----------------------
const { toolSchemaRetryMiddleware, withoutLookaroundPatterns } =
  await import("./provider.ts");
const { APICallError } = await import("ai");

const SCHEMA_REJECTION = new APICallError({
  message:
    "Invalid JSON schema: regex lookaround is not supported. Found at $.properties.attendees.items.pattern.",
  url: "https://chatgpt.com/backend-api/codex/responses",
  requestBodyValues: {},
  statusCode: 400,
  responseBody: '{"error":{"code":"invalid_json_schema","param":"tools"}}',
});

function calendarTools(): LanguageModelV4FunctionTool[] {
  return [
    {
      type: "function" as const,
      name: "create_event",
      inputSchema: {
        type: "object",
        properties: {
          attendees: {
            type: "array",
            items: {
              type: "string",
              pattern: "^(?=.*@).+$",
              description: "email",
            },
          },
          title: { type: "string", pattern: "^[^\\n]+$" },
        },
      },
    },
  ];
}

function modelRejectingSchemaOnce(rejections: Error[]) {
  const calls: unknown[][] = [];
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: (options) => {
        calls.push(options.tools ?? []);
        const next = rejections.shift();
        if (next) return Promise.reject(next);
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue(streamPart("text-start"));
              controller.enqueue(streamPart("text-delta"));
              controller.close();
            },
          }),
        } satisfies LanguageModelV4StreamResult);
      },
    }),
    middleware: toolSchemaRetryMiddleware,
  });
  return { model, calls };
}

void test("a 400 for a tool schema is retried once with the lookaround patterns gone, everything else kept", async () => {
  const { model, calls } = modelRejectingSchemaOnce([SCHEMA_REJECTION]);
  const { stream } = await model.doStream({
    prompt: [],
    tools: calendarTools(),
  });
  await stream.pipeTo(new WritableStream());
  assert.equal(calls.length, 2);
  const retried = calls[1][0] as {
    inputSchema: {
      properties: Record<
        string,
        { items?: Record<string, unknown>; pattern?: string }
      >;
    };
  };
  assert.deepEqual(retried.inputSchema.properties.attendees.items, {
    type: "string",
    description: "email",
  });
  assert.equal(retried.inputSchema.properties.title.pattern, "^[^\\n]+$");
  // Исходные инструменты первого вызова не тронуты: копия, не мутация.
  const first = calls[0][0] as typeof retried;
  assert.equal(
    first.inputSchema.properties.attendees.items?.pattern,
    "^(?=.*@).+$",
  );
});

void test("any other 400, or a schema with nothing to drop, fails fast without a retry", async () => {
  const other = new APICallError({
    message: "Invalid 'input[0].role': expected one of user, assistant",
    url: "https://x",
    requestBodyValues: {},
    statusCode: 400,
  });
  const a = modelRejectingSchemaOnce([other]);
  await assert.rejects(
    () =>
      Promise.resolve(a.model.doStream({ prompt: [], tools: calendarTools() })),
    other,
  );
  assert.equal(a.calls.length, 1);

  const b = modelRejectingSchemaOnce([SCHEMA_REJECTION]);
  const plain: LanguageModelV4FunctionTool[] = [
    {
      ...calendarTools()[0],
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  ];
  await assert.rejects(
    () => Promise.resolve(b.model.doStream({ prompt: [], tools: plain })),
    SCHEMA_REJECTION,
  );
  assert.equal(b.calls.length, 1);
});

// Инвариант вырезания: lookaround-паттернов нет, всё остальное на месте, мусор не роняет.
// Seed печатает fast-check при провале.
void test("property: withoutLookaroundPatterns drops exactly the lookaround patterns and never throws", () => {
  const lookaround = /\(\?<?[=!]/u;
  const pattern = fc.oneof(
    fc.constant("^(?=.*@).+$"),
    fc.constant("(?!x)y"),
    fc.constant("(?<=a)b"),
    fc.constant("(?<!a)b"),
    fc.constant("^[a-z]+$"),
    fc.string({ maxLength: 12 }),
  );
  const schema = fc.letrec((tie) => ({
    node: fc.record(
      {
        type: fc.constantFrom("string", "object", "array"),
        pattern,
        description: fc.string({ maxLength: 8 }),
        items: tie("node"),
        properties: fc.dictionary(fc.string({ maxLength: 5 }), tie("node"), {
          maxKeys: 3,
        }),
      },
      { requiredKeys: [] },
    ),
  })).node;
  const scrub = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, v: unknown) =>
        key === "pattern" && typeof v === "string" && lookaround.test(v)
          ? undefined
          : v,
      ),
    ) as unknown;
  fc.assert(
    fc.property(schema, (input) => {
      const dropped = { count: 0 };
      const out = withoutLookaroundPatterns(input, dropped);
      assert.deepEqual(JSON.parse(JSON.stringify(out)), scrub(input));
      assert.equal(
        dropped.count > 0,
        JSON.stringify(input) !== JSON.stringify(scrub(input)),
      );
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(fc.jsonValue({ maxDepth: 4 }), (garbage) => {
      withoutLookaroundPatterns(garbage);
    }),
    { numRuns: 300 },
  );
});

// --- Codex: инструменты уходят с strict:false, иначе Responses включает строгий режим сам --
const { codexProviderOptions } = await import("./provider.ts");

void test("codex sends every function tool with strict:false and leaves provider tools alone", async () => {
  const out = await codexProviderOptions().transformParams?.({
    type: "stream",
    model: new MockLanguageModelV4(),
    params: {
      prompt: [],
      tools: [
        ...calendarTools(),
        {
          type: "provider",
          id: "openai.web_search",
          name: "web_search",
          args: {},
        },
      ],
    },
  });
  const tools = out?.tools ?? [];
  assert.equal(tools.length, 2);
  assert.equal((tools[0] as { strict?: boolean }).strict, false);
  assert.equal("strict" in tools[1], false);
});

void test("codex without tools still passes: nothing to mark", async () => {
  const out = await codexProviderOptions().transformParams?.({
    type: "stream",
    model: new MockLanguageModelV4(),
    params: { prompt: [] },
  });
  assert.equal(out?.tools, undefined);
});

// SDK решает «рассуждающая ли модель» по префиксу id и незнакомую серию (gpt-6-*) считал бы
// обычной: reasoning выброшен, system вместо developer, encrypted_content не запрошен. Проверка
// на границе SDK — по телу запроса, которое он собрал из наших опций.
void test("codex treats an id the SDK does not know as a reasoning model", async () => {
  let body: Record<string, unknown> = {};
  const openai = createOpenAI({
    apiKey: "test",
    fetch: (_input, init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });
  const model = wrapLanguageModel({
    model: openai.responses("gpt-6-sol"),
    middleware: codexProviderOptions(),
  });
  await generateText({
    model,
    system: "sys",
    prompt: "ok",
    maxRetries: 0,
  }).catch(() => undefined);
  assert.equal(body.model, "gpt-6-sol");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  const roles = (body.input as { role: string }[]).map((item) => item.role);
  assert.deepEqual(roles, ["developer", "user"]);
});

// --- Рассуждение в истории: возвращается там, где вендор его принимает ---------------------
// Решение по вендору — одна строка в MODEL_PROVIDERS. Возврат доказан живьём только у codex
// (gpt-6-sol, 23.09.2026: второй запрос несёт reasoning-item с encrypted_content, ход без 400).
void test("only codex replays reasoning; every other vendor keeps it stripped", () => {
  assert.deepEqual(
    MODEL_PROVIDER_NAMES.filter(
      (name) => MODEL_PROVIDERS[name].replaysReasoning,
    ),
    ["codex"],
  );
});

const REPLAY_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
} as unknown as LanguageModelV4Usage;

type ReasoningBlock = { kind: "reasoning"; deltas: (string | undefined)[] };
type OutputBlock = ReasoningBlock | { kind: "text"; text: string };

function replayStreamModel(blocks: readonly OutputBlock[]) {
  const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
  blocks.forEach((block, index) => {
    const id = `b${index}`;
    if (block.kind === "text") {
      parts.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: block.text },
        { type: "text-end", id },
      );
      return;
    }
    parts.push({ type: "reasoning-start", id });
    for (const delta of block.deltas)
      parts.push(
        delta === undefined
          ? { type: "reasoning-delta", id }
          : { type: "reasoning-delta", id, delta },
      );
    parts.push({ type: "reasoning-end", id });
  });
  parts.push({ type: "finish", finishReason: "stop", usage: REPLAY_USAGE });
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: convertArrayToReadableStream(parts),
      } as unknown as LanguageModelV4StreamResult),
  });
}

function replayGenerateModel(content: unknown[]) {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        finishReason: "stop",
        usage: REPLAY_USAGE,
        content,
        warnings: [],
      } as unknown as LanguageModelV4GenerateResult),
  });
}

function reasoningParts(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "reasoning")
      : [],
  );
}

/** Повторный ход с этой историей: ai@7 валидирует промпт до модели, как на реплее eve. */
async function replays(history: readonly ModelMessage[]) {
  await generateText({
    model: replayGenerateModel([{ type: "text", text: "ок" }]),
    messages: [
      { role: "user", content: "привет" },
      ...history,
      { role: "user", content: "дальше" },
    ],
  });
}

void test("a vendor that replays keeps reasoning in the history and the next turn accepts it", async () => {
  const model = withReplayableReasoning(
    replayStreamModel([
      { kind: "reasoning", deltas: ["думаю", undefined] },
      { kind: "text", text: "ответ" },
    ]),
    true,
  );
  const result = streamText({ model, prompt: "hi" });
  assert.equal(await result.text, "ответ");
  const history = (await result.response).messages;
  assert.deepEqual(
    reasoningParts(history).map((part) => part.text),
    ["думаю"],
  );
  await replays(history);
});

void test("a vendor that does not replay loses reasoning from stream and generate output", async () => {
  const streamed = streamText({
    model: withReplayableReasoning(
      replayStreamModel([
        { kind: "reasoning", deltas: ["думаю"] },
        { kind: "text", text: "ответ" },
      ]),
      false,
    ),
    prompt: "hi",
  });
  assert.equal(await streamed.text, "ответ");
  assert.deepEqual(reasoningParts((await streamed.response).messages), []);

  const generated = await generateText({
    model: withReplayableReasoning(
      replayGenerateModel([
        { type: "reasoning", text: "думаю" },
        { type: "text", text: "привет" },
      ]),
      false,
    ),
    prompt: "hi",
  });
  assert.equal(generated.text, "привет");
  assert.deepEqual(reasoningParts(generated.response.messages), []);
});

// Исходный дефект: deepseek отдавал reasoning-часть без `text`, и ai@7 отвергал реплей всей
// сессии. Такая часть не доходит до истории ни у одного вендора, в generate и в stream.
const REPLAY_SEED = 20_260_923;
const outputBlock: fc.Arbitrary<OutputBlock> = fc.oneof(
  fc.record({
    kind: fc.constant("reasoning" as const),
    deltas: fc.array(fc.option(fc.string(), { nil: undefined }), {
      maxLength: 4,
    }),
  }),
  fc.record({
    kind: fc.constant("text" as const),
    text: fc.string({ minLength: 1 }),
  }),
);

await test(`reasoning without text never reaches the history of any vendor (seed ${REPLAY_SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(outputBlock, { minLength: 1, maxLength: 5 }),
      fc.boolean(),
      async (blocks, replay) => {
        const streamed = streamText({
          model: withReplayableReasoning(replayStreamModel(blocks), replay),
          prompt: "hi",
        });
        await streamed.consumeStream();
        const generated = await generateText({
          model: withReplayableReasoning(
            replayGenerateModel(
              blocks.map((block) =>
                block.kind === "text"
                  ? { type: "text", text: block.text }
                  : block.deltas[0] === undefined
                    ? { type: "reasoning" }
                    : { type: "reasoning", text: block.deltas[0] },
              ),
            ),
            replay,
          ),
          prompt: "hi",
        });
        for (const history of [
          (await streamed.response).messages,
          generated.response.messages,
        ]) {
          const parts = reasoningParts(history);
          if (!replay) assert.deepEqual(parts, []);
          for (const part of parts) assert.equal(typeof part.text, "string");
          await replays(history);
        }
      },
    ),
    { seed: REPLAY_SEED, numRuns: 100 },
  );
});

// Граница SDK codex: рассуждение прошлого шага с encrypted_content едет во второй запрос
// reasoning-item'ом; у вендора без возврата то же рассуждение из промпта вырезается (история,
// записанная до смены вендора в той же сессии).
const replayedHistory: LanguageModelV4Prompt = [
  { role: "user", content: [{ type: "text", text: "сложи" }] },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "",
        providerOptions: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "enc-1" },
        },
      },
      { type: "tool-call", toolCallId: "call_1", toolName: "add", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "add",
        output: { type: "json", value: { sum: 3 } },
      },
    ],
  },
];

async function codexInput(replay: boolean): Promise<unknown[]> {
  let body: Record<string, unknown> = {};
  const openai = createOpenAI({
    apiKey: "test",
    fetch: (_input, init) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  });
  const model = wrapLanguageModel({
    model: openai.responses("gpt-6-sol"),
    middleware: [reasoningReplayMiddleware(replay), codexProviderOptions()],
  });
  // Заглушка отвечает 500: нужен только собранный запрос.
  await assert.rejects(async () =>
    model.doGenerate({ prompt: replayedHistory }),
  );
  return body.input as unknown[];
}

void test("codex sends the previous step's reasoning back as an encrypted item", async () => {
  const input = await codexInput(true);
  assert.deepEqual(
    input.filter((item) => (item as { type?: string }).type === "reasoning"),
    [
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "enc-1",
        summary: [],
      },
    ],
  );
});

void test("a vendor without replay gets no reasoning from an older history", async () => {
  const input = await codexInput(false);
  assert.equal(
    input.some((item) => (item as { type?: string }).type === "reasoning"),
    false,
  );
});

// --- Имена инструментов на проводе: одна граница на всех вендоров ------------------------------
// Имя подключения eve бывает любой длины и алфавита (#240). makeTextModel кодирует его до
// провайдера: у claude — в пределе без префикса mcp__iva__, у остальных — в 64.

async function loadProviderAs(name: string): Promise<ProviderModule> {
  const previous = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = name;
  try {
    const specifier = `./provider.ts?provider=${name}`;
    const loaded: unknown = await import(specifier);
    return loaded as ProviderModule;
  } finally {
    process.env.MODEL_PROVIDER = previous;
  }
}

function namedTool(name: string): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema: { type: "object" } };
}

/** Окружение на время теста: ключи Anthropic увели бы CLI мимо подписки ещё до запуска. */
function claudeTestEnv(t: TestContext, command: string): void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_"))
      delete process.env[key];
  process.env.CLAUDE_COMMAND = command;
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

void test("claude: имя инструмента длиннее 54 символов доходит до запуска CLI", async (t) => {
  assert.equal(MODEL_PROVIDERS.claude.toolNameMax, CLAUDE_TOOL_NAME_MAX);
  const claude = await loadProviderAs("claude");
  const dir = mkdtempSync(join(tmpdir(), "iva-claude-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  claudeTestEnv(t, join(dir, "no-such-claude"));
  const model = claude.makeTextModel({ chatModelSeesImages: blindToImages });
  const name = "eva_sources_runtime__granola__query_granola_meetings_v2";
  assert.ok(name.length > 54 && name.length <= 64);
  let failure: unknown;
  try {
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [namedTool(name)],
    });
    for await (const part of stream)
      if (part.type === "error") failure = part.error;
  } catch (error) {
    failure = error;
  }
  // Имя прошло claudeTools: вызов дошёл до поиска бинаря перед запуском.
  assert.ok(
    failure instanceof Error,
    "вызов без CLI не может кончиться успехом",
  );
  assert.doesNotMatch(failure.message, /tool name/u);
  assert.match(failure.message, /is not found or not executable/u);
});

/**
 * Один шаг модели против заглушки CLI, которая молчит и выходит. Шаг обязан упасть ошибкой CLI:
 * так видно, что CLI запускали, а не что шаг сломался раньше. Рабочая папка к этому моменту
 * уже записана заглушкой.
 */
async function runClaudeStep(
  model: Pick<LanguageModelV4, "doStream">,
): Promise<void> {
  await assert.rejects(async () => {
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    for await (const part of stream) void part;
  }, ClaudeCliError);
}

// Боевой путь один: agent.ts отдаёт makeTextModel id сессии eve, и только он делает папку CLI
// постоянной. Потеряй provider.ts sessionId по дороге — каждый шаг снова пойдёт в новой
// временной папке, блок «# Environment» поменяется и кэш промпта сломается без единой ошибки.
void test("claude: makeTextModel с id сессии запускает оба шага CLI в одной папке сессии", async (t) => {
  const claude = await loadProviderAs("claude");
  const dir = mkdtempSync(join(tmpdir(), "iva-claude-cwd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "cwd.log");
  const command = join(dir, "record-cwd.sh");
  writeFileSync(command, `#!/bin/sh\npwd -P >> '${log}'\n`);
  chmodSync(command, 0o755);
  claudeTestEnv(t, command);
  delete process.env.CLAUDE_SESSION_CWD;
  // Папки сессий — в своём tmp теста, а не в общем tmp того, кто гоняет тесты.
  process.env.TMPDIR = dir;

  for (let step = 0; step < 2; step++)
    await runClaudeStep(
      claude.makeTextModel({
        sessionId: "prov-sess",
        chatModelSeesImages: blindToImages,
      }),
    );

  const cwds = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(cwds.length, 2, "CLI запускался на каждом шаге");
  assert.equal(cwds[1], cwds[0], "второй шаг сессии в той же папке");
  assert.ok(
    !basename(cwds[0]).startsWith("iva-claude-"),
    `шаг ушёл во временную папку шага: ${cwds[0]}`,
  );
});

function sse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")
    .concat("data: [DONE]\n\n");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Запросы, ушедшие провайдеру; `answers` отдаются по очереди. */
function captureRequests(
  t: TestContext,
  answers: (() => Response)[],
): Record<string, unknown>[] {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (_input, init) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return Promise.resolve(answers.shift()!());
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return bodies;
}

const OK_CHUNK = {
  id: "c",
  object: "chat.completion.chunk",
  created: 0,
  model: "test",
  choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
};

void test("повтор после отказа схемы тоже уходит с проводными именами", async (t) => {
  const go = await loadOpencodeProvider();
  const bodies = captureRequests(t, [
    () =>
      Response.json(
        {
          error: {
            message:
              "Invalid JSON schema: regex lookaround is not supported. Found at $.properties.attendees.items.pattern.",
            type: "invalid_request_error",
            param: "tools",
            code: "invalid_json_schema",
          },
        },
        { status: 400 },
      ),
    () => sse([OK_CHUNK]),
  ]);
  const long = `calendar.${"x".repeat(70)}`;
  const [calendar] = calendarTools();
  const model = go.makeTextModel({ chatModelSeesImages: blindToImages });
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ ...calendar, name: long }],
  });
  await stream.pipeTo(new WritableStream());
  assert.equal(bodies.length, 2, "отказ схемы повторён один раз");
  for (const body of bodies) {
    const [sent] = body.tools as { function: { name: string } }[];
    assert.match(sent.function.name, /^[A-Za-z0-9_-]{1,64}$/u);
  }
});

void test("makeTextModel stops repeated failed calls before any provider request", async (t) => {
  const traceDir = mkdtempSync(join(tmpdir(), "iva-provider-repeat-"));
  const previousDataDir = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = traceDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDataDir;
    rmSync(traceDir, { recursive: true, force: true });
  });
  const go = await loadOpencodeProvider();
  const bodies = captureRequests(t, [() => sse([OK_CHUNK])]);
  const model = go.makeTextModel({ chatModelSeesImages: blindToImages });
  const failure = (id: string): LanguageModelV4Prompt => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: id,
          toolName: "read_file",
          input: { path: "missing" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read_file",
          output: { type: "error-text", value: "ENOENT" },
        },
      ],
    },
  ];
  const user: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "прочитай" }] },
  ];
  const stopped = await model.doStream({
    prompt: [...user, ...failure("a"), ...failure("b"), ...failure("c")],
  });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stopped.stream) parts.push(part);
  assert.equal(bodies.length, 0);
  assert.equal(
    parts.find((part) => part.type === "finish")?.finishReason.unified,
    "stop",
  );
  assert.ok(
    parts.some(
      (part) => part.type === "text-delta" && part.delta.includes("read_file"),
    ),
  );

  const passed = await model.doStream({
    prompt: [...user, ...failure("a"), ...failure("b")],
  });
  await passed.stream.pipeTo(new WritableStream());
  assert.equal(bodies.length, 1);
});

// --- Соседние user-сообщения уходят одним ------------------------------------------------------
// Строка времени приходит отдельным user-сообщением перед вводом владельца (#236). Часть
// chat-шаблонов (vLLM, llama.cpp) отвергает две реплики одной роли подряд, поэтому граница
// провайдера склеивает их для всех вендоров.
void test("user-сообщение времени и ввод владельца уходят одним user-сообщением", async (t) => {
  const go = await loadOpencodeProvider();
  const bodies = captureRequests(t, [() => sse([OK_CHUNK])]);
  const model = go.makeTextModel({ chatModelSeesImages: blindToImages });
  const { stream } = await model.doStream({
    prompt: [
      { role: "system", content: "Ты Ива." },
      { role: "user", content: [{ type: "text", text: "раньше" }] },
      { role: "assistant", content: [{ type: "text", text: "ответ" }] },
      { role: "user", content: [{ type: "text", text: "время 10:31" }] },
      { role: "user", content: [{ type: "text", text: "а сейчас?" }] },
    ],
  });
  await stream.pipeTo(new WritableStream());
  const messages = bodies[0].messages as { role: string; content: unknown }[];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(messages[3].content, "время 10:31\n\nа сейчас?");
});

void test("файл между user-текстами остаётся на своём месте", async (t) => {
  const go = await loadOpencodeProvider();
  const bodies = captureRequests(t, [() => sse([OK_CHUNK])]);
  const model = go.makeTextModel({ chatModelSeesImages: blindToImages });
  const { stream } = await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "до" }] },
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "data", data: new Uint8Array([1, 2, 3]) },
            mediaType: "image/png",
          },
          { type: "text", text: "после" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "вопрос" }] },
    ],
  });
  await stream.pipeTo(new WritableStream());
  const messages = bodies[0].messages as { role: string; content: unknown }[];
  assert.equal(messages.length, 1);
  const content = messages[0].content as { type: string; text?: string }[];
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "image_url", "text"],
  );
  assert.equal(content[0].text, "до");
  assert.equal(content[2].text, "после\n\nвопрос");
});

// --- Codex: ключ кэша промпта — ID диалога ----------------------------------------------------
// Без prompt_cache_key бэкенд подписки раскладывает шаги одного диалога по разным машинам кэша,
// и префикс прошлого шага не переиспользуется. Ключ — sessionId eve; без сессии — ID процесса,
// как у x-opencode-session. Проверка по телу, которое уходит в /responses через makeTextModel:
// агент строит модель заново на каждом шаге, ключ обязан совпасть между ними.
const CODEX_CACHE_KEY_SEED = 20260924;

async function codexCacheKeysOf(
  codex: ProviderModule,
  sessionIds: readonly (string | undefined)[],
): Promise<unknown[]> {
  const keys: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (
      requestUrl(input).endsWith("/responses") &&
      typeof init?.body === "string"
    )
      keys.push(
        (JSON.parse(init.body) as Record<string, unknown>).prompt_cache_key,
      );
    return Promise.resolve(new Response("{}", { status: 500 }));
  };
  try {
    for (const sessionId of sessionIds)
      await generateText({
        model: codex.makeTextModel({
          sessionId,
          chatModelSeesImages: blindToImages,
        }),
        prompt: "ping",
        maxRetries: 0,
      }).catch(() => undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return keys;
}

await test(`codex: prompt_cache_key равен sessionId и стабилен между шагами (seed ${CODEX_CACHE_KEY_SEED})`, async (t) => {
  installCodexAuth(t, Date.now());
  const codex = await loadProviderAs("codex");
  assert.equal(codex.providerName, "codex");
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^[A-Za-z0-9_:.-]{1,64}$/u),
      async (sessionId) => {
        // Три шага одной сессии: каждый — новая модель, как в agent.ts на step.started.
        const keys = await codexCacheKeysOf(codex, [
          sessionId,
          sessionId,
          sessionId,
        ]);
        assert.deepEqual(keys, [sessionId, sessionId, sessionId]);
      },
    ),
    { seed: CODEX_CACHE_KEY_SEED, numRuns: 25 },
  );
});

await test("codex без сессии: prompt_cache_key — один ID процесса на все вызовы", async (t) => {
  installCodexAuth(t, Date.now());
  const codex = await loadProviderAs("codex");
  const keys = await codexCacheKeysOf(codex, [undefined, "  ", undefined]);
  assert.equal(keys.length, 3);
  assert.match(String(keys[0]), /^iva-[0-9a-f-]{36}$/u);
  assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
});
