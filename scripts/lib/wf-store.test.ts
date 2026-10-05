import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, {
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
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quarantineDir,
  quarantinePath,
  queuedInputTargets,
  recoverInterruptedSessionState,
  resetStateTargets,
  rewriteRunStatusesForUpdate,
  sessionStateTargets,
} from "./wf-store.ts";

const realOpenSync = fs.openSync;
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;

function withFsHook(install: () => void, run: () => void): void {
  install();
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

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

void test("startup recovery frees an interrupted compaction between turns at once, not leaving it for Bridge to close", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-store-compacting-status-"));
  const dir = join(dataDir, "run-status.d");
  const file = join(dir, "compacting.json");
  mkdirSync(dir);
  writeFileSync(
    file,
    JSON.stringify({
      generation: 7,
      status: "running",
      updatedAt: Date.now(),
      sessionId: "session-compacting",
      compacting: true,
    }),
    { mode: 0o600 },
  );
  const before = Date.now();

  assert.equal(rewriteRunStatusesForUpdate(dataDir, true), 1);

  const record = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    number | string
  >;
  // No session, no compacting flag, no updatedAt: 0 mark: Bridge sees a free chat and
  // reports no interrupted turn.
  assert.deepEqual(Object.keys(record).sort(), [
    "generation",
    "resetAt",
    "status",
    "updatedAt",
  ]);
  assert.equal(record.status, "idle");
  assert.equal(record.generation, 8);
  assert.ok(Number(record.updatedAt) >= before);
  assert.equal(record.resetAt, record.updatedAt);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(rewriteRunStatusesForUpdate(dataDir), 0, "nothing to re-arm");
});

void test("an update keeps an interrupted compaction marked like a turn: a rollback restores the store, and Bridge must still reset that session", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-store-compacting-rollback-"));
  const dataDir = join(home, "data");
  const dir = join(dataDir, "run-status.d");
  const file = join(dir, "compacting.json");
  const store = join(home, ".workflow-data");
  mkdirSync(dir, { recursive: true });
  mkdirSync(store);
  writeFileSync(join(store, "session"), "mid-compaction");
  writeFileSync(
    file,
    JSON.stringify({
      generation: 7,
      status: "running",
      updatedAt: Date.now(),
      sessionId: "session-compacting",
      compacting: true,
    }),
    { mode: 0o600 },
  );

  // The update quiesces writers: the store may come back if the candidate fails.
  assert.equal(rewriteRunStatusesForUpdate(dataDir), 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    generation: 7,
    status: "running",
    updatedAt: 0,
    sessionId: "session-compacting",
    compacting: true,
  });

  // Same road as an interrupted turn: Bridge reaps the record and resets the session,
  // silently for a compaction (scripts/poller/queue.ts).
  assert.equal(rewriteRunStatusesForUpdate(dataDir), 0, "marked once");
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

void test("restart recovery retires workflow state but preserves the Telegram queue", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-restart-"));
  const dataDir = join(root, "data");
  const statusDir = join(dataDir, "run-status.d");
  const workflow = join(root, ".eve/.workflow-data");
  const legacyWorkflow = join(root, ".workflow-data");
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(workflow, { recursive: true });
  mkdirSync(legacyWorkflow, { recursive: true });
  writeFileSync(join(workflow, "active.json"), "active");
  writeFileSync(join(legacyWorkflow, "active.json"), "legacy");
  writeFileSync(
    join(statusDir, "running.json"),
    JSON.stringify({
      status: "running",
      updatedAt: Date.now(),
      sessionId: "interrupted-session",
    }),
  );
  writeFileSync(
    join(statusDir, "idle.json"),
    JSON.stringify({ status: "idle", updatedAt: 123 }),
  );
  const queue = join(dataDir, "telegram-queue.json");
  writeFileSync(queue, '{"version":2,"queues":{"1:":["queued"]}}');

  const result = recoverInterruptedSessionState(root, dataDir, "restart");

  assert.equal(result.interrupted, 1);
  assert.deepEqual(result.quarantined.sort(), [
    `${workflow}.trash-restart`,
    `${legacyWorkflow}.trash-restart`,
  ]);
  assert.equal(existsSync(workflow), false);
  assert.equal(existsSync(legacyWorkflow), false);
  assert.equal(
    readFileSync(queue, "utf8"),
    '{"version":2,"queues":{"1:":["queued"]}}',
  );
  const running = JSON.parse(
    readFileSync(join(statusDir, "running.json"), "utf8"),
  ) as { updatedAt?: unknown };
  assert.equal(running.updatedAt, 0);
  assert.deepEqual(
    JSON.parse(readFileSync(join(statusDir, "idle.json"), "utf8")),
    { status: "idle", updatedAt: 123 },
  );
});

void test("restart recovery leaves parked workflow state untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-clean-restart-"));
  const dataDir = join(root, "data");
  const workflow = join(root, ".eve/.workflow-data");
  mkdirSync(join(dataDir, "run-status.d"), { recursive: true });
  mkdirSync(workflow, { recursive: true });
  writeFileSync(join(workflow, "parked.json"), "parked");
  writeFileSync(
    join(dataDir, "run-status.d/idle.json"),
    JSON.stringify({ status: "idle", updatedAt: 123 }),
  );

  assert.deepEqual(recoverInterruptedSessionState(root, dataDir, "clean"), {
    interrupted: 0,
    quarantined: [],
  });
  assert.equal(readFileSync(join(workflow, "parked.json"), "utf8"), "parked");
});

void test("second start before Bridge reaps the turn touches nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "wf-store-double-restart-"));
  const dataDir = join(root, "data");
  const statusDir = join(dataDir, "run-status.d");
  const workflow = join(root, ".eve/.workflow-data");
  mkdirSync(statusDir, { recursive: true });
  mkdirSync(workflow, { recursive: true });
  writeFileSync(
    join(statusDir, "running.json"),
    JSON.stringify({ status: "running", updatedAt: Date.now() }),
  );

  const first = recoverInterruptedSessionState(root, dataDir, "restart");
  mkdirSync(workflow, { recursive: true });
  writeFileSync(join(workflow, "second-start.json"), "active");
  const marked = readFileSync(join(statusDir, "running.json"), "utf8");
  const second = recoverInterruptedSessionState(root, dataDir, "restart-2");

  assert.equal(first.interrupted, 1);
  assert.deepEqual(second, { interrupted: 0, quarantined: [] });
  assert.equal(
    readFileSync(join(workflow, "second-start.json"), "utf8"),
    "active",
  );
  assert.deepEqual(readdirSync(join(root, ".eve")).sort(), [
    ".workflow-data",
    ".workflow-data.trash-restart",
  ]);
  assert.equal(readFileSync(join(statusDir, "running.json"), "utf8"), marked);
  assert.equal(rewriteRunStatusesForUpdate(dataDir), 0);
});

void test("update rewrite leaves a chat alone when Bridge finishes it after the scan", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-store-race-"));
  const dir = join(dataDir, "run-status.d");
  const file = join(dir, "chat.json");
  mkdirSync(dir);
  writeFileSync(
    file,
    JSON.stringify({ status: "running", updatedAt: Date.now() }),
  );
  const idle = JSON.stringify({ status: "idle", updatedAt: 777 });
  let reads = 0;
  withFsHook(
    () =>
      mock.method(
        fs,
        "readFileSync",
        (...args: Parameters<typeof fs.readFileSync>) => {
          const content = realReadFileSync(...args);
          if (String(args[0]) === file && ++reads === 1)
            realWriteFileSync(file, idle);
          return content;
        },
      ),
    () => assert.equal(rewriteRunStatusesForUpdate(dataDir), 0),
  );

  assert.ok(reads >= 2, "the record is read again before the rewrite");
  assert.equal(readFileSync(file, "utf8"), idle);
});

void test("a failed run-status write is logged while a damaged record stays silent", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wf-store-write-fail-"));
  const dir = join(dataDir, "run-status.d");
  mkdirSync(dir);
  const running = JSON.stringify({ status: "running", updatedAt: Date.now() });
  writeFileSync(join(dir, "chat.json"), running);
  writeFileSync(join(dir, "damaged.json"), "{not json");
  const logged: string[] = [];
  withFsHook(
    () => {
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        if (args[1] === "wx")
          throw Object.assign(new Error("no space left on device"), {
            code: "ENOSPC",
          });
        return realOpenSync(...args);
      });
      mock.method(console, "error", (...args: unknown[]) => {
        logged.push(args.join(" "));
      });
    },
    () => assert.equal(rewriteRunStatusesForUpdate(dataDir), 0),
  );

  assert.equal(logged.length, 1, logged.join("\n"));
  assert.match(logged[0], /chat\.json/u);
  assert.match(logged[0], /no space left on device/u);
  assert.equal(readFileSync(join(dir, "chat.json"), "utf8"), running);
});
