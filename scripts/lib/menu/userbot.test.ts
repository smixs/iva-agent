/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runSetupCommand } from "./userbot.ts";
import userbot from "./userbot.ts";
import { USERBOT_LOGIN_PHASES } from "../userbot-health.ts";
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
        return {
          state: "unauthorized" as const,
          reason: "telegram_login_required",
        };
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
      probeUserbotHealth: async () => ({
        state: "off" as const,
        reason: "service_off",
      }),
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

test("userbot menu tells the owner what to do on every login phase", async () => {
  const dir = tempDir("iva-userbot-login-menu-");
  const envPath = join(dir, ".env");
  await writeFile(
    envPath,
    "TELEGRAM_API_ID=12345\nTELEGRAM_API_HASH=abcdef123456\n",
  );
  const screen = async (
    login: (typeof USERBOT_LOGIN_PHASES)[number] | undefined,
    ru: boolean,
  ) => {
    const view = await userbot.render(
      { chatId: 1, userId: "2", screen: "ub", data: {} },
      {
        deps: {
          root: dir,
          envPath,
          probeUserbotHealth: async () => ({
            state: "unauthorized" as const,
            reason: "telegram_login_required",
            ...(login ? { login } : {}),
          }),
        },
        tr: (en: string, russian: string) => (ru ? russian : en),
        flows: { get: () => null, screen: async () => {} },
        show: async () => {},
      },
    );
    return view.text;
  };
  const expected: Record<string, [RegExp, RegExp]> = {
    idle: [/not connected.*scan a QR/u, /не подключён.*отсканировать QR/u],
    starting: [/QR is in your chat/u, /QR лежит в твоём чате/u],
    waiting: [/QR is in your chat/u, /QR лежит в твоём чате/u],
    password_needed: [
      /two-step verification password.*sent again/u,
      /пароль двухфакторной защиты.*ещё раз/u,
    ],
    expired: [/QR expired.*get a new one/u, /QR истёк.*получить новый/u],
    error: [/login failed.*start again/u, /Вход не удался.*начать заново/u],
    interrupted: [
      /restarted in the middle of the login.*start again/u,
      /перезапустился посреди входа.*начать заново/u,
    ],
  };
  for (const login of USERBOT_LOGIN_PHASES) {
    // `authorized` never comes with `unauthorized`: the probe refuses that pair.
    if (login === "authorized") continue;
    const [en, ru] = expected[login] ?? [];
    assert.ok(en && ru, `no wording for ${login}`);
    assert.match(await screen(login, false), en);
    assert.match(await screen(login, false), /Status: login required/u);
    assert.match(await screen(login, true), ru);
  }
  assert.match(await screen(undefined, false), /not connected.*scan a QR/u);
});
