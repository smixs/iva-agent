/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and injected service doubles preserve asynchronous boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import service, {
  commandSpec,
  type ExecFileImplementation,
  type MenuServiceContext,
  type MenuServiceState,
  type MenuServiceView,
} from "./service.ts";
import root from "./root.ts";
import {
  LOADERS,
  cancelRun,
  currentRun,
  resetForTests,
  startProcess,
  type RunOptions,
} from "./svc-run.ts";
import { acquireUpdateLock } from "../version-store.ts";
import { createFlows } from "../tg-flow.ts";
import { tempDir } from "../../fixtures/temp-dir.ts";

const { SCREENS } = (await import("./index.ts")) as {
  SCREENS: Record<string, unknown>;
};
// The bridge's own Bot API call, where the outbound Gate stands: the screens below are
// driven through it exactly as they are in production.
const { tg: bridgeTg } = (await import("../../poller/transport.ts")) as {
  tg: (method: string, body: unknown) => Promise<unknown>;
};

type TestState = MenuServiceState & {
  flow: "menu";
  page: number;
  awaitText: null;
  data: Record<string, unknown>;
  _last?: MenuServiceView;
};
type TelegramBody = Record<string, unknown> & {
  text?: string;
  rich_message?: { markdown?: string };
};
type Harness = {
  ctx: MenuServiceContext;
  rendered: MenuServiceView[];
  st: TestState | null;
};
type TestDeps = Partial<MenuServiceContext["deps"]>;

// Кнопка — тег в markdown: порядок тегов и есть прежний порядок кнопок.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

// Стенд как в menu-screens.test.ts: экран отдаёт готовый markdown движку (flows.screen),
// а движок в тестах — накопитель рендеров.
function makeCtx({
  lang = "ru",
  deps = {},
}: { lang?: string; deps?: TestDeps } = {}): Harness {
  const rendered: MenuServiceView[] = [];
  let state: TestState | null = null;
  const flows = {
    screen: async (st: MenuServiceState, text: string) => {
      const testState = st as TestState;
      testState.msgId ??= 1;
      testState._last = { text };
      rendered.push({ text });
    },
    get: () => state,
    touch: () => {},
  };
  const ctx: MenuServiceContext = {
    deps: { root: "", envPath: "", dataDir: "", ...deps },
    flows,
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
    show: async (st: MenuServiceState, sid: string) => {
      st.screen = sid;
      const v = await service.render(st, ctx);
      await flows.screen(st, v.text);
    },
  };
  return {
    ctx,
    rendered,
    get st() {
      return state;
    },
    set st(next: TestState | null) {
      state = next;
    },
  };
}

const newState = (over: Partial<TestState> = {}): TestState => ({
  flow: "menu",
  chatId: 10,
  userId: "20",
  screen: "svc",
  page: 0,
  awaitText: null,
  data: {},
  msgId: 1,
  ...over,
});

const waitFor = async (fn: () => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
};

const fastRun = {
  tickMs: 15,
  timeoutMs: 5000,
  pollMs: 5,
} satisfies Partial<RunOptions>;

test("svc зарегистрирован в движке, root ведёт на него, Закрыть в конце", () => {
  assert.equal(SCREENS.svc, service);
  const view = root.render(newState({ screen: "r" }), makeCtx().ctx);
  const buttons = buttonsOf(view.text);
  assert.ok(buttons.some(([, data]) => data === "iva_menu:svc:o"));
  const close = buttons.filter(([, data]) => data === "iva_menu:r:x");
  assert.equal(close.length, 1);
  assert.deepEqual(buttons.at(-1), ["✖ Закрыть", "iva_menu:r:x"]);
});

test("render idle: четыре команды и Назад, ru/en", async () => {
  resetForTests();
  for (const lang of ["ru", "en"]) {
    const h = makeCtx({ lang });
    const st = newState();
    h.st = st;
    const view = await service.render(st, h.ctx);
    const data = buttonsOf(view.text).map(([, callback]) => callback);
    for (const cb of [
      "iva_menu:svc:c:doc",
      "iva_menu:svc:c:cln",
      "iva_menu:svc:c:mem",
      "iva_menu:svc:up",
    ])
      assert.ok(data.includes(cb), `${lang}: ${cb}`);
    assert.match(view.text, lang === "ru" ? /Обслуживание/ : /Maintenance/);
  }
});

test("render snapshots the current run before returning its promise", async (t) => {
  resetForTests();
  t.after(() => {
    cancelRun();
    resetForTests();
  });
  const h = makeCtx({ lang: "en" });
  const st = newState();
  h.st = st;

  const pendingView = service.render(st, h.ctx);
  const run = startProcess(
    "doc",
    { argv: [process.execPath, "-e", "setTimeout(() => {}, 2000)"] },
    {
      edit: () => Promise.resolve(),
      chatId: st.chatId,
      messageId: st.msgId,
      progressView: () => ({ text: "running" }),
      ...fastRun,
    },
  );
  assert.ok(run);

  const view = await pendingView;
  assert.match(view.text, /Maintenance/);
  assert.doesNotMatch(view.text, /running/);
});

test("подтверждение: c:<cmd> рисует описание и ▶ go:<cmd>", async () => {
  resetForTests();
  const h = makeCtx();
  const st = newState();
  h.st = st;
  for (const cmd of ["doc", "cln", "mem"]) {
    await service.on("c", [cmd], st, h.ctx);
    assert.ok(st._last);
    const data = buttonsOf(st._last.text).map(([, callback]) => callback);
    assert.ok(data.includes(`iva_menu:svc:go:${cmd}`));
    assert.ok(data.includes("iva_menu:svc:o")); // Назад к списку
  }
});

test("up: хендофф в deps.handleUpdateCheck с chatId", async () => {
  resetForTests();
  let called: string | number | null = null;
  const h = makeCtx({
    deps: {
      handleUpdateCheck: (chatId) => {
        called = chatId;
      },
    },
  });
  const st = newState();
  h.st = st;
  await service.on("up", [], st, h.ctx);
  assert.equal(called, 10);
});

test("cln: TypeScript cleaner берётся из репо, cwd — vault", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = tempDir("iva-data-");
  const h = makeCtx({
    deps: { root: repoRoot, envPath: join(dataDir, ".env") },
  });
  const spec = await commandSpec("cln", h.ctx);
  assert.equal(spec.kind, "proc");
  assert.deepEqual(spec.argv.slice(0, 2), [
    process.execPath,
    join(repoRoot, "scripts/vault-cleanup.ts"),
  ]);
  assert.ok(existsSync(spec.argv[1]), `нет скрипта: ${spec.argv[1]}`);
  assert.deepEqual(spec.argv.slice(2), [".", "--apply"]);
  assert.equal(spec.argv.length, 4);
  assert.equal(spec.cwd, join(repoRoot, "vault"));
});

test("doc: doctor receives the menu's canonical data directory", async () => {
  const dataDir = tempDir("iva-data-");
  const h = makeCtx({ deps: { dataDir, root: "/iva", envPath: "/iva/.env" } });
  const spec = await commandSpec("doc", h.ctx);
  assert.equal(spec.kind, "proc");
  assert.equal(spec.env?.ASSISTANT_DATA_DIR, dataDir);
});

test("go:doc: прогресс с 🔄, финал ✅ с кнопкой Назад", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/nonexistent",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({
        kind: "proc",
        argv: [process.execPath, "-e", "console.log('шаг ок')"],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "done");
  await waitFor(() => h.rendered.some((v) => /✅/.test(v.text)));
  assert.ok(h.rendered.some((v) => v.text.startsWith(LOADERS.doc.alt)));
  const final = h.rendered.filter((v) => /✅/.test(v.text)).at(-1);
  assert.ok(final);
  assert.match(final.text, /Диагностика пройдена/);
  assert.ok(
    buttonsOf(final.text).some(([, data]) => data === "iva_menu:svc:o"),
  );
});

test("go:cln: сводка парсит финальную строку cleanup", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/nonexistent",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      // Строка дословно как её печатает scripts/vault-cleanup.ts.
      svcSpec: () => ({
        kind: "proc",
        argv: [
          process.execPath,
          "-e",
          "console.log('cleanup (applied): 3 file(s), 224,000,000 bytes of bug garbage')",
        ],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["cln"], st, h.ctx);
  await waitFor(() =>
    h.rendered.some((v) => /Чистка/.test(v.text) && /✅/.test(v.text)),
  );
  const final = h.rendered.filter((v) => /✅/.test(v.text)).at(-1);
  assert.ok(final);
  assert.match(final.text, /3 файл/);
  assert.match(final.text, /224(\.0)? МБ/);
});

// Чистка идёт процессом, пока мост свободен: правки владельца в Obsidian ложатся в vault
// рядом с её работой, и без пары коммитов они уехали бы в ночной `add -A` неотличимо от
// результата чистки. Шов тот же, что у обновлятора: снимок «до» и результат после.
test("go:cln: чистка оставляет в vault пару коммитов — снимок до и результат", async (t) => {
  resetForTests();
  t.after(() => {
    cancelRun();
    resetForTests();
  });
  const vault = tempDir("iva-vault-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: vault,
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "vault@example.com");
  git("config", "user.name", "Vault");
  writeFileSync(join(vault, "CORE.md"), "# CORE\n");
  git("add", "-A");
  git("commit", "-q", "-m", "vault");
  // Правка владельца в Obsidian, ещё не в истории: она уезжает в снимок «до».
  writeFileSync(join(vault, "CORE.md"), "# CORE\n\nправка владельца\n");

  const dataDir = tempDir("iva-data-");
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/nonexistent",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      // Чистка — чужой процесс: правит vault мимо инструментов памяти. cwd процесса и есть
      // vault, поэтому коммиты ложатся в него.
      svcSpec: () => ({
        kind: "proc",
        cwd: vault,
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('карточка.md', '# Починено\\n')",
        ],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["cln"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "done");
  await waitFor(() => git("log", "--pretty=%s").split("\n").length >= 3);
  assert.deepEqual(git("log", "--pretty=%s").split("\n").slice(0, 2), [
    "menu: vault cleanup",
    "menu: vault snapshot",
  ]);
  // Снимок «до» держит правку владельца, второй коммит - результат чистки.
  assert.match(git("show", "--name-only", "--pretty=", "HEAD~1"), /CORE\.md/u);
  assert.match(
    git("show", "--name-only", "--pretty=", "HEAD"),
    /карточка\.md/u,
  );
  assert.equal(git("status", "--porcelain"), "");
});

test("go:mem: юнит через systemctl, финал «Цикл памяти пройден»", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const active = ["activating", "inactive"];
  const execFileImpl: ExecFileImplementation = (
    cmd,
    args,
    _options,
    callback,
  ) => {
    const a = args.join(" ");
    if (a.includes("start")) return callback(null, "", "");
    if (a.includes("is-active"))
      return callback(null, active.shift() ?? "inactive", "");
    if (cmd === "journalctl") return callback(null, "done\n", "");
    return callback(null, "", "");
  };
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: { ...fastRun, execFileImpl },
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["mem"], st, h.ctx);
  await waitFor(() =>
    h.rendered.some((v) => /Цикл памяти пройден/.test(v.text)),
  );
});

test("busy-гейт: второй go при running — экран «Уже идёт», без второго процесса", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({
        kind: "proc",
        argv: [process.execPath, "-e", "setTimeout(()=>{}, 2000)"],
      }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  await waitFor(() => currentRun()?.status === "running");
  const first = currentRun();
  await service.on("go", ["cln"], st, h.ctx);
  assert.equal(currentRun(), first); // новый не стартовал
  assert.ok(st._last);
  assert.match(st._last.text, /Уже идёт|идёт/i);
  // отмена через ab
  await service.on("ab", [], st, h.ctx);
  await waitFor(() => currentRun()?.status === "cancelled");
  await waitFor(() => h.rendered.some((v) => /Прервано/.test(v.text)));
});

test("update-lock: занят — go:doc не стартует, текст про обновление", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const lock = acquireUpdateLock(dataDir);
  assert.ok(lock);
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "0"] }),
    },
  });
  const st = newState();
  h.st = st;
  await service.on("go", ["doc"], st, h.ctx);
  assert.equal(currentRun(), null);
  assert.ok(st._last);
  assert.match(st._last.text, /обновлени/i);
  lock.release();
});

// Обратная сторона того же гейта: обновление, убитое вместе с процессом, оставляет
// каталог лока навсегда, и меню, которое смотрит на существование каталога, после
// одного такого падения молчит про обновление до конца жизни установки.
test("update-lock: владелец лока мёртв — go:doc стартует", async () => {
  resetForTests();
  const dataDir = tempDir("iva-data-");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.ok(dead);
  mkdirSync(join(dataDir, "update.lock"), { recursive: true });
  writeFileSync(
    join(dataDir, "update.lock/owner.json"),
    JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }),
  );
  const h = makeCtx({
    deps: {
      dataDir,
      root: "/x",
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      svcSpec: () => ({ kind: "proc", argv: [process.execPath, "-e", "0"] }),
    },
  });
  const st = newState();
  h.st = st;

  await service.on("go", ["doc"], st, h.ctx);

  assert.notEqual(currentRun(), null);
  assert.ok(st._last);
  assert.doesNotMatch(st._last.text, /обновлени/i);
});

const PLANTED = `api_key=${"z".repeat(24)}`;
// Ключ OpenRouter в том виде, в каком его выдаёт провайдер: форма настоящая, значение нет.
const OPENROUTER_KEY = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;
const leaks = (cmd: string, secret = PLANTED) => ({
  kind: "proc" as const,
  argv: [process.execPath, "-e", `console.log("boom ${secret}"); ${cmd}`],
});

// Производственная проводка: экран разговаривает с Telegram мостовым tg(), на котором
// стоит гейт. Ни одна вьюха — тикер, сводка, «Уже идёт», перерисовка — про гейт не знает,
// и это ровно то свойство, которое здесь проверяется (правило: agent/lib/outbox.ts).
function gatedStand(
  t: { after: (fn: () => void) => void },
  deps: TestDeps,
): { ctx: MenuServiceContext; st: MenuServiceState; sent: string[] } {
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as TelegramBody;
    sent.push(body.rich_message?.markdown ?? body.text ?? "");
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }) as unknown as typeof fetch;
  console.error = () => {}; // «[security] outbound leak redacted» на каждый тик
  t.after(() => {
    cancelRun();
    resetForTests();
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });
  const dataDir = tempDir("iva-data-");
  const flows = createFlows({ tg: bridgeTg as never });
  const st = flows.start(10, "20", "menu", {
    screen: "svc",
    msgId: 1,
  }) as unknown as MenuServiceState;
  const ctx: MenuServiceContext = {
    deps: {
      root: "/x",
      dataDir,
      envPath: join(dataDir, ".env"),
      svcRun: fastRun,
      ...deps,
    },
    flows: flows as unknown as MenuServiceContext["flows"],
    tr: (_en: string, ru: string) => ru,
    show: async (state: MenuServiceState, sid: string) => {
      state.screen = sid;
      const v = await service.render(state, ctx);
      await ctx.flows.screen(state, v.text);
    },
  };
  return { ctx, st, sent };
}

const gatedFind = (sent: string[], re: RegExp): string => {
  const found = sent.filter((text) => re.test(text)).at(-1);
  assert.ok(found, `нет экрана ${re.source} среди: ${sent.join(" | ")}`);
  assert.ok(
    sent.every((text) => !/zzzz/u.test(text)),
    "секрет дошёл до Bot API",
  );
  return found;
};

test("финальная сводка: вывод упавшей команды уходит отредактированным", async (t) => {
  resetForTests();
  const { ctx, st, sent } = gatedStand(t, {
    svcSpec: () => leaks("process.exit(1)"),
  });

  await service.on("go", ["doc"], st, ctx);
  await waitFor(() => sent.some((text) => /Есть проблемы/u.test(text)));

  assert.match(gatedFind(sent, /Есть проблемы/u), /boom \[REDACTED\]/u);
});

// Планты выше удобны гейту; здесь — форма, которую действительно печатает упавшая
// проверка провайдера в выводе обслуживания.
test("вывод с ключом живого формата тоже не доезжает до Bot API", async (t) => {
  resetForTests();
  const { ctx, st, sent } = gatedStand(t, {
    svcSpec: () => leaks("process.exit(1)", OPENROUTER_KEY),
  });

  await service.on("go", ["doc"], st, ctx);
  await waitFor(() => sent.some((text) => /Есть проблемы/u.test(text)));

  assert.ok(
    sent.every((text) => !/sk-or-v1|4f9c1e77/u.test(text)),
    "ключ дошёл до Bot API",
  );
  assert.match(gatedFind(sent, /Есть проблемы/u), /boom \[REDACTED\]/u);
});

test("тикер и экран «Уже идёт»: та же строка вывода, тот же гейт", async (t) => {
  resetForTests();
  const { ctx, st, sent } = gatedStand(t, {
    svcSpec: () => leaks("setTimeout(() => {}, 60000)"),
  });

  await service.on("go", ["doc"], st, ctx);
  await waitFor(() => sent.some((text) => /boom/u.test(text)));
  assert.match(gatedFind(sent, /boom/u), /boom \[REDACTED\]/u);

  await service.on("go", ["cln"], st, ctx); // занято — вьюха прогресса под шапкой
  assert.match(gatedFind(sent, /Уже идёт/u), /boom \[REDACTED\]/u);
});

test("перерисовка после ухода с экрана и возврата тоже проходит гейт", async (t) => {
  resetForTests();
  const { ctx, st, sent } = gatedStand(t, {
    svcSpec: () => leaks("setTimeout(() => {}, 60000)"),
  });

  await service.on("go", ["doc"], st, ctx);
  await waitFor(() => currentRun()?.lastLine.includes("boom") === true);
  st.screen = "r"; // ушёл в корень: тикер за сообщение больше не дерётся
  sent.length = 0;

  await ctx.show(st, "svc");

  assert.match(gatedFind(sent, /Доктор/u), /boom \[REDACTED\]/u);
});
