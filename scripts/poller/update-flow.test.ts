/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { tempDir } from "../fixtures/temp-dir.ts";

const dataDir = tempDir("iva-update-flow-");
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.env.TELEGRAM_BOT_TOKEN = "token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";

const { handleUpdateCallback, handleUpdateCheck, removeStaleUpdateJobs } =
  (await import(`./update-flow.ts?characterize=${Date.now()}`)) as {
    handleUpdateCallback: (query: {
      id: string;
      from: { id: number };
      message: { chat: { id: number }; message_id: number };
      data: string;
    }) => Promise<boolean>;
    handleUpdateCheck: (
      chatId: number,
      options: {
        root?: string;
        inspectImpl?: () => Promise<{
          hasCommitUpdate: boolean;
          hasVersionUpdate: boolean;
          localVersion?: string | null;
          remoteVersion?: string | null;
        }>;
        markNotifiedImpl?: (dataDir: string, version: string) => Promise<void>;
        envImpl?: () => Promise<NodeJS.ProcessEnv>;
        force?: boolean;
      },
    ) => Promise<boolean>;
    removeStaleUpdateJobs: () => Promise<void>;
  };

/** Текст экрана из тела вызова Telegram: финальные экраны — rich (markdown), начальные — text. */
function screenText(body: {
  text?: unknown;
  rich_message?: { markdown?: unknown };
}): string {
  const markdown = body.rich_message?.markdown;
  if (typeof markdown === "string") return markdown;
  return typeof body.text === "string" ? body.text : "";
}

test("stale update-job cleanup removes only expired JSON job files", async () => {
  const jobs = join(dataDir, "update-jobs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(jobs));
  const oldJob = join(jobs, "old.json");
  const freshJob = join(jobs, "fresh.json");
  const other = join(jobs, "keep.txt");
  writeFileSync(oldJob, "{}");
  writeFileSync(freshJob, "{}");
  writeFileSync(other, "keep");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(oldJob, old, old);

  await removeStaleUpdateJobs();

  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(freshJob)),
  );
  await assert.doesNotReject(() =>
    import("node:fs/promises").then(({ stat }) => stat(other)),
  );
  await assert.rejects(() =>
    import("node:fs/promises").then(({ stat }) => stat(oldJob)),
  );
});

/**
 * Заявка на повтор - часть своего job: TTL судит job, а не её собственный mtime.
 * Иначе свежий job остаётся без заявки, и обрыв повторяется второй раз.
 */
test("the retry claim outlives the sweep while its job does", async () => {
  const jobs = join(dataDir, "update-jobs");
  mkdirSync(jobs, { recursive: true });
  const fresh = join(jobs, "live.json");
  const claim = `${fresh}.retried`;
  const orphan = join(jobs, "gone.json.retried");
  writeFileSync(fresh, "{}");
  writeFileSync(claim, "");
  writeFileSync(orphan, "");
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(claim, old, old);
  utimesSync(orphan, old, old);

  await removeStaleUpdateJobs();

  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(claim), true);
  // Заявка, чей job уже убрали, - мусор: уходит вместе с ним, не живёт вечно.
  assert.equal(existsSync(orphan), false);
});

type MockFetch = (
  url: string,
  init: { body?: string },
) => Promise<{ json(): Promise<{ ok: boolean; result: unknown }> }>;
const mutableGlobal: { fetch: MockFetch } = globalThis;

for (const scenario of [
  {
    name: "inspect failure",
    inspectImpl: (): Promise<never> =>
      Promise.reject(new Error("inspect failed")),
  },
  {
    name: "current version",
    inspectImpl: () =>
      Promise.resolve({
        hasCommitUpdate: false,
        hasVersionUpdate: false,
        localVersion: "1.2.3",
        remoteVersion: "1.2.3",
      }),
  },
  {
    name: "update offer",
    inspectImpl: () =>
      Promise.resolve({
        hasCommitUpdate: true,
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
      }),
  },
] as const) {
  test(`/update ${scenario.name} is retained when its final edit returns null`, async () => {
    const methods: string[] = [];
    const previousFetch = mutableGlobal.fetch;
    mutableGlobal.fetch = (url) => {
      const method = url.split("/").at(-1) ?? "";
      methods.push(method);
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            result: method === "sendMessage" ? { message_id: 73 } : null,
          }),
      });
    };
    try {
      assert.equal(
        await handleUpdateCheck(1, {
          inspectImpl: scenario.inspectImpl,
          markNotifiedImpl: () => Promise.resolve(),
          envImpl: () => Promise.resolve({ MODEL_PROVIDER: "codex" }),
        }),
        false,
      );
    } finally {
      mutableGlobal.fetch = previousFetch;
    }
    assert.deepEqual(methods, ["sendMessage", "editMessageText"]);
  });
}

/**
 * Tap the /update button and collect the texts Telegram was sent. `systemd-run`
 * is a stand-in that records the command line: the launch is real, the update
 * behind it is not.
 */
async function press(launcher: string): Promise<string[]> {
  // This fixture characterizes the Linux transient-unit path even on a Mac.
  writeFileSync(join(launcher, "systemctl"), "#!/bin/sh\nexit 97\n", {
    mode: 0o755,
  });
  const texts: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  const previousPath = process.env.PATH;
  mutableGlobal.fetch = (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as {
      text?: unknown;
      rich_message?: { markdown?: unknown };
    };
    const text = screenText(body);
    if (text) texts.push(text);
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  };
  process.env.PATH = launcher;
  try {
    await handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:do",
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
    process.env.PATH = previousPath;
  }
  return texts;
}

test("invalid update callback data only clears the Telegram spinner", async () => {
  const methods: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (url) => {
    methods.push(url.split("/").at(-1) ?? "");
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: {} }),
    });
  };
  try {
    await handleUpdateCallback({
      id: "invalid-callback",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:garbage",
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  assert.deepEqual(methods, ["answerCallbackQuery"]);
});

test("skip callback is retained when only spinner ack succeeds", async () => {
  const methods: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (url) => {
    const method = url.split("/").at(-1) ?? "";
    methods.push(method);
    return Promise.resolve({
      json: () =>
        Promise.resolve(
          method === "answerCallbackQuery"
            ? { ok: true, result: true }
            : { ok: false, result: false },
        ),
    });
  };
  try {
    const handled = await handleUpdateCallback({
      id: "failed-skip",
      from: { id: 42 },
      message: { chat: { id: 1 }, message_id: 10 },
      data: "iva_update:skip",
    });
    assert.equal(handled, false);
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  assert.deepEqual(methods, ["answerCallbackQuery", "editMessageText"]);
});

test("the /update button leaves the lock to the update it launches", async (t) => {
  const lock = join(dataDir, "update.lock");
  const jobs = join(dataDir, "update-jobs");
  rmSync(jobs, { recursive: true, force: true }); // The cleanup test's leftovers.
  const launched = join(dataDir, "launched.log");
  const bin = join(dataDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "systemd-run"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${launched}"\nexit 0\n`,
    { mode: 0o755 },
  );
  t.after(() => {
    for (const path of [lock, jobs, bin, launched])
      rmSync(path, { recursive: true, force: true });
  });

  const first = await press(bin);

  assert.match(first.at(-1) ?? "", /Starting the update/u);
  const command = readFileSync(launched, "utf8");
  assert.match(command, /update --telegram-job [0-9a-f]/u);
  assert.match(command, new RegExp(`--setenv=ASSISTANT_DATA_DIR=${dataDir}`));
  assert.equal(
    readdirSync(jobs).length,
    1,
    "the update has its job to report to",
  );
  // Nothing claimed on the updater's behalf: a lock taken here would never be
  // released - this process outlives the update and is restarted by it - and the
  // updater, seeing an owner that is alive, would refuse to run at all.
  assert.equal(existsSync(lock), false, first.join(" | "));

  // So a second tap is answered by starting an update, not by a wedged lock.
  assert.match((await press(bin)).at(-1) ?? "", /Starting the update/u);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(jobs).length, 2);

  // A launcher that fails takes the job file back down with it, and names the reason.
  writeFileSync(
    join(bin, "systemd-run"),
    `#!/bin/sh\necho 'Failed to connect to bus: No such file or directory' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const failed = (await press(bin)).at(-1) ?? "";
  assert.match(failed, /Couldn't start the update/u);
  assert.match(failed, /Failed to connect to bus/u);
  assert.equal(readdirSync(jobs).length, 2);

  // And an update that is really running is answered before anything is launched.
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  assert.deepEqual(await press(bin), ["⚠️ An update is already running"]);
  assert.equal(readdirSync(jobs).length, 2);
});

test("/update --force starts a rebuild of the running version without asking upstream", async (t) => {
  const jobs = join(dataDir, "update-jobs");
  rmSync(jobs, { recursive: true, force: true });
  const bin = join(dataDir, "bin-force");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 97\n", {
    mode: 0o755,
  });
  writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  t.after(() => {
    for (const path of [jobs, bin])
      rmSync(path, { recursive: true, force: true });
  });
  const texts: string[] = [];
  let inspected = 0;
  const previousFetch = mutableGlobal.fetch;
  const previousPath = process.env.PATH;
  mutableGlobal.fetch = (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as {
      text?: unknown;
      rich_message?: { markdown?: unknown };
    };
    const text = screenText(body);
    if (text) texts.push(text);
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: { message_id: 10 } }),
    });
  };
  process.env.PATH = bin;
  try {
    assert.equal(
      await handleUpdateCheck(1, {
        force: true,
        inspectImpl: () => {
          inspected += 1;
          return Promise.reject(new Error("must not be asked"));
        },
        markNotifiedImpl: () => Promise.resolve(),
        envImpl: () => Promise.resolve({}),
      }),
      true,
    );
  } finally {
    mutableGlobal.fetch = previousFetch;
    process.env.PATH = previousPath;
  }
  assert.equal(inspected, 0);
  assert.match(texts[0] ?? "", /Rebuilding the current version/u);
  assert.match(texts.at(-1) ?? "", /Starting the update/u);
  const [name] = readdirSync(jobs);
  const job = JSON.parse(readFileSync(join(jobs, name), "utf8")) as {
    force?: unknown;
  };
  assert.equal(job.force, true, "the flag travels in the job file");
});

/** git in a directory, with an identity, so a commit needs no ambient config. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "iva",
      GIT_AUTHOR_EMAIL: "iva@example.com",
      GIT_COMMITTER_NAME: "iva",
      GIT_COMMITTER_EMAIL: "iva@example.com",
    },
  }).trim();
}

/**
 * An installation as the bridge leaves it: no working tree, history only in the
 * bare mirror, and the running code reached through `current`. Exactly the layout
 * every converted user has, and the one a checkout-era update check dies on.
 */
function converted(t: TestContext, { mirror = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-converted-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source");
  const home = join(dir, "iva");
  mkdirSync(source, { recursive: true });
  const release = (version: string): void =>
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify({ name: "iva", version })}\n`,
    );
  release("0.3.15");
  git(source, ["init", "--initial-branch=main"]);
  git(source, ["add", "-A"]);
  git(source, ["commit", "-m", "initial"]);
  // A release is a vX.Y.Z tag: an update without beta updates installs only those.
  git(source, ["tag", "v0.3.15"]);
  const sha = git(source, ["rev-parse", "HEAD"]);

  const name = `0.3.15-${sha.slice(0, 12)}`;
  mkdirSync(join(home, "versions", name), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(join(home, "versions", name), join(home, "current"));
  if (mirror) git(dir, ["clone", "-q", "--mirror", source, join(home, "repo")]);
  return {
    /** What the poller's own ROOT is on a converted box. */
    root: join(home, "current"),
    home,
    source,
    publish: (version: string): void => {
      release(version);
      git(source, ["add", "-A"]);
      git(source, ["commit", "-m", `release ${version}`]);
      git(source, ["tag", `v${version}`]);
    },
  };
}

/** Drives /update with the real upstream check and returns what Telegram was told. */
async function check(root: string): Promise<string[]> {
  const texts: string[] = [];
  const previousFetch = mutableGlobal.fetch;
  mutableGlobal.fetch = (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as {
      text?: unknown;
      rich_message?: { markdown?: unknown };
    };
    const text = screenText(body);
    if (text) texts.push(text);
    return Promise.resolve({
      json: () => Promise.resolve({ ok: true, result: { message_id: 10 } }),
    });
  };
  try {
    await handleUpdateCheck(1, {
      root,
      markNotifiedImpl: () => Promise.resolve(),
      envImpl: () => Promise.resolve({ MODEL_PROVIDER: "codex" }),
    });
  } finally {
    mutableGlobal.fetch = previousFetch;
  }
  return texts;
}

test("/update offers the new release on an installation with no working tree", async (t) => {
  const install = converted(t);
  install.publish("0.3.16");

  const texts = await check(install.root);

  assert.equal(texts.length, 2, texts.join(" | "));
  assert.match(texts[1] ?? "", /Update available/u);
  assert.match(texts[1] ?? "", /v0\.3\.15 → v0\.3\.16/u);
});

test("/update reports the version that runs, not the mirror's moving HEAD", async (t) => {
  const install = converted(t);

  const texts = await check(install.root);

  // The mirror's own HEAD is upstream's; asking it about "HEAD" would compare the
  // installation with itself and answer "up to date" through every release.
  assert.match(texts[1] ?? "", /You're up to date/u);
  assert.match(texts[1] ?? "", /Iva v0\.3\.15/u);
});

test("/update fails loudly rather than answering about the repository above the install", async (t) => {
  const install = converted(t, { mirror: false });
  // A box whose $HOME is a git repository of its own - versioned dotfiles - is
  // where git's climb to a parent turns a missing mirror into a wrong answer.
  const above = join(install.home, "..");
  git(above, ["init", "--initial-branch=main"]);
  writeFileSync(join(above, "dotfile"), "\n");
  git(above, ["add", "-A"]);
  git(above, ["commit", "-m", "dotfiles"]);
  // With a remote of its own that repository answers every question the check
  // asks: a climb ends in a confident report about somebody else's history.
  git(above, ["remote", "add", "origin", install.source]);

  const texts = await check(install.root);

  assert.match(texts[1] ?? "", /Couldn't check for updates/u);
});
