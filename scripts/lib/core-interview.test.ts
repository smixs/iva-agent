import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_CAP } from "#lib/core-cap.ts";
import {
  INTERVIEW,
  saveInterview,
  buildDistillMessage,
} from "./core-interview.ts";

// Полный набор ответов на все 6 тем — общий для двух групп тестов.
const QA = [
  { q: "Как обращаться?", a: "Шима, на «ты»" },
  { q: "Чем занимаешься?", a: "Веду ассистента и пару проектов" },
  { q: "Город/ритм?", a: "Ташкент, UTC+5, на связи днём" },
  { q: "Важные люди?", a: "Семья и коллеги по проекту" },
  { q: "Приоритеты?", a: "Допилить меню и релиз" },
  { q: "Что бесит?", a: "Многословие и выдумки" },
];

void test("INTERVIEW — ровно 6 вопросов с id и двумя языками", () => {
  assert.equal(INTERVIEW.length, 6);
  for (const q of INTERVIEW) {
    assert.equal(typeof q.id, "string");
    assert.ok(q.id.length > 0);
    assert.equal(typeof q.text.en, "string");
    assert.equal(typeof q.text.ru, "string");
    assert.ok(q.text.en.length > 0 && q.text.ru.length > 0);
  }
});

void test("saveInterview пишет сырой архив в tmp-vault со всеми ответами", async () => {
  const vault = mkdtempSync(join(tmpdir(), "iva-core-interview-"));
  const file = await saveInterview(vault, QA);
  assert.equal(file, join(vault, "core-interview.md"));
  const md = readFileSync(file, "utf8");
  // Каждый вопрос и каждый ответ должны попасть в архив дословно.
  for (const { q, a } of QA) {
    assert.ok(md.includes(q), `нет вопроса «${q}»`);
    assert.ok(md.includes(a), `нет ответа «${a}»`);
  }
});

void test("saveInterview создаёт отсутствующий каталог vault и перезаписывает файл", async () => {
  const base = mkdtempSync(join(tmpdir(), "iva-core-interview-"));
  const vault = join(base, "nested", "vault"); // ещё не существует
  await saveInterview(vault, [{ q: "первый", a: "старый ответ" }]);
  const file = await saveInterview(vault, [{ q: "второй", a: "новый ответ" }]);
  const md = readFileSync(file, "utf8");
  assert.ok(md.includes("новый ответ"));
  assert.ok(
    !md.includes("старый ответ"),
    "перезапись не затёрла прошлое интервью",
  );
});

void test("saveInterview показывает пропущенный ответ прочерком, не роняясь", async () => {
  const vault = mkdtempSync(join(tmpdir(), "iva-core-interview-"));
  const file = await saveInterview(vault, [{ q: "пропущено", a: "" }]);
  const md = readFileSync(file, "utf8");
  assert.ok(md.includes("пропущено"));
  assert.ok(md.includes("—"));
});

void test("buildDistillMessage (ru) несёт все ответы, лимит CORE_CAP и явное «не выдумывай»", () => {
  const msg = buildDistillMessage(QA, "ru");
  assert.ok(msg.includes("[Настройка core memory]"));
  assert.ok(msg.includes(String(CORE_CAP)), "лимит CORE_CAP не упомянут");
  assert.ok(msg.includes("vault/CORE.md"));
  assert.match(msg, /не выдумывай/);
  for (const { q, a } of QA) {
    assert.ok(msg.includes(q), `нет вопроса «${q}»`);
    assert.ok(msg.includes(a), `нет ответа «${a}»`);
  }
});

void test("buildDistillMessage (en) — английский вариант с тем же лимитом CORE_CAP", () => {
  const msg = buildDistillMessage(QA, "en");
  assert.ok(msg.includes("[Core memory setup]"));
  assert.ok(msg.includes(String(CORE_CAP)));
  assert.ok(msg.includes("vault/CORE.md"));
  assert.match(msg, /make anything up/i);
  for (const { a } of QA) assert.ok(msg.includes(a));
});

void test("buildDistillMessage — незнакомый lang сваливается в русский дефолт", () => {
  const msg = buildDistillMessage(QA, undefined);
  assert.ok(msg.includes("[Настройка core memory]"));
});
