import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsage,
  subagentTurnId,
  usageFilePath,
  setUsageRequest,
  takeUsageRequest,
} from "./usage.ts";
import fc from "fast-check";

void test("fingerprint labels isolate sessions/turns and abandoned calls stay bounded (seed 101820)", () => {
  console.error("[usage label property] seed 101820, runs 40");
  const request = {
    system: "12345678",
    cache: "23456789",
    tools: "34567890",
    toolCount: 0,
  };
  fc.assert(
    fc.property(fc.string(), fc.string(), (a, b) => {
      const first = { sessionId: a, turnId: `${b}:`, step: 0 };
      const second = { sessionId: `${a}:${b}`, turnId: "", step: 0 };
      setUsageRequest(first, request);
      setUsageRequest(second, { ...request, toolCount: 1 });
      assert.deepEqual(takeUsageRequest(first), request);
      assert.equal(takeUsageRequest(second)?.toolCount, 1);
      assert.equal(takeUsageRequest(first), undefined);
    }),
    { seed: 101820, numRuns: 40 },
  );
  for (let step = 0; step <= 256; step++)
    setUsageRequest(
      { sessionId: "abandoned", turnId: "turn_0", step },
      request,
    );
  assert.equal(
    takeUsageRequest({ sessionId: "abandoned", turnId: "turn_0", step: 0 }),
    undefined,
  );
  assert.deepEqual(
    takeUsageRequest({ sessionId: "abandoned", turnId: "turn_0", step: 256 }),
    request,
  );
});

const record = (over: Partial<Parameters<typeof appendUsage>[0]> = {}) => ({
  ts: "2026-07-31T01:23:14.343Z",
  source: "channel:telegram",
  provider: "ollama",
  model: "deepseek-v4-pro",
  sessionId: "wrun_1",
  turnId: "turn_1",
  step: 0,
  in: 0,
  out: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  ...over,
});

void test("the log path follows ASSISTANT_DATA_DIR", () => {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = "/tmp/iva-data";
  try {
    assert.equal(usageFilePath(), "/tmp/iva-data/usage.jsonl");
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
  assert.equal(usageFilePath("data"), "data/usage.jsonl");
});

// Каталог данных на свежей установке ещё не создан: первая же запись хода не имеет права
// упасть ENOENT, а шаги одного хода должны лечь отдельными строками, а не склеиться.
void test("appending creates the data directory and keeps one record per line", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-usage-append-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");

  appendUsage(record({ step: 0 }), dataDir);
  appendUsage(record({ step: 1, subagent: "planner" }), dataDir);

  const lines = readFileSync(usageFilePath(dataDir), "utf8").split("\n");
  assert.equal(lines.length, 3); // две записи и завершающий перевод строки
  assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[0]), record({ step: 0 }));
  assert.deepEqual(
    JSON.parse(lines[1]),
    record({ step: 1, subagent: "planner" }),
  );
});

// Лог расхода растёт с каждым шагом модели и раньше не подрезался вовсе. Теряем при
// переполнении САМОЕ СТАРОЕ и только его: свежие записи (их читает /usage) и целостность
// строк обязаны пережить подрезку.
void test("an oversized log is trimmed from the oldest end, keeping whole lines", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-usage-trim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });

  // Лог, накопленный до подрезки: пятимегабайтный файл целых строк.
  const filler = JSON.stringify(record({ turnId: "old" })) + "\n";
  const file = usageFilePath(dataDir);
  writeFileSync(
    file,
    filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length)),
  );
  const before = readFileSync(file, "utf8").length;

  appendUsage(record({ turnId: "newest", step: 42 }), dataDir);

  const raw = readFileSync(file, "utf8");
  assert.ok(raw.length < before, "файл подрезан");
  assert.ok(raw.length > 1024 * 1024, "хвост оставлен, а не вычищен под ноль");
  const lines = raw.split("\n").filter(Boolean);
  // Ни одной покалеченной строки и последней лежит только что дописанная запись.
  for (const line of lines) JSON.parse(line);
  assert.deepEqual(
    JSON.parse(lines[lines.length - 1]),
    record({ turnId: "newest", step: 42 }),
  );
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.endsWith(".tmp")),
    [],
  );

  // Следующая запись в подрезанный лог ложится как обычно, без повторной подрезки.
  appendUsage(record({ turnId: "after", step: 43 }), dataDir);
  const afterLines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(afterLines.length, lines.length + 1);
});

void test("the subagent turn key falls back the way Eve itself does", () => {
  assert.equal(
    subagentTurnId({ id: "turn_5", sequence: 5 }, "planner", "turn_0"),
    "turn_5#planner",
  );
  assert.equal(
    subagentTurnId({ id: "", sequence: 7 }, "planner", "turn_0"),
    "turn_7#planner",
  );
  assert.equal(
    subagentTurnId({ sequence: 0 }, "planner", "turn_3"),
    "turn_0#planner",
  );
  assert.equal(
    subagentTurnId(undefined, "planner", "turn_3"),
    "turn_3#planner",
  );
  assert.equal(subagentTurnId({}, "planner", "turn_3"), "turn_3#planner");
  assert.equal(
    subagentTurnId({ id: "turn_5" }, undefined, "turn_0"),
    "turn_5#subagent",
  );
});
