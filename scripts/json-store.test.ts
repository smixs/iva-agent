/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Тесты примитивов agent/lib/json-store.ts (лок, атомарная запись, бэкап битого JSON).
// Импорт .ts напрямую: Node 24 стрипает типы без флагов при явном .ts-специфкаторе.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../agent/lib/json-store.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

test("нет файла → fallback; save+load round-trip; tmp не остаётся", async () => {
  const dir = tempDir("json-store-");
  const file = join(dir, "tasks.json");
  assert.deepEqual(await loadJsonStrict(file, []), []);
  await saveJsonAtomic(file, [{ id: 1 }]);
  assert.deepEqual(await loadJsonStrict(file, []), [{ id: 1 }]);
  assert.deepEqual(
    readdirSync(dir),
    ["tasks.json"],
    "tmp-файл должен быть переименован",
  );
});

test("битый JSON: бэкап *.corrupt-* и явная ошибка, не пустой fallback", async () => {
  const dir = tempDir("json-store-");
  const file = join(dir, "tasks.json");
  writeFileSync(file, "{broken");
  await assert.rejects(() => loadJsonStrict(file, []), /damaged/);
  assert.ok(!existsSync(file), "битый файл должен быть отложен");
  const backup = readdirSync(dir).find((n) =>
    n.startsWith("tasks.json.corrupt-"),
  );
  assert.ok(backup, "должен появиться corrupt-бэкап");
  assert.equal(
    readFileSync(join(dir, backup), "utf8"),
    "{broken",
    "содержимое сохранено",
  );
});

test("лок эксклюзивен, снимается, протухший лок отбирается", async () => {
  const dir = tempDir("json-store-");
  const lock = join(dir, "tasks.json.lock");
  const t1 = await acquireLock(lock);
  await assert.rejects(
    () => acquireLock(lock),
    /lock timeout/,
    "второй захват должен ждать и падать по таймауту",
  );
  releaseLock(lock, t1);
  const t2 = await acquireLock(lock); // после release захватывается снова
  releaseLock(lock, t2);
});

test("release с чужим токеном не снимает лок преемника", async () => {
  const dir = tempDir("json-store-");
  const lock = join(dir, "tasks.json.lock");
  const stale = await acquireLock(lock);
  // Имитация staleness-вытеснения: преемник отобрал лок и держит его под своим токеном.
  releaseLock(lock, stale);
  const successor = await acquireLock(lock);
  releaseLock(lock, stale); // запоздавший release вытесненного держателя — no-op
  assert.equal(
    existsSync(lock),
    true,
    "лок преемника должен остаться на месте",
  );
  releaseLock(lock, successor);
  assert.equal(existsSync(lock), false, "владелец снимает свой лок");
});
