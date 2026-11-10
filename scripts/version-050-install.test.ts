import "./fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCliRuntime } from "./cli/runtime.ts";
import { createAccountCommands } from "./cli/account.ts";
import { createDoctorCommand } from "./cli/doctor.ts";
import { createDiagnoseCommand } from "./cli/diagnose.ts";
import type { createCliSystemd } from "./cli/systemd.ts";
import statusMenu from "./lib/menu/status.ts";
import { createVersionStore, versionName } from "./lib/version-store.ts";
import { runVersionUpdate } from "./lib/version-update.ts";
import {
  fixtureRunner,
  fixtureProbe,
} from "./fixtures/version-update-harness.ts";
import { eveArchive, runChild, NPM_CLI } from "./fixtures/eve-archive.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NOW = new Date("2026-10-15T01:23:45.000Z");
const TRANSITIONS = [
  ["0.4.17", "0.5.0"],
  ["0.4.9", "0.5.0"],
  ["0.5.0", "0.5.1"],
] as const;
function workspace(t: TestContext): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "iva-version-050-install-")),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root: string, file: string, body: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}
function lifecycle(): ReturnType<typeof createCliSystemd> {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    restartServices: () => undefined,
  };
}

for (const [from, to] of TRANSITIONS) {
  void test(`${from} -> ${to}: new updater builds, probes, activates and settles the numeric version`, async (t) => {
    const home = workspace(t);
    const repo = join(home, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "iva");
    git("config", "user.email", "iva@example.invalid");
    write(repo, "package.json", JSON.stringify({ name: "iva", version: to }));
    write(repo, "agent/agent.ts", "export const agent = 1;\n");
    git("add", "-A");
    git("commit", "-qm", to);
    const sha = git("rev-parse", "HEAD");
    const store = createVersionStore(home);
    const old = versionName(from, "0123456789ab");
    const oldDir = store.stage(old);
    write(oldDir, "package.json", JSON.stringify({ version: from }));
    store.linkState(oldDir);
    store.complete(old);
    store.activate(old);
    store.settle(old);
    write(home, "data/sentinel", "user data\n");
    const result = await runVersionUpdate({
      home,
      resolveTarget: () => Promise.resolve({ sha, version: to }),
      run: fixtureRunner(),
      probe: fixtureProbe(),
      quiesce: () => Promise.resolve(),
      resumeOldWriters: () => Promise.resolve(),
      startCandidate: () => Promise.resolve(),
      serving: () => Promise.resolve({ ok: true, log: "fixture serving" }),
    });
    assert.equal(result.status, "updated", JSON.stringify(result));
    const name = versionName(to, sha);
    assert.equal(store.currentName(), name);
    assert.equal(store.settled(), name);
    assert.equal(store.previousName(), old);
    assert.equal(
      readFileSync(join(home, "data/sentinel"), "utf8"),
      "user data\n",
    );
  });
}

for (const version of ["0.5.0", "0.5.0-beta.1", "0.5.1"]) {
  void test(`${version}: iva version, doctor, diagnose and menu read the full version`, async (t) => {
    const home = workspace(t);
    const name = versionName(version, "0123456789ab");
    const store = createVersionStore(home);
    const dir = store.stage(name);
    const eve = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { dependencies: { eve: string } };
    write(
      dir,
      "package.json",
      JSON.stringify({
        name: "iva",
        version,
        dependencies: { eve: eve.dependencies.eve },
      }),
    );
    write(dir, ".output/server/index.mjs", "export {};\n");
    store.linkState(dir);
    store.complete(name);
    store.activate(name);
    store.settle(name);
    const env = {
      MODEL_PROVIDER: "ollama",
      AGENT_LANGUAGE: "en",
      ASSISTANT_DATA_DIR: join(home, "data"),
      ASSISTANT_VAULT_DIR: join(home, "vault"),
    };
    const events: string[] = [];
    const runtime = {
      ...createCliRuntime(dir),
      readEnv: () => env,
      hasSystemd: () => false,
      ok: (text: string) => {
        events.push(text);
      },
      warn: (text: string) => {
        events.push(text);
      },
      bad: (text: string) => {
        events.push(text);
      },
      cap: () => ({ code: 1, out: "", err: "fixture: no systemd" }),
    };
    createAccountCommands(runtime, lifecycle(), {
      log: (...args: unknown[]) => {
        events.push(args.map(String).join(" "));
      },
    }).cmdVersion();
    assert.ok(
      events.includes(`iva ${version} · commit 0123456789ab · updates stable`),
    );
    await createDoctorCommand(runtime, lifecycle(), {
      nodeVersion: "24.21.0",
      log: () => {},
      exit: () => undefined,
    })();
    assert.ok(
      events.some((text) => text.includes(`current ${name}`)),
      events.join("\n"),
    );
    await createDiagnoseCommand(runtime, lifecycle(), { now: () => NOW })();
    const diagnose = readFileSync(
      join(home, "data/diagnose/2026-10-15T01-23-45-000Z.md"),
      "utf8",
    );
    assert.ok(diagnose.includes(`- iva: ${version} (git 0123456789ab)`));
    assert.ok(diagnose.includes(`- eve: ${eve.dependencies.eve}`));
    write(home, ".env", "MODEL_PROVIDER=ollama\n");
    const menu = await statusMenu.render(
      { chatId: 42, userId: 42, screen: "st" },
      {
        deps: {
          root: dir,
          envPath: join(home, ".env"),
          dataDir: join(home, "data"),
          probeUserbotHealth: () => Promise.resolve({ state: "off" }),
        },
        flows: { get: () => null, screen: () => Promise.resolve() },
        getLang: () => "en",
        tr: (en: string) => en,
      },
    );
    assert.ok(menu.text.includes(`Iva v${version}`));
  });
}

void test("eve archive npm ci accepts the 0.5.0 and 0.5.1 package/lock manifest on the wire", async (t) => {
  const root = workspace(t);
  const archive = await eveArchive(t, root);
  for (const version of ["0.5.0", "0.5.1"]) {
    const dir = join(root, version);
    archive.writeManifest(dir, version);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(?:npm_config_|NPM_CONFIG_)/u.test(key)) delete env[key];
    const result = await runChild(
      process.execPath,
      [NPM_CLI, "ci", "--no-audit", "--no-fund"],
      env,
      dir,
    );
    assert.equal(result.code, 0, result.output);
    const installed = JSON.parse(
      readFileSync(join(dir, "node_modules/eve/package.json"), "utf8"),
    ) as { version: string };
    assert.equal(installed.version, "0.51.1-iva.1");
    const lock = JSON.parse(
      readFileSync(join(dir, "package-lock.json"), "utf8"),
    ) as { version: string };
    assert.equal(lock.version, version);
  }
  assert.ok(archive.requests.includes("/eve.tgz"));
  assert.ok(archive.requests.includes("/asset.tgz"));
});

void test("eve release manifest writer preserves Iva 0.5.0 independently of eve's archive version", (t) => {
  const root = workspace(t);
  const script = readFileSync(join(ROOT, "scripts/eve-release.sh"), "utf8");
  const program = /<<'JS'\n([\s\S]*?)\nJS\n/u.exec(script)?.[1];
  const version = /^version="([^"]+)"$/mu.exec(script)?.[1];
  assert.ok(program);
  assert.ok(version);
  const buildVersion = /^version="([^"]+)"$/mu.exec(
    readFileSync(join(ROOT, "scripts/build-eve.sh"), "utf8"),
  )?.[1];
  assert.equal(buildVersion, version);
  for (const ivaVersion of ["0.4.17", "0.4.9", "0.5.0", "0.5.1"]) {
    const dir = join(root, ivaVersion);
    const pkg = {
      name: "iva",
      version: ivaVersion,
      dependencies: { eve: "old" },
    };
    write(dir, "package.json", JSON.stringify(pkg));
    write(
      dir,
      "package-lock.json",
      JSON.stringify({
        version: ivaVersion,
        packages: { "": pkg, "node_modules/eve": {} },
      }),
    );
    write(dir, "archive.tgz", "fixture archive bytes");
    write(
      dir,
      "package/BUILD.json",
      JSON.stringify({
        sourceTreeHash: "source",
        packedTreeHash: "packed",
        packageVersion: version,
      }),
    );
    write(
      dir,
      "package/package.json",
      JSON.stringify({ name: "eve", version }),
    );
    const url: string = `https://github.com/smixs/iva-agent/releases/download/eve-${version}/eve-${version}.tgz`;
    const args = [
      "--input-type=module",
      "-",
      join(dir, "archive.tgz"),
      join(dir, "package"),
      version,
      url,
      "source",
      "packed",
    ];
    execFileSync(process.execPath, [...args, "false"], {
      cwd: dir,
      input: program,
    });
    // The read-only publish preflight must accept the same manifests too.
    execFileSync(process.execPath, [...args, "true"], {
      cwd: dir,
      input: program,
    });
    const actual = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as { version: string; dependencies: { eve: string } };
    const lock = JSON.parse(
      readFileSync(join(dir, "package-lock.json"), "utf8"),
    ) as { version: string; packages: Record<string, { version: string }> };
    assert.equal(actual.version, ivaVersion);
    assert.equal(lock.version, ivaVersion);
    assert.equal(lock.packages[""].version, ivaVersion);
    assert.equal(lock.packages["node_modules/eve"].version, version);
    assert.equal(actual.dependencies.eve, url);
  }
});

void test("agent User-Agent reads 0.5.0, its beta and 0.5.1 from the installation manifest", (t) => {
  const root = workspace(t);
  for (const version of ["0.5.0", "0.5.0-beta.1", "0.5.1"]) {
    const dir = join(root, version);
    write(dir, "package.json", JSON.stringify({ version }));
    const source = `const { IVA_USER_AGENT } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "agent/provider.ts")).href)}); process.stdout.write(IVA_USER_AGENT);`;
    const actual = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, MODEL_PROVIDER: "ollama" },
      },
    );
    assert.equal(actual, `iva/${version}`);
  }
});

void test("beta.sh reads 0.5.0 active markers and checkout package versions verbatim", (t) => {
  const root = workspace(t);
  const fn = /^active\(\) \{[\s\S]*?^\}/mu.exec(
    readFileSync(join(ROOT, "beta.sh"), "utf8"),
  )?.[0];
  assert.ok(fn);
  for (const version of ["0.5.0", "0.5.0-beta.1", "0.5.1"]) {
    const home = join(root, version);
    write(home, "package.json", JSON.stringify({ version }));
    const env = { ...process.env, INSTALL_DIR: home };
    execFileSync("git", ["init", "-q", "-b", "main", home]);
    execFileSync("git", ["-C", home, "add", "package.json"]);
    execFileSync("git", [
      "-C",
      home,
      "-c",
      "user.name=iva",
      "-c",
      "user.email=iva@example.invalid",
      "commit",
      "-qm",
      version,
    ]);
    const sha = execFileSync("git", ["-C", home, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const checkout: string = execFileSync("bash", ["-c", `${fn}\nactive`], {
      env,
      encoding: "utf8",
    });
    assert.equal(checkout, `${version}-${sha}`);
    const name = versionName(version, "0123456789ab");
    write(
      home,
      "data/active.json",
      JSON.stringify({ schema: "iva-active/v2", version: name }),
    );
    const active: string = execFileSync("bash", ["-c", `${fn}\nactive`], {
      env,
      encoding: "utf8",
    });
    assert.equal(active.trim(), name);
  }
});
