// Регрессия 22.09: ночной роллап сжимает CORE.md, детектор coreDamage принимал
// переформулировку заголовка за «потерю секции» и откатывал файл (ложный алерт
// «Приватность на скринах» никуда не делась). Переформулированный заголовок — это
// НЕ потеря: ночной ход имеет право ужать имя секции.
import test from "node:test";
import assert from "node:assert/strict";
import { coreDamage } from "./core-clamp.ts";

test("a rephrased heading is a rename, not a lost section", () => {
  const before = [
    "## Приватность на скринах (финальный стандарт 2026-09-01)",
    "- Текст → чёрный прямоугольник",
    "## Указатели",
    "- Последний день: summaries/daily/2026-09-21",
  ].join("\n");
  const after = [
    "## Приватность на скринах (правило ВЛАДЕЛЬЦА, 2026-09-01)",
    "- Текст → чёрный прямоугольник",
    "## Указатели",
    "- Последний день: summaries/daily/2026-09-21",
  ].join("\n");
  const damage = coreDamage(before, after);
  assert.deepEqual(damage.lostHeadings, []);
  assert.deepEqual(damage.hollowedHeadings, []);
  assert.equal(damage.damaged, false);
});

test("a genuinely dropped section is still detected", () => {
  const before = [
    "## Пользователь",
    "- Станислав",
    "## Указатели",
    "- Последний день: summaries/daily/2026-09-21",
  ].join("\n");
  const after = [
    "## Пользователь",
    "- Станислав",
  ].join("\n");
  const damage = coreDamage(before, after);
  assert.deepEqual(damage.lostHeadings, ["Указатели"]);
  assert.equal(damage.damaged, true);
});

test("a hollowed section (body emptied) is still detected through a rename", () => {
  const before = [
    "## Приватность на скринах (финальный стандарт 2026-09-01)",
    "- Текст → чёрный прямоугольник",
  ].join("\n");
  const after = [
    "## Приватность на скринах (правило ВЛАДЕЛЬЦА, 2026-09-01)",
  ].join("\n");
  const damage = coreDamage(before, after);
  assert.deepEqual(damage.lostHeadings, []);
  assert.deepEqual(damage.hollowedHeadings, ["Приватность на скринах (финальный стандарт 2026-09-01)"]);
  assert.equal(damage.damaged, true);
});
