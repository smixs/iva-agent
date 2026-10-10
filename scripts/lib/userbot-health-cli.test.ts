import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantCliTree } from "../fixtures/cli-tree.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type RunOptions = SpawnOptions & { readonly encoding?: BufferEncoding };

type RunResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    (child.stdout as NonNullable<typeof child.stdout>).on(
      "data",
      (chunk: string) => {
        stdout += chunk;
      },
    );
    (child.stderr as NonNullable<typeof child.stderr>).on(
      "data",
      (chunk: string) => {
        stderr += chunk;
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

void test("iva userbot diagnose --json returns the shared ready state without secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-userbot-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "iva");
  const fakeBin = join(dir, "bin");
  const token = "diagnose-secret-token";
  await mkdir(join(project, "data"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await plantCliTree(ROOT, project, { copy: ["scripts/cli"] });
  await writeFile(join(project, "data/telegram-userbot.token"), token);

  const interpreter = join(
    project,
    "services/telegram-userbot/.venv/bin/python",
  );
  await mkdir(dirname(interpreter), { recursive: true });
  await writeFile(interpreter, "#!/bin/sh\nexit 0\n");
  await chmod(interpreter, 0o755);

  const systemctl = join(fakeBin, "systemctl");
  await writeFile(
    systemctl,
    [
      "#!/bin/sh",
      'if [ "$2" = "is-active" ]; then echo active; exit 0; fi',
      'if [ "$2" = "is-enabled" ]; then echo enabled; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(systemctl, 0o755);

  const server = createServer((request, response) => {
    assert.equal(request.url, "/healthz");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"state":"ready"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  await writeFile(join(project, ".env"), `TELEGRAM_MCP_PORT=${port}\n`);

  const diagnose = () =>
    run(
      process.execPath,
      [join(project, "bin/iva.mjs"), "userbot", "diagnose", "--json"],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: join(dir, "home"),
          NO_COLOR: "1",
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        encoding: "utf8",
      },
    );
  // The probe gives a local service 1500 ms. A machine busy running the rest of
  // this suite can stall that long on its own, and a starved event loop is not
  // the thing under test - so one timeout is retried, anything else is a failure.
  let result = await diagnose();
  if (/probe_timeout/u.test(result.stdout)) result = await diagnose();

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { state: "ready", reason: "ok" });
  await writeFile(interpreter, "#!/bin/sh\nexit 1\n");
  const damaged = await diagnose();
  assert.deepEqual(JSON.parse(damaged.stdout), {
    state: "unreachable",
    reason: "python_dependencies_unavailable",
  });
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(token));
});
