/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const INIT_VAULT = fileURLToPath(new URL("./init-vault.mjs", import.meta.url));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "iva-init-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeTemplate(root: string) {
  const template = join(root, "vault-template");
  mkdirSync(join(template, "cards"), { recursive: true });
  writeFileSync(join(template, "CORE.md"), "Russian core\n");
  writeFileSync(join(template, "CORE.en.md"), "English core\n");
  writeFileSync(join(template, "MOC.md"), "MOC\n");
  writeFileSync(join(template, "cards", ".gitkeep"), "");
}

function withoutGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_CONFIG_GLOBAL;
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(root, "empty-home"),
    XDG_CONFIG_HOME: join(root, "empty-xdg"),
  };
}

function runInit(root: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [INIT_VAULT], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

void test("init-vault rejects a missing template before creating a vault", async (t) => {
  const root = await sandbox(t);
  const result = runInit(root, {
    ...process.env,
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /template .* not found/u);
  assert.equal(existsSync(join(root, "live-vault")), false);
});

void test("init-vault creates the first commit with repo-local identity on a fresh server", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const env: NodeJS.ProcessEnv = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  };
  const result = runInit(root, env);
  const vault = join(root, "live-vault");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /vault created from template/u);
  assert.doesNotMatch(
    result.stderr,
    /first commit failed|Author identity unknown/u,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", vault, ...args], {
      env,
      encoding: "utf8",
    }).trim();
  assert.equal(git("log", "-1", "--format=%an <%ae>"), "Iva <iva@localhost>");
  assert.equal(git("config", "--local", "--get", "user.name"), "Iva");
  assert.equal(
    git("config", "--local", "--get", "user.email"),
    "iva@localhost",
  );
  assert.equal(existsSync(join(env.HOME!, ".gitconfig")), false);
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME!, "git/config")), false);
  assert.equal(readFileSync(join(vault, "CORE.md"), "utf8"), "Russian core\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
  assert.equal(readFileSync(join(vault, "MOC.md"), "utf8"), "MOC\n");
  assert.equal(existsSync(join(vault, ".git")), true);
});

void test("init-vault preserves an existing vault identity and the global git configuration", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const vault = join(root, "live-vault");
  const env: NodeJS.ProcessEnv = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  };
  mkdirSync(env.HOME!, { recursive: true });
  const global = join(env.HOME!, ".gitconfig");
  const globalText =
    "[user]\n\tname = Global owner\n\temail = global@example.test\n";
  writeFileSync(global, globalText);
  execFileSync("git", ["init", "-q", vault], { env });
  for (const [key, value] of [
    ["user.name", "Vault owner"],
    ["user.email", "vault@example.test"],
  ])
    execFileSync("git", ["-C", vault, "config", "--local", key, value], {
      env,
    });
  const result = runInit(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(global, "utf8"), globalText);
  for (const [key, value] of [
    ["user.name", "Vault owner"],
    ["user.email", "vault@example.test"],
  ])
    assert.equal(
      execFileSync("git", ["-C", vault, "config", "--local", "--get", key], {
        env,
        encoding: "utf8",
      }).trim(),
      value,
    );
});

void test("init-vault selects English CORE when requested", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = runInit(root, {
    ...withoutGitIdentity(root),
    AGENT_LANGUAGE: "en",
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, "live-vault", "CORE.md"), "utf8"),
    "English core\n",
  );
  assert.equal(existsSync(join(root, "live-vault", "CORE.en.md")), false);
});

void test("init-vault preserves an existing vault on repeated runs", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const env = {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  };
  const first = runInit(root, env);
  const vault = join(root, "live-vault");
  writeFileSync(join(vault, "personal.md"), "keep this\n");
  const second = runInit(root, env);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(
    second.stdout,
    /vault already has data, skipping template copy/u,
  );
  assert.equal(readFileSync(join(vault, "personal.md"), "utf8"), "keep this\n");
  assert.equal(existsSync(join(vault, "CORE.en.md")), false);
});

void test("init-vault leaves a non-empty pre-existing vault untouched", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const vault = join(root, "live-vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "personal.md"), "private memory\n");

  const result = runInit(root, {
    ...withoutGitIdentity(root),
    ASSISTANT_VAULT_DIR: "live-vault",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /vault already has data, skipping template copy/u,
  );
  assert.equal(
    readFileSync(join(vault, "personal.md"), "utf8"),
    "private memory\n",
  );
  assert.equal(existsSync(join(vault, "CORE.md")), false);
  assert.equal(existsSync(join(vault, ".git")), true);
  assert.equal(
    execFileSync("git", ["-C", vault, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).trim(),
    "true",
  );
});

// Атомарная запись оставляет временный файл рядом с данными, если писателя убили
// сигналом, а ночной brain делает `git add -A` — огрызок не должен попасть в историю
// vault. Проверяем НАСТОЯЩИМ git'ом и настоящими именами обоих писателей: python
// (tempfile.mkstemp → tmpXXXX.tmp) и TypeScript (fs-atomic → <файл>.tmp-<pid>-<uuid>).
void test("the vault template ignores half-written temp files, not real cards", async (t) => {
  const root = await sandbox(t);
  const vault = join(root, "vault");
  mkdirSync(join(vault, "cards"), { recursive: true });
  const template = fileURLToPath(
    new URL("../vault-template/.gitignore", import.meta.url),
  );
  writeFileSync(join(vault, ".gitignore"), readFileSync(template, "utf8"));

  execFileSync("git", ["-C", vault, "init", "-q"]);
  mkdirSync(join(vault, ".index"));
  for (const name of [
    "cards/tmpjsxhjx4o.tmp",
    "cards/ivan.md.tmp-23940-c9d1d4da-9f4c-477f-ac92-7972aedd15ea",
    "cards/ivan.md",
    "MOC.md",
    // Производный кэш hybrid-поиска: в бэкап vault ему не место (T351).
    ".index/embeddings.json",
  ])
    writeFileSync(join(vault, name), "x\n");
  execFileSync("git", ["-C", vault, "add", "-A"]);

  const staged = execFileSync(
    "git",
    ["-C", vault, "diff", "--cached", "--name-only"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(staged, [".gitignore", "MOC.md", "cards/ivan.md"]);
});

// T24 v3: пустое значение — одна строка причины и код 1, без стека на импорте.
test("пустой ASSISTANT_VAULT_DIR: одна строка и код 1 без стека", async (t) => {
  const root = await sandbox(t);
  makeTemplate(root);
  const result = spawnSync(process.execPath, [INIT_VAULT], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_VAULT_DIR: "" },
  });
  assert.equal(result.status, 1, result.stderr);
  const err = result.stderr.trim();
  assert.match(err, /ASSISTANT_VAULT_DIR/);
  assert.ok(!err.includes("    at "), `в stderr стек: ${err}`);
  assert.ok(err.split("\n").length === 1, `строк больше одной: ${err}`);
});
