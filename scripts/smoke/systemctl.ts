#!/usr/bin/env node
// File-backed unit state, following update-run-kill.test.ts; never calls the host manager.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = process.env.SMOKE_UNIT_STATE!;
const args = process.argv.slice(2).filter((arg) => arg !== "--user");
appendFileSync(process.env.SMOKE_UNIT_LOG!, JSON.stringify(args) + "\n");
const [action, ...rest] = args;
const names = rest.filter((arg) => !arg.startsWith("--"));
const states = JSON.parse(readFileSync(file, "utf8")) as Record<
  string,
  { active: boolean; enabled: boolean }
>;
let code = 0;
for (const name of names) {
  const item = states[name] ?? { active: false, enabled: false };
  switch (action) {
    case "show":
      console.log(states[name] ? "loaded" : "not-found");
      continue;
    case "is-active":
      console.log(item.active ? "active" : "inactive");
      code = item.active ? 0 : 3;
      continue;
    case "is-enabled":
      console.log(item.enabled ? "enabled" : "disabled");
      code = item.enabled ? 0 : 1;
      continue;
    case "enable":
      item.enabled = true;
      if (rest.includes("--now")) item.active = true;
      break;
    case "disable":
      item.enabled = false;
      if (rest.includes("--now")) item.active = false;
      break;
    case "start":
    case "restart":
      item.active = true;
      break;
    case "stop":
      item.active = false;
      break;
    case "daemon-reload":
    case "reset-failed":
      break;
    default:
      throw new Error(`Unsupported fake systemctl action: ${action}`);
  }
  states[name] = item;
}
writeFileSync(file, JSON.stringify(states));
process.exitCode = code;
