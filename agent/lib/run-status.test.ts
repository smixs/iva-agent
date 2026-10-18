/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireFileLockSync, releaseFileLock } from "./fs-atomic.ts";

const dataDir = mkdtempSync(join(tmpdir(), "iva-run-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.IVA_RUN_STATUS_LOCK_STALE_MS = "300";
process.env.IVA_RUN_STATUS_LOCK_TIMEOUT_MS = "150";
const modulePath = fileURLToPath(new URL("./run-status.ts", import.meta.url));
const status = (await import(
  `${pathToFileURL(modulePath).href}?test=${Date.now()}`
)) as typeof import("./run-status.ts");

test("legacy whole-map is read and each touched key migrates independently", () => {
  const legacy = join(dataDir, "run-status.json");
  writeFileSync(
    legacy,
    JSON.stringify({
      "legacy-a:": { status: "running", sessionId: "a" },
      "legacy-b:7": { status: "running", sessionId: "b" },
    }),
  );

  assert.equal(status.getChatStatus("legacy-a:")?.sessionId, "a");
  status.setChatStatus("legacy-a:", { status: "idle", sessionId: null });

  // The untouched key remains available from the legacy file.
  assert.equal(status.getChatStatus("legacy-b:7")?.sessionId, "b");
  // Once migrated, the per-chat file wins over stale legacy bytes.
  writeFileSync(
    legacy,
    JSON.stringify({
      "legacy-a:": { status: "running", sessionId: "stale" },
      "legacy-b:7": { status: "running", sessionId: "b" },
    }),
  );
  assert.equal(status.getChatStatus("legacy-a:")?.status, "idle");
  assert.equal(status.getChatStatus("legacy-a:")?.sessionId, undefined);
});

test("CAS derives its patch from the current cause and skips a mismatched pair", () => {
  const key = "cause-cas:";
  status.setChatStatus(key, {
    sessionId: "cause-session",
    turnId: "cause-turn",
    wasCancelled: "steer",
  });
  status.setChatStatus(key, { wasCancelled: "stop" });
  const updated = status.setChatStatusIf(
    key,
    { turnId: "cause-turn" },
    (current) => ({
      wasCancelled: current.wasCancelled,
      status: "idle",
    }),
  );
  assert.equal(updated?.wasCancelled, "stop");
  let called = false;
  assert.equal(
    status.setChatStatusIf(key, { turnId: "stale" }, () => {
      called = true;
      return { wasCancelled: "steer" };
    }),
    null,
  );
  assert.equal(called, false);
  assert.equal(
    status.setChatStatusIf(key, {}, () => null),
    null,
  );
  assert.deepEqual(status.getChatStatus(key), updated);
});

test("a delivered cancellation note is retired when the next turn starts", () => {
  const key = "cause-next:";
  status.setChatStatus(key, {
    status: "running",
    sessionId: "s",
    turnId: "old",
    wasCancelled: "stop",
    cancelContextDelivered: true,
  });
  const next = status.setChatStatus(key, { turnId: "new" });
  assert.equal(next.wasCancelled, undefined);
  assert.equal(next.cancelContextDelivered, undefined);
});

test("the first normal rewrite removes the retired routing field", () => {
  const legacy = join(dataDir, "run-status.json");
  const key = "legacy-routing:";
  writeFileSync(
    legacy,
    JSON.stringify({
      [key]: {
        status: "running",
        sessionId: "session-current",
        [status.RETIRED_SESSION_ROUTING_FIELD]: "retired-value",
      },
    }),
  );

  const rewritten = status.setChatStatus(key, { status: "idle" });

  assert.equal(rewritten[status.RETIRED_SESSION_ROUTING_FIELD], undefined);
  assert.equal(
    status.getChatStatus(key)?.[status.RETIRED_SESSION_ROUTING_FIELD],
    undefined,
  );
  assert.equal(rewritten.sessionId, "session-current");
});

test("distinct chats survive bounded concurrent writers", async () => {
  const workers = 8;
  const keysPerWorker = 100;
  const workerSource = `
    import { setChatStatus } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const worker = Number(process.argv[1]);
    const count = Number(process.argv[2]);
    for (let i = 0; i < count; i++) {
      setChatStatus("worker-" + worker + "-" + i + ":", {
        status: "running",
        sessionId: "session-" + worker + "-" + i
      });
    }
  `;
  const runs = Array.from(
    { length: workers },
    (_, worker) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            workerSource,
            String(worker),
            String(keysPerWorker),
          ],
          {
            env: { ...process.env, ASSISTANT_DATA_DIR: dataDir },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${worker} exited ${code}: ${stderr}`));
        });
      }),
  );
  await Promise.all(runs);

  for (let worker = 0; worker < workers; worker++) {
    for (let i = 0; i < keysPerWorker; i++) {
      assert.equal(
        status.getChatStatus(`worker-${worker}-${i}:`)?.sessionId,
        `session-${worker}-${i}`,
      );
    }
  }
});

test("conditional update checks sessionId under the same per-chat lock", () => {
  status.setChatStatus("cas:", {
    status: "running",
    sessionId: "fresh-session",
    turnId: "fresh-turn",
  });

  assert.equal(
    status.setChatStatusIf(
      "cas:",
      { sessionId: "retired-session" },
      { status: "idle", turnId: null },
    ),
    null,
  );
  assert.equal(status.getChatStatus("cas:")?.status, "running");
  assert.equal(status.getChatStatus("cas:")?.turnId, "fresh-turn");

  assert.ok(
    status.setChatStatusIf(
      "cas:",
      { status: "running", sessionId: "fresh-session" },
      { status: "idle", sessionId: null, turnId: null },
    ),
  );
  assert.equal(status.getChatStatus("cas:")?.status, "idle");
});

test("each accepted status write advances a monotonic per-chat generation", () => {
  const first = status.setChatStatus("generation:", {
    status: "running",
    sessionId: "session-1",
  });
  const second = status.setChatStatus("generation:", {
    status: "idle",
    sessionId: null,
  });

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
});

test("a write with no fields still refreshes updatedAt (the turn heartbeat rides on this)", () => {
  // Пульс живого хода (markTelegramTurnAlive) шлёт ПУСТОЙ патч: сообщать ему нечего,
  // кроме «ход ещё жив», а жизнь измеряется возрастом updatedAt. Если запись без полей
  // перестанет двигать updatedAt, молчаливый длинный ход снова начнёт жаться жнецом.
  const before = status.setChatStatus("heartbeat:", {
    status: "running",
    sessionId: "session-1",
  });
  assert.equal(before.status, "running");
  // Обе записи умещаются в одну миллисекунду, и тогда «updatedAt двинулся» нечем
  // измерить. Ждём смену часов, а не таймер: ограничено одной миллисекундой и не
  // зависит от загрузки машины.
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    /* смена миллисекунды */
  }

  const beat = status.setChatStatusIf(
    "heartbeat:",
    { status: "running", sessionId: "session-1" },
    {},
  );
  assert.ok(beat);
  assert.equal(beat.status, "running");
  assert.equal(beat.sessionId, "session-1");
  assert.equal(beat.generation, (before.generation as number) + 1);
  assert.ok((beat.updatedAt as number) > (before.updatedAt as number));
  assert.ok(Date.now() - (beat.updatedAt as number) < 60_000);

  // Чужая сессия пульс не пишет: CAS не совпал.
  assert.equal(
    status.setChatStatusIf(
      "heartbeat:",
      { status: "running", sessionId: "session-2" },
      {},
    ),
    null,
  );
});

test("per-chat status enumeration returns decoded keys and records", () => {
  const dir = join(dataDir, "run-status.d");
  status.setChatStatus("listed:-7", {
    status: "running",
    sessionId: "listed-session",
  });
  writeFileSync(
    join(dir, ".json"),
    JSON.stringify({ status: "running", sessionId: "empty-key" }),
  );

  const records = status.listChatStatuses();
  const listed = records.find(
    ({ chatKey }: { chatKey: string }) => chatKey === "listed:-7",
  );
  assert.equal(listed?.status.status, "running");
  assert.equal(listed?.status.sessionId, "listed-session");
  assert.equal(
    records.some(({ chatKey }: { chatKey: string }) => chatKey === ""),
    false,
  );
});

test("pending input update failure logs its chatKey and sessionId", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));
  try {
    assert.equal(
      status.updateTelegramPendingInputRequests("missing-pending-session", {
        requested: ["request-1"],
      }),
      false,
    );
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, [
    "[telegram] pending input state update failed for chatKey not-found, session missing-pending-session",
  ]);
});

test("pending input I/O failure logs its matched chatKey and sessionId", () => {
  const key = "pending-io-failure:";
  const sessionId = "pending-io-session";
  status.setChatStatus(key, { status: "running", sessionId });
  const dir = join(dataDir, "run-status.d");
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  const lock = join(dir, `${encoded}.json.lock`);
  writeFileSync(lock, "live-owner", { mode: 0o600 });
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));
  try {
    assert.equal(
      status.updateTelegramPendingInputRequests(sessionId, {
        requested: ["request-1"],
      }),
      false,
    );
  } finally {
    console.error = original;
    rmSync(lock, { force: true });
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`chatKey ${key}`));
  assert.match(lines[0], new RegExp(`session ${sessionId}`));
  assert.match(lines[0], /run-status lock timeout/u);
});

test("a stale per-chat lock is reclaimed after a crashed writer", () => {
  const key = "stale-lock:";
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  const dir = join(dataDir, "run-status.d");
  const lock = join(dir, `${encoded}.json.lock`);
  mkdirSync(dir, { recursive: true });
  const crashed = acquireFileLockSync(lock, { timeoutMs: 100, mode: 0o600 });
  assert.ok(crashed);
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);

  status.setChatStatus(key, { status: "running", sessionId: "successor" });
  releaseFileLock(crashed);

  assert.equal(status.getChatStatus(key)?.sessionId, "successor");
  assert.equal(existsSync(lock), false);
  assert.equal(
    readdirSync(dir).some((name) => name.includes(".tmp-")),
    false,
  );
});

test("a fresh orphan lock fails within a bounded timeout", () => {
  const key = "fresh-lock:";
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  const dir = join(dataDir, "run-status.d");
  const lock = join(dir, `${encoded}.json.lock`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "live-or-recent-owner", { mode: 0o600 });

  const started = Date.now();
  assert.throws(
    () => status.setChatStatus(key, { status: "running" }),
    /run-status lock timeout/,
  );
  assert.ok(Date.now() - started >= 100);
  assert.ok(Date.now() - started < 2_000);
  rmSync(lock, { force: true });
});

test("ordinary writers preserve an orphan lock older than recovery's threshold", () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IVA_RUN_STATUS_LOCK_TIMEOUT_MS: "150",
  };
  delete env.IVA_RUN_STATUS_LOCK_STALE_MS;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { join } from "node:path";
    import { acquireFileLockSync } from ${JSON.stringify(new URL("./fs-atomic.ts", import.meta.url).href)};
    const status = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const key = "ordinary-threshold:";
    status.setChatStatus(key, { status: "running", sessionId: "ordinary" });
    const file = join(${JSON.stringify(dataDir)}, "run-status.d", Buffer.from(key).toString("base64url") + ".json");
    const before = fs.readFileSync(file, "utf8");
    const lock = file + ".lock";
    assert.ok(acquireFileLockSync(lock, { timeoutMs: 100, staleMs: 30_000 }));
    const age = new Date(Date.now() - 3_000);
    fs.utimesSync(lock, age, age);
    try {
      assert.throws(() => status.setChatStatus(key, { status: "idle" }), /run-status lock timeout/u);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(fs.existsSync(lock), true);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  `,
    ],
    { env, stdio: "pipe" },
  );
});

test("one corrupt per-chat file is quarantined without blocking neighbors", () => {
  const corruptKey = "corrupt:";
  const neighborKey = "neighbor:";
  status.setChatStatus(neighborKey, {
    status: "running",
    sessionId: "neighbor-session",
  });

  const dir = join(dataDir, "run-status.d");
  const encoded = Buffer.from(corruptKey, "utf8").toString("base64url");
  const file = join(dir, `${encoded}.json`);
  const corrupt = '{"status":"running"';
  writeFileSync(file, corrupt, { mode: 0o600 });

  assert.equal(status.getChatStatus(corruptKey), null);
  assert.equal(
    status.getChatStatus(neighborKey)?.sessionId,
    "neighbor-session",
  );
  status.setChatStatus(corruptKey, { status: "idle" });
  assert.equal(status.getChatStatus(corruptKey)?.status, "idle");

  const backups = readdirSync(dir).filter((name) =>
    name.startsWith(`${encoded}.json.corrupt-`),
  );
  assert.equal(backups.length, 1);
  // Compare after the healthy replacement exists: returning {} and overwriting
  // the damaged file would lose these bytes.
  assert.equal(readFileSync(join(dir, backups[0]), "utf8"), corrupt);
});

test(
  "an operational read error is rethrown and the status file is not quarantined",
  {
    skip:
      process.getuid?.() === 0 ? "root bypasses file permission bits" : false,
  },
  () => {
    const key = "unreadable:";
    status.setChatStatus(key, { status: "running", sessionId: "keep" });
    const dir = join(dataDir, "run-status.d");
    const encoded = Buffer.from(key, "utf8").toString("base64url");
    const file = join(dir, `${encoded}.json`);
    chmodSync(file, 0o000);

    try {
      assert.throws(
        () => status.getChatStatus(key),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EACCES",
      );
      assert.equal(existsSync(file), true);
      assert.equal(
        readdirSync(dir).some((name) =>
          name.startsWith(`${encoded}.json.corrupt-`),
        ),
        false,
      );
    } finally {
      chmodSync(file, 0o600);
    }
  },
);

test("markTelegramSessionForRetirement помечает ровно нужную сессию", () => {
  const { markTelegramSessionForRetirement } = status;
  const running = (over: Record<string, unknown> = {}) => ({
    status: "running",
    generation: 3,
    updatedAt: 1000,
    sessionId: "s1",
    turnId: "t1",
    ...over,
  });
  const calls: unknown[][] = [];
  // Приманки ПЕРЕД целью: выключение любого условия ниже обязано дать лишний вызов.
  const listStatusesImpl = () => [
    { chatKey: "tg:3", status: running({ status: "idle" }) },
    { chatKey: "tg:2", status: running({ sessionId: "other" }) },
    { chatKey: "tg:4", status: running({ turnId: "other" }) },
    { chatKey: "tg:1", status: running() },
  ];
  const setStatusIfImpl = (...args: unknown[]) => {
    calls.push(args);
    return { ok: true };
  };

  assert.equal(
    markTelegramSessionForRetirement("s1", "t1", 5000, {
      listStatusesImpl,
      setStatusIfImpl,
    }),
    true,
  );
  assert.ok(
    calls.every(([chatKey]) => chatKey === "tg:1"),
    `приманки не помечены: ${JSON.stringify(calls)}`,
  );
  assert.deepEqual(calls, [
    [
      "tg:1",
      {
        status: "running",
        generation: 3,
        updatedAt: 1000,
        sessionId: "s1",
        turnId: "t1",
        retireAfterTurn: undefined,
      },
      { retireAfterTurn: { replayMs: 5000, sessionId: "s1", turnId: "t1" } },
    ],
  ]);
});

test("markTelegramSessionForRetirement молчит, когда помечать нечего", () => {
  const { markTelegramSessionForRetirement } = status;
  let calls = 0;
  const quiet = {
    listStatusesImpl: () => [
      {
        chatKey: "tg:9",
        status: {
          status: "running",
          sessionId: "s1",
          turnId: "t1",
          retiredSessionId: "s1",
        },
      },
      {
        chatKey: "tg:8",
        status: {
          status: "running",
          sessionId: "s1",
          turnId: "t1",
          retireAfterTurn: { replayMs: 1, sessionId: "s1", turnId: "t1" },
        },
      },
    ],
    setStatusIfImpl: () => {
      calls += 1;
      return null;
    },
  };
  assert.equal(
    markTelegramSessionForRetirement("s1", "t1", 5000, quiet),
    false,
  );
  assert.equal(calls, 0, "setStatusIf не должен вызываться");
  assert.equal(
    markTelegramSessionForRetirement("missing", "t1", 5000, {
      listStatusesImpl: () => [],
      setStatusIfImpl: () => {
        calls += 1;
        return null;
      },
    }),
    false,
  );
  assert.equal(calls, 0, "пустой список — тоже молча");
});

test("a write with touch: false moves generation but keeps updatedAt", async () => {
  const chatKey = "touch:";
  const first = status.setChatStatus(chatKey, {
    status: "running",
    sessionId: "s",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const kept = status.setChatStatusIf(
    chatKey,
    { status: "running" },
    { queuedIngressId: "q" },
    { touch: false },
  );
  assert.equal(kept?.updatedAt, first.updatedAt);
  assert.equal(kept?.generation, (first.generation ?? 0) + 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const touched = status.setChatStatusIf(chatKey, { status: "running" }, {});
  assert.ok((touched?.updatedAt ?? 0) > (first.updatedAt ?? 0));
});

test("legacy status UI fields survive a heartbeat and retire with the turn pair", () => {
  const key = "legacy-ui:";
  const dir = join(dataDir, "run-status.d");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Buffer.from(key).toString("base64url")}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      status: "running",
      sessionId: "s",
      turnId: "t",
      statusMessageId: 1,
      statusAt: 2,
      queuedStatusMessageId: 3,
      queuedStatusAt: 4,
    }),
  );
  assert.equal(status.getChatStatus(key)?.sessionId, "s");
  status.setChatStatus(key, { draftId: 41 });
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  const fields = [
    "statusMessageId",
    "statusAt",
    "queuedStatusMessageId",
    "queuedStatusAt",
  ];
  for (const [index, field] of fields.entries())
    assert.equal(written[field], index + 1);
  assert.equal(written.sessionId, "s");
  assert.equal(written.turnId, "t");
  assert.equal(written.draftId, 41);
  status.setChatStatus(key, { turnId: "next-turn" });
  for (const field of fields)
    assert.equal(Object.hasOwn(status.getChatStatus(key) ?? {}, field), false);
});
