/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  readdir,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashEveTree, listEveTreeFiles } from "./lib/eve-tree-hash.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_ROOT = path.join(ROOT, "eve");
const INSTALLED_ROOT = path.join(ROOT, "node_modules/eve");

interface EveBuildMetadata {
  readonly nodeVersion: string;
  readonly packageVersion: string;
  readonly packedTreeHash: string;
  readonly pnpmVersion: string;
  readonly sourceTreeHash: string;
  readonly upstreamCommit: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

test("eve source files match the git index", async () => {
  const files = new Set(await listEveTreeFiles(SOURCE_ROOT, "source"));
  const tracked = new Set(
    execFileSync("git", ["ls-files", "-z", "--", "eve"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((file) => file.slice("eve/".length)),
  );
  assert.deepEqual(
    {
      missing: [...tracked].filter((file) => !files.has(file)),
      untracked: [...files].filter((file) => !tracked.has(file)),
    },
    { missing: [], untracked: [] },
    "eve source files differ from git index",
  );
});

test("the eve copy holds no tests, documentation or dropped entry points (ADR-0027)", async () => {
  const dropped =
    /(?:^|\/)(?:__snapshots__|__fixtures__)\/|\.test(?:-d)?\.tsx?$|^docs\/|^packages\/eve\/(?:test|extension-contracts)\/|^packages\/eve\/src\/(?:internal\/testing|react|vue|svelte|self-modification|public\/(?:next|nuxt|sveltekit|channels\/(?:slack|teams|discord|linear|twilio|chat-sdk|photon|linq)))\//u;
  const files = await listEveTreeFiles(SOURCE_ROOT, "source");
  assert.deepEqual(
    files.filter((file) => dropped.test(file)),
    [],
    "eve/ carries files that ADR-0027 removed",
  );
  const manifest = await readJson<{
    readonly files: readonly string[];
    readonly exports: Record<string, unknown>;
  }>(path.join(SOURCE_ROOT, "packages/eve/package.json"));
  assert.ok(
    !manifest.files.includes("docs"),
    "the eve package ships without its documentation",
  );
  assert.deepEqual(
    Object.keys(manifest.exports).filter((entry) =>
      /^\.\/(?:react|vue|svelte|next|nuxt|sveltekit|self-modification(?:\/.*)?|channels\/(?:slack|teams|discord|linear|twilio|chat-sdk|photon|linq))$/u.test(
        entry,
      ),
    ),
    [],
    "the eve package exports an entry point that ADR-0027 removed",
  );
});

test("installed eve is the package built from the current eve source tree", async () => {
  const build = await readJson<EveBuildMetadata>(
    path.join(INSTALLED_ROOT, "BUILD.json"),
  );
  const packageJson = await readJson<{ readonly version: string }>(
    path.join(INSTALLED_ROOT, "package.json"),
  );
  const [sourceTreeHash, packedTreeHash] = await Promise.all([
    hashEveTree(SOURCE_ROOT, "source"),
    hashEveTree(INSTALLED_ROOT, "packed"),
  ]);

  const reference = await readJson<{
    version: string;
    sourceTreeHash: string;
    packedTreeHash: string;
  }>(path.join(ROOT, "eve.lock.json"));
  assert.equal(build.sourceTreeHash, reference.sourceTreeHash);
  assert.equal(build.packedTreeHash, reference.packedTreeHash);
  assert.equal(build.packageVersion, reference.version);
  assert.equal(
    sourceTreeHash,
    reference.sourceTreeHash,
    "eve/ differs from the built source tree",
  );
  assert.equal(
    packedTreeHash,
    reference.packedTreeHash,
    "node_modules/eve package was changed",
  );
  assert.equal(
    packageJson.version,
    build.packageVersion,
    "installed eve version differs from BUILD.json",
  );
  assert.match(build.upstreamCommit, /^[0-9a-f]{40}$/u);
  assert.match(build.pnpmVersion, /^11\.25\.0$/u);
  assert.match(build.nodeVersion, /^v\d+\./u);
});

test("eve archive dependency and installed lock metadata agree", async () => {
  type Manifest = {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  type Lock = {
    packages: Record<
      string,
      {
        version: string;
        resolved: string;
        integrity: string;
        dependencies: Record<string, string>;
      }
    >;
  };
  const pkg = await readJson<Manifest>(path.join(ROOT, "package.json"));
  const lock = await readJson<Lock>(path.join(ROOT, "package-lock.json"));
  const installed = await readJson<Lock>(
    path.join(ROOT, "node_modules/.package-lock.json"),
  );
  const build = await readJson<EveBuildMetadata>(
    path.join(INSTALLED_ROOT, "BUILD.json"),
  );
  const entry = lock.packages["node_modules/eve"];
  const have = installed.packages["node_modules/eve"];
  const url = `https://github.com/smixs/iva-agent/releases/download/eve-${build.packageVersion}/eve-${build.packageVersion}.tgz`;
  assert.ok(entry && have);
  assert.equal(entry.version, build.packageVersion);
  assert.equal(pkg.dependencies.eve, url);
  assert.equal(lock.packages[""]?.dependencies.eve, url);
  assert.equal(entry.resolved, url);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
  const localArchive = process.env.EVE_LOCAL_ARCHIVE;
  if (localArchive) {
    assert.equal(have.resolved, `file:${localArchive}`);
    assert.equal(
      "sha512-" +
        createHash("sha512")
          .update(await readFile(path.resolve(ROOT, localArchive)))
          .digest("base64"),
      entry.integrity,
    );
  } else assert.equal(have.resolved, entry.resolved);
  for (const field of ["version", "integrity"] as const)
    assert.equal(
      have[field],
      entry[field],
      `installed eve ${field} differs from lockfile`,
    );
});

test("eve installation uses the archive without a postinstall mutation", async () => {
  const pkg = await readJson<{
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  }>(path.join(ROOT, "package.json"));
  const lock = await readJson<{ packages: Record<string, unknown> }>(
    path.join(ROOT, "package-lock.json"),
  );
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.devDependencies["patch-package"], undefined);
  assert.equal(lock.packages["node_modules/patch-package"], undefined);
  await assert.rejects(access(path.join(ROOT, "patches")), { code: "ENOENT" });
});

test("data migrations match the recorded migration file hashes", async () => {
  const baseline = await readJson<Record<string, string>>(
    path.join(ROOT, "scripts/fixtures/eve-migrations.json"),
  );
  const current = (await readdir(path.join(ROOT, "scripts/migrations"))).sort();
  assert.deepEqual(current, Object.keys(baseline).sort());
  for (const file of current)
    assert.equal(
      createHash("sha256")
        .update(await readFile(path.join(ROOT, "scripts/migrations", file)))
        .digest("hex"),
      baseline[file],
      file,
    );
});

test("migration guard works in a clone with no release tags", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "eve-migrations-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const dir of ["scripts/lib", "scripts/fixtures", "scripts/migrations"])
    await mkdir(path.join(fixture, dir), { recursive: true });
  for (const file of [
    "scripts/eve-copy.test.ts",
    "scripts/lib/eve-tree-hash.ts",
    "scripts/fixtures/eve-migrations.json",
    ...(await readdir(path.join(ROOT, "scripts/migrations"))).map(
      (file) => `scripts/migrations/${file}`,
    ),
  ])
    await copyFile(path.join(ROOT, file), path.join(fixture, file));
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-name-pattern=^data migrations",
      "scripts/eve-copy.test.ts",
    ],
    { cwd: fixture, env: testChildEnvironment(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("coordinated changes to dist and BUILD are rejected by the repository reference", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "eve-reference-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const dir of ["scripts/lib", "eve", "node_modules/eve/dist"])
    await mkdir(path.join(fixture, dir), { recursive: true });
  for (const file of [
    "scripts/eve-copy.test.ts",
    "scripts/lib/eve-tree-hash.ts",
  ])
    await copyFile(path.join(ROOT, file), path.join(fixture, file));
  await writeFile(path.join(fixture, "eve/NOTICE"), "source");
  const installed = path.join(fixture, "node_modules/eve");
  await writeFile(
    path.join(installed, "package.json"),
    JSON.stringify({ version: "0.51.1-iva.1" }),
  );
  await writeFile(path.join(installed, "dist/index.js"), "original code");
  const reference = {
    version: "0.51.1-iva.1",
    sourceTreeHash: await hashEveTree(path.join(fixture, "eve"), "source"),
    packedTreeHash: await hashEveTree(installed, "packed"),
  };
  const build = {
    ...reference,
    packageVersion: reference.version,
    upstreamCommit: "a".repeat(40),
    pnpmVersion: "11.25.0",
    nodeVersion: process.version,
  };
  await writeFile(
    path.join(fixture, "eve.lock.json"),
    JSON.stringify(reference),
  );
  await writeFile(path.join(installed, "BUILD.json"), JSON.stringify(build));
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=^installed eve is",
        "scripts/eve-copy.test.ts",
      ],
      { cwd: fixture, encoding: "utf8", env: testChildEnvironment() },
    );
  const initial = run();
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  await writeFile(path.join(installed, "dist/index.js"), "changed code");
  build.packedTreeHash = await hashEveTree(installed, "packed");
  await writeFile(path.join(installed, "BUILD.json"), JSON.stringify(build));
  const changed = run();
  assert.notEqual(changed.status, 0, changed.stdout + changed.stderr);
});

test("source guard sees ignored directory names nested in authored source", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "eve-source-guard-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  assert.ok(
    !fixture.startsWith(SOURCE_ROOT),
    "fixture must stay outside the real eve source",
  );
  await cp(SOURCE_ROOT, path.join(fixture, "eve"), { recursive: true });
  await mkdir(path.join(fixture, "scripts/lib"), { recursive: true });
  for (const file of [
    ".gitignore",
    "scripts/eve-copy.test.ts",
    "scripts/lib/eve-tree-hash.ts",
  ])
    await copyFile(path.join(ROOT, file), path.join(fixture, file));
  execFileSync("git", ["init", "--quiet"], {
    cwd: fixture,
    env: gitEnvironment(),
  });
  execFileSync("git", ["add", "--", "eve"], {
    cwd: fixture,
    env: gitEnvironment(),
  });
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=^eve source files match",
        "scripts/eve-copy.test.ts",
      ],
      { cwd: fixture, encoding: "utf8", env: testChildEnvironment() },
    );
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const directory = path.join(
    fixture,
    "eve/packages/eve/src/guard-fixture/dist",
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "untracked.ts"), "authored source");
  const changed = run();
  assert.notEqual(changed.status, 0, changed.stdout + changed.stderr);
  assert.match(
    changed.stdout + changed.stderr,
    /eve source files differ from git index/u,
  );
});

function testChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  return env;
}

function hooksPath(root: string): string {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get", "core.hooksPath"],
    {
      cwd: root,
      env: gitEnvironment(),
      encoding: "utf8",
    },
  );
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout;
}

const PNPM_FIXTURE = String.raw`#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(process.env.EVE_TEST_WRONG_PNPM ? "0.0.0" : "11.25.0"); process.exit(0); }
const stage = args[0] === "install" ? "install" : args.includes("build") ? "build" : "pack";
const root = path.dirname(process.cwd());
const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
assert.notEqual(probe.status, 0, stage + " discovered the parent repository");
execFileSync(process.execPath, ["scripts/install-git-hooks.mjs"]);
appendFileSync(path.join(root, "stages.txt"), stage + "\n");
if (stage === "pack") {
  const source = path.join(process.cwd(), "packages/eve");
  const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const destination = args[args.indexOf("--pack-destination") + 1];
  const input = path.join(root, "pack-input");
  rmSync(input, { recursive: true, force: true });
  mkdirSync(input);
  cpSync(source, path.join(input, "package"), { recursive: true });
  if (process.env.EVE_TEST_CORRUPT_SECOND_PACK && readFileSync(path.join(root, "stages.txt"), "utf8").split("\n").filter(stage => stage === "pack").length >= 2)
    writeFileSync(path.join(input, "package/corrupt.js"), "changed after metadata");
  execFileSync("tar", ["-czf", path.join(destination, "eve-" + version + ".tgz"), "-C", input, "package"]);
}
`;

for (const inheritedGitDirectory of [false, true]) {
  test(`eve build preserves Git hooks at every step (inherited Git directory: ${inheritedGitDirectory})`, async () => {
    const before = hooksPath(ROOT);
    const fixture = await mkdtemp(path.join(tmpdir(), "eve-build-hooks-"));
    try {
      execFileSync("git", ["init", "--quiet", fixture], {
        env: gitEnvironment(),
      });
      for (const directory of [
        "scripts/lib",
        "eve/scripts",
        "eve/packages/eve",
      ])
        await mkdir(path.join(fixture, directory), { recursive: true });
      for (const file of [
        "scripts/build-eve.sh",
        "scripts/eve-release.sh",
        "scripts/lib/eve-tree-hash.ts",
        "eve/scripts/install-git-hooks.mjs",
        "eve/scripts/copy-package-license.mjs",
        "eve/LICENSE",
        "eve/NOTICE",
      ])
        await copyFile(path.join(ROOT, file), path.join(fixture, file));
      const packageRoot = path.join(fixture, "eve/packages/eve");
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "eve",
          version: "0.51.1",
          license: "Apache-2.0",
          files: [],
        }),
      );
      const pnpm = path.join(fixture, "pnpm.ts");
      await writeFile(pnpm, PNPM_FIXTURE);
      await chmod(pnpm, 0o755);
      const env: NodeJS.ProcessEnv = {
        ...gitEnvironment(),
        EVE_PNPM_BIN: pnpm,
      };
      if (inheritedGitDirectory) {
        env.GIT_DIR = path.join(fixture, ".git");
        env.GIT_WORK_TREE = fixture;
        env.GIT_COMMON_DIR = env.GIT_DIR;
        env.GIT_INDEX_FILE = path.join(env.GIT_DIR, "index");
      }
      execFileSync(
        "bash",
        [path.join(fixture, "scripts/build-eve.sh"), path.join(fixture, "out")],
        { env },
      );
      assert.equal(
        await readFile(path.join(fixture, "stages.txt"), "utf8"),
        "install\nbuild\npack\npack\n",
      );
      assert.equal(hooksPath(fixture), "");
      assert.equal(hooksPath(ROOT), before);
      if (!inheritedGitDirectory) {
        await writeFile(
          path.join(fixture, "package.json"),
          JSON.stringify({ dependencies: { eve: "0.51.1" } }),
        );
        await writeFile(
          path.join(fixture, "package-lock.json"),
          JSON.stringify({
            packages: {
              "": { dependencies: { eve: "0.51.1" } },
              "node_modules/eve": { version: "0.51.1" },
            },
          }),
        );
        await writeFile(
          path.join(fixture, ".gitignore"),
          "out/\npack-input/\nstages.txt\n",
        );
        const runRelease = () =>
          spawnSync(
            "bash",
            [path.join(fixture, "scripts/eve-release.sh"), "out"],
            { cwd: fixture, env, encoding: "utf8" },
          );
        assert.notEqual(runRelease().status, 0, "dirty tree must be refused");
        const commit = () => {
          execFileSync("git", ["add", "."], { cwd: fixture, env });
          execFileSync(
            "git",
            [
              "-c",
              "user.name=iva",
              "-c",
              "user.email=iva@example.invalid",
              "commit",
              "--quiet",
              "-m",
              "sources",
            ],
            { cwd: fixture, env },
          );
        };
        commit();
        const { eveReleaseVersion } =
          await import("./fixtures/eve-release-version.test-fixture.ts");
        const archive = path.join(
          fixture,
          "out",
          `eve-${eveReleaseVersion(ROOT)}.tgz`,
        );
        const bytes = await readFile(archive);
        const first = runRelease();
        assert.equal(first.status, 0, first.stdout + first.stderr);
        const lock = await readFile(path.join(fixture, "package-lock.json"));
        commit();
        const second = runRelease();
        assert.equal(second.status, 0, second.stdout + second.stderr);
        assert.deepEqual(
          await readFile(path.join(fixture, "package-lock.json")),
          lock,
        );
        assert.deepEqual(await readFile(archive), bytes);
        assert.equal(
          await readFile(path.join(fixture, "stages.txt"), "utf8"),
          "install\nbuild\npack\npack\n",
          "release must reuse the archive",
        );
        const unpacked = path.join(fixture, "out/tamper");
        await mkdir(unpacked);
        execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
        await writeFile(
          path.join(unpacked, "package/corrupt.js"),
          "different archive contents",
        );
        execFileSync("tar", ["-czf", archive, "-C", unpacked, "package"]);
        const changedArchive = runRelease();
        assert.notEqual(
          changedArchive.status,
          0,
          "reused archive must match its packed hash",
        );
        assert.match(changedArchive.stderr, /Archive contents differ/u);
        assert.deepEqual(
          await readFile(path.join(fixture, "package-lock.json")),
          lock,
        );
        await writeFile(archive, bytes);
        await writeFile(path.join(fixture, "stages.txt"), "");
        const corruptBuild = spawnSync(
          "bash",
          [
            path.join(fixture, "scripts/build-eve.sh"),
            path.join(fixture, "out"),
          ],
          {
            env: { ...env, EVE_TEST_CORRUPT_SECOND_PACK: "1" },
            encoding: "utf8",
          },
        );
        assert.notEqual(
          corruptBuild.status,
          0,
          "second packing must be checked against the first",
        );
        assert.match(
          corruptBuild.stderr,
          /Archive contents differ from BUILD.json/u,
        );
        await writeFile(archive, bytes);
        const wrongPnpm = spawnSync(
          "bash",
          [
            path.join(fixture, "scripts/build-eve.sh"),
            path.join(fixture, "out"),
          ],
          { env: { ...env, EVE_TEST_WRONG_PNPM: "1" }, encoding: "utf8" },
        );
        assert.notEqual(wrongPnpm.status, 0);
        assert.match(wrongPnpm.stderr, /pnpm.*11\.25\.0/u);
        await writeFile(path.join(fixture, "eve/NOTICE"), "changed source\n");
        commit();
        const stale = runRelease();
        assert.notEqual(stale.status, 0);
        assert.match(stale.stderr, /Existing archive is stale/u);
        assert.deepEqual(await readFile(archive), bytes);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
