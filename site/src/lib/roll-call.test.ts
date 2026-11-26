// The rules of the roll call against a real SQLite. Run: node --test src/lib/roll-call.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SCHEMA } from "./installs.ts";
import { memoryDatabase } from "./memory-d1.ts";
import { textUpTo } from "./request-body.ts";
import {
  FIELDS,
  installations,
  MAX_GAP,
  MAX_ROLL_CALL_BODY,
  recordRollCall,
  ROLL_CALL_SCHEMA,
  rollCallIn,
  split,
  type Counter,
} from "./roll-call.ts";

const SEED = Number(process.env.SEED ?? 20_261_126);

/** A small seeded generator (mulberry32): a failure prints the seed, the seed replays it. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]) => items[int(0, items.length - 1)];
  return { int, pick };
}
const CALL = {
  gap: 1,
  version: "0.5.16",
  branch: "main",
  os: "linux",
  arch: "x64",
  provider: "codex",
  model: "gpt-5.5",
};
const body = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ ...CALL, ...patch });

test("a roll call is exactly seven fields in their shapes; anything else is refused", () => {
  assert.deepEqual(rollCallIn(body()), { ...CALL, gap: "1" });
  for (const model of ["openai/gpt-5.1", "gemma4:31b", "deepseek-v4.1-flash"])
    assert.equal(rollCallIn(body({ model }))?.model, model);
  assert.equal(rollCallIn(body({ version: "other" }))?.version, "other");
  for (const bad of [
    "",
    "null",
    "[]",
    "{}",
    "{not json",
    body({ gap: -1 }),
    body({ gap: MAX_GAP + 1 }),
    body({ gap: 1.5 }),
    body({ gap: "1" }),
    body({ id: "abc" }),
    body({ version: "0.5.16-beta" }),
    body({ model: "http://box:11434/llama" }),
    body({ model: "203.0.113.7" }),
    body({ model: "10.0.0.1:11434" }),
    body({ model: "192.168.1.5:11434/llama3" }),
    body({ model: "fe80::1" }),
    body({ model: "2001:db8:0:1:2:3:4:5" }),
    body({ branch: "Main" }),
    body({ model: "My Model" }),
    body({ model: "/srv/models/model.gguf" }),
    body({ provider: "Codex" }),
    body({ os: "linux; rm -rf" }),
    body({ model: "a".repeat(65) }),
    JSON.stringify({ ...CALL, model: undefined }),
    `${body()}${" ".repeat(MAX_ROLL_CALL_BODY)}`,
  ])
    assert.equal(rollCallIn(bad), null, bad.slice(0, 60));
});

test(`no body outside the shapes reaches the table (seed ${SEED})`, () => {
  const { int, pick } = random(SEED);
  const values = [
    ...Object.values(CALL),
    "",
    "other",
    "a b",
    "203.0.113.7",
    "fe80::1",
    "http://x/y",
    "0.5",
    -1,
    32,
    0,
    null,
    true,
  ];
  let taken = 0;
  for (let run = 0; run < 2000; run++) {
    // A real roll call with up to two fields changed, dropped or added: most bodies are near
    // the valid ones, where a wrong rule would show.
    const fields: Record<string, unknown> = { ...CALL };
    for (let change = int(0, 2); change > 0; change--) {
      const key = pick([...FIELDS, "id", "ip", "host"]);
      if (int(0, 3) === 0) delete fields[key];
      else fields[key] = pick(values);
    }
    const call = rollCallIn(JSON.stringify(fields));
    if (call === null) continue;
    taken++;
    assert.deepEqual(
      Object.keys(call).sort(),
      [...FIELDS].sort(),
      `seed ${SEED}, run ${run}`,
    );
    assert.ok(Number(call.gap) >= 0 && Number(call.gap) <= MAX_GAP);
    for (const address of ["203.0.113.7", "fe80::1", "http://x/y"])
      assert.ok(
        !Object.values(call).includes(address),
        `seed ${SEED}, run ${run}`,
      );
  }
  assert.ok(taken > 200, `seed ${SEED}: only ${taken} bodies taken`);
});

test("the table keeps one counter per day, field and value, and nothing about the sender", async () => {
  const { db, raw } = memoryDatabase(ROLL_CALL_SCHEMA);
  const now = new Date("2026-11-26T10:00:00Z");
  await recordRollCall(db, rollCallIn(body())!, now);
  await recordRollCall(
    db,
    rollCallIn(body({ provider: "claude", model: "claude-fable-5-2" }))!,
    now,
  );
  const rows = raw
    .prepare(
      "SELECT day, field, value, count FROM roll_call ORDER BY field, value",
    )
    .all()
    .map((row) => ({ ...row }));
  assert.equal(rows.length, 9);
  assert.deepEqual(
    rows.filter((row) => row.field === "provider"),
    [
      { day: "2026-11-26", field: "provider", value: "claude", count: 1 },
      { day: "2026-11-26", field: "provider", value: "codex", count: 1 },
    ],
  );
  assert.deepEqual(
    rows.find((row) => row.field === "gap"),
    { day: "2026-11-26", field: "gap", value: "1", count: 2 },
  );
  assert.deepEqual(
    raw
      .prepare("PRAGMA table_info(roll_call)")
      .all()
      .map((column) => (column as { name: string }).name),
    ["day", "field", "value", "count"],
  );
});

/** Installations that answer on some days; each gives the gaps its roll calls would carry. */
function rollCalls(days: number[][], start: string): Counter[] {
  const counters = new Map<string, number>();
  for (const answered of days) {
    let last: number | null = null;
    for (const day of [...new Set(answered)].sort((a, b) => a - b)) {
      const gap = last === null ? 0 : Math.min(day - last, MAX_GAP);
      const date = new Date(Date.parse(start) + day * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const key = `${date}|${gap}`;
      counters.set(key, (counters.get(key) ?? 0) + 1);
      last = day;
    }
  }
  return [...counters].map(([key, count]) => {
    const [day, value] = key.split("|");
    return { day, field: "gap", value, count };
  });
}

test(`the gaps alone count distinct installations in any window of up to a month (seed ${SEED})`, () => {
  const start = "2026-01-01";
  const date = (n: number) =>
    new Date(Date.parse(start) + n * 86_400_000).toISOString().slice(0, 10);
  const { int } = random(SEED);
  for (let run = 0; run < 1000; run++) {
    const days = Array.from({ length: int(0, 25) }, () =>
      Array.from({ length: int(1, 40) }, () => int(0, 90)),
    );
    const from = int(0, 90);
    const to = from + int(0, MAX_GAP - 1);
    const truth = days.filter((answered) =>
      answered.some((d) => d >= from && d <= to),
    ).length;
    assert.equal(
      installations(rollCalls(days, start), date(from), date(to)),
      truth,
      `seed ${SEED}, run ${run}`,
    );
  }
});

test("one day splits by field, largest first", () => {
  const counters: Counter[] = [
    { day: "2026-11-26", field: "provider", value: "codex", count: 3 },
    { day: "2026-11-26", field: "provider", value: "claude", count: 5 },
    { day: "2026-11-25", field: "provider", value: "ollama", count: 9 },
    { day: "2026-11-26", field: "model", value: "gpt-5.5", count: 3 },
  ];
  assert.deepEqual(split(counters, "2026-11-26", "provider"), [
    ["claude", 5],
    ["codex", 3],
  ]);
});

test("the seven counters of a roll call are written together or not at all", async () => {
  const { db, raw } = memoryDatabase([
    ...ROLL_CALL_SCHEMA,
    // D1 failing in the middle of the seven writes: the model is the sixth.
    "CREATE TRIGGER fail BEFORE INSERT ON roll_call WHEN NEW.field = 'model' BEGIN SELECT RAISE(ABORT, 'D1 is down'); END",
  ]);
  await assert.rejects(
    recordRollCall(db, rollCallIn(body())!, new Date("2026-11-26T10:00:00Z")),
    /D1 is down/,
  );
  assert.deepEqual(raw.prepare("SELECT * FROM roll_call").all(), []);
});

test("the schema file creates exactly the tables the code expects", () => {
  const file = readFileSync(
    new URL("../../d1/installs.sql", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.deepEqual(file, [...SCHEMA, ...ROLL_CALL_SCHEMA]);
});

test("a body is read no further than its limit, whatever Content-Length says", async () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://iva-agent.com/api/roll-call", {
      method: "POST",
      body,
      headers,
    });
  const small = body();
  assert.equal(await textUpTo(post(small), MAX_ROLL_CALL_BODY), small);
  assert.equal(await textUpTo(post(""), MAX_ROLL_CALL_BODY), "");
  const large = "x".repeat(1 << 20);
  // A stream has no Content-Length: only the read can stop it.
  const streamed = new Request("https://iva-agent.com/api/roll-call", {
    method: "POST",
    body: new Blob([large]).stream(),
    duplex: "half",
  } as RequestInit);
  assert.equal(streamed.headers.get("content-length"), null);
  assert.equal(await textUpTo(streamed, MAX_ROLL_CALL_BODY), null);
  assert.equal(
    await textUpTo(
      post(small, { "content-length": "100000" }),
      MAX_ROLL_CALL_BODY,
    ),
    null,
  );
  // Multi-byte text is counted in bytes, as the limit is.
  const wide = "я".repeat(MAX_ROLL_CALL_BODY / 2 + 1);
  assert.equal(await textUpTo(post(wide), MAX_ROLL_CALL_BODY), null);
});

test("the endpoint answers 204 to a roll call, 400 to anything else, 413 to a large body, and has no GET", async () => {
  const endpoint = await import("../../functions/api/roll-call.ts");
  assert.equal("onRequestGet" in endpoint, false);
  assert.equal("onRequest" in endpoint, false);
  const { db, raw } = memoryDatabase(ROLL_CALL_SCHEMA);
  const post = (text: string) =>
    endpoint.onRequestPost({
      request: new Request("https://iva-agent.com/api/roll-call", {
        method: "POST",
        body: text,
      }),
      env: { INSTALLS: db },
    });
  const taken = await post(body());
  assert.equal(taken.status, 204);
  assert.equal(taken.headers.get("cache-control"), "no-store");
  assert.equal((await post(body({ id: "abc" }))).status, 400);
  assert.equal((await post("x".repeat(MAX_ROLL_CALL_BODY + 1))).status, 413);
  // Only the taken one was counted: seven counters, one each.
  assert.deepEqual(
    raw
      .prepare("SELECT SUM(count) AS total FROM roll_call")
      .all()
      .map((row) => ({ ...row })),
    [{ total: 7 }],
  );
});
