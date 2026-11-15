/* eslint-disable @typescript-eslint/require-await -- async test double preserves the git adapter contract. */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPDATE_BRANCH,
  persistUpdateBranch,
  resolveUpdateTarget,
  syncUpdateBranch,
  UPDATE_BRANCH_CONFIG,
  type Git,
  type GitResult,
} from "./update-channel.ts";

type GitStep = {
  args: string[];
  code?: number;
  stdout?: string;
  stderr?: string;
};

type ScriptedGit = Git & { assertComplete: () => void };

function scriptedGit(steps: GitStep[]): ScriptedGit {
  let index = 0;
  const git: Git = async (...args: string[]): Promise<GitResult> => {
    assert.ok(index < steps.length, `unexpected git call: ${args.join(" ")}`);
    const step = steps[index];
    index += 1;
    assert.deepEqual(args, step.args);
    return {
      code: step.code ?? 0,
      stdout: step.stdout ?? "",
      stderr: step.stderr ?? "",
    };
  };
  return Object.assign(git, {
    assertComplete: (): void => assert.equal(index, steps.length),
  });
}

void test("update channel constants preserve the main branch and local config key", () => {
  assert.equal(DEFAULT_UPDATE_BRANCH, "main");
  assert.equal(UPDATE_BRANCH_CONFIG, "iva.updateBranch");
});

void test("configured update branch is validated and resolved through FETCH_HEAD", async () => {
  const git = scriptedGit([
    {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "worktree\n",
    },
    {
      args: ["config", "--local", "--get", "iva.updateBranch"],
      stdout: "release/beta\n",
    },
    { args: ["check-ref-format", "--branch", "release/beta"] },
    {
      args: ["fetch", "--prune", "upstream", "refs/heads/release/beta"],
    },
    { args: ["rev-parse", "FETCH_HEAD"], stdout: "abc123\n" },
  ]);

  assert.deepEqual(await resolveUpdateTarget({ git, remote: "upstream" }), {
    branch: "release/beta",
    currentBranch: "worktree",
    configured: true,
    legacyMigration: false,
    targetHead: "abc123",
  });
  git.assertComplete();
});

void test("configured branch validation and fetch failures stop target resolution", async (t) => {
  await t.test("invalid branch", async () => {
    const git = scriptedGit([
      {
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        stdout: "main\n",
      },
      {
        args: ["config", "--local", "--get", "iva.updateBranch"],
        stdout: "not valid\n",
      },
      {
        args: ["check-ref-format", "--branch", "not valid"],
        code: 1,
      },
    ]);

    await assert.rejects(
      () => resolveUpdateTarget({ git }),
      /invalid update branch: not valid/,
    );
    git.assertComplete();
  });

  await t.test("missing remote branch", async () => {
    const git = scriptedGit([
      {
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        stdout: "main\n",
      },
      {
        args: ["config", "--local", "--get", "iva.updateBranch"],
        stdout: "release/beta\n",
      },
      { args: ["check-ref-format", "--branch", "release/beta"] },
      {
        args: ["fetch", "--prune", "origin", "refs/heads/release/beta"],
        code: 128,
        stderr: "remote branch disappeared",
      },
      // origin ответил, ветки нет — ветка недоступна (ADR-0018).
      { args: ["ls-remote", "origin", "refs/heads/release/beta"] },
    ]);

    await assert.rejects(
      () => resolveUpdateTarget({ git }),
      /remote branch disappeared/,
    );
    git.assertComplete();
  });
});

void test("resolver rejects a missing git adapter, branch lookup failure, and detached HEAD", async (t) => {
  await t.test("missing adapter", async () => {
    await assert.rejects(
      () => resolveUpdateTarget(),
      /update target resolver requires git/,
    );
  });

  await t.test("branch lookup failure", async () => {
    const git = scriptedGit([
      {
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        code: 128,
        stderr: "not a git repository",
      },
    ]);

    await assert.rejects(
      () => resolveUpdateTarget({ git }),
      /not a git repository/,
    );
    git.assertComplete();
  });

  await t.test("detached HEAD", async () => {
    const git = scriptedGit([
      {
        args: ["rev-parse", "--abbrev-ref", "HEAD"],
        stdout: "HEAD\n",
      },
    ]);

    await assert.rejects(
      () => resolveUpdateTarget({ git }),
      /detached HEAD: switch to the update branch first/,
    );
    git.assertComplete();
  });
});

void test("a contained legacy branch migrates to the configured default channel", async () => {
  const git = scriptedGit([
    {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "feature/legacy\n",
    },
    {
      args: ["config", "--local", "--get", "iva.updateBranch"],
      code: 1,
    },
    { args: ["check-ref-format", "--branch", "stable"] },
    { args: ["fetch", "--prune", "origin", "refs/heads/stable"] },
    { args: ["rev-parse", "FETCH_HEAD"], stdout: "stable-head\n" },
    {
      args: ["merge-base", "--is-ancestor", "HEAD", "stable-head"],
    },
  ]);

  assert.deepEqual(
    await resolveUpdateTarget({ git, defaultBranch: "stable" }),
    {
      branch: "stable",
      currentBranch: "feature/legacy",
      configured: false,
      legacyMigration: true,
      targetHead: "stable-head",
    },
  );
  git.assertComplete();
});

void test("a diverged legacy branch remains on its current channel", async () => {
  const git = scriptedGit([
    {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "feature/diverged\n",
    },
    {
      args: ["config", "--local", "--get", "iva.updateBranch"],
      code: 1,
    },
    { args: ["check-ref-format", "--branch", "main"] },
    { args: ["fetch", "--prune", "origin", "refs/heads/main"] },
    { args: ["rev-parse", "FETCH_HEAD"], stdout: "main-head\n" },
    {
      args: ["merge-base", "--is-ancestor", "HEAD", "main-head"],
      code: 1,
    },
    { args: ["check-ref-format", "--branch", "feature/diverged"] },
    {
      args: ["fetch", "--prune", "origin", "refs/heads/feature/diverged"],
    },
    { args: ["rev-parse", "FETCH_HEAD"], stdout: "feature-head\n" },
  ]);

  assert.deepEqual(await resolveUpdateTarget({ git }), {
    branch: "feature/diverged",
    currentBranch: "feature/diverged",
    configured: false,
    legacyMigration: false,
    targetHead: "feature-head",
  });
  git.assertComplete();
});

void test("the default branch remains its own channel without an ancestry probe", async () => {
  const git = scriptedGit([
    {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "main\n",
    },
    {
      args: ["config", "--local", "--get", "iva.updateBranch"],
      stdout: "  \n",
    },
    { args: ["check-ref-format", "--branch", "main"] },
    { args: ["fetch", "--prune", "origin", "refs/heads/main"] },
    { args: ["rev-parse", "FETCH_HEAD"], stdout: "main-head\n" },
  ]);

  assert.deepEqual(await resolveUpdateTarget({ git }), {
    branch: "main",
    currentBranch: "main",
    configured: false,
    legacyMigration: false,
    targetHead: "main-head",
  });
  git.assertComplete();
});

void test("persistUpdateBranch writes local config and surfaces git errors", async (t) => {
  await t.test("success", async () => {
    const git = scriptedGit([
      {
        args: ["config", "--local", "iva.updateBranch", "release/stable"],
      },
    ]);

    await persistUpdateBranch(git, "release/stable");
    git.assertComplete();
  });

  await t.test("failure", async () => {
    const git = scriptedGit([
      {
        args: ["config", "--local", "iva.updateBranch", "main"],
        code: 1,
        stdout: "config is locked",
      },
    ]);

    await assert.rejects(
      () => persistUpdateBranch(git, "main"),
      /config is locked/,
    );
    git.assertComplete();
  });
});

// ── одна запись на два репозитория (specs/UpdateBranch.tla) ─────────────────
// `iva beta` пишет выбор владельца в репозиторий установки и в зеркало. Между записями
// процесс может умереть, а откат неудавшейся записи - не пройти; тогда зеркало, из
// которого обновление берёт ветку, остаётся на прежней. Чтение чинит кэш по записи
// владельца, поэтому обновление ставит ту версию, которую выбрали.

const branchGit = (initial: string) => {
  let value = initial;
  const writes: string[] = [];
  const git: Git = async (...args: string[]): Promise<GitResult> => {
    if (args[0] === "config" && args[1] === "--local") {
      if (args[2] === "--get") {
        return value
          ? { code: 0, stdout: `${value}\n` }
          : { code: 1, stdout: "" };
      }
      value = args[3] ?? "";
      writes.push(value);
      return { code: 0 };
    }
    return { code: 1, stdout: `unexpected git call: ${args.join(" ")}` };
  };
  return {
    git,
    writes,
    get value() {
      return value;
    },
  };
};

void test("UpdateBranch OneRecord, AgreeAfterRead: a mirror left on the old branch is repaired from the owner's record", async () => {
  const record = branchGit("beta");
  const mirror = branchGit("main");

  assert.equal(await syncUpdateBranch(mirror.git, record.git), "repaired");
  assert.equal(mirror.value, "beta", "the cache follows the record");
  assert.deepEqual(mirror.writes, ["beta"]);
  assert.deepEqual(record.writes, [], "a read never writes the owner's record");

  // Second read: nothing left to repair.
  assert.equal(await syncUpdateBranch(mirror.git, record.git), "same");
  assert.deepEqual(mirror.writes, ["beta"]);
});

void test("UpdateBranch OneRecord: an installation with no record leaves the cache alone", async () => {
  const record = branchGit("");
  const mirror = branchGit("main");

  assert.equal(await syncUpdateBranch(mirror.git, record.git), "no-record");
  assert.equal(mirror.value, "main");
  assert.deepEqual(mirror.writes, []);
});
