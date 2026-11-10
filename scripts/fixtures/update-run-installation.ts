// The update the new version finishes (scripts/update-finish.ts), killed between the stop
// of the old writers and the start of the candidate, and run again (specs/UpdateRun.tla).
// The process is the real one, in a hermetic installation: systemctl is a fake that keeps
// unit state in a file, the candidate's eve answers its probe, and the "service" answers on
// the installation's port only while the fake says iva.service is active. The kill comes
// from inside the step it interrupts: the fake systemctl, a migration of the candidate and
// its vault cleanup SIGKILL the updater exactly where the step stands.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./temp-dir.ts";
import { createVersionStore } from "../lib/version-store.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OLD = "0.5.11-aaaaaaaaaaaa";
const NEW = "0.5.12-bbbbbbbbbbbb";

type Units = Record<string, { active: boolean; enabled: boolean }>;

const BEFORE: Units = {
  "iva.service": { active: true, enabled: true },
  "iva-telegram-poll.service": { active: true, enabled: true },
  "iva-brain.timer": { active: true, enabled: true },
  "iva-brain.service": { active: false, enabled: false },
  "iva-telegram-userbot.service": { active: true, enabled: true },
  "iva-update-check.timer": { active: true, enabled: true },
};

const FAKE_SYSTEMCTL = `import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const args = process.argv.slice(2).filter((a) => a !== "--user");
const [action, ...rest] = args;
const units = rest.filter((a) => !a.startsWith("--"));
const path = process.env.IVA_KILL_STATE;
if (process.env.IVA_TRACE) appendFileSync(process.env.IVA_TRACE, process.ppid + " " + args.join(" ") + "\\n");
const states = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const kill = () => { if (process.env.IVA_KILL_AT === action + ":" + (units[0] ?? "")) { process.kill(process.ppid, "SIGKILL"); process.exit(1); } };
// A start is killed before it happens, a stop after it did.
if (action !== "stop") kill();
const unit = units[0];
const item = states[unit] ?? { active: false, enabled: false };
switch (action) {
  case "show": console.log(states[unit] ? "loaded" : "not-found"); process.exit(0);
  case "is-active": console.log(item.active ? "active" : "inactive"); process.exit(item.active ? 0 : 3);
  case "is-enabled": console.log(item.enabled ? "enabled" : "disabled"); process.exit(item.enabled ? 0 : 1);
  case "enable": item.enabled = true; if (rest.includes("--now")) item.active = true; break;
  case "disable": item.enabled = false; if (rest.includes("--now")) item.active = false; break;
  case "start": case "restart": item.active = true; break;
  case "stop": item.active = false; break;
  case "reset-failed": process.exit(0);
  default: process.exit(0);
}
if (unit) { states[unit] = item; writeFileSync(path, JSON.stringify(states)); }
if (action === "stop") kill();
`;

/** The candidate's eve: answers on the probe port until it is stopped. */
const FAKE_EVE = `import {createServer} from "node:http";
createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
`;

const KILL_MIGRATION = `export default () => { if (process.env.IVA_KILL_AT === "migrate") process.kill(process.pid, "SIGKILL"); };
`;
const KILL_VAULT = `if (process.env.IVA_KILL_AT === "vault") process.kill(process.ppid, "SIGKILL");
`;
const FINISH = `import { main } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/update-finish.ts")).href)};
process.exitCode = await main(process.argv.slice(2));
`;

function write(path: string, body: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode });
}

function installation(port: number) {
  const root = tempDir("iva-update-run-kill-");
  const home = join(root, "iva");
  const bin = join(root, "bin");
  const state = join(root, "units.json");
  write(
    join(home, ".env"),
    `MODEL_PROVIDER=ollama\nAGENT_LANGUAGE=en\nIVA_PORT=${port}\nASSISTANT_TIMEZONE=UTC\nASSISTANT_BEARER=${"a".repeat(43)}\n`,
    0o600,
  );
  write(join(home, ".eve/.workflow-data/session-1.json"), "{}\n");
  const store = createVersionStore(home);
  for (const [name, version] of [
    [OLD, "0.5.11"],
    [NEW, "0.5.12"],
  ] as const) {
    const dir = store.stage(name);
    write(
      join(dir, "package.json"),
      JSON.stringify({ name: "iva", version, type: "module" }),
    );
    cpSync(join(ROOT, "deploy"), join(dir, "deploy"), { recursive: true });
    store.linkState(dir);
    store.complete(name);
  }
  const candidate = join(home, "versions", NEW);
  write(join(candidate, "node_modules/eve/bin/eve.js"), FAKE_EVE);
  write(join(candidate, "scripts/migrations/001-kill-test.ts"), KILL_MIGRATION);
  write(join(candidate, "scripts/vault-cleanup.ts"), KILL_VAULT);
  write(join(candidate, "scripts/update-finish-entry.ts"), FINISH);
  store.activate(OLD);
  store.settle(OLD);
  write(join(root, "fake-systemctl.ts"), FAKE_SYSTEMCTL);
  write(
    join(bin, "systemctl"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, "fake-systemctl.ts")}' "$@"\n`,
    0o755,
  );
  writeFileSync(state, JSON.stringify(BEFORE));
  return { root, home, bin, state, candidate, store };
}

/** The installation's service: answers only while the fake says it runs. */
async function service(state: string, port: number): Promise<Server> {
  const server = createServer((_, res) => {
    const units = JSON.parse(readFileSync(state, "utf8")) as Units;
    if (units["iva.service"]?.active) res.end("ok");
    else res.destroy();
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return server;
}

function finish(
  at: ReturnType<typeof installation>,
  killAt: string,
): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(at.candidate, "scripts/update-finish-entry.ts"), at.home, NEW],
      {
        cwd: at.candidate,
        env: {
          ...process.env,
          HOME: at.root,
          PATH: `${at.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          IVA_KILL_AT: killAt,
          IVA_KILL_STATE: at.state,
          IVA_TRACE: join(at.root, "trace.log"),
          IVA_UPDATE_OUTCOME: join(
            at.root,
            `outcome-${killAt || "retry"}.json`,
          ),
          AGENT_LANGUAGE: "en",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    child.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

export {
  installation,
  service,
  finish,
  FAKE_SYSTEMCTL,
  FAKE_EVE,
  BEFORE,
  OLD,
  NEW,
};
