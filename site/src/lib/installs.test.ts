// The rules of the install count against a real SQLite: `node:sqlite` stands behind the few
// calls of D1 the module makes. Run: node --test src/lib/installs.test.ts
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  installCounts,
  MAX_BODY,
  nameIn,
  recordInstall,
  SCHEMA,
  type Database,
} from "./installs.ts";

function database(): { db: Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) raw.exec(statement);
  const db: Database = {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: () =>
          Promise.resolve({
            meta: {
              changes: Number(raw.prepare(sql).run(...values).changes),
            },
          }),
        all: <Row>() =>
          Promise.resolve({
            results: raw.prepare(sql).all(...values) as Row[],
          }),
      }),
    }),
  };
  return { db, raw };
}

const LISTED = new Set(["trace", "voice-reply"]);
const SALT = "test-salt";
const at = (iso: string) => new Date(iso);
const install = (
  db: Database,
  name: string,
  address: string,
  now = "2026-11-22T10:00:00Z",
) => recordInstall(db, { name, address, now: at(now), salt: SALT }, LISTED);

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
  const { db, raw } = database();
  for (const name of [
    "",
    "Trace",
    "trace ",
    "unknown",
    "trace'; DROP TABLE installs;--",
    "__proto__",
    "constructor",
  ])
    assert.equal(await install(db, name, "203.0.113.7"), "unlisted", name);
  assert.deepEqual(raw.prepare("SELECT * FROM installs").all(), []);
  assert.deepEqual(raw.prepare("SELECT * FROM seen").all(), []);
  assert.deepEqual(
    await installCounts(db, LISTED, at("2026-11-22T10:00:00Z")),
    {},
  );
});

test("one address counts once a day for a plugin, and again the next day", async () => {
  const { db } = database();
  assert.equal(await install(db, "trace", "203.0.113.7"), "counted");
  // The same request again, and again: a retry, a reinstall, a loop.
  assert.equal(await install(db, "trace", "203.0.113.7"), "repeat");
  assert.equal(
    await install(db, "trace", "203.0.113.7", "2026-11-22T23:59:59Z"),
    "repeat",
  );
  // Another plugin from the same address and another address are their own installs.
  assert.equal(await install(db, "voice-reply", "203.0.113.7"), "counted");
  assert.equal(await install(db, "trace", "203.0.113.8"), "counted");
  assert.equal(
    await install(db, "trace", "203.0.113.7", "2026-11-23T00:00:01Z"),
    "counted",
  );
  assert.deepEqual(
    await installCounts(db, LISTED, at("2026-11-23T09:00:00Z")),
    {
      trace: 3,
      "voice-reply": 1,
    },
  );
});

test("the address is never stored, and yesterday's hashes leave with the new day", async () => {
  const { db, raw } = database();
  await install(db, "trace", "203.0.113.7");
  await install(db, "voice-reply", "2001:db8::17");
  const dump = () =>
    JSON.stringify([
      raw.prepare("SELECT * FROM seen").all(),
      raw.prepare("SELECT * FROM installs").all(),
    ]);
  assert.doesNotMatch(dump(), /203\.0\.113\.7|2001:db8/u);
  const seen = raw.prepare("SELECT day, hash FROM seen").all() as {
    day: string;
    hash: string;
  }[];
  assert.equal(seen.length, 2);
  for (const row of seen) {
    assert.equal(row.day, "2026-11-22");
    assert.match(row.hash, /^[0-9a-f]{64}$/u);
  }
  // The same address and plugin on the next day is another hash: nothing links the two days.
  await install(db, "trace", "203.0.113.7", "2026-11-23T08:00:00Z");
  const next = raw.prepare("SELECT day, hash FROM seen").all() as {
    day: string;
    hash: string;
  }[];
  assert.deepEqual(
    next.map((row) => row.day),
    ["2026-11-23"],
  );
  assert.equal(
    seen.some((row) => row.hash === next[0].hash),
    false,
  );
});

test("yesterday's hashes leave with any request of a new day, not only with a counted install", async () => {
  const days = async (
    then: (db: Database) => Promise<unknown>,
  ): Promise<string[]> => {
    const { db, raw } = database();
    await install(db, "trace", "203.0.113.7", "2026-11-18T10:00:00Z");
    await then(db);
    return (raw.prepare("SELECT day FROM seen").all() as { day: string }[]).map(
      (row) => row.day,
    );
  };
  const later = "2026-11-22T10:00:00Z";
  // A read of the numbers: the page asks for them on every visit.
  assert.deepEqual(
    await days((db) => installCounts(db, LISTED, at(later))),
    [],
  );
  // A name that is not on the list: nothing is counted, the old hash still goes.
  assert.deepEqual(
    await days((db) => install(db, "unknown", "203.0.113.9", later)),
    [],
  );
  // The numbers themselves stay.
  const { db } = database();
  await install(db, "trace", "203.0.113.7", "2026-11-18T10:00:00Z");
  assert.deepEqual(await installCounts(db, LISTED, at(later)), { trace: 1 });
});

test("a different salt gives a different hash for the same address", async () => {
  const one = database();
  const two = database();
  const request = {
    name: "trace",
    address: "203.0.113.7",
    now: at("2026-11-22T10:00:00Z"),
  };
  await recordInstall(one.db, { ...request, salt: "a" }, LISTED);
  await recordInstall(two.db, { ...request, salt: "b" }, LISTED);
  const hashOf = (raw: DatabaseSync) =>
    (raw.prepare("SELECT hash FROM seen").get() as { hash: string }).hash;
  assert.notEqual(hashOf(one.raw), hashOf(two.raw));
});

test("a plugin taken off the list keeps its row and leaves the page", async () => {
  const { db } = database();
  await install(db, "trace", "203.0.113.7");
  await install(db, "voice-reply", "203.0.113.7");
  assert.deepEqual(
    await installCounts(db, new Set(["trace"]), at("2026-11-22T10:00:00Z")),
    { trace: 1 },
  );
});
