/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createVersionStore } from "./lib/version-store.ts";
import {
  eveArchive,
  runChild,
  type ArchiveFault,
} from "./fixtures/eve-archive.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: "iva",
  GIT_AUTHOR_EMAIL: "iva@example.invalid",
  GIT_COMMITTER_NAME: "iva",
  GIT_COMMITTER_EMAIL: "iva@example.invalid",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}
function write(root: string, file: string, value: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), value);
}
// These cases exercise the candidate CLI, with fixture version labels.
// The shipped CLI shim and its real dispatcher run against fixture paths. Only import
// locations change: source modules remain in this checkout, with its installed dependencies.
const CLI = readFileSync(join(ROOT, "bin/iva.mjs"), "utf8")
  .replace(
    '"../scripts/cli/main.ts"',
    JSON.stringify(pathToFileURL(join(ROOT, "scripts/cli/main.ts")).href),
  )
  .replace(
    '"../scripts/lib/version-layout.ts"',
    JSON.stringify(
      pathToFileURL(join(ROOT, "scripts/lib/version-layout.ts")).href,
    ),
  );
const FINISH = `import { main } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/update-finish.ts")).href)};
process.exitCode = await main(process.argv.slice(2));\n`;

for (const layout of ["current", "lost-current", "legacy"] as const) {
  for (const fault of [
    "ok",
    "404",
    "drop",
    "integrity",
    "truncated",
  ] satisfies ArchiveFault[]) {
    test(`candidate CLI: archive npm ci through ${layout === "legacy" ? "repair.sh" : "iva update"} (${layout}, ${fault}) preserves serving output, installed eve and data before activation`, async (t) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "iva-eve-archive-update-")),
      );
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, "iva"),
        source = join(root, "source"),
        remote = join(root, "remote.git"),
        tools = join(root, "tools"),
        log = join(root, "npm.log");
      const archive = await eveArchive(t, root);
      archive.setFault(fault);
      write(
        source,
        "package.json",
        JSON.stringify({
          name: "iva",
          version: layout === "legacy" ? "0.5.0" : "0.5.9",
          type: "module",
        }),
      );
      write(source, "bin/iva.mjs", CLI);
      write(source, "scripts/update-finish.ts", FINISH);
      write(source, ".gitignore", ".env\ndata/\n.output/\nnode_modules/\n");
      git(source, "init", "--quiet", "--initial-branch=main");
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "old installation");
      const oldSha = git(source, "rev-parse", "HEAD");
      const oldName = `0.5.9-${oldSha.slice(0, 12)}`;
      archive.writeManifest(source);
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "new archive dependency");
      git(source, "tag", "v0.5.12");
      git(root, "clone", "--quiet", "--bare", source, remote);
      mkdirSync(home, { recursive: true });
      write(home, ".env", "MODEL_PROVIDER=ollama\nAGENT_LANGUAGE=en\n");
      write(home, "data/sentinel", "user data\n");
      let oldRoot: string;
      if (layout === "legacy") {
        git(home, "init", "--quiet", "--initial-branch=main");
        git(home, "remote", "add", "origin", remote);
        git(home, "fetch", "--quiet", "origin", "main");
        git(home, "reset", "--quiet", "--hard", oldSha);
        oldRoot = home;
      } else {
        git(root, "clone", "--quiet", "--mirror", remote, join(home, "repo"));
        const store = createVersionStore(home);
        const name = oldName;
        oldRoot = store.stage(name);
        write(
          oldRoot,
          "package.json",
          '{"name":"iva","version":"0.5.9","type":"module"}',
        );
        write(oldRoot, "bin/iva.mjs", CLI);
        store.linkState(oldRoot);
        store.complete(name);
        store.activate(name);
        store.settle(name);
        if (layout === "lost-current") rmSync(join(home, "current"));
      }
      write(oldRoot, ".output/marker", "old serving code\n");
      write(
        oldRoot,
        "node_modules/eve/package.json",
        '{"name":"eve","version":"0.51.1"}',
      );
      mkdirSync(tools);
      symlinkSync(process.execPath, join(tools, "node"));
      // Even an unexpected service call is contained in this hermetic world.
      write(tools, "systemctl", "#!/bin/sh\nexit 0\n");
      chmodSync(join(tools, "systemctl"), 0o755);
      const env = {
        ...process.env,
        ...IDENTITY,
        HOME: root,
        PATH: `${tools}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: home,
        IVA_TEST_NPM_LOG: log,
        NO_COLOR: "1",
        TERM: "dumb",
      };
      for (const key of Object.keys(env))
        if (
          /^(?:npm_config_|NPM_CONFIG_|ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(key)
        )
          delete (env as NodeJS.ProcessEnv)[key];
      const run = () =>
        layout === "legacy"
          ? runChild("bash", [join(ROOT, "repair.sh")], env, root)
          : runChild(
              process.execPath,
              [join(oldRoot, "bin/iva.mjs"), "update"],
              env,
              root,
            );
      const result = await run();
      const npmLogs = readdirSync(join(root, "npm-cache/_logs"))
        .filter((file) => file.endsWith(".log"))
        .map((file) =>
          readFileSync(join(root, "npm-cache/_logs", file), "utf8"),
        )
        .join("\n");
      assert.match(
        npmLogs,
        /verbose argv "ci" "--no-audit" "--no-fund"/u,
        result.output,
      );
      assert.match(
        npmLogs,
        /cwd .*\/versions\/0\.5\.12-[a-f0-9]{12}/u,
        result.output,
      );
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      assert.ok(archive.requests.includes("/asset.tgz"), result.output);
      assert.equal(result.code, 1, result.output);
      assert.equal(calls.includes("CI_OK"), fault === "ok", result.output);
      assert.match(
        result.output,
        fault === "ok"
          ? /EVE_TEST_STOP_AFTER_CI/u
          : fault === "404"
            ? /E404/u
            : fault === "integrity"
              ? /EINTEGRITY/u
              : /ECONNRESET|ETIMEDOUT|EIDLETIMEOUT|ERR_SOCKET_TIMEOUT/u,
      );
      const checkOld = () => {
        assert.equal(
          readFileSync(join(oldRoot, ".output/marker"), "utf8"),
          "old serving code\n",
        );
        assert.equal(
          (
            JSON.parse(
              readFileSync(
                join(oldRoot, "node_modules/eve/package.json"),
                "utf8",
              ),
            ) as { version: string }
          ).version,
          "0.51.1",
        );
        assert.equal(
          readFileSync(join(home, "data/sentinel"), "utf8"),
          "user data\n",
        );
        assert.equal(
          createVersionStore(home).currentName(),
          layout === "legacy" ? null : oldName,
        );
      };
      checkOld();
      assert.equal(
        (
          JSON.parse(readFileSync(join(oldRoot, "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
        layout === "legacy" ? "0.5.12" : "0.5.9",
        "repair.sh resets legacy source files to the candidate before npm ci",
      );
      if (layout === "legacy")
        assert.notEqual(git(home, "rev-parse", "HEAD"), oldSha);
      if (fault === "truncated") {
        archive.setFault("ok");
        const retry = await run();
        assert.match(readFileSync(log, "utf8"), /CI_OK/u, retry.output);
        assert.match(retry.output, /EVE_TEST_STOP_AFTER_CI/u);
        checkOld();
      }
      assert.ok(
        archive.requests.every((url) =>
          ["/eve.tgz", "/asset.tgz"].includes(url),
        ),
        archive.requests.join("\n"),
      );
    });
  }
}

function unpackTree(ref: string, directory: string, root: string) {
  if (ref.startsWith("v")) {
    const tag = spawnSync(
      "git",
      ["rev-parse", "--verify", `refs/tags/${ref}^{commit}`],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(
      tag.status,
      0,
      `нужны метки выпусков: git fetch --tags (${ref})`,
    );
  }
  mkdirSync(directory, { recursive: true });
  const tar = join(root, "tree.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, ref], {
    cwd: ROOT,
  });
  execFileSync("tar", ["-xf", tar, "-C", directory]);
  rmSync(tar);
}

function assertHistoricalTree(directory: string, version: string) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  assert.equal(manifest.version, version, "historical manifest version");
}

const minimum = (
  JSON.parse(readFileSync(join(ROOT, "update-compat.json"), "utf8")) as {
    minUpdater: string;
  }
).minUpdater;
for (const version of [minimum]) {
  for (const fault of ["ok", "404", "integrity"] satisfies ArchiveFault[]) {
    test(`historical v${version} CLI hands off to downloaded update-finish (${fault})`, async (t) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "iva-historical-update-")),
      );
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const source = join(root, "source"),
        home = join(root, "iva"),
        remote = join(root, "remote.git"),
        log = join(root, "npm.log");
      const archive = await eveArchive(t, root);
      archive.setFault(fault);
      unpackTree(`v${version}`, source, root);
      assertHistoricalTree(source, version);
      git(source, "init", "--quiet", "--initial-branch=main");
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "historical tree");
      const oldSha = git(source, "rev-parse", "HEAD"),
        oldName = `${version}-${oldSha.slice(0, 12)}`;
      // Overlay the complete candidate tree. Its imports stay relative to the downloaded tree.
      for (const file of readdirSync(source))
        if (file !== ".git")
          rmSync(join(source, file), { recursive: true, force: true });
      unpackTree("HEAD", source, root);
      archive.writeManifest(source);
      git(source, "add", "-A");
      git(source, "commit", "--quiet", "-m", "candidate tree");
      git(source, "tag", "v0.5.12");
      git(root, "clone", "--quiet", "--no-local", "--mirror", source, remote);
      mkdirSync(home);
      git(root, "clone", "--quiet", "--mirror", remote, join(home, "repo"));
      const store = createVersionStore(home),
        oldRoot = store.stage(oldName);
      unpackTree(`v${version}`, oldRoot, root);
      assertHistoricalTree(oldRoot, version);
      // Shared candidate dependencies satisfy the historical first half and the new
      // updater's early imports; npm ci installs only into the staged candidate.
      symlinkSync(join(ROOT, "node_modules"), join(home, "node_modules"));
      store.linkState(oldRoot);
      store.complete(oldName);
      store.activate(oldName);
      store.settle(oldName);
      write(home, ".env", "MODEL_PROVIDER=ollama\nAGENT_LANGUAGE=en\n");
      write(home, "data/sentinel", "user data\n");
      write(oldRoot, ".output/marker", "old serving code\n");
      const oldCli = readFileSync(join(oldRoot, "bin/iva.mjs"));
      assert.deepEqual(
        oldCli,
        execFileSync("git", ["show", `v${version}:bin/iva.mjs`], { cwd: ROOT }),
      );
      const tools = join(root, "tools");
      mkdirSync(tools);
      write(tools, "systemctl", "#!/bin/sh\nexit 0\n");
      chmodSync(join(tools, "systemctl"), 0o755);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...IDENTITY,
        HOME: root,
        PATH: `${tools}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        IVA_TEST_NPM_LOG: log,
        NO_COLOR: "1",
        TERM: "dumb",
      };
      for (const key of Object.keys(env))
        if (
          /^(?:npm_config_|NPM_CONFIG_|ANTHROPIC_|CLAUDE_CODE_USE_)/u.test(key)
        )
          delete env[key];
      const result = await runChild(
        process.execPath,
        [join(oldRoot, "bin/iva.mjs"), "update"],
        env,
        root,
      );
      assert.ok(archive.requests.includes("/asset.tgz"), result.output);
      assert.equal(result.code, 1, result.output);
      assert.equal(existsSync(log), fault === "ok", result.output);
      assert.match(
        result.output,
        fault === "ok"
          ? /EVE_TEST_STOP_AFTER_CI/u
          : fault === "404"
            ? /E404/u
            : /EINTEGRITY/u,
      );
      assert.equal(store.currentName(), oldName);
      assert.deepEqual(readFileSync(join(oldRoot, "bin/iva.mjs")), oldCli);
      assert.equal(
        readFileSync(join(oldRoot, ".output/marker"), "utf8"),
        "old serving code\n",
      );
      assert.equal(
        readFileSync(join(home, "data/sentinel"), "utf8"),
        "user data\n",
      );
      assert.equal(
        (
          JSON.parse(readFileSync(join(oldRoot, "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
        version,
      );
      const logs = readdirSync(join(root, "npm-cache/_logs"))
        .map((file) =>
          readFileSync(join(root, "npm-cache/_logs", file), "utf8"),
        )
        .join("\n");
      assert.match(logs, /verbose argv "ci" "--no-audit" "--no-fund"/u);
      assert.match(logs, /cwd .*\/versions\/0\.5\.12-[a-f0-9]{12}/u);
      assert.ok(
        archive.requests.every((url) =>
          ["/eve.tgz", "/asset.tgz"].includes(url),
        ),
        archive.requests.join("\n"),
      );
    });
  }
}

test("historical tests explain missing release tags in a clone", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iva-no-tags-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = join(root, "clone");
  git(root, "clone", "--quiet", "--no-tags", "--shared", ROOT, clone);
  // Exercise the candidate test, including changes not committed yet.
  write(
    clone,
    "scripts/eve-archive-update.test.ts",
    readFileSync(join(ROOT, "scripts/eve-archive-update.test.ts"), "utf8"),
  );
  symlinkSync(join(ROOT, "node_modules"), join(clone, "node_modules"));
  assert.equal(git(clone, "tag", "--list"), "");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const version of [minimum]) {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        `--test-name-pattern=^historical v${version} CLI.*\\(404\\)$`,
        "scripts/eve-archive-update.test.ts",
      ],
      { cwd: clone, env, encoding: "utf8" },
    );
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /нужны метки выпусков: git fetch --tags/u);
    assert.doesNotMatch(output, /fatal: not a valid object name/u);
  }
});
