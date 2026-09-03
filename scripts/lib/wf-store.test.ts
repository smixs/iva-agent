import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quarantineDir,
  quarantinePath,
  queuedInputTargets,
  resetStateTargets,
  rewriteRunStatusesForUpdate,
  sessionStateTargets,
} from "./wf-store.ts";

void test("quarantineDir переименовывает стор в *.trash-<штамп> с содержимым", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  mkdirSync(dir);
  writeFileSync(join(dir, "run.json"), "{}");
  const dest = quarantineDir(dir, "2026-01-01T00-00-00-000Z");
  assert.equal(dest, `${dir}.trash-2026-01-01T00-00-00-000Z`);
  assert.ok(dest);
  assert.ok(!existsSync(dir), "исходная директория должна исчезнуть");
  assert.ok(
    existsSync(join(dest, "run.json")),
    "содержимое должно переехать в карантин",
  );
  assert.equal(statSync(dest).mode & 0o777, 0o700);
});

void test("quarantinePath сохраняет файл и закрывает его права", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-file-"));
  const file = join(root, "telegram-queue.json");
  writeFileSync(file, '{"chat":["secret"]}');
  chmodSync(file, 0o644);

  const dest = quarantinePath(file, "2026-01-01");

  assert.equal(dest, `${file}.trash-2026-01-01`);
  assert.ok(dest);
  assert.equal(readFileSync(dest, "utf8"), '{"chat":["secret"]}');
  assert.equal(statSync(dest).mode & 0o777, 0o600);
});

void test("стор, который версия видит по симлинку, карантинится по-настоящему", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-link-"));
  // Как в версионном layout: код живёт в версии, стор — в установке.
  const store = join(root, ".eve/.workflow-data");
  const version = join(root, "versions/0.3.15/.eve");
  mkdirSync(store, { recursive: true });
  mkdirSync(version, { recursive: true });
  writeFileSync(join(store, "run.json"), '{"status":"running"}');
  symlinkSync(store, join(version, ".workflow-data"));

  const dest = quarantinePath(join(version, ".workflow-data"), "2026-01-01");

  // Переименована сама директория стора, а не ссылка на неё: иначе reset ничего не
  // чистит, а следующий апдейт возвращает те же зависшие прогоны.
  assert.equal(dest, `${store}.trash-2026-01-01`);
  assert.equal(
    readFileSync(join(String(dest), "run.json"), "utf8"),
    '{"status":"running"}',
  );
  assert.deepEqual(readdirSync(store), []);
  // Ссылка не висит: сервис снова может писать через неё.
  writeFileSync(join(version, ".workflow-data/run.json"), "{}");
  assert.deepEqual(readdirSync(store), ["run.json"]);
});

void test("quarantinePath на отсутствующем пути — null, ничего не создаёт", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, ".workflow-data");
  assert.equal(quarantinePath(dir), null);
  assert.deepEqual(readdirSync(root), []);
});

void test("старые directory-карантины ротируются, свежие остаются", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-"));
  const dir = join(root, "store");
  for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    mkdirSync(dir);
    quarantineDir(dir, stamp);
  }
  assert.deepEqual(readdirSync(root).sort(), [
    "store.trash-2026-01-02",
    "store.trash-2026-01-03",
  ]);
});

void test("старые file-карантины ротируются по тому же правилу", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-file-"));
  const file = join(root, "run-status.json");
  for (const stamp of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    writeFileSync(file, stamp);
    quarantinePath(file, stamp);
  }
  assert.deepEqual(readdirSync(root).sort(), [
    "run-status.json.trash-2026-01-02",
    "run-status.json.trash-2026-01-03",
  ]);
});

void test("одинаковый operation stamp не перезаписывает существующий карантин", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-collision-"));
  const file = join(root, "telegram-queue.json");
  writeFileSync(file, "first");
  const first = quarantinePath(file, "same-stamp");
  writeFileSync(file, "second");
  const second = quarantinePath(file, "same-stamp");

  assert.equal(first, `${file}.trash-same-stamp`);
  assert.equal(second, `${file}.trash-same-stamp-1`);
  assert.ok(first);
  assert.ok(second);
  assert.equal(readFileSync(first, "utf8"), "first");
  assert.equal(readFileSync(second, "utf8"), "second");
});

void test("global reset plan includes workflow and all Telegram control-state targets", () => {
  const root = "/srv/iva";
  const data = "/var/lib/iva";
  assert.deepEqual(sessionStateTargets(root, data), [
    "/srv/iva/.eve/.workflow-data",
    "/srv/iva/.workflow-data",
  ]);
  assert.deepEqual(queuedInputTargets(data), [
    "/var/lib/iva/telegram-queue.json",
  ]);
  assert.deepEqual(resetStateTargets(root, data), [
    "/srv/iva/.eve/.workflow-data",
    "/srv/iva/.workflow-data",
    "/var/lib/iva/run-status.d",
    "/var/lib/iva/run-status.json",
    "/var/lib/iva/telegram-queue.json",
  ]);
});

void test("update rewrite expires running chats and preserves cleanup fields", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-store-run-status-"));
  const dir = join(dataDir, "run-status.d");
  const file = join(dir, "chat.json");
  const damagedFile = join(dir, "damaged.json");
  mkdirSync(dir);
  writeFileSync(
    file,
    JSON.stringify({
      generation: 1,
      status: "running",
      updatedAt: Date.now(),
      sessionId: "session-to-reset",
      statusMessageId: 4242,
      custom: "preserved",
    }),
    { mode: 0o600 },
  );
  writeFileSync(damagedFile, "{not json", { mode: 0o600 });

  rewriteRunStatusesForUpdate(dataDir);

  const record = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(record, {
    generation: 1,
    status: "running",
    updatedAt: 0,
    sessionId: "session-to-reset",
    statusMessageId: 4242,
    custom: "preserved",
  });
  assert.equal(
    record.status === "running" &&
      Date.now() - Number(record.updatedAt) < 60_000,
    false,
  );
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(damagedFile, "utf8"), "{not json");
});

void test("update rewrite leaves terminal chats alone and does not re-arm a notice", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-store-idle-status-"));
  const dir = join(dataDir, "run-status.d");
  mkdirSync(dir);
  const records = {
    idle: {
      generation: 4,
      status: "idle",
      updatedAt: 1234,
      resetAt: 1233,
    },
    failed: {
      generation: 5,
      status: "failed",
      updatedAt: 2345,
      sessionId: "finished-session",
    },
  } as const;
  for (const [name, record] of Object.entries(records))
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(record), {
      mode: 0o600,
    });

  rewriteRunStatusesForUpdate(dataDir);
  rewriteRunStatusesForUpdate(dataDir);

  for (const [name, record] of Object.entries(records))
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")),
      record,
    );
});
