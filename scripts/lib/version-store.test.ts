/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createVersionStore,
  layoutFor,
  parseVersionName,
  readActiveState,
  releaseOf,
  retainedVersions,
  acquireUpdateLock,
  updateRunning,
  versionName,
} from "./version-store.ts";
import { ATOMIC_WRITE_DURABILITY } from "../../agent/lib/fs-atomic.ts";

function home(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-versions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stage, fill and complete a version the way a successful update would. */
function install(
  store: ReturnType<typeof createVersionStore>,
  name: string,
  marker = name,
): string {
  const dir = store.stage(name);
  writeFileSync(join(dir, "marker.txt"), marker);
  store.complete(name);
  return dir;
}

function age(dir: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(dir, when, when);
}

test("version names carry the release, the commit and the customization", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(versionName("0.3.15", sha), "0.3.15-0123456789ab");
  assert.deepEqual(parseVersionName("0.3.15-0123456789ab"), {
    version: "0.3.15",
    sha: "0123456789ab",
    overlay: null,
    build: 1,
  });
  // The same commit with a customization is a different version, or a user's
  // edit would resolve to the version that is already running.
  assert.equal(
    versionName("0.3.15", sha, "beefcafe"),
    "0.3.15-0123456789ab+beefcafe",
  );
  assert.deepEqual(parseVersionName("0.3.15-0123456789ab+beefcafe"), {
    version: "0.3.15",
    sha: "0123456789ab",
    overlay: "beefcafe",
    build: 1,
  });
  // A rebuild of the same code is another directory, not another release: it
  // carries a build number, and `releaseOf` is what sees through it.
  assert.equal(
    versionName("0.3.15", sha, "beefcafe", 2),
    "0.3.15-0123456789ab+beefcafe~2",
  );
  assert.equal(parseVersionName("0.3.15-0123456789ab~3")?.build, 3);
  assert.deepEqual(parseVersionName(versionName("1.2.3-rc-hotfix", sha)), {
    version: "1.2.3-rc-hotfix",
    sha: "0123456789ab",
    overlay: null,
    build: 1,
  });
  for (const version of ["1.2.3+build.7", "1.2.3-rc.1+build.7"])
    assert.deepEqual(parseVersionName(versionName(version, sha)), {
      version,
      sha: "0123456789ab",
      overlay: null,
      build: 1,
    });
  assert.equal(
    releaseOf("0.3.15-0123456789ab+beefcafe~2"),
    "0.3.15-0123456789ab+beefcafe",
  );
  assert.equal(releaseOf("0.3.15-0123456789ab"), "0.3.15-0123456789ab");
  assert.equal(parseVersionName("0.3.15-0123456789ab~"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab/../etc"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab+"), null);
  assert.equal(parseVersionName("0.3.15-0123456789ab+zzzzzzzz"), null);
  assert.equal(parseVersionName(".incomplete"), null);
  assert.equal(parseVersionName("node_modules"), null);
  assert.equal(parseVersionName("0.3.15-XYZ"), null);
  for (const invalid of [
    "1.2.3-alpha..beta",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3+build..7",
  ])
    assert.equal(
      parseVersionName(versionName(invalid, "0123456789abcdef")),
      null,
      invalid,
    );
});

test("version names round-trip every supported package SemVer shape", () => {
  const numeric = fc.nat({ max: 999 }).map(String);
  const identifier = fc
    .array(
      fc.constantFrom(
        ..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-",
      ),
      {
        minLength: 1,
        maxLength: 8,
      },
    )
    .map((characters) => characters.join(""));
  const prereleaseIdentifier = identifier.filter(
    (value) => !/^0\d+$/u.test(value),
  );
  const prerelease = fc
    .array(prereleaseIdentifier, { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join("."));
  const metadata = fc
    .array(identifier, { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join("."));
  const semver = fc
    .tuple(
      numeric,
      numeric,
      numeric,
      fc.option(prerelease, { nil: undefined }),
      fc.option(metadata, { nil: undefined }),
    )
    .map(
      ([major, minor, patch, prerelease, metadata]) =>
        `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}${metadata ? `+${metadata}` : ""}`,
    );
  const hex = fc.constantFrom(..."0123456789abcdef");
  const digest = (length: number) =>
    fc
      .array(hex, { minLength: length, maxLength: length })
      .map((digits) => digits.join(""));

  fc.assert(
    fc.property(
      semver,
      digest(40),
      fc.option(digest(8), { nil: null }),
      fc.integer({ min: 1, max: 9 }),
      (version, sha, overlay, build) => {
        assert.deepEqual(
          parseVersionName(versionName(version, sha, overlay, build)),
          {
            version,
            sha: sha.slice(0, 12),
            overlay,
            build,
          },
        );
      },
    ),
    { seed: 18804, numRuns: 500 },
  );
});

test("layout keeps state outside the versions tree", (t) => {
  const root = home(t);
  const layout = layoutFor(root);
  assert.equal(layout.versions, join(root, "versions"));
  assert.equal(layout.current, join(root, "current"));
  assert.equal(layout.data, join(root, "data"));
  assert.equal(layout.vault, join(root, "vault"));
  assert.equal(layout.env, join(root, ".env"));
  for (const path of [layout.data, layout.vault, layout.env])
    assert.equal(path.startsWith(join(root, "versions")), false);
});

test("the layout is the state the .env names, wherever the user put it", (t) => {
  const root = home(t);
  const elsewhere = home(t);
  // Absolute, the way `iva config` writes it; and a relative one is still the
  // installation's own, so the two spellings cannot pull the layout apart.
  writeFileSync(
    join(root, ".env"),
    `ASSISTANT_DATA_DIR=${elsewhere}\nASSISTANT_VAULT_DIR=notes\n`,
  );
  const layout = layoutFor(root);
  assert.equal(layout.data, elsewhere);
  assert.equal(layout.vault, join(root, "notes"));

  // And what a version borrows leads to the same place: one directory holds the
  // lock, the markers and the customization, whoever asks for it.
  const store = createVersionStore(root);
  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(dir);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(elsewhere));
  assert.equal(
    realpathSync(join(dir, "vault")),
    realpathSync(join(root, "notes")),
  );
  assert.equal(existsSync(join(root, "data")), false);
});

test("an interrupted stage leaves the active version untouched and is swept later", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  // kill -9 in the middle of building the candidate: the directory exists, the sentinel stays.
  const staged = store.stage("0.3.15-bbbbbbbbbbbb");
  writeFileSync(join(staged, "half-built.txt"), "partial");

  assert.deepEqual(store.list(), ["0.3.14-aaaaaaaaaaaa"]);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.throws(() => store.activate("0.3.15-bbbbbbbbbbbb"), /incomplete/);

  assert.deepEqual(store.sweep(), ["0.3.15-bbbbbbbbbbbb"]);
  assert.equal(existsSync(staged), false);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    readFileSync(join(store.layout.current, "marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
});

test("sweep keeps complete versions and the active one, and clears stale flip links", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.15-bbbbbbbbbbbb");
  // kill -9 between creating the replacement link and renaming it over `current`.
  symlinkSync(
    join(root, "versions/0.3.14-aaaaaaaaaaaa"),
    join(root, ".current.iva-flip-1234"),
  );

  assert.deepEqual(store.sweep(), [".current.iva-flip-1234"]);
  assert.equal(existsSync(join(root, ".current.iva-flip-1234")), false);
  assert.deepEqual(store.list().sort(), [
    "0.3.14-aaaaaaaaaaaa",
    "0.3.15-bbbbbbbbbbbb",
  ]);
  assert.equal(store.currentName(), "0.3.15-bbbbbbbbbbbb");
});

test("activation is atomic, repeatable and reversible without git", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");

  store.activate("0.3.14-aaaaaaaaaaaa");
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.15-bbbbbbbbbbbb");
  assert.equal(store.currentName(), "0.3.15-bbbbbbbbbbbb");
  assert.equal(lstatSync(layoutFor(root).current).isSymbolicLink(), true);

  // Downgrade: the previous version is still on disk, so rollback is one flip.
  assert.equal(store.previousName(), "0.3.14-aaaaaaaaaaaa");
  store.activate(store.previousName()!);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    readFileSync(join(root, "current/marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
  // No leftover flip links from three activations.
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".current")),
    [],
  );
});

test("a missing current path is healed onto the newest version", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  age(install(store, "0.3.14-aaaaaaaaaaaa"), 600);
  install(store, "0.3.15-bbbbbbbbbbbb");

  assert.equal(store.currentName(), null);
  assert.equal(store.heal(), "0.3.15-bbbbbbbbbbbb");

  // Nothing to heal onto: report it instead of guessing.
  rmSync(layout.current, { force: true });
  rmSync(layout.versions, { recursive: true, force: true });
  assert.equal(store.heal(), null);
});

test("an external current symlink blocks healing without changing either owner", (t) => {
  const root = home(t);
  const foreign = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");
  const leftover = store.stage("0.3.99-cccccccccccc");
  writeFileSync(join(leftover, "partial"), "keep");
  const owner = join(foreign, "owner.txt");
  const bytes = Buffer.from([0x66, 0x6f, 0x72, 0x65, 0x69, 0x67, 0x6e]);
  writeFileSync(owner, bytes);
  symlinkSync(foreign, layout.current);
  const target = readlinkSync(layout.current);

  assert.throws(
    () => store.currentName(),
    /current.*foreign|outside.*versions/u,
  );
  assert.throws(() => store.sweep(), /current.*foreign|outside.*versions/u);
  assert.throws(() => store.heal(), /current.*foreign|outside.*versions/u);
  assert.throws(
    () => store.activate("0.3.14-aaaaaaaaaaaa"),
    /current.*foreign|outside.*versions/u,
  );
  assert.equal(readlinkSync(layout.current), target);
  assert.deepEqual(readFileSync(owner), bytes);
  assert.equal(readFileSync(join(leftover, "partial"), "utf8"), "keep");
});

test("owned relative current links are valid while dangling and hostile links fail closed", (t) => {
  const root = home(t);
  const foreign = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  const owned = "0.3.14-aaaaaaaaaaaa";
  install(store, owned);
  install(store, "0.3.15-bbbbbbbbbbbb");

  const relativeOwned = join("versions", owned);
  symlinkSync(relativeOwned, layout.current);
  assert.equal(store.currentName(), owned);
  assert.equal(store.heal(), owned);
  assert.equal(readlinkSync(layout.current), relativeOwned);

  const dangling = join(layout.versions, "0.3.99-cccccccccccc");
  rmSync(layout.current, { force: true });
  symlinkSync(dangling, layout.current);
  assert.throws(() => store.currentName(), /current.*dangling|unreadable/u);
  assert.throws(() => store.heal(), /current.*dangling|unreadable/u);
  assert.equal(readlinkSync(layout.current), dangling);

  const hostile = join("..", basename(foreign));
  rmSync(layout.current, { force: true });
  symlinkSync(hostile, layout.current);
  assert.throws(
    () => store.currentName(),
    /current.*foreign|outside.*versions/u,
  );
  assert.throws(() => store.heal(), /current.*foreign|outside.*versions/u);
  assert.equal(readlinkSync(layout.current), hostile);
});

test("a non-symlink current object blocks activation without changing its bytes", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  // A real directory at the reserved path is foreign state. Refuse it and keep
  // every byte for manual repair instead of guessing that it is safe to delete.
  mkdirSync(layout.current);
  writeFileSync(join(layout.current, "junk"), "junk");
  assert.throws(
    () => store.activate("0.3.14-aaaaaaaaaaaa"),
    /current.*not a symlink/u,
  );
  assert.equal(lstatSync(layout.current).isDirectory(), true);
  assert.equal(readFileSync(join(layout.current, "junk"), "utf8"), "junk");
});

test("healing goes back to the version the installation settled on", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  age(install(store, "0.3.14-aaaaaaaaaaaa"), 600);
  install(store, "0.3.15-bbbbbbbbbbbb");
  // A rollback: onto the older version, and said so.
  store.activate("0.3.14-aaaaaaaaaaaa");
  store.settle("0.3.14-aaaaaaaaaaaa");
  // The state links a rollback leaves are the installation's; a probe's are not.
  store.linkState(
    join(layout.versions, "0.3.14-aaaaaaaaaaaa"),
    join(root, "gone"),
  );
  rmSync(layout.current, { force: true });

  // Never the newest on disk: that is the version the rollback rejected.
  assert.equal(store.heal(), "0.3.14-aaaaaaaaaaaa");
  assert.equal(
    realpathSync(join(root, "current/data")),
    realpathSync(layout.data),
  );
});

test("a corrupt active marker blocks healing without changing its bytes", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.14-aaaaaaaaaaaa");
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const corrupt = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]);
  writeFileSync(marker, corrupt);
  rmSync(store.layout.current);

  assert.throws(
    () => store.heal(),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );
  assert.deepEqual(readFileSync(marker), corrupt);
  assert.equal(existsSync(store.layout.current), false);
});

// UpdateFloor.NoSilentLoss: releases before 0.3.24 wrote the marker as iva-active/v1. It is
// not converted: every reader refuses it by the file's name and the bytes stay.
test("NoSilentLoss: an active.json of schema iva-active/v1 is refused by name and its bytes stay", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");
  const marker = join(store.layout.data, "active.json");
  const v1 = `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" })}\n`;
  writeFileSync(marker, v1);

  for (const read of [
    () => store.settled(),
    () => store.heal(),
    () => store.activate("0.3.14-aaaaaaaaaaaa"),
  ])
    assert.throws(read, /active\.json.*corrupt|corrupt.*active\.json/u);
  assert.equal(readFileSync(marker, "utf8"), v1);
});

test("a valid current link cannot hide a corrupt active marker from healing", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");
  const current = readlinkSync(store.layout.current);
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const corrupt = Buffer.from("{not json");
  writeFileSync(marker, corrupt);

  assert.throws(() => store.heal(), /active\.json.*corrupt/u);
  assert.equal(readlinkSync(store.layout.current), current);
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("a corrupt active marker blocks rollback selection", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  install(store, "0.3.15-bbbbbbbbbbbb");
  store.activate("0.3.15-bbbbbbbbbbbb");
  mkdirSync(store.layout.data, { recursive: true });
  writeFileSync(join(store.layout.data, "active.json"), "not json\n");

  assert.throws(
    () => store.previousName(),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );
});

test("an unreadable active marker is not treated as missing", (t) => {
  const store = createVersionStore(home(t));
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  mkdirSync(marker);

  assert.throws(
    () => store.settled(),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );
  assert.equal(lstatSync(marker).isDirectory(), true);
});

test("a symlinked active marker is corrupt even when its target is valid", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const target = join(root, "active-target.json");
  const bytes = Buffer.from(
    '{"schema":"iva-active/v2","version":"0.3.14-aaaaaaaaaaaa","settledAt":"2026-01-01T00:00:00.000Z"}\n',
  );
  writeFileSync(target, bytes);
  symlinkSync(target, marker);
  const before = lstatSync(marker);

  assert.equal(readActiveState(marker).kind, "corrupt-or-unreadable");
  assert.equal(lstatSync(marker).ino, before.ino);
  assert.equal(readlinkSync(marker), target);
  assert.deepEqual(readFileSync(target), bytes);
});

test("a dangling active marker blocks sweep before it removes a version", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const staged = store.stage("0.3.15-bbbbbbbbbbbb");
  writeFileSync(join(staged, "half-built.txt"), "partial");
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const target = join(root, "missing-active-target.json");
  symlinkSync(target, marker);
  const before = lstatSync(marker);

  let caught: unknown;
  try {
    store.sweep();
  } catch (error) {
    caught = error;
  }

  assert.equal(existsSync(staged), true, "sweep removed a staged version");
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /active\.json.*corrupt/u);
  assert.equal(lstatSync(marker).ino, before.ino);
  assert.equal(lstatSync(marker).isSymbolicLink(), true);
  assert.equal(readlinkSync(marker), target);
  assert.equal(existsSync(target), false);
});

test("invalid UTF-8 is rejected before JSON schema validation", (t) => {
  const store = createVersionStore(home(t));
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const corrupt = Buffer.concat([
    Buffer.from(
      '{"schema":"iva-active/v2","version":"0.3.14-aaaaaaaaaaaa","x":"',
    ),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  writeFileSync(marker, corrupt);

  assert.deepEqual(readActiveState(marker), {
    kind: "corrupt-or-unreadable",
    reason: "invalid UTF-8",
  });
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("two updates racing on the same version let exactly one stage it", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  store.stage("0.3.15-bbbbbbbbbbbb");
  assert.throws(() => store.stage("0.3.15-bbbbbbbbbbbb"), /already/);
  // Restaging the running version would delete the live installation.
  assert.throws(() => store.stage("0.3.14-aaaaaaaaaaaa"), /active/);
  assert.throws(() => store.stage("../escape"), /invalid version/);
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
});

test("a rebuild of the running release gets a directory the running one does not own", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  const rebuild = store.nextBuild("0.3.14-aaaaaaaaaaaa");
  assert.equal(rebuild, "0.3.14-aaaaaaaaaaaa~2");
  assert.equal(releaseOf(rebuild), "0.3.14-aaaaaaaaaaaa");
  // Staging it is legal precisely because it is not the directory that runs.
  store.stage(rebuild);
  assert.equal(store.nextBuild("0.3.14-aaaaaaaaaaaa"), "0.3.14-aaaaaaaaaaaa~3");
  assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
  // A release with nothing on disk keeps its plain name.
  assert.equal(store.nextBuild("0.3.15-bbbbbbbbbbbb"), "0.3.15-bbbbbbbbbbbb");
  assert.throws(() => store.nextBuild("../escape"), /invalid version/);
});

test("a failure to write the staging directory leaves the installation untouched", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  // Stand-in for a full disk: the versions directory cannot be written into.
  const layout = layoutFor(root);
  chmodSync(layout.versions, 0o500);
  try {
    assert.throws(() => store.stage("0.3.15-bbbbbbbbbbbb"));
    assert.equal(store.currentName(), "0.3.14-aaaaaaaaaaaa");
    assert.equal(
      existsSync(join(layout.versions, "0.3.15-bbbbbbbbbbbb")),
      false,
    );
  } finally {
    chmodSync(layout.versions, 0o700);
  }
});

test("garbage collection keeps the active version and the rollback target", (t) => {
  const store = createVersionStore(home(t));
  age(install(store, "0.3.11-111111111111"), 400);
  age(install(store, "0.3.12-222222222222"), 300);
  age(install(store, "0.3.13-333333333333"), 200);
  install(store, "0.3.14-444444444444");
  store.activate("0.3.13-333333333333");

  assert.deepEqual(store.gc(2), ["0.3.11-111111111111", "0.3.12-222222222222"]);
  assert.deepEqual(store.list().sort(), [
    "0.3.13-333333333333",
    "0.3.14-444444444444",
  ]);
  assert.equal(store.currentName(), "0.3.13-333333333333");
  // Idempotent: a second collection has nothing left to drop.
  assert.deepEqual(store.gc(2), []);
  // Even keep=1 never removes the active version.
  assert.deepEqual(store.gc(1), ["0.3.14-444444444444"]);
  assert.equal(store.currentName(), "0.3.13-333333333333");
});

test("garbage collection preserves the settled rollback regardless of mtime", (t) => {
  const store = createVersionStore(home(t));
  const rollback = "0.3.12-222222222222";
  const unrelated = "0.3.13-333333333333";
  const current = "0.3.14-444444444444";
  install(store, rollback);
  install(store, unrelated);
  install(store, current);
  store.activate(rollback);
  mkdirSync(store.layout.data, { recursive: true });
  writeFileSync(
    join(store.layout.data, "active.json"),
    `${JSON.stringify({
      schema: "iva-active/v2",
      version: rollback,
      settledAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  store.activate(current);
  store.settle(current);
  age(join(store.layout.versions, rollback), 10_000);
  age(join(store.layout.versions, unrelated), 0);

  assert.deepEqual(store.gc(2), [unrelated]);
  assert.deepEqual(store.list().sort(), [current, rollback].sort());
  assert.equal(store.currentName(), current);
  assert.equal(store.settled(), current);
  assert.equal(store.previousName(), rollback);
  const state = JSON.parse(
    readFileSync(join(store.layout.data, "active.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(state.schema, "iva-active/v2");
  assert.equal(state.version, current);
  assert.equal(state.previous, rollback);
  assert.match(String(state.settledAt), /^\d{4}-\d{2}-\d{2}T/u);
});

test("current-only garbage collection takes the rollback slot in settled and unsettled state", (t) => {
  const settledStore = createVersionStore(home(t));
  const settledPrevious = "0.3.13-333333333333";
  const settledCurrent = "0.3.14-444444444444";
  install(settledStore, settledPrevious);
  install(settledStore, settledCurrent);
  settledStore.activate(settledPrevious);
  settledStore.settle(settledPrevious);
  settledStore.activate(settledCurrent);
  settledStore.settle(settledCurrent);

  assert.deepEqual(settledStore.gc(1, { references: "current" }), [
    settledPrevious,
  ]);
  assert.deepEqual(settledStore.list(), [settledCurrent]);

  const unsettledStore = createVersionStore(home(t));
  const recorded = "0.3.15-555555555555";
  const current = "0.3.16-666666666666";
  install(unsettledStore, recorded);
  install(unsettledStore, current);
  unsettledStore.activate(recorded);
  unsettledStore.settle(recorded);
  unsettledStore.activate(current);

  assert.deepEqual(unsettledStore.gc(1, { references: "current" }), [recorded]);
  assert.deepEqual(unsettledStore.list(), [current]);
});

test("current-only garbage collection keeps exactly current and leaves incomplete versions untouched", () => {
  const finishedNames = fc
    .uniqueArray(fc.integer({ min: 0, max: 999_999 }), {
      minLength: 1,
      maxLength: 8,
    })
    .map((identifiers) =>
      identifiers.map((identifier) =>
        versionName(
          `1.0.${identifier}`,
          identifier.toString(16).padStart(12, "0"),
        ),
      ),
    );

  fc.assert(
    fc.property(
      finishedNames,
      fc.nat(),
      fc.constantFrom("settled", "unsettled", "no-previous"),
      fc.integer({ min: 0, max: 3 }),
      (finished, currentIndex, requestedState, incompleteCount) => {
        const root = mkdtempSync(join(tmpdir(), "iva-current-gc-"));
        try {
          const store = createVersionStore(root);
          for (const name of finished) install(store, name);
          const current = finished[currentIndex % finished.length];
          store.activate(current);
          const stateKind =
            requestedState === "unsettled" && finished.length === 1
              ? "settled"
              : requestedState;
          const recorded =
            stateKind === "unsettled"
              ? finished.find((name) => name !== current)!
              : current;
          const previous =
            stateKind === "no-previous"
              ? undefined
              : finished.find((name) => name !== recorded);
          mkdirSync(store.layout.data, { recursive: true });
          writeFileSync(
            join(store.layout.data, "active.json"),
            `${JSON.stringify({
              schema: "iva-active/v2",
              version: recorded,
              ...(previous ? { previous } : {}),
              settledAt: "2026-08-19T00:00:00.000Z",
            })}\n`,
          );

          const incomplete = Array.from(
            { length: incompleteCount },
            (_, index) =>
              versionName(`9.9.${index}`, index.toString(16).padStart(12, "f")),
          );
          for (const name of incomplete) {
            const dir = store.stage(name);
            writeFileSync(join(dir, "partial"), name);
          }

          store.gc(1, { references: "current" });

          assert.deepEqual(store.list(), [current]);
          for (const name of incomplete) {
            const dir = join(store.layout.versions, name);
            assert.deepEqual(readdirSync(dir).sort(), [
              ".iva-incomplete",
              "partial",
            ]);
            assert.equal(readFileSync(join(dir, "partial"), "utf8"), name);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
    { seed: 194, numRuns: 200, verbose: true },
  );
});

test("current-only garbage collection fails closed before deleting versions", (t) => {
  const foreignStore = createVersionStore(home(t));
  for (const name of ["0.3.13-333333333333", "0.3.14-444444444444"])
    install(foreignStore, name);
  mkdirSync(foreignStore.layout.current);
  const beforeForeign = readdirSync(foreignStore.layout.versions);

  assert.throws(
    () => foreignStore.gc(1, { references: "current" }),
    /current.*foreign|current path is not a symlink/u,
  );
  assert.deepEqual(readdirSync(foreignStore.layout.versions), beforeForeign);

  const corruptStore = createVersionStore(home(t));
  for (const name of ["0.3.15-555555555555", "0.3.16-666666666666"])
    install(corruptStore, name);
  corruptStore.activate("0.3.16-666666666666");
  mkdirSync(corruptStore.layout.data, { recursive: true });
  writeFileSync(join(corruptStore.layout.data, "active.json"), "{junk\n");
  const beforeCorrupt = readdirSync(corruptStore.layout.versions);

  assert.throws(
    () => corruptStore.gc(1, { references: "current" }),
    /active\.json.*corrupt/u,
  );
  assert.deepEqual(readdirSync(corruptStore.layout.versions), beforeCorrupt);
});

test("corrupt active bytes block GC and settlement without changing data", (t) => {
  const store = createVersionStore(home(t));
  for (const name of [
    "0.3.12-222222222222",
    "0.3.13-333333333333",
    "0.3.14-444444444444",
  ])
    install(store, name);
  store.activate("0.3.14-444444444444");
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const corrupt = Buffer.from('{"schema":"iva-active/v2","version":');
  writeFileSync(marker, corrupt);
  const before = store.list();

  assert.throws(
    () => store.gc(2),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );
  assert.deepEqual(store.list(), before);
  assert.deepEqual(readFileSync(marker), corrupt);
  assert.throws(
    () => store.settle("0.3.14-444444444444"),
    /active\.json.*corrupt|corrupt.*active\.json/u,
  );
  assert.deepEqual(readFileSync(marker), corrupt);
});

test("semantic-invalid v1 and v2 active markers fail closed", (t) => {
  const store = createVersionStore(home(t));
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const invalid = [
    {},
    { schema: "iva-active/v0", version: "0.3.14-aaaaaaaaaaaa" },
    // specs/UpdateFloor.tla, NoSilentLoss: the marker of releases before 0.3.24.
    { schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" },
    {
      schema: "iva-active/v1",
      version: "0.3.14-aaaaaaaaaaaa",
      settledAt: "2026-08-16T00:00:00.000Z",
    },
    { schema: "iva-active/v2", version: "0.3.14-aaaaaaaaaaaa" },
    {
      schema: "iva-active/v2",
      version: "0.3.14-aaaaaaaaaaaa",
      previous: "0.3.14-aaaaaaaaaaaa",
      settledAt: "2026-08-16T00:00:00.000Z",
    },
    {
      schema: "iva-active/v2",
      version: "0.3.14-aaaaaaaaaaaa",
      settledAt: "yesterday",
      cleanupPending: "yes",
    },
  ];

  for (const value of invalid) {
    const bytes = `${JSON.stringify(value)}\n`;
    writeFileSync(marker, bytes);
    assert.throws(
      () => store.settled(),
      /active\.json.*corrupt|corrupt.*active\.json/u,
      JSON.stringify(value),
    );
    assert.equal(readFileSync(marker, "utf8"), bytes);
  }
});

test("arbitrary malformed active bytes fail closed with a fixed seed", (t) => {
  const store = createVersionStore(home(t));
  mkdirSync(store.layout.data, { recursive: true });
  const marker = join(store.layout.data, "active.json");
  const seed = 41_907;

  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 96 }), (tail) => {
      const corrupt = Buffer.concat([Buffer.from([0xff]), Buffer.from(tail)]);
      writeFileSync(marker, corrupt);
      assert.throws(
        () => store.settled(),
        /active\.json.*corrupt|corrupt.*active\.json/u,
      );
      assert.deepEqual(readFileSync(marker), corrupt);
    }),
    { seed, numRuns: 200 },
  );
});

test("valid active state survives JSON roundtrip", (t) => {
  const root = home(t);
  const marker = join(root, "active.json");
  const versions = ["0.3.14-aaaaaaaaaaaa", "0.3.15-bbbbbbbbbbbb"];

  fc.assert(
    fc.property(
      fc.constantFrom(...versions),
      fc.boolean(),
      (version, cleanupPending) => {
        const previous = versions.find((name) => name !== version);
        const state = {
          schema: "iva-active/v2" as const,
          version,
          previous,
          settledAt: "2026-08-16T00:00:00.000Z",
          ...(cleanupPending ? { cleanupPending: true } : {}),
        };
        writeFileSync(marker, `${JSON.stringify(state)}\n`);
        assert.deepEqual(readActiveState(marker), { kind: "valid", state });
      },
    ),
    { seed: 41_908, numRuns: 100 },
  );
});

test("missing active state remains a valid first-install state", (t) => {
  const store = createVersionStore(home(t));
  assert.equal(store.settled(), null);
  assert.equal(store.heal(), null);
  assert.deepEqual(store.gc(2), []);
});

test("a post-rename durability fault preserves published cleanup debt", (t) => {
  const root = home(t);
  const first = "0.3.14-aaaaaaaaaaaa";
  const next = "0.3.15-bbbbbbbbbbbb";
  const store = createVersionStore(root);
  install(store, first);
  install(store, next);
  store.activate(first);
  store.settle(first);
  store.activate(next);
  let injected = false;
  const faulty = createVersionStore(root, {
    activeWriteOptions: {
      afterStep(step) {
        if (step === "rename" && !injected) {
          injected = true;
          throw new Error("directory fsync fault");
        }
      },
    },
  });

  assert.throws(
    () => faulty.settle(next, { previous: first, cleanupPending: true }),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === ATOMIC_WRITE_DURABILITY,
  );

  const recovered = createVersionStore(root);
  assert.equal(recovered.settled(), next);
  assert.equal(recovered.previousName(), first);
  assert.equal(recovered.cleanupPending(next), true);
  assert.equal(
    statSync(join(store.layout.data, "active.json")).mode & 0o777,
    0o600,
  );
});

test("settlement pins the captured pre-flip active Version as previous", (t) => {
  const store = createVersionStore(home(t));
  const stale = "0.3.13-333333333333";
  const active = "0.3.14-444444444444";
  const next = "0.3.15-555555555555";
  for (const name of [stale, active, next]) install(store, name);
  store.activate(stale);
  store.settle(stale);
  store.activate(active);
  store.activate(next);

  store.settle(next, { previous: active });

  assert.equal(store.previousName(), active);
});

test("explicit retention is invariant under arbitrary mtimes", () => {
  const current = "0.3.14-444444444444";
  const rollback = "0.3.13-333333333333";
  const other = ["0.3.12-222222222222", "0.3.11-111111111111"];
  const names = [current, rollback, ...other];

  fc.assert(
    fc.property(
      fc.tuple(fc.integer(), fc.integer(), fc.integer(), fc.integer()),
      (mtimes) => {
        const byMtime = names
          .map((name, index) => ({ name, mtime: mtimes[index] ?? 0 }))
          .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
          .map(({ name }) => name);
        const kept = new Set(retainedVersions(byMtime, [current, rollback], 2));
        assert.deepEqual(kept, new Set([current, rollback]));
      },
    ),
    { seed: 18_819, numRuns: 200 },
  );
});

test("materialize writes an exact commit tree without leaving git state behind", async (t) => {
  const root = home(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(
    join(repo, "package.json"),
    '{"name":"iva","version":"0.3.14"}',
  );
  mkdirSync(join(repo, "scripts/lib"), { recursive: true });
  writeFileSync(join(repo, "scripts/lib/keep.ts"), "old\n");
  git("add", "-A");
  git("commit", "-m", "one");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "scripts/lib/keep.ts"), "new\n");
  git("add", "-A");
  git("commit", "-m", "two");
  const second = git("rev-parse", "HEAD");

  const store = createVersionStore(root);
  const dir = store.stage(versionName("0.3.14", first));
  await store.materialize({ sha: first, dir });
  assert.equal(readFileSync(join(dir, "scripts/lib/keep.ts"), "utf8"), "old\n");
  assert.equal(existsSync(join(dir, ".git")), false);
  store.complete(versionName("0.3.14", first));

  const newer = store.stage(versionName("0.3.15", second));
  await store.materialize({ sha: second, dir: newer });
  assert.equal(
    readFileSync(join(newer, "scripts/lib/keep.ts"), "utf8"),
    "new\n",
  );

  await assert.rejects(
    store.materialize({ sha: "0".repeat(40), dir: newer }),
    /materialize/,
  );
});

test("state directories are shared into a version instead of copied", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  mkdirSync(layout.data, { recursive: true });
  mkdirSync(layout.vault, { recursive: true });
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  writeFileSync(join(layout.data, "state.json"), "{}");

  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(dir);
  store.complete("0.3.15-bbbbbbbbbbbb");

  assert.equal(lstatSync(join(dir, "data")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(realpathSync(join(dir, "vault")), realpathSync(layout.vault));
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));
  // Re-linking an already linked version is a no-op, not an EEXIST failure.
  store.linkState(dir);
  assert.equal(readFileSync(join(dir, "data/state.json"), "utf8"), "{}");
});

// specs/UpdateFloor.tla, NoSilentLoss: builds before 0.3.15 kept the workflow store at the root.
test("NoSilentLoss: a workflow store at the installation root is neither linked nor touched", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  mkdirSync(join(root, ".workflow-data"), { recursive: true });
  writeFileSync(join(root, ".workflow-data/run.json"), '{"run":1}\n');
  const dir = store.stage("0.3.16-cccccccccccc");
  store.linkState(dir);
  const scratch = store.sandboxState("0.3.16-cccccccccccc");
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  assert.equal(existsSync(join(dir, ".workflow-data")), false);
  assert.equal(existsSync(join(scratch, ".workflow-data")), false);
  assert.deepEqual(readdirSync(join(root, ".workflow-data")), ["run.json"]);
  assert.equal(
    readFileSync(join(root, ".workflow-data/run.json"), "utf8"),
    '{"run":1}\n',
  );
});

test("a version being probed writes to scratch state, not the installation's", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.linkState(dir);
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  mkdirSync(join(layout.data, "custom"), { recursive: true });
  writeFileSync(join(root, ".eve/.workflow-data/open-run.json"), "{}");

  const scratch = store.sandboxState(name);
  assert.equal(
    dirname(scratch),
    root,
    "scratch state belongs outside versions",
  );
  // What a started server writes goes through the links, and has to land in the
  // sandbox: a version that is only being proved is not the installation yet.
  writeFileSync(join(dir, "data/started.log"), "started\n");
  writeFileSync(join(dir, ".eve/.workflow-data/started.log"), "re-enqueued\n");
  assert.equal(existsSync(join(layout.data, "started.log")), false);
  assert.equal(
    existsSync(join(root, ".eve/.workflow-data/started.log")),
    false,
  );
  assert.equal(
    readFileSync(join(root, ".eve/.workflow-data/open-run.json"), "utf8"),
    "{}",
  );
  // The installation's own .env is read even by a probe - that is the point of it.
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));

  // Proved: the state links go back to the installation.
  store.linkState(dir);
  store.complete(name);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(
    realpathSync(join(dir, ".eve/.workflow-data")),
    realpathSync(join(root, ".eve/.workflow-data")),
  );
  assert.equal(existsSync(join(dir, ".iva-incomplete")), false);
});

test("re-proving a finished version leaves the version, not the version's grave", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.linkState(dir);
  store.complete(name);
  // A finished version goes back to scratch state whenever it is proved again:
  // a downgrade onto it, or an interrupted run that built it but never flipped.
  const scratch = store.sandboxState(name);

  // Being checked is not being unfinished. A kill right here used to hand the
  // next sweep the very version the installation was going back to.
  assert.deepEqual(store.list(), [name]);
  assert.deepEqual(store.sweep(), [basename(scratch)]);
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(scratch), false);
});

test("activating a version aims its state at the installation, whatever it was probed on", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const layout = layoutFor(root);
  const name = "0.3.15-bbbbbbbbbbbb";
  const dir = store.stage(name);
  store.complete(name);
  // Killed while proving this version - a downgrade, or one prepared and never
  // flipped: its state links are left aimed at a scratch directory that the next
  // sweep removes. Rolling back onto it must not start a service on those.
  const scratch = store.sandboxState(name);
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(layout.env, "IVA_PORT=8723\n");
  mkdirSync(layout.data, { recursive: true });
  writeFileSync(join(layout.data, "state.json"), "{}");

  store.activate(name);

  assert.equal(store.currentName(), name);
  assert.equal(realpathSync(join(dir, "data")), realpathSync(layout.data));
  assert.equal(realpathSync(join(dir, ".env")), realpathSync(layout.env));
  assert.equal(readFileSync(join(dir, "data/state.json"), "utf8"), "{}");
});

test("a version links .env before there is one, so a later write lands outside", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  store.linkState(dir);

  assert.equal(existsSync(layoutFor(root).env), false);
  assert.equal(lstatSync(join(dir, ".env")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(dir, ".env")), layoutFor(root).env);
});

test("resetting a staged version clears it without giving up the claim", (t) => {
  const store = createVersionStore(home(t));
  install(store, "0.3.14-aaaaaaaaaaaa");
  store.activate("0.3.14-aaaaaaaaaaaa");

  const dir = store.stage("0.3.15-bbbbbbbbbbbb");
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent/broken.ts"), "does not compile");
  store.linkState(dir);

  assert.equal(store.reset("0.3.15-bbbbbbbbbbbb"), dir);
  assert.deepEqual(readdirSync(dir), [".iva-incomplete"]);
  assert.deepEqual(store.list(), ["0.3.14-aaaaaaaaaaaa"]);
  // The shared state the version borrowed is untouched by the reset.
  assert.equal(existsSync(layoutFor(store.layout.home).data), true);

  // A finished version is never someone's scratch space.
  assert.throws(() => store.reset("0.3.14-aaaaaaaaaaaa"), /complete/);
  assert.equal(
    readFileSync(join(store.layout.current, "marker.txt"), "utf8"),
    "0.3.14-aaaaaaaaaaaa",
  );
});

test("a version the service died on is remembered by what it was built from", (t) => {
  const root = home(t);
  const store = createVersionStore(root);
  const marker = join(layoutFor(root).data, "live-failures.json");

  store.recordLive("0.3.15-bbbbbbbbbbbb+aaaa1111", false);

  // A rebuild of the same commit with the same files is the same code: the build
  // number is all that differs, and it is not what killed the service.
  assert.equal(store.liveFailed("0.3.15-bbbbbbbbbbbb+aaaa1111"), true);
  assert.equal(store.liveFailed("0.3.15-bbbbbbbbbbbb+aaaa1111~7"), true);
  // A different customization, and the same customization on a different commit,
  // are versions nothing is known about yet.
  assert.equal(store.liveFailed("0.3.15-bbbbbbbbbbbb+aaaa2222"), false);
  assert.equal(store.liveFailed("0.3.16-cccccccccccc+aaaa1111"), false);
  assert.equal(store.liveFailed("0.3.15-bbbbbbbbbbbb"), false);
  assert.equal(store.liveFailed("not-a-version"), false);

  // Coming up on it is what takes the record away, and only that record.
  store.recordLive("0.3.16-cccccccccccc", false);
  store.recordLive("0.3.15-bbbbbbbbbbbb+aaaa1111", true);
  assert.equal(store.liveFailed("0.3.15-bbbbbbbbbbbb+aaaa1111"), false);
  assert.equal(store.liveFailed("0.3.16-cccccccccccc"), true);

  // The file cannot grow without bound on a box that keeps failing, and a
  // successful update that has nothing to forget does not rewrite it.
  for (let at = 0; at < 20; at++)
    store.recordLive(
      `0.3.17-dddddddddddd+${String(at).padStart(8, "0")}`,
      false,
    );
  const written = readFileSync(marker, "utf8");
  const body = JSON.parse(written) as { failed: string[] };
  assert.equal(body.failed.length, 8);
  assert.equal(store.liveFailed("0.3.17-dddddddddddd+00000019"), true);
  assert.equal(store.liveFailed("0.3.17-dddddddddddd+00000000"), false);
  store.recordLive("0.3.18-eeeeeeeeeeee", true);
  assert.equal(readFileSync(marker, "utf8"), written);

  // A marker somebody truncated or hand-edited is "nothing is known", never a crash.
  writeFileSync(marker, "{ not json");
  assert.equal(store.liveFailed("0.3.17-dddddddddddd+00000019"), false);
  store.recordLive("0.3.17-dddddddddddd+00000019", false);
  assert.equal(store.liveFailed("0.3.17-dddddddddddd+00000019"), true);
});

/**
 * Замок обновления после перезагрузки: pid владельца снова занят, но уже чужим
 * процессом. Живость по одному `kill(pid, 0)` держала бы установку вечно - лечилось
 * бы только удалением `data/update.lock` руками.
 */
test("an update lock whose pid now runs somebody else is taken over", (t) => {
  const data = home(t);
  const lock = join(data, "update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      command: "/usr/sbin/cron -f",
    })}\n`,
  );

  assert.equal(updateRunning(data), false);
  const taken = acquireUpdateLock(data);
  assert.ok(taken, "the lock of a reused pid must be free to take");
  taken?.release();
});

/** Обратная сторона: владелец жив и это он - замок чужой, его не забирают. */
test("an update lock held by a live owner is not taken over", (t) => {
  const data = home(t);
  const mine = acquireUpdateLock(data);
  assert.ok(mine);

  assert.equal(updateRunning(data), true);
  assert.equal(acquireUpdateLock(data), null);
  mine?.release();
  assert.equal(updateRunning(data), false);
});

/**
 * Замок старого формата - без записанной команды - судится возрастом: полугодовалый
 * `owner.json` с pid, который сейчас носит системный процесс, не держит обновление.
 * Именно эта комбинация блокировала установку насмерть (проба критика 13.09.2026).
 */
test("an update lock older than an hour with no command recorded is stale", (t) => {
  const data = home(t);
  const lock = join(data, "update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    `${JSON.stringify({
      pid: 1,
      startedAt: new Date(Date.now() - 180 * 24 * 3600_000).toISOString(),
    })}\n`,
  );

  assert.equal(updateRunning(data), false);
  const taken = acquireUpdateLock(data);
  assert.ok(taken, "a lock nobody has held for half a year must be free");
  taken?.release();
});

/** А свежий замок того же старого формата - чужая работа, его не забирают. */
test("a fresh update lock with no command recorded still counts", (t) => {
  const data = home(t);
  const lock = join(data, "update.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    `${JSON.stringify({ pid: 1, startedAt: new Date().toISOString() })}\n`,
  );

  assert.equal(updateRunning(data), true);
  assert.equal(acquireUpdateLock(data), null);
});
