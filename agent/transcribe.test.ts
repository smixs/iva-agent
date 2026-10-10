// Запрос к Deepgram на проводе: адрес, который уходит в fetch, при разных DEEPGRAM_KEYTERMS.
// Сеть подменена: fetch записывает адрес и заголовки и отвечает готовой расшифровкой.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";

import {
  KEYTERMS_BYTES,
  KEYTERMS_LIMIT,
  parseKeyterms,
  transcribe,
} from "./transcribe.ts";

const BASE =
  "https://api.deepgram.com/v1/listen?model=nova-3&language=multi&punctuate=true&smart_format=true";
const KEYTERMS_SEED = 20_261_010;

type Sent = { url: string; init: RequestInit };

/**
 * Окружение Deepgram задано тестом целиком (хостовые DEEPGRAM_* не просачиваются), fetch
 * записывает каждый запрос, console.warn — каждую строку журнала. Всё возвращается в t.after.
 * Возвращает отправку: один вызов transcribe с этим значением настройки (undefined — настройки
 * нет вовсе) и то, что ушло на провод и в журнал за этот вызов.
 */
function wire(t: TestContext) {
  const names = [
    "DEEPGRAM_API_KEY",
    "DEEPGRAM_LANGUAGE",
    "DEEPGRAM_KEYTERMS",
  ] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.DEEPGRAM_API_KEY = "dg-test";
  delete process.env.DEEPGRAM_LANGUAGE;
  const sent: Sent[] = [];
  const warnings: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: "привет" }] }] },
        }),
      ),
    );
  });
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  return async (keyterms: string | undefined) => {
    if (keyterms === undefined) delete process.env.DEEPGRAM_KEYTERMS;
    else process.env.DEEPGRAM_KEYTERMS = keyterms;
    const before = { sent: sent.length, warnings: warnings.length };
    assert.equal(await transcribe(new ArrayBuffer(4)), "привет");
    assert.equal(sent.length, before.sent + 1);
    const { url, init } = sent[sent.length - 1];
    return { url, init, warnings: warnings.slice(before.warnings) };
  };
}

const urlFor = (t: TestContext, keyterms: string | undefined) =>
  wire(t)(keyterms);

await test("без DEEPGRAM_KEYTERMS запрос прежний байт в байт", async (t) => {
  const { url, init, warnings } = await urlFor(t, undefined);
  assert.equal(url, BASE);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    Authorization: "Token dg-test",
    "Content-Type": "application/octet-stream",
  });
  assert.deepEqual(warnings, []);
});

await test("пустое значение и одни запятые с пробелами — тоже прежний запрос", async (t) => {
  const send = wire(t);
  for (const raw of ["", "   ", ",", " , ,, ,"]) {
    const { url, warnings } = await send(raw);
    assert.equal(url, BASE, JSON.stringify(raw));
    assert.deepEqual(warnings, []);
  }
});

await test("одно слово — один keyterm в конце запроса", async (t) => {
  const { url } = await urlFor(t, "OJ");
  assert.equal(url, `${BASE}&keyterm=OJ`);
});

await test("три слова — три keyterm в порядке владельца", async (t) => {
  const { url } = await urlFor(t, "OJ,Sonnet,Todoist");
  assert.equal(url, `${BASE}&keyterm=OJ&keyterm=Sonnet&keyterm=Todoist`);
});

await test("кириллица и пробел внутри фразы кодируются, края обрезаются", async (t) => {
  const { url } = await urlFor(t, " Оджей ,  Claude Code ");
  assert.equal(
    url,
    `${BASE}&keyterm=%D0%9E%D0%B4%D0%B6%D0%B5%D0%B9&keyterm=Claude%20Code`,
  );
  assert.deepEqual(new URL(url).searchParams.getAll("keyterm"), [
    "Оджей",
    "Claude Code",
  ]);
});

// Кусок без единой буквы и цифры — не имя: Deepgram нечего писать, а «-» в меню — знак очистки.
await test("кусок без букв и цифр не уходит: «-», «--», «...», тире", async (t) => {
  const send = wire(t);
  for (const raw of ["-", "–", "—", "--", "...", " - , -- "]) {
    const { url, warnings } = await send(raw);
    assert.equal(url, BASE, JSON.stringify(raw));
    assert.deepEqual(warnings, []);
  }
  const { url } = await send("-, OJ, --, ..., C++, —, 42");
  assert.deepEqual(new URL(url).searchParams.getAll("keyterm"), [
    "OJ",
    "C++",
    "42",
  ]);
});

await test("повторы и лишние запятые выброшены", async (t) => {
  const { url } = await urlFor(t, ",OJ,, OJ ,Sonnet,,OJ,");
  assert.equal(url, `${BASE}&keyterm=OJ&keyterm=Sonnet`);
});

await test("слово с & и = не дописывает в запрос свои параметры", async (t) => {
  const { url } = await urlFor(t, "a&model=nova-2&language=en,b#c?d");
  const params = new URL(url).searchParams;
  assert.deepEqual(params.getAll("model"), ["nova-3"]);
  assert.deepEqual(params.getAll("language"), ["multi"]);
  assert.deepEqual(params.getAll("keyterm"), [
    "a&model=nova-2&language=en",
    "b#c?d",
  ]);
});

await test("60 слов — в запросе первые 50 и одна строка в журнале без самих слов", async (t) => {
  const words = Array.from({ length: 60 }, (_, i) => `Term${i}`);
  const { url, warnings } = await urlFor(t, words.join(","));
  assert.equal(KEYTERMS_LIMIT, 50);
  assert.deepEqual(
    new URL(url).searchParams.getAll("keyterm"),
    words.slice(0, 50),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DEEPGRAM_KEYTERMS: в запрос идут 50 из 60/u);
  assert.ok(!warnings[0].includes("Term"), "слова в журнал не попали");
});

await test("ровно 50 слов — все в запросе, журнал молчит", async (t) => {
  const words = Array.from({ length: 50 }, (_, i) => `Name${i}`);
  const { url, warnings } = await urlFor(t, words.join(","));
  assert.deepEqual(new URL(url).searchParams.getAll("keyterm"), words);
  assert.deepEqual(warnings, []);
});

// Лимит Deepgram — 500 токенов на все keyterm запроса; сверх него отказ получает весь запрос,
// и голосовое остаётся без расшифровки. Длинный кусок без запятых — одно слово, и число
// слов его не останавливает.
await test("абзац без запятых длиннее 500 байт не уходит: запрос прежний, в журнале счёт", async (t) => {
  const paragraph = Array.from({ length: 600 }, () => "word").join(" ");
  const { url, warnings } = await urlFor(t, paragraph);
  assert.equal(url, BASE);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DEEPGRAM_KEYTERMS: в запрос идут 0 из 1/u);
  assert.ok(!warnings[0].includes("word"), "слова в журнал не попали");
});

await test("слова вместе не длиннее 500 байт UTF-8: 500 входит, 501 обрывает, кириллица по два байта", async (t) => {
  const send = wire(t);
  const keyterms = (url: string) => new URL(url).searchParams.getAll("keyterm");
  assert.equal(KEYTERMS_BYTES, 500);

  const exact = ["a".repeat(250), "b".repeat(250)];
  assert.deepEqual(keyterms((await send(exact.join(","))).url), exact);
  const over = ["a".repeat(250), "b".repeat(251), "c"];
  const cut = await send(over.join(","));
  assert.deepEqual(keyterms(cut.url), [over[0]]);
  assert.match(cut.warnings[0], /в запрос идут 1 из 3/u);

  // Пять слов по 100 байт — ровно 500, шестое и дальше не идут.
  const hundred = Array.from({ length: 8 }, (_, i) => `${"x".repeat(99)}${i}`);
  assert.deepEqual(
    keyterms((await send(hundred.join(","))).url),
    hundred.slice(0, 5),
  );

  // Кириллическая буква — два байта: 30 слов по 10 букв (20 байт) — в запрос 25.
  const letters = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
  const cyrillic = Array.from(
    { length: 30 },
    (_, i) => `${"Ж".repeat(9)}${letters[i]}`,
  );
  assert.deepEqual(
    keyterms((await send(cyrillic.join(","))).url),
    cyrillic.slice(0, 25),
  );
});

// Значение собирается из чистых слов (произвольный текст: &, =, #, %, кириллица, эмодзи;
// короткие латинские; длинные латинские) и шума: пробелы и табуляции по краям, пустые куски,
// повторы. Разобранный обратно адрес обязан нести ровно первые различные чистые слова, пока
// их не больше 50 и вместе не больше 500 байт UTF-8, прежние параметры — по одному разу, а
// начало адреса — прежним.
const graphemeTerm = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
  .map((text) => text.replace(/[,\n]/gu, "").trim())
  .filter((text) => text.length > 0);
const shortTerm = fc.stringMatching(/^[a-z]{1,3}$/u);
const longTerm = fc.stringMatching(/^[A-Za-z]{40,120}$/u);
const pad = fc.constantFrom("", " ", "  ", "\t");
// term — слово, которое кусок несёт; null — кусок из одного шума.
type Piece = { term: string | null; text: string };
const pieceOf = (term: fc.Arbitrary<string>): fc.Arbitrary<Piece> =>
  fc.oneof(
    fc.tuple(pad, term, pad).map(([left, word, right]) => ({
      term: word,
      text: `${left}${word}${right}`,
    })),
    pad.map((text) => ({ term: null, text })),
  );
// Прогон берёт один набор слов: одни короткие — больше 50 разных раньше 500 байт; вперемешку —
// 500 байт раньше 50 слов. Кусок, выпавший парой, — повтор того же слова подряд. size "max":
// без него fast-check тянет массивы не длиннее 10 и ни до одной границы не доходит.
const pieces = fc
  .constantFrom(shortTerm, fc.oneof(graphemeTerm, shortTerm, longTerm))
  .chain((term) =>
    fc.array(
      fc.oneof(
        pieceOf(term).map((p) => [p]),
        pieceOf(term).map((p) => [p, p]),
      ),
      { maxLength: 120, size: "max" },
    ),
  )
  .map((drawn) => drawn.flat());

// Ожидание пересказано независимо от кода: первые различные слова хотя бы с одной буквой или
// цифрой, пока их не больше 50 и вместе не больше 500 байт UTF-8.
function firstThatFit(terms: string[]): string[] {
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  for (const term of new Set(terms)) {
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    bytes += encoder.encode(term).length;
    if (kept.length === 50 || bytes > 500) break;
    kept.push(term);
  }
  return kept;
}

await test(`адрес на проводе разбирается обратно в те же слова (seed ${KEYTERMS_SEED})`, async (t) => {
  const send = wire(t);
  await fc.assert(
    fc.asyncProperty(pieces, async (drawn) => {
      const { url } = await send(drawn.map(({ text }) => text).join(","));
      assert.ok(url.startsWith(BASE), url);
      const expected = firstThatFit(
        drawn.flatMap(({ term }) => (term === null ? [] : [term])),
      );
      const params = new URL(url).searchParams;
      assert.deepEqual(params.getAll("keyterm"), expected);
      for (const name of ["model", "language", "punctuate", "smart_format"])
        assert.equal(params.getAll(name).length, 1, name);
    }),
    { seed: KEYTERMS_SEED, numRuns: 200 },
  );
});

await test("parseKeyterms: запятая и перевод строки разделяют, порядок первого вхождения", () => {
  assert.deepEqual(parseKeyterms(undefined), []);
  assert.deepEqual(parseKeyterms("OJ\nSonnet, OJ\n\n,Todoist"), [
    "OJ",
    "Sonnet",
    "Todoist",
  ]);
});

// Канон CONTEXT.md: у верхней границы расхода имя Ceiling (предел), у провайдера — лимит;
// «потолок», «бюджет» и «quota» стоят в её _Avoid_ и не идут ни в код, ни в комментарии.
await test("код имён и терминов не берёт слов из _Avoid_ записи Ceiling", () => {
  for (const file of ["./transcribe.ts", "../scripts/lib/menu/voice.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /потол|бюджет|quota/iu, file);
  }
});
