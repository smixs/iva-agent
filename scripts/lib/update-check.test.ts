/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/unbound-method -- Node's test runner owns registration promises, async doubles preserve adapter boundaries, and the tested JavaScript entrypoint is loaded through createRequire */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import {
  compareStableVersions,
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  parseMinUpdater,
  readMinUpdater,
  readNotifiedVersion,
  REPAIR_COMMAND,
  updateOffer,
  updaterCompat,
  updaterTooOldMessage,
  updaterVersion,
} from "./update-check.ts";
import { tempDir } from "../fixtures/temp-dir.ts";

type UpdateOfferRequest = {
  token: string;
  chatId: string;
  offer: { text: string };
};
type DailyUpdateResult = {
  status: string;
  info?: { remoteVersion?: string };
};
type DailyUpdateOptions = {
  root?: string;
  env?: Record<string, string>;
  inspectImpl?: (options: { root: string; head?: string }) => Promise<{
    hasVersionUpdate: boolean;
    localVersion?: string;
    remoteVersion?: string;
    remote?: string;
  }>;
  sendImpl?: (request: UpdateOfferRequest) => Promise<unknown>;
  gitImpl?: (
    root: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};
const require = createRequire(import.meta.url);
const { runDailyUpdateCheck } = require("../check-update.mjs") as unknown as {
  runDailyUpdateCheck(options?: DailyUpdateOptions): Promise<DailyUpdateResult>;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** callback_data кнопок в порядке появления в rich-тексте сообщения. */
function actionCallbacks(text: string): string[] {
  return [...text.matchAll(/data="([^"]+)"/gu)].map((match) => match[1]);
}

function repoFixture() {
  const temp = tempDir("iva-update-check-");
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.2.3"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "initial");
  git(temp, "init", "--bare", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  // Бета — ветка beta (ADR-0018): каждый push seed кладёт ту же историю и в неё.
  git(
    seed,
    "config",
    "--add",
    "remote.origin.push",
    "refs/heads/main:refs/heads/main",
  );
  git(
    seed,
    "config",
    "--add",
    "remote.origin.push",
    "refs/heads/main:refs/heads/beta",
  );
  git(seed, "push");
  git(temp, "clone", "--branch", "main", remote, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Test");
  // Эти проверки — о вершине ветки: бета-обновления (иначе обновление ждёт выпуск,
  // метку vX.Y.Z — update-release-git.test.ts). Прежний флаг при main уводит на beta.
  git(local, "config", "iva.beta", "true");
  return { temp, remote, seed, local };
}

test("stable version comparison accepts only numeric release triples", () => {
  assert.equal(compareStableVersions("1.2.3", "1.2.4"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.3.0"), 1);
  assert.equal(compareStableVersions("1.2.3", "2.0.0"), 1);
  assert.equal(compareStableVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareStableVersions("1.2.3", "1.2.2"), -1);
  assert.equal(compareStableVersions("1.2.3", "1.3.0-beta.1"), null);
  assert.equal(compareStableVersions("not-semver", "1.3.0"), null);
});

test("stable version comparison preserves runtime string coercion", () => {
  assert.equal(compareStableVersions({ toString: () => "1.2.3" }, "1.2.4"), 1);
});

test("upstream inspection separates commit updates from release updates", async () => {
  const { seed, local } = repoFixture();
  let info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.hasVersionUpdate, false);

  writeFileSync(join(seed, "README.md"), "docs only\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "docs");
  git(seed, "push");
  info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.hasVersionUpdate, false);

  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.3.0"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "release");
  git(seed, "push");
  info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.hasVersionUpdate, true);
  assert.equal(info.remoteVersion, "1.3.0");
});

test("a locally ahead repository has no upstream update", async () => {
  const { local } = repoFixture();
  writeFileSync(join(local, "local.txt"), "local\n");
  git(local, "add", "local.txt");
  git(local, "commit", "-m", "local");
  const info = await inspectUpstream({ root: local });
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.hasVersionUpdate, false);
});

test("a merged legacy feature branch discovers updates from main", async () => {
  const { seed, local } = repoFixture();
  git(seed, "branch", "feat/legacy");
  git(seed, "push", "origin", "feat/legacy");
  git(local, "fetch", "origin", "feat/legacy");
  git(local, "switch", "-c", "feat/legacy", "FETCH_HEAD");

  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.3.0"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "release");
  git(seed, "push");

  const info = await inspectUpstream({ root: local });
  assert.equal(info.currentBranch, "feat/legacy");
  assert.equal(info.branch, "beta");
  assert.equal(info.legacyMigration, true);
  assert.equal(info.remote, git(seed, "rev-parse", "HEAD"));
  assert.equal(info.hasVersionUpdate, true);
});

test("an explicitly configured feature channel does not drift to main", async () => {
  const { seed, local } = repoFixture();
  git(seed, "switch", "-c", "feat/beta");
  writeFileSync(join(seed, "beta.txt"), "beta\n");
  git(seed, "add", "beta.txt");
  git(seed, "commit", "-m", "beta");
  git(seed, "push", "-u", "origin", "feat/beta");
  git(local, "fetch", "origin", "feat/beta");
  git(local, "switch", "-c", "feat/beta", "FETCH_HEAD");
  git(local, "config", "iva.updateBranch", "feat/beta");

  git(seed, "switch", "main");
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"2.0.0"}\n',
  );
  git(seed, "add", "package.json");
  git(seed, "commit", "-m", "main release");
  git(seed, "push", "origin", "main");

  const info = await inspectUpstream({ root: local });
  assert.equal(info.branch, "feat/beta");
  assert.equal(info.legacyMigration, false);
  assert.equal(info.hasCommitUpdate, false);
  assert.equal(info.remoteVersion, "1.2.3");
});

test("notification target prefers digest chat and falls back to the first trusted user", () => {
  assert.equal(
    notificationChat({
      TELEGRAM_DIGEST_CHAT_ID: "99",
      TELEGRAM_ALLOWED_USER_IDS: "1,2",
    }),
    "99",
  );
  assert.equal(notificationChat({ TELEGRAM_ALLOWED_USER_IDS: " 1, 2" }), "1");
  assert.equal(notificationChat({}), "");
});

test("installer persists the selected update channel", () => {
  const installer = readFileSync(
    new URL("../../install.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    installer,
    /config --local iva\.updateBranch "\$UPDATE_CHANNEL"/,
  );
  assert.match(
    installer,
    /UPDATE_CHANNEL="\$\(git -C "\$PROJECT_DIR" branch --show-current/,
  );
});

test("notification state is atomic, private and readable", async () => {
  const data = tempDir("iva-update-state-");
  await markVersionNotified(data, "1.2.4");
  assert.equal(await readNotifiedVersion(data), "1.2.4");
  assert.equal(statSync(join(data, "update-check.json")).mode & 0o777, 0o600);
});

test("daily check sends one offer per version and records only successful sends", async () => {
  const root = tempDir("iva-daily-check-");
  const env = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    AGENT_LANGUAGE: "ru",
    ASSISTANT_DATA_DIR: "data",
  };
  const info = {
    hasVersionUpdate: true,
    localVersion: "1.2.3",
    remoteVersion: "1.2.4",
  };
  const sent: UpdateOfferRequest[] = [];
  const options = {
    root,
    env,
    inspectImpl: async () => info,
    sendImpl: async (request: UpdateOfferRequest) => sent.push(request),
  };
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 1);
  // Кнопки — строки rich-текста: обе на месте, рядом со своими пояснениями.
  assert.deepEqual(actionCallbacks(sent[0].offer.text), [
    "iva_update:do",
    "iva_update:skip",
  ]);
  assert.match(sent[0].offer.text, /Доступна новая версия Ивы/);
  assert.equal((await runDailyUpdateCheck(options)).status, "already-notified");
  assert.equal(sent.length, 1);

  info.remoteVersion = "1.2.5";
  assert.equal((await runDailyUpdateCheck(options)).status, "notified");
  assert.equal(sent.length, 2);

  info.remoteVersion = "1.2.6";
  await assert.rejects(
    () =>
      runDailyUpdateCheck({
        ...options,
        sendImpl: async () => {
          throw new Error("offline");
        },
      }),
    /offline/,
  );
  assert.equal(await readNotifiedVersion(join(root, "data")), "1.2.5");
});

const WHATS_NEW_README = [
  "## Что нового",
  "",
  "<details>",
  "",
  "### 24.08.2026",
  "",
  "#### v1.2.4",
  "",
  "- 🔁 **Reply на старое сообщение больше не вешает бота**: и дальше текст.",
  "",
  "</details>",
  "",
].join("\n");

test("the daily notice says what is new, in the language of the notice", async () => {
  const root = tempDir("iva-daily-whats-new-");
  const asked: string[][] = [];
  const sent: UpdateOfferRequest[] = [];
  const result = await runDailyUpdateCheck({
    root,
    env: {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_DIGEST_CHAT_ID: "42",
      AGENT_LANGUAGE: "ru",
      ASSISTANT_DATA_DIR: "data",
    },
    inspectImpl: async () => ({
      hasVersionUpdate: true,
      localVersion: "1.2.3",
      remoteVersion: "1.2.4",
      remote: "deadbeef",
    }),
    // The ref the check already fetched, read the way the minUpdater marker is read.
    gitImpl: async (_root, args) => {
      asked.push(args);
      return { code: 0, stdout: WHATS_NEW_README, stderr: "" };
    },
    sendImpl: async (request: UpdateOfferRequest) => sent.push(request),
  });
  assert.equal(result.status, "notified");
  assert.deepEqual(asked, [["show", "deadbeef:README.ru.md"]]);
  assert.match(sent[0].offer.text, /Доступна новая версия Ивы/);
  assert.match(sent[0].offer.text, /\nЧто нового:\nv1\.2\.4\n/);
  assert.match(
    sent[0].offer.text,
    /• 🔁 Reply на старое сообщение больше не вешает бота\n/,
  );
  // What's New sits between the body and the buttons; the buttons close the message.
  assert.match(
    sent[0].offer.text,
    /Полный список: https:\/\/github\.com\/smixs\/iva-agent\/releases\n\n<tg-button [^]*iva_update:skip[^]*<\/tg-button> — напомню завтра$/,
  );
  // Rich markdown: no stray markdown marker may reach the chat.
  assert.doesNotMatch(sent[0].offer.text, /[`*]/);
});

test("the daily notice survives a README it cannot read", async () => {
  const root = tempDir("iva-daily-no-readme-");
  const sent: UpdateOfferRequest[] = [];
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    const result = await runDailyUpdateCheck({
      root,
      env: {
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_DIGEST_CHAT_ID: "42",
        ASSISTANT_DATA_DIR: "data",
      },
      inspectImpl: async () => ({
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
        remote: "deadbeef",
      }),
      gitImpl: async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal: path 'README.ru.md' does not exist in 'deadbeef'",
      }),
      sendImpl: async (request: UpdateOfferRequest) => sent.push(request),
    });
    assert.equal(result.status, "notified");
    assert.equal(sent.length, 1);
    assert.match(sent[0].offer.text, /Доступна новая версия Ивы/);
    assert.doesNotMatch(sent[0].offer.text, /Что нового/);
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.match(logged[0], /What's New: fatal: path 'README\.ru\.md'/);
  } finally {
    console.error = consoleError;
  }
});

test("daily check is silent without config, without a release, or during an update", async () => {
  const root = tempDir("iva-daily-silent-");
  assert.equal(
    (await runDailyUpdateCheck({ root, env: {} })).status,
    "not-configured",
  );

  const env = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "1" };
  const current = await runDailyUpdateCheck({
    root,
    env,
    inspectImpl: async () => ({ hasVersionUpdate: false }),
    sendImpl: async () => assert.fail("must stay silent"),
  });
  assert.equal(current.status, "current");

  mkdirSync(join(root, "data", "update.lock"), { recursive: true });
  const locked = await runDailyUpdateCheck({
    root,
    env,
    inspectImpl: async () => assert.fail("must not fetch during update"),
  });
  assert.equal(locked.status, "update-running");
});

test("offer copy is bilingual and keeps existing callback actions", () => {
  const en = updateOffer("1.2.3", "1.2.4", "en");
  const ru = updateOffer("1.2.3", "1.2.4", "ru");
  assert.match(en.text, /new Iva version/);
  assert.match(ru.text, /новая версия Ивы/);
  assert.deepEqual(actionCallbacks(en.text), [
    "iva_update:do",
    "iva_update:skip",
  ]);
});

test("systemd templates schedule a persistent 10:00 local check and lifecycle commands include it", () => {
  const root = join(import.meta.dirname, "..", "..");
  const timer = readFileSync(
    join(root, "deploy", "iva-update-check.timer"),
    "utf8",
  );
  const service = readFileSync(
    join(root, "deploy", "iva-update-check.service"),
    "utf8",
  );
  const pollService = readFileSync(
    join(root, "deploy", "iva-telegram-poll.service"),
    "utf8",
  );
  const cliRuntime = readFileSync(
    join(root, "scripts", "cli", "runtime.ts"),
    "utf8",
  );
  const cliSystemd = readFileSync(
    join(root, "scripts", "cli", "systemd.ts"),
    "utf8",
  );
  const installer = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(timer, /OnCalendar=\*-\*-\* 10:00:00 __TIMEZONE__/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /scripts\/check-update\.mjs/);
  assert.match(service, /EnvironmentFile=__PROJECT_DIR__\/\.env/);
  assert.match(cliRuntime, /const TIMERS = \[BRAIN_TIMER, UPDATE_TIMER\]/);
  assert.match(cliSystemd, /replaceAll\("__TIMEZONE__", timezone\)/);
  assert.match(installer, /bin\/iva\.mjs" _activate-units/);
  assert.match(
    pollService,
    /ExecStartPost=-\/usr\/bin\/systemctl --user enable --now iva-update-check\.timer/,
  );
});

test("on the versioned layout the daily check reads the mirror and names the installed commit", async () => {
  const home = realpathSync(tempDir("iva-daily-layout-"));
  const sha = "a".repeat(40);
  const name = `0.3.15-${sha.slice(0, 12)}`;
  mkdirSync(join(home, "versions", name), { recursive: true });
  mkdirSync(join(home, "repo"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  symlinkSync(join(home, "versions", name), join(home, "current"));

  const asked: { root?: string; head?: string }[] = [];
  const result = await runDailyUpdateCheck({
    // The units run from `current`, which is where the check starts too.
    root: join(home, "current"),
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "1" },
    inspectImpl: async (options) => {
      asked.push(options);
      return { hasVersionUpdate: false };
    },
  });
  assert.equal(result.status, "current");
  // The mirror's own HEAD follows the remote, so the active version has to be named.
  assert.deepEqual(asked, [
    { root: join(home, "repo"), head: sha.slice(0, 12) },
  ]);

  // The README of the offered release is read from the same mirror, not from `current`:
  // the install root is not a repository at all on this layout.
  const readFrom: { root: string; args: string[] }[] = [];
  const sent: UpdateOfferRequest[] = [];
  const notified = await runDailyUpdateCheck({
    root: join(home, "current"),
    env: { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "1" },
    inspectImpl: async () => ({
      hasVersionUpdate: true,
      localVersion: "0.3.15",
      remoteVersion: "0.3.16",
      remote: "deadbeef",
    }),
    gitImpl: async (root, args) => {
      readFrom.push({ root, args });
      return {
        code: 0,
        stdout: "#### v0.3.16\n\n- 🔁 **Заголовок релиза**: и текст.\n",
        stderr: "",
      };
    },
    sendImpl: async (request: UpdateOfferRequest) => sent.push(request),
  });
  assert.equal(notified.status, "notified");
  assert.deepEqual(readFrom, [
    { root: join(home, "repo"), args: ["show", "deadbeef:README.ru.md"] },
  ]);
  assert.match(sent[0].offer.text, /• 🔁 Заголовок релиза/);
});

// Предложение обновиться — алерт (ADR-0007), и говорит он на языке, выбранном в /menu, а не на
// том, что остался в .env. Резолвер кэширует язык на ~2с и читает settings.json от cwd,
// поэтому каждый сценарий — свежий процесс (тот же приём, что в agent/lib/i18n.test.ts).
const OFFER_PROBE = `
const { runDailyUpdateCheck } = await import(process.env.__CHECK_UPDATE_URL);
const texts = [];
const result = await runDailyUpdateCheck({
  root: process.env.__ROOT,
  env: {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    ASSISTANT_DATA_DIR: process.env.ASSISTANT_DATA_DIR,
    AGENT_LANGUAGE: process.env.AGENT_LANGUAGE,
  },
  inspectImpl: async () => ({ hasVersionUpdate: true, localVersion: "1.2.3", remoteVersion: "1.2.4", remote: "deadbeef" }),
  // The What's New of the offered release comes from the README of the same language.
  gitImpl: async (root, args) => ({
    code: 0,
    stdout: args[1].endsWith("README.ru.md")
      ? "#### v1.2.4\\n\\n- 🔁 **Русский заголовок**: и текст.\\n"
      : "#### v1.2.4\\n\\n- 🔁 **An English headline**: and the text.\\n",
    stderr: "",
  }),
  sendImpl: async (request) => texts.push(request.offer.text),
});
process.stdout.write(JSON.stringify({ status: result.status, texts }));
`;

function offerProbe(settingsLanguage: string, agentLanguage: string): string[] {
  const root = realpathSync(tempDir("iva-offer-lang-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ language: settingsLanguage }),
  );
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", OFFER_PROBE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        __CHECK_UPDATE_URL: new URL("../check-update.mjs", import.meta.url)
          .href,
        __ROOT: root,
        ASSISTANT_DATA_DIR: data,
        AGENT_LANGUAGE: agentLanguage,
      },
    },
  );
  const parsed = JSON.parse(output) as { status: string; texts: string[] };
  assert.equal(parsed.status, "notified");
  return parsed.texts;
}

test("the update offer speaks the language picked in /menu, not the one left in .env", () => {
  const english = offerProbe("en", "ru");
  assert.equal(english.length, 1);
  assert.match(english[0], /A new Iva version is available/);
  assert.doesNotMatch(english[0], /Доступна новая версия/);
  // The What's New block obeys the same choice: English notice, English README.
  assert.match(
    english[0],
    /\nWhat's new:\nv1\.2\.4\n• 🔁 An English headline\n/,
  );
  assert.match(english[0], /\nFull list: https:\/\/github\.com\//);

  const russian = offerProbe("ru", "en");
  assert.equal(russian.length, 1);
  assert.match(russian[0], /Доступна новая версия Ивы/);
  assert.doesNotMatch(russian[0], /A new Iva version/);
  assert.match(russian[0], /\nЧто нового:\nv1\.2\.4\n• 🔁 Русский заголовок\n/);
  assert.match(russian[0], /\nПолный список: https:\/\/github\.com\//);
});

const RELEASE = fc
  .tuple(fc.nat({ max: 40 }), fc.nat({ max: 40 }), fc.nat({ max: 40 }))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);
// Everything a marker, a package.json or a hand edit can put where a release belongs.
const JUNK = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    " 1.2.3",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "01.2.3",
    "1.2.3-beta.1",
    "1.2.3+meta",
    "latest",
  ),
);

test("release comparison is a total order", () => {
  fc.assert(
    fc.property(RELEASE, (one) => {
      assert.equal(compareStableVersions(one, one), 0);
    }),
    { seed: 191_001, numRuns: 200 },
  );

  fc.assert(
    fc.property(RELEASE, RELEASE, (one, other) => {
      const forward = compareStableVersions(one, other);
      const back = compareStableVersions(other, one);
      assert.notEqual(forward, null);
      assert.notEqual(back, null);
      // Written without negating zero: -0 is not 0 under strict equality.
      assert.equal(forward, back === 0 ? 0 : -(back as number));
      assert.equal(forward === 0, one === other);
    }),
    { seed: 191_002, numRuns: 400 },
  );

  fc.assert(
    fc.property(RELEASE, RELEASE, RELEASE, (one, other, third) => {
      const first = compareStableVersions(one, other) as number;
      const second = compareStableVersions(other, third) as number;
      const whole = compareStableVersions(one, third) as number;
      if (first <= 0 && second <= 0) assert.ok(whole <= 0);
      if (first >= 0 && second >= 0) assert.ok(whole >= 0);
    }),
    { seed: 191_003, numRuns: 400 },
  );
});

test("release comparison answers junk with the unparseable verdict, never a crash", () => {
  fc.assert(
    fc.property(
      fc.oneof(RELEASE, JUNK),
      fc.oneof(RELEASE, JUNK),
      (one, other) => {
        const verdict = compareStableVersions(one, other);
        assert.ok([null, -1, 0, 1].includes(verdict));
        const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
        if (!stable.test(one) || !stable.test(other))
          assert.equal(verdict, null);
      },
    ),
    { seed: 191_004, numRuns: 500 },
  );
});

test("an unreadable minUpdater is a named error, never a silent go-ahead", () => {
  assert.equal(parseMinUpdater('{"minUpdater":"0.3.29"}'), "0.3.29");
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.json(),
        JUNK.map((value) => JSON.stringify({ minUpdater: value })),
      ),
      (text) => {
        let parsed: string;
        try {
          parsed = parseMinUpdater(text);
        } catch (error) {
          assert.ok(error instanceof Error);
          assert.match(error.message, /update-compat\.json/);
          return;
        }
        assert.match(parsed, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      },
    ),
    { seed: 191_005, numRuns: 500 },
  );
});

test("the marker of a fetched tree decides whether this updater may install it", async () => {
  const { seed, local } = repoFixture();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const at =
    (root: string) =>
    (...args: string[]) =>
      Promise.resolve({
        code: 0,
        stdout: execFileSync("git", args, {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        stderr: "",
      });
  const head = () => git(local, "rev-parse", "HEAD");

  // A tree from before the marker existed is installed the way it always was.
  assert.equal(await readMinUpdater(at(local), head()), null);
  assert.deepEqual(await updaterCompat(at(local), head(), "0.0.1"), {
    status: "ok",
  });

  writeFileSync(join(seed, "update-compat.json"), '{"minUpdater":"0.3.29"}\n');
  git(seed, "add", "update-compat.json");
  git(seed, "commit", "-m", "compat");
  git(seed, "push");
  git(local, "fetch", "origin");
  const marked = git(local, "rev-parse", "origin/main");

  assert.equal(await readMinUpdater(at(local), marked), "0.3.29");
  assert.deepEqual(await updaterCompat(at(local), marked, "0.3.28"), {
    status: "too-old",
    own: "0.3.28",
    minUpdater: "0.3.29",
  });
  for (const own of ["0.3.29", "0.3.30", "1.0.0"])
    assert.deepEqual(await updaterCompat(at(local), marked, own), {
      status: "ok",
    });
  // Бета-обновлятор — чуть младше своего релиза: 0.4.11-beta.1 < 0.4.11, но > 0.3.29.
  for (const own of ["0.3.30-beta.1", "0.4.11-beta.1"])
    assert.deepEqual(await updaterCompat(at(local), marked, own), {
      status: "ok",
    });
  assert.deepEqual(await updaterCompat(at(local), marked, "0.3.29-beta.1"), {
    status: "too-old",
    own: "0.3.29-beta.1",
    minUpdater: "0.3.29",
  });

  writeFileSync(join(seed, "update-compat.json"), "{ not json\n");
  git(seed, "add", "update-compat.json");
  git(seed, "commit", "-m", "corrupt");
  git(seed, "push");
  git(local, "fetch", "origin");
  await assert.rejects(
    () =>
      updaterCompat(at(local), git(local, "rev-parse", "origin/main"), "9.9.9"),
    /update-compat\.json is not JSON/,
  );
});

test("this checkout names its own release, and the refusal says how to repair it", () => {
  const own = updaterVersion();
  // Релиз X.Y.Z или бета X.Y.Z-beta.N (бета-обновления, 0.4.11-beta.1).
  assert.match(
    own,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/,
  );
  assert.throws(
    () => updaterVersion(tempDir("iva-no-package-")),
    /no readable release/,
  );

  const english = updaterTooOldMessage("0.3.20", "en");
  assert.equal(
    english,
    `Your Iva (0.3.20) is too old to update itself. Open a terminal on the server and run:\n${REPAIR_COMMAND}\nYour data and .env stay in place.`,
  );
  const russian = updaterTooOldMessage("0.3.20", "ru");
  assert.equal(
    russian,
    `Ваша Iva (0.3.20) слишком старая, чтобы обновиться сама. Откройте терминал на сервере и выполните:\n${REPAIR_COMMAND}\nДанные и .env остаются на месте.`,
  );
});

test("the update Alert carries the repair command only for an updater that is too old", async () => {
  const plain = updateOffer("1.2.3", "1.2.4", "en");
  assert.doesNotMatch(plain.text, /repair\.sh/);
  assert.match(plain.text, /Edits to Iva's own code are not carried over\./u);

  for (const locale of ["en", "ru"]) {
    const stuck = updateOffer("1.2.3", "1.2.4", locale, true);
    assert.match(stuck.text, /v1\.2\.3 → v1\.2\.4/);
    assert.ok(stuck.text.includes(REPAIR_COMMAND), stuck.text);
    // The buttons stay: the tap now earns the same words instead of a broken update.
    assert.deepEqual(actionCallbacks(stuck.text), [
      "iva_update:do",
      "iva_update:skip",
    ]);
  }

  // End to end: the flag comes off the remote marker the daily check already fetched.
  const { seed, local } = repoFixture();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"9.9.9"}\n',
  );
  writeFileSync(join(seed, "update-compat.json"), '{"minUpdater":"9.9.9"}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "release that needs a newer updater");
  git(seed, "push");

  const info = await inspectUpstream({ root: local });
  assert.equal(info.hasVersionUpdate, true);
  assert.equal(info.updaterTooOld, true);
  assert.ok(
    updateOffer(
      info.localVersion,
      info.remoteVersion,
      "en",
      info.updaterTooOld,
    ).text.includes(REPAIR_COMMAND),
  );
});

test("beta: Alert о новых коммитах ветки — версия и заголовки Unreleased (≤ 5), тот же коммит второй раз не шлётся", async () => {
  const { temp, seed, local } = repoFixture();
  const rows = Array.from(
    { length: 6 },
    (_, i) => `- 🔧 **Правка ${i + 1}**: подробности ${i + 1}.`,
  );
  writeFileSync(
    join(seed, "CHANGELOG.md"),
    `# Changelog\n\n## [Unreleased]\n\n${rows.join("\n")}\n\n## [1.2.3] - 2026-01-01\n\n- 🐞 **Старое**: было.\n`,
  );
  writeFileSync(
    join(seed, "package.json"),
    '{"name":"iva","version":"1.2.4-beta.1"}\n',
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "beta build");
  git(seed, "push");
  const sent: string[] = [];
  const env = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_DIGEST_CHAT_ID: "1",
    AGENT_LANGUAGE: "ru",
    ASSISTANT_DATA_DIR: join(temp, "data"),
  };
  const check = () =>
    runDailyUpdateCheck({
      root: local,
      env,
      sendImpl: async ({ offer }) => void sent.push(offer.text),
    });
  assert.equal((await check()).status, "notified");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /1\.2\.4-beta\.1/u);
  for (const n of [1, 2, 3, 4, 5])
    assert.match(sent[0], new RegExp(`Правка ${n}\\b`, "u"));
  assert.doesNotMatch(sent[0], /Правка 6|Старое|подробности/u);
  assert.equal((await check()).status, "already-notified");
  writeFileSync(join(seed, "more.txt"), "x\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "another");
  git(seed, "push");
  assert.equal((await check()).status, "notified");
  assert.equal(sent.length, 2);
});

test("beta: сборка требует обновлятор новее установленного — в Alert инструкция ремонта вместо кнопки", async () => {
  const { temp, seed, local } = repoFixture();
  writeFileSync(join(seed, "update-compat.json"), '{"minUpdater":"99.0.0"}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "needs a newer updater");
  git(seed, "push");
  const sent: string[] = [];
  const result = await runDailyUpdateCheck({
    root: local,
    env: {
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_DIGEST_CHAT_ID: "1",
      AGENT_LANGUAGE: "en",
      ASSISTANT_DATA_DIR: join(temp, "data"),
    },
    sendImpl: async ({ offer }) => void sent.push(offer.text),
  });
  assert.equal(result.status, "notified");
  assert.ok(sent[0]?.includes(REPAIR_COMMAND), sent[0]);
  assert.deepEqual(actionCallbacks(sent[0] ?? ""), []);
});

// Круг 2 (QA D3): бета включена, ветка beta недоступна (нет сети или ветки) — ежедневная
// проверка молчит, как «current»; отказ скажет сам iva update. Настоящий git: зеркало с
// веткой beta в config и origin без ветки beta.
test("daily check on beta with the beta branch unavailable stays quiet as current", async () => {
  const { local } = repoFixture();
  git(local, "config", "iva.updateBranch", "beta");
  git(local, "remote", "set-url", "origin", join(local, "нет.git"));
  const result = await runDailyUpdateCheck({
    root: local,
    env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_DIGEST_CHAT_ID: "1" },
    sendImpl: async () => assert.fail("nothing to offer"),
  });
  assert.equal(result.status, "current");
});

// ── Круг 3: таблица отказов ежедневной проверки на бете ──────────────────────────────
// Молчит, как current, только сеть и отсутствующая ветка beta. Повреждённый
// update-compat.json на вершине и негодное имя ветки показываются, как до беты.
test("daily failure table: only an unreachable or missing beta branch is quiet", async () => {
  const rows: Array<
    [string, (fx: ReturnType<typeof repoFixture>) => void, "current" | "error"]
  > = [
    [
      "network",
      (fx) =>
        git(fx.local, "remote", "set-url", "origin", join(fx.local, "нет.git")),
      "current",
    ],
    [
      "missing branch",
      (fx) => git(fx.remote, "update-ref", "-d", "refs/heads/beta"),
      "current",
    ],
    [
      "update-compat.json",
      (fx) => {
        writeFileSync(join(fx.seed, "update-compat.json"), "{ not json");
        git(fx.seed, "add", "update-compat.json");
        git(fx.seed, "commit", "-m", "broken compat");
        git(fx.seed, "push");
      },
      "error",
    ],
    // R4: origin и ветка есть, fetch падает локально — ошибка видна, а не тишина.
    [
      "fetch (local)",
      (fx) =>
        mkdirSync(join(fx.local, ".git", "FETCH_HEAD"), { recursive: true }),
      "error",
    ],
    [
      "branch name",
      (fx) => git(fx.local, "config", "iva.updateBranch", "a..b"),
      "error",
    ],
  ];
  const broken: string[] = [];
  for (const [step, inject, expect] of rows) {
    const fx = repoFixture();
    inject(fx);
    const outcome = await runDailyUpdateCheck({
      root: fx.local,
      env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_DIGEST_CHAT_ID: "1" },
      sendImpl: async () => {},
    }).then(
      (result) => result.status,
      () => "error",
    );
    if (outcome !== expect) broken.push(`${step}: ${outcome}`);
  }
  assert.deepEqual(broken, []);
});
