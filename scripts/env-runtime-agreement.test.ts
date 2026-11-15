// Одно значение в `.env` — один смысл у всех, кто его читает.
//
// Читателей у файла на боевой машине двое, и старший — не тот, что кажется: юнит несёт
// `EnvironmentFile=` (scripts/cli/systemd.ts, deploy/*.service), а `node --env-file`
// унаследованное окружение уже не перезаписывает. Поэтому писатель кладёт в файл только
// безопасное подмножество, которое оба парсера читают одинаково и без кавычек
// (правила и их источники — в шапке envValueRejection), а всё остальное отвергает.
//
// Оракул здесь — настоящий дочерний `node --env-file`, а не наш же `parseEnv` в памяти:
// сверка с самой собой ничего не доказывает, и именно так в прошлый раз проскочил NUL
// (в памяти он сохраняется, из файла обрывает значение).
//
// КАК ВОСПРОИЗВЕСТИ падение свойства: fast-check печатает `{ seed, path }` — подставь
// их вторым аргументом fc.assert.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  ambiguousEnvLines,
  ENV_VALUE_PROBLEM,
  envKeyProblem,
  envValueRejection,
  formatEnvLine,
  parseEnvText,
} from "./lib/env-file.ts";
import { createCliRuntime } from "./cli/runtime.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

// Байт NUL строим из кода: сырой NUL в исходнике ломает и git, и редакторы.
const NUL = String.fromCharCode(0);
const SEED = 20_260_912;
const RUNS = 60;
const BATCH = 12;
const ABSENT = "<absent>";

const scratch = tempDir("env-agreement-");
let files = 0;

/** Что увидит сам процесс агента: значения из `node --env-file=<файл>`. */
function valuesInProcess(
  fileText: string,
  keys: readonly string[],
): Record<string, string> {
  const path = join(scratch, `probe-${(files += 1)}.env`);
  writeFileSync(path, fileText);
  const out = execFileSync(
    process.execPath,
    [
      `--env-file=${path}`,
      "-e",
      `const keys = ${JSON.stringify(keys)};` +
        ` const seen = {};` +
        ` for (const k of keys) seen[k] = process.env[k] ?? ${JSON.stringify(ABSENT)};` +
        ` process.stdout.write(JSON.stringify(seen));`,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  return JSON.parse(out) as Record<string, string>;
}

const valueInProcess = (fileText: string, key: string): string | undefined => {
  const seen = valuesInProcess(fileText, [key])[key];
  return seen === ABSENT ? undefined : seen;
};

// Значения, на которых владелец и агент расходились: решётка обрывает значение,
// ведущая решётка убирает переменную целиком, непарная кавычка сдвигает на символ.
const DIVERGING = ["ab#cd", "#secret", '"abc', "ab #cd", "abc"] as const;

await test("владелец видит то же значение, что получит процесс агента", () => {
  for (const written of DIVERGING) {
    const fileText = `CUSTOM_API_KEY=${written}\n`;
    assert.equal(
      parseEnvText(fileText).CUSTOM_API_KEY,
      valueInProcess(fileText, "CUSTOM_API_KEY"),
      `CUSTOM_API_KEY=${JSON.stringify(written)}: владелец видит одно, агент получает другое`,
    );
  }
});

await test("`iva doctor` читает .env глазами процесса, а не своими", () => {
  const root = tempDir("env-agreement-root-");
  // Ключ, начинающийся с решётки: для процесса переменной просто нет. Доктор обязан
  // назвать её пустой и отправить владельца в `iva config`, а не рапортовать «заполнено».
  writeFileSync(join(root, ".env"), "CUSTOM_API_KEY=#secret\nIVA_PORT=8723\n");
  const env = createCliRuntime(root).readEnv();
  assert.equal(
    env.CUSTOM_API_KEY,
    "",
    "доктор показывает ключ, которого у процесса нет",
  );
  assert.equal(env.IVA_PORT, "8723", "обычное значение читается по-прежнему");
});

await test("подмножество: принятое доезжает целиком, отвергнутое названо причиной", () => {
  const accepted = [
    "sk-live_ABC-123.xyz",
    "https://api.example.com/v1",
    "8723",
    "a b",
    "",
    "a=b",
    "a$b",
    "a;b",
    "~/vault",
  ];
  const keys = accepted.map((_, index) => `ZQ_${index}`);
  const text = accepted
    .map((value, index) => formatEnvLine(keys[index], value))
    .join("\n");
  const seen = valuesInProcess(`${text}\n`, keys);
  accepted.forEach((value, index) => {
    assert.equal(
      seen[keys[index]],
      value,
      `${JSON.stringify(value)} доехало до процесса искажённым`,
    );
  });

  const refused: Array<[string, keyof typeof ENV_VALUE_PROBLEM]> = [
    ["ab#cd", "special"],
    ['a"b', "special"],
    ["a'b", "special"],
    ["a`b", "special"],
    ["a\\b", "special"],
    [`sk-live-a${NUL}BCDEF`, "control"],
    ["a\nb", "newline"],
    ["a\rb", "newline"],
    ["a\tb", "control"],
    [" abc", "edge-space"],
    ["abc ", "edge-space"],
    ["вольт", "non-ascii"],
  ];
  for (const [value, reason] of refused) {
    assert.equal(
      envValueRejection(value),
      reason,
      `${JSON.stringify(value)}: не та причина отказа`,
    );
    assert.throws(
      () => formatEnvLine("CUSTOM_API_KEY", value),
      (error: Error) => error.message.includes(ENV_VALUE_PROBLEM[reason]),
      `${JSON.stringify(value)} записалось вместо отказа`,
    );
  }
});

await test("имя ключа: строка, которую сервис не примет за имя, не пишется", () => {
  for (const key of ["my.key", "MY-KEY", "9KEY", "ключ", "MY KEY", ""]) {
    assert.equal(envKeyProblem(key), "a name the service cannot use", key);
    assert.throws(
      () => formatEnvLine(key, "1"),
      /is not a name/u,
      `${JSON.stringify(key)} записалось вместо отказа`,
    );
  }
  for (const key of ["CUSTOM_API_KEY", "_x", "a1"])
    assert.equal(envKeyProblem(key), null, key);
});

// N3: по разобранному значению расхождения не видно - `parseEnv` обрезает `ab#cd` до
// `ab`. Смотреть надо на сырую строку файла, иначе предупреждение слепо ровно к тому
// случаю, ради которого заведено.
await test("строки существующего .env разбираются по сырому тексту, а не по значению", () => {
  const text = [
    "CUSTOM_API_KEY=ab#cd",
    "IVA_PORT=8723",
    "# комментарий",
    "; тоже комментарий",
    "",
    'TELEGRAM_BOT_TOKEN="tg "',
    "my.key=1",
    "export ASSISTANT_VAULT_DIR=вольт",
  ].join("\n");
  assert.equal(
    parseEnvText(text).CUSTOM_API_KEY,
    "ab",
    "разобранное значение выглядит безобидно - потому и нужен сырой текст",
  );
  // `TELEGRAM_BOT_TOKEN="tg "` в фикстуре есть, а в списке его нет намеренно: кавычки
  // снимают оба парсера, и краевой пробел ВНУТРИ них расхождением не является (T34-7).
  assert.deepEqual(ambiguousEnvLines(text), [
    { key: "CUSTOM_API_KEY", problem: ENV_VALUE_PROBLEM.special },
    { key: "my.key", problem: "a name the service cannot use" },
    { key: "ASSISTANT_VAULT_DIR", problem: ENV_VALUE_PROBLEM["non-ascii"] },
  ]);
  assert.deepEqual(
    ambiguousEnvLines("CUSTOM_API_KEY=sk-live_ABC-123\nIVA_PORT=8723\n"),
    [],
    "на здоровом файле проверка обязана молчать",
  );
});

await test("NUL: процесс обрывает значение, поэтому запись обязана отказать", () => {
  const poisoned = `sk-live-a${NUL}BCDEF`;
  // Прямая запись мимо formatEnvLine — то, что делал прежний писатель.
  assert.notEqual(
    valueInProcess(`CUSTOM_API_KEY=${poisoned}\n`, "CUSTOM_API_KEY"),
    poisoned,
    "процесс вдруг сохранил NUL целиком — проверка потеряла смысл",
  );
  assert.throws(() => formatEnvLine("CUSTOM_API_KEY", poisoned));
});

// Алфавит нарочно шире подмножества: в нём и то, что обязано быть принято, и то, что
// обязано быть отвергнуто, включая NUL и перевод строки.
const character = fc.constantFrom(
  ..."abzABZ059",
  "-",
  "_",
  ".",
  "/",
  ":",
  "=",
  "+",
  "~",
  "#",
  "$",
  "%",
  ",",
  '"',
  "'",
  "`",
  "\\",
  " ",
  "\t",
  "\n",
  NUL,
  "ю",
);
const value = fc.string({ unit: character, minLength: 0, maxLength: 20 });

await test(`записанное процесс отдаёт дословно, остальное отвергнуто (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(value, { minLength: BATCH, maxLength: BATCH }),
      (batch) => {
        const lines: string[] = [];
        const expected = new Map<string, string>();
        batch.forEach((written, index) => {
          const key = `ZQ_${index}`;
          if (envValueRejection(written)) {
            assert.throws(
              () => formatEnvLine(key, written),
              `${JSON.stringify(written)}: отвергнуто проверкой, но записалось`,
            );
            return;
          }
          lines.push(formatEnvLine(key, written));
          expected.set(key, written);
        });
        if (expected.size === 0) return;
        // Один дочерний процесс на весь пакет: оракул дорогой, значений много.
        const seen = valuesInProcess(`${lines.join("\n")}\n`, [
          ...expected.keys(),
        ]);
        for (const [key, written] of expected)
          assert.equal(
            seen[key],
            written,
            `${JSON.stringify(written)}: записали одно, процесс получил другое`,
          );
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});

// Ключи вендора claude пишет и мастер установки, и `iva config`: имя модели, окно
// контекста и путь к CLI — обычные строки, а не секреты, и процесс должен прочитать их
// ровно теми, какими их записали.
await test("ключи claude доезжают до процесса как есть", () => {
  const values = {
    CLAUDE_MODEL: "claude-fable-5-1",
    CLAUDE_CONTEXT_WINDOW: "1000000",
    CLAUDE_COMMAND: "/opt/claude/bin/claude",
  };
  const text = Object.entries(values)
    .map(([key, value]) => formatEnvLine(key, value))
    .join("\n");
  assert.deepEqual(valuesInProcess(`${text}\n`, Object.keys(values)), values);
});

await test("iva userbot creds: значение вне подмножества отвергается, файл не тронут", () => {
  const root = tempDir("env-agreement-creds-");
  const envPath = join(root, ".env");
  const before = "IVA_PORT=8723\nTELEGRAM_API_ID=12345\n";
  writeFileSync(envPath, before);
  const runtime = createCliRuntime(root);

  assert.throws(
    () =>
      runtime.writeEnvVars({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "ab#cd",
      }),
    /one of/u,
    "api_hash с решёткой записался вместо отказа",
  );
  assert.equal(
    readFileSync(envPath, "utf8"),
    before,
    "файл изменён после отказа",
  );

  runtime.writeEnvVars({
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "0123456789abcdef",
  });
  assert.equal(
    valueInProcess(readFileSync(envPath, "utf8"), "TELEGRAM_API_HASH"),
    "0123456789abcdef",
    "годный api_hash не доехал до процесса",
  );
});

// T34-7: doctor судил СЫРОЕ значение, а `envValueRejection` отвергает любую кавычку -
// поэтому обычная строка `KEY="value"` из уже существующего .env объявлялась
// расхождением парсеров. Кавычки снимают оба (шапка env-file.ts), значит целиком
// закавыченное значение надо судить по тому, что ВНУТРИ.
await test("doctor: кавычки, которые снимают оба парсера, - не расхождение", () => {
  const agreed = [
    'CUSTOM_API_KEY="sk-live_ABC-123"',
    'TELEGRAM_BOT_TOKEN="tg "',
    "ASSISTANT_VAULT_DIR='my vault'",
    'CUSTOM_BASE_URL="https://api.example.com/v1#frag"',
    `TELEGRAM_BOT_USERNAME="it's"`,
    "DEEPGRAM_LANGUAGE='a\"b'",
    'ASSISTANT_HOST=""',
  ].join("\n");
  assert.deepEqual(
    ambiguousEnvLines(agreed),
    [],
    "на закавыченных значениях доктору сказать нечего",
  );

  // Не «держит ноль»: оракул подтверждает, что процесс правда снимает эти кавычки.
  assert.deepEqual(
    valuesInProcess(`${agreed}\n`, [
      "CUSTOM_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "ASSISTANT_VAULT_DIR",
      "CUSTOM_BASE_URL",
      "TELEGRAM_BOT_USERNAME",
      "DEEPGRAM_LANGUAGE",
      "ASSISTANT_HOST",
    ]),
    {
      CUSTOM_API_KEY: "sk-live_ABC-123",
      TELEGRAM_BOT_TOKEN: "tg ",
      ASSISTANT_VAULT_DIR: "my vault",
      CUSTOM_BASE_URL: "https://api.example.com/v1#frag",
      TELEGRAM_BOT_USERNAME: "it's",
      DEEPGRAM_LANGUAGE: 'a"b',
      ASSISTANT_HOST: "",
    },
  );
});

// Обратная сторона: кавычки снимают расхождение не всегда. Здесь предупреждение обязано
// остаться, иначе правка выше просто выключила бы доктору голос.
await test("doctor: кавычки, которые парсеры снимают по-разному, названы", () => {
  assert.deepEqual(
    ambiguousEnvLines(
      [
        'A="a\\nb"', // node разворачивает \n в перевод строки, systemd оставляет буквы
        'B="a" trailing', // node берёт только закавыченное, шелл склеил бы всё
        'C="abc', // кавычка не закрыта: значение начинается с неё
        'D=a"b"c', // кавычки не по краям - обычные символы
        'E="каф"', // не-ASCII внутри кавычек так и остаётся необещанным
        "F=ab#cd", // голая решётка - исходный случай ветки, не трогаем
        'G="a\tb"', // табуляция внутри кавычек: systemd отвергает непечатные
      ].join("\n"),
    ),
    [
      { key: "A", problem: ENV_VALUE_PROBLEM.special },
      { key: "B", problem: ENV_VALUE_PROBLEM.special },
      { key: "C", problem: ENV_VALUE_PROBLEM.special },
      { key: "D", problem: ENV_VALUE_PROBLEM.special },
      { key: "E", problem: ENV_VALUE_PROBLEM["non-ascii"] },
      { key: "F", problem: ENV_VALUE_PROBLEM.special },
      { key: "G", problem: ENV_VALUE_PROBLEM.control },
    ],
  );
});
