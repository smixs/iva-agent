import assert from "node:assert/strict";
import { glob, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import {
  acquireTelegramProcessLock,
  type TelegramProcessLease,
} from "./process-lock.ts";
import {
  decideTelegramStartup,
  parseBacklogDropMarker,
  prepareTelegramStartup,
} from "./startup-state.ts";

const SEED = 18_702;
const ROOT = join(import.meta.dirname, "../..");
let startupGuardSequence = 0;

async function temporaryStartup(t: TestContext): Promise<{
  markerFile: string;
  lease: TelegramProcessLease;
}> {
  const directory = await mkdtemp(join(tmpdir(), "iva-startup-state-"));
  const lease = await acquireTelegramProcessLock({
    testGuard: {
      identity: `startup-${process.pid}-${++startupGuardSequence}`,
      directory: join(directory, ".guard"),
    },
  });
  t.after(async () => {
    await lease.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    markerFile: join(directory, "telegram-backlog-drop.json"),
    lease,
  };
}

void test("first run publishes its marker before permitting one backlog drop", async (t) => {
  const { markerFile, lease } = await temporaryStartup(t);
  const events: string[] = [];
  const first = await prepareTelegramStartup(lease, {
    markerFile,
    loadOffsetImpl: () => Promise.resolve({ offset: null }),
    createMarkerImpl: async (file, data) => {
      events.push("marker");
      // The SIGKILL matrix in telegram-startup-crash.test.ts crosses the same
      // production writer after this call returns.
      await writeFileAtomic(file, data, { mode: 0o600 });
    },
  });
  events.push("drop-permitted");

  assert.deepEqual(first, { firstRun: true, offset: null });
  assert.deepEqual(events, ["marker", "drop-permitted"]);
  assert.deepEqual(parseBacklogDropMarker(await readFile(markerFile, "utf8")), {
    schema: "iva-telegram-backlog-drop/v1",
  });
  assert.equal((await stat(markerFile)).mode & 0o777, 0o600);

  await assert.rejects(
    prepareTelegramStartup(lease, {
      markerFile,
      loadOffsetImpl: () => Promise.resolve({ offset: null }),
      createMarkerImpl: () => assert.fail("must not replace the marker"),
    }),
    /marker exists without an offset/u,
  );
});

void test("an existing offset upgrades by writing a private marker without dropping", async (t) => {
  const { markerFile, lease } = await temporaryStartup(t);
  const state = await prepareTelegramStartup(lease, {
    markerFile,
    loadOffsetImpl: () => Promise.resolve({ offset: 42 }),
  });

  assert.deepEqual(state, { firstRun: false, offset: 42 });
  assert.equal((await stat(markerFile)).mode & 0o777, 0o600);
});

void test("corrupt and invalid-UTF-8 marker bytes fail closed and remain unchanged", async (t) => {
  for (const bytes of [
    Buffer.from('{"schema":"wrong"}'),
    Buffer.from([0xff]),
  ]) {
    const { markerFile, lease } = await temporaryStartup(t);
    await writeFile(markerFile, bytes);
    await assert.rejects(
      prepareTelegramStartup(lease, {
        markerFile,
        loadOffsetImpl: () => Promise.resolve({ offset: null }),
      }),
      /failed to load Telegram backlog marker/u,
    );
    assert.deepEqual(await readFile(markerFile), bytes);
  }
});

void test("startup rejects fabricated and released leases before reading state", async (t) => {
  let stateRead = false;
  const options = {
    loadOffsetImpl: () => {
      stateRead = true;
      return Promise.resolve({ offset: null });
    },
  };
  await assert.rejects(
    prepareTelegramStartup({} as TelegramProcessLease, options),
    /requires an active process lease/u,
  );
  assert.equal(stateRead, false);

  const { lease } = await temporaryStartup(t);
  await lease.close();
  await assert.rejects(
    prepareTelegramStartup(lease, options),
    /requires an active process lease/u,
  );
  assert.equal(stateRead, false);
});

void test("main is the only production caller and passes its held lease", async () => {
  const callers: string[] = [];
  for await (const relative of glob("scripts/**/*.{ts,mjs}", { cwd: ROOT })) {
    if (
      relative.endsWith(".test.ts") ||
      relative.includes("/fixtures/") ||
      relative.endsWith("/startup-state.ts")
    ) {
      continue;
    }
    const source = await readFile(join(ROOT, relative), "utf8");
    if (/\bprepareTelegramStartup\s*\(/u.test(source)) callers.push(relative);
  }
  assert.deepEqual(callers, ["scripts/poller/main.ts"]);
  const mainSource = await readFile(join(ROOT, callers[0]), "utf8");
  assert.match(
    mainSource,
    /const processLease = await acquireProcessLockImpl\(\);[\s\S]*prepareTelegramStartup\(processLease\)/u,
  );
  assert.match(
    mainSource,
    /for \(;;\) \{\s+assertTelegramProcessLease\(processLease\);/u,
  );
  assert.match(
    mainSource,
    /void main\(\)\.catch/u,
    "the production entrypoint must use the immutable uid-global default",
  );
});

void test("property: startup decision is total and fail-closed", () => {
  fc.assert(
    fc.property(
      fc.option(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), {
        nil: null,
      }),
      fc.boolean(),
      (offset, markerPresent) => {
        const decision = decideTelegramStartup(
          { offset },
          markerPresent ? "present" : "missing",
        );
        if (offset === null && markerPresent) {
          assert.equal(decision.action, "ambiguous");
          return;
        }
        if (offset === null) {
          assert.equal(decision.action, "write-marker-and-drop");
          return;
        }
        assert.equal(
          decision.action,
          markerPresent ? "resume" : "write-marker-and-resume",
        );
        assert.equal(decision.offset, offset);
      },
    ),
    { seed: SEED, numRuns: 2_000 },
  );
});
