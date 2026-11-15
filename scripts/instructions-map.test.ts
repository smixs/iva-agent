/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Карта agent/instructions.md уходит в system каждого шага модели, и ADR-0014 держит её в
// пределах 5 000 знаков. Правила, которые владелец назвал приоритетом 10.10.2026 («сначала
// ищи сама, потом спрашивай», длинный вывод в файл), держатся якорями: сокращение карты под
// предел не выбрасывает их молча. Лежит в scripts/, а не в agent/instructions/: там eve
// принял бы файл за инструкцию. Здесь же сторожа self-map: описание скилла уходит в каждый
// шаг модели, а рассказ Ивы о себе сверяется с кодом.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { humanizeProviderError } from "../agent/lib/error-humanizer.ts";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MAP = read("agent/instructions.md");
/** Тот же текст одной строкой: перенос строк в markdown смысла не меняет. */
const FLAT_MAP = MAP.replace(/\s+/gu, " ");
/** ADR-0014: предел карты в знаках (владелец, 22.09.2026). */
const MAP_LIMIT = 5_000;

/** Пункт списка карты `- **<title>…` до следующего пункта или раздела, одной строкой. */
function item(title: string): string {
  const start = MAP.indexOf(`- **${title}`);
  assert.notEqual(start, -1, `в карте нет пункта «${title}»`);
  const rest = MAP.slice(start + 2);
  const end = rest.search(/\n(?:- |\n)/u);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/gu, " ");
}

test("the map stays within 5 000 characters (ADR-0014)", () => {
  const length = Array.from(MAP).length;
  assert.ok(
    length <= MAP_LIMIT,
    `agent/instructions.md: ${length} знаков, предел ${MAP_LIMIT}`,
  );
});

test("before a question to the owner the map walks memory, tools and skills, the web, the browser, the server — in that order", () => {
  const rule = item("Find it yourself before you ask");
  let from = 0;
  for (const step of [
    "memory_search",
    "skill",
    "web",
    "browser",
    "`bash`",
    "Ask the owner",
  ]) {
    const at = rule.indexOf(step, from);
    assert.ok(at >= from, `«${step}» выпал из порядка поиска: ${rule}`);
    from = at + step.length;
  }
  assert.match(rule, /say what you checked/u);
  assert.match(rule, /skill library/u);
  // Перегиб в другую сторону: выбор и согласие остаются вопросом владельцу.
  assert.match(rule, /Choices, consent/u);
});

test("long output goes to a file and is read in parts", () => {
  const rule = item("Long output");
  assert.match(rule, /to a file/u);
  assert.match(rule, /read it in parts/u);
});

// Три правила поведения (владелец, 15.11.2026): форма ответа, прерванная работа, проверка факта.
// Карта сжата под предел, поэтому каждое держится якорями.
test("the map carries the answer shape, the interrupted-work rule and the fact check", () => {
  assert.match(FLAT_MAP, /what to do, if anything\./u);
  assert.match(FLAT_MAP, /Delivery goes through this turn's response\./u);
  assert.match(
    FLAT_MAP,
    /In chat talk: answer in 1-4 lines, optional depth in one `<details>` fold \(`rich-replies`\)\. Requested documents and scheduled turns keep their skill's format\./u,
  );
  const interrupt = item("A message that interrupts your work continues it");
  assert.match(interrupt, /another subject or says stop/u);
  assert.match(interrupt, /steps in the history, no restart/u);
  assert.match(interrupt, /one line says what you take into account/u);
  const check = item("Check before you state");
  assert.match(
    check,
    /read its source with a tool this turn, else call it unchecked/u,
  );
  assert.match(
    check,
    /CORE and memory count as read; name the source in a few words/u,
  );
  assert.match(check, /Read messages before compiling tasks/u);
  assert.match(check, /facts already read need no re-read/u);
});

// В фоновом ходе (Watch, Brief, Insight, Reminder) код доставляет текст хода сам: фраза «что
// делаю» там стала бы сообщением владельцу, поэтому правило — только для разговора в чате.
test("the one sentence before a chain of tools is for a chat only", () => {
  assert.match(
    FLAT_MAP,
    /In a chat, before a long chain of tools, say in one short sentence what you are doing\./u,
  );
});

test("the ephemeral goes to todo, tasks or a Reminder, not CORE", () => {
  const memoryMap = read("agent/instructions/10-map.md").replace(/\s+/gu, " ");
  assert.match(
    memoryMap,
    /Do NOT write the ephemeral into CORE[^.]*`todo`[^.]*`tasks` or a Reminder/u,
  );
});

/** Описание self-map до волны 10.10.2026: 356 знаков. Список скиллов уходит в каждый шаг модели. */
const SELF_MAP_DESCRIPTION_LIMIT = 356;
const SELF_MAP = read("agent/skills/self-map/SKILL.md");

test("the self-map description does not grow past its size before 10.10.2026", () => {
  const description = /^description: "(.*)"$/mu.exec(SELF_MAP)?.[1];
  assert.ok(description, "у self-map нет описания");
  const length = Array.from(description).length;
  assert.ok(
    length <= SELF_MAP_DESCRIPTION_LIMIT,
    `описание self-map: ${length} знаков, предел ${SELF_MAP_DESCRIPTION_LIMIT}`,
  );
});

// QA 10.10.2026: self-map обещала кнопку «Повторить» после любого обрыва, а код ставит её
// только на обрыве посреди ответа и без вложения (agent/lib/error-humanizer.ts, midAnswerAsk).
test("self-map promises the «Повторить» button only where the code gives it", () => {
  const flat = SELF_MAP.replace(/\s+/gu, " ");
  assert.match(
    flat,
    /In the middle of the answer: a «Повторить» button [^.]*only for a message without an attachment/u,
  );
  assert.match(flat, /Before the answer began: [^.]*no button\./u);
  fc.assert(
    fc.property(
      fc.constantFrom(
        "terminated",
        "TypeError: fetch failed (ECONNRESET)",
        "AI_APICallError: 502 Bad Gateway",
        "Upstream request failed",
      ),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.string({ maxLength: 200 }),
      (message, answerStarted, media, group, question) => {
        const { en, ru } = humanizeProviderError({
          message,
          details: { attempts: 3, answerStarted },
          question,
          media,
          group,
        });
        // `<` из вопроса владельца цитата меняет на «‹»: кнопку может поставить только код.
        const button = answerStarted && !media;
        assert.equal(ru.includes("<tg-button"), button, ru);
        assert.equal(en.includes("<tg-button"), button, en);
      },
    ),
  );
});
