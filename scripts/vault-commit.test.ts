/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Память под git: одна успешная правка = один локальный коммит затронутых путей vault.
// Проверяем поведение через публичный шов: инструменты (write_card, write_file) и сам
// commitVaultWrite; состояние читаем из настоящего репозитория git.
// Запуск: node --test scripts/vault-commit.test.ts

import "./lib/ts-esm-hooks.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asSchema } from "ai";
import { toInputSchema } from "../node_modules/eve/dist/src/tools/schema.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = join(REPO, "vault-template", "schema.json");
process.env.ASSISTANT_TIMEZONE = "UTC";

/** Свежий vault на каждый тест: репозиторий git заводится, только если тест про него. */
function makeVault(
  t: { after(fn: () => void): void },
  {
    repo = true,
    identity = "Test",
  }: { repo?: boolean; identity?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-vault-"));
  // Большой vault с тысячами файлов сносится не с первой попытки.
  t.after(() =>
    rmSync(dir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  mkdirSync(join(dir, "cards", "contacts"), { recursive: true });
  mkdirSync(join(dir, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(dir, "schema.json"));
  if (repo) {
    sh(["init", "-q", "-b", "main"], dir);
    if (identity) sh(["config", "user.email", `${identity}@example.com`], dir);
    if (identity) sh(["config", "user.name", identity], dir);
    // Как init-vault: стартовое состояние vault уже в истории, иначе первый же
    // тест читал бы чужую незакоммиченную правку.
    sh(["add", "-A"], dir);
    sh(["commit", "-q", "-m", "vault"], dir);
  }
  process.env.ASSISTANT_VAULT_DIR = dir;
  const data = `${dir}-data`;
  mkdirSync(data);
  process.env.ASSISTANT_DATA_DIR = data;
  t.after(() => rmSync(data, { recursive: true, force: true }));
  return dir;
}

function sh(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

/** Тем же способом, что и шов: git обязан уметь работать в этом каталоге. */
function trySh(args: readonly string[], cwd: string): string {
  try {
    return sh(args, cwd);
  } catch {
    return "";
  }
}

/** История правок памяти: стартовый коммит vault в неё не входит. */
const subjects = (vault: string) =>
  trySh(["log", "--pretty=%s"], vault)
    .split("\n")
    .filter((subject) => subject && subject !== "vault");

const touched = (vault: string) =>
  trySh(
    ["-c", "core.quotePath=false", "show", "--name-only", "--pretty=", "HEAD"],
    vault,
  )
    .split("\n")
    .filter(Boolean);

const porcelain = (vault: string) =>
  trySh(["-c", "core.quotePath=false", "status", "--porcelain"], vault);

const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date());

type WriteCardResult = {
  action: string;
  error: string;
  file: string;
  ok: boolean;
};
type WriteFileResult = {
  bytes: number;
  error: string;
  ok: boolean;
  path: string;
};

/** Импорт инструментов после того, как каталог vault уже выставлен. Динамический импорт:
 * статический слинковался бы до регистрации resolve-хука (.js→.ts). */
const loadTools = async () => {
  const card = (await import(
    join(REPO, "agent", "tools", "write_card.ts")
  )) as typeof import("../agent/tools/write_card.ts");
  const file = (await import(
    join(REPO, "agent", "tools", "write_file.ts")
  )) as typeof import("../agent/tools/write_file.ts");
  const seam = (await import(
    join(REPO, "agent", "lib", "vault-commit.ts")
  )) as typeof import("../agent/lib/vault-commit.ts");
  const cardTool = card.default as unknown as {
    execute: (input: unknown) => Promise<WriteCardResult>;
  };
  const cardSchema = asSchema(toInputSchema(card.default.inputSchema));
  const fileTool = file.default as unknown as {
    execute: (input: unknown) => Promise<WriteFileResult>;
  };
  return {
    card: async (args: unknown) => {
      const validated = await cardSchema.validate!(args);
      assert.equal(validated.success, true);
      assert.ok(validated.success);
      return cardTool.execute(validated.value);
    },
    file: (path: string, content: string) =>
      fileTool.execute({ content, path }),
    seam,
  };
};

const tool = await loadTools();

/** Ввод write_card: факт в Card (создаёт её, если нет) или новая правда — `truth`. */
const card = (overrides: Record<string, unknown>) => {
  const {
    body = "Факт из разговора.",
    operation,
    title = "Проверочная карточка",
  } = overrides;
  return operation === "truth"
    ? { operation, type: "note", title, text: body, reason: "владелец уточнил" }
    : {
        operation: "fact",
        type: "note",
        title,
        text: body,
        description: "Описание карточки",
        tags: ["test"],
      };
};

/** Причина отказа одной строкой уходит в журнал: строки журнала возвращаются рядом со
 * значением перехваченного вызова. */
async function journal<T>(
  run: () => Promise<T>,
): Promise<{ logged: string; value: T }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  let value: T;
  try {
    value = await run();
  } finally {
    console.error = real;
  }
  return { logged: lines.join("\n"), value };
}

test("fact и truth оставляют по коммиту с карточкой и операцией; повтор факта — без коммита", async (t) => {
  const vault = makeVault(t);
  const added = await tool.card(
    card({ body: "работает в TDI Group.", title: "Батыр" }),
  );
  assert.equal(added.ok, true, added.error);
  assert.deepEqual(subjects(vault), ["card батыр: fact"]);
  assert.deepEqual(touched(vault), ["cards/notes/батыр.md"]);
  assert.equal(porcelain(vault), "");

  const updated = await tool.card(
    card({ title: "Батыр", body: "Позвонил по смете." }),
  );
  assert.equal(updated.ok, true, updated.error);
  assert.deepEqual(subjects(vault), ["card батыр: fact", "card батыр: fact"]);
  assert.deepEqual(touched(vault), ["cards/notes/батыр.md"]);

  const replaced = await tool.card(
    card({ operation: "truth", title: "Батыр", body: "Работает в Majento" }),
  );
  assert.equal(replaced.ok, true, replaced.error);
  assert.deepEqual(subjects(vault)[0], "card батыр: truth");
  assert.equal(porcelain(vault), "");

  // Повтор того же факта карточку не меняет и коммита не делает.
  const again = await tool.card({
    operation: "fact",
    type: "note",
    title: "Батыр",
    text: "Позвонил по смете.",
    tags: ["test"],
  });
  assert.equal(again.ok, true, again.error);
  assert.equal(subjects(vault).length, 3);
});

test("write_file коммитит только то, что лежит внутри vault", async (t) => {
  const vault = makeVault(t);
  const inside = join(vault, "library", "book", "01.md");
  const written = await tool.file(inside, "Глава\n");
  assert.equal(written.ok, true, written.error);
  assert.deepEqual(subjects(vault), ["file library/book/01.md: write"]);
  assert.deepEqual(touched(vault), ["library/book/01.md"]);

  const outside = join(vault, "..", `outside-${String(process.pid)}.md`);
  t.after(() => rmSync(outside, { force: true }));
  const other = await tool.file(outside, "Не память\n");
  assert.equal(other.ok, true, other.error);
  assert.equal(
    subjects(vault).length,
    1,
    "правка вне vault коммитов не делает",
  );
  assert.equal(porcelain(vault), "");
});

test("чужая незакоммиченная правка переживает коммит и в него не попадает", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ title: "Первая" }));

  const foreign = join(vault, "cards", "notes", "чужая.md");
  writeFileSync(foreign, "# Чужая правка владельца\n");
  const result = await tool.card(
    card({ title: "Вторая", body: "Вторая карточка." }),
  );
  assert.equal(result.ok, true, result.error);

  assert.equal(readFileSync(foreign, "utf8"), "# Чужая правка владельца\n");
  assert.deepEqual(touched(vault), ["cards/notes/вторая.md"]);
  assert.match(porcelain(vault), /^\?\? cards\/notes\/чужая\.md$/mu);
  assert.deepEqual(subjects(vault), ["card вторая: fact", "card первая: fact"]);
});

test("двадцать параллельных правок разных карточек дают двадцать коммитов", async (t) => {
  const vault = makeVault(t);
  const titles = Array.from({ length: 20 }, (_, index) => `Карточка-${index}`);
  const results = await Promise.all(
    titles.map((title, index) =>
      tool.card(card({ body: `Факт ${index}.`, title: title })),
    ),
  );
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.error),
    [],
  );
  assert.equal(subjects(vault).length, 20);
  for (const title of titles) {
    const file = join(vault, "cards", "notes", `${title.toLowerCase()}.md`);
    assert.match(readFileSync(file, "utf8"), /^# /mu);
  }
  assert.equal(porcelain(vault), "");
  assert.equal(trySh(["fsck", "--no-progress"], vault).length >= 0, true);
});

test("пять параллельных правок одной карточки не теряют ни одну", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ title: "Одна" }));
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      tool.card(
        card({
          body: `Уточнение ${index}.`,
          description: `Описание ${index}`,
          title: "Одна",
        }),
      ),
    ),
  );
  const ok = results.filter((result) => result.ok).length;
  assert.equal(ok, 5, JSON.stringify(results.map((result) => result.error)));
  assert.equal(subjects(vault).length, 6);
  assert.equal(porcelain(vault), "");
  const text = readFileSync(join(vault, "cards", "notes", "одна.md"), "utf8");
  assert.match(text, /^## Log$/mu);
  assert.equal(text.match(/Уточнение \d\./gu)?.length, 5);
});

test("vault не репозиторий: правка записывается, причина отказа в журнале", async (t) => {
  const vault = makeVault(t, { repo: false });
  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Без-гита" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(
    readFileSync(join(vault, "cards", "notes", "без-гита.md"), "utf8"),
    /^# /mu,
  );
  assert.match(logged, /^\[vault-commit\] card без-гита: fact: /u);
  assert.equal(logged.split("\n").length, 1, "причина отказа - одна строка");
});

test("git не в PATH: правка записывается, ход не падает", async (t) => {
  const vault = makeVault(t);
  const path = process.env.PATH;
  const { logged, value: result } = await journal(async () => {
    process.env.PATH = "";
    try {
      return await tool.card(card({ title: "Без-PATH" }));
    } finally {
      process.env.PATH = path;
    }
  });
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /git не найден в PATH/u);
  assert.equal(existsSync(join(vault, "cards", "notes", "без-path.md")), true);
  assert.deepEqual(subjects(vault), []);
});

test("в vault нет identity: коммит всё равно есть, конфиг владельца не тронут", async (t) => {
  const vault = makeVault(t, { identity: "" });
  const previous = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  sh(["config", "user.useConfigOnly", "true"], vault);
  t.after(() => {
    process.env.GIT_CONFIG_GLOBAL = previous.global;
    process.env.GIT_CONFIG_SYSTEM = previous.system;
  });

  const result = await tool.card(card({ title: "Без имени" }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(subjects(vault), ["card без-имени: fact"]);
  assert.equal(
    sh(["log", "-1", "--pretty=%an <%ae>"], vault),
    "Iva <iva@localhost>",
  );
  assert.equal(
    trySh(["config", "--get", "user.email"], vault),
    "",
    "чужой конфиг не тронут",
  );
});

test("замок индекса от убитого коммита снимается, следующий коммит работает", async (t) => {
  const vault = makeVault(t);
  await tool.card(card({ title: "До-замка" }));
  const lock = join(vault, ".git", "index.lock");
  writeFileSync(lock, "");
  const past = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(lock, past, past);

  const result = await tool.card(card({ title: "После-замка" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(
    existsSync(lock),
    false,
    "огрызок убитого коммита не остаётся навсегда",
  );
  assert.deepEqual(subjects(vault), [
    "card после-замка: fact",
    "card до-замка: fact",
  ]);
});

test("свежий замок индекса: правка сохранена, причина в журнале, следующий коммит проходит", async (t) => {
  const vault = makeVault(t);
  const lock = join(vault, ".git", "index.lock");
  writeFileSync(lock, "");
  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Занят" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /lock file may be stale|index\.lock/u);
  assert.deepEqual(subjects(vault), []);
  assert.equal(
    readFileSync(join(vault, "cards", "notes", "занят.md"), "utf8").length > 0,
    true,
  );

  rmSync(lock);
  const later = await tool.card(card({ title: "Свободен" }));
  assert.equal(later.ok, true, later.error);
  assert.deepEqual(subjects(vault), ["card свободен: fact"]);
});

test("SIGKILL посреди коммита не ломает ни vault, ни следующие коммиты", async (t) => {
  const vault = makeVault(t);
  const script = join(vault, "..", `killed-${String(process.pid)}.mts`);
  t.after(() => rmSync(script, { force: true }));
  writeFileSync(
    script,
    `const seam = await import(${JSON.stringify(join(REPO, "agent", "lib", "vault-commit.ts"))});
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const vault = process.env.ASSISTANT_VAULT_DIR;
for (let index = 0; index < 40; index += 1) {
  const file = join(vault, "cards", "notes", \`loop-\${index}.md\`);
  writeFileSync(file, \`# loop \${index}\\n\`);
  process.stdout.write("written\\n");
  await seam.commitVaultWrite(\`card loop-\${index}: fact\`, [file]);
}
`,
  );
  const child = spawn(
    process.execPath,
    ["--import", join(REPO, "scripts", "lib", "ts-esm-hooks.ts"), script],
    { cwd: REPO, env: { ...process.env, ASSISTANT_VAULT_DIR: vault } },
  );
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");

  // Ровно то, что делает ночной подметальщик: свой add -A и свой коммит.
  const lock = join(vault, ".git", "index.lock");
  if (existsSync(lock))
    utimesSync(lock, new Date(Date.now() - 5 * 60 * 1000), new Date());
  const swept = await tool.seam.commitVaultWrite(
    `chore: memory ${day()}`,
    trySh(["status", "--porcelain", "-z"], vault)
      .split("\0")
      .filter(Boolean)
      .map((entry) => join(vault, entry.slice(3))),
    vault,
  );
  assert.equal(swept.ok, true);
  assert.equal(existsSync(lock), false);
  assert.ok(subjects(vault).length >= 1, "после убийства коммит проходит");
  assert.equal(trySh(["fsck", "--no-progress"], vault).length >= 0, true);

  const after = await tool.card(card({ title: "После-смерти" }));
  assert.equal(after.ok, true, after.error);
  assert.equal(subjects(vault)[0], "card после-смерти: fact");
  assert.equal(porcelain(vault), "");
});

test("коммит правки в vault из двух тысяч карточек стоит десятки миллисекунд", async (t) => {
  // Замер в одном и том же vault и в один и тот же момент: сначала без репозитория
  // (коммит пропускается), потом с ним. Разница и есть цена коммита, а не цена машины.
  const vault = makeVault(t, { repo: false });
  for (let index = 0; index < 2000; index += 1) {
    writeFileSync(
      join(vault, "cards", "notes", `bulk-${index}.md`),
      `---\ntype: "note"\ndescription: "Карточка ${index}"\n---\n\n# Карточка ${index}\n\nТекст.\n`,
    );
  }
  const medianWrite = async (prefix: string): Promise<number> => {
    const times: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const started = Date.now();
      const result = await tool.card(card({ title: `${prefix}-${index}` }));
      assert.equal(result.ok, true, result.error);
      times.push(Date.now() - started);
    }
    return [...times].sort((one, other) => one - other)[2];
  };
  const { value: plain } = await journal(() => medianWrite("Без-гита"));
  sh(["init", "-q", "-b", "main"], vault);
  sh(["config", "user.email", "vault@example.com"], vault);
  sh(["config", "user.name", "Vault"], vault);
  sh(["add", "-A"], vault);
  sh(["commit", "-q", "-m", "bulk"], vault);
  const committed = await medianWrite("С-гитом");
  const delta = committed - plain;
  console.log(
    `      vault из 2000 карточек: правка ${String(plain)} мс, с коммитом ${String(committed)} мс, цена коммита ${String(delta)} мс`,
  );
  assert.ok(subjects(vault).includes("card с-гитом-0: fact"));
  assert.ok(
    committed < 1000,
    `правка с коммитом заняла ${String(committed)} мс`,
  );
  assert.ok(delta < 300, `коммит правки занял ${String(delta)} мс`);
});

/** Чужой процесс в репозитории vault: правки владельца, упавший hook, висящий hook. */
function hook(vault: string, body: string): void {
  const path = join(vault, ".git", "hooks", "pre-commit");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("чужой staged-файл остаётся staged и в коммит записи не уезжает", async (t) => {
  const vault = makeVault(t);
  const foreign = join(vault, "owner-staged.md");
  writeFileSync(foreign, "Чужая работа владельца\n");
  sh(["add", "--", "owner-staged.md"], vault);

  const result = await tool.card(
    card({ body: "Вторая карточка.", title: "Вторая" }),
  );
  assert.equal(result.ok, true, result.error);

  assert.deepEqual(touched(vault), ["cards/notes/вторая.md"]);
  assert.deepEqual(subjects(vault), ["card вторая: fact"]);
  assert.match(
    porcelain(vault),
    /^A {2}owner-staged\.md$/mu,
    "работа владельца остаётся в индексе, а не в истории памяти",
  );
  assert.equal(readFileSync(foreign, "utf8"), "Чужая работа владельца\n");
});
test("осиротевшая запись убитого хода не уезжает в следующий коммит", async (t) => {
  const vault = makeVault(t);
  // Так выглядит индекс после SIGKILL посреди коммита: карточка написана и добавлена,
  // коммита нет. Следующая запись обязана назвать только свои пути.
  writeFileSync(
    join(vault, "cards", "notes", "сирота.md"),
    '---\ntype: "note"\ndescription: "Сирота"\n---\n\n# Сирота\n\nТекст.\n',
  );
  sh(["add", "--", "cards/notes/сирота.md"], vault);

  const result = await tool.card(
    card({ body: "Следующая карточка.", title: "Следующая" }),
  );
  assert.equal(result.ok, true, result.error);

  assert.deepEqual(touched(vault), ["cards/notes/следующая.md"]);
  assert.match(porcelain(vault), /^A {2}cards\/notes\/сирота\.md$/mu);
});
test("упавший pre-commit: запись на диске, коммита нет, карточка не остаётся staged", async (t) => {
  const vault = makeVault(t);
  hook(vault, "echo 'hook says no' >&2\nexit 1");

  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Падхук" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /hook says no/u);
  assert.equal(existsSync(join(vault, "cards", "notes", "падхук.md")), true);
  assert.deepEqual(subjects(vault), []);
  assert.match(
    trySh(
      ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
      vault,
    ),
    /^\?\? cards\/notes\/падхук\.md$/mu,
    "брошенная правка не живёт в чужом индексе до следующего коммита",
  );

  rmSync(join(vault, ".git", "hooks", "pre-commit"));
  const later = await tool.card(
    card({ body: "Следующая карточка.", title: "Следующая" }),
  );
  assert.equal(later.ok, true, later.error);
  assert.deepEqual(touched(vault), ["cards/notes/следующая.md"]);
  assert.deepEqual(subjects(vault), ["card следующая: fact"]);
});
test("vault внутри чужого репозитория: память не уезжает в чужую историю", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "iva-parent-"));
  t.after(() =>
    rmSync(parent, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  sh(["init", "-q", "-b", "main"], parent);
  sh(["config", "user.email", "owner@example.com"], parent);
  sh(["config", "user.name", "Owner"], parent);
  writeFileSync(join(parent, "SOURCE.md"), "чужой репозиторий\n");
  sh(["add", "-A"], parent);
  sh(["commit", "-q", "-m", "parent base"], parent);
  const vault = join(parent, "vault");
  mkdirSync(join(vault, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(vault, "schema.json"));
  process.env.ASSISTANT_VAULT_DIR = vault;

  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Внутри" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(vault, "cards", "notes", "внутри.md")), true);
  assert.deepEqual(
    sh(["log", "--pretty=%s"], parent).split("\n"),
    ["parent base"],
    "чужой репозиторий не знает о записи в память",
  );
  assert.equal(trySh(["status", "--porcelain"], parent), "?? vault/");
  assert.match(logged, /^\[vault-commit\] card внутри: fact: /u);
  assert.equal(logged.split("\n").length, 1, "причина отказа - одна строка");
});
test("git не ответил за таймаут: причина - таймаут, а не «нет в PATH»", async (t) => {
  const vault = makeVault(t);
  const pidFile = join(process.env.ASSISTANT_DATA_DIR!, "hook.pid");
  hook(vault, `echo $$ > "${pidFile}"; exec sleep 40`);
  t.after(() => {
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      }
    }
  });
  writeFileSync(
    join(process.env.ASSISTANT_DATA_DIR!, "settings.json"),
    JSON.stringify({ night: { gitTimeoutMs: 1500, raisesPerNight: 0 } }),
  );
  const started = Date.now();
  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Тишина" })),
  );
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true, result.error);
  assert.equal(existsSync(join(vault, "cards", "notes", "тишина.md")), true);
  assert.match(logged, /не ответил/u);
  assert.doesNotMatch(logged, /PATH/u);
  assert.ok(elapsed < 8_000, `запись ждала ${String(elapsed)} мс`);
});
test("в журнал уходит причина отказа, а не подсказка git", async (t) => {
  const vault = makeVault(t);
  writeFileSync(join(vault, ".gitignore"), "cards/notes/*\n");
  sh(["add", "--", ".gitignore"], vault);
  sh(["commit", "-q", "-m", "ignore cards"], vault);

  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Скрытая" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /вне git-бэкапа по ignore/u);
  assert.doesNotMatch(logged, /hint:/u);
});
test("read-only .git: причина в журнале, без пустого ожидания", async (t) => {
  const vault = makeVault(t);
  chmodSync(join(vault, ".git"), 0o500);
  const started = Date.now();
  const outcome = await journal(async () => {
    try {
      return await tool.card(card({ title: "Закрытый" }));
    } finally {
      chmodSync(join(vault, ".git"), 0o700);
    }
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.value.ok, true, outcome.value.error);
  assert.match(outcome.logged, /Permission denied/u);
  assert.ok(elapsed < 700, `запись ждала ${String(elapsed)} мс без причины`);
});

/** Соседний чужой репозиторий: в него смотрят GIT_*-переменные из окружения. На каталог
 * vault не влияет — инструменты читают его из ASSISTANT_VAULT_DIR, который уже выставлен. */
function foreignRepo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-foreign-"));
  t.after(() =>
    rmSync(dir, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    }),
  );
  sh(["init", "-q", "-b", "main"], dir);
  sh(["config", "user.email", "foreign@example.com"], dir);
  sh(["config", "user.name", "Foreign"], dir);
  writeFileSync(join(dir, "FOREIGN.md"), "чужой репозиторий\n");
  sh(["add", "-A"], dir);
  sh(["commit", "-q", "-m", "foreign base"], dir);
  return dir;
}

/** Отпечаток репозитория целиком: HEAD, индекс, дерево и незакоммиченное состояние. */
function fingerprint(dir: string): string {
  return [
    trySh(["rev-parse", "HEAD"], dir),
    trySh(["ls-files", "-s", "-z"], dir),
    trySh(["status", "--porcelain=v2", "-z", "-uall"], dir),
  ].join("\n");
}

/** Список незакоммиченного без схлопывания каталогов и без кавычек. */
function statusAll(vault: string): string {
  return trySh(
    ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"],
    vault,
  );
}
/** Состояние индекса одного пути: что владелец видит в status плюс флаги записи индекса -
 * intent-to-add живёт только в них. */
function indexState(vault: string, rel: string): string {
  const status = trySh(
    [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v2",
      "-uall",
      "--",
      rel,
    ],
    vault,
  );
  const flags = /flags: (\w+)/u.exec(
    trySh(["ls-files", "--debug", "--", rel], vault),
  )?.[1];
  return `${status}|${flags ?? "нет"}`;
}

async function withGitDir<T>(value: string, run: () => Promise<T>): Promise<T> {
  const original = process.env.GIT_DIR;
  process.env.GIT_DIR = value;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
  }
}

test("чужой GIT_DIR в окружении не уводит коммит из vault", async (t) => {
  const vault = makeVault(t);
  const foreign = foreignRepo(t);
  const before = fingerprint(foreign);
  const { logged, value: result } = await withGitDir(
    join(foreign, ".git"),
    () => journal(() => tool.card(card({ title: "Не-туда" }))),
  );

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(subjects(vault), ["card не-туда: fact"]);
  assert.deepEqual(
    subjects(foreign),
    ["foreign base"],
    "чужая история не растёт",
  );
  assert.equal(fingerprint(foreign), before, "чужой репозиторий не тронут");
  assert.equal(logged, "");
});

test("имя файла с глобом забирает только свой файл", async (t) => {
  const vault = makeVault(t);
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes", "отчёт-январь.md"), "ЧУЖОЙ ЯНВАРЬ\n");
  writeFileSync(join(vault, "notes", "отчёт-февраль.md"), "ЧУЖОЙ ФЕВРАЛЬ\n");

  const result = await tool.file(
    join(vault, "notes", "отчёт-*.md"),
    "файл агента\n",
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(touched(vault), ["notes/отчёт-*.md"]);
  assert.match(statusAll(vault), /^\?\? notes\/отчёт-январь\.md$/mu);
  assert.match(statusAll(vault), /^\?\? notes\/отчёт-февраль\.md$/mu);
});

test("intent-to-add владельца переживает неудачный коммит", async (t) => {
  const vault = makeVault(t);
  mkdirSync(join(vault, "library"), { recursive: true });
  const file = join(vault, "library", "2026-09-21.md");
  writeFileSync(file, "старое\n");
  sh(["add", "-N", "--", "library/2026-09-21.md"], vault);
  const before = indexState(vault, "library/2026-09-21.md");
  hook(vault, "exit 1");

  const result = await tool.file(file, "новое содержимое\n");
  assert.equal(result.ok, true, result.error);
  assert.equal(
    indexState(vault, "library/2026-09-21.md"),
    before,
    "помета intent-to-add возвращается вместе с записью индекса",
  );
});

test("отказ git add на одном из путей не оставляет остальные застейдженными", async (t) => {
  const vault = makeVault(t);
  // Пропавший неотслеживаемый путь: add стейджит соседний, но выходит с ошибкой.
  const good = join(vault, "cards", "notes", "остаток.md");
  writeFileSync(good, "# Остаток\n");

  const outcome = await tool.seam.commitVaultWrite(
    "file остаток: write",
    [good, join(vault, "cards", "notes", "игнор.md")],
    vault,
  );
  assert.equal(outcome.ok, false);
  assert.match(
    outcome.ok ? "" : outcome.reason,
    /pathspec.*did not match any files/u,
  );
  assert.equal(
    statusAll(vault),
    "?? cards/notes/остаток.md",
    "ничего из отказавшего add не осталось в индексе",
  );
});

test("ignore новых путей не отменяет соседний бэкап и виден в журнале (#257)", async (t) => {
  const vault = makeVault(t);
  writeFileSync(join(vault, ".gitignore"), "cards/notes/private.md\n");
  sh(["add", ".gitignore"], vault);
  sh(["commit", "-qm", "ignore"], vault);
  const good = join(vault, "cards/notes/public.md");
  const privateFile = join(vault, "cards/notes/private.md");
  writeFileSync(good, "public\n");
  writeFileSync(privateFile, "private\n");
  writeFileSync(join(vault, "owner.md"), "staged owner\n");
  sh(["add", "owner.md"], vault);
  const { value: outcome, logged } = await journal(() =>
    tool.seam.commitVaultWrite("night", [good, privateFile], vault),
  );
  assert.deepEqual(outcome, {
    ok: true,
    committed: true,
    skipped: ["cards/notes/private.md"],
  });
  assert.deepEqual(touched(vault), ["cards/notes/public.md"]);
  assert.match(logged, /вне git-бэкапа по ignore.*private\.md/u);
  assert.equal(statusAll(vault), "A  owner.md");
  const skipped = await tool.seam.commitVaultWrite(
    "private",
    [privateFile],
    vault,
  );
  assert.deepEqual(skipped, {
    ok: true,
    committed: false,
    skipped: ["cards/notes/private.md"],
  });
  assert.equal(readFileSync(privateFile, "utf8"), "private\n");
});

test("отслеживаемый литеральный путь под ignored каталогом продолжает историю (#257)", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/отчёт-*.md";
  const file = join(vault, path);
  writeFileSync(file, "before\n");
  sh(["--literal-pathspecs", "add", "--", path], vault);
  sh(["commit", "-qm", "tracked"], vault);
  writeFileSync(join(vault, ".gitignore"), "cards/\n");
  sh(["add", ".gitignore"], vault);
  sh(["commit", "-qm", "ignore parent"], vault);
  writeFileSync(file, "after\n");
  writeFileSync(join(vault, "cards/notes/отчёт-private.md"), "private\n");
  const outcome = await tool.seam.commitVaultWrite("night", [file], vault);
  assert.deepEqual(outcome, { ok: true, committed: true });
  assert.deepEqual(touched(vault), [path]);
  assert.equal(sh(["show", `HEAD:${path}`], vault), "after");
  assert.equal(sh(["ls-files", "cards/notes/отчёт-private.md"], vault), "");
});

for (const staged of [false, true]) {
  test(`удаление tracked пути под ignore (${staged ? "staged" : "unstaged"}) сохраняется`, async (t) => {
    const vault = makeVault(t);
    const path = "cards/notes/deleted.md";
    const file = join(vault, path);
    writeFileSync(file, "before\n");
    sh(["add", path], vault);
    sh(["commit", "-qm", "tracked"], vault);
    rmSync(file);
    if (staged) sh(["add", path], vault);
    writeFileSync(join(vault, ".gitignore"), "cards/\n");
    const outcome = await tool.seam.commitVaultWrite("delete", [file], vault);
    assert.deepEqual(outcome, { ok: true, committed: true });
    assert.deepEqual(touched(vault), [path]);
    assert.equal(sh(["ls-files", path], vault), "");
  });
}

test("удалённый файл по пути через символическую ссылку на vault не теряется", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/gone.md";
  writeFileSync(join(vault, path), "before\n");
  sh(["add", path], vault);
  sh(["commit", "-qm", "tracked"], vault);
  // Вызывающий держит vault по ссылке (на macOS так лежит весь tmp): у удалённого
  // файла реального пути уже нет, и раньше шов считал такой путь чужим и молчал.
  const link = `${vault}-link`;
  symlinkSync(vault, link);
  t.after(() => rmSync(link, { force: true }));
  rmSync(join(vault, path));
  const outcome = await tool.seam.commitVaultWrite(
    "delete",
    [join(link, path)],
    vault,
  );
  assert.deepEqual(outcome, { ok: true, committed: true });
  assert.equal(sh(["ls-files", path], vault), "");
});

test("отказ hook после force tracked add возвращает staged владельца под ignore", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/partial.md";
  const file = join(vault, path);
  writeFileSync(file, "base\n");
  sh(["add", path], vault);
  sh(["commit", "-qm", "tracked"], vault);
  writeFileSync(file, "owner staged\n");
  sh(["add", path], vault);
  writeFileSync(join(vault, ".gitignore"), "cards/\n");
  writeFileSync(file, "night\n");
  const beforeIndex = sh(["ls-files", "-s", "--", path], vault);
  hook(vault, "exit 1");
  const outcome = await tool.seam.commitVaultWrite("night", [file], vault);
  assert.equal(outcome.ok, false);
  assert.equal(sh(["ls-files", "-s", "--", path], vault), beforeIndex);
  assert.equal(readFileSync(file, "utf8"), "night\n");
});

test("intent-to-add возвращается после отказа hook под ignored родителем", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/intent.md";
  const file = join(vault, path);
  writeFileSync(file, "before\n");
  sh(["add", "-N", path], vault);
  writeFileSync(join(vault, ".gitignore"), "cards/\n");
  const before = indexState(vault, path);
  writeFileSync(file, "night\n");
  hook(vault, "exit 1");
  const outcome = await tool.seam.commitVaultWrite("night", [file], vault);
  assert.equal(outcome.ok, false);
  assert.equal(indexState(vault, path), before);
});

test("git rm --cached плюс ignore не возвращает файл владельца в бэкап", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/private.md";
  const file = join(vault, path);
  writeFileSync(file, "before\n");
  sh(["add", path], vault);
  sh(["commit", "-qm", "tracked"], vault);
  sh(["rm", "--cached", path], vault);
  writeFileSync(join(vault, ".gitignore"), "cards/\n");
  writeFileSync(file, "after\n");
  const before = sh(["diff", "--cached", "--raw"], vault);
  const head = sh(["rev-parse", "HEAD"], vault);
  const skip = await tool.seam.commitVaultWrite("private", [file], vault);
  assert.deepEqual(skip, { ok: true, committed: false, skipped: [path] });
  assert.equal(sh(["rev-parse", "HEAD"], vault), head);
  const good = join(vault, "public.md");
  writeFileSync(good, "public\n");
  const mixed = await tool.seam.commitVaultWrite("mixed", [file, good], vault);
  assert.deepEqual(mixed, { ok: true, committed: true, skipped: [path] });
  assert.deepEqual(touched(vault), ["public.md"]);
  assert.equal(sh(["ls-files", "--", path], vault), "");
  assert.equal(sh(["diff", "--cached", "--raw"], vault), before);
  assert.equal(readFileSync(file, "utf8"), "after\n");
});

test("git rm --cached плюс ignore сохраняет оборванную ссылку вне бэкапа", async (t) => {
  const vault = makeVault(t);
  const path = "cards/notes/private-link";
  const file = join(vault, path);
  symlinkSync("missing-target", file);
  sh(["add", path], vault);
  sh(["commit", "-qm", "tracked link"], vault);
  sh(["rm", "--cached", path], vault);
  writeFileSync(join(vault, ".gitignore"), "cards/\n");
  const before = sh(["diff", "--cached", "--raw"], vault);
  const result = await tool.seam.commitVaultWrite("private", [file], vault);
  assert.deepEqual(result, { ok: true, committed: false, skipped: [path] });
  assert.equal(sh(["diff", "--cached", "--raw"], vault), before);
  assert.equal(sh(["ls-files", "--", path], vault), "");
});

test("force tracked add не выходит из vault через символическую ссылку", async (t) => {
  const vault = makeVault(t);
  const foreign = foreignRepo(t);
  const file = join(foreign, "outside.md");
  writeFileSync(file, "outside\n");
  symlinkSync(foreign, join(vault, "linked"), "dir");
  const before = fingerprint(foreign);
  const outcome = await tool.seam.commitVaultWrite(
    "night",
    [join(vault, "linked/outside.md")],
    vault,
  );
  assert.deepEqual(outcome, { ok: true, committed: false });
  assert.deepEqual(subjects(vault), []);
  assert.equal(fingerprint(foreign), before);
});

test("vault подкаталог своего репозитория: причина называет корень выше", async (t) => {
  const parent = foreignRepo(t);
  const vault = join(parent, "vault");
  mkdirSync(join(vault, "cards", "notes"), { recursive: true });
  cpSync(SCHEMA, join(vault, "schema.json"));
  process.env.ASSISTANT_VAULT_DIR = vault;

  const { logged, value: result } = await journal(() =>
    tool.card(card({ title: "Подкаталог" })),
  );
  assert.equal(result.ok, true, result.error);
  assert.match(logged, /выше vault/u);
  assert.doesNotMatch(logged, /чужой/u);
});

test("подметальщик Brain коммитит только в свой репозиторий vault", async (t) => {
  const vault = makeVault(t);
  const foreign = foreignRepo(t);
  const before = fingerprint(foreign);
  writeFileSync(join(vault, "cards", "notes", "остаток.md"), "# Остаток\n");
  const outcome = await withGitDir(join(foreign, ".git"), () =>
    tool.seam.commitVaultSweep("chore: memory 2026-09-21", vault),
  );

  assert.equal(outcome.ok, true);
  assert.deepEqual(subjects(vault), ["chore: memory 2026-09-21"]);
  assert.deepEqual(touched(vault), ["cards/notes/остаток.md"]);
  assert.deepEqual(subjects(foreign), ["foreign base"]);
  assert.equal(fingerprint(foreign), before);
});

test("нечего коммитить: коммита нет, журнал молчит, чужой staged цел", async (t) => {
  const vault = makeVault(t);
  mkdirSync(join(vault, "library"), { recursive: true });
  const file = join(vault, "library", "2026-09-21.md");
  writeFileSync(file, "текст\n");
  sh(["add", "--", "library/2026-09-21.md"], vault);
  sh(["commit", "-q", "-m", "library"], vault);
  const foreign = join(vault, "owner-staged.md");
  writeFileSync(foreign, "чужая работа\n");
  sh(["add", "--", "owner-staged.md"], vault);

  const { logged, value: result } = await journal(() =>
    tool.file(file, "текст\n"),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(subjects(vault), ["library"]);
  assert.equal(
    logged,
    "",
    "нечего коммитить - это не отказ и не строка в журнале",
  );
  assert.match(statusAll(vault), /^A {2}owner-staged\.md$/mu);
  assert.equal(readFileSync(file, "utf8"), "текст\n");
});

// Git на VPS с русской локалью отвечает по-русски, а шов узнаёт «нечего коммитить» и занятый
// индекс по английскому тексту: язык сообщений у вызовов шва свой, какой бы ни был у процесса.
test("окружение git: свой язык сообщений, буквальные пути и ни одной чужой GIT_*", async () => {
  const seam = (await import(
    join(REPO, "agent", "lib", "vault-commit.ts")
  )) as typeof import("../agent/lib/vault-commit.ts");
  const env = seam.gitEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    LANG: "ru_RU.UTF-8",
    LANGUAGE: "ru",
    LC_ALL: "ru_RU.UTF-8",
    LC_MESSAGES: "ru_RU.UTF-8",
    GIT_DIR: "/чужой/.git",
    GIT_INDEX_FILE: "/чужой/.git/index",
    GIT_LITERAL_PATHSPECS: "0",
    SECRET_TOKEN: "x",
  });
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.LANGUAGE, "C");
  assert.equal(env.GIT_LITERAL_PATHSPECS, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/user");
  assert.deepEqual(
    Object.keys(env).filter(
      (name) => name.startsWith("GIT_") && name !== "GIT_LITERAL_PATHSPECS",
    ),
    [],
  );
  assert.equal("SECRET_TOKEN" in env, false);
});

// Чтение истории тем же раннером: null только когда ls-tree говорит «пути нет»; битая ревизия,
// пропавший объект коммита, пропавший блоб — исключение, не пустой текст.
test("vaultShow отдаёт текст пути, null на отсутствующем пути и бросает на битой ревизии и пропавших объектах", async (t) => {
  const vault = makeVault(t);
  const { vaultHead, vaultShow } = (await import(
    join(REPO, "agent", "lib", "vault-commit.ts")
  )) as typeof import("../agent/lib/vault-commit.ts");
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  sh(["add", "CORE.md"], vault);
  sh(["commit", "-q", "-m", "core"], vault);
  const head = sh(["rev-parse", "HEAD"], vault).trim();

  assert.equal(await vaultHead(vault), head);
  assert.equal(await vaultShow(vault, head, "CORE.md"), "# CORE\n");
  assert.equal(await vaultShow(vault, head, "missing.md"), null);
  await assert.rejects(
    vaultShow(vault, "deadbeef", "CORE.md"),
    /ls-tree deadbeef/u,
  );

  const drop = (sha: string) =>
    rmSync(join(vault, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
  drop(sh(["rev-parse", `${head}:CORE.md`], vault).trim());
  await assert.rejects(vaultShow(vault, head, "CORE.md"), /git show/u);
  drop(head);
  await assert.rejects(vaultShow(vault, head, "CORE.md"), /ls-tree/u);
});

// Настоящий fake git получает те же аргументы и окружение, зависает без дочернего sleep.
// Проба только ускоряет таймер раннера; исходный срок 12/24 с сохраняется в трассе.
for (const hangs of [1, 2])
  test(`self-heal git: hangs ${hangs} time(s), exactly one retry`, async (t) => {
    const vault = makeVault(t);
    const data = process.env.ASSISTANT_DATA_DIR!;
    const bin = join(data, "bin");
    mkdirSync(bin);
    const count = join(data, "hang-count");
    const fake = join(bin, "git");
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const countFile = ${JSON.stringify(count)};
let count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
if (args.includes("commit") && count < ${hangs}) {
  fs.writeFileSync(countFile, String(count + 1));
  setInterval(() => {}, 1000);
} else {
  const result = cp.spawnSync("/usr/bin/git", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
    );
    chmodSync(fake, 0o755);
    const file = join(vault, "pending.md");
    writeFileSync(file, "owner bytes\n");
    const trace = join(data, "timeouts.jsonl");
    const preload = `import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = cp.execFile;
cp.execFile = (file, args, options, callback) => {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, timeout: options.timeout }) + "\\n");
  return original(file, args, { ...options, timeout: args.includes("commit") && (!fs.existsSync(${JSON.stringify(count)}) || Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) < ${hangs}) ? options.timeout / 20 : options.timeout }, callback);
};
syncBuiltinESMExports();`;
    const seam = join(REPO, "agent/lib/vault-commit.ts");
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(REPO, "scripts/lib/ts-esm-hooks.ts"),
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "--input-type=module",
        "-e",
        `
      const { commitVaultWrite } = await import(${JSON.stringify(seam)});
      console.log(JSON.stringify(await commitVaultWrite("night test", [${JSON.stringify(file)}], ${JSON.stringify(vault)})));
    `,
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = await new Promise<number | null>((accept) =>
      child.once("close", accept),
    );
    assert.equal(exit, 0, stderr);
    const result = JSON.parse(stdout) as {
      ok: boolean;
      reason?: string;
      committed?: boolean;
    };
    assert.equal(result.ok, hangs === 1, stderr);
    if (hangs === 1) {
      assert.equal(result.committed, true);
      assert.equal(sh(["show", "HEAD:pending.md"], vault), "owner bytes");
    } else assert.equal(result.reason, "git не ответил за 24 с");
    const settings = JSON.parse(
      readFileSync(join(data, "settings.json"), "utf8"),
    ) as { night: { gitTimeoutMs: number } };
    assert.equal(settings.night.gitTimeoutMs, 24_000);
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as { args: string[]; timeout: number });
    assert.deepEqual(
      calls
        .filter((row) => row.args.includes("commit"))
        .map((row) => row.timeout),
      [12_000, 24_000],
    );
    assert.equal(readFileSync(count, "utf8"), String(hangs));
    assert.equal(readFileSync(file, "utf8"), "owner bytes\n");
  });

function repairCommitProcess(
  vault: string,
  path: string,
  bin: string,
  preload: string,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(REPO, "scripts/lib/ts-esm-hooks.ts"),
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      "--input-type=module",
      "-e",
      `
      const { commitVaultWrite } = await import(${JSON.stringify(join(REPO, "agent/lib/vault-commit.ts"))});
      console.log(JSON.stringify(await commitVaultWrite(${JSON.stringify(`repair ${path}`)}, [${JSON.stringify(join(vault, path))}], ${JSON.stringify(vault)})));
    `,
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((accept) =>
    child.once("close", (code) => accept({ code, stdout, stderr })),
  );
  return { child, result };
}

for (const memoryOnly of [false, true])
  test(`repair lock: a live writer survives an aged index lock; memory-only raise=${memoryOnly}`, async (t) => {
    const vault = makeVault(t);
    const data = process.env.ASSISTANT_DATA_DIR!;
    const settings = join(data, "settings.json");
    const bytes = memoryOnly
      ? "{broken"
      : JSON.stringify({
          night: { gitTimeoutMs: 24_000, maxGitTimeoutMs: 24_000 },
        });
    writeFileSync(settings, bytes);
    const trace = join(data, "trace.jsonl");
    const ready = join(data, "ready.pid");
    const release = join(data, "release");
    const count = join(data, "add-count");
    const lock = join(vault, ".git/index.lock");
    const binA = join(data, "bin-a");
    const binB = join(data, "bin-b");
    mkdirSync(binA);
    mkdirSync(binB);
    const fake = (hold: boolean) => `#!${process.execPath}
const fs = require("node:fs"); const cp = require("node:child_process");
const args = process.argv.slice(2);
const run = () => process.exit(cp.spawnSync("/usr/bin/git", args, { stdio: "inherit" }).status ?? 1);
if (${hold} && args[0] === "add") {
  const countFile = ${JSON.stringify(count)};
  const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(n + 1));
  if (${memoryOnly} && n === 0) setInterval(() => {}, 1000);
  else {
    const lock = ${JSON.stringify(lock)};
    const fd = fs.openSync(lock, "wx"); fs.writeSync(fd, String(process.pid));
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer); fs.closeSync(fd);
      if (fs.existsSync(lock)) fs.unlinkSync(lock);
      run();
    }, 10);
  }
} else run();
`;
    for (const [bin, hold] of [
      [binA, true],
      [binB, false],
    ] as const) {
      writeFileSync(join(bin, "git"), fake(hold));
      chmodSync(join(bin, "git"), 0o755);
    }
    const preload = (
      role: string,
    ) => `import fs from "node:fs"; import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const lock = fs.realpathSync(${JSON.stringify(vault)}) + "/.git/index.lock";
const note = row => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ role: ${JSON.stringify(role)}, ...row }) + "\\n");
const remove = fs.rmSync; const exec = cp.execFile;
fs.rmSync = (file, ...args) => {
  if (String(file) === lock) {
    const owner = Number(fs.readFileSync(${JSON.stringify(ready)}, "utf8"));
    let live = true; try { process.kill(owner, 0); } catch (error) { if (error.code === "ESRCH") live = false; else throw error; }
    note({ event: "remove-index-lock", ageMs: Date.now() - fs.statSync(file).mtimeMs, ownerAStillRunning: live });
  }
  return remove(file, ...args);
};
let adds = 0;
cp.execFile = (file, args, options, callback) => {
  note({ event: "git", args, timeout: options.timeout });
  const firstHang = ${memoryOnly && role === "A"} && args[0] === "add" && adds++ === 0;
  return exec(file, args, { ...options, timeout: firstHang ? 200 : options.timeout }, callback);
};
syncBuiltinESMExports();`;
    writeFileSync(join(vault, "a.md"), "writer A\n");
    writeFileSync(join(vault, "b.md"), "writer B\n");
    writeFileSync(join(vault, "owner.md"), "owner staged bytes\n");
    sh(["add", "owner.md"], vault);
    const a = repairCommitProcess(vault, "a.md", binA, preload("A"));
    let bResult:
      Awaited<ReturnType<typeof repairCommitProcess>["result"]> | undefined;
    let protectedWhileAlive: boolean;
    let aResult: Awaited<typeof a.result>;
    try {
      for (let wait = 0; wait < 500 && !existsSync(ready); wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(existsSync(ready), "writer A reached its live git add");
      const aged = new Date(Date.now() - 16_000);
      utimesSync(lock, aged, aged);
      bResult = await repairCommitProcess(vault, "b.md", binB, preload("B"))
        .result;
      process.kill(Number(readFileSync(ready, "utf8")), 0);
      protectedWhileAlive = existsSync(lock);
    } finally {
      writeFileSync(release, "go");
      aResult = await a.result;
    }
    const resumed = await repairCommitProcess(
      vault,
      "b.md",
      binB,
      preload("B-after"),
    ).result;
    const rows = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map(
        (row) =>
          JSON.parse(row) as {
            role: string;
            event: string;
            ownerAStillRunning?: boolean;
            timeout?: number;
            args?: string[];
          },
      );
    const removals = rows.filter((row) => row.event === "remove-index-lock");
    t.diagnostic(
      JSON.stringify({
        memoryOnly,
        protectedWhileAlive,
        removals,
        aAddTimeouts: rows
          .filter((row) => row.role === "A" && row.args?.[0] === "add")
          .map((row) => row.timeout),
        contender: bResult?.stdout.trim(),
      }),
    );
    assert.ok(
      protectedWhileAlive,
      "contender must preserve the live writer's index lock",
    );
    assert.deepEqual(removals, [], "no seam removes the live writer's lock");
    assert.ok(bResult);
    assert.equal(bResult.code, 0, bResult.stderr);
    assert.equal((JSON.parse(bResult.stdout) as { ok: boolean }).ok, false);
    assert.equal(aResult.code, 0, aResult.stderr);
    assert.equal(
      (JSON.parse(aResult.stdout) as { committed: boolean }).committed,
      true,
    );
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(
      (JSON.parse(resumed.stdout) as { committed: boolean }).committed,
      true,
    );
    assert.equal(sh(["show", "HEAD:a.md"], vault), "writer A");
    assert.equal(sh(["show", "HEAD:b.md"], vault), "writer B");
    assert.equal(sh(["diff", "--cached", "--name-only"], vault), "owner.md");
    assert.equal(sh(["show", ":owner.md"], vault), "owner staged bytes");
    assert.equal(readFileSync(settings, "utf8"), bytes);
    if (memoryOnly) {
      assert.match(aResult.stderr, /сохранить настройки пока не удалось/u);
      assert.deepEqual(
        rows
          .filter((row) => row.role === "A" && row.args?.[0] === "add")
          .map((row) => row.timeout),
        [12_000, 24_000],
      );
    }
  });
