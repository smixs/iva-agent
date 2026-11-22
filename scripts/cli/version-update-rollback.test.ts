/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva rollback` обязан не только перевернуть current: демонтированная версия — путь
// назад, а не служба, и её `.eve` собирается тем же gc, что и при смене версии.
// Здесь весь круг в изолированной установке: смена версии → уборка → откат →
// версия, на которую откатились, стартует и заново пишет свой кэш — настоящий
// prewarm just-bash, не имитация файлов фикстурой.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { justbash } from "eve/sandbox/just-bash";
import { probeVersion } from "../lib/health-probe.ts";
import { createVersionStore } from "../lib/version-store.ts";
import { createCliRuntime } from "./runtime.ts";
import { createVersionUpdateCommand } from "./version-update-command.ts";

/** A serving's smallest proof of life: an HTTP endpoint the health probe takes. */
const SERVER = `import { createServer } from "node:http";
createServer((_request, response) => response.writeHead(200).end("ok"))
  .listen(Number(process.env.PORT), "127.0.0.1");
`;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });

type World = {
  readonly store: ReturnType<typeof createVersionStore>;
  readonly previous: string;
  readonly current: string;
};

/** Two served versions, the newer one settled: exactly what a finished update leaves. */
function world(t: TestContext): World {
  const home = mkdtempSync(join(tmpdir(), "iva-rollback-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createVersionStore(home);
  writeFileSync(join(home, ".env"), "");
  const serve = (name: string): void => {
    const dir = store.stage(name);
    writeFileSync(join(dir, "package.json"), `{"name":"iva","version":"${name.split("-")[0]}"}\n`);
    mkdirSync(join(dir, ".output"), { recursive: true });
    writeFileSync(join(dir, ".output/server.mjs"), SERVER);
    store.linkState(dir);
    // What its serving wrote into `.eve`: a session payload a rollback may
    // return to, a prewarmed template and a leftover prewarm lock, and the
    // build summary.
    const cache = join(dir, ".eve/sandbox-cache/just-bash");
    mkdirSync(join(cache, "sessions/s1"), { recursive: true });
    writeFileSync(join(cache, "sessions/s1/blob"), "session\n");
    mkdirSync(join(cache, "templates/t1"), { recursive: true });
    writeFileSync(join(cache, "templates/t1/blob"), "template\n");
    mkdirSync(join(dir, ".eve/sandbox-cache/template-locks/just-bash/t1.lock"), {
      recursive: true,
    });
    writeFileSync(join(dir, ".eve/agent-summary.json"), "{}");
    store.complete(name);
  };
  const previous = "0.3.13-333333333333";
  const current = "0.3.14-444444444444";
  serve(previous);
  serve(current);
  store.activate(previous);
  store.settle(previous);
  store.activate(current);
  store.settle(current);
  // The switch that demoted `previous` collected its `.eve` cache already.
  store.gc(2);
  return { store, previous, current };
}

test("iva rollback collects the demoted version's .eve and lands on a version that serves", async (t) => {
  const { store, previous, current } = world(t);
  const said: string[] = [];
  const restarts: string[] = [];
  const base = createCliRuntime(join(store.layout.versions, current));
  const command = createVersionUpdateCommand(
    {
      ...base,
      ok: (message) => said.push(`ok ${message}`),
      warn: (message) => said.push(`warn ${message}`),
      bad: (message) => said.push(`bad ${message}`),
    },
    { restartServices: () => restarts.push("restart") },
  );

  command.rollback();

  assert.equal(process.exitCode, undefined, said.join("\n"));
  assert.deepEqual(restarts, ["restart"]);
  assert.equal(store.currentName(), previous);
  // The collection the rollback ran took only what a start writes again —
  // templates and prewarm locks — and left the way back whole: the state
  // link, the build summary and the session payload a reattach returns to.
  const demoted = join(store.layout.versions, current, ".eve");
  assert.ok(!existsSync(join(demoted, "sandbox-cache/template-locks")));
  assert.deepEqual(
    readdirSync(join(demoted, "sandbox-cache/just-bash/templates")),
    [],
  );
  assert.deepEqual(readdirSync(demoted).sort(), [
    ".workflow-data",
    "agent-summary.json",
    "sandbox-cache",
  ]);
  assert.equal(
    existsSync(join(demoted, "sandbox-cache/just-bash/sessions/s1/blob")),
    true,
  );
  // The version it landed on is a serving again: it starts, and the cache
  // the switch-time collection had taken is written again — the real
  // just-bash prewarm puts a template back where gc removed one.
  const dir = join(store.layout.versions, previous);
  const port = await freePort();
  const probe = await probeVersion({
    dir,
    port,
    command: process.execPath,
    args: [join(dir, ".output/server.mjs")],
    timeoutMs: 8000,
    intervalMs: 50,
    stopGraceMs: 500,
  });
  assert.equal(probe.ok, true, probe.log);
  const backend = justbash();
  await backend.prewarm({
    runtimeContext: { appRoot: dir },
    seedFiles: [],
    templateKey: "t2",
  });
  assert.ok(
    existsSync(join(dir, ".eve/sandbox-cache/just-bash/templates/t2")),
  );
  // Prewarm writes templates only: the surviving session payload is untouched.
  assert.equal(
    existsSync(join(dir, ".eve/sandbox-cache/just-bash/sessions/s1/blob")),
    true,
  );
});
