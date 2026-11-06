// Хаос-прогон описаний пользовательских скиллов: владелец кладёт в
// data/custom/agent/skills/ файл с длинным description в frontmatter, а индекс скиллов
// уходит в промпт каждого хода. Найдено 2026-09-12 маршрутом pbt/iva-deepseek-4.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed стоит в имени теста; при провале fast-check печатает
// `{ seed, path, endOnFailure: true }`, который повторяет прогон байт в байт.
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не меняется, починка описана в отчёте
// `.scratch/work/reviews/pbt-iva-deepseek-4-2026-09-12.md`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { DESCRIPTION_CAP, readCustomSkills } from "./custom-skills.ts";
const SEED = 20_260_912;

function hasLoneSurrogate(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
  });
}

// Свой каталог на каждый вызов: тесты последовательные, но общий каталог и хук
// очистки делали порядок значимым.
async function descriptionOf(declared: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "iva-custom-skills-chaos-"));
  try {
    mkdirSync(join(root, "mine"), { recursive: true });
    writeFileSync(
      join(root, "mine/SKILL.md"),
      `---\ndescription: ${declared}\n---\n\nbody\n`,
    );
    const skills = await readCustomSkills(root, () => undefined);
    return skills.mine?.description ?? "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// НАХОДКА 3. Усечение описания до 120 знаков режет строку по коду UTF-16: если на
// границе стоит эмодзи, описание заканчивается одиноким старшим суррогатом и знаком
// «…». Этот же текст уходит в индекс скиллов в промпте, где суррогат превращается в
// «�»: пользователь видит сломанный символ в описании своего скилла, а модель -
// подменённый. Минимальный контрпример: 118 букв, эмодзи, одна буква.
await test("НАХОДКА 3: усечение описания скилла не рвёт эмодзи (контрпример)", async () => {
  const description = await descriptionOf(
    `${"a".repeat(DESCRIPTION_CAP - 2)}😀b`,
  );
  assert.equal(
    hasLoneSurrogate(description),
    false,
    `описание обрывается одиноким суррогатом: ${JSON.stringify(description.slice(-3))}`,
  );
});

await test(`НАХОДКА 3: свойство «усечение не рвёт суррогат» (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: DESCRIPTION_CAP - 8, max: DESCRIPTION_CAP - 1 }),
      fc.constantFrom("😀", "🎉", "🧑‍🚀"),
      async (prefixLength, emoji) => {
        const description = await descriptionOf(
          `${"a".repeat(prefixLength)}${emoji}bbb`,
        );
        assert.equal(hasLoneSurrogate(description), false);
      },
    ),
    { seed: SEED, numRuns: 60 },
  );
});

// Зелёные свойства: предел и знак усечения держатся, то есть находка выше - именно про
// разорванный суррогат, а не про неверно понятый контракт усечения.
await test("зелёное: усечённое описание укладывается в предел и кончается «…»", async () => {
  const description = await descriptionOf("я".repeat(400));
  assert.equal(description.length, DESCRIPTION_CAP);
  assert.ok(description.endsWith("…"));
  assert.equal(hasLoneSurrogate(description), false);
});
