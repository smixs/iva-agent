// Чистая половина ночи: property-тесты с печатью seed (fast-check) и якоря контрактов.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import "../lib/ts-esm-hooks.ts";
const {
  canonicalHash,
  markedDone,
  parseDay,
  parseJson,
  prefixHash,
  quoteBelongsTo,
  stepHash,
  summaryEdited,
  summaryText,
} = await import("./night-input.ts");
const {
  compiledTruthInput,
  disappearedLines,
  logFactKey,
  mergeRelated,
  parseCardSections,
  replaceH2Sections,
  sanitizeField,
  sectionRows,
  truthOf,
  withTruth,
} = await import("../../agent/lib/card-store.ts");
const { parseFrontmatter, renderCardDocument } =
  await import("../../agent/lib/frontmatter.ts");
const { periodChildIds, periodChildren } = await import("./night-periods.ts");
const { buildVaultGraph } = await import("./graph.ts");
const { resolveStopAt } = await import("../lib/rollup-turn.ts");
const { NIGHT_CEILING, PART_SIZE } =
  await import("../../agent/lib/memory-night-constants.ts");

const SEED = 20_260_927;
const CHECKS = { seed: SEED, numRuns: 200, endOnFailure: true } as const;
const line = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter(
    (value) =>
      !/[\n\r]/u.test(value) && value.trim() === value && value.length > 0,
  );
const owner = (text: string) => ({
  id: "e1",
  time: "10:00",
  type: "[text]",
  text,
  origin: "owner" as const,
});

void test(`разбор дня: поддельный заголовок внутри реплики не рождает реплику (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 0, max: 23 }), line), {
        minLength: 1,
        maxLength: 15,
      }),
      (rows) => {
        const raw = rows
          .map(
            ([hour, body]) =>
              `## ${String(hour).padStart(2, "0")}:00 [text]\n${body}\n<!-- ## 10:00 fake -->`,
          )
          .join("\n\n");
        assert.deepEqual(
          parseDay(raw).map((entry) => entry.id),
          rows.map((_, index) => `e${index + 1}`),
        );
      },
    ),
    CHECKS,
  );
});

void test(`отметка ночи не меняет разбор и отпечаток префикса, в том числе с пробелами (ДЕФ-11, seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(line, { minLength: 1, maxLength: 10 }),
      fc.constantFrom("", " ", "  \n"),
      (bodies, tail) => {
        const raw =
          bodies.map((body) => `## 10:00 [text]\n${body}\n`).join("\n") + tail;
        const marked = `${raw}\n<!-- processed: memory-night 2026-09-26 -->\n`;
        const entries = parseDay(raw);
        assert.equal(
          prefixHash(parseDay(marked), entries.length),
          prefixHash(entries, entries.length),
        );
        assert.equal(markedDone(marked), true);
        assert.equal(markedDone(`${marked}\n## 11:00 [text]\nхвост\n`), false);
      },
    ),
    CHECKS,
  );
});

void test("реплики [queued] — владельца, [iva] и пересланное — нет (ДЕФ-10)", () => {
  const origins = parseDay(
    "## 10:00 [queued]\nмоё\n## 10:01 [iva]\nответ\n## 10:02 [text]\n[forwarded from @x]\nчужое\n## 10:03 [text]\nсвоё\n",
  ).map((e) => e.origin);
  assert.deepEqual(origins, ["owner", "iva", "forwarded", "owner"]);
});

void test("legacy queued daily keeps its text, IDs and origin", () => {
  assert.deepEqual(
    parseDay(
      "## 10:00 [queued]\nмоё\n[forwarded]\nчужое\n\n## 10:01 [iva]\nответ\n",
    ),
    [
      {
        id: "e1",
        time: "10:00",
        type: "[queued]",
        text: "моё\n[forwarded]\nчужое",
        origin: "owner",
      },
      { id: "e2", time: "10:01", type: "[iva]", text: "ответ", origin: "iva" },
    ],
  );
});

void test(`канонический hash не зависит от порядка ключей (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue()),
      (record) => {
        assert.equal(
          canonicalHash(record),
          canonicalHash(Object.fromEntries(Object.entries(record).reverse())),
        );
      },
    ),
    CHECKS,
  );
});

void test(`sanitizeField: одна строка без frontmatter, фенсов и заголовков (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 600 }), (value) => {
      const clean = sanitizeField(`---\n# ${value}\n\`\`\``);
      assert.doesNotMatch(clean, /```|^---$|^#\s/mu);
      assert.ok(clean.length <= 500 && !clean.includes("\n"));
    }),
    CHECKS,
  );
});

void test(`цитата владельца переживает ё, тире и кавычки; реплика Ивы не источник (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.constantFrom('"', "«", "»", "„", "“"),
      fc.constantFrom("-", "–", "—"),
      (quote, dash) => {
        const text = `${quote}Ёлка ${dash} дом${quote}`;
        assert.equal(quoteBelongsTo(owner(text), '"елка — дом"'), true);
        assert.equal(
          quoteBelongsTo({ ...owner(text), origin: "iva" }, text),
          false,
        );
        assert.equal(quoteBelongsTo(owner(text), "чего не было"), false);
      },
    ),
    CHECKS,
  );
});

void test(`цитата сверяется без пунктуации: слова и порядок те же; выдумка, перестановка и обрывок слова — нет (real2, seed ${SEED})`, () => {
  const word = fc.stringMatching(/^[а-яa-z0-9]{1,8}$/u);
  const mark = fc.constantFrom(" ", ", ", ". ", " — ", "; ", ": ", "! ", " (");
  fc.assert(
    fc.property(
      fc.array(fc.tuple(word, mark), { minLength: 3, maxLength: 8 }),
      fc.nat(),
      fc.array(mark, { minLength: 8, maxLength: 8 }),
      (parts, cut, other) => {
        const text = parts.map(([w, m]) => `${w}${m}`).join("");
        const words = parts.map(([w]) => w);
        const from = cut % (words.length - 1);
        const taken = words.slice(from, from + 2);
        const quote = taken.map((w, i) => `${w}${other[i]}`).join("");
        assert.equal(quoteBelongsTo(owner(text), quote), true, text);
        const swapped = [...taken].reverse();
        if (
          swapped.join(" ") !== taken.join(" ") &&
          !` ${words.join(" ")} `.includes(` ${swapped.join(" ")} `)
        )
          assert.equal(quoteBelongsTo(owner(text), swapped.join(" ")), false);
      },
    ),
    CHECKS,
  );
  const said = owner(
    "Запустили проект Альфа вместе с Анной, первый клиент — Сбер.",
  );
  assert.equal(
    quoteBelongsTo(said, "Запустили проект Альфа вместе с Анной."),
    true,
  );
  assert.equal(quoteBelongsTo(said, "проект Альфа вместе с Анн"), false);
  const moved = owner("Она переехала в Ташкент, теперь живёт там.");
  assert.equal(quoteBelongsTo(moved, "живёт в Ташкенте"), false);
  assert.equal(quoteBelongsTo(owner("..."), "."), false);
});

void test("отпечаток шага меняется вместе с текстом инструкции (promptVersion, #18)", () => {
  const inputs = [{ id: "e1", text: "день" }];
  const base = stepHash("A", "model", "инструкция v1", inputs);
  assert.equal(stepHash("A", "model", "инструкция v1", inputs), base);
  assert.notEqual(stepHash("A", "model", "инструкция v2", inputs), base);
  assert.notEqual(stepHash("weekly", "model", "инструкция v1", inputs), base);
});

void test(`дедуп Log: факт с другим днём и указателем — тот же (seed ${SEED})`, () => {
  fc.assert(
    fc.property(line, (fact) => {
      assert.equal(
        logFactKey(`- 2026-09-26: ${fact} · [[daily/2026-09-26]] 10:00`),
        logFactKey(`- 2026-09-27: ${fact}`),
      );
    }),
    CHECKS,
  );
});

void test(`правда целиком: остальные разделы байт в байт, исчезнувшее = разница строк (ДЕФ-1, ДЕФ-18, seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(line, { minLength: 1, maxLength: 8 }),
      fc.uniqueArray(line, { maxLength: 8 }),
      (before, after) => {
        const tail = "## Log\n\n- 2026-09-26: факт\n\n## History\n";
        const body = `# Card\n\n${before.join("\n")}\n\n${tail}`;
        const next = withTruth(body, after.join("\n"));
        assert.equal(truthOf(next), after.join("\n"));
        assert.ok(next.endsWith(tail));
        assert.ok(next.startsWith("# Card\n\n"));
        assert.deepEqual(
          disappearedLines(before.join("\n"), after.join("\n")),
          before.filter((row) => !after.includes(row)),
        );
      },
    ),
    CHECKS,
  );
});

const CARD_SEED = 20_260_928;
void test(`Card после случайных fact/truth/merge/night сохраняет структуру и архивы (seed ${CARD_SEED})`, () => {
  const token = fc.stringMatching(/^[a-z0-9]{1,10}$/u);
  const operation = fc.record({
    kind: fc.constantFrom("fact", "truth", "merge", "night"),
    token,
  });
  const frontmatter = fc.constantFrom(
    "",
    "---\n---\n",
    '---\ntype: "note"\ncustom: "keep"\n---\n',
    "\uFEFF---\ndescription: >-\n  folded value\naliases:\n  - one\n---\n",
  );
  fc.assert(
    fc.property(
      frontmatter,
      fc.boolean(),
      fc.integer({ min: 0, max: 3 }),
      fc.array(operation, { minLength: 1, maxLength: 12 }),
      (fm, crlf, blanks, operations) => {
        const gap = Array.from({ length: blanks }, () => "");
        const initial = [
          "# Property Card",
          ...gap,
          "исходная правда",
          "```md",
          "# код, не H1",
          "## код, не H2",
          "```",
          "",
          "## Log",
          "",
          "- log-original",
          "",
          "## Related",
          "",
          "## History",
          "",
          "history-original",
        ].join("\n");
        const eol = crlf ? "\r\n" : "\n";
        let raw = `${fm}${initial}\n`.replace(/\n/gu, eol);
        let parsed = parseFrontmatter(raw);
        for (const [index, step] of operations.entries()) {
          const oldLog = sectionRows(parsed.body, "Log") ?? [];
          const oldHistory = sectionRows(parsed.body, "History") ?? [];
          let body = parsed.body;
          const mark = `${step.kind}-${step.token}-${String(index)}`;
          if (step.kind === "fact") {
            body = replaceH2Sections(body, "Log", [...oldLog, `- ${mark}`]);
          } else if (step.kind === "merge") {
            body = replaceH2Sections(body, "Log", [...oldLog, `- ${mark}`]);
            body = replaceH2Sections(body, "History", [
              ...oldHistory,
              `проза-${mark}`,
            ]);
            body = mergeRelated(body, [`cards/notes/${mark}`]);
          } else {
            const oldTruth = truthOf(body).replace(/\s+/gu, " ").trim();
            body = withTruth(
              body,
              `${mark}\n\n\`\`\`md\n# внутри\n## внутри\n\`\`\`\nхвост`,
            );
            body = replaceH2Sections(body, "History", [
              ...oldHistory,
              `- ${mark}: ${oldTruth}`,
            ]);
          }
          raw = renderCardDocument(parsed, parsed.fields ?? {}, body);
          assert.equal(/(^|[^\r])\n/u.test(raw), !crlf);
          parsed = parseFrontmatter(raw);
          const structure = parseCardSections(parsed.body.split("\n"));
          assert.equal(structure.open, false);
          for (const heading of ["Log", "History", "Related"])
            assert.equal(
              structure.sections.filter(
                (section) =>
                  section.level === 2 && section.key === heading.toLowerCase(),
              ).length,
              1,
            );
          const nextLog = sectionRows(parsed.body, "Log") ?? [];
          const nextHistory = sectionRows(parsed.body, "History") ?? [];
          const preserved = (before: string[], after: string[]) => {
            let at = 0;
            for (const row of after) if (row === before[at]) at++;
            return at === before.length;
          };
          assert.ok(preserved(oldLog, nextLog), JSON.stringify(oldLog));
          assert.ok(
            preserved(oldHistory, nextHistory),
            JSON.stringify(oldHistory),
          );
        }
      },
    ),
    { seed: CARD_SEED, numRuns: 100, endOnFailure: true },
  );
});

void test("мягкий разбор ответа: ограды markdown и текст вокруг JSON", () => {
  assert.deepEqual(parseJson('Вот:\n```json\n{"a":{"b":1}}\n```\nготово'), {
    a: { b: 1 },
  });
  assert.deepEqual(
    parseJson('```json {"a":1} ```\nПояснение: поле `src` — список {id}.'),
    { a: 1 },
  );
  assert.deepEqual(parseJson('{"a":"```"}'), { a: "```" });
  assert.deepEqual(parseJson('```json\n{"a":"```\\ncode\\n```"}\n```'), {
    a: "```\ncode\n```",
  });
  assert.deepEqual(parseJson('Ответ {кратко}:\n```json\n{"a":1}\n```'), {
    a: 1,
  });
  assert.throws(() => parseJson("нет json"), /JSON/u);
});

void test("B сохраняет markdown и архивирует только исчезнувшую строку", () => {
  const tail = `\n\n### Команда\n\n  - вложенный пункт\n\n    npm run build\n${"x".repeat(700)}`;
  const before = `Старое${tail}`;
  const after = `Новое${tail}`;
  assert.equal(compiledTruthInput(after), after);
  assert.deepEqual(disappearedLines(before, after), ["Старое"]);
});

void test("выжимка без body_hash — граница перехода, с несошедшимся — правка владельца", () => {
  const ours = summaryText({ type: "daily-summary" }, "# День\n");
  assert.equal(summaryEdited(ours), false);
  assert.equal(summaryEdited(ours.replace("# День", "# Правка")), true);
  assert.equal(
    summaryEdited('---\ndescription: "старая ночь"\n---\n# День\n'),
    false,
  );
  assert.equal(summaryEdited('---\ndescription: "битая\n---\n# День\n'), true);
});

void test(`месяц: полные недели и дни краёв, без повторов (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2000, max: 2099 }),
      fc.integer({ min: 1, max: 12 }),
      (year, month) => {
        const id = `${year}-${String(month).padStart(2, "0")}`;
        const children = periodChildIds("monthly", id);
        assert.ok(
          children
            .filter((child) => !child.includes("W"))
            .every((day) => day.startsWith(`${id}-`)),
        );
        assert.equal(new Set(children).size, children.length);
      },
    ),
    CHECKS,
  );
});

void test("месяц ждёт неготового ребёнка с транскриптом и собирается без транскрипта краевого дня (ДЕФ-15)", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-period-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const children = periodChildIds("monthly", "2026-08");
  const write = (dir: string, name: string) => {
    mkdirSync(join(vault, dir), { recursive: true });
    writeFileSync(join(vault, dir, `${name}.md`), "x");
  };
  for (const child of children.slice(1))
    write(child.includes("W") ? "weekly" : "summaries/daily", child);
  assert.ok(
    periodChildren(vault, "monthly", "2026-08"),
    "первый краевой день без транскрипта — «нет данных»",
  );
  write("daily", children[0]);
  assert.equal(periodChildren(vault, "monthly", "2026-08"), null);
});

void test("неделя, все дни которой закрыты skip или на паузе, не держит месяц", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-period-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const children = periodChildIds("monthly", "2026-08");
  const week = children.find((child) => child.includes("W"))!;
  const write = (dir: string, name: string, text = "x") => {
    mkdirSync(join(vault, dir), { recursive: true });
    writeFileSync(join(vault, dir, `${name}.md`), text);
  };
  for (const child of children.filter((c) => c !== week))
    write(child.includes("W") ? "weekly" : "summaries/daily", child);
  const days = periodChildIds("weekly", week);
  for (const date of days.slice(1))
    write(
      "daily",
      date,
      "## 10:00 [text]\nx\n\n<!-- processed: skipped by owner -->\n",
    );
  write("daily", days[0], "## 10:00 [text]\nx\n");
  assert.equal(
    periodChildren(vault, "monthly", "2026-08"),
    null,
    "день ждёт ночи",
  );
  const month = periodChildren(vault, "monthly", "2026-08", new Set([days[0]]));
  assert.deepEqual(
    month?.find((child) => child.id === week),
    { id: week },
  );
});

void test("предел и размер части закреплены в одном модуле", () => {
  assert.deepEqual(NIGHT_CEILING, { calls: 40, inputTokens: 300_000 });
  assert.equal(PART_SIZE, 48_000);
});

void test("TS-граф имеет формат, который читает memory_search", (t) => {
  const vault = mkdtempSync(join(tmpdir(), "iva-graph-"));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  mkdirSync(join(vault, "cards"));
  writeFileSync(join(vault, "cards/a.md"), "# A\n\n[[cards/b]]\n[[missing]]\n");
  writeFileSync(join(vault, "cards/b.md"), "# B\n");
  const graph = buildVaultGraph(vault);
  assert.deepEqual(graph.nodes["cards/a"].outgoing, ["cards/b"]);
  assert.deepEqual(graph.nodes["cards/b"].incoming, ["cards/a"]);
  assert.deepEqual(graph.broken, [{ source: "cards/a", target: "missing" }]);
});

void test("resolveStopAt: будущий срок раннера принимается, прошлый и мусор — отказ", () => {
  assert.equal(resolveStopAt("2000", 1000), 2000);
  assert.ok(resolveStopAt(undefined, 1000) > 1000);
  assert.throws(() => resolveStopAt("999", 1000));
  assert.throws(() => resolveStopAt("later", 1000));
});

// ── Указатель «Последний день» в CORE ведёт код ночи (setLastDayPointer) ────────────
const { setLastDayPointer } = await import("../../agent/lib/core-clamp.ts");
const POINTED = [
  "# CORE",
  "",
  "## Пользователь",
  "",
  "- владелец",
  "",
  "## Указатели",
  "",
  "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md",
  "",
].join("\n");

void test("указатель: меняется одна ссылка, хвост строки цел; старый vault/ нормализуется; повтор — байт в байт", () => {
  const pointed = setLastDayPointer(POINTED, "2026-08-23");
  assert.equal(pointed, POINTED.replace("2026-08-20", "2026-08-23"));
  assert.equal(setLastDayPointer(pointed, "2026-08-23"), pointed);
  const legacy = POINTED.replace(
    "summaries/daily/2026-08-20 · Индекс: MOC.md",
    "vault/summaries/daily/2026-08-20 · Индекс: vault/MOC.md",
  );
  assert.equal(
    setLastDayPointer(legacy, "2026-08-23"),
    legacy.replace(
      "vault/summaries/daily/2026-08-20",
      "summaries/daily/2026-08-23",
    ),
  );
  const empty = "## Указатели\n\n- Последний день: · Индекс: MOC.md\n";
  assert.equal(
    setLastDayPointer(empty, "2026-08-23"),
    "## Указатели\n\n- Последний день: summaries/daily/2026-08-23 · Индекс: MOC.md\n",
  );
});

void test("указатель: нет строки — дописывается в раздел Указатели; нет раздела — в конец; пустой CORE — только раздел", () => {
  const lost = POINTED.replace(
    "- Последний день: summaries/daily/2026-08-20 · Индекс: MOC.md\n",
    "- Индекс: MOC.md\n\n## Мои заметки\n\n- хвост\n",
  );
  assert.match(
    setLastDayPointer(lost, "2026-08-23"),
    /- Индекс: MOC\.md\n- Последний день: summaries\/daily\/2026-08-23\n\n## Мои заметки/u,
  );
  const bare = "# CORE\n\n## Пользователь\n\n- владелец\n";
  const appended = setLastDayPointer(bare, "2026-08-23");
  assert.equal(
    appended,
    `${bare}\n## Указатели\n\n- Последний день: summaries/daily/2026-08-23\n`,
  );
  assert.equal(setLastDayPointer(appended, "2026-08-23"), appended);
  assert.equal(
    setLastDayPointer("", "2026-08-23"),
    "## Указатели\n\n- Последний день: summaries/daily/2026-08-23\n",
  );
  assert.throws(() => setLastDayPointer(POINTED, "2026-8-3"), TypeError);
  assert.throws(() => setLastDayPointer(POINTED, "вчера"), TypeError);
});

const isoDay = fc
  .date({
    min: new Date("2000-01-01"),
    max: new Date("2099-12-31"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));
const coreLine = line.filter(
  (value) => !value.startsWith("#") && !/Последний день|Last day/u.test(value),
);

void test(`указатель: правится ровно одна строка, повтор ничего не меняет, CRLF держится (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(coreLine, { maxLength: 6 }),
      fc.array(coreLine, { maxLength: 3 }),
      fc.boolean(),
      isoDay,
      (before, after, crlf, date) => {
        const newline = crlf ? "\r\n" : "\n";
        const lines = [
          "# CORE",
          "",
          ...before,
          "## Указатели",
          "",
          "- Последний день: summaries/daily/2001-01-01 · хвост",
          "",
          ...after,
        ];
        const text = lines.join(newline);
        const pointed = setLastDayPointer(text, date);
        const at = lines.findIndex((row) => row.includes("Последний день"));
        const changed = pointed
          .split(newline)
          .flatMap((row, index) => (row === lines[index] ? [] : [index]));
        assert.equal(pointed.split(newline).length, lines.length);
        assert.deepEqual(changed, date === "2001-01-01" ? [] : [at]);
        assert.equal(
          pointed.split(newline)[at],
          `- Последний день: summaries/daily/${date} · хвост`,
        );
        assert.equal(setLastDayPointer(pointed, date), pointed);
      },
    ),
    CHECKS,
  );
});

void test(`указатель: мусор на входе — без исключения, идемпотентно, прежние строки на месте (seed ${SEED})`, () => {
  const junk = fc.oneof(
    fc.constantFrom("", "\n", "\r\n\r\n", "# CORE", "просто текст"),
    fc.string({ unit: "binary", maxLength: 200 }),
    fc
      .array(fc.string({ unit: "grapheme", maxLength: 20 }), { maxLength: 8 })
      .map((rows) => rows.join("\r\n")),
  );
  fc.assert(
    fc.property(junk, isoDay, (text, date) => {
      const once = setLastDayPointer(text, date);
      assert.ok(once.includes(`summaries/daily/${date}`));
      assert.equal(setLastDayPointer(once, date), once);
      const kept = once.split(/\r?\n/u);
      for (const row of text.split(/\r?\n/u))
        if (!row.includes("Последний день")) assert.ok(kept.includes(row));
    }),
    CHECKS,
  );
});
