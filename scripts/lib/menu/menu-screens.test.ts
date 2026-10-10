/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import character from "./character.ts";
import search from "./search.ts";
import rich from "./rich.ts";
import voice from "./voice.ts";
// gws.ts импортируем ДИНАМИЧЕСКИ в своём тесте: он считает SECRET_PATH от homedir() при
// загрузке, поэтому HOME переопределяем ДО импорта, чтобы не тронуть реальный ~/.config/gws.

type View = { text: string };
type AwaitText = {
  kind: string;
  secret: boolean;
  data: Record<string, unknown>;
};
type Quiz = { i: number; answers: number[]; code: string | null };
type MenuState = {
  flow: string;
  chatId: number;
  userId: string;
  screen: string;
  page: number;
  awaitText: AwaitText | null;
  data: { quiz?: Quiz };
  msgId: number;
  _last?: View;
};
type MenuContext = {
  deps: Record<string, unknown>;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
    end: (state: MenuState, text: string) => Promise<void>;
  };
  tr: (english: string, russian: string) => string;
  getLang: () => string;
  show: (state: MenuState, screen: string) => Promise<void>;
};
type Screen = {
  render: (state: MenuState, context: MenuContext) => View | Promise<View>;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
  texts?: Record<
    string,
    (
      text: unknown,
      message: unknown,
      state: MenuState,
      context: MenuContext,
    ) => Promise<void>
  >;
};

const characterScreen = character as unknown as Screen;
const searchScreen = search as unknown as Screen;
const richScreen = rich as unknown as Screen;
const voiceScreen = voice as unknown as Screen;

// Кнопка — тег в markdown: подпись и data достаём из строки экрана.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);
const dataOf = (text: string): string[] =>
  buttonsOf(text).map(([, data]) => data);

// ── лёгкий стенд ctx по контракту движка (index.ts), но без самого движка ───────────────
// flows.screen/end пишут в st._last и накапливают рендеры; ctx.show зовёт render модуля из
// переданного реестра. Хватает, чтобы гонять render/on/texts экранов в изоляции.
function makeCtx({
  lang = "ru",
  deps = {},
  screens = {},
}: {
  lang?: string;
  deps?: Record<string, unknown>;
  screens?: Record<string, Screen>;
} = {}) {
  const rendered: Array<{
    kind: "screen" | "end";
    text: string;
  }> = [];
  const harness: {
    ctx: MenuContext;
    rendered: typeof rendered;
    st: MenuState | null;
  } = {
    ctx: undefined as unknown as MenuContext,
    rendered,
    st: null,
  };
  const flows = {
    screen: (st: MenuState, text: string) => {
      st.msgId ??= 1;
      st._last = { text };
      rendered.push({ kind: "screen", text });
      return Promise.resolve();
    },
    end: (st: MenuState, text: string) => {
      st._last = { text };
      rendered.push({ kind: "end", text });
      return Promise.resolve();
    },
    touch: () => {},
  };
  const ctx = {
    deps,
    flows,
    lang,
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    getLang: () => lang,
    show: async (st: MenuState, sid: string) => {
      st.screen = sid;
      const mod = screens[sid];
      if (mod) {
        const v = await mod.render(st, ctx);
        if (v) await flows.screen(st, v.text);
      }
    },
  };
  harness.ctx = ctx;
  return harness;
}

const newState = (over: Partial<MenuState> = {}): MenuState => ({
  flow: "menu",
  chatId: 10,
  userId: "20",
  screen: "r",
  page: 0,
  awaitText: null,
  data: {},
  msgId: 1,
  ...over,
});

// ── 1. character: полный проход 10 ответов через scoreQuiz + apply пишет PERSONA.md ─────
test("character: 10 ответов скорятся через scoreQuiz, apply пишет PERSONA.md", async () => {
  const vault = mkdtempSync(join(tmpdir(), "iva-vault-"));
  process.env.ASSISTANT_VAULT_DIR = vault;
  const h = makeCtx({ lang: "ru", screens: { chr: characterScreen } });
  const st = newState({ screen: "chr" });
  h.st = st;

  // Интро (verb o) — предупреждение + [Начать].
  const intro = characterScreen.render(st, h.ctx) as View;
  assert.match(intro.text, /Характер/);
  assert.ok(dataOf(intro.text).includes("iva_menu:chr:go"));

  // Старт квиза.
  await characterScreen.on("go", [], st, h.ctx);
  assert.equal(st.data.quiz?.i, 0);

  // Гард протухшего даблтапа: ответ не на текущий вопрос игнорируется, i не двигается.
  await characterScreen.on("q", ["5", "0"], st, h.ctx);
  assert.equal(st.data.quiz?.i, 0);

  // Все 10 ответов «да» (индекс 0 = +2) → детерминированно WVPF (Старшая сестра).
  for (let i = 0; i < 10; i++)
    await characterScreen.on("q", [String(i), "0"], st, h.ctx);
  assert.equal(st.data.quiz?.i, 10);
  assert.equal(st.data.quiz?.code, "WVPF");

  // Последний рендер — портрет с именем архетипа и кнопками Принять/Заново.
  assert.match(st._last?.text ?? "", /Старшая сестра/);
  assert.ok(dataOf(st._last?.text ?? "").includes("iva_menu:chr:apply"));

  // apply пишет vault/PERSONA.md: <=800 симв., самодостаточная инструкция с кодом.
  await characterScreen.on("apply", [], st, h.ctx);
  const persona = readFileSync(join(vault, "PERSONA.md"), "utf8");
  assert.ok(persona.length <= 800, `persona ${persona.length} > 800`);
  assert.match(persona, /^# /);
  assert.match(persona, /WVPF/);
  assert.match(st._last?.text ?? "", /со следующего сообщения/);
});

test("character: другой набор ответов даёт другой код (интеграция scoreQuiz)", async () => {
  const h = makeCtx({ lang: "ru", screens: { chr: characterScreen } });
  const st = newState({ screen: "chr" });
  h.st = st;
  await characterScreen.on("go", [], st, h.ctx);
  // Все «нет» (индекс 3 = -2): с реверс-вопросами → DVRF (Эксперт), не зеркало WVPF.
  for (let i = 0; i < 10; i++)
    await characterScreen.on("q", [String(i), "3"], st, h.ctx);
  assert.equal(st.data.quiz?.code, "DVRF");
});

// ── 2. search: render помечает ✓ текущий провайдер и 🔑 провайдеров с ключом ────────────
test("search: render ✓ текущий провайдер и 🔑 наличие ключа на фикстурном .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-"));
  const envPath = join(dir, ".env");
  // brave — текущий (без ключа); tavily — ключ есть, но не текущий.
  writeFileSync(
    envPath,
    "SEARCH_PROVIDER=brave\nTAVILY_API_KEY=tvly-abc12345\n",
  );
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch" });
  h.st = st;

  const view = await searchScreen.render(st, h.ctx);
  const buttonOf = (id: string) =>
    buttonsOf(view.text).find(
      ([, callback]) => callback === `iva_menu:srch:set:${id}`,
    );

  const brave = buttonOf("brave")?.[0];
  const tavily = buttonOf("tavily")?.[0];
  const exa = buttonOf("exa")?.[0];
  assert.ok(brave?.startsWith("✓ "), `brave текущий: ${brave}`);
  assert.ok(!brave?.includes("🔑"), `у brave ключа нет: ${brave}`);
  assert.ok(tavily?.includes("🔑"), `у tavily ключ есть: ${tavily}`);
  assert.ok(!tavily?.startsWith("✓"), `tavily не текущий: ${tavily}`);
  assert.ok(
    exa && !exa.includes("🔑") && !exa.startsWith("✓"),
    `exa без бейджей: ${exa}`,
  );
  // «Сменить ключ» указывает на текущего провайдера.
  assert.ok(dataOf(view.text).includes("iva_menu:srch:key:brave"));
  // Значения ключей нигде в тексте/кнопках.
  assert.ok(!JSON.stringify(view).includes("tvly-abc12345"));
});

test("search: тап по провайдеру без ключа ставит секретный awaitText (в личке)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env2-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "SEARCH_PROVIDER=tavily\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch", chatId: 555 }); // положительный chatId = личка
  h.st = st;
  await searchScreen.on("set", ["brave"], st, h.ctx);
  assert.ok(st.awaitText, "awaitText поставлен");
  assert.equal(st.awaitText.kind, "apikey");
  assert.equal(st.awaitText.secret, true);
  assert.equal(st.awaitText.data.provider, "brave");
});

test("search: inherited property names are never accepted as providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-provider-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "SEARCH_PROVIDER=toString\n");
  const h = makeCtx({
    lang: "en",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { srch: searchScreen },
  });
  const st = newState({ screen: "srch", chatId: 555 });
  h.st = st;

  const view = await searchScreen.render(st, h.ctx);
  const tavily = buttonsOf(view.text).find(
    ([, callback]) => callback === "iva_menu:srch:set:tavily",
  );
  assert.ok(tavily?.[0].startsWith("✓ "));

  await searchScreen.on("set", ["toString"], st, h.ctx);
  assert.equal(st.awaitText, null);

  st.awaitText = {
    kind: "apikey",
    secret: true,
    data: { provider: "toString" },
  };
  await searchScreen.texts?.apikey("abcdefgh", null, st, h.ctx);
  assert.equal(st.awaitText, null);
  assert.match(st._last?.text ?? "", /doesn't look like a key/);
  assert.equal(readFileSync(envPath, "utf8"), "SEARCH_PROVIDER=toString\n");
});

// ── 2b. rich: тумблер TELEGRAM_RICH_REPLIES ───────────────────────────────────────────
test("rich: ✓ на текущем режиме, запись в .env и предложение рестарта", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-rich-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "TELEGRAM_RICH_REPLIES=never\n");
  const restarts: Array<[string, string]> = [];
  const h = makeCtx({
    lang: "ru",
    deps: {
      envPath,
      sc: (action: string, unit: string) => {
        restarts.push([action, unit]);
        return Promise.resolve(true);
      },
    },
    screens: { rich: richScreen },
  });
  const st = newState({ screen: "rich" });
  h.st = st;

  const view = await richScreen.render(st, h.ctx);
  const labelOf = (data: string) =>
    buttonsOf(view.text).find(([, callback]) => callback === data)?.[0];
  assert.ok(labelOf("iva_menu:rich:set:never")?.endsWith("✓"));
  assert.ok(!labelOf("iva_menu:rich:set:auto")?.includes("✓"));

  await richScreen.on("set", ["auto"], st, h.ctx);
  assert.equal(readFileSync(envPath, "utf8"), "TELEGRAM_RICH_REPLIES=auto\n");
  assert.ok(dataOf(st._last?.text ?? "").includes("iva_menu:rich:rs:now"));

  await richScreen.on("rs", ["now"], st, h.ctx);
  assert.deepEqual(restarts, [["restart", "iva.service"]]);
  assert.match(st._last?.text ?? "", /режим ответов активен/);
});

test("rich: кривое значение .env названо на экране и ничем не помечено", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-rich-bad-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "TELEGRAM_RICH_REPLIES=maybe\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { rich: richScreen },
  });
  const st = newState({ screen: "rich" });
  h.st = st;

  const view = await richScreen.render(st, h.ctx);
  assert.match(view.text, /TELEGRAM_RICH_REPLIES=maybe/);
  assert.match(view.text, /не стартует/);
  assert.ok(!view.text.includes("✓"), "✓ не выдуман при кривом значении");
  // Переключатель всё равно на месте: этим экраном значение и чинится.
  assert.deepEqual(dataOf(view.text).sort(), [
    "iva_menu:r:o",
    "iva_menu:rich:set:auto",
    "iva_menu:rich:set:never",
  ]);
});

// ── 2c. voice: ключ Deepgram и язык распознавания ─────────────────────────────────────
test("voice: ключ принимается в личке, пишется в .env, язык переключается", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "DEEPGRAM_LANGUAGE=ru\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });
  const st = newState({ screen: "voice", chatId: 555 }); // положительный chatId = личка
  h.st = st;

  const view = await voiceScreen.render(st, h.ctx);
  assert.match(view.text, /Ключ Deepgram: нет/);
  assert.match(view.text, /Без ключа голосовые не распознаются/);
  assert.match(view.text, /Язык: Русский/);
  assert.ok(
    buttonsOf(view.text)
      .find(([, callback]) => callback === "iva_menu:voice:lang:ru")?.[0]
      .endsWith("✓"),
  );

  await voiceScreen.on("key", [], st, h.ctx);
  assert.equal(st.awaitText?.kind, "deepgramkey");
  assert.equal(st.awaitText?.secret, true);

  const key = "dg-abcdef1234567890";
  await voiceScreen.texts?.deepgramkey(key, null, st, h.ctx);
  assert.equal(st.awaitText, null);
  assert.match(
    readFileSync(envPath, "utf8"),
    /DEEPGRAM_API_KEY=dg-abcdef1234567890/,
  );
  assert.ok(dataOf(st._last?.text ?? "").includes("iva_menu:voice:rs:now"));
  assert.ok(
    h.rendered.every(({ text }) => !text.includes(key)),
    "значение ключа не попало ни в один экран",
  );

  await voiceScreen.on("lang", ["uz"], st, h.ctx);
  assert.match(readFileSync(envPath, "utf8"), /DEEPGRAM_LANGUAGE=uz/);
  await voiceScreen.on("rs", ["later"], st, h.ctx);
  assert.match(st._last?.text ?? "", /после перезапуска/);
});

test("voice: в группе ключ не принимается, а мусор вместо ключа снимает ожидание", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-bad-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });

  // Группа (отрицательный chatId): секрет не принимаем, ожидание не ставим.
  const group = newState({ screen: "voice", chatId: -100500 });
  await voiceScreen.on("key", [], group, h.ctx);
  assert.equal(group.awaitText, null);
  assert.match(group._last?.text ?? "", /личн/i);

  // Личка: вместо ключа пришёл обычный текст — ожидание снято, .env не тронут.
  const priv = newState({ screen: "voice", chatId: 555 });
  await voiceScreen.on("key", [], priv, h.ctx);
  assert.ok(priv.awaitText);
  await voiceScreen.texts?.deepgramkey("это не ключ", null, priv, h.ctx);
  assert.equal(priv.awaitText, null);
  assert.match(priv._last?.text ?? "", /не приму/);
  assert.equal(readFileSync(envPath, "utf8"), "");

  // Смена языка уводит с приглашения вводить ключ: ожидание снимается, и следующий
  // обычный текст владельца не съедается как ключ.
  await voiceScreen.on("key", [], priv, h.ctx);
  assert.ok(priv.awaitText);
  await voiceScreen.on("lang", ["ru"], priv, h.ctx);
  assert.equal(priv.awaitText, null);
});

test("voice: имена и термины пишутся в .env одной строкой, «-» и пустой список очищают", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-terms-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "DEEPGRAM_LANGUAGE=ru\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });
  const st = newState({ screen: "voice", chatId: 555 });
  h.st = st;

  const view = await voiceScreen.render(st, h.ctx);
  assert.match(view.text, /Имена и термины: нет\./);
  assert.ok(dataOf(view.text).includes("iva_menu:voice:terms"));

  // Кнопка ставит ожидание текста; список не секрет — движок его не удаляет.
  await voiceScreen.on("terms", [], st, h.ctx);
  assert.equal(st.awaitText?.kind, "deepgramkeyterms");
  assert.equal(st.awaitText?.secret, false);
  assert.match(st._last?.text ?? "", /Сейчас: нет\./);

  // Пробелы по краям, лишние запятые, повтор и перевод строки — в .env чистый список.
  await voiceScreen.texts?.deepgramkeyterms(
    " OJ, Sonnet,,OJ ,\nTodoist ,",
    null,
    st,
    h.ctx,
  );
  assert.equal(st.awaitText, null);
  assert.equal(
    readFileSync(envPath, "utf8"),
    "DEEPGRAM_LANGUAGE=ru\nDEEPGRAM_KEYTERMS=OJ,Sonnet,Todoist\n",
  );
  assert.match(st._last?.text ?? "", /Имена и термины: OJ, Sonnet, Todoist\./);
  assert.ok(dataOf(st._last?.text ?? "").includes("iva_menu:voice:rs:now"));
  assert.match(
    (await voiceScreen.render(st, h.ctx)).text,
    /Имена и термины: OJ, Sonnet, Todoist\./,
  );
  await voiceScreen.on("terms", [], st, h.ctx);
  assert.match(st._last?.text ?? "", /Сейчас: OJ, Sonnet, Todoist\./);

  // «-» убирает строку целиком, соседние настройки не тронуты.
  await voiceScreen.texts?.deepgramkeyterms("-", null, st, h.ctx);
  assert.equal(st.awaitText, null);
  assert.equal(readFileSync(envPath, "utf8"), "DEEPGRAM_LANGUAGE=ru\n");
  assert.match(st._last?.text ?? "", /Список очищен/);

  // Пустой ввод и одни запятые — тоже очистка.
  for (const empty of ["", " , ,, "]) {
    await voiceScreen.texts?.deepgramkeyterms("Iva", null, st, h.ctx);
    assert.match(readFileSync(envPath, "utf8"), /DEEPGRAM_KEYTERMS=Iva/);
    await voiceScreen.on("terms", [], st, h.ctx);
    await voiceScreen.texts?.deepgramkeyterms(empty, null, st, h.ctx);
    assert.equal(
      readFileSync(envPath, "utf8"),
      "DEEPGRAM_LANGUAGE=ru\n",
      JSON.stringify(empty),
    );
  }
});

test("voice: кириллицу и знаки, которых .env не хранит, список не пишет; 60 слов — первые 50", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-terms-bad-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "DEEPGRAM_KEYTERMS=OJ\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });
  const st = newState({ screen: "voice", chatId: 555 });
  h.st = st;

  for (const [input, reason] of [
    ["OJ, Оджей", /кириллица/],
    ["C#, Sonnet", /знак, которого файл настроек не хранит/],
    ['say "hi"', /знак, которого файл настроек не хранит/],
  ] as const) {
    await voiceScreen.on("terms", [], st, h.ctx);
    await voiceScreen.texts?.deepgramkeyterms(input, null, st, h.ctx);
    assert.equal(st.awaitText, null, input);
    assert.match(st._last?.text ?? "", reason);
    assert.ok(!(st._last?.text ?? "").includes(input), "ввод не эхом");
    assert.ok(dataOf(st._last?.text ?? "").includes("iva_menu:voice:terms"));
    assert.equal(readFileSync(envPath, "utf8"), "DEEPGRAM_KEYTERMS=OJ\n");
  }

  const words = Array.from({ length: 60 }, (_, i) => `Term${i}`);
  await voiceScreen.on("terms", [], st, h.ctx);
  await voiceScreen.texts?.deepgramkeyterms(words.join(", "), null, st, h.ctx);
  assert.equal(
    readFileSync(envPath, "utf8"),
    `DEEPGRAM_KEYTERMS=${words.slice(0, 50).join(",")}\n`,
  );
  assert.match(st._last?.text ?? "", /Оставил первые 50 из 60/);
});

// Лимит Deepgram — 500 токенов на все keyterm запроса, сверх него отказ получает весь запрос и
// каждое голосовое остаётся без расшифровки. Абзац без запятых — одно слово, и счёт слов его
// не останавливает; меню сохраняет только то, что войдёт в запрос.
test("voice: абзац без запятых не сохраняется, длинный список обрезан по 500 байт", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-terms-bytes-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "DEEPGRAM_KEYTERMS=OJ\n");
  const h = makeCtx({
    lang: "ru",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });
  const st = newState({ screen: "voice", chatId: 555 });
  h.st = st;

  const paragraph = Array.from({ length: 600 }, () => "word").join(" ");
  await voiceScreen.on("terms", [], st, h.ctx);
  await voiceScreen.texts?.deepgramkeyterms(paragraph, null, st, h.ctx);
  assert.equal(st.awaitText, null);
  assert.equal(readFileSync(envPath, "utf8"), "DEEPGRAM_KEYTERMS=OJ\n");
  const refused = st._last?.text ?? "";
  assert.match(refused, /до 500 знаков имён вместе/);
  assert.ok(!refused.includes("word word"), "ввод не эхом");
  assert.ok(dataOf(refused).includes("iva_menu:voice:terms"));
  assert.ok(!dataOf(refused).includes("iva_menu:voice:rs:now"));

  // Пять слов по 100 знаков — ровно 500; дальше не пишем и говорим об этом.
  const hundred = Array.from({ length: 8 }, (_, i) => `${"x".repeat(99)}${i}`);
  await voiceScreen.on("terms", [], st, h.ctx);
  await voiceScreen.texts?.deepgramkeyterms(
    hundred.join(", "),
    null,
    st,
    h.ctx,
  );
  assert.equal(
    readFileSync(envPath, "utf8"),
    `DEEPGRAM_KEYTERMS=${hundred.slice(0, 5).join(",")}\n`,
  );
  assert.match(st._last?.text ?? "", /Оставил первые 5 из 8/);
});

test("voice: список из .env на экране экранирован и обрезан по длине", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-env-voice-terms-long-"));
  const envPath = join(dir, ".env");
  const long = Array.from({ length: 80 }, (_, i) => `LongName${i}`);
  writeFileSync(envPath, `DEEPGRAM_KEYTERMS=a<b>*c*,${long.join(",")}\n`);
  const h = makeCtx({
    lang: "en",
    deps: { envPath, sc: () => Promise.resolve(true) },
    screens: { voice: voiceScreen },
  });
  const st = newState({ screen: "voice", chatId: 555 });
  const { text } = await voiceScreen.render(st, h.ctx);
  const line = text
    .split("\n")
    .find((row) => row.startsWith("Names and terms:"));
  assert.ok(line, text);
  // Разметка из значения не исполняется: escapeRichText ставит перед ней обратный слэш.
  assert.ok(line.includes("a\\<b>\\*c\\*"), line);
  assert.ok(line.length < 400, `${line.length}`);
  assert.match(line, /… \(81\)\.$/);
});

// ── 3. gws: валидация shape client_secret.json (bad JSON / неверная форма / успех 0600) ──
test("gws.gwsjson: bad JSON и неверная форма отвергаются, валидный секрет пишется 0600", async () => {
  const home = mkdtempSync(join(tmpdir(), "iva-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home; // до импорта — SECRET_PATH возьмёт этот homedir
  const gws = (await import("./gws.ts")).default as unknown as Screen;
  const h = makeCtx({ lang: "ru", screens: { gws } });
  const st = newState({
    screen: "gws",
    awaitText: { kind: "gwsjson", secret: true, data: {} },
  });
  h.st = st;
  const fakeMsg = (id: number) => ({ chat: { id: 10 }, message_id: id });

  // Невалидный JSON → повтор-приглашение, awaitText не снят, файла нет.
  await gws.texts?.gwsjson("не json {", fakeMsg(1), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после битого JSON");
  assert.match(st._last?.text ?? "", /JSON/i);

  // JSON-примитив синтаксически валиден, но не проходит отдельную проверку формы.
  await gws.texts?.gwsjson("null", fakeMsg(2), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после JSON-примитива");
  assert.match(st._last?.text ?? "", /client_secret/);

  // Валидный JSON, но не client_secret (нет installed/web с client_id).
  await gws.texts?.gwsjson(JSON.stringify({ foo: 1 }), fakeMsg(3), st, h.ctx);
  assert.ok(st.awaitText, "awaitText сохранён после неверной формы");
  assert.match(st._last?.text ?? "", /client_secret/);

  // Корректный client_secret.json (Desktop app: installed + client_id).
  const secret = JSON.stringify({
    installed: {
      client_id: "abc.apps.googleusercontent.com",
      client_secret: "shhh",
      redirect_uris: ["http://localhost"],
    },
  });
  await gws.texts?.gwsjson(secret, fakeMsg(4), st, h.ctx);
  assert.equal(st.awaitText, null, "awaitText снят при успехе");
  const path = join(home, ".config/gws/client_secret.json");
  assert.ok(existsSync(path), "client_secret.json записан");
  assert.equal(statSync(path).mode & 0o777, 0o600, "права 0600");
  assert.equal(readFileSync(path, "utf8"), secret);

  chmodSync(path, 0o644);
  const replacement = JSON.stringify({
    installed: { client_id: "replacement.apps.googleusercontent.com" },
  });
  st.awaitText = { kind: "gwsjson", secret: true, data: {} };
  await gws.texts?.gwsjson(replacement, fakeMsg(5), st, h.ctx);
  assert.equal(readFileSync(path, "utf8"), replacement);
  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    "replacement restores strict mode before publishing",
  );

  process.env.HOME = prevHome;
});
