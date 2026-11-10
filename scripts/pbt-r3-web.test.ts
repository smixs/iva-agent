// Хаос-прогон web_fetch и web_search: редиректы по кругу, не-HTML, обрезка выдачи
// поисковика. Найдено 2026-09-13 маршрутом pbt/deepseek-4-3 (раунд 3).
// Находки R3-1 (объявленный charset игнорируется) и R3-2 (построчный потолок eve рвёт
// суррогат) остаются в ветке pbt/deepseek-4-3: их корень - eve в node_modules, вход для
// правки на стороне eve (см. .scratch/work/tasks/backlog-after-wave.md), здесь не чинятся.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed стоит в имени свойства; при провале fast-check печатает
// `{ seed, path, endOnFailure: true }`, который повторяет прогон байт в байт. Сеть
// подменяется globalThis.fetch, поэтому путь фреймворка проверяется целиком.
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/pbt-deepseek-4-3-2026-09-12.md`.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

// Хук резолвинга идёт первым: тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const traceRoot = tempDir("pbt-r3-web-");
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.env.TAVILY_API_KEY = "test-key";
process.env.SEARCH_PROVIDER = "tavily";

const { default: webFetchTool } = await import("../agent/tools/web_fetch.ts");
const { default: webSearchTool } = await import("../agent/tools/web_search.ts");

const SEED = 20_260_913;
const MAX_ERROR_CHARS = 2_000;

type ToolContext = Parameters<typeof webFetchTool.execute>[1];
const ctx = {
  abortSignal: AbortSignal.timeout(10_000),
} as unknown as ToolContext;

type FetchAnswer = {
  content?: string;
  contentType?: string;
  truncated?: boolean;
  url?: string;
  warning?: string;
  notice?: string;
  error?: string;
};

type SearchHit = { url: string; title: string; snippet: string };
type SearchAnswer = {
  results?: SearchHit[];
  answer?: string;
  warning?: string;
  notice?: string;
  error?: string;
};

function hasLoneSurrogate(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

async function withFetch<T>(
  impl: () => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function fetchPage(
  body: BodyInit | null,
  contentType: string,
): Promise<FetchAnswer> {
  return withFetch(
    () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }),
    () =>
      webFetchTool.execute(
        { url: "https://example.com/page" },
        ctx,
      ) as Promise<FetchAnswer>,
  );
}

async function search(payload: unknown): Promise<SearchAnswer> {
  return withFetch(
    () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () =>
      webSearchTool.execute({ query: "запрос" }, ctx) as Promise<SearchAnswer>,
  );
}

// НАХОДКА R3-3. Обрезка заголовка (200 знаков) и сниппета (500) сделана через
// String.slice: эмодзи на границе разрывается, и выдача поисковика приезжает модели с
// одиноким суррогатом («�» на месте эмодзи).
await test("НАХОДКА R3-3: обрезка заголовка и сниппета не рвёт эмодзи", async () => {
  const result = await search({
    answer: "",
    results: [
      {
        title: `${"a".repeat(199)}😀tail`,
        url: "https://example.com/1",
        content: `${"c".repeat(499)}😀tail`,
      },
    ],
  });
  const hit = result.results?.[0];
  assert.ok(hit);
  assert.equal(hasLoneSurrogate(hit.title), false, "заголовок разорван");
  assert.equal(hasLoneSurrogate(hit.snippet), false, "сниппет разорван");
});

// Лимит считается в знаках, а не в единицах UTF-16: 200 эмодзи — это 200 знаков,
// и обрезки с «…» быть не должно (старый slice оставлял 100 знаков и хвост суррогата).
await test("НАХОДКА R3-3: строка по лимиту в знаках не обрезается", async () => {
  const title = "😀".repeat(200);
  const result = await search({
    results: [{ title, url: "https://example.com/1", content: "сниппет" }],
  });
  const hit = result.results?.[0];
  assert.ok(hit);
  assert.equal(hit.title, title, "заголовок обрезан или перекодирован");
});

await test(`НАХОДКА R3-3: свойство «обрезка выдачи не рвёт суррогат» (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(null), async () => {
      for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
        const result = await search({
          results: [
            {
              title: `${"a".repeat(199 + offset)}😀tail`,
              url: "https://example.com/1",
              content: `${"c".repeat(499 + offset)}😀tail`,
            },
          ],
        });
        const hit = result.results?.[0];
        assert.ok(hit);
        assert.equal(hasLoneSurrogate(hit.title), false, `title ${offset}`);
        assert.equal(hasLoneSurrogate(hit.snippet), false, `snippet ${offset}`);
      }
    }),
    { seed: SEED, numRuns: 3 },
  );
});

// Зелёные controls: мусорные ответы сети не роняют инструменты и не раздувают ошибку.
await test("зелёное: редирект по кругу возвращается ошибкой с адресом, без зависания", async () => {
  let calls = 0;
  const result = await withFetch(
    () => {
      calls += 1;
      return new Response(null, {
        status: 301,
        headers: { location: "https://example.com/loop" },
      });
    },
    () =>
      webFetchTool.execute(
        { url: "https://example.com/page" },
        ctx,
      ) as Promise<FetchAnswer>,
  );
  assert.ok(result.error, JSON.stringify(result));
  assert.match(result.error, /redirect/i);
  assert.ok(result.error.length <= MAX_ERROR_CHARS + 40);
  assert.equal(hasLoneSurrogate(result.error), false);
  assert.ok(calls <= 12, `фреймворк сделал ${calls} запросов`);
});

await test("зелёное: страница больше 5 МБ отбивается ошибкой, а не throw", async () => {
  const result = await fetchPage("x".repeat(6 * 1024 * 1024), "text/plain");
  assert.match(result.error ?? "", /5 MB/);
  assert.equal(hasLoneSurrogate(result.error ?? ""), false);
});

await test("зелёное: не-HTML с битыми байтами доезжает как текст, без throw", async () => {
  const result = await fetchPage(
    new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x41]),
    "application/octet-stream",
  );
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(typeof result.content, "string");
});

await test("зелёное: обычная выдача поиска едет без потерь", async () => {
  const result = await search({
    answer: "короткий ответ",
    results: [
      { title: "Заголовок", url: "https://example.com/1", content: "сниппет" },
    ],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.results, [
    { title: "Заголовок", url: "https://example.com/1", snippet: "сниппет" },
  ]);
  assert.equal(result.answer, "короткий ответ");
});
