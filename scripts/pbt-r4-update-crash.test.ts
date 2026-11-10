// Хаос-прогон обрыва обновления: вывод старого чекаута (`retireCheckout`) и обновление
// шима (`refreshOwnedShim`). Найдено 2026-09-13 маршрутом pbt/deepseek-4-4 (раунд 4).
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed стоит в имени свойства; при провале fast-check печатает
// `{ seed, path, endOnFailure: true }`, который повторяет прогон байт в байт. Обрыв
// моделируется состоянием на диске, которое остаётся после kill в конкретной точке
// (`rmSync` файла без последующей уборки каталогов; шим, унесённый в каталог-заявку).
//
// КРАСНЫЙ тест здесь - находка; продакшн-код не менялся, починка описана в отчёте
// `.scratch/work/reviews/pbt-deepseek-4-4-2026-09-12.md`.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

// Хук резолвинга идёт первым: модули тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";

const { RETIRE_MARKER, retireCheckout, retireIdentity } =
  await import("../scripts/update-finish.ts");
const { refreshOwnedShim, shimScript, SHIM_CLAIM_TTL_MS } =
  await import("../scripts/lib/version-layout.ts");

const SEED = 20_260_914;
/** Имя заявки нового формата: pid + uuid, как их пишет claimDirectoryName. */
function claimName(pid: number): string {
  return `.iva-shim-refresh-${pid}-${randomUUID()}`;
}

/** PID, которого нет: имя каталога-заявки шима несёт pid процесса, сделавшего его. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid ?? 999_999;
}

/** Пути, которые git считает своими в чекауте: их вывод и проверяется. */
const TRACKED = [
  ".gitignore",
  "package.json",
  "install.sh",
  "agent/index.ts",
  "agent/tools/x.ts",
  "bin/iva.mjs",
];
/** Тяжёлые артефакты: не отслеживаются, но выводятся всегда. */
const ARTIFACTS = ["node_modules", ".output"];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-home-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", home, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "pbt@test");
  git("config", "user.name", "pbt");
  writeFileSync(join(home, ".gitignore"), "node_modules\n.output\n");
  writeFileSync(join(home, "package.json"), '{ "name": "iva" }\n');
  writeFileSync(join(home, "install.sh"), "#!/bin/sh\n");
  mkdirSync(join(home, "agent", "tools"), { recursive: true });
  writeFileSync(join(home, "agent", "index.ts"), "export {};\n");
  writeFileSync(join(home, "agent", "tools", "x.ts"), "export {};\n");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "iva.mjs"), "// shim entry\n");
  mkdirSync(join(home, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(home, "node_modules", "dep", "index.js"), "x\n");
  mkdirSync(join(home, ".output"), { recursive: true });
  writeFileSync(join(home, ".output", "server.js"), "x\n");
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "settings.json"), "{}\n");
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return home;
}

/** Что осталось от чекаута: имена верхнего уровня, кроме вечного (data/.env). */
function leftovers(home: string): string[] {
  return readdirSync(home)
    .filter(
      (name) => !["data", ".env", "current", "repo", "versions"].includes(name),
    )
    .sort();
}

// НАХОДКА R4-1. `retireCheckout` берёт список своих файлов у git, а `.git` удаляет
// первым среди артефактов. Kill между удалением `.git` и `node_modules` (удаление
// большого каталога - секунды, окно широкое) оставляет чекаут без репозитория: повтор
// возвращает [] (git недоступен) и не трогает ни `node_modules`, ни `.output`.
// Путь `adopt()` (scripts/update-finish.ts) вообще не зовёт вывод, если `.git` исчез, -
// то есть гигабайты тяжёлых артефактов остаются на диске навсегда.
await test("НАХОДКА R4-1: без git метка ничего не сносит, а сообщает", () => {
  const home = makeHome();
  const identity = retireIdentity(home);
  assert.ok(identity, "идентичность дерева читается");
  writeFileSync(
    join(home, RETIRE_MARKER),
    JSON.stringify({ ...identity, at: 0 }),
  );
  const said: string[] = [];
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  let removed: string[];
  try {
    removed = retireCheckout(home, (line) => said.push(String(line)));
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(removed, [], "без git не сносится ничего");
  for (const name of [...ARTIFACTS, ".git", "agent", "bin", "package.json"])
    assert.ok(existsSync(join(home, name)), `${name} снесён без git`);
  assert.match(said.join("\n"), /git is not available/u);
});

await test("НАХОДКА R4-1: своя метка дочищает покалеченный .git", () => {
  const home = makeHome();
  const identity = retireIdentity(home);
  assert.ok(identity);
  rmSync(join(home, ".git", "objects"), { recursive: true, force: true });
  writeFileSync(
    join(home, RETIRE_MARKER),
    JSON.stringify({ ...identity, at: 0 }),
  );

  const removed = retireCheckout(home);
  assert.ok(removed.includes("node_modules"), JSON.stringify(removed));
  // Список tracked-файлов у покалеченного git не спросить: вывод дочищает артефакты и
  // сам репозиторий, исходники остаются владельцу.
  assert.deepEqual(
    leftovers(home).filter((name) => ARTIFACTS.includes(name)),
    [],
  );
  assert.ok(!existsSync(join(home, ".git")), ".git снесён");
  assert.ok(!existsSync(join(home, RETIRE_MARKER)), "метка снята");
});

// НАХОДКА T34-C. Обрыв ровно ПОСЛЕ удаления `.git` (он идёт последним) оставлял метку,
// которую повтор принять не мог: `retireIdentity` в состоянии «без .git» даёт null/null, и
// сверка с записанным в метке `.git` не сходилась - вывод не дочищался никогда.
await test("метка дочищает вывод, когда .git уже снесён обрывом", () => {
  const home = makeHome();
  const identity = retireIdentity(home);
  assert.ok(identity);
  writeFileSync(
    join(home, RETIRE_MARKER),
    JSON.stringify({ ...identity, at: 0 }),
  );
  // Обрыв после удаления `.git`: тяжёлые артефакты и метка остались на диске.
  rmSync(join(home, ".git"), { recursive: true, force: true });
  assert.ok(existsSync(join(home, "node_modules")));

  const said: string[] = [];
  const removed = retireCheckout(home, (line) => said.push(String(line)));
  assert.ok(
    removed.includes("node_modules"),
    JSON.stringify({ removed, said: said.join("\n") }),
  );
  assert.ok(!existsSync(join(home, RETIRE_MARKER)), "метка снята");
  assert.deepEqual(
    leftovers(home).filter((name) => ARTIFACTS.includes(name)),
    [],
  );
});

await test("НАХОДКА R4-1: чужая метка ничего не сносит", () => {
  const home = makeHome();
  rmSync(join(home, ".git", "objects"), { recursive: true, force: true });
  writeFileSync(
    join(home, RETIRE_MARKER),
    JSON.stringify({
      home: "/somewhere/else",
      gitDev: null,
      gitIno: null,
      headSha: null,
      at: 0,
    }),
  );
  const said: string[] = [];
  const removed = retireCheckout(home, (line) => said.push(String(line)));
  assert.deepEqual(removed, []);
  assert.ok(existsSync(join(home, "node_modules")), "артефакты целы");
  assert.match(said.join("\n"), /does not belong to this tree/u);
});

await test("НАХОДКА R4-1: упавший на первом удалении вывод не оставляет метку", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-locked-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", home, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "pbt@test");
  git("config", "user.name", "pbt");
  writeFileSync(join(home, "package.json"), '{ "name": "iva" }\n');
  const blocked = join(home, "adr");
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, "0001.md"), "adr\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  chmodSync(blocked, 0o555);
  try {
    assert.throws(() => retireCheckout(home));
  } finally {
    chmodSync(blocked, 0o755);
  }
  assert.ok(!existsSync(join(home, RETIRE_MARKER)), "метка залипла");
  assert.ok(existsSync(join(home, "package.json")), "вывод успел снести файл");
});

// НАХОДКА R4-2. Уборка каталогов висит на удалении файла: пустые родители подчищаются
// только в конце той же итерации. Kill после `rmSync` последнего файла каталога и до
// прохода по родителям оставляет пустые каталоги; на повторе файлов уже нет
// (`existsSync` → continue), и уборка за ними не запускается - пустые `agent/`,
// `agent/tools/`, `bin/` остаются в удалённом чекауте.
await test("НАХОДКА R4-2: обрыв в середине удаления не оставляет пустые каталоги", () => {
  const home = makeHome();
  for (const relative of TRACKED) rmSync(join(home, relative), { force: true });

  retireCheckout(home);
  assert.deepEqual(
    leftovers(home).filter((name) => name === "agent" || name === "bin"),
    [],
    `пустые каталоги: ${JSON.stringify(leftovers(home))}`,
  );
});

// То же свойством: с какого бы места обрыв ни случился, повтор обязан дочистить.
await test(`НАХОДКА R4-1/R4-2: свойство «повтор после обрыва дочищает чекаут» (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.subarray(TRACKED, { minLength: 0, maxLength: TRACKED.length }),
      (alreadyRemoved) => {
        const home = makeHome();
        for (const relative of alreadyRemoved)
          rmSync(join(home, relative), { force: true });
        retireCheckout(home);
        assert.deepEqual(
          leftovers(home),
          [],
          `обрыв на ${JSON.stringify(alreadyRemoved)}`,
        );
        assert.ok(existsSync(join(home, "data", "settings.json")));
        assert.ok(existsSync(join(home, ".env")));
        rmSync(home, { recursive: true, force: true });
        return Promise.resolve();
      },
    ),
    { seed: SEED, numRuns: 12 },
  );
});

// Решение владельца (13.09.2026): правки в коде Ивы обновление затирает, ставится версия
// из коммита. Чужой файл рядом с правкой - не наш, он остаётся.
await test("правка в коде Ивы вывод не переживает, файл рядом переживает", () => {
  const home = makeHome();
  writeFileSync(join(home, "agent", "index.ts"), "// правка пользователя\n");
  writeFileSync(join(home, "notes.md"), "# моё\n");
  const removed = retireCheckout(home);
  assert.equal(existsSync(join(home, "agent", "index.ts")), false);
  assert.equal(readFileSync(join(home, "notes.md"), "utf8"), "# моё\n");
  assert.ok(removed.includes("package.json"), JSON.stringify(removed));
});

// НАХОДКА R4-4 (шим). Обрыв между claim (шим унесён в `.iva-shim-refresh-<pid>-<id>`)
// и публикацией нового шима: повтор создаёт шим заново, но каталог-заявка с копией
// прежнего шима остаётся в `~/.local/bin` навсегда - ни один путь её не убирает.
await test("НАХОДКА R4-4: обрыв при обновлении шима не оставляет мусор рядом", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  // Заявка обрыва: имя несёт pid процесса, которого больше нет.
  const claim = join(bin, claimName(deadPid()));
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });

  // Шим возвращает уже сама уборка заявки (копия в ней — единственная), поэтому
  // «переписала ли его эта ветка» неважно: важен шим на месте и пустой каталог.
  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(existsSync(shim), "шим обязан восстановиться");
  assert.deepEqual(
    readdirSync(bin).filter((name) => name.startsWith(".iva-shim-refresh-")),
    [],
    "каталог-заявка остался",
  );
});

// БЛОКЕР Б2 QA: старый формат имени (mkdtemp: 6 случайных знаков) нельзя читать как pid.
// Имя `2avFo0` даёт parseInt → 2, и раньше заявка сносяme вместе с единственной копией
// шима; теперь старый формат судится только по возрасту.
await test("НАХОДКА R4-4: имя старого формата с ведущей цифрой не читается как pid", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const claim = join(bin, ".iva-shim-refresh-2avFo0");
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });

  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(
    existsSync(claim),
    "свежая заявка старого формата снесена как pid 2",
  );
  assert.ok(existsSync(shim), "шим на месте");
});

// БЛОКЕР Б2 QA: заявку живого чужого процесса уборка не имеет права пропускать вечно.
// pid переиспользован не нашим процессом — заявка брошена.
await test("НАХОДКА R4-4: заявка с чужим живым pid убирается", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const foreign = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    assert.ok(foreign.pid, "нет pid чужого процесса");
    const claim = join(bin, claimName(foreign.pid));
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });
    refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
    assert.ok(
      !existsSync(claim),
      "брошенная заявка с чужим живым pid осталась",
    );
    assert.ok(existsSync(shim), "шим на месте");
  } finally {
    foreign.kill("SIGKILL");
  }
});

// БЛОКЕР Б2 QA: убирая заявку, нельзя потерять шим. Если шим на месте нет, а в заявке
// лежит его копия — копия единственная, её возвращают до уборки каталога.
await test("НАХОДКА R4-4: заявка с единственной копией шима сначала возвращает шим", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  const claim = join(bin, claimName(deadPid()));
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });
  const copyIno = statSync(join(claim, "previous")).ino;

  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(existsSync(shim), "копия шима потеряна");
  // Именно возвращённая копия, а не заново написанный шим: тот же inode (жёсткая ссылка).
  assert.equal(statSync(shim).ino, copyIno, "шим не возвращён из заявки");
  assert.ok(!existsSync(claim), "заявка осталась");
});

// БЛОКЕР Б2 QA (раунд 2): возраст решает и для заявки с нашим pid. Заявка живёт
// миллисекунды, поэтому заявка старше часа с нашим (повторно использованным) pid
// брошена, и её recovery-копия не должна потеряться вместе с каталогом.
await test("НАХОДКА R4-4: заявка с нашим pid старше часа убирается", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  const claim = join(bin, claimName(process.pid));
  mkdirSync(claim, { recursive: true });
  writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });
  const copyIno = statSync(join(claim, "previous")).ino;
  const old = new Date(Date.now() - SHIM_CLAIM_TTL_MS - 60_000);
  utimesSync(join(claim, "previous"), old, old);
  utimesSync(claim, old, old);

  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(!existsSync(claim), "брошенная заявка с нашим pid осталась");
  assert.ok(existsSync(shim), "копия шима потеряна");
  assert.equal(statSync(shim).ino, copyIno, "шим не возвращён из заявки");
});

// Жёсткий обрыв (kill -9) мог оставить заявку старого формата - без pid в имени.
// Её судят по возрасту: брошенная больше часа назад убирается при следующем старте.
await test("НАХОДКА R4-4: брошенная заявка старого формата старше часа убирается", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const stale = mkdtempSync(join(bin, ".iva-shim-refresh-"));
  writeFileSync(join(stale, "previous"), desired, { mode: 0o755 });
  const old = new Date(Date.now() - SHIM_CLAIM_TTL_MS - 60_000);
  utimesSync(stale, old, old);

  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(!existsSync(stale), "брошенная заявка старого формата осталась");
});

// Зелёный control уборки: свежую заявку без pid она не трогает - её ещё может держать
// параллельный ход на старом коде.
await test("зелёное: свежую заявку старого формата уборка не трогает", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const fresh = mkdtempSync(join(bin, ".iva-shim-refresh-"));
  writeFileSync(join(fresh, "previous"), desired, { mode: 0o755 });

  refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
  assert.ok(existsSync(fresh), "свежая заявка удалена");
});

// Зелёный control уборки: заявку живого процесса она не трогает (иначе снесла бы
// работу параллельного обновления).
await test("зелёное: заявку живого процесса уборка не трогает", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  const desired = shimScript(home, process.execPath, join(home, "data"));
  writeFileSync(shim, desired, { mode: 0o755 });
  const child = spawn(
    process.execPath,
    ["-e", "/* iva shim holder */ setTimeout(() => {}, 60000)"],
    { detached: true, stdio: "ignore" },
  );
  try {
    assert.ok(child.pid, "нет pid живого процесса");
    const claim = join(bin, claimName(child.pid));
    mkdirSync(claim, { recursive: true });
    writeFileSync(join(claim, "previous"), desired, { mode: 0o755 });
    refreshOwnedShim(shim, home, process.execPath, join(home, "data"));
    assert.ok(existsSync(claim), "заявка живого процесса удалена");
  } finally {
    child.kill("SIGKILL");
  }
});

// Зелёные controls шима: чужой шим не трогается, чужой файл на месте остаётся.
await test("зелёное: чужой шим не перезаписывается", () => {
  const home = mkdtempSync(join(tmpdir(), "pbt-r4-shim-home-"));
  const bin = mkdtempSync(join(tmpdir(), "pbt-r4-shim-bin-"));
  const shim = join(bin, "iva");
  writeFileSync(shim, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, join(home, "data")),
    false,
  );
  assert.match(execFileSync("cat", [shim], { encoding: "utf8" }), /foreign/u);
});

// specs/UpdateFloor.tla, NoSilentLoss: сборки до 0.3.15 держали стор воркфлоу в корне
// установки. Git его не отслеживал никогда, и вывод чекаута оставляет его как есть.
await test("NoSilentLoss: вывод чекаута не трогает .workflow-data в корне", () => {
  const home = makeHome();
  mkdirSync(join(home, ".workflow-data"));
  writeFileSync(join(home, ".workflow-data", "run.json"), '{"run":1}\n');

  const removed = retireCheckout(home);

  assert.ok(removed.includes("node_modules"), JSON.stringify(removed));
  assert.deepEqual(leftovers(home), [".workflow-data"]);
  assert.equal(
    readFileSync(join(home, ".workflow-data", "run.json"), "utf8"),
    '{"run":1}\n',
  );
});
