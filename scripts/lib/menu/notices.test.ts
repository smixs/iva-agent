/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { classicScreen } from "../telegram-buttons.ts";

// settings.ts берёт каталог данных из окружения на импорте — задаём ДО загрузки экрана,
// чтобы тумблер не тронул настоящий data/ (тот же приём, что в lang.test.ts).
const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-notices-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.ASSISTANT_TIMEZONE = "UTC";

const loaded: unknown = await import(
  new URL("./notices.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("notices menu has no default screen");
const screen = loaded.default as Screen;

after(() => rmSync(dataDir, { recursive: true, force: true }));

type View = { text: string };
type MenuState = { page: number };
type MenuContext = {
  deps: { dataDir: string };
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screenId: string) => Promise<void>;
};
type Screen = {
  parent: string;
  render: (state: MenuState, context: MenuContext) => View;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
};

const settingsPath = join(dataDir, "settings.json");

function writeSettingsFile(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings));
}

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
}

function makeContext(lang: string, redrawn: string[] = []): MenuContext {
  return {
    deps: { dataDir },
    tr: (english, russian) => (lang === "ru" ? russian : english),
    show: (_state, screenId) => {
      redrawn.push(screenId);
      return Promise.resolve();
    },
  };
}

// Кнопка — тег в markdown: подпись и data достаём из строки.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

const labels = (view: View) => buttonsOf(view.text);

test("proactive skills read current times and menu keeps time constants in proactive-config", () => {
  const skill = (name: string) =>
    readFileSync(`agent/skills/${name}/SKILL.md`, "utf8");
  for (const name of ["brief", "watch", "insight"])
    assert.match(skill(name), /iva proactive show/u);
  assert.doesNotMatch(skill("brief").split("\n")[2], /\d{2}:\d{2}/u);
  assert.doesNotMatch(skill("watch").split("## Settings")[1], /\d{2}:\d{2}/u);
  assert.doesNotMatch(
    readFileSync("scripts/lib/menu/notices.ts", "utf8"),
    /["'`]\d{2}:\d{2}["'`]/u,
  );
});

test("reports render off and Watch on on a fresh installation, in either language", () => {
  rmSync(settingsPath, { force: true });

  const russian = screen.render({ page: 3 }, makeContext("ru"));
  assert.match(russian.text, /🔔 Уведомления/);
  assert.match(
    russian.text,
    /Алерты — о проблемах и обновлениях — приходят всегда/,
  );
  assert.deepEqual(labels(russian), [
    ["○ Отчёты памяти", "iva_menu:ntc:set:rep:1"],
    ["✓ Сама пишет", "iva_menu:ntc:set:pro:0"],
    ["○ Инсайт", "iva_menu:ntc:ins:1130"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.match(
    russian.text,
    /Присмотр за пропущенным, обзор дня и инсайт\. О сбоях пишу всегда\./,
  );
  assert.match(russian.text, /раз в день: черновик плагина/u);
  assert.doesNotMatch(russian.text, /Время инсайта|Инсайт: каждый/u);
  // Строка дайджеста ушла: её место — времена Brief из настроек.
  assert.match(russian.text, /Обзор дня: 08:30 и 14:00/u);
  assert.doesNotMatch(russian.text, /дайджест/iu);

  const english = screen.render({ page: 0 }, makeContext("en"));
  assert.match(english.text, /🔔 Notices/);
  assert.match(english.text, /Alerts — problems and updates — always arrive/);
  assert.deepEqual(labels(english), [
    ["○ Memory reports", "iva_menu:ntc:set:rep:1"],
    ["✓ Writes on her own", "iva_menu:ntc:set:pro:0"],
    ["○ Insight", "iva_menu:ntc:ins:1130"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);
  assert.match(
    english.text,
    /Watch for missed items, the daily brief and Insight\. Failures are always reported\./,
  );
  assert.match(english.text, /once a day: a plugin draft/u);
  assert.match(english.text, /Daily brief: 08:30 and 14:00/u);
  assert.doesNotMatch(english.text, /digest/iu);
  assert.equal(screen.parent, "r");
});

test("a switched-on toggle is ticked and offers the way back off", () => {
  writeSettingsFile({
    memoryReports: { enabled: true },
    // Не больше двух Brief в сутки: три времени — уже значение по умолчанию.
    proactive: { enabled: false, briefTimes: ["09:00", "18:00"] },
  });

  const view = screen.render({ page: 0 }, makeContext("ru"));
  assert.deepEqual(labels(view), [
    ["✓ Отчёты памяти", "iva_menu:ntc:set:rep:0"],
    ["○ Сама пишет", "iva_menu:ntc:set:pro:1"],
    ["○ Инсайт", "iva_menu:ntc:ins:1130"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.match(view.text, /Обзор дня: 09:00 и 18:00/u);
});

test("a tap on the old digest toggle from a stale screen changes nothing", async () => {
  writeSettingsFile({ language: "en" });
  const redrawn: string[] = [];
  await screen.on("set", ["dig", "1"], { page: 0 }, makeContext("ru", redrawn));
  assert.deepEqual(readSettingsFile(), { language: "en" });
  assert.deepEqual(redrawn, []);
});

test("a toggle writes its own key and leaves the neighbours alone", async () => {
  // Соседи двух видов: чужой ключ верхнего уровня (язык, второй тумблер) и сосед ВНУТРИ
  // того же объекта. Второго сегодня в коде нет — и потому он здесь: тумблер обязан патчить
  // вложенный объект целиком, а не переписывать его одним своим полем.
  writeSettingsFile({
    language: "en",
    memoryReports: { enabled: false, chatId: "123" },
  });
  const redrawn: string[] = [];
  const context = makeContext("ru", redrawn);

  await screen.on("set", ["rep", "1"], { page: 4 }, context);

  assert.deepEqual(readSettingsFile(), {
    language: "en",
    memoryReports: { enabled: true, chatId: "123" },
  });
  assert.deepEqual(redrawn, ["ntc"], "the screen redraws itself, not the root");
});

test("«Сама пишет» writes proactive.enabled and keeps the Watch settings beside it", async () => {
  writeSettingsFile({
    language: "en",
    proactive: { watchCapPerDay: 3, urgentSenders: ["wife"] },
  });
  await screen.on("set", ["pro", "0"], { page: 0 }, makeContext("ru"));
  assert.deepEqual(readSettingsFile(), {
    language: "en",
    proactive: { watchCapPerDay: 3, urgentSenders: ["wife"], enabled: false },
  });
  await screen.on("set", ["pro", "1"], { page: 0 }, makeContext("ru"));
  assert.equal(
    (readSettingsFile().proactive as { enabled?: unknown }).enabled,
    true,
  );
});

test("a stale tap sets the value it carries instead of flipping twice", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const context = makeContext("ru");

  await screen.on("set", ["rep", "1"], { page: 0 }, context);
  await screen.on("set", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), { memoryReports: { enabled: true } });
});

test("junk callback arguments change nothing and throw nothing", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const before = readSettingsFile();
  const redrawn: string[] = [];
  const context = makeContext("en", redrawn);

  for (const args of [
    [],
    [""],
    ["rep"],
    ["rep", ""],
    ["rep", "true"],
    ["rep", "yes", "please"],
    ["REP", "1"],
    ["dig", "2"],
    ["toString", "1"],
    ["constructor", "1"],
    ["__proto__", "1"],
    ["hasOwnProperty", "0"],
  ])
    await screen.on("set", args, { page: 0 }, context);
  // Неизвестный верб тоже ничего не делает.
  await screen.on("rf", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), before);
  assert.deepEqual(redrawn, [], "a junk tap redraws nothing");
});

test("corrupt settings render safely but a toggle refuses to replace their bytes", async () => {
  for (const corrupt of ["", "{ not json", "null", "[]", '"ru"', "42"]) {
    writeFileSync(settingsPath, corrupt);
    const view = screen.render({ page: 0 }, makeContext("en"));
    assert.deepEqual(labels(view)[0], [
      "○ Memory reports",
      "iva_menu:ntc:set:rep:1",
    ]);
    await assert.rejects(
      screen.on("set", ["rep", "1"], { page: 0 }, makeContext("en")),
      (error: unknown) =>
        (error as { code?: unknown; state?: unknown }).code ===
          "ESETTINGS_WRITE_REFUSED" &&
        (error as { state?: unknown }).state === "corrupt",
    );
    assert.equal(readFileSync(settingsPath, "utf8"), corrupt);
  }
});

// ── Insight (ADR-0022): тумблер, время, строка статуса ──

const proactivePath = join(dataDir, "proactive.json");

function writeProactiveFile(insight?: Record<string, unknown>): void {
  writeFileSync(
    proactivePath,
    JSON.stringify({
      schemaVersion: 1,
      seen: {},
      wakes: { day: "", count: 0 },
      modelWakes: { day: "", count: 0 },
      briefDone: { day: "", slots: [] },
      failuresSeenUpToMs: 0,
      ...(insight === undefined ? {} : { insight }),
    }),
  );
}

test("a switched-on Insight is ticked, offers its times and says when it comes", () => {
  rmSync(proactivePath, { force: true });
  writeSettingsFile({ proactive: { insightTimes: ["11:30"] } });

  const view = screen.render({ page: 0 }, makeContext("ru"));
  assert.deepEqual(labels(view).slice(2), [
    ["✓ Инсайт", "iva_menu:ntc:ins:0"],
    ["09:30", "iva_menu:ntc:ins:0930"],
    ["11:30 ✓", "iva_menu:ntc:ins:1130"],
    ["17:30", "iva_menu:ntc:ins:1730"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.match(view.text, /Время инсайта:/u);
  assert.match(view.text, /Инсайт: каждый день в 11:30/u);
  assert.doesNotMatch(view.text, /не придёт|Последний инсайт/u);

  const english = screen.render({ page: 0 }, makeContext("en"));
  assert.match(english.text, /Insight time:/u);
  assert.match(english.text, /Insight: every day at 11:30/u);
});

test("Insight while «Writes on her own» is off says it stays silent", () => {
  rmSync(proactivePath, { force: true });
  writeSettingsFile({ proactive: { enabled: false, insightTimes: ["17:30"] } });

  const view = screen.render({ page: 0 }, makeContext("ru"));
  assert.match(view.text, /Инсайт не придёт, пока выключено «Сама пишет»\./u);
  assert.doesNotMatch(view.text, /каждый день в/u);
});

test("a time set by command outside the row gets no tick but shows in the status", () => {
  rmSync(proactivePath, { force: true });
  writeSettingsFile({ proactive: { insightTimes: ["19:30"] } });

  const view = screen.render({ page: 0 }, makeContext("ru"));
  assert.ok(
    !labels(view).some(([label]) => label.includes("✓ ") && /\d/.test(label)),
  );
  assert.match(view.text, /Инсайт: каждый день в 19:30/u);
});

test("the Insight state file: last insight, a file of the paused version, missing, unreadable", (t) => {
  writeSettingsFile({ proactive: { insightTimes: ["11:30"] } });
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...parts: unknown[]) => errors.push(parts));
  const render = (lang = "ru") =>
    screen.render({ page: 0 }, makeContext(lang)).text;

  writeProactiveFile({ day: "2026-10-05", draft: "relay" });
  let text = render();
  assert.match(text, /Последний инсайт: 2026-10-05\./u);
  assert.match(text, /Инсайт: каждый день в 11:30/u);
  assert.match(render("en"), /Last insight: 2026-10-05\./u);

  // Файл версии с недельной паузой: поля читаются и ничего не значат — время обещано, паузы нет.
  writeProactiveFile({
    day: "2026-10-05",
    draft: "relay",
    misses: 2,
    pausedUntilMs: Date.parse("2099-01-02T03:04:00.000Z"),
  });
  text = render();
  assert.match(text, /Инсайт: каждый день в 11:30/u);
  assert.doesNotMatch(text, /пауз|⚠️/u);
  assert.doesNotMatch(render("en"), /paused/u);

  writeProactiveFile({ day: "2026-10-05", draft: "" });
  text = render();
  assert.doesNotMatch(text, /Последний инсайт/u, "QUIET has no last insight");
  assert.match(text, /каждый день в 11:30/u);

  rmSync(proactivePath, { force: true });
  text = render();
  assert.doesNotMatch(text, /⚠️|Последний/u);

  assert.equal(errors.length, 0);
  for (const broken of [
    "{ not json",
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({
      schemaVersion: 1,
      seen: {},
      wakes: { day: "", count: 0 },
      modelWakes: { day: "", count: 0 },
      briefDone: { day: "", slots: [] },
      failuresSeenUpToMs: 0,
      insight: { day: 5 },
    }),
  ]) {
    writeFileSync(proactivePath, broken);
    text = render();
    assert.match(
      text,
      /⚠️ data\/proactive\.json не читается: присмотра, обзора и инсайта не будет, пока файл не починят\./u,
      broken,
    );
    assert.doesNotMatch(text, /каждый день в/u, broken);
    assert.match(
      render("en"),
      /⚠️ data\/proactive\.json is unreadable: no Watch, Brief or Insight until it is fixed\./u,
    );
  }
  assert.ok(errors.length >= 3, "the reason goes to the journal");
  rmSync(proactivePath, { force: true });
});

test("Insight taps write proactive.insightTimes and keep every neighbour", async () => {
  writeSettingsFile({
    language: "en",
    proactive: { watchCapPerDay: 3, enabled: false, urgentSenders: ["wife"] },
  });
  const redrawn: string[] = [];
  const context = makeContext("ru", redrawn);

  await screen.on("ins", ["0930"], { page: 0 }, context);
  assert.deepEqual(readSettingsFile(), {
    language: "en",
    proactive: {
      watchCapPerDay: 3,
      enabled: false,
      urgentSenders: ["wife"],
      insightTimes: ["09:30"],
    },
  });
  await screen.on("ins", ["1730"], { page: 0 }, context);
  await screen.on("ins", ["1730"], { page: 0 }, context);
  assert.deepEqual(
    (readSettingsFile().proactive as { insightTimes: unknown }).insightTimes,
    ["17:30"],
  );
  await screen.on("ins", ["0"], { page: 0 }, context);
  assert.deepEqual(readSettingsFile(), {
    language: "en",
    proactive: {
      watchCapPerDay: 3,
      enabled: false,
      urgentSenders: ["wife"],
      insightTimes: [],
    },
  });
  assert.deepEqual(redrawn, ["ntc", "ntc", "ntc", "ntc"]);
});

test("an Insight tap on corrupt settings refuses to replace their bytes", async () => {
  for (const corrupt of ["{ not json", "[]"]) {
    writeFileSync(settingsPath, corrupt);
    const redrawn: string[] = [];
    await assert.rejects(
      screen.on("ins", ["1130"], { page: 0 }, makeContext("en", redrawn)),
      (error: unknown) =>
        (error as { code?: unknown }).code === "ESETTINGS_WRITE_REFUSED",
    );
    assert.equal(readFileSync(settingsPath, "utf8"), corrupt);
    assert.deepEqual(redrawn, []);
  }
});

// Мусор в аргументах: ничего не пишется, экран не перерисовывается. Seed печатает fast-check.
test("property: junk Insight arguments write nothing and redraw nothing", async () => {
  const junk = fc
    .array(
      fc.oneof(
        fc.constantFrom(
          "",
          "11:30",
          "1130:x",
          "__proto__",
          "constructor",
          "toString",
          "hasOwnProperty",
          "00",
          "1",
          "9:30",
          "0930 ",
        ),
        fc.integer().map(String),
        fc.string({ maxLength: 70 }),
        fc.string({ unit: "grapheme", maxLength: 20 }),
      ),
      { maxLength: 3 },
    )
    .filter(
      (args) =>
        !(args.length === 1 && ["0", "0930", "1130", "1730"].includes(args[0])),
    );
  writeSettingsFile({ language: "en", proactive: { insightTimes: ["11:30"] } });
  const before = readFileSync(settingsPath, "utf8");
  await fc.assert(
    fc.asyncProperty(junk, async (args) => {
      const redrawn: string[] = [];
      await screen.on("ins", args, { page: 0 }, makeContext("en", redrawn));
      assert.equal(readFileSync(settingsPath, "utf8"), before);
      assert.deepEqual(redrawn, []);
    }),
    { numRuns: 300 },
  );
});

test("classic menu: [reports, writes], [Insight], the times row, [‹ Menu]; every data fits 64 bytes", () => {
  rmSync(proactivePath, { force: true });
  for (const [times, rows] of [
    [[], [["○ Отчёты памяти", "✓ Сама пишет"], ["○ Инсайт"], ["‹ Меню"]]],
    [
      ["11:30"],
      [
        ["○ Отчёты памяти", "✓ Сама пишет"],
        ["✓ Инсайт"],
        ["09:30", "11:30 ✓", "17:30"],
        ["‹ Меню"],
      ],
    ],
  ] as const) {
    writeSettingsFile({ proactive: { insightTimes: times } });
    const view = screen.render({ page: 0 }, makeContext("ru"));
    const keyboard =
      classicScreen(view.text).reply_markup?.inline_keyboard ?? [];
    assert.deepEqual(
      keyboard.map((row) => row.map((b) => b.text)),
      rows,
    );
    for (const [, data] of labels(view))
      assert.ok(Buffer.byteLength(data) <= 64, data);
  }
});

test("settings drive CLI, menu and tick despite legacy state times (seed 20261019)", async (t) => {
  const { parseProactive } = await import("#lib/proactive-config.ts");
  const { createProactiveCommand } = await import("../../cli/proactive.ts");
  const { initialState } = await import("../../proactive/state.ts");
  const { runProactiveTick } = await import("../../proactive/tick.ts");
  const out: string[] = [];
  t.mock.method(console, "log", (line: string) => out.push(line));
  const cmd = createProactiveCommand({
    ok: () => {},
    dataDirAbs: () => dataDir,
    readEnv: () => ({ ASSISTANT_TIMEZONE: "UTC" }),
  });
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("brief", "insight"),
      fc.integer({ min: 8, max: 20 }),
      fc.constantFrom(0, 30),
      fc.jsonValue(),
      async (kind, hour, minute, legacy) => {
        const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        const settings = {
          proactive: {
            briefTimes: kind === "brief" ? [time] : [],
            insightTimes: kind === "insight" ? [time] : [],
          },
        };
        writeSettingsFile(settings);
        const now = Date.UTC(2026, 9, 19, hour, minute);
        const state = initialState(now);
        writeFileSync(
          proactivePath,
          JSON.stringify({
            ...state,
            briefTimes: legacy,
            insightTimes: legacy,
          }),
        );
        out.length = 0;
        await cmd(["show"]);
        assert.ok(out.includes(`${kind}Times: ${time}`));
        const text = screen.render({ page: 0 }, makeContext("en")).text;
        assert.ok(
          text.includes(
            `${kind === "brief" ? "Daily brief:" : "Insight: every day at"} ${time}`,
          ),
        );
        const turns: string[] = [];
        assert.equal(
          await runProactiveTick(now, {
            config: () => parseProactive(settings),
            timeZone: "UTC",
            statePath: proactivePath,
            sources: [],
            runTurn: (_prompt, source) => {
              turns.push(source);
              return Promise.resolve({
                status: "completed",
                message: "QUIET",
                feedback: () => Promise.resolve(),
              });
            },
            send: () => Promise.resolve({ ok: true, error: "" }),
            translate: () => Promise.resolve((en) => en),
            log: () => {},
          }),
          0,
        );
        assert.deepEqual(turns, [kind]);
      },
    ),
    { seed: 20261019, numRuns: 50 },
  );
  rmSync(proactivePath, { force: true });
});
