import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCliMain, dispatchCli, type CliCommand } from "./main.ts";

class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

void test("signal --help documents the optional stable event key", () => {
  const help = execFileSync(
    process.execPath,
    ["bin/iva.mjs", "signal", "--help"],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8" },
  );
  assert.match(help, /iva signal.*\[--key <k>\]/u);
  assert.match(help, /same key.*pending/u);
});

const exit = (code: number): never => {
  throw new ExitSignal(code);
};

void test("dispatch passes the untouched argument tail to the selected command", async () => {
  const seen: string[][] = [];
  const commands: Record<string, CliCommand> = {
    selected: (args) => {
      seen.push([...args]);
      return "done";
    },
  };

  const result = await dispatchCli(["selected", "--flag", "value"], commands, {
    bad: assert.fail,
    help: assert.fail,
    exit,
  });

  assert.equal(result, "done");
  assert.deepEqual(seen, [["--flag", "value"]]);
});

void test("missing and unknown commands preserve help, diagnostics, and exit codes", () => {
  for (const { argv, expected } of [
    { argv: [] as string[], expected: ["help", "exit:0"] },
    {
      argv: ["unknown", "tail"],
      expected: ["bad:Unknown command: unknown", "help", "exit:1"],
    },
  ]) {
    const events: string[] = [];
    assert.throws(
      () =>
        dispatchCli(
          argv,
          {},
          {
            bad: (message) => events.push(`bad:${message}`),
            help: () => events.push("help"),
            exit: (code): never => {
              events.push(`exit:${code}`);
              throw new ExitSignal(code);
            },
          },
        ),
      ExitSignal,
    );
    assert.deepEqual(events, expected);
  }
});

void test("command help flags show help without executing the command", () => {
  for (const flag of ["--help", "-h"]) {
    const events: string[] = [];
    const commands: Record<string, CliCommand> = {
      rollback: () => events.push("command"),
    };

    assert.throws(
      () =>
        dispatchCli(["rollback", flag], commands, {
          bad: assert.fail,
          help: () => events.push("help"),
          exit: (code): never => {
            events.push(`exit:${code}`);
            throw new ExitSignal(code);
          },
        }),
      (error: unknown) => error instanceof ExitSignal && error.code === 0,
    );
    assert.deepEqual(events, ["help", "exit:0"]);
  }
});

void test("sync throws escape before Promise.resolve while async rejections use the legacy catch", async () => {
  const marker = Symbol("sync failure");
  const syncCommands: Record<string, CliCommand> = {
    sync: () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- preserve arbitrary legacy JavaScript failures
      throw marker;
    },
  };
  try {
    void dispatchCli(["sync"], syncCommands, {
      bad: assert.fail,
      help: assert.fail,
      exit,
    });
    assert.fail("expected synchronous failure");
  } catch (error) {
    assert.equal(error, marker);
  }

  const events: string[] = [];
  const asyncCommands: Record<string, CliCommand> = {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve a non-Error JavaScript rejection
    async: () => Promise.reject({ message: "async failure" }),
  };
  await assert.rejects(
    dispatchCli(["async"], asyncCommands, {
      bad: (message) => events.push(`bad:${message}`),
      help: assert.fail,
      exit: (code): never => {
        events.push(`exit:${code}`);
        throw new ExitSignal(code);
      },
    }),
    ExitSignal,
  );
  assert.deepEqual(events, ["bad:async failure", "exit:1"]);
});

void test("a Symbol-valued rejection message keeps the legacy logger interpolation failure", async () => {
  const commands: Record<string, CliCommand> = {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- preserve the legacy Symbol message boundary
    async: () => Promise.reject({ message: Symbol("message") }),
  };
  let exited = false;

  await assert.rejects(
    dispatchCli(["async"], commands, {
      bad: (message) => {
        void `${message}`;
      },
      help: assert.fail,
      exit: (): never => {
        exited = true;
        throw new ExitSignal(1);
      },
    }),
    TypeError,
  );
  assert.equal(exited, false);
});

void test("main composition exposes the exact legacy command key set without executing a command", () => {
  const cli = createCliMain("/tmp/iva-main-test");

  assert.deepEqual(Object.keys(cli.commands), [
    "update",
    "beta",
    "stable",
    "rollback",
    "userbot",
    "config",
    "login",
    "doctor",
    "diagnose",
    "plugin",
    "trace",
    "status",
    "restart",
    "reset",
    "usage",
    "notify",
    "remind",
    "jobs",
    "post",
    "proactive",
    "night",
    "signal",
    "start",
    "stop",
    "logs",
    "uninstall",
    "version",
    "tree",
    "help",
    "--help",
    "-h",
    "_install-units",
    "_activate-units",
    "_await-healthy",
  ]);
});

/** Everything `iva update` prints: `bad` goes through console.log, the progress through stdout. */
function printed(t: TestContext): () => string {
  const lines: string[] = [];
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  t.mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return () => lines.join("\n");
}

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-main-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Every message the update UI would send to Telegram, with the API answering ok. */
function chat(t: TestContext): string[] {
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { text?: string };
    sent.push(body.text ?? "");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: { message_id: 100 } }),
    });
  });
  return sent;
}

void test("a checkout marked `.iva-dev` is refused and left exactly as it was", async (t) => {
  const home = join(scratch(t), "iva");
  mkdirSync(home);
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: home,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "iva",
        GIT_AUTHOR_EMAIL: "iva@example.com",
        GIT_COMMITTER_NAME: "iva",
        GIT_COMMITTER_EMAIL: "iva@example.com",
      },
    }).trim();
  git("init", "-q", "--initial-branch=main");
  writeFileSync(join(home, "package.json"), '{ "version": "0.3.19" }\n');
  git("add", "-A");
  git("commit", "-q", "-m", "release");
  writeFileSync(join(home, "package.json"), '{ "version": "mine" }\n');
  writeFileSync(join(home, "notes.txt"), "untracked\n");
  // The one thing that keeps the updater out of a tree: the file its owner wrote.
  writeFileSync(join(home, ".iva-dev"), "");
  // The tap came from the chat, so the refusal is owed to the chat: the terminal of
  // a self-update belongs to systemd-run and nobody reads it.
  writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=1:token\n");
  const job = join(home, "data/update-jobs/deadbeefdeadbeef.json");
  mkdirSync(dirname(job), { recursive: true });
  writeFileSync(job, JSON.stringify({ chatId: 7, messageId: 100 }));
  // Everything but the agent's own state: the job file the refusal closes lives there.
  const tree = (): readonly string[] => [
    git("rev-parse", "HEAD"),
    git("status", "--porcelain", "--", ".", ":(exclude)data"),
  ];
  const before = tree();

  const out = printed(t);
  const sent = chat(t);
  await createCliMain(home).commands.update([
    "--telegram-job",
    "deadbeefdeadbeef",
  ]);

  assert.equal(process.exitCode, 1);
  assert.match(
    out(),
    /development checkout \(\.iva-dev\): update it with git, build it with `npm run build`/u,
  );
  assert.deepEqual(sent, [
    "⚠️ this is a development checkout (.iva-dev): update it with git, build it with `npm run build`",
  ]);
  // Left behind, the job keeps the bridge waiting on an update that will never run,
  // and the chat stays on "Starting the update" until the six-hour TTL.
  assert.equal(existsSync(job), false);
  assert.deepEqual(tree(), before);
});

void test("an installed version is handed to the updater", async (t) => {
  const root = join(scratch(t), "versions", "0.3.19-aaaaaaaaaaaa");
  mkdirSync(root, { recursive: true });
  // The first thing the updater checks, and the one refusal that touches nothing.
  writeFileSync(join(root, ".env"), "MODEL_PROVIDER=ollmaa\n");

  const out = printed(t);
  await createCliMain(root).commands.update([]);

  assert.equal(process.exitCode, 1);
  assert.match(out(), /MODEL_PROVIDER/u);
  assert.doesNotMatch(out(), /development checkout/u);
});
