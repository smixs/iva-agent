// The rules of the install count against a real SQLite: `node:sqlite` stands behind the few
// calls of D1 the module makes. Run: node --test src/lib/installs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  installCounts,
  MAX_BODY,
  nameIn,
  recordInstall,
  SCHEMA,
} from "./installs.ts";
import { memoryDatabase } from "./memory-d1.ts";

const LISTED = new Set(["trace", "voice-reply"]);

test("a body that is not exactly a name is refused before anything is counted", () => {
  for (const body of [
    "",
    "trace",
    "null",
    "[]",
    '["trace"]',
    "{}",
    '{"name":7}',
    '{"name":null}',
    '{"name":["trace"]}',
    '{"name":{"toString":"trace"}}',
    '{"name":"trace"',
    `{"name":"${"a".repeat(MAX_BODY)}"}`,
  ])
    assert.equal(nameIn(body), null, body);
  assert.equal(nameIn('{"name":"trace"}'), "trace");
  // Extra fields are not read: whatever a caller adds, only the name reaches the table.
  assert.equal(nameIn('{"name":"trace","id":"abc"}'), "trace");
});

test("a name that is not on the list writes nothing, whatever it looks like", async () => {
  const { db, raw } = memoryDatabase(SCHEMA);
  for (const name of [
    "",
    "Trace",
    "trace ",
    "unknown",
    "trace'; DROP TABLE installs;--",
    "__proto__",
    "constructor",
  ])
    assert.equal(await recordInstall(db, name, LISTED), "unlisted", name);
  assert.deepEqual(raw.prepare("SELECT * FROM installs").all(), []);
  assert.deepEqual(await installCounts(db, LISTED), {});
});

test("every install counts, and nothing about the sender is kept", async () => {
  const { db, raw } = memoryDatabase(SCHEMA);
  assert.equal(await recordInstall(db, "trace", LISTED), "counted");
  assert.equal(await recordInstall(db, "trace", LISTED), "counted");
  assert.equal(await recordInstall(db, "voice-reply", LISTED), "counted");
  assert.deepEqual(await installCounts(db, LISTED), {
    trace: 2,
    "voice-reply": 1,
  });
  // What is stored is the row and nothing else: a name and its number.
  assert.deepEqual(
    raw
      .prepare("SELECT * FROM installs ORDER BY name")
      .all()
      .map((row) => ({ ...row })),
    [
      { name: "trace", count: 2 },
      { name: "voice-reply", count: 1 },
    ],
  );
  // One table, one number per plugin: there is nowhere an address or its hash could go.
  assert.deepEqual(
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name),
    ["installs"],
  );
});

test("a database that kept daily hashes loses them, and keeps its numbers", () => {
  const { raw } = memoryDatabase([
    "CREATE TABLE installs (name TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE TABLE seen (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash)) WITHOUT ROWID",
    "INSERT INTO installs VALUES ('trace', 3)",
    "INSERT INTO seen VALUES ('2026-11-26', 'abc')",
  ]);
  for (const statement of SCHEMA) raw.exec(statement);
  assert.deepEqual(
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => ({ ...row })),
    [{ name: "installs" }],
  );
  assert.deepEqual(
    raw
      .prepare("SELECT name, count FROM installs")
      .all()
      .map((row) => ({ ...row })),
    [{ name: "trace", count: 3 }],
  );
});

test("a plugin taken off the list keeps its row and leaves the page", async () => {
  const { db } = memoryDatabase(SCHEMA);
  await recordInstall(db, "trace", LISTED);
  await recordInstall(db, "voice-reply", LISTED);
  assert.deepEqual(await installCounts(db, new Set(["trace"])), { trace: 1 });
});
