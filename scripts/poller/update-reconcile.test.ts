/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { writeFileAtomic } from "#lib/fs-atomic.ts";
import { createVersionStore } from "../lib/version-store.ts";

const dataDir = realpathSync(
  mkdtempSync(join(tmpdir(), "iva-update-reconcile-")),
);
process.env.ASSISTANT_DATA_DIR = dataDir;
writeFileSync(
  join(dataDir, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
);
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

type Reconcile = (options: {
  root?: string;
  tickMs?: number;
  graceMs?: number;
  /** Обязателен и здесь: тест, забывший подставить свой запуск, самообновлял бы чекаут. */
  launchImpl: (jobId: string) => Promise<{ ok: boolean; msg: string }>;
}) => Promise<Promise<void>[]>;

/** Повтор в этом тесте не ожидается: запуск отвечает отказом и никуда не ходит. */
const refuseLaunch = (): Promise<{ ok: boolean; msg: string }> =>
  Promise.resolve({ ok: false, msg: "no launch is expected here" });

const { reconcileUpdateJobs } = (await import(
  `./update-flow.ts?reconcile=${Date.now()}`
)) as { reconcileUpdateJobs: Reconcile };

const OLD = "0.3.17-aaaaaaaaaaaa";
const NEW = "0.3.18-bbbbbbbbbbbb";
/** A build an older update already failed on, still on disk when the next one runs. */
const STALE = "0.3.16-cccccccccccc";
const jobsDir = join(dataDir, "update-jobs");
const lockDir = join(dataDir, "update.lock");

type Call = { method: string; text: string };
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
type Answer = { ok: boolean; status: number; body: Record<string, unknown> };
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

const accepted: Answer = {
  ok: true,
  status: 200,
  body: { ok: true, result: { message_id: 10 } },
};
const refused = (description: string): Answer => ({
  ok: false,
  status: 400,
  body: { ok: false, description },
});

/** Telegram, as far as the reporter can tell; every call is kept in order. */
function telegram(
  t: TestContext,
  reply: (method: string, call: number) => Answer = () => accepted,
): Call[] {
  const calls: Call[] = [];
  const previous = mutableGlobal.fetch;
  t.after(() => {
    mutableGlobal.fetch = previous;
  });
  mutableGlobal.fetch = (url, init) => {
    const method = url.split("/").at(-1) ?? "";
    const body = JSON.parse(init.body) as {
      text?: string;
      rich_message?: { markdown?: string };
    };
    // Финальные экраны обновления — rich: их markdown лежит в rich_message.markdown.
    calls.push({
      method,
      text: body.rich_message?.markdown ?? body.text ?? "",
    });
    const answer = reply(method, calls.length);
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    });
  };
  return calls;
}

/** An installation on the immutable layout, with `current` where the bridge finds it. */
function install(t: TestContext, current: string = NEW): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-reconcile-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The state directories are the ones this test's bridge already reads.
  writeFileSync(join(home, ".env"), `ASSISTANT_DATA_DIR=${dataDir}\n`);
  mkdirSync(join(home, "versions", current), { recursive: true });
  symlinkSync(join(home, "versions", current), join(home, "current"));
  return join(home, "current");
}

/**
 * The same installation, built the way an update builds one: the store stages both
 * versions and flips `current` itself. Nothing here is arranged by hand, so a test
 * on top of it exercises the code that moves an installation rather than a fixture
 * shaped like its result.
 */
function installation(t: TestContext): {
  store: ReturnType<typeof createVersionStore>;
  root: string;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-reconcile-home-")));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(join(dataDir, "live-failures.json"), { force: true });
  });
  writeFileSync(join(home, ".env"), `ASSISTANT_DATA_DIR=${dataDir}\n`);
  const store = createVersionStore(home);
  for (const name of [OLD, NEW]) {
    store.stage(name);
    store.complete(name);
  }
  store.activate(OLD); // What the box runs as the tap is made.
  return { store, root: join(home, "current") };
}

function clean(t: TestContext): void {
  rmSync(jobsDir, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
  rmSync(join(dataDir, "active.json"), { force: true });
  t.after(() => {
    rmSync(jobsDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(join(dataDir, "active.json"), { force: true });
  });
}

/**
 * A job whose update was already restarted once - the claim `<job>.retried` beside it.
 * That is the state every test below reads about, because the first break is answered by
 * a retry (retryInterruptedUpdate) and only the second one is left to the evidence on
 * disk and the TTL. A test about the retry itself passes `retried: false`.
 */
function job(
  id: string,
  body: Record<string, unknown>,
  retried = true,
): string {
  const path = join(jobsDir, `${id}.json`);
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  if (retried) writeFileSync(`${path}.retried`, "", { mode: 0o600 });
  return path;
}

const outcome = (before: string | undefined, after: string) => ({
  schema: "iva-update-outcome/v1",
  status: "updated",
  ...(before ? { before } : {}),
  after,
  custom: "none",
  finishedAt: new Date().toISOString(),
});

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const settleMarker = (version: string, settledAt: string): void =>
  writeFileSync(
    join(dataDir, "active.json"),
    JSON.stringify({ schema: "iva-active/v2", version, settledAt }),
  );

const finals = (calls: readonly Call[]): string[] =>
  calls.filter((call) => call.method === "editMessageText").map((c) => c.text);

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("an outcome left by a dead updater is delivered exactly and only once", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t, (_method, call) =>
    // The retry after a crash finds the message already saying it: Telegram's
    // own answer to an identical edit is what makes a second delivery a no-op.
    call === 1 ? accepted : refused("Bad Request: message is not modified"),
  );
  const path = job("first", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });

  assert.deepEqual(
    await reconcileUpdateJobs({ launchImpl: refuseLaunch, root }),
    [],
  );
  assert.equal(existsSync(path), false, "the answered job is gone");

  // The same job again: a bridge killed between the edit and the unlink.
  job("first", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });
  await reconcileUpdateJobs({ launchImpl: refuseLaunch, root });

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 2, calls.map((c) => c.text).join(" | "));
  assert.equal(
    new Set(finals(calls)).size,
    1,
    "both attempts carry the same final screen",
  );
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}`, "u"));
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
});

test("a delivery Telegram refuses keeps the job for the next start", async (t) => {
  clean(t);
  const root = install(t);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls = telegram(t, () => refused("Bad Request: chat not found"));
  const path = job("refused", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(2),
    currentAtStart: OLD,
    outcome: outcome(OLD, NEW),
  });

  await reconcileUpdateJobs({ launchImpl: refuseLaunch, root });

  assert.equal(existsSync(path), true, "an undelivered final is not dropped");
  // Финал — rich-экран: отказанную правку reporter добивает sendRichMessage'ом.
  assert.equal(
    calls.filter((call) => call.method === "sendRichMessage").length,
    1,
  );
  assert.ok(
    errors.some((line) => /chat not found/u.test(line)),
    errors.join("\n"),
  );
});

test(
  "a job file that cannot be removed costs the chat nothing else",
  {
    // Permissions do not apply to root, so neither does the failure being proved.
    skip: process.getuid?.() === 0 && "root writes through any directory",
  },
  async (t) => {
    clean(t);
    const root = install(t);
    const lines: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) =>
      lines.push(args.map(String).join(" ")),
    );
    const calls = telegram(t);
    const body = {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(2),
      currentAtStart: OLD,
      outcome: outcome(OLD, NEW),
    };
    const first = job("stuck-a", body);
    const second = job("stuck-b", { ...body, messageId: 101 });
    // A read-only jobs directory: every final goes out, no job file can be unlinked.
    // This runs before the first poll, so a throw here is a bridge that never polls.
    chmodSync(jobsDir, 0o555);
    try {
      assert.deepEqual(
        await reconcileUpdateJobs({ launchImpl: refuseLaunch, root }),
        [],
        "no watchers",
      );
    } finally {
      chmodSync(jobsDir, 0o755);
    }

    assert.equal(finals(calls).length, 2, finals(calls).join(" | "));
    assert.equal(
      existsSync(first),
      true,
      "an undeletable job waits for the TTL",
    );
    assert.equal(existsSync(second), true, "and so does the one behind it");
    assert.ok(
      lines.filter((line) => /update job reconcile failed/u.test(line))
        .length === 2,
      lines.join("\n"),
    );
  },
);

test(
  "a watched job whose file cannot be removed is still answered once",
  {
    // Permissions do not apply to root, so neither does the failure being proved.
    skip: process.getuid?.() === 0 && "root writes through any directory",
  },
  async (t) => {
    clean(t);
    const root = install(t);
    const lines: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) =>
      lines.push(args.map(String).join(" ")),
    );
    const calls = telegram(t);
    const body = {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(2),
      currentAtStart: OLD,
    };
    const path = job("watched-stuck", body);

    // No outcome yet, so the job is watched rather than answered on the spot.
    const watchers = await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 10_000, // Long enough that only the outcome below ends the watch.
    });
    assert.equal(watchers.length, 1, "a job with no outcome is watched");

    // The updater's verdict lands under the watcher, into a directory nothing may
    // unlink from any more: the final is owed, the file cannot go.
    writeFileSync(
      path,
      JSON.stringify({ ...body, outcome: outcome(OLD, NEW) }),
    );
    chmodSync(jobsDir, 0o555);
    let watched = false;
    const finished = Promise.all(watchers).then(() => {
      watched = true;
    });
    try {
      // A watcher that survives its own unlink stops here; one that does not comes
      // back every tick, so the window is what counts the repeats.
      await Promise.race([finished, wait(120)]);
    } finally {
      chmodSync(jobsDir, 0o755);
    }

    assert.equal(finals(calls).length, 1, finals(calls).join(" | "));
    assert.equal(watched, true, "a delivered final ends the watch");
    assert.equal(
      calls.filter((call) => call.method === "sendMessage").length,
      0,
      calls.map((call) => `${call.method}: ${call.text}`).join(" | "),
    );
    assert.equal(
      existsSync(path),
      true,
      "an undeletable job waits for the TTL",
    );
    assert.ok(
      lines.some((line) => /update job file left on disk/u.test(line)),
      lines.join("\n"),
    );
    assert.equal(
      lines.filter((line) => /update job watch failed/u.test(line)).length,
      0,
      lines.join("\n"),
    );
  },
);

test("a job killed after the flip is answered from what the installation says", async (t) => {
  for (const settledAt of [minutesAgo(1)]) {
    await t.test(`settle marker time: ${settledAt}`, async (st) => {
      clean(st);
      const root = install(st);
      settleMarker(NEW, settledAt);
      const calls = telegram(st);
      const path = job("killed", {
        chatId: 1,
        messageId: 100,
        locale: "en",
        startedAt: minutesAgo(3),
        currentAtStart: OLD,
      });

      const watchers = await reconcileUpdateJobs({
        launchImpl: refuseLaunch,
        root,
        tickMs: 5,
        graceMs: 15,
      });
      assert.equal(watchers.length, 1, "a job with no outcome is watched");
      await Promise.all(watchers);

      assert.equal(existsSync(path), false);
      assert.deepEqual(finals(calls).length, 1, finals(calls).join(" | "));
      assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}`, "u"));
    });
  }
});

test("an outcome that arrives while the job is watched wins over the guess", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const path = job("late", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
  });
  // The lock is held by a live process, exactly as an updater in the middle of a
  // build holds it: nothing may be said about the update while it runs.
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  const watchers = await reconcileUpdateJobs({
    launchImpl: refuseLaunch,
    root,
    tickMs: 5,
    graceMs: 10,
  });
  await wait(60);
  assert.deepEqual(calls, [], "a running update is never reported on");

  writeFileSync(
    path,
    JSON.stringify({
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(1),
      currentAtStart: OLD,
      outcome: outcome(OLD, `${NEW}~2`),
    }),
  );
  rmSync(lockDir, { recursive: true, force: true });
  await Promise.all(watchers);

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 1);
  assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}~2`, "u"));
});

test("a job from a bridge that never named a version falls back to the settle marker", async (t) => {
  clean(t);
  const root = install(t);
  settleMarker(NEW, minutesAgo(1));
  const calls = telegram(t);
  const path = job("transitional", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.equal(existsSync(path), false);
  assert.equal(finals(calls).length, 1);
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`Version: ${NEW}`, "u"));
  assert.doesNotMatch(finals(calls)[0], /→/u);
});

test("nothing is said when no evidence says the update finished", async (t) => {
  clean(t);
  const root = install(t);
  // The last move predates the tap: this settle marker is somebody else's.
  settleMarker(NEW, minutesAgo(90));
  const calls = telegram(t);
  const path = job("unproven", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(calls, [], "a false ✅ is worse than a spinner");
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a rollback is never a ✅ on a job that never named its version", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  const calls = telegram(t);
  const path = job("rolled-back", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  // The rollback out of version-update.ts, step for step and through the store
  // itself: the new build is flipped in, the service does not answer on its port,
  // the dead build is recorded, the installation goes back and settles where it
  // started. The gap is the restart and the health deadline that really sit here.
  store.activate(NEW);
  await wait(25);
  store.recordLive(NEW, false);
  store.activate(OLD);
  store.settle(OLD);

  assert.equal(store.currentName(), OLD, "the box runs what it started on");
  // Where the mtime reading broke: activating OLD relinks state inside it, so the
  // build the rollback went back to is the newest directory and the running one at
  // once, and a rollback looks exactly like an update that stuck.
  if (store.list()[0] === OLD)
    t.diagnostic("the rollback left the old build newest on disk");

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(
    calls,
    [],
    "the version that failed is not one to celebrate",
  );
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("an update that stuck is still a ✅ on a job that never named its version", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  const calls = telegram(t);
  const path = job("stuck", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
  });

  // The same steps where the service does come up: flip, a live record that says
  // so, settle on the new build. The version left behind is not one that failed,
  // so nothing here may swallow the final the user is owed.
  store.activate(NEW);
  await wait(25);
  store.recordLive(NEW, true);
  store.settle(NEW);

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.equal(existsSync(path), false, "the answered job is gone");
  assert.equal(finals(calls).length, 1, finals(calls).join(" | "));
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`Version: ${NEW}`, "u"));
  assert.doesNotMatch(finals(calls)[0], /→/u);
});

test("a rollback out of a resumed flip is never a ✅ on the version it left", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  const calls = telegram(t);
  // Where the previous update died: `current` is already the new build, nothing
  // else about the move finished. The tap that follows names what it finds.
  store.activate(NEW);
  const path = job("resumed", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
    currentAtStart: NEW,
  });

  // The resumed run out of version-update.ts: it finishes the move onto the build
  // already linked in, the service does not answer after the restart, and it goes
  // back the same way - the dead build on record, the old one active and settled.
  await wait(25);
  store.recordLive(NEW, false);
  store.activate(OLD);
  store.settle(OLD);

  assert.equal(store.currentName(), OLD, "the box is back where it came from");

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(calls, [], "a downgrade is not an update to announce");
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a rollback that never happened is never a ✅ on the version it died on", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  store.settle(OLD); // Where the box has been sitting since the last update.
  const calls = telegram(t);
  const path = job("half-rolled-back", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
    currentAtStart: OLD,
  });

  // version-update.ts kills the updater between the two lines that undo a bad flip:
  // the dead build is on record, the activate(back) that would have moved off it
  // never runs. `current` is the new build, the service is down on it, and nothing
  // settled - the only process left to speak is this bridge, which systemd restarts
  // on its own unit.
  store.activate(NEW);
  await wait(25);
  store.recordLive(NEW, false);

  assert.equal(store.currentName(), NEW, "the box is stuck on the dead build");
  assert.equal(store.settled(), OLD, "the move never settled");

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(
    calls,
    [],
    "a ✅ over a dead agent is the worst final of all",
  );
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a flip nobody has judged yet is never a ✅", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  const calls = telegram(t);
  const path = job("unjudged", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
    currentAtStart: OLD,
  });

  // Where the updater really dies: the flip is one line, and the migrations, the
  // vault cleanup, the restart and the whole health deadline come after it. Killed
  // in there it leaves `current` on the new build and a verdict on nothing - no
  // live failure, no settle marker - which is exactly what a box whose agent is
  // down looks like from here.
  store.activate(NEW);
  await wait(25);

  assert.equal(store.currentName(), NEW, "the box stands on the new build");
  assert.equal(store.liveFailed(NEW), false, "no verdict was ever recorded");
  assert.equal(store.settled(), null, "and the move never settled");

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(
    calls,
    [],
    "a move that never finished is not one to announce",
  );
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("a verdict pushed out of the failure list is still not a ✅", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  store.settle(OLD); // Where the box has been sitting since the last update.
  const calls = telegram(t);
  const path = job("forgotten-verdict", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
    currentAtStart: OLD,
  });

  // The dead flip of the test above it, plus time: the failure list keeps only the
  // last few builds, so the updates that follow push this verdict out of it. The
  // failure guard goes blind at that point; what the box did not do - settle onto
  // the build it stands on - it still has not done.
  store.activate(NEW);
  await wait(25);
  store.recordLive(NEW, false);
  for (let i = 1; i <= 8; i++)
    store.recordLive(`0.3.${i}-${String(i).repeat(12)}`, false);

  assert.equal(store.currentName(), NEW, "the box is stuck on the dead build");
  assert.equal(store.liveFailed(NEW), false, "its verdict has been forgotten");
  assert.equal(store.settled(), OLD, "the move never settled");

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.deepEqual(calls, [], "a forgotten failure is not a success");
  assert.equal(existsSync(path), true, "the job waits for the TTL");
});

test("an old failure on disk does not swallow the ✅ of an update that stuck", async (t) => {
  clean(t);
  const { store, root } = installation(t);
  // Somebody else's failure, left where a previous rollback left it: present, not
  // running, on record as dead. It says nothing about the update running now.
  store.stage(STALE);
  store.complete(STALE);
  store.recordLive(STALE, false);
  const calls = telegram(t);
  const path = job("honest", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(5),
    currentAtStart: OLD,
  });

  // The move that worked: flipped in, alive on its port, settled on the new build.
  store.activate(NEW);
  await wait(25);
  store.recordLive(NEW, true);
  store.settle(NEW);

  assert.equal(
    store.liveFailed(STALE),
    true,
    "the old corpse is still on disk",
  );

  await Promise.all(
    await reconcileUpdateJobs({
      launchImpl: refuseLaunch,
      root,
      tickMs: 5,
      graceMs: 15,
    }),
  );

  assert.equal(existsSync(path), false, "the answered job is gone");
  assert.equal(finals(calls).length, 1, finals(calls).join(" | "));
  assert.match(finals(calls)[0], /Iva updated/u);
  assert.match(finals(calls)[0], new RegExp(`${OLD} → ${NEW}`, "u"));
});

test("a job the updater answered itself is dropped without a second word", async (t) => {
  clean(t);
  // Nothing was installed, so nothing flipped: the updater reported the failure
  // through its own reporter and took the job file with it.
  const root = install(t, OLD);
  const calls = telegram(t);
  const path = job("failed", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
  });

  const watchers = await reconcileUpdateJobs({
    launchImpl: refuseLaunch,
    root,
    tickMs: 5,
    graceMs: 15,
  });
  rmSync(path, { force: true });
  await Promise.all(watchers);

  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(jobsDir), []);
});

/** Deterministic noise: the seed is printed, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("an outcome written under a reader is never read half-written", async (t) => {
  clean(t);
  const seed = Number(process.env.IVA_TEST_SEED ?? Date.now() % 2 ** 31);
  console.log(`randomized outcome interleaving seed: ${seed}`);
  t.diagnostic(`seed ${seed}`);
  const random = mulberry32(seed);
  const before = {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
    // Long enough that a plain write would need more than one page.
    padding: "x".repeat(64 * 1024),
  };
  const path = job("racy", before);
  const after = { ...before, outcome: outcome(OLD, NEW) };

  let reads = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(parsed && typeof parsed === "object");
      const seen = parsed as { padding?: string; outcome?: unknown };
      assert.equal(seen.padding, before.padding, "a whole job, never a piece");
      assert.ok(seen.outcome === undefined || typeof seen.outcome === "object");
      reads += 1;
      if (random() < 0.3) await wait(0);
    }
  })();

  for (let round = 0; round < 30; round++) {
    await wait(Math.floor(random() * 3));
    await writeFileAtomic(
      path,
      JSON.stringify(round % 2 === 0 ? after : before),
      { mode: 0o600 },
    );
  }
  stop = true;
  await reader;

  assert.ok(reads > 30, `the reader ran ${reads} times`);
});

test("an interrupted update is restarted once, and the chat is told", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const launched: string[] = [];
  const path = job(
    "broken",
    {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(1),
      currentAtStart: OLD,
    },
    false,
  );

  const watchers = await reconcileUpdateJobs({
    root,
    tickMs: 5,
    graceMs: 10,
    launchImpl: (jobId) => {
      launched.push(jobId);
      return Promise.resolve({ ok: true, msg: "" });
    },
  });
  await Promise.all(watchers);

  assert.deepEqual(launched, ["broken"], "the same job is handed back");
  assert.match(finals(calls)[0] ?? "", /interrupted, retrying/u);
  // Заявка рядом с job - то, чем один повтор отличается от бесконечного.
  assert.equal(existsSync(`${path}.retried`), true);
  const marked = JSON.parse(readFileSync(path, "utf8")) as { chatId?: unknown };
  assert.equal(marked.chatId, 1, "the job keeps the chat it must answer");
});

test("an update that is still running is never restarted under it", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const launched: string[] = [];
  const path = job(
    "running",
    {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(1),
      currentAtStart: OLD,
    },
    false,
  );
  // Живой владелец лока: обновление идёт, второй обновлятор рядом с ним - катастрофа.
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );

  const watchers = await reconcileUpdateJobs({
    root,
    tickMs: 5,
    graceMs: 10,
    launchImpl: (jobId) => {
      launched.push(jobId);
      return Promise.resolve({ ok: true, msg: "" });
    },
  });
  rmSync(lockDir, { recursive: true, force: true });
  await Promise.all(watchers);

  assert.deepEqual(launched, []);
  assert.deepEqual(calls, []);
  assert.equal(
    existsSync(`${path}.retried`),
    false,
    "the job is left for the next start exactly as it was",
  );
});

test("a job whose update was already retried is left to the ttl", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const launched: string[] = [];
  const path = job("second-break", {
    chatId: 1,
    messageId: 100,
    locale: "en",
    startedAt: minutesAgo(1),
    currentAtStart: OLD,
  });

  const watchers = await reconcileUpdateJobs({
    root,
    tickMs: 5,
    graceMs: 10,
    launchImpl: (jobId) => {
      launched.push(jobId);
      return Promise.resolve({ ok: true, msg: "" });
    },
  });
  await Promise.all(watchers);

  assert.deepEqual(launched, [], "one break, one retry");
  assert.deepEqual(calls, []);
  assert.equal(existsSync(path), true);
});

test("a retry whose launch fails says nothing and is not tried again", async (t) => {
  clean(t);
  const root = install(t);
  const calls = telegram(t);
  const launched: string[] = [];
  const path = job(
    "launch-fails",
    {
      chatId: 1,
      messageId: 100,
      locale: "en",
      startedAt: minutesAgo(1),
      currentAtStart: OLD,
    },
    false,
  );

  const watchers = await reconcileUpdateJobs({
    root,
    tickMs: 5,
    graceMs: 10,
    launchImpl: (jobId) => {
      launched.push(jobId);
      return Promise.resolve({ ok: false, msg: "systemd-run: not found" });
    },
  });
  await Promise.all(watchers);

  assert.deepEqual(launched, ["launch-fails"]);
  // Обещать чату повтор, которого не было, нельзя: экран остаётся прежним, дальше TTL.
  assert.deepEqual(finals(calls), []);
  // Заявка израсходована: следующий старт моста не запускает обновление второй раз.
  assert.equal(existsSync(`${path}.retried`), true);
  assert.equal(existsSync(path), true);
});
