/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../fixtures/systemd-env.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CodexAuth } from "../lib/codex-oauth.ts";
import type { UsageRecord } from "../lib/usage.ts";
import { createAccountCommands, type AccountDependencies } from "./account.ts";
import { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;
type LoadedUsageModule = Awaited<
  ReturnType<NonNullable<AccountDependencies["loadUsage"]>>
>;

const ROOT = "/tmp/iva-account-test";
const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

function runtime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return {
    ...createCliRuntime(ROOT),
    C: NO_COLOR,
    ok: () => undefined,
    warn: () => undefined,
    bad: () => undefined,
    step: () => undefined,
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<SystemdLifecycle> = {},
): SystemdLifecycle {
  return {
    ensureAssistantBearer: () => false,
    writeUnits: () => [],
    activateUnits: () => undefined,
    removeUnits: () => [],
    migrateEnv: () => false,
    restartServices: () => undefined,
    ...overrides,
  };
}

function usageDependencies(
  events: string[],
  entries: UsageRecord[],
): Pick<AccountDependencies, "loadUsage"> {
  return {
    loadUsage: () =>
      Promise.resolve({
        readEntries: (dataDir = "data") => {
          events.push(`read:${dataDir}`);
          return entries;
        },
        parseWindow: (arg?: string) => {
          events.push(`parse:${String(arg)}`);
          return "week";
        },
        summarize: (
          records: UsageRecord[],
          options: { window?: unknown; now?: unknown; tz?: unknown } = {},
        ) => {
          events.push(
            `summarize:${records.length}:${String(options.window)}:${String(options.now)}:${String(options.tz)}`,
          );
          return {
            window: "week" as const,
            totals: {
              in: 0,
              out: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
              steps: 0,
              turns: 0,
            },
            bySource: [],
            byModel: [],
          };
        },
        formatUsageReport: () => {
          events.push("format");
          return "usage report";
        },
      } as unknown as LoadedUsageModule),
  };
}

test("account command factory is side-effect-free and usage modules stay lazy", async () => {
  const events: string[] = [];
  const logs: unknown[][] = [];
  const entries = Array.from(
    { length: 12 },
    (_, index) => ({ index }) as unknown as UsageRecord,
  );
  const commands = createAccountCommands(
    runtime({
      readEnv: () => ({ ASSISTANT_TIMEZONE: "Asia/Tashkent" }),
      dataDirAbs: () => "/data-dir",
    }),
    lifecycle(),
    {
      ...usageDependencies(events, entries),
      now: () => 1234,
      log: (...args) => logs.push(args),
      loadCodexOauth: () => {
        events.push("load-oauth");
        return Promise.reject(new Error("not used"));
      },
    },
  );

  assert.deepEqual(events, []);

  await commands.cmdUsage(["tail", "0"]);
  assert.deepEqual(events, ["read:/data-dir"]);
  assert.deepEqual(
    logs,
    entries.slice(-10).map((entry) => [JSON.stringify(entry)]),
  );

  events.length = 0;
  logs.length = 0;
  await commands.cmdUsage(["week"]);
  assert.deepEqual(events, [
    "read:/data-dir",
    "parse:week",
    "summarize:12:week:1234:Asia/Tashkent",
    "format",
  ]);
  assert.deepEqual(logs, [["usage report"]]);
});

test("uninstall preserves confirmation, removal, and purge ordering", async () => {
  const events: string[] = [];
  const confirmations = [true, true];
  const commands = createAccountCommands(
    runtime({
      warn: (message) => events.push(`warn:${message}`),
      bad: (message) => events.push(`bad:${message}`),
      ok: (message) => events.push(`ok:${message}`),
      confirm: (question, defaultValue) => {
        events.push(`confirm:${question}:${String(defaultValue)}`);
        return Promise.resolve(confirmations.shift() ?? false);
      },
      hasSystemd: () => {
        events.push("has-systemd");
        return true;
      },
      readEnv: (): Record<string, string> => {
        events.push("read-env");
        return { ASSISTANT_VAULT_DIR: "memory" };
      },
    }),
    lifecycle({
      removeUnits: () => {
        events.push("remove-units");
        return ["one", "two"];
      },
    }),
    {
      homeDir: () => "/home/user",
      remove: (path, options) =>
        events.push(`remove:${path}:${JSON.stringify(options)}`),
      log: (...args) => events.push(`log:${args.join(" ")}`),
    },
  );

  await commands.cmdUninstall(["--purge"]);

  assert.deepEqual(events, [
    "warn:Uninstalling Iva: systemd units and the `iva` command will be removed.",
    "bad:--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).",
    "confirm:Continue?:false",
    "has-systemd",
    "remove-units",
    "ok:Removed systemd units: 2",
    "remove:/home/user/.local/bin/iva:undefined",
    "ok:iva command removed from ~/.local/bin",
    `confirm:Delete the ${ROOT} directory AND vault IRREVERSIBLY?:false`,
    "read-env",
    `remove:${join(ROOT, "memory")}:{"recursive":true,"force":true}`,
    "ok:vault deleted",
    `remove:${ROOT}:{"recursive":true,"force":true}`,
    "ok:code deleted",
  ]);
});

test("uninstall cancellation stops before system and filesystem work", async () => {
  const events: string[] = [];
  const commands = createAccountCommands(
    runtime({
      warn: (message) => events.push(`warn:${message}`),
      bad: (message) => events.push(`bad:${message}`),
      confirm: () => {
        events.push("confirm");
        return Promise.resolve(false);
      },
      hasSystemd: () => {
        events.push("unexpected-systemd");
        return true;
      },
    }),
    lifecycle(),
    {
      remove: () => events.push("unexpected-remove"),
      log: (...args) => events.push(`log:${args.join(" ")}`),
    },
  );

  await commands.cmdUninstall(["--purge"]);

  assert.deepEqual(events, [
    "warn:Uninstalling Iva: systemd units and the `iva` command will be removed.",
    "bad:--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).",
    "confirm",
    "log:Cancelled.",
  ]);
});

test("version retains undefined metadata, Symbol failure, and missing-file fallback semantics", () => {
  const logs: unknown[][] = [];
  const base = {
    log: (...args: unknown[]) => logs.push(args),
  };
  const undefinedVersion = createAccountCommands(
    runtime({ gitHead: () => "abc1234" }),
    lifecycle(),
    { ...base, readPackage: () => "{}" },
  );
  undefinedVersion.cmdVersion();

  const symbolVersion = createAccountCommands(
    runtime({ gitHead: () => "not-reached" }),
    lifecycle(),
    {
      ...base,
      readPackage: () => "{}",
      parsePackage: () => ({ version: Symbol("version") }),
    },
  );
  assert.throws(() => symbolVersion.cmdVersion(), TypeError);

  const missingPackage = createAccountCommands(
    runtime({ gitHead: () => "" }),
    lifecycle(),
    {
      ...base,
      readPackage: () => {
        throw new Error("missing");
      },
    },
  );
  missingPackage.cmdVersion();

  assert.deepEqual(logs, [
    ["iva undefined · commit abc1234 · updates stable"],
    ["iva ? · commit ? · updates stable"],
  ]);
});

test("login keeps import, setup, prompt, and warning order", async () => {
  const events: string[] = [];
  let envRead = 0;
  const auth: CodexAuth = {
    access_token: "access",
    refresh_token: "refresh",
    planType: "pro",
    accountId: "account-1",
  };
  const commands = createAccountCommands(
    runtime({
      dataDirAbs: () => {
        events.push("data-dir");
        return "/data";
      },
      readEnv: (): Record<string, string> => {
        envRead++;
        events.push(`read-env-${envRead}`);
        return envRead === 1
          ? { AGENT_LANGUAGE: "RU" }
          : { MODEL_PROVIDER: "ollama" };
      },
      step: (message) => events.push(`step:${message}`),
      ok: (message) => events.push(`ok:${message}`),
      warn: (message) => events.push(`warn:${message}`),
    }),
    lifecycle(),
    {
      log: (...args) => events.push(`log:${args.join(" ")}`),
      loadCodexOauth: () => {
        events.push("load-oauth");
        return Promise.resolve({
          runDeviceCodeLogin: () => {
            events.push("unexpected-device");
            return Promise.resolve(auth);
          },
          runBrowserLogin: (options) => {
            const resolvedOptions = options ?? {};
            events.push(
              `browser:${resolvedOptions.dataDir}:${resolvedOptions.lang}:${String(resolvedOptions.log !== undefined)}`,
            );
            resolvedOptions.log?.("oauth progress");
            return Promise.resolve(auth);
          },
        });
      },
    },
  );

  await commands.cmdLogin(["--browser"]);

  assert.deepEqual(events, [
    "load-oauth",
    "data-dir",
    "read-env-1",
    "step:OpenAI sign-in (browser)…",
    "browser:/data:ru:true",
    "log:oauth progress",
    "ok:Signed in — plan: pro · account account-1",
    "log:Token stored: /data/codex-auth.json (chmod 600)",
    "read-env-2",
    "warn:Set MODEL_PROVIDER=codex to use it: iva config (then iva restart)",
  ]);
});

test("login catches flow failures but leaves lazy import failures outside its try boundary", async () => {
  const flowEvents: string[] = [];
  const failedFlow = createAccountCommands(
    runtime({
      dataDirAbs: () => "/data",
      readEnv: () => ({}),
      step: (message) => flowEvents.push(`step:${message}`),
      bad: (message) => flowEvents.push(`bad:${message}`),
    }),
    lifecycle(),
    {
      exit: (code) => flowEvents.push(`exit:${code}`),
      loadCodexOauth: () =>
        Promise.resolve({
          runDeviceCodeLogin: () => Promise.reject(new Error("device boom")),
          runBrowserLogin: () => Promise.reject(new Error("browser boom")),
        }),
    },
  );

  await failedFlow.cmdLogin([]);
  assert.deepEqual(flowEvents, [
    "step:OpenAI sign-in (device code)…",
    "bad:Sign-in failed: device boom",
    "exit:1",
  ]);

  const importEvents: string[] = [];
  const failedImport = createAccountCommands(
    runtime({
      dataDirAbs: () => {
        importEvents.push("unexpected-data-dir");
        return "/data";
      },
      step: () => importEvents.push("unexpected-step"),
      bad: () => importEvents.push("unexpected-bad"),
    }),
    lifecycle(),
    {
      exit: () => importEvents.push("unexpected-exit"),
      loadCodexOauth: () => {
        importEvents.push("load-oauth");
        return Promise.reject(new Error("import boom"));
      },
    },
  );

  await assert.rejects(failedImport.cmdLogin([]), /import boom/);
  assert.deepEqual(importEvents, ["load-oauth"]);
});

test("repair 15: macOS uninstall confirmation names Iva jobs", async () => {
  const warnings: string[] = [];
  const rt = runtime({
    warn: (m) => warnings.push(m),
    confirm: () => Promise.resolve(false),
  });
  rt.systemd.manager = "launchd";
  await createAccountCommands(rt, lifecycle(), { log: () => {} }).cmdUninstall(
    [],
  );
  assert.match(warnings[0], /задания Ивы/);
});
