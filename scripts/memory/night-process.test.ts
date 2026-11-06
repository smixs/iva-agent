// Настоящий процесс ночи (scripts/memory/night.ts) против двойника модели: локальный
// OpenAI-совместимый сервер отвечает потоком текста и считает запросы. Vault
// под git во временной папке. Утверждаются файлы vault, история git, stderr и код выхода.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import "../lib/ts-esm-hooks.ts";

const cs = await import("../../agent/lib/card-store.ts");
const { parseFrontmatter } = await import("../../agent/lib/frontmatter.ts");

const ROOT = resolve(import.meta.dirname, "../..");
const NIGHT = join(ROOT, "scripts/memory/night.ts");
const HOOKS = join(ROOT, "scripts/lib/ts-esm-hooks.ts");
const DATE = "2026-09-26";
// Часы ночи закреплены: неделя DATE ещё не закончилась, поэтому ночь не собирает сводку
// недели, и число вызовов модели не зависит от дня запуска тестов.
const NOW = "2026-09-27T12:00:00Z";
const TODAY = NOW.slice(0, 10);
const CLOCK = join(ROOT, "scripts/fixtures/shifted-clock.ts");

class ModelDouble {
  readonly prompts: string[] = [];
  replies: unknown[] = [];
  private readonly held = new Map<
    number,
    { entered: () => void; gate: Promise<void> }
  >();
  readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );

  hold(call: number) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((accept) => (entered = accept));
    const gate = new Promise<void>((accept) => (release = accept));
    this.held.set(call, { entered, gate });
    return { reached, release };
  }

  async start(t: TestContext): Promise<string> {
    await new Promise<void>((accept) =>
      this.server.listen(0, "127.0.0.1", accept),
    );
    t.after(async () => {
      this.server.closeAllConnections();
      await new Promise((accept) => this.server.close(accept));
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const params = JSON.parse(body) as {
      messages: Array<{ content: unknown }>;
      stream: boolean;
    };
    assert.equal(params.stream, true);
    const messages = params.messages;
    this.prompts.push(JSON.stringify(messages.at(-1)?.content));
    const held = this.held.get(this.prompts.length);
    if (held) {
      held.entered();
      await held.gate;
    }
    // Сценарий ответа: { status } — ошибка HTTP, { text } — текст без JSON,
    // { usage, value } — свой расход (null — без usage), иначе — сам JSON ответа.
    const reply = this.replies.shift() as Record<string, unknown> | undefined;
    const send = (status: number, value: unknown) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (reply === undefined)
      return send(500, { error: { message: "unexpected model call" } });
    if (typeof reply.status === "number")
      return send(reply.status, {
        error: { message: `double ${reply.status}` },
      });
    const own = "usage" in reply;
    const promptContent = messages.at(-1)?.content;
    const prompt =
      typeof promptContent === "string"
        ? promptContent
        : JSON.stringify(promptContent ?? "");
    const cyrillic = prompt.match(/[\u0400-\u04ff]/gu)?.length ?? 0;
    const usage =
      reply.usage === "russian"
        ? Math.ceil(cyrillic / 2 + (prompt.length - cyrillic) / 4)
        : own
          ? (reply.usage as number | null)
          : 100;
    const value = own ? reply.value : reply;
    const text = typeof reply.text === "string" ? reply.text : null;
    // Модель отвечает текстом: JSON в markdown-ограде, как делают настоящие модели.
    const content =
      text ?? `Ответ:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "double",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    chunk({ role: "assistant", content }, null);
    chunk(
      {},
      "stop",
      usage === null
        ? undefined
        : {
            prompt_tokens: usage,
            completion_tokens: 10,
            total_tokens: usage + 10,
          },
    );
    response.end("data: [DONE]\n\n");
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Fixture {
  readonly vault: string;
  readonly data: string;
  readonly model: ModelDouble;
  baseUrl: string;
}

async function fixture(t: TestContext, core = true): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "iva-night-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(data, "settings.json"), "{}\n");
  if (core)
    writeFileSync(
      join(vault, "CORE.md"),
      "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n",
    );
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({ node_types: { project: { status: ["active", "done"] } } }),
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "night@example.invalid");
  git(vault, "config", "user.name", "Night");
  commit(vault, "initial");
  const model = new ModelDouble();
  return { vault, data, model, baseUrl: await model.start(t) };
}

function commit(vault: string, message = "fixture"): void {
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", message, "--allow-empty");
}

function spawnNight(
  fx: Fixture,
  date: string | null = DATE,
  env: Record<string, string> = {},
) {
  const args = [
    "--import",
    HOOKS,
    "--import",
    CLOCK,
    ...(env.IVA_TEST_NIGHT_TRACE || env.IVA_TEST_NIGHT_CRASH
      ? [
          "--import",
          `data:text/javascript,${encodeURIComponent(`
      import fs from "node:fs";
      import cp from "node:child_process";
      import { relative } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const append = fs.appendFileSync;
      const rename = fs.renameSync;
      const exec = cp.execFile;
      const counts = new Map();
      const dataRoot = fs.realpathSync(process.env.ASSISTANT_DATA_DIR);
      const vaultRoot = fs.realpathSync(process.env.ASSISTANT_VAULT_DIR);
      const count = (key) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return key + "#" + n;
      };
      const point = (key) => {
        if (process.env.IVA_TEST_NIGHT_TRACE)
          append(process.env.IVA_TEST_NIGHT_TRACE, key + "\\n");
        if (key === process.env.IVA_TEST_NIGHT_CRASH) {
          fs.writeSync(2, "NIGHT_CRASH " + key + "\\n");
          process.kill(process.pid, "SIGKILL");
        }
      };
      const pathKey = (file) => {
        const path = fs.existsSync(file) ? fs.realpathSync(file) : String(file);
        if (path.startsWith(dataRoot + "/memory/night/"))
          return "cache:" + relative(dataRoot, path);
        if (path.startsWith(vaultRoot + "/") && path.endsWith(".md"))
          return "vault:" + relative(vaultRoot, path);
        return null;
      };
      fs.renameSync = (from, to) => {
        const path = pathKey(to);
        const key = path ? count("rename:" + path) : null;
        if (key) point(key + ":before");
        const result = rename(from, to);
        if (key) point(key + ":after");
        return result;
      };
      fs.appendFileSync = (file, ...args) => {
        const path = pathKey(file);
        const key = path ? count("append:" + path) : null;
        if (key) point(key + ":before");
        const result = append(file, ...args);
        if (key) point(key + ":after");
        return result;
      };
      cp.execFile = (file, args, options, callback) => {
        if (file !== "git" || !args.includes("commit"))
          return exec(file, args, options, callback);
        const key = count("commit:" + args[args.indexOf("-m") + 1]);
        point(key + ":before");
        return exec(file, args, options, (...result) => {
          point(key + ":after");
          callback(...result);
        });
      };
      syncBuiltinESMExports();
    `)}`,
        ]
      : []),
    ...(env.IVA_TEST_SUMMARY_CRASH
      ? [
          "--import",
          `data:text/javascript,${encodeURIComponent(`
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        const summary = String(to).endsWith(${JSON.stringify(`/summaries/daily/${DATE}.md`)});
        const crash = () => { process.stderr.write("SUMMARY_CRASH\\n"); process.exit(86); };
        if (summary && process.env.IVA_TEST_SUMMARY_CRASH === "before") crash();
        const result = rename(from, to);
        if (summary && process.env.IVA_TEST_SUMMARY_CRASH === "after") crash();
        return result;
      };
      syncBuiltinESMExports();
    `)}`,
        ]
      : []),
    ...(env.IVA_TEST_OWNER_TRIGGER
      ? ["--import", join(ROOT, "scripts/fixtures/night-owner-edit.ts")]
      : []),
    ...(env.IVA_TEST_PAUSES
      ? [
          "--import",
          `data:text/javascript,${encodeURIComponent(`
      import timers from "node:timers/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { appendFileSync } from "node:fs";
      const original = timers.setTimeout;
      timers.setTimeout = (ms, ...args) => {
        appendFileSync(process.env.IVA_TEST_PAUSES, String(ms) + "\\n");
        return original(ms / 1000, ...args);
      };
      syncBuiltinESMExports();
    `)}`,
        ]
      : []),
    env.IVA_TEST_NIGHT_ENTRY ?? NIGHT,
    ...(date ? [date] : []),
  ];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ASSISTANT_VAULT_DIR: fx.vault,
      ASSISTANT_DATA_DIR: fx.data,
      ASSISTANT_TIMEZONE: "UTC",
      MODEL_PROVIDER: "custom",
      CUSTOM_BASE_URL: fx.baseUrl,
      CUSTOM_API_KEY: "test",
      CUSTOM_MODEL: "double",
      IVA_JOB_STOP_AT: String(Date.parse(env.IVA_TEST_NOW ?? NOW) + 60_000),
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_DIGEST_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: "",
      IVA_MEMORY_LOCK_HELD: "1",
      IVA_TEST_NOW: NOW,
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child
    .stderr!.setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((accept) =>
    child.once("close", (code, signal) => accept({ code, signal, stderr })),
  );
  return { child, result };
}

const night = (
  fx: Fixture,
  date?: string | null,
  env?: Record<string, string>,
) => spawnNight(fx, date, env).result;

function A(parts: Record<string, unknown> = {}) {
  return {
    gist: "Запущен проект Аврора",
    topics: ["проекты"],
    points: [{ text: "Старт Авроры", src: "e1" }],
    new_cards: [],
    facts: [],
    aliases: [],
    links: [],
    core: [],
    ...parts,
  };
}
const newAurora = {
  name: "Аврора",
  type: "project",
  description: "Новый проект",
};
const B = (...cards: Array<Record<string, unknown>>) => ({
  cards: cards.map((card) => ({
    truth: null,
    description: null,
    status: null,
    ...card,
  })),
});

function day(fx: Fixture, text: string, date = DATE): string {
  const file = join(fx.vault, "daily", `${date}.md`);
  writeFileSync(file, text);
  commit(fx.vault, `day ${date}`);
  return file;
}

function card(fx: Fixture, path: string, lines: string[]): string {
  const file = join(fx.vault, `${path}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  commit(fx.vault, `card ${path}`);
  return file;
}

const read = (file: string) => readFileSync(file, "utf8");
const summary = (fx: Fixture, date = DATE) =>
  join(fx.vault, "summaries/daily", `${date}.md`);
const logRows = (text: string) =>
  text.split("\n").filter((line) => /^- \d{4}-\d{2}-\d{2}: /u.test(line));
const aurora = [
  "---",
  'type: "project"',
  'description: "Проект"',
  'status: "active"',
  "---",
  "# Аврора",
  "",
  "Первая строка правды",
  "Вторая строка правды",
  "Третья строка правды",
  "",
  "## Log",
  "",
  "## Related",
  "",
  "## History",
  "",
];

void test("обычный день: A и B, Card, выжимка, отметка, коммиты; повтор ночи ничего не зовёт и не меняет", async (t) => {
  const fx = await fixture(t);
  const raw =
    "## 10:00 [text]\nЗапустил проект Аврора\n\n## 10:05 [iva]\nОтличный старт\n";
  const file = day(fx, raw);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Проект запуска" }),
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /^iva-model-auth-success custom \d+$/mu);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(
    read(file),
    `${raw}\n<!-- processed: memory-night ${DATE} -->\n`,
  );
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.deepEqual(logRows(text), [
    `- ${DATE}: Проект запущен · [[daily/${DATE}]] 10:00`,
  ]);
  assert.match(text, /# Аврора\n\nПроект запуска\n\n## Log/u);
  assert.match(read(summary(fx)), /body_hash: "[0-9a-f]{64}"/u);
  const fields = parseFrontmatter(read(summary(fx))).fields!;
  assert.equal(Object.hasOwn(fields, "source"), false);
  assert.equal(Object.hasOwn(fields, "through"), false);
  assert.match(read(summary(fx)), /- \[\[cards\/projects\/аврора\]\]/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  const head = git(fx.vault, "rev-parse", "HEAD");
  const again = await night(fx, null);
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /iva-model-auth-success/u);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
});

for (const tracked of [false, true]) {
  void test(`ignore daily и summaries не останавливает ночь; raw ${tracked ? "tracked" : "untracked"} (#257)`, async (t) => {
    const fx = await fixture(t);
    const raw = "## 10:00 [text]\nЗапустил проект Аврора\n";
    const file = join(fx.vault, "daily", `${DATE}.md`);
    if (tracked) day(fx, raw);
    writeFileSync(join(fx.vault, ".gitignore"), "daily/\nsummaries/\n");
    commit(fx.vault, "ignore memory");
    if (!tracked) writeFileSync(file, raw);
    fx.model.replies = [A()];
    const first = await night(fx);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(fx.model.prompts.length, 1);
    assert.match(read(file), /processed: memory-night/u);
    assert.match(read(summary(fx)), /Аврора/u);
    assert.match(first.stderr, /вне git-бэкапа по ignore.*summaries\/daily/u);
    assert.equal(git(fx.vault, "ls-files", `summaries/daily/${DATE}.md`), "");
    const cache = JSON.parse(
      read(join(fx.data, "memory/night", `${DATE}.json`)),
    ) as { pass?: unknown; through: number; writtenSummaryHash: string };
    assert.equal(cache.pass, undefined);
    assert.equal(cache.through, 1);
    assert.match(cache.writtenSummaryHash, /^[a-f0-9]{64}$/u);
    if (tracked)
      assert.match(
        git(fx.vault, "show", `HEAD:daily/${DATE}.md`),
        /processed: memory-night/u,
      );
    else {
      assert.equal(git(fx.vault, "ls-files", `daily/${DATE}.md`), "");
      assert.match(
        first.stderr,
        /вне git-бэкапа по ignore.*daily\/2026-09-26/u,
      );
    }
    const head = git(fx.vault, "rev-parse", "HEAD");
    const again = await night(fx, null);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fx.model.prompts.length, 1);
    assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
  });
}

void test("B заменяет правду целиком: сменённая средняя строка уходит в History, порядок цел (ДЕФ-1, ДЕФ-18)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nВторую строку меняю\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Строка меняется",
          src: "e1",
          quote: "Вторую строку меняю",
        },
      ],
    }),
    B({
      card: "cards/projects/аврора",
      truth: "Первая строка правды\nНовая вторая\nТретья строка правды",
    }),
  ];
  assert.equal((await night(fx)).code, 0);
  const text = read(file);
  assert.match(
    text,
    /# Аврора\n\nПервая строка правды\nНовая вторая\nТретья строка правды\n\n## Log/u,
  );
  assert.match(
    text,
    new RegExp(
      `## History\\n\\n- ${DATE}: Вторая строка правды \\(сменено: \\[\\[daily/${DATE}\\]\\]\\)`,
      "u",
    ),
  );
  assert.match(text, new RegExp(`truth_date: "${DATE}"`, "u"));
});

void test("B повторяет ответ с H1/H2 или незакрытым fence и не ломает Card", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "# Подмена\n\n## Log\n\n```" }),
    B({ card: "cards/projects/аврора", truth: "Безопасная правда" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 3);
  const text = read(file);
  assert.match(text, /# Аврора\n\nБезопасная правда\n\n## Log/u);
  assert.equal((text.match(/^## Log$/gmu) ?? []).length, 1);
  assert.doesNotMatch(text, /Подмена/u);
});

void test("поздний хвост: A только по новым репликам, Log без повторов, дубля Card нет (M2, ДЕФ-2)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  assert.equal((await night(fx)).code, 0);
  appendFileSync(file, "\n## 11:00 [text]\nСрок Авроры пятница\n");
  commit(fx.vault);
  fx.model.replies = [
    A({
      gist: "Аврора и срок",
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Срок пятница",
          src: ["e2"],
          quote: "Срок Авроры пятница",
        },
        {
          card: "cards/projects/аврора",
          text: "Проект запущен",
          src: "e2",
          quote: "Срок Авроры",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const tail = await night(fx);
  assert.equal(tail.code, 0, tail.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.doesNotMatch(fx.model.prompts[2], /Запустил проект/u);
  assert.match(fx.model.prompts[2], /Запущен проект Аврора/u);
  assert.match(fx.model.prompts[2], /cards\/projects\/аврора/u);
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.equal(logRows(text).length, 2);
  assert.deepEqual(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.match(read(summary(fx)), /description: "Аврора и срок"/u);
  assert.equal(read(file).match(/processed: memory-night/gu)?.length, 2);
  const unchanged = git(fx.vault, "rev-parse", "HEAD");
  writeFileSync(file, read(file).replace("Запустил", "Начал"));
  commit(fx.vault);
  const edited = await night(fx, null);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(edited.stderr, /изменён после разбора/u);
  assert.notEqual(unchanged, "");
});

void test("выключатель: ничего не читается и не зовётся", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ memory: { night: "off" } }),
  );
  chmodSync(fx.vault, 0o000);
  const result = await night(fx);
  chmodSync(fx.vault, 0o755);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /выключено/u);
  assert.equal(fx.model.prompts.length, 0);
});

void test("ответ не по форме: один повтор с текстом ошибки, потом no-report; ответ без submit тоже повторяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [
    { text: "Не понял задачу" },
    { text: "Вот ответ словами" },
  ];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа/u);
  assert.equal(existsSync(summary(fx)), false);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /no-report/u);
  fx.model.replies = [{ text: "без инструмента" }, A(), B()];
  const retried = await night(fx);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(existsSync(summary(fx)), true);
});

void test("негодный факт отбрасывается со строкой в Job, остальной ответ применяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
        {
          card: "Несуществующая",
          text: "Лишнее",
          src: "e1",
          quote: "Запустил",
        },
        { card: "Аврора", text: "Из воздуха", src: "e9", quote: "Запустил" },
        { card: "Аврора", text: "Выдумка", src: "e1", quote: "этого не было" },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /отброшено.*Несуществующая/u);
  assert.match(result.stderr, /отброшено.*e9/u);
  assert.match(result.stderr, /отброшено.*этого не было/u);
  assert.deepEqual(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("сеть 429: один вызов, без попытки дня, день в очереди", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [{ status: 429 }];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  fx.model.replies = [A(), B()];
  assert.equal((await night(fx)).code, 0);
});

void test(
  "#256: два обрыва до заголовков B сохраняют два факта и кэш; следующая ночь продолжает без второго A",
  { timeout: 35_000 },
  async (t) => {
    const fx = await fixture(t);
    const raw = day(fx, "## 10:00 [text]\nАврора и Борис начали работу\n");
    const rawBefore = read(raw);
    const paths = ["cards/projects/аврора", "cards/projects/борис"];
    const files = paths.map((path, i) =>
      card(
        fx,
        path,
        aurora.map((line) => (i ? line.replaceAll("Аврора", "Борис") : line)),
      ),
    );
    const truths = files.map((file) =>
      cs.truthOf(parseFrontmatter(read(file)).body),
    );
    fx.model.replies = [
      A({
        facts: paths.map((path, i) => ({
          card: path,
          text: `${i ? "Борис" : "Аврора"} начал работу`,
          src: "e1",
          quote: i ? "Борис" : "Аврора",
        })),
      }),
    ];
    const cacheFile = join(fx.data, "memory/night", `${DATE}.json`);
    let firstCache: unknown;
    for (const call of [2, 3]) {
      const held = fx.model.hold(call);
      const run = spawnNight(fx, null, {
        IVA_JOB_STOP_AT: String(Date.parse(NOW) + 6_000),
      });
      t.after(() => run.child.kill("SIGKILL"));
      await Promise.race([
        held.reached,
        run.result.then((result) => {
          throw new Error(`night exited before B: ${result.stderr}`);
        }),
      ]);
      // The real HTTP server has received B, but sent no response headers. The
      // actual process deadline interrupts the SDK request, not a mocked throw.
      const failed = await run.result;
      held.release();
      assert.equal(failed.code, 1, failed.stderr);
      assert.match(failed.stderr, /memory-night deadline/u);
      assert.equal(fx.model.prompts.length, call, "no transport retries");
      assert.equal(
        read(raw),
        rawBefore,
        "unfinished raw day is not marked ready",
      );
      assert.equal(existsSync(summary(fx)), false);
      assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
      const cache = JSON.parse(read(cacheFile)) as {
        pass: { truth: string[] };
      };
      assert.deepEqual(cache.pass.truth, paths);
      if (call === 2) firstCache = cache;
      else
        assert.deepEqual(
          cache,
          firstCache,
          "the pending step survives the second failure",
        );
      for (const [i, file] of files.entries()) {
        assert.equal(
          logRows(read(file)).length,
          1,
          "accepted fact remains, once",
        );
        assert.equal(cs.truthOf(parseFrontmatter(read(file)).body), truths[i]);
      }
      // Let the disconnected server handler finish before assigning the next reply.
      await new Promise((accept) => setImmediate(accept));
    }
    fx.model.replies = [B(...paths.map((path) => ({ card: path })))];
    const resumed = await night(fx, null);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(
      fx.model.prompts.length,
      4,
      "one A, two interrupted B, one resumed B",
    );
    assert.equal(existsSync(summary(fx)), true);
    for (const file of files) assert.equal(logRows(read(file)).length, 1);
    assert.equal(git(fx.vault, "status", "--porcelain"), "");
  },
);

void test("kill -9 на B: повтор без второго A и без дубля Card, даже если отметка применения не успела", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  run.child.kill("SIGKILL");
  await run.result;
  held.release();
  await new Promise((accept) => setTimeout(accept, 100));
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  const state = JSON.parse(read(cache)) as { pass: Record<string, unknown> };
  delete state.pass.applied;
  delete state.pass.truth;
  delete state.pass.summaryHash; // Кэш старой ночи продолжает открытый проход.
  writeFileSync(cache, JSON.stringify(state));
  fx.model.replies = [B({ card: "cards/projects/аврора" })];
  const again = await night(fx);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.model.prompts.length, 3);
  assert.equal(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.equal(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("правка человека во время B побеждает, день закрыт, B по Card следующей ночью (ДЕФ-3)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Ночная правда" }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  writeFileSync(
    file,
    read(file).replace("Первая строка правды", "Правда владельца"),
  );
  held.release();
  const first = await run.result;
  assert.equal(first.code, 0, first.stderr);
  assert.match(read(file), /Правда владельца/u);
  assert.doesNotMatch(read(file), /Ночная правда/u);
  assert.match(read(file), new RegExp(`truth_pending: "${DATE}"`, "u"));
  assert.match(first.stderr, /изменён человеком/u);
  assert.equal(existsSync(summary(fx)), true);
  day(fx, "## 09:00 [text]\nПросто день\n", "2026-09-27");
  fx.model.replies = [
    A({ facts: [] }),
    B({
      card: "cards/projects/аврора",
      truth: "Правда владельца\nКурс сменён",
    }),
  ];
  const second = await night(fx, "2026-09-27");
  assert.equal(second.code, 0, second.stderr);
  assert.match(fx.model.prompts[3], /Курс сменён/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("занятое имя новой Card: отдельная Card «Имя (D)» и Alert, исходная байт в байт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора\n");
  const file = card(fx, "cards/notes/аврора", [
    "---",
    'type: "note"',
    'aliases: ["Аврора"]',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
  ]);
  const before = read(file);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        { card: "Аврора", text: "Новый проект", src: "e1", quote: "Аврора" },
      ],
    }),
    B({ card: `cards/projects/аврора-${DATE}` }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(file), before);
  assert.match(
    read(join(fx.vault, `cards/projects/аврора-${DATE}.md`)),
    new RegExp(`# Аврора \\(${DATE}\\)`, "u"),
  );
  assert.match(result.stderr, /Похоже на дубль: Аврора/u);
});

void test("открытый фенс и чужой файл на месте новой Card: факты в pending, файлы целы; починка дописывает без модели (ДЕФ-4)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора и Борис\n");
  const fenced = card(fx, "cards/projects/аврора", [
    "---",
    'type: "project"',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
    "```",
    "открыто",
    "",
  ]);
  const foreign = card(fx, "cards/contacts/борис", [
    "---",
    'description: "битая кавычка',
    "---",
    "# Борис",
    "",
    "Текст владельца",
    "",
  ]);
  const [fencedBefore, foreignBefore] = [read(fenced), read(foreign)];
  fx.model.replies = [
    A({
      new_cards: [{ name: "Борис", type: "contact", description: "Коллега" }],
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Аврора идёт",
          src: "e1",
          quote: "Аврора",
        },
        { card: "Борис", text: "Борис в команде", src: "e1", quote: "Борис" },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(fenced), fencedBefore);
  assert.equal(read(foreign), foreignBefore);
  assert.match(result.stderr, /Поправь Card cards\/projects\/аврора/u);
  assert.match(result.stderr, /Поправь Card cards\/contacts\/борис/u);
  writeFileSync(fenced, fencedBefore.replace("открыто\n", "открыто\n```\n"));
  writeFileSync(
    foreign,
    foreignBefore
      .replace('"битая кавычка', '"починено"')
      .replace("Текст владельца\n", "Текст владельца\n\n## Log\n"),
  );
  commit(fx.vault);
  const fixed = await night(fx, null);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(logRows(read(fenced)).length, 1);
  assert.deepEqual(logRows(read(foreign)), [
    `- ${DATE}: Борис в команде · [[daily/${DATE}]] 10:00`,
  ]);
});

void test("предел ночи: большой расход на A — B не начат, попытки сохранены, код 1; без usage следующий вызов закрыт", async (t) => {
  const fx = await fixture(t);
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ night: { raisesPerNight: 0 } }),
  );
  day(fx, "## 10:00 [text]\nАврора\n");
  card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    {
      usage: 299_990,
      value: A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Факт",
            src: "e1",
            quote: "Аврора",
          },
        ],
      }),
    },
  ];
  const cut = await night(fx);
  assert.equal(cut.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.match(cut.stderr, /обрез пределом ночи/u);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  assert.equal(existsSync(summary(fx)), false);
  fx.model.replies = [
    { usage: null, value: B({ card: "cards/projects/аврора" }) },
  ];
  const unknown = await night(fx);
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stderr, /usage unknown/u);
});

void test("отказ коммита: день не готов; следующая ночь коммитит без вызова модели", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  fx.model.replies = [A(), B()];
  const failed = await night(fx);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /не закоммичен/u);
  rmSync(hook);
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  assert.equal(existsSync(summary(fx)), true);
});

void test("summary commit failure: the next night finishes its published summary without another model call", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПросто день\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  held.release();
  const failed = await run.result;
  assert.equal(failed.code, 1, failed.stderr);
  const published = read(summary(fx));
  rmSync(hook);
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(read(summary(fx)), published);
  assert.doesNotMatch(resumed.stderr, /день ждёт владельца/u);
  const cache = JSON.parse(
    read(join(fx.data, "memory/night", `${DATE}.json`)),
  ) as { pass?: unknown };
  assert.equal(cache.pass, undefined);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

for (const change of ["image", "model"] as const)
  void test(`summary recovery: ${change} changes after publication before commit`, async (t) => {
    const fx = await fixture(t);
    const raw = day(fx, "## 10:00 [text]\nПросто день\n");
    fx.model.replies = [A()];
    const held = fx.model.hold(1);
    const run = spawnNight(fx);
    await held.reached;
    const hook = join(fx.vault, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    held.release();
    assert.equal((await run.result).code, 1);
    const published = read(summary(fx));
    rmSync(hook);
    if (change === "image")
      appendFileSync(raw, "\n![[attachments/2026-09-26/late.jpg]]\n");
    const env: Record<string, string> =
      change === "model" ? { CUSTOM_MODEL: "changed-model" } : {};
    for (let next = 0; next < 2; next++) {
      const result = await night(fx, null, env);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /день ждёт владельца/u);
    }
    const cache = JSON.parse(
      read(join(fx.data, "memory/night", `${DATE}.json`)),
    ) as { pass?: unknown; through: number };
    assert.equal(cache.pass, undefined);
    assert.equal(cache.through, 1);
    assert.notEqual(read(summary(fx)), published);
    if (change === "image")
      assert.match(read(summary(fx)), /attachments\/2026-09-26\/late\.jpg/u);
    else
      assert.equal(
        parseFrontmatter(read(summary(fx))).body,
        parseFrontmatter(published).body,
      );
    assert.equal(fx.model.prompts.length, 1);
  });

for (const cacheFormat of ["current", "0.5.5", "0.5.5-empty"] as const)
  for (const edit of ["absent", "description"] as const)
    void test(`closed summary: ${cacheFormat} ${edit} owner edit survives a late entry and three nights`, async (t) => {
      const fx = await fixture(t);
      const raw = day(
        fx,
        cacheFormat === "0.5.5-empty" ? "" : "## 10:00 [text]\nПросто день\n",
      );
      fx.model.replies = [A()];
      const first = await night(fx);
      assert.equal(first.code, 0, first.stderr);
      if (cacheFormat !== "current") {
        const file = join(fx.data, "memory/night", `${DATE}.json`);
        const cache = JSON.parse(read(file)) as Record<string, unknown>;
        assert.equal(cache.v, 1);
        assert.equal(cache.through, cacheFormat === "0.5.5-empty" ? 0 : 1);
        assert.equal(cache.pass, undefined);
        delete cache.writtenSummaryHash;
        writeFileSync(file, JSON.stringify(cache));
      }
      const published = read(summary(fx));
      const owner =
        edit === "absent"
          ? published.replace(/^body_hash:.*\n/mu, "") + "\nПравка владельца\n"
          : published.replace(
              /^description:.*$/mu,
              'description: "Правка владельца"',
            );
      assert.notEqual(owner, published);
      writeFileSync(summary(fx), owner);
      appendFileSync(raw, "\n## 11:00 [text]\nПоздняя реплика\n");
      fx.model.replies = [A()];
      for (let next = 0; next < 3; next++) {
        const result = await night(fx, null);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(read(summary(fx)), owner);
        assert.match(result.stderr, /день ждёт владельца/u);
        assert.match(
          result.stderr,
          new RegExp(`iva jobs skip memory-night ${DATE}`, "u"),
        );
      }
    });

void test("summary conflict: iva jobs skip releases an open pass", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПросто день\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  mkdirSync(join(summary(fx), ".."), { recursive: true });
  const owner = "---\ntype: daily-summary\n---\n# Правка владельца\n";
  writeFileSync(summary(fx), owner);
  held.release();
  assert.match((await run.result).stderr, /день ждёт владельца/u);
  const { createJobsCommand } = await import("../cli/jobs.ts");
  const skip = createJobsCommand(
    {
      ROOT: ROOT,
      ENV_PATH: "unused",
      dataDirAbs: () => fx.data,
      ok: () => {},
      bad: (message: string) => assert.fail(message),
    } as never,
    {
      lock: () => null,
      readEnv: () =>
        Promise.resolve({
          ASSISTANT_VAULT_DIR: fx.vault,
          ASSISTANT_TIMEZONE: "UTC",
        }),
      now: () => new Date(NOW),
    },
  );
  await skip(["skip", "memory-night", DATE]);
  for (let next = 0; next < 2; next++) {
    const result = await night(fx, null);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /день ждёт владельца/u);
    assert.equal(read(summary(fx)), owner);
  }
  assert.equal(fx.model.prompts.length, 1);
});

for (const origin of ["iva", "forwarded"] as const)
  void test(`CORE owner-only: ${origin} candidate is discarded`, async (t) => {
    const fx = await fixture(t);
    day(
      fx,
      `## 10:00 [text]\nМои слова\n\n## 10:01 [${origin === "iva" ? "iva" : "text"}]\n${origin === "forwarded" ? "[forwarded from @ann]\n" : ""}Люблю чай\n`,
    );
    const candidate = { text: "Любит чай", src: ["e2"] };
    fx.model.replies = [
      A({ core: [candidate] }),
      { sections: [{ section: "Предпочтения", text: "- Любит чай" }] },
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(read(join(fx.vault, "CORE.md")), /Любит чай/u);
    assert.ok(
      result.stderr.includes(`отброшено: ${JSON.stringify(candidate)}`),
    );
    assert.equal(fx.model.prompts.length, 1);
  });

void test("CORE owner-only preserves every owner-backed candidate (seed 20261018)", async (t) => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("owner", "iva", "forwarded"), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.array(fc.array(fc.nat({ max: 12 }), { maxLength: 8 }), {
        maxLength: 12,
      }),
      async (generatedOrigins, refs) => {
        const origins = [...generatedOrigins, "owner"];
        const fx = await fixture(t);
        day(
          fx,
          origins
            .map(
              (origin) =>
                `## 10:00 [${origin === "iva" ? "iva" : "text"}]\n${origin === "forwarded" ? "[forwarded]\n" : ""}Слова\n`,
            )
            .join("\n"),
        );
        // Keep the accepted A answer in the real cache for source inspection.
        const hook = join(fx.vault, ".git/hooks/pre-commit");
        writeFileSync(hook, "#!/bin/sh\nexit 1\n");
        chmodSync(hook, 0o755);
        const core = [
          ...refs,
          [origins.length - 1],
          [0, origins.length - 1, 12],
        ].map((ids, index) => ({
          text: `candidate ${index}`,
          src: ids.map((id) => `e${id + 1}`),
        }));
        fx.model.replies = [A({ core })];
        const result = await night(fx);
        assert.equal(result.code, 1, result.stderr);
        const cache = JSON.parse(
          read(join(fx.data, "memory/night", `${DATE}.json`)),
        ) as {
          pass: { a: Array<{ core: typeof core }> };
        };
        const kept = cache.pass.a[0].core;
        for (const candidate of core) {
          const accepted = kept.find((item) => item.text === candidate.text);
          const ownerRefs = candidate.src.filter(
            (id) => origins[Number(id.slice(1)) - 1] === "owner",
          );
          assert.equal(Boolean(accepted), ownerRefs.length > 0);
          if (accepted) assert.deepEqual(accepted.src, ownerRefs);
        }
      },
    ),
    { seed: 20261018, numRuns: 30 },
  );
});

void test("первая ночь без CORE: C зовётся, CORE создан, строка сразу под заголовком раздела (ДЕФ-6, ДЕФ-8)", async (t) => {
  const fx = await fixture(t, false);
  day(fx, "## 10:00 [text]\nКофе после четырёх не пью\n");
  fx.model.replies = [
    A({ core: [{ text: "Не пьёт кофе после 16:00", src: "e1" }] }),
    {
      sections: [
        { section: "Предпочтения", text: "- Не пьёт кофе после 16:00" },
      ],
    },
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    read(join(fx.vault, "CORE.md")),
    /## Предпочтения\n\n- Не пьёт кофе после 16:00\n\n## Активные цели/u,
  );
  assert.match(
    read(join(fx.vault, "CORE.md")),
    new RegExp(`Последний день: summaries/daily/${DATE}`, "u"),
  );
});

void test("CORE над лимитом: повтор с «освободи», отказ — кандидат ждёт следующей ночи, не exit 1 (ДЕФ-7)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЛюблю чай\n");
  const long = `- ${"x".repeat(4000)}`;
  fx.model.replies = [
    A({ core: [{ text: "Любит чай", src: "e1" }] }),
    { sections: [{ section: "Предпочтения", text: long }] },
    { sections: [{ section: "Предпочтения", text: long }] },
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.match(fx.model.prompts[2], /освободи \d+ знаков/u);
  assert.match(first.stderr, /кандидаты ждут/u);
  assert.doesNotMatch(read(join(fx.vault, "CORE.md")), /xxxx/u);
  fx.model.replies = [
    { sections: [{ section: "Предпочтения", text: "- Любит чай" }] },
  ];
  assert.equal((await night(fx, null)).code, 0);
  assert.match(fx.model.prompts[3], /Любит чай/u);
  assert.match(read(join(fx.vault, "CORE.md")), /- Любит чай/u);
});

for (const accepted of [false, true])
  void test(`night clean: C consumes candidates, accepted=${accepted}`, async (t) => {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nЛюблю чай\n");
    fx.model.replies = [
      A({ core: [{ text: "Любит чай", src: "e1" }] }),
      {
        sections: accepted
          ? [{ section: "Предпочтения", text: "- Любит чай" }]
          : [],
      },
    ];
    const first = await night(fx);
    assert.equal(first.code, 0, first.stderr);
    const cache = JSON.parse(
      read(join(fx.data, "memory/night", `${DATE}.json`)),
    ) as { core: unknown[]; coreDone?: boolean };
    assert.deepEqual(
      cache.core,
      [],
      "C consumes accepted and declined candidates",
    );
    assert.equal(Object.hasOwn(cache, "coreDone"), false);
    const again = await night(fx, null);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(
      fx.model.prompts.length,
      2,
      "consumed C is never requested again",
    );
  });

void test("night clean: retention uses completedAt after mtime changes", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПросто день\n");
  fx.model.replies = [A()];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  const file = join(fx.data, "memory/night", `${DATE}.json`);
  const cache = JSON.parse(read(file)) as Record<string, unknown>;
  assert.equal(
    new Date(String(cache.completedAt)).toISOString().slice(0, 10),
    TODAY,
  );
  const old = new Date(Date.parse(NOW) - 15 * 86_400_000);
  utimesSync(file, old, old);
  const again = await night(fx, null);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(existsSync(file), "copied mtime cannot expire a fresh completion");
  cache.completedAt = old.toISOString();
  writeFileSync(file, JSON.stringify(cache));
  const expired = await night(fx, null);
  assert.equal(expired.code, 0, expired.stderr);
  assert.equal(existsSync(file), false);
  assert.equal(fx.model.prompts.length, 1);
  assert.ok(existsSync(summary(fx)), "expiry preserves the published result");
});

// The acceptance command supplies the frozen 0.5.6 executable from the evidence
// tree. Ordinary installs and source archives need no git history to run tests.
if (process.env.IVA_NIGHT_ROLLBACK_ENTRY) {
  const oldNight = {
    IVA_TEST_NIGHT_ENTRY: process.env.IVA_NIGHT_ROLLBACK_ENTRY,
  };
  void test("night clean: 0.5.6 reads a completed new cache and preserves its results", async (t) => {
    const fx = await fixture(t);
    const daily = day(fx, "## 10:00 [text]\nЛюблю чай\n");
    fx.model.replies = [
      A({ core: [{ text: "Любит чай", src: "e1" }] }),
      { sections: [{ section: "Предпочтения", text: "- Любит чай" }] },
    ];
    const first = await night(fx);
    assert.equal(first.code, 0, first.stderr);
    const files = [daily, summary(fx), join(fx.vault, "CORE.md")];
    const before = files.map(read);
    const file = join(fx.data, "memory/night", `${DATE}.json`);
    const old = new Date(Date.parse(NOW) - 15 * 86_400_000);
    utimesSync(file, old, old);
    const rolledBack = await night(fx, null, oldNight);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.deepEqual(files.map(read), before);
    assert.equal(
      fx.model.prompts.length,
      2,
      "0.5.6 does not repeat completed A or C",
    );
    assert.ok(
      existsSync(file),
      "0.5.6 also ignores mtime for a fresh completion",
    );
    const cache = JSON.parse(read(file)) as Record<string, unknown>;
    cache.completedAt = old.toISOString();
    writeFileSync(file, JSON.stringify(cache));
    const expired = await night(fx, null, oldNight);
    assert.equal(expired.code, 0, expired.stderr);
    assert.equal(
      existsSync(file),
      false,
      "0.5.6 retains its normal cleanup semantics",
    );
    assert.deepEqual(files.map(read), before);
  });

  void test("night clean: 0.5.6 resumes a saved A portion produced by the new night", async (t) => {
    const fx = await fixture(t);
    day(
      fx,
      `## 10:00 [text]\n${"a".repeat(30_000)}\n\n## 11:00 [text]\n${"b".repeat(30_000)}\n`,
    );
    fx.model.replies = [A({ gist: "saved first portion" }), { status: 401 }];
    const stopped = await night(fx);
    assert.equal(stopped.code, 1, stopped.stderr);
    const file = join(fx.data, "memory/night", `${DATE}.json`);
    const cache = JSON.parse(read(file)) as {
      pass: { progress: { answers: unknown[] } };
    };
    assert.equal(cache.pass.progress.answers.length, 1);
    fx.model.replies = [A({ gist: "0.5.6 finished the day" })];
    const rolledBack = await night(fx, DATE, oldNight);
    assert.equal(rolledBack.code, 0, rolledBack.stderr);
    assert.equal(
      fx.model.prompts.length,
      3,
      "the saved first A is not requested again",
    );
    assert.match(fx.model.prompts[2], /saved first portion/u);
    assert.match(read(summary(fx)), /0\.5\.6 finished the day/u);
    assert.equal(
      (JSON.parse(read(file)) as { pass?: unknown }).pass,
      undefined,
    );
  });
}

for (const waiting of ["pass", "pending", "core"] as const)
  void test(`night clean: retention never expires waiting ${waiting}`, async (t) => {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nПросто день\n");
    fx.model.replies = [A()];
    assert.equal((await night(fx)).code, 0);
    const cache = JSON.parse(
      read(join(fx.data, "memory/night", `${DATE}.json`)),
    ) as Record<string, unknown>;
    cache.date = "2026-09-01";
    cache.completedAt = "2026-09-01T12:00:00.000Z";
    if (waiting === "pass")
      cache.pass = { from: 0, upto: 1, created: {}, b: {} };
    if (waiting === "pending") cache.pending = { "cards/missing": ["- факт"] };
    if (waiting === "core") {
      cache.core = [
        { id: "waiting", text: "Любит чай", source: "[[daily/2026-09-01]]" },
      ];
      const overlong = {
        sections: [{ section: "Предпочтения", text: "x".repeat(4000) }],
      };
      fx.model.replies = [overlong, overlong];
    }
    const file = join(fx.data, "memory/night/2026-09-01.json");
    writeFileSync(file, JSON.stringify(cache));
    const old = new Date(Date.parse(NOW) - 15 * 86_400_000);
    utimesSync(file, old, old);
    const again = await night(fx, null);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(read(file)), cache);
  });

for (const coreDone of [false, true])
  void test(`night clean: reads 0.5.6 candidates with coreDone=${coreDone}`, async (t) => {
    const fx = await fixture(t);
    const daily = day(fx, "## 10:00 [text]\nЛюблю чай\n");
    fx.model.replies = [A()];
    assert.equal((await night(fx)).code, 0);
    const file = join(fx.data, "memory/night", `${DATE}.json`);
    const cache = JSON.parse(read(file)) as Record<string, unknown>;
    cache.core = [
      {
        id: `${DATE}:0:1`,
        text: "Любит чай",
        source: `[[daily/${DATE}]] 10:00`,
      },
    ];
    cache.coreDone = coreDone;
    writeFileSync(file, JSON.stringify(cache));
    fx.model.replies = coreDone ? [] : [{ sections: [] }];
    const again = await night(fx, null);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fx.model.prompts.length, coreDone ? 1 : 2);
    appendFileSync(daily, "\n## 11:00 [text]\nПоздняя реплика\n");
    fx.model.replies = [A()];
    const late = await night(fx);
    assert.equal(late.code, 0, late.stderr);
    const rewritten = JSON.parse(read(file)) as Record<string, unknown>;
    assert.equal(Object.hasOwn(rewritten, "coreDone"), false);
    assert.deepEqual(rewritten.core, []);
  });

void test("догон: из четырёх дней ночь берёт три старых по порядку", async (t) => {
  const fx = await fixture(t);
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const date of dates) day(fx, `## 10:00 [text]\nФакт ${date}\n`, date);
  fx.model.replies = dates.slice(0, 3).flatMap((date) => [A({ gist: date })]);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  dates
    .slice(0, 3)
    .forEach((date, index) =>
      assert.match(fx.model.prompts[index], new RegExp(date, "u")),
    );
  assert.equal(existsSync(summary(fx, dates[3])), false);
});

void test("день по частям: A на каждую часть, вторая видит выжимку первой, одна выжимка дня", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [
    A({ gist: "первая часть" }),
    A({ gist: "весь день", points: [{ text: "вторая", src: "e2" }] }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /первая часть/u);
  assert.match(
    read(summary(fx)),
    /description: "весь день"[\s\S]*- вторая · \[\[daily\/2026-09-26\]\] 11:00/u,
  );
});

void test("граница перехода и ручная правка: старая выжимка без body_hash и правленая выжимка не трогаются (ДЕФ-5, ДЕФ-12)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nСтарый день\n", "2020-02-10");
  day(
    fx,
    "## 10:00 [text]\nЕщё день\n\n## 11:00 [text]\nХвост после правки\n",
    "2020-02-11",
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  const legacy =
    '---\ntype: "daily-summary"\ndescription: "старая ночь"\n---\n# 2020-02-10\n';
  writeFileSync(summary(fx, "2020-02-10"), legacy);
  writeFileSync(
    summary(fx, "2020-02-11"),
    `---\nbody_hash: "${"0".repeat(64)}"\n---\n# Правка владельца\n`,
  );
  commit(fx.vault);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
  assert.equal(read(summary(fx, "2020-02-10")), legacy);
  assert.match(read(summary(fx, "2020-02-11")), /Правка владельца/u);
  assert.match(result.stderr, /выжимка 2020-02-11 изменена вручную/u);
});

void test("iva jobs skip закрывает день отметкой в сыром дне", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    "## 10:00 [text]\nФакт\n\n<!-- processed: skipped by owner 2026-09-27T00:00:00Z -->\n",
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
});

void test("кэш не пишется: вызова нет, код 1 (ДЕФ-16)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  mkdirSync(join(fx.data, "memory"), { recursive: true });
  writeFileSync(join(fx.data, "memory/night"), "not a directory");
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
});

void test("реплика, пришедшая во время ручной ночи, разбирается следующей ночью (ДЕФ-13)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nПервая\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  appendFileSync(file, "\n## 10:30 [text]\nПришла во время ночи\n");
  held.release();
  assert.equal((await run.result).code, 0);
  fx.model.replies = [A({ points: [{ text: "поздняя", src: "e2" }] })];
  const next = await night(fx, null);
  assert.equal(next.code, 0, next.stderr);
  assert.match(fx.model.prompts[1], /Пришла во время ночи/u);
});

void test("CLI отвергает несуществующую дату (ДЕФ-19)", async (t) => {
  const fx = await fixture(t);
  const result = await night(fx, "2026-02-30");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage/u);
});

void test("нет сырого дня за вчера при ходах в usage.jsonl — Alert о сбое транскрипта (ДЕФ-17)", async (t) => {
  const fx = await fixture(t);
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    join(fx.data, "usage.jsonl"),
    `${JSON.stringify({ ts: `${yesterday}T10:00:00.000Z`, source: "chat" })}\n`,
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /memory-night alert night-transcript/u);
});

void test("неделя из готовых дней собирается одним вызовом; неготовый день держит период; сбой P — выжимка без модели", async (t) => {
  const fx = await fixture(t);
  const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days.slice(0, 6))
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
    );
  day(fx, "## 10:00 [text]\nПоследний день недели\n", days[6]);
  fx.model.replies = [
    A({ gist: "последний" }),
    { text: "неделя" },
    { text: "неделя" },
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(fx.model.prompts[0], /Последний день недели/u);
  const weekly = execFileSync("ls", [join(fx.vault, "weekly")], {
    encoding: "utf8",
  }).trim();
  assert.match(
    read(join(fx.vault, "weekly", weekly)),
    /mode: "fallback"[\s\S]*\[\[summaries\/daily\//u,
  );
  assert.match(result.stderr, /night-fallback/u);
});

// День, закрытый iva jobs skip или вставший на паузу после трёх попыток, выжимки не
// получит никогда: неделя собирается без него («нет данных»), а не ждёт вечно.
for (const closed of ["skip", "pause"] as const)
  void test(`неделя с днём без выжимки (${closed}) собирается, день — «нет данных»`, async (t) => {
    const fx = await fixture(t);
    const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    const days = Array.from({ length: 7 }, (_, index) =>
      new Date(monday.getTime() + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
    for (const date of days.slice(0, 6))
      writeFileSync(
        summary(fx, date),
        `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
      );
    const marker =
      "\n<!-- processed: skipped by owner 2026-09-20T00:00:00.000Z -->\n";
    day(
      fx,
      `## 10:00 [text]\nтяжёлый день\n${closed === "skip" ? marker : ""}`,
      days[6],
    );
    if (closed === "pause") {
      const at = "2026-09-20T00:00:00.000Z";
      const tries = Array.from({ length: 3 }, () => ({
        at,
        reason: "no-report",
      }));
      writeFileSync(
        join(fx.data, "rollup-attempts.json"),
        JSON.stringify({ [days[6]]: tries }),
      );
    }
    fx.model.replies = [{ text: JSON.stringify({ gist: "неделя" }) }];
    const result = await night(fx, null);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fx.model.prompts.length, 1, result.stderr);
    assert.doesNotMatch(fx.model.prompts[0], /тяжёлый день/u);
    const weekly = execFileSync("ls", [join(fx.vault, "weekly")], {
      encoding: "utf8",
    }).trim();
    assert.match(weekly, /^\d{4}-W\d{2}\.md$/u);
    const alerts = result.stderr.match(
      /memory-night alert rollup-day-paused/gu,
    );
    assert.equal(
      alerts?.length ?? 0,
      closed === "pause" ? 1 : 0,
      result.stderr,
    );
  });

/** Выжимки дней с description; день — строка YYYY-MM-DD. */
function daySummaries(fx: Fixture, days: readonly string[], hash = "") {
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days)
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n${hash ? `input_hash: "${hash}"\n` : ""}---\n# ${date}\n`,
    );
}
const periodReply = (gist: string) => ({ gist, topics: [], points: [] });
const pinned = (now: string) => ({
  IVA_TEST_NOW: now,
  IVA_JOB_STOP_AT: String(Date.parse(now) + 60_000),
});

// Ремонт (Sol P1): закрытый день недели, которая целиком старше окна 35 дней, а её месяц
// в окне. Неделю собирает та же ночь, за ней месяц; вечной блокировки нет.
void test("неделя вне окна 35 дней, которой ждёт месяц в окне, собирается, за ней месяц", async (t) => {
  const fx = await fixture(t);
  const week = ["17", "18", "19", "20", "21", "22", "23"].map(
    (d) => `2026-08-${d}`,
  );
  daySummaries(
    fx,
    week.filter((date) => date !== "2026-08-20"),
  );
  day(
    fx,
    "## 10:00 [text]\nзакрыт\n\n<!-- processed: skipped by owner -->\n",
    "2026-08-20",
  );
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const result = await night(fx, null, pinned("2026-09-28T12:00:00.000Z"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 2, result.stderr);
  assert.ok(existsSync(join(fx.vault, "weekly/2026-W34.md")));
  assert.ok(existsSync(join(fx.vault, "monthly/2026-08.md")));
});

// Ремонт (Sol P1): поздняя выжимка дня пересобирает неделю, а за ней месяц и год, даже
// когда модель вернула неделе прежний gist: в хеш родителя входит вход ребёнка.
void test("поздняя выжимка дня пересобирает неделю, месяц и год при прежнем description недели", async (t) => {
  const fx = await fixture(t);
  const now = pinned("2027-01-06T12:00:00.000Z");
  const week = ["14", "15", "16", "17", "18", "19", "20"].map(
    (d) => `2026-12-${d}`,
  );
  daySummaries(fx, week.slice(0, 6), "h1");
  day(fx, "## 10:00 [text]\nпоздний\n", week[6]);
  const at = "2026-12-21T00:00:00.000Z";
  writeFileSync(
    join(fx.data, "rollup-attempts.json"),
    JSON.stringify({ [week[6]]: Array(3).fill({ at, reason: "no-report" }) }),
  );
  fx.model.replies = [
    periodReply("неделя"),
    periodReply("декабрь"),
    periodReply("год"),
  ];
  const first = await night(fx, null, now);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fx.model.prompts.length, 3, first.stderr);
  for (const file of [
    "weekly/2026-W51.md",
    "monthly/2026-12.md",
    "yearly/2026.md",
  ]) {
    const fields = parseFrontmatter(read(join(fx.vault, file))).fields!;
    assert.equal(Object.hasOwn(fields, "source"), false);
    assert.match(String(fields.input_hash), /^[a-f0-9]{64}$/u);
    assert.match(String(fields.body_hash), /^[a-f0-9]{64}$/u);
  }
  daySummaries(fx, [week[6]], "late");
  rmSync(join(fx.data, "rollup-attempts.json"));
  commit(fx.vault, "late day");
  fx.model.replies = [
    periodReply("неделя"),
    periodReply("декабрь"),
    periodReply("год"),
  ];
  const second = await night(fx, null, now);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fx.model.prompts.length, 6, second.stderr);
});

void test(
  "night clean: SIGKILL matrix for week, month and year publication",
  { timeout: 60_000 },
  async (t) => {
    const env = pinned("2027-01-06T12:00:00.000Z");
    const files = [
      "weekly/2026-W51.md",
      "monthly/2026-12.md",
      "yearly/2026.md",
    ];
    const answers = [
      periodReply("неделя"),
      periodReply("декабрь"),
      periodReply("год"),
    ];
    const setup = async (context: TestContext) => {
      const fx = await fixture(context);
      daySummaries(
        fx,
        ["14", "15", "16", "17", "18", "19", "20"].map((d) => `2026-12-${d}`),
        "h1",
      );
      commit(fx.vault, "period inputs");
      fx.model.replies = [...answers];
      return fx;
    };
    const reference = await setup(t);
    const trace = join(reference.data, "period-boundaries.txt");
    const complete = await night(reference, null, {
      ...env,
      IVA_TEST_NIGHT_TRACE: trace,
    });
    assert.equal(complete.code, 0, complete.stderr);
    const points = read(trace).trim().split("\n");
    assert.equal(
      points.length,
      12,
      "rename and commit before/after each of three periods",
    );
    const expected = files.map((file) => read(join(reference.vault, file)));
    const outcomes: string[] = [];
    for (const point of points)
      await t.test(point, { timeout: 10_000 }, async (part) => {
        const fx = await setup(part);
        const run = spawnNight(fx, null, {
          ...env,
          IVA_TEST_NIGHT_CRASH: point,
        });
        part.after(() => run.child.kill("SIGKILL"));
        const stopped = await run.result;
        assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
        assert.ok(stopped.stderr.includes(`NIGHT_CRASH ${point}`));
        fx.model.replies = answers.filter(
          (_answer, index) => !existsSync(join(fx.vault, files[index])),
        );
        const resumed = await night(fx, null, env);
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.deepEqual(
          files.map((file) => read(join(fx.vault, file))),
          expected,
        );
        assert.equal(
          git(fx.vault, "status", "--porcelain", "--", ...files),
          "",
        );
        const count = fx.model.prompts.length;
        const repeated = await night(fx, null, env);
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.equal(fx.model.prompts.length, count);
        outcomes.push(point);
        if (process.env.IVA_NIGHT_MATRIX_EVIDENCE)
          writeFileSync(
            `${process.env.IVA_NIGHT_MATRIX_EVIDENCE}.periods.json`,
            JSON.stringify({ points, outcomes }, null, 2),
          );
      });
  },
);

// Ремонт (Sol r2b P1): неделя старше окна уже собрана без дня на паузе, месяц тоже; день
// получил выжимку позже. Зависимый обход берёт и существующих детей, due() по хешу решает:
// пересобраны неделя и месяц.
void test("существующая неделя вне окна пересобирается после поздней выжимки дня, за ней месяц", async (t) => {
  const fx = await fixture(t);
  const now = pinned("2026-09-28T12:00:00.000Z");
  const week = ["17", "18", "19", "20", "21", "22", "23"].map(
    (d) => `2026-08-${d}`,
  );
  daySummaries(
    fx,
    week.filter((date) => date !== "2026-08-20"),
    "h1",
  );
  day(fx, "## 10:00 [text]\nпоздний\n", "2026-08-20");
  const at = "2026-08-21T00:00:00.000Z";
  writeFileSync(
    join(fx.data, "rollup-attempts.json"),
    JSON.stringify({
      "2026-08-20": Array(3).fill({ at, reason: "no-report" }),
    }),
  );
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const first = await night(fx, null, now);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(existsSync(join(fx.vault, "weekly/2026-W34.md")));
  assert.ok(existsSync(join(fx.vault, "monthly/2026-08.md")));
  daySummaries(fx, ["2026-08-20"], "late");
  rmSync(join(fx.data, "rollup-attempts.json"));
  commit(fx.vault, "late day");
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const second = await night(fx, null, now);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fx.model.prompts.length, 4, second.stderr);
  assert.match(fx.model.prompts[2], /2026-W34/u);
  assert.match(fx.model.prompts[3], /2026-08/u);
});

void test("связь пишется в Related обеих Card; связь с неизвестной Card отброшена", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАнна и Борис взяли Аврору\n");
  const contact = (name: string) => [
    "---",
    'type: "contact"',
    "---",
    `# ${name}`,
    "",
    "## Log",
    "",
    "## Related",
    "",
  ];
  const anna = card(fx, "cards/contacts/анна", contact("Анна"));
  const boris = card(fx, "cards/contacts/борис", contact("Борис"));
  const quote = "Анна и Борис взяли Аврору";
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/contacts/анна",
          text: "Анна в Авроре",
          src: "e1",
          quote,
        },
        {
          card: "cards/contacts/борис",
          text: "Борис в Авроре",
          src: "e1",
          quote,
        },
      ],
      links: [
        { a: "cards/contacts/анна", b: "cards/contacts/борис", src: "e1" },
        { a: "cards/contacts/анна", b: "Никто", src: "e1" },
      ],
    }),
    B({ card: "cards/contacts/анна" }, { card: "cards/contacts/борис" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(anna), /## Related\n\n- \[\[cards\/contacts\/борис\]\]/u);
  assert.match(read(boris), /## Related\n\n- \[\[cards\/contacts\/анна\]\]/u);
  assert.match(result.stderr, /отброшено: .*Никто/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

// ── Круг 2: ответы формы настоящих моделей (real2) и находки ревью ─────────────────
const REAL_DAY = [
  "## 09:10 [text]",
  "Утром созвонился с Анной. Она переехала в Ташкент, теперь живёт там.",
  "",
  "## 09:15 [text]",
  "Анна ушла из Яндекса, теперь работает в Uzum.",
  "",
  "## 11:00 [text]",
  "Запустили проект Альфа вместе с Анной, первый клиент — Сбер.",
  "",
  "## 18:20 [text]",
  "Встреча с Борисом из Uzum по интеграции платежей, он пришлёт договор до пятницы.",
  "",
].join("\n");
const ls = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).sort().join("\n") : "";

void test("real2: связь двух новых Card пишется, имя-путь — это Card, цитата с другой пунктуацией принята, выдумка отброшена", async (t) => {
  const fx = await fixture(t);
  day(fx, REAL_DAY);
  const contact = (name: string) => ({ name, type: "contact" });
  fx.model.replies = [
    A({
      new_cards: [
        contact("Анна"),
        { name: "Альфа", type: "project" },
        contact("Сбер"),
        contact("cards/contacts/борис"),
        { name: "Uzum", type: "project" },
        contact("Яндекс"),
      ],
      facts: [
        {
          card: "cards/contacts/анна",
          text: "Анна ведёт проект Альфа",
          src: ["e3"],
          quote: "Запустили проект Альфа вместе с Анной.",
        },
        {
          card: "cards/contacts/анна",
          text: "Живёт в Ташкенте",
          src: ["e1"],
          quote: "живёт в Ташкенте",
        },
        {
          card: "cards/contacts/борис",
          text: "Борис из Uzum",
          src: "e4",
          quote: "Встреча с Борисом из Uzum",
        },
      ],
      links: [
        { a: "Альфа", b: "Сбер", src: ["e3"] },
        { a: "Uzum", b: "Борис", src: ["e4"] },
        { a: "Яндекс", b: "Никто", src: ["e2"] },
      ],
    }),
    B({ card: "cards/contacts/анна" }, { card: "cards/contacts/борис" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  const path = (card: string) => join(fx.vault, `${card}.md`);
  assert.equal(
    ls(join(fx.vault, "cards/contacts")),
    "анна.md\nборис.md\nсбер.md",
  );
  const anna = read(path("cards/contacts/анна"));
  assert.deepEqual(logRows(anna), [
    `- ${DATE}: Анна ведёт проект Альфа · [[daily/${DATE}]] 11:00`,
  ]);
  assert.match(result.stderr, /отброшено: .*живёт в Ташкенте/u);
  assert.match(
    logRows(read(path("cards/contacts/борис")))[0],
    /Борис из Uzum/u,
  );
  const related = (card: string) => cs.sectionRows(read(path(card)), "Related");
  assert.deepEqual(related("cards/projects/альфа"), [
    "- [[cards/contacts/сбер]]",
  ]);
  assert.deepEqual(related("cards/contacts/сбер"), [
    "- [[cards/projects/альфа]]",
  ]);
  assert.deepEqual(related("cards/projects/uzum"), [
    "- [[cards/contacts/борис]]",
  ]);
  assert.deepEqual(related("cards/contacts/борис"), [
    "- [[cards/projects/uzum]]",
  ]);
  assert.doesNotMatch(ls(join(fx.vault, "cards/contacts")), /яндекс/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("Card с truth_date позже разбираемого дня: факт только в Log, B не зовётся, truth_pending нет (#2)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_date: "2026-09-27"',
    ...aurora.slice(4),
  ]);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(logRows(read(file)).length, 1);
  assert.match(read(file), /truth_date: "2026-09-27"/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("время строки Log — от той реплики из src, где стоит цитата (#3)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 09:00 [text]\nУтро\n\n## 15:30 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: ["e1", "e2"],
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  assert.equal((await night(fx)).code, 0);
  assert.deepEqual(logRows(read(file)), [
    `- ${DATE}: Курс сменён · [[daily/${DATE}]] 15:30`,
  ]);
});

void test("битый кэш дня с отложенными фактами не считается отсутствующим: код 1, строка Job, кэш цел (#4)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  mkdirSync(join(fx.data, "memory/night"), { recursive: true });
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  const broken =
    '{"v":1,"date":"2026-09-26","pending":{"cards/projects/аврора":["- факт';
  writeFileSync(cache, broken);
  const result = await night(fx, null);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
  assert.match(result.stderr, new RegExp(`кэш ${DATE}.*не читается`, "u"));
  assert.equal(read(cache), broken);
});

void test("одна нечитаемая Card не останавливает скан: строка Job, остальные идут (#5)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  // Файл вне git (ignored): sweep его не читает, читает только скан Card.
  writeFileSync(join(fx.vault, ".gitignore"), "cards/notes/закрытая.md\n");
  commit(fx.vault);
  const locked = card(fx, "cards/notes/закрытая", ["# Закрытая", ""]);
  chmodSync(locked, 0o000);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(logRows(read(file)).length, 1);
  assert.match(result.stderr, /cards\/notes\/закрытая.*не читается/u);
});

void test("truth_pending: B каждой ночью и без нового дня; Alert, когда правда ждёт дольше трёх ночей (#7)", async (t) => {
  const fx = await fixture(t);
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_pending: "2020-01-01"',
    ...aurora.slice(4, 12),
    "- 2020-01-01: Курс сменён · [[daily/2020-01-01]] 10:00",
    ...aurora.slice(12),
  ]);
  fx.model.replies = [{ text: "не понял" }, { text: "опять не понял" }];
  const failed = await night(fx, null);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[0], /Курс сменён/u);
  assert.match(read(file), /truth_pending: "2020-01-01"/u);
  assert.match(
    failed.stderr,
    /alert night-pending.*аврора.*ждёт с 2020-01-01/u,
  );
  fx.model.replies = [
    B({ card: "cards/projects/аврора", truth: "Курс сменён" }),
  ];
  const fixed = await night(fx, null);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.match(read(file), /# Аврора\n\nКурс сменён\n\n## Log/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("периоды: все пропущенные недели за 35 дней, старшие первыми; fallback пересобирается; правленый не трогается, изменённый вход пересобирает (#10–#12)", async (t) => {
  const fx = await fixture(t);
  const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 14);
  const days = Array.from({ length: 14 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days)
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
    );
  commit(fx.vault);
  const P = (gist: string) => ({ gist, topics: [], points: [] });
  fx.model.replies = [
    { text: "неделя" },
    { text: "неделя" },
    ...Array.from({ length: 8 }, () => P("модель")),
  ];
  const first = await night(fx, null);
  assert.equal(first.code, 0, first.stderr);
  const weeks = ls(join(fx.vault, "weekly")).split("\n");
  assert.equal(weeks.length, 2, first.stderr);
  const [older, newer] = weeks.map((name) => name.replace(/\.md$/u, ""));
  const at = (id: string) => fx.model.prompts.findIndex((p) => p.includes(id));
  assert.ok(
    at(older) >= 0 && at(older) < at(newer),
    fx.model.prompts.join("\n"),
  );
  const weekly = (id: string) => join(fx.vault, "weekly", `${id}.md`);
  assert.match(read(weekly(older)), /mode: "fallback"/u);
  fx.model.replies = Array.from({ length: 8 }, () => P("пересобрано"));
  const second = await night(fx, null);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(read(weekly(older)), /mode: "fallback"/u);
  assert.match(read(weekly(older)), /description: "пересобрано"/u);
  const calls = fx.model.prompts.length;
  const third = await night(fx, null);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(fx.model.prompts.length, calls, "неизменный вход — без вызова");
  writeFileSync(weekly(newer), `${read(weekly(newer))}\nправка владельца\n`);
  writeFileSync(
    summary(fx, days[0]),
    `---\ndescription: "день поздний"\n---\n# ${days[0]}\n`,
  );
  commit(fx.vault);
  const edited = read(weekly(newer));
  fx.model.replies = Array.from({ length: 8 }, () => P("вход изменился"));
  const fourth = await night(fx, null);
  assert.equal(fourth.code, 0, fourth.stderr);
  assert.equal(read(weekly(newer)), edited);
  assert.match(
    fourth.stderr,
    new RegExp(`weekly ${newer}.*изменён вручную`, "u"),
  );
  assert.match(read(weekly(older)), /description: "вход изменился"/u);
});

void test("ответ-пустышка A при репликах владельца — не по форме: повтор с текстом ошибки, потом no-report, выжимки нет (ДЕФ-2)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [{ refusal: "не могу" }, {}];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа: .*выжимк/u);
  assert.equal(existsSync(summary(fx)), false);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /no-report/u);
});

void test("отказ общего коммита правок владельца перед ночью: Alert с причиной, ничего не пишется (Н-6)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  writeFileSync(join(fx.vault, "заметка.md"), "правка владельца\n");
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho причина-хука >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const head = git(fx.vault, "rev-parse", "HEAD");
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
  assert.match(result.stderr, /alert night-sweep: .*не закоммичен/u);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(summary(fx)), false);
});

/** Report ночи без чата печатается в журнал после строки «Report: no chat configured». */
const reportOf = (stderr: string) =>
  /Report: no chat configured\n([\s\S]*?)(?:\nmemory-night: |$)/u.exec(
    stderr,
  )?.[1] ?? null;

function reportsOn(fx: Fixture, language: string) {
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ language, memoryReports: { enabled: true } }),
  );
}

const auroraDay = () => [
  A({
    new_cards: [newAurora],
    facts: [
      { card: "Аврора", text: "Проект запущен", src: "e1", quote: "Запустил" },
    ],
  }),
  B({ card: "cards/projects/аврора", truth: "Проект запуска" }),
];

void test("Report ночи: дни с выжимкой уходят швом Notice; без чата текст отчёта — в журнал", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ memoryReports: { enabled: true } }),
  );
  fx.model.replies = [A()];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /Report: no chat configured\n[\s\S]*Запущен проект Аврора/u,
  );
});

void test("Report ночи по-русски: 3 строки человеческими словами, без служебных строк и дат ISO", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "ru");
  fx.model.replies = auroraDay();
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    reportOf(result.stderr),
    [
      "Ночью я разобрала 1 день памяти.",
      "Новых карточек: 1, дополнено: 0.",
      "26 сентября: Запущен проект Аврора",
    ].join("\n"),
    result.stderr,
  );
});

void test("Report ночи по-английски при language=en", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "en");
  fx.model.replies = auroraDay();
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    reportOf(result.stderr),
    [
      "Last night I went through 1 day of memory.",
      "New Cards: 1, updated: 0.",
      "September 26: Запущен проект Аврора",
    ].join("\n"),
    result.stderr,
  );
});

void test("Report ночи с провалом: одна человеческая строка, служебного текста нет", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПервый день\n", "2026-09-25");
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "ru");
  fx.model.replies = [
    { text: "Не понял задачу" },
    { text: "Вот ответ словами" },
    A(),
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 1, result.stderr);
  const report = reportOf(result.stderr) ?? "";
  assert.equal(
    report,
    [
      "Ночью я разобрала 1 день памяти.",
      "Новых фактов для карточек не было.",
      "26 сентября: Запущен проект Аврора",
      "Не всё получилось: 1 день не разобран, попробую следующей ночью.",
    ].join("\n"),
    result.stderr,
  );
  assert.doesNotMatch(report, /ответ A|не по форме|\d{4}-\d{2}-\d{2}/u);
});

void test("пустая ночь Report не шлёт", async (t) => {
  const fx = await fixture(t);
  reportsOn(fx, "ru");
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(reportOf(result.stderr), null, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
});

void test("занятый дневной замок Card: ночь не пишет Card и ждёт; после освобождения доделывает без второго A (#1)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  const before = read(file);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
  ];
  // Замок берёт дневной write_card, пока ночь ждёт ответ A.
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  const release = await cs.acquireLock(join(fx.vault, "cards", ".write_card"));
  held.release();
  const busy = await run.result;
  release();
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /занята/u);
  assert.equal(read(file), before);
  fx.model.replies = [B({ card: "cards/projects/аврора" })];
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(logRows(read(file)).length, 1);
});

// ── Круг 3 ───────────────────────────────────────────────────────────────────────────
void test("пустышка A после отбрасывания: единственный пункт на неизвестную реплику — не выжимка, повтор и no-report", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  const empty = A({ gist: "", points: [{ text: "Выдумка", src: "e999" }] });
  fx.model.replies = [empty, empty];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа: .*выжимк/u);
  assert.equal(existsSync(summary(fx)), false);
});

void test("коллизия слага с исправной чужой Card: занятое имя — `Имя (D)` и Alert, чужая Card байт в байт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nВстреча с !!!\n");
  const foreign = card(fx, "cards/contacts/card", [
    "---",
    'type: "contact"',
    "---",
    "# Служебная",
    "",
    "## Log",
    "",
    "## Related",
    "",
  ]);
  const before = read(foreign);
  fx.model.replies = [
    A({
      new_cards: [{ name: "!!!", type: "contact" }],
      facts: [{ card: "!!!", text: "Встреча", src: "e1", quote: "Встреча" }],
    }),
    B(),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(foreign), before);
  assert.match(result.stderr, /Похоже на дубль: !!!/u);
  const made = ls(join(fx.vault, "cards/contacts")).split("\n");
  assert.equal(made.length, 2, made.join(", "));
  const fresh = made.find((name) => name !== "card.md")!;
  assert.match(read(join(fx.vault, "cards/contacts", fresh)), /Встреча/u);
});

void test("truth_pending: B этой ночью и при остатке дневной очереди (#r3-4)", async (t) => {
  const fx = await fixture(t);
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const date of dates) day(fx, `## 10:00 [text]\nДень ${date}\n`, date);
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_pending: "2020-01-10"',
    ...aurora.slice(4, 12),
    "- 2020-01-10: Курс сменён · [[daily/2020-01-10]] 10:00",
    ...aurora.slice(12),
  ]);
  fx.model.replies = [
    ...dates.slice(0, 3).map((date) => A({ gist: date })),
    B({ card: "cards/projects/аврора", truth: "Курс сменён" }),
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(fx.model.prompts[3], /Курс сменён/u);
  assert.match(read(file), /# Аврора\n\nКурс сменён\n\n## Log/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
  assert.equal(existsSync(summary(fx, dates[3])), false);
});

void test("отказ связи не оставляет новую Card, заведённую только ради неё (второй конец — битый файл)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАльфа и Борис\n");
  const broken = card(fx, "cards/contacts/борис", [
    "---",
    'description: "битая кавычка',
    "---",
    "# Борис",
    "",
  ]);
  const before = read(broken);
  fx.model.replies = [
    A({
      new_cards: [
        { name: "Альфа", type: "project" },
        { name: "Борис", type: "contact" },
      ],
      links: [{ a: "Альфа", b: "Борис", src: "e1" }],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(fx.vault, "cards/projects/альфа.md")), false);
  assert.equal(read(broken), before);
  assert.match(result.stderr, /связь Альфа ↔ Борис не записана/u);
});

// Alert ночи — на языке владельца (settings.language), как у Brain; дроссель Alert судит
// по сути, а не по тексту: смена языка ту же проблему новой не делает.
void test("Alert ночи на языке владельца, смена языка не повторяет его", async (t) => {
  const fx = await fixture(t);
  const sent = join(fx.data, "telegram-sent.log");
  const double = join(fx.data, "telegram-double.mjs");
  writeFileSync(
    double,
    `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.telegram.org")) return real(url, init);
  appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
};
`,
  );
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    join(fx.data, "usage.jsonl"),
    `${JSON.stringify({ ts: `${yesterday}T10:00:00.000Z`, source: "chat" })}\n`,
  );
  const env = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    NODE_OPTIONS: `--import ${double}`,
  };
  const transcriptAlerts = () =>
    existsSync(sent)
      ? readFileSync(sent, "utf8")
          .split("\n")
          .filter((row) => /vault\/daily/u.test(row))
      : [];
  writeFileSync(join(fx.data, "settings.json"), '{"language":"en"}\n');
  const first = await night(fx, null, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(transcriptAlerts().length, 1, first.stderr);
  assert.match(transcriptAlerts()[0], /no raw day/u);
  assert.doesNotMatch(transcriptAlerts()[0], /нет сырого дня/u);
  writeFileSync(join(fx.data, "settings.json"), '{"language":"ru"}\n');
  // Тот же день часом позже: каждый процесс стартует с IVA_TEST_NOW, и без сдвига
  // вторая ночь оказалась бы раньше первой отправки.
  const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
  const second = await night(fx, null, { ...env, IVA_TEST_NOW: later });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(transcriptAlerts().length, 1, "без повтора на другом языке");
});

// Статус, который днём поставил владелец (status_date), ночь этого дня не меняет; статус
// более раннего дня B менять вправе.
void test("B не затирает status, поставленный днём владельцем; ранний статус меняет", async (t) => {
  for (const [statusDate, expected] of [
    [DATE, "done"],
    ["2026-09-20", "active"],
  ] as const) {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nАврора снова в работе?\n");
    const file = card(fx, "cards/projects/аврора", [
      ...aurora.slice(0, 3),
      'status: "done"',
      `status_date: "${statusDate}"`,
      ...aurora.slice(4),
    ]);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Вопрос о работе",
            src: "e1",
            quote: "Аврора снова в работе",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: "active" }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(read(file), new RegExp(`status: "${expected}"`, "u"));
    assert.match(read(file), new RegExp(`status_date: "${statusDate}"`, "u"));
  }
});

// Статус от B сверяется со schema.json vault, как статус дня у write_card: статус вне
// допустимых для типа Card ночь не пишет, статус Card остаётся прежним.
void test("B не пишет статус вне schema.json: статус Card прежний, допустимый ставится", async (t) => {
  for (const [answer, expected] of [
    ["paused", "active"],
    ["выдумка", "active"],
    ["Done", "active"],
    ["done", "done"],
  ] as const) {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nАврора на паузе\n");
    const file = card(fx, "cards/projects/аврора", aurora);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Проект на паузе",
            src: "e1",
            quote: "Аврора на паузе",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: answer }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(read(file), new RegExp(`status: "${expected}"`, "u"), answer);
  }
});

// «Новых карточек» в Report — все Card, созданные за ночь, а не только те, куда лёг факт:
// Card ради связи тоже новая. Card, которая не записалась (связь отвергнута), не считается.
void test("Report ночи считает все созданные за ночь Card, включая Card ради связи", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАльфа работает со Сбером\n");
  reportsOn(fx, "ru");
  fx.model.replies = [
    A({
      gist: "",
      new_cards: [
        { name: "Альфа", type: "project" },
        { name: "Сбер", type: "contact" },
        { name: "Яндекс", type: "contact" },
      ],
      links: [
        { a: "Альфа", b: "Сбер", src: "e1" },
        { a: "Яндекс", b: "Никто", src: "e1" },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    ls(join(fx.vault, "cards/contacts")),
    "сбер.md",
    "Card ради отвергнутой связи не пишется",
  );
  assert.match(
    reportOf(result.stderr) ?? "",
    /^Новых карточек: 2, дополнено: 0\.$/mu,
    result.stderr,
  );
});

// Со схемой сверяется точный ответ B, как у write_card днём: " done " в схеме нет и не пишется,
// допустимый статус длиннее 40 символов пишется точно, без обрезки.
void test("B: статус сверяется со схемой точной строкой, длинный допустимый пишется целиком", async (t) => {
  const long = "waiting-for-external-approval-and-vendor-confirmation";
  for (const [answer, expected] of [
    [" done ", "active"],
    [long, long],
  ] as const) {
    const fx = await fixture(t);
    writeFileSync(
      join(fx.vault, "schema.json"),
      JSON.stringify({
        node_types: { project: { status: ["active", "done", long] } },
      }),
    );
    commit(fx.vault, "schema");
    day(fx, "## 10:00 [text]\nАврора ждёт подтверждения\n");
    const file = card(fx, "cards/projects/аврора", aurora);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Проект ждёт подтверждения",
            src: "e1",
            quote: "Аврора ждёт подтверждения",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: answer }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      read(file),
      new RegExp(`^status: "${expected}"$`, "mu"),
      JSON.stringify(answer),
    );
  }
});

void test("owner edit window: Card save after B cache publication wins", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Ночная правда" }),
  ];
  const result = await night(fx, DATE, {
    IVA_TEST_OWNER_FILE: file,
    IVA_TEST_OWNER_TRIGGER: "applyTruthCard",
    IVA_TEST_OWNER_STEP: "cache",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OWNER_EDIT_WINDOW applyTruthCard/u);
  assert.match(read(file), /Правда владельца/u);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.doesNotMatch(read(file), /Ночная правда/u);
  assert.match(read(file), /truth_pending/u);
});

void test("owner edit window: giveUp keeps a save made during its cache publication", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B(),
  ];
  const result = await night(fx, DATE, {
    IVA_TEST_OWNER_FILE: file,
    IVA_TEST_OWNER_TRIGGER: "giveUp",
    IVA_TEST_OWNER_STEP: "cache",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OWNER_EDIT_WINDOW giveUp/u);
  assert.match(read(file), /Правда владельца/u);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(read(file), /truth_pending/u);
});

void test("owner edit window: facts built from a Card draft preserve the owner's latest save", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B(),
  ];
  const result = await night(fx, DATE, {
    IVA_TEST_OWNER_FILE: file,
    IVA_TEST_OWNER_TRIGGER: "Day.draft",
    IVA_TEST_OWNER_STEP: "read",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OWNER_EDIT_WINDOW Day.draft/u);
  assert.match(read(file), /Правда владельца/u);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(result.stderr, /Card changed after read/u);
  const calls = fx.model.prompts.length;
  fx.model.replies = [B()];
  const retry = await night(fx);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(
    fx.model.prompts.length,
    calls + 1,
    "A is reused from the saved cache",
  );
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(read(file), /Курс сменён/u);
});

void test("owner edit window: links use the last Card publication as their snapshot", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  card(
    fx,
    "cards/projects/спутник",
    aurora.map((row) => row.replace("Аврора", "Спутник")),
  );
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
      links: [
        { a: "cards/projects/аврора", b: "cards/projects/спутник", src: "e1" },
      ],
    }),
  ];
  const result = await night(fx, DATE, {
    IVA_TEST_OWNER_FILE: file,
    IVA_TEST_OWNER_TRIGGER: "Day.write",
    IVA_TEST_OWNER_STEP: "card",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OWNER_EDIT_WINDOW Day.write/u);
  assert.match(read(file), /Правда владельца/u);
  assert.match(read(file), /OWNER_EDIT/u);
  fx.model.replies = [B()];
  const retry = await night(fx);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(read(file), /\[\[cards\/projects\/спутник\]\]/u);
});

void test("owner edit window: pending facts keep their cache when the Card changes after read", async (t) => {
  const fx = await fixture(t);
  const file = card(fx, "cards/projects/аврора", aurora);
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  mkdirSync(join(cache, ".."), { recursive: true });
  writeFileSync(
    cache,
    JSON.stringify({
      v: 1,
      date: DATE,
      through: 0,
      prefixHash: "",
      touched: [],
      core: [],
      pending: { "cards/projects/аврора": [`- ${DATE}: Отложенный факт`] },
    }),
  );
  const result = await night(fx, null, {
    IVA_TEST_OWNER_FILE: file,
    IVA_TEST_OWNER_TRIGGER: "applyCachePending",
    IVA_TEST_OWNER_STEP: "read",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /OWNER_EDIT_WINDOW applyCachePending/u);
  assert.match(read(file), /Правда владельца/u);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(read(cache), /Отложенный факт/u);
  const retry = await night(fx, null);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(read(file), /OWNER_EDIT/u);
  assert.match(read(file), /Отложенный факт/u);
});

void test("owner edit window: daily summary saved while A runs stays on disk", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПросто день\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  const { summaryText } = await import("./night-input.ts");
  mkdirSync(join(summary(fx), ".."), { recursive: true });
  writeFileSync(
    summary(fx),
    summaryText({ type: "daily-summary" }, "# Owner\n") + "\nOWNER_EDIT\n",
  );
  held.release();
  const result = await run.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(summary(fx)), /OWNER_EDIT/u);
});

for (const hash of ["absent", "valid"] as const)
  void test(`owner edit window: a summary with ${hash} body_hash survives three nights`, async (t) => {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nПросто день\n");
    fx.model.replies = [A()];
    const held = fx.model.hold(1);
    const run = spawnNight(fx);
    await held.reached;
    const { summaryText } = await import("./night-input.ts");
    const owner =
      hash === "valid"
        ? summaryText({ type: "daily-summary" }, "# Owner\n")
        : "---\ntype: daily-summary\n---\n# Owner\n";
    mkdirSync(join(summary(fx), ".."), { recursive: true });
    writeFileSync(summary(fx), owner);
    held.release();
    const result = await run.result;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(read(summary(fx)), owner);
    assert.match(result.stderr, /день ждёт владельца/u);
    for (let next = 0; next < 2; next++) {
      const repeated = await night(fx, null);
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(read(summary(fx)), owner);
      assert.match(repeated.stderr, /день ждёт владельца/u);
    }
    assert.equal(fx.model.prompts.length, 1);
    assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  });

void test("owner edit window: cached summary hashes preserve arbitrary owner text", async (t) => {
  const { summaryText, prefixHash } = await import("./night-input.ts");
  const { textHash } = await import("../../agent/lib/core-write.ts");
  const seed = 20261020;
  t.diagnostic(`fast-check seed=${seed}`);
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.string(), async (before, edit) => {
      const fx = await fixture(t);
      day(fx, "## 10:00 [text]\nПросто день\n");
      const previous = summaryText(
        { type: "daily-summary" },
        `# Before\n${before}\n`,
      );
      const owner = summaryText(
        { type: "daily-summary" },
        `# Owner\n${edit}\n`,
      );
      mkdirSync(join(summary(fx), ".."), { recursive: true });
      writeFileSync(summary(fx), previous);
      const cache = join(fx.data, "memory/night", `${DATE}.json`);
      mkdirSync(join(cache, ".."), { recursive: true });
      writeFileSync(
        cache,
        JSON.stringify({
          v: 1,
          date: DATE,
          through: 0,
          prefixHash: prefixHash([], 0),
          touched: [],
          core: [],
          pass: {
            from: 0,
            upto: 1,
            created: {},
            b: {},
            summaryHash: textHash(previous),
          },
        }),
      );
      fx.model.replies = [A()];
      const held = fx.model.hold(1);
      const run = spawnNight(fx);
      await held.reached;
      writeFileSync(summary(fx), owner);
      held.release();
      for (const result of [await run.result, await night(fx, null)]) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(read(summary(fx)), owner);
        assert.match(result.stderr, /день ждёт владельца/u);
      }
      assert.equal(fx.model.prompts.length, 1);
    }),
    { seed, numRuns: 100 },
  );
});

void test("owner edit window: mismatch summary survives three nights while other days, CORE, periods and Report finish", async (t) => {
  const fx = await fixture(t);
  const older = "2026-09-23";
  day(fx, "## 10:00 [text]\nПросто день\n", older);
  reportsOn(fx, "ru");
  const { summaryText } = await import("./night-input.ts");
  const owner =
    summaryText({ type: "daily-summary" }, "# Owner\n") + "\nOWNER_EDIT\n";
  const periodInput = summary(fx, "2026-08-17");
  mkdirSync(join(periodInput, ".."), { recursive: true });
  writeFileSync(
    periodInput,
    summaryText({ description: "День", input_hash: "old" }, "# Day\n"),
  );
  commit(fx.vault);
  const outcomes: Array<{ code: number | null; kept: boolean }> = [];
  for (const [index, date] of [
    "2026-09-24",
    "2026-09-25",
    "2026-09-26",
  ].entries()) {
    day(fx, "## 10:00 [text]\nКофе после четырёх не пью\n", date);
    fx.model.replies = [
      ...(index === 0
        ? [periodReply("Готовая неделя"), periodReply("Готовый месяц"), A()]
        : []),
      A({ core: [{ text: "Не пьёт кофе после 16:00", src: "e1" }] }),
      {
        sections: [
          { section: "Предпочтения", text: "- Не пьёт кофе после 16:00" },
        ],
      },
    ];
    const held = index === 0 ? fx.model.hold(3) : null;
    const run = spawnNight(fx, null);
    if (held) {
      await held.reached;
      writeFileSync(summary(fx, older), owner);
      held.release();
    }
    const result = await run.result;
    outcomes.push({
      code: result.code,
      kept: read(summary(fx, older)) === owner,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /день ждёт владельца/u);
    assert.equal(existsSync(summary(fx, date)), true, result.stderr);
    assert.match(read(join(fx.vault, "CORE.md")), /Не пьёт кофе после 16:00/u);
    assert.match(
      reportOf(result.stderr) ?? "",
      new RegExp(`${24 + index} сентября:`, "u"),
    );
    assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  }
  assert.match(read(join(fx.vault, "weekly/2026-W34.md")), /Готовая неделя/u);
  assert.match(read(join(fx.vault, "monthly/2026-08.md")), /Готовый месяц/u);
  assert.deepEqual(
    outcomes,
    Array.from({ length: 3 }, () => ({ code: 0, kept: true })),
  );
  fx.model.replies = [];
  const calls = fx.model.prompts.length;
  const manual = await night(fx, older);
  assert.equal(manual.code, 0, manual.stderr);
  assert.equal(read(summary(fx, older)), owner);
  assert.equal(fx.model.prompts.length, calls);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
});

for (const trigger of ["Day.draft", "Day.write", "applyCachePending"] as const)
  void test(`owner edit window: ${trigger} defers its day and finishes the other day, CORE, periods and Report`, async (t) => {
    const fx = await fixture(t);
    const older = "2026-09-25";
    const file = card(fx, "cards/projects/аврора", aurora);
    reportsOn(fx, "ru");
    const first = join(fx.vault, "daily", `${older}.md`);
    const cache = join(fx.data, "memory/night", `${older}.json`);
    writeFileSync(first, "## 10:00 [text]\nАврора сменила курс\n");
    if (trigger === "applyCachePending") {
      mkdirSync(join(cache, ".."), { recursive: true });
      const { prefixHash } = await import("./night-input.ts");
      writeFileSync(
        cache,
        JSON.stringify({
          v: 1,
          date: older,
          through: 0,
          prefixHash: prefixHash([], 0),
          touched: [],
          core: [],
          pending: { "cards/projects/аврора": [`- ${older}: Отложенный факт`] },
        }),
      );
    } else {
      if (trigger === "Day.write")
        card(
          fx,
          "cards/projects/спутник",
          aurora.map((row) => row.replace("Аврора", "Спутник")),
        );
    }
    day(fx, "## 10:00 [text]\nКофе после четырёх не пью\n");
    const periodInput = join(fx.vault, "summaries/daily/2026-08-17.md");
    mkdirSync(join(periodInput, ".."), { recursive: true });
    const { summaryText } = await import("./night-input.ts");
    writeFileSync(
      periodInput,
      summaryText({ description: "День", input_hash: "old" }, "# Day\n"),
    );
    commit(fx.vault);
    fx.model.replies = [
      periodReply("Готовая неделя"),
      periodReply("Готовый месяц"),
      ...(trigger === "applyCachePending"
        ? []
        : [
            A({
              facts: [
                {
                  card: "cards/projects/аврора",
                  text: "Курс сменён",
                  src: "e1",
                  quote: "Аврора сменила курс",
                },
              ],
              links:
                trigger === "Day.write"
                  ? [
                      {
                        a: "cards/projects/аврора",
                        b: "cards/projects/спутник",
                        src: "e1",
                      },
                    ]
                  : [],
            }),
          ]),
      A({ core: [{ text: "Не пьёт кофе после 16:00", src: "e1" }] }),
      {
        sections: [
          { section: "Предпочтения", text: "- Не пьёт кофе после 16:00" },
        ],
      },
    ];
    const result = await night(fx, null, {
      IVA_TEST_OWNER_FILE: file,
      IVA_TEST_OWNER_TRIGGER: trigger,
      IVA_TEST_OWNER_STEP: trigger === "Day.write" ? "card" : "read",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(read(file), /OWNER_EDIT/u);
    assert.equal(existsSync(summary(fx, older)), false);
    assert.equal(existsSync(summary(fx)), true, result.stderr);
    assert.match(read(join(fx.vault, "CORE.md")), /Не пьёт кофе после 16:00/u);
    assert.match(read(join(fx.vault, "weekly/2026-W34.md")), /Готовая неделя/u);
    assert.match(reportOf(result.stderr) ?? "", /26 сентября:/u);
    assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
    assert.match(
      read(cache),
      trigger === "applyCachePending" ? /Отложенный факт/u : /"pass"/u,
    );
    fx.model.replies = trigger === "applyCachePending" ? [A()] : [B()];
    const retry = await night(fx, null);
    assert.equal(retry.code, 0, retry.stderr);
    assert.match(
      read(file),
      trigger === "applyCachePending" ? /Отложенный факт/u : /Курс сменён/u,
    );
    assert.match(read(file), /OWNER_EDIT/u);
  });

void test("owner edit window: period summary saved while the model runs wins", async (t) => {
  const fx = await fixture(t);
  const { summaryText } = await import("./night-input.ts");
  const daily = join(fx.vault, "summaries/daily/2026-08-17.md");
  mkdirSync(join(daily, ".."), { recursive: true });
  writeFileSync(
    daily,
    summaryText({ description: "День", input_hash: "old" }, "# Day\n"),
  );
  commit(fx.vault);
  fx.model.replies = [periodReply("Ночная неделя")];
  const held = fx.model.hold(1);
  const run = spawnNight(fx, null);
  await held.reached;
  const weekly = join(fx.vault, "weekly/2026-W34.md");
  mkdirSync(join(weekly, ".."), { recursive: true });
  writeFileSync(
    weekly,
    summaryText({ description: "Владелец" }, "# Owner\n") + "\nOWNER_EDIT\n",
  );
  held.release();
  const result = await run.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(weekly), /OWNER_EDIT/u);
  assert.doesNotMatch(read(weekly), /Ночная неделя/u);
});

void test("#309: kill during a later portion resumes from the saved answer", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [A({ gist: "saved first portion" })];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  t.after(() => run.child.kill("SIGKILL"));
  await Promise.race([
    held.reached,
    run.result.then((result) => {
      throw new Error(result.stderr);
    }),
  ]);
  run.child.kill("SIGKILL");
  await run.result;
  const cache = JSON.parse(
    read(join(fx.data, "memory/night", `${DATE}.json`)),
  ) as {
    pass: {
      a?: unknown;
      summaryHash: string | null;
      progress: { answers: Array<{ gist: string }> };
    };
  };
  assert.equal(cache.pass.a, undefined, "0.5.5 must see an unfinished A");
  assert.equal(cache.pass.progress.answers.length, 1);
  assert.equal(cache.pass.progress.answers[0].gist, "saved first portion");
  assert.equal(
    cache.pass.summaryHash,
    null,
    "#337 snapshot survives checkpoints",
  );
  // Release the dead request before giving the next process its response.
  held.release();
  await new Promise<void>((accept) => setImmediate(accept));
  fx.model.replies = [
    A({ gist: "finished", points: [{ text: "second", src: "e2" }] }),
  ];
  const resumed = await night(fx);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 3);
  assert.match(fx.model.prompts[2], /saved first portion/u);
  assert.doesNotMatch(fx.model.prompts[2], /аааа/u);
  const finished = JSON.parse(
    read(join(fx.data, "memory/night", `${DATE}.json`)),
  ) as { pass?: unknown; writtenSummaryHash?: string };
  assert.equal(finished.pass, undefined);
  assert.equal(typeof finished.writtenSummaryHash, "string");
  assert.match(read(summary(fx)), /description: "finished"/u);
});

void test("#309: a 503 resumes the same night without repeating earlier portions or facts", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\nАврора ${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [
    A({
      gist: "first saved",
      new_cards: [newAurora],
      facts: [{ card: "Аврора", text: "Аврора", quote: "Аврора", src: "e1" }],
    }),
    { status: 503 },
    A({ gist: "all done", points: [{ text: "second", src: "e2" }] }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(fx.model.prompts[2], /first saved/u);
  assert.doesNotMatch(fx.model.prompts[2], /аааа/u);
  assert.equal(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
});

void test("#341: transient failures use growing pauses and preserve day attempts", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  const attemptFile = join(fx.data, "rollup-attempts.json");
  const before = JSON.stringify({ [DATE]: [{ at: NOW, reason: "no-report" }] });
  writeFileSync(attemptFile, before);
  fx.model.replies = [
    ...Array.from({ length: 3 }, () => ({ status: 503 })),
    A(),
  ];
  const held = fx.model.hold(4);
  const pauses = join(fx.data, "pauses.log");
  const run = spawnNight(fx, null, { IVA_TEST_PAUSES: pauses });
  t.after(() => run.child.kill("SIGKILL"));
  await Promise.race([
    held.reached,
    run.result.then((result) => {
      throw new Error(result.stderr);
    }),
  ]);
  assert.equal(
    read(attemptFile),
    before,
    "transient failures spend no day attempts",
  );
  held.release();
  const result = await run.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.deepEqual(
    read(pauses).trim().split("\n").map(Number),
    [5_000, 30_000, 120_000],
  );
  assert.deepEqual(JSON.parse(read(attemptFile)), {});
  assert.ok(existsSync(summary(fx)));
});

void test("#341: deadline during backoff keeps progress available to the next night", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [A({ gist: "saved before outage" }), { status: 503 }];
  const result = await night(fx, null, {
    IVA_JOB_STOP_AT: String(Date.parse(NOW) + 2_500),
  });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  fx.model.replies = [
    A({
      gist: "finished after outage",
      points: [{ text: "second", src: "e2" }],
    }),
  ];
  const resumed = await night(fx);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 3);
  assert.match(fx.model.prompts[2], /saved before outage/u);
  assert.doesNotMatch(fx.model.prompts[2], /аааа/u);
});

void test("#309: saved prefix is reused for every generated interruption point", async (t) => {
  const seed = 20261020;
  t.diagnostic(`fast-check seed=${seed}`);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 5 }),
      fc.nat(),
      async (parts, point) => {
        const fx = await fixture(t);
        const interrupted = 1 + (point % (parts - 1));
        day(
          fx,
          Array.from(
            { length: parts },
            (_, i) => `## 1${i}:00 [text]\n${String(i).repeat(30_000)}\n`,
          ).join("\n"),
        );
        const answers = Array.from({ length: parts }, (_, i) =>
          A({
            gist: `portion ${i}`,
            points: [{ text: `point ${i}`, src: `e${i + 1}` }],
          }),
        );
        fx.model.replies = [...answers.slice(0, interrupted), { status: 401 }];
        assert.equal((await night(fx)).code, 1);
        const cachePath = join(fx.data, "memory/night", `${DATE}.json`);
        const cache = JSON.parse(read(cachePath)) as {
          pass: { progress: { answers: unknown[] } };
        };
        assert.equal(cache.pass.progress.answers.length, interrupted);
        // Saved input identity protects the correspondence between portion and answer.
        const daily = join(fx.vault, "daily", `${DATE}.md`);
        const original = read(daily);
        writeFileSync(daily, original.replace("0000", "edit"));
        const edited = await night(fx);
        assert.equal(edited.code, 0, edited.stderr);
        assert.match(edited.stderr, /изменён во время разбора/u);
        assert.equal(fx.model.prompts.length, interrupted + 1);
        writeFileSync(daily, original);
        fx.model.replies = answers.slice(interrupted);
        const resumed = await night(fx);
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.equal(fx.model.prompts.length, parts + 1);
        assert.match(fx.model.prompts[interrupted + 1], /portion 0/u);
        const reference = await fixture(t);
        day(reference, original.slice(original.indexOf("## ")));
        reference.model.replies = answers;
        assert.equal((await night(reference)).code, 0);
        assert.equal(
          read(summary(fx)),
          read(summary(reference)),
          "same result as an uninterrupted day",
        );
      },
    ),
    { seed, numRuns: 8 },
  );
});

void test("#309: night ceiling preserves a completed portion for the next night", async (t) => {
  const fx = await fixture(t);
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ night: { raisesPerNight: 0 } }),
  );
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [
    { usage: 300_000, value: A({ gist: "saved at ceiling" }) },
  ];
  const cut = await night(fx);
  assert.equal(cut.code, 1, cut.stderr);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  assert.equal(fx.model.prompts.length, 1);
  fx.model.replies = [
    A({
      gist: "finished after ceiling",
      points: [{ text: "second", src: "e2" }],
    }),
  ];
  const resumed = await night(fx);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /saved at ceiling/u);
  assert.doesNotMatch(fx.model.prompts[1], /аааа/u);
});

void test("#341: an edited partial day waits while its neighbour completes", async (t) => {
  const fx = await fixture(t);
  const first = "2026-09-25";
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
    first,
  );
  day(fx, "## 10:00 [text]\nСоседний день\n");
  fx.model.replies = [
    A({ gist: "saved original" }),
    { status: 503 },
    A({ gist: "neighbour finished" }),
  ];
  const held = fx.model.hold(2);
  const pauses = join(fx.data, "pauses.log");
  const run = spawnNight(fx, null, { IVA_TEST_PAUSES: pauses });
  t.after(() => run.child.kill("SIGKILL"));
  await Promise.race([
    held.reached,
    run.result.then((result) => {
      throw new Error(result.stderr);
    }),
  ]);
  const daily = join(fx.vault, "daily", `${first}.md`);
  const edited = read(daily).replace("аааа", "правка");
  writeFileSync(daily, edited);
  held.release();
  const result = await run.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /изменён во время разбора/u);
  assert.ok(existsSync(summary(fx)));
  assert.equal(existsSync(summary(fx, first)), false);
  assert.equal(read(daily), edited);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  const cacheFile = join(fx.data, "memory/night", `${first}.json`);
  const cache = read(cacheFile);
  const next = await night(fx, null);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stderr, /изменён во время разбора/u);
  assert.equal(read(cacheFile), cache, "waiting preserves saved portions");
  assert.equal(fx.model.prompts.length, 3);
});

void test("#341: genuine day failures still exhaust the three day attempts", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  for (let i = 0; i < 3; i++) {
    fx.model.replies = [{ text: "invalid JSON" }, { text: "invalid JSON" }];
    const result = await night(fx, null);
    assert.equal(result.code, 1, result.stderr);
  }
  const attempts = JSON.parse(
    read(join(fx.data, "rollup-attempts.json")),
  ) as Record<string, unknown[]>;
  assert.equal(attempts[DATE].length, 3);
  await night(fx, null);
  await night(fx);
  assert.equal(
    fx.model.prompts.length,
    6,
    "exhausted day waits across automatic and manual nights",
  );
  assert.equal(existsSync(summary(fx)), false);
});

// Стас, 23.10: настоящий процесс с обычным пределом 40 вызовов / 300k.
// 52k повторяет расход из отчёта; 150k даёт больше трёх обрезов за день.
for (const [scenario, usage, legacy] of [
  ["a: 11 частей за несколько ночей", 52_000, false],
  ["b: сохранённый прогресс переживает больше трёх обрезов", 150_000, false],
  ["c: три старых cut возвращают день в очередь", 52_000, true],
] as const)
  void test(`Стас: ${scenario}`, async (t) => {
    const fx = await fixture(t);
    writeFileSync(
      join(fx.data, "settings.json"),
      JSON.stringify({ night: { raisesPerNight: 0 } }),
    );
    const raw = Array.from(
      { length: 11 },
      (_, i) =>
        `## ${String(i + 1).padStart(2, "0")}:00 [text]\n${String.fromCharCode(97 + i).repeat(30_000)}\n`,
    ).join("\n");
    const daily = day(fx, raw);
    const answers = Array.from({ length: 11 }, (_, i) =>
      A({
        gist: `saved-part-${i + 1}`,
        points: Array.from({ length: i + 1 }, (_, j) => ({
          text: `point-${j + 1}`,
          src: [`e${j + 1}`],
        })),
      }),
    );
    const attemptFile = join(fx.data, "rollup-attempts.json");
    const before = JSON.stringify({
      [DATE]: Array.from({ length: 3 }, () => ({ at: NOW, reason: "cut" })),
    });
    if (legacy) writeFileSync(attemptFile, before);
    fx.model.replies = answers.map((value) => ({ usage, value }));
    const cacheFile = join(fx.data, "memory/night", `${DATE}.json`);
    let saved = 0;
    let cuts = 0;
    for (let n = 0; n < 12; n++) {
      const called = fx.model.prompts.length;
      // Каждый запуск заново выбирает очередь, как следующая ночь по расписанию.
      const result = await night(fx, null);
      assert.ok(fx.model.prompts.length > called, result.stderr);
      assert.doesNotMatch(result.stderr, /rollup-day-paused/u);
      if (existsSync(summary(fx))) {
        assert.equal(result.code, 0, result.stderr);
        break;
      }
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /обрез пределом ночи/u);
      cuts++;
      const cache = JSON.parse(read(cacheFile)) as {
        pass: { progress: { answers: unknown[] } };
      };
      const progress = cache.pass.progress.answers;
      assert.ok(progress.length > saved);
      assert.deepEqual(progress, answers.slice(0, progress.length));
      saved = progress.length;
      // Обрез сохраняет прежний файл, включая читаемые при откате cut.
      assert.equal(existsSync(attemptFile), legacy);
      if (legacy) assert.equal(read(attemptFile), before);
      assert.equal(read(daily), raw);
    }
    assert.ok(cuts >= (usage === 150_000 ? 4 : 1));
    assert.equal(
      fx.model.prompts.length,
      11,
      "каждая часть A вызвана один раз",
    );
    assert.equal(fx.model.replies.length, 0);
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < i; j++)
        assert.ok(fx.model.prompts[i].includes(`saved-part-${j + 1}`));
      for (let j = 0; j < 11; j++)
        assert.equal(
          fx.model.prompts[i].includes(String.fromCharCode(97 + j).repeat(100)),
          i === j,
          `вызов ${i + 1} читает только свою часть ${j + 1}`,
        );
    }
    const text = read(summary(fx));
    for (let i = 0; i < 11; i++)
      assert.ok(text.includes(`- point-${i + 1} · [[daily/${DATE}]]`));
    assert.equal(readdirSync(join(fx.vault, "summaries/daily")).length, 1);
    assert.equal((read(daily).match(/<!-- processed:/gu) ?? []).length, 1);
    const reference = await fixture(t);
    day(reference, raw);
    reference.model.replies = answers;
    const uninterrupted = await night(reference, null);
    assert.equal(uninterrupted.code, 0, uninterrupted.stderr);
    assert.equal(
      text,
      read(summary(reference)),
      "полная выжимка совпадает с цельным разбором",
    );
    if (existsSync(attemptFile))
      assert.deepEqual(JSON.parse(read(attemptFile)), {});
    const head = git(fx.vault, "rev-parse", "HEAD");
    const repeated = await night(fx, null);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(fx.model.prompts.length, 11);
    assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
    t.diagnostic(`11 частей, ${cuts + 1} ночей, ${cuts} обрезов, 11 вызовов A`);
  });

void test(
  "night clean: SIGKILL matrix at every durable day and CORE boundary",
  { timeout: 180_000 },
  async (t) => {
    const answerA = A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил проект Аврора",
        },
        {
          card: "cards/projects/вега",
          text: "Вега запущена",
          src: "e1",
          quote: "Вега",
        },
      ],
      aliases: [{ card: "Аврора", alias: "Аврора", src: "e1" }],
      links: [{ a: "Аврора", b: "cards/projects/вега", src: "e1" }],
      core: [{ text: "Любит чай", src: "e1" }],
    });
    const answerB = B(
      { card: "cards/projects/аврора", truth: "Проект запущен" },
      { card: "cards/projects/вега", truth: "Вега связана с Авророй" },
    );
    const answerC = {
      sections: [{ section: "Предпочтения", text: "- Любит чай" }],
    };
    const setup = async (context: TestContext) => {
      const fx = await fixture(context);
      day(fx, "## 10:00 [text]\nЗапустил проект Аврора и Вега. Люблю чай\n");
      card(
        fx,
        "cards/projects/вега",
        aurora.map((line) => line.replace("Аврора", "Вега")),
      );
      fx.model.replies = [answerA, answerB, answerC];
      return fx;
    };
    const reference = await setup(t);
    const trace = join(reference.data, "boundaries.txt");
    const complete = await night(reference, DATE, {
      IVA_TEST_NIGHT_TRACE: trace,
    });
    assert.equal(complete.code, 0, complete.stderr);
    const points = read(trace).trim().split("\n");
    assert.equal(new Set(points).size, points.length);
    for (const family of [
      "rename:cache:",
      "rename:vault:cards/",
      "rename:vault:summaries/",
      "append:vault:daily/",
      "rename:vault:CORE.md",
      "commit:",
    ])
      assert.ok(
        points.some((point) => point.startsWith(family)),
        family,
      );
    const files = [
      `daily/${DATE}.md`,
      `summaries/daily/${DATE}.md`,
      "cards/projects/аврора.md",
      "cards/projects/вега.md",
      "CORE.md",
    ];
    const expected = files.map((file) => read(join(reference.vault, file)));
    const outcomes: Array<{ point: string; calls: number }> = [];
    for (const point of points)
      await t.test(point, { timeout: 15_000 }, async (part) => {
        const fx = await setup(part);
        const run = spawnNight(fx, DATE, { IVA_TEST_NIGHT_CRASH: point });
        part.after(() => run.child.kill("SIGKILL"));
        const stopped = await run.result;
        assert.equal(stopped.signal, "SIGKILL", stopped.stderr);
        assert.ok(
          stopped.stderr.includes(`NIGHT_CRASH ${point}`),
          stopped.stderr,
        );
        const file = join(fx.data, "memory/night", `${DATE}.json`);
        const cache = existsSync(file)
          ? (JSON.parse(read(file)) as {
              core: unknown[];
              pass?: {
                a?: unknown[];
                progress?: { answers: unknown[] };
                b: Record<string, unknown>;
              };
            })
          : null;
        const replies: unknown[] = [];
        if (!cache || cache.pass) {
          if (!cache?.pass?.a && !cache?.pass?.progress?.answers.length)
            replies.push(answerA);
          if (!cache?.pass?.b["cards/projects/аврора"]) replies.push(answerB);
        }
        if (!cache || cache.pass || cache.core.length) replies.push(answerC);
        fx.model.replies = replies;
        // The killed holder is gone. Age its real lock directory past the normal
        // 15-second grace without sleeping or changing the lock implementation.
        const lock = join(fx.vault, "cards/.write_card.lock");
        if (existsSync(lock)) {
          const stale = new Date(Date.parse(NOW) - 30_000);
          utimesSync(lock, stale, stale);
        }
        const resumed = await night(fx);
        assert.equal(resumed.code, 0, resumed.stderr);
        assert.deepEqual(
          files.map((file) => read(join(fx.vault, file))),
          expected,
        );
        assert.equal(
          git(fx.vault, "status", "--porcelain", "--", ...files),
          "",
        );
        const final = JSON.parse(read(file)) as Record<string, unknown>;
        assert.equal(final.pass, undefined);
        assert.equal(Object.hasOwn(final, "coreDone"), false);
        assert.equal(
          new Date(String(final.completedAt)).toISOString().slice(0, 10),
          TODAY,
        );
        assert.deepEqual(final.core, []);
        const count = fx.model.prompts.length;
        const repeated = await night(fx, null);
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.equal(
          fx.model.prompts.length,
          count,
          "settled results never call the model again",
        );
        outcomes.push({ point, calls: count });
        if (process.env.IVA_NIGHT_MATRIX_EVIDENCE)
          writeFileSync(
            process.env.IVA_NIGHT_MATRIX_EVIDENCE,
            JSON.stringify({ points, outcomes }, null, 2),
          );
      });
    t.diagnostic(
      `${outcomes.length} durable boundaries: SIGKILL, resume, identical results, no repeat after completion`,
    );
  },
);

for (const boundary of ["before", "after"] as const)
  for (const previous of [false, true])
    void test(`R1: crash ${boundary} summary rename, previous=${previous}, resumes cached A`, async (t) => {
      const fx = await fixture(t);
      const daily = day(fx, "## 10:00 [text]\nЗапустили Аврору\n");
      let old: string | null = null;
      if (previous) {
        fx.model.replies = [A()];
        const initial = await night(fx);
        assert.equal(initial.code, 0, initial.stderr);
        old = read(summary(fx));
        appendFileSync(daily, "\n## 11:00 [text]\nПоздняя реплика\n");
      }
      const cacheFile = join(fx.data, "memory/night", `${DATE}.json`);
      const oldHash = existsSync(cacheFile)
        ? (JSON.parse(read(cacheFile)) as { writtenSummaryHash?: string })
            .writtenSummaryHash
        : undefined;
      fx.model.replies = [A({ gist: "Recovered summary" })];
      const crashed = await night(fx, DATE, {
        IVA_TEST_SUMMARY_CRASH: boundary,
      });
      assert.equal(crashed.code, 86, crashed.stderr);
      assert.match(crashed.stderr, /SUMMARY_CRASH/u);
      if (boundary === "before")
        assert.equal(existsSync(summary(fx)) ? read(summary(fx)) : null, old);
      else assert.match(read(summary(fx)), /Recovered summary/u);
      const pending = JSON.parse(read(cacheFile)) as {
        writtenSummaryHash?: string;
        pass?: unknown;
      };
      assert.equal(
        pending.writtenSummaryHash,
        oldHash,
        "file is published before its hash is cached",
      );
      assert.ok(pending.pass);
      const recovered = await night(fx);
      assert.equal(recovered.code, 0, recovered.stderr);
      assert.match(read(summary(fx)), /Recovered summary/u);
      assert.doesNotMatch(recovered.stderr, /день ждёт владельца/u);
      assert.equal(fx.model.prompts.length, previous ? 2 : 1);
      const finished = JSON.parse(read(cacheFile)) as { pass?: unknown };
      assert.equal(finished.pass, undefined);
      const repeated = await night(fx);
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(fx.model.prompts.length, previous ? 2 : 1);
    });

for (const boundary of ["before", "after"] as const)
  for (const legacySnapshot of [false, true])
    void test(`R1: owner text after crash ${boundary} summary rename, legacy=${legacySnapshot}, survives retries`, async (t) => {
      const fx = await fixture(t);
      const daily = day(fx, "## 10:00 [text]\nЗапустили Аврору\n");
      if (legacySnapshot) {
        fx.model.replies = [A()];
        const initial = await night(fx);
        assert.equal(initial.code, 0, initial.stderr);
        appendFileSync(daily, "\n## 11:00 [text]\nПоздняя реплика\n");
      }
      fx.model.replies = [A()];
      const crashed = await night(fx, DATE, {
        IVA_TEST_SUMMARY_CRASH: boundary,
      });
      assert.equal(crashed.code, 86, crashed.stderr);
      if (legacySnapshot) {
        const cacheFile = join(fx.data, "memory/night", `${DATE}.json`);
        const cache = JSON.parse(read(cacheFile)) as {
          pass: { summaryHash?: string | null };
        };
        delete cache.pass.summaryHash;
        writeFileSync(cacheFile, JSON.stringify(cache));
      }
      const { summaryText } = await import("./night-input.ts");
      const owner = summaryText({ description: "Owner" }, "# OWNER_EDIT\n");
      writeFileSync(summary(fx), owner);
      for (let n = 0; n < 3; n++) {
        const repeated = await night(fx);
        assert.equal(repeated.code, 0, repeated.stderr);
        assert.match(repeated.stderr, /день ждёт владельца/u);
        assert.equal(read(summary(fx)), owner);
      }
      assert.equal(fx.model.prompts.length, legacySnapshot ? 2 : 1);
    });

// 800 КБ UTF-8: накопительные выжимки также входят в реальный вход следующей части.
function russianLongDay() {
  const raw = Array.from(
    { length: 10 },
    (_, i) =>
      `## ${String(i + 1).padStart(2, "0")}:00 [text]\n${String.fromCharCode(0x430 + i).repeat(40_000)}\n`,
  ).join("\n");
  const answers = Array.from({ length: 10 }, (_, i) =>
    A({
      gist: `часть-${i + 1} ` + "я".repeat(3_000 * (i + 1)),
      points: Array.from({ length: i + 1 }, (_, j) => ({
        text: `итог-${j + 1}`,
        src: [`e${j + 1}`],
      })),
    }),
  );
  return { raw, answers };
}

void test("self-heal: 800 KB Russian day resumes after ceiling with raises disabled", async (t) => {
  const fx = await fixture(t);
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ night: { raisesPerNight: 0 } }),
  );
  const { raw, answers } = russianLongDay();
  assert.ok(
    Buffer.byteLength(raw) >= 800_000 && Buffer.byteLength(raw) < 810_000,
  );
  day(fx, raw);
  fx.model.replies = answers.map((value) => ({ usage: "russian", value }));
  const first = await night(fx, null);
  assert.equal(first.code, 1, first.stderr);
  const cache = JSON.parse(
    read(join(fx.data, "memory/night", `${DATE}.json`)),
  ) as {
    pass: { progress: { answers: unknown[] } };
  };
  const k = cache.pass.progress.answers.length;
  assert.ok(k > 0 && k < answers.length);
  assert.deepEqual(cache.pass.progress.answers, answers.slice(0, k));
  const second = await night(fx, null);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fx.model.prompts.length, answers.length);
  for (let i = 0; i < answers.length; i++) {
    assert.ok(
      fx.model.prompts[i].includes(String.fromCharCode(0x430 + i).repeat(100)),
    );
    for (let j = 0; j < i; j++)
      assert.ok(
        !fx.model.prompts[i].includes(
          String.fromCharCode(0x430 + j).repeat(100),
        ),
      );
    assert.ok(read(summary(fx)).includes(`итог-${i + 1}`));
  }
  assert.equal(readdirSync(join(fx.vault, "summaries/daily")).length, 1);
  t.diagnostic(
    `800 KB: night 1 saved ${k}, night 2 starts at ${k + 1}; ${answers.length} total calls`,
  );
});

void test("self-heal: 800 KB Russian day finishes in one night and reports a persisted raise", async (t) => {
  const fx = await fixture(t);
  reportsOn(fx, "ru");
  const { raw, answers } = russianLongDay();
  day(fx, raw);
  fx.model.replies = answers.map((value) => ({ usage: "russian", value }));
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, answers.length);
  const settings = JSON.parse(read(join(fx.data, "settings.json"))) as {
    language: string;
    memoryReports: { enabled: boolean };
    night: { inputTokens: number };
  };
  assert.equal(settings.night.inputTokens, 600_000);
  assert.equal(settings.language, "ru");
  assert.equal(settings.memoryReports.enabled, true);
  assert.match(reportOf(result.stderr) ?? "", /подняла до 600000/u);
  assert.match(reportOf(result.stderr) ?? "", /свёрнуто дней 1, в очереди 0/u);
  for (let i = 0; i < answers.length; i++)
    assert.ok(read(summary(fx)).includes(`итог-${i + 1}`));
});

void test("self-heal: hard ceiling sends one alert across repeated nights and a language change", async (t) => {
  const fx = await fixture(t);
  const sent = join(fx.data, "sent.jsonl");
  const preload = `const real = fetch; globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.telegram.org")) return real(url, init);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };`;
  const env = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(preload)}`,
  };
  const { raw, answers } = russianLongDay();
  day(fx, raw);
  const putSettings = (language: string) =>
    writeFileSync(
      join(fx.data, "settings.json"),
      JSON.stringify({
        language,
        night: { inputTokens: 300_000, maxInputTokens: 300_000 },
      }),
    );
  putSettings("ru");
  fx.model.replies = answers.map((value) => ({ usage: "russian", value }));
  const first = await night(fx, null, env);
  assert.equal(first.code, 1, first.stderr);
  const k = fx.model.prompts.length;
  const cacheFile = join(fx.data, "memory/night", `${DATE}.json`);
  // Тот же исчерпанный вход во второй процесс: alertOnce помнит доставку, а не процесс.
  const cache = read(cacheFile);
  const preloadUsage = `import fs from "node:fs"; const real = fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("api.telegram.org")) return real(url, init);
      fs.appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };`;
  // Сохранённые ответы остаются; потолок первого запроса второй ночи достигается
  // расходом модели на первой продолженной части.
  putSettings("en");
  fx.model.replies = answers
    .slice(k)
    .map((value) => ({ usage: 300_000, value }));
  const second = await night(fx, null, {
    ...env,
    NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(preloadUsage)}`,
    IVA_TEST_NOW: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
  });
  assert.equal(second.code, 1, second.stderr);
  assert.notEqual(read(cacheFile), cache);
  const messages = read(sent)
    .split("\n")
    .filter((row) => row.includes("maxInputTokens"));
  assert.equal(messages.length, 1, read(sent));
  assert.match(messages[0], /300000/u);
});

void test("self-heal: a previous day can exhaust the budget before the first saved A of its neighbour", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПервый день\n", "2026-09-25");
  day(fx, "## 10:00 [text]\nВторой день\n");
  fx.model.replies = [{ usage: 300_000, value: A() }];
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ night: { raisesPerNight: 0 } }),
  );
  const cut = await night(fx, null);
  assert.equal(cut.code, 1, cut.stderr);
  const file = join(fx.data, "memory/night", `${DATE}.json`);
  const cache = JSON.parse(read(file)) as { pass: { progress?: unknown } };
  assert.ok(cache.pass);
  assert.equal(cache.pass.progress, undefined);
  assert.equal(fx.model.prompts.length, 1);
  writeFileSync(join(fx.data, "settings.json"), "{}");
  fx.model.replies = [A({ gist: "Второй день продолжен" })];
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(read(summary(fx)), /Второй день продолжен/u);
});

void test("self-heal: reaching a raised hard ceiling alerts once when the next night starts at that ceiling", async (t) => {
  const fx = await fixture(t);
  const sent = join(fx.data, "raised-ceiling-sent.jsonl");
  const preload = `import { appendFileSync } from "node:fs";
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("api.telegram.org")) return real(url, init);
      appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };`;
  const env = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(preload)}`,
  };
  const alerts = () =>
    (existsSync(sent) ? read(sent).trim().split("\n") : [])
      .map((row) => JSON.parse(row) as { text?: string })
      .filter((row) => row.text?.includes("iva night set maxInputTokens"));
  const { raw, answers } = russianLongDay();
  day(fx, raw);
  const file = join(fx.data, "settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      language: "ru",
      night: {
        maxInputTokens: 600_000,
        raisesPerNight: 1,
      },
    }),
  );
  fx.model.replies = answers.map((value) => ({ usage: 100_000, value }));
  const first = await night(fx, null, env);
  assert.equal(first.code, 1, first.stderr);
  const saved = JSON.parse(read(file)) as {
    language: string;
    night: { inputTokens: number };
  };
  assert.equal(saved.night.inputTokens, 600_000);
  const k = fx.model.prompts.length;
  assert.equal(k, 6);
  assert.equal(alerts().length, 1, read(sent));
  assert.match(alerts()[0].text!, /поднимала пределы 1 раз/u);
  // Сохранённый мягкий предел уже равен потолку: у нового процесса ноль поднятий.
  writeFileSync(file, JSON.stringify({ ...saved, language: "en" }));
  fx.model.replies = answers
    .slice(k)
    .map((value) => ({ usage: 600_000, value }));
  const second = await night(fx, null, {
    ...env,
    IVA_TEST_NOW: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
  });
  assert.equal(second.code, 1, second.stderr);
  assert.equal(fx.model.prompts.length, k + 1);
  assert.doesNotMatch(second.stderr, /raised it to/u);
  assert.equal(alerts().length, 1, read(sent));
});

void test("repair sweep: git timeout at a raised ceiling sends one alert across processes and languages", async (t) => {
  const fx = await fixture(t);
  const sent = join(fx.data, "sweep-sent.jsonl");
  const trace = join(fx.data, "status-timeouts.jsonl");
  const bin = join(fx.data, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "status") setInterval(() => {}, 1000);
else process.exit(cp.spawnSync("/usr/bin/git", args, { stdio: "inherit" }).status ?? 1);
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const preload = `import cp from "node:child_process"; import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = cp.execFile;
cp.execFile = (file, args, options, callback) => {
  if (file !== "git" || args[0] !== "status") return original(file, args, options, callback);
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, timeout: options.timeout }) + "\\n");
  return original(file, args, { ...options, timeout: options.timeout / 60 }, callback);
};
syncBuiltinESMExports();
const real = fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.telegram.org")) return real(url, init);
  fs.appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
};`;
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    NODE_OPTIONS: `--import data:text/javascript,${encodeURIComponent(preload)}`,
  };
  const file = join(fx.data, "settings.json");
  writeFileSync(
    file,
    JSON.stringify({
      language: "ru",
      night: { gitTimeoutMs: 12_000, maxGitTimeoutMs: 24_000 },
    }),
  );
  const first = await night(fx, null, env);
  assert.equal(first.code, 1, first.stderr);
  const saved = JSON.parse(read(file)) as {
    night: { gitTimeoutMs: number };
    language: string;
  };
  assert.equal(saved.night.gitTimeoutMs, 24_000);
  const messages = () =>
    read(sent)
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row) as { text: string });
  const firstMessages = messages();
  writeFileSync(file, JSON.stringify({ ...saved, language: "en" }));
  const second = await night(fx, null, {
    ...env,
    IVA_TEST_NOW: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
  });
  assert.equal(second.code, 1, second.stderr);
  const all = messages();
  const calls = read(trace)
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row) as { args: string[]; timeout: number });
  t.diagnostic(
    JSON.stringify({
      firstMessages,
      totalMessages: all.length,
      timeouts: calls.map((row) => row.timeout),
    }),
  );
  assert.equal(firstMessages.length, 1, JSON.stringify(firstMessages));
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.match(all[0].text, /предел ожидания git = 24000/u);
  assert.match(all[0].text, /iva night set maxGitTimeoutMs/u);
  assert.deepEqual(
    calls.map((row) => row.timeout),
    [12_000, 24_000, 24_000],
  );
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(fx.model.prompts.length, 0);
});
