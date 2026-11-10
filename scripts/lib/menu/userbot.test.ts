/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runSetupCommand } from "./userbot.ts";
import userbot from "./userbot.ts";
import { tempDir } from "../../fixtures/temp-dir.ts";

type ExecCallback = (
  error: (Error & { code?: number }) | null,
  stdout?: string,
  stderr?: string,
) => void;
type Rendered = { text: string };

test("userbot menu setup rejects exit 1 with a redacted error", async () => {
  const secret = "setup-stderr-secret";
  let childDataDir: string | undefined;
  const exec = (
    _cmd: string,
    _args: string[],
    opts: {
      timeout: number;
      encoding: "utf8";
      env?: NodeJS.ProcessEnv;
    },
    callback: ExecCallback,
  ) => {
    childDataDir = opts.env?.ASSISTANT_DATA_DIR;
    const error = Object.assign(new Error(secret), { code: 1 });
    callback(error, "", secret);
  };

  await assert.rejects(
    runSetupCommand("/iva/bin/iva.mjs", { exec, dataDir: "/iva/runtime" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "userbot setup failed (exit 1)");
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(childDataDir, "/iva/runtime");
});

test("userbot menu renders the shared Telethon authorization state", async () => {
  const dir = tempDir("iva-userbot-health-menu-");
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
  );
  let calls = 0;
  const ctx = {
    deps: {
      root: dir,
      envPath,
      probeUserbotHealth: async ({
        root,
        port,
      }: {
        root: string;
        port: string;
      }) => {
        calls += 1;
        assert.equal(root, dir);
        assert.equal(port, "8724");
        return { state: "unauthorized", reason: "telegram_login_required" };
      },
    },
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    flows: { get: () => null, screen: async () => {} },
    show: async () => {},
  };

  const view = await userbot.render(
    { chatId: 1, userId: "2", screen: "ub", data: {} },
    ctx,
  );

  assert.equal(calls, 1);
  assert.match(view.text, /Status: login required/);
  assert.match(view.text, /account-ban risk/);
});

test("userbot menu surfaces setup exit 1 and keeps the userbot heading", async () => {
  const dir = tempDir("iva-userbot-menu-");
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
  );
  const rendered: Rendered[] = [];
  const state = {
    chatId: 1,
    userId: "2",
    screen: "ub",
    data: {},
    _last: undefined as Rendered | undefined,
  };
  const flows = {
    get: () => state,
    screen: async (_state: unknown, text: string) => {
      state._last = { text };
      rendered.push(state._last);
    },
  };
  const ctx = {
    deps: {
      root: dir,
      envPath,
      probeUserbotHealth: async () => ({ state: "off", reason: "service_off" }),
      runUserbotSetup: async () => {
        throw new Error("must stay redacted");
      },
      log: () => {},
    },
    flows,
    tr: (en: string) => en,
    btn: (text: string, callback_data: string) => ({ text, callback_data }),
    backRow: () => [{ text: "Back", callback_data: "iva_menu:r:o" }],
    show: async () => {},
  };

  await userbot.on("do", ["setup"], state, ctx);
  for (
    let i = 0;
    i < 20 && !rendered.some((view) => /Setup failed/.test(view.text));
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.match(state._last?.text ?? "", /Telegram userbot/);
  assert.match(state._last?.text ?? "", /Setup failed/);
  assert.doesNotMatch(state._last?.text ?? "", /must stay redacted/);
});
