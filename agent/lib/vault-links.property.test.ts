// Резолвер ссылок повторяет ночной обход графа (scripts/autograph/), и его вход —
// то, что модель написала в карточке: любой юникод, любая пунктуация, любая длина.
// Генератор перебирает то, что руками не перечислить; свойство одно и то же с обеих
// сторон границы: цель, под которой лежит файл, проходит, остальные — нет.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unresolvedLinkTargets } from "./vault-links.ts";

const SEED = 20_260_913;
const RUNS = 120;
const TODAY = Date.UTC(2026, 8, 13);
const SOURCE = "cards/notes/источник";

// Слаг карточки: то, что оставляет slugify — строчные буквы, цифры и дефис.
const slug = fc
  .stringMatching(/^[a-zа-я0-9][a-zа-я0-9-]{0,20}$/u)
  .filter((value) => !value.endsWith("-"));

/** Вольт из карточек-заглушек: без H1, чтобы резолв шёл только по пути и stem'у. */
function vaultWith(slugs: readonly string[]): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-links-prop-"));
  mkdirSync(join(vault, "cards", "notes"), { recursive: true });
  for (const name of slugs)
    writeFileSync(
      join(vault, "cards", "notes", `${name}.md`),
      "факт\n",
      "utf8",
    );
  return vault;
}

void test("цель, под которой лежит файл, проходит в любой из своих форм", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(slug, { minLength: 1, maxLength: 6 }),
      fc.nat(),
      (slugs, pick) => {
        const name = slugs[pick % slugs.length];
        const vault = vaultWith(slugs);
        try {
          const targets = [
            `cards/notes/${name}.md`,
            `cards/notes/${name}`,
            `vault/cards/notes/${name}`,
            `notes/${name}`,
            name,
            `${name}#Раздел`,
          ];
          assert.deepEqual(
            unresolvedLinkTargets(targets, {
              vaultDir: vault,
              source: SOURCE,
              today: TODAY,
            }),
            [],
          );
        } finally {
          rmSync(vault, { recursive: true, force: true });
        }
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});

void test("цель без файла отказывается и возвращается дословно", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(slug, { minLength: 1, maxLength: 6 }),
      slug,
      (slugs, missing) => {
        fc.pre(!slugs.includes(missing));
        const vault = vaultWith(slugs);
        try {
          assert.deepEqual(
            unresolvedLinkTargets([missing, `cards/notes/${missing}`], {
              vaultDir: vault,
              source: SOURCE,
              today: TODAY,
            }),
            [missing, `cards/notes/${missing}`],
          );
        } finally {
          rmSync(vault, { recursive: true, force: true });
        }
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});
