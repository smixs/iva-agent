// Хаос-прогон ответов мастеру установки (install.sh): мусор и чужие языки в ответах на
// вопросы мастера. Найдено 2026-09-13 маршрутом pbt/deepseek-4-4 (раунд 4).
//
// Харнесс не переписывает мастер, а вынимает его функции из install.sh по именам и
// выполняет их настоящий текст под bash: если функция изменится, тест увидит новую.
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/pbt-deepseek-4-4-2026-09-12.md`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/temp-dir.ts";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));

/** Вынимает тело функции из install.sh по её имени (от `name() {` до строки `}`). */
function functionBody(name: string): string {
  const source = readFileSync(INSTALL_SH, "utf8");
  const start = source.indexOf(`\n${name}() {\n`);
  assert.ok(start >= 0, `в install.sh нет функции ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `у функции ${name} не найден конец`);
  return source.slice(start + 1, end + 3);
}

const work = tempDir("pbt-r4-master-");
const harness = join(work, "master.sh");
writeFileSync(
  harness,
  [
    "#!/usr/bin/env bash",
    "set -u",
    'c_bold=""; c_blue=""; c_green=""; c_reset=""',
    "IVA_LANG=en",
    "IS_INTERACTIVE=true",
    "NON_INTERACTIVE=false",
    `INSTALL_DIR="${join(work, "no-install")}"`,
    "have_tty() { return 1; }",
    't() { if [ "${IVA_LANG:-en}" = ru ]; then printf "%s" "$2"; else printf "%s" "$1"; fi; }',
    // Общий разбор ответа мастер берёт из одного места - его вынимаем первым.
    functionBody("answer_token"),
    functionBody("prompt_yes_no"),
    functionBody("pick_language"),
    'case "${1:-}" in',
    '  prompt) prompt_yes_no "Q?" "${2:-no}" ;;',
    '  lang) pick_language >/dev/null; printf "%s" "$IVA_LANG" ;;',
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"),
);

function run(
  mode: "prompt" | "lang",
  answer: string,
  extra?: string,
): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(
      "bash",
      [harness, mode, ...(extra === undefined ? [] : [extra])],
      {
        input: `${answer}\n`,
        encoding: "utf8",
        // Целевые машины ставят install.sh из curl|bash на Debian/Ubuntu, где локаль
        // по умолчанию POSIX: разбор ответов обязан работать и под C.
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
    );
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? "" };
  }
}

// НАХОДКА R4-3. Вопросы мастера двуязычны (`t "yes/no" "да/нет"`), а разбор ответа
// знает только английское «yes»: русский владелец, отвечающий на русский вопрос «да»
// (или короткое «Д»), получает молчаливое «нет». Так тихо не заводится автозапуск
// systemd (install.sh:1160 шлёт вопрос через `t`), и владелец уверен, что согласился.
await test("НАХОДКА R4-3: ответ «да» на русский вопрос мастера понимается как согласие", () => {
  const callSites = readFileSync(INSTALL_SH, "utf8")
    .split("\n")
    .filter((line) => line.includes('prompt_yes_no "$(t "'));
  assert.ok(
    callSites.length > 0,
    "мастер обязан задавать вопросы в двух языках через t()",
  );
  for (const answer of ["да", "Д"])
    assert.equal(
      run("prompt", answer).status,
      0,
      `ответ ${JSON.stringify(answer)} прочитан как «нет»`,
    );
  // Тот же разбор языка: меню печатает «[2] Русский», а ответ с точкой/скобкой
  // («2.», «2)» — так пишут, когда пункт показан как «2)») уходит в default.
  assert.equal(
    run("lang", "2.").stdout,
    "ru",
    "ответ «2.» прочитан как default-язык",
  );
});

// Зелёные controls: английские ответы, мусор и режим без вопросов работают как раньше.
await test("зелёное: мастер разбирает yes/no, мусор и non-interactive", () => {
  for (const answer of ["y", "Y", "yes", "YES", "yEs"])
    assert.equal(run("prompt", answer).status, 0, `yes-форма ${answer}`);
  for (const answer of ["n", "no", "maybe", "да нет", "0"])
    assert.equal(run("prompt", answer).status, 1, `no-форма ${answer}`);
  assert.equal(
    run("prompt", "", "yes").status,
    0,
    "пустой ответ берёт default=yes",
  );
  assert.equal(
    run("prompt", "", "no").status,
    1,
    "пустой ответ берёт default=no",
  );
});

await test("зелёное: язык выбирается по ответам мастера", () => {
  for (const answer of ["2", "ru", "RU", "Русский", "рус", " 2 "])
    assert.equal(run("lang", answer).stdout, "ru", `язык для ${answer}`);
  for (const answer of ["1", "en", "EN", "english", "мусор", ""])
    assert.equal(run("lang", answer).stdout, "en", `язык для ${answer}`);
});
