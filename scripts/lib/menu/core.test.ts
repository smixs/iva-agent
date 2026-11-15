import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

type InterviewState = {
  i: number;
  qa: Array<{ q: string; a: string }>;
  chat: Record<string, unknown> | null;
  from: Record<string, unknown> | null;
  threadId: number | null;
};

type MenuState = {
  chatId: number;
  userId: string;
  data: { iv?: InterviewState; [key: string]: unknown };
  awaitText: {
    kind: string;
    secret: boolean;
    data: Record<string, unknown>;
  } | null;
  [key: string]: unknown;
};

type Delivery = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: Record<string, unknown>;
    from: Record<string, unknown>;
    text: string;
    message_thread_id?: number;
  };
};

type MenuContext = {
  deps: {
    deliver: (update: Delivery) => Promise<unknown>;
    admitSynthetic: (update: Delivery) => Promise<boolean>;
    log?: (...parts: unknown[]) => void;
  };
  getLang: () => "en" | "ru";
  tr: (en: string, ru: string) => string;
  flows: {
    screen: (state: MenuState, text: string) => Promise<void>;
  };
  show: (state: MenuState, screen: string) => Promise<void>;
};

type CoreScreen = {
  parent: string;
  render: (state: MenuState, context: MenuContext) => Promise<{ text: string }>;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<unknown>;
  texts: {
    interview: (
      text: unknown,
      message: {
        chat: Record<string, unknown>;
        from: Record<string, unknown>;
        message_thread_id?: number;
      },
      state: MenuState,
      context: MenuContext,
    ) => Promise<void>;
  };
};

type RunStatus = {
  chatKeyOf: (chatId: number, threadId: number | null) => string;
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => unknown;
};

const statusDir = mkdtempSync(join(tmpdir(), "iva-menu-core-status-"));
const previousDataDir = process.env.ASSISTANT_DATA_DIR;
process.env.ASSISTANT_DATA_DIR = statusDir;

const coreModulePath: string = "./core.ts";
const { default: core } = (await import(coreModulePath)) as {
  default: CoreScreen;
};
const runStatus = (await import("#lib/run-status.ts")) as RunStatus;

after(() => {
  if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  rmSync(statusDir, { recursive: true, force: true });
});

function useVault(t: TestContext): string {
  const vault = mkdtempSync(join(tmpdir(), "iva-menu-core-vault-"));
  const previousVault = process.env.ASSISTANT_VAULT_DIR;
  process.env.ASSISTANT_VAULT_DIR = vault;
  t.after(() => {
    if (previousVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = previousVault;
    rmSync(vault, { recursive: true, force: true });
  });
  return vault;
}

function makeState(overrides: Partial<MenuState> = {}): MenuState {
  return {
    chatId: 44,
    userId: "77",
    data: {},
    awaitText: null,
    ...overrides,
  };
}

function makeContext(lang: "en" | "ru" = "ru") {
  const screens: Array<{ text: string }> = [];
  const deliveries: Delivery[] = [];
  const admissions: Delivery[] = [];
  const shown: string[] = [];
  const context: MenuContext = {
    deps: {
      deliver: (update) => {
        deliveries.push(update);
        return Promise.resolve(true);
      },
      admitSynthetic: (update) => {
        admissions.push(update);
        return Promise.resolve(true);
      },
      log: () => {},
    },
    getLang: () => lang,
    tr: (en, ru) => (lang === "ru" ? ru : en),
    flows: {
      screen: (_state, text) => {
        screens.push({ text });
        return Promise.resolve();
      },
    },
    show: (_state, screen) => {
      shown.push(screen);
      return Promise.resolve();
    },
  };
  return { context, screens, deliveries, admissions, shown };
}

void test("core render handles an empty vault and trims an oversized CORE excerpt", async (t) => {
  const vault = useVault(t);
  const { context } = makeContext();
  const state = makeState();

  const empty = await core.render(state, context);
  assert.equal(core.parent, "r");
  assert.match(empty.text, /^# 💾 Ядро памяти$/m);
  assert.match(empty.text, /Ядро памяти пусто/);
  assert.match(
    empty.text,
    /<tg-button[^>]*data="iva_menu:core:go"[^>]*>Пройти интервью<\/tg-button>/,
  );

  const excerpt = `${"а".repeat(399)}  ${"б".repeat(20)}`;
  writeFileSync(join(vault, "CORE.md"), `\n${excerpt}\n`, "utf8");
  const populated = await core.render(state, context);

  assert.ok(populated.text.includes("Текущее ядро:"));
  assert.ok(populated.text.includes(`${"а".repeat(399)}…`));
  assert.equal(populated.text.includes("б"), false);
});

void test("core toggles the single memory night setting without losing siblings", async () => {
  const settings = join(statusDir, "settings.json");
  rmSync(settings, { force: true });
  writeFileSync(settings, JSON.stringify({ language: "ru" }));
  const { context, shown } = makeContext("en");
  const state = makeState();

  await core.on("night", [], state, context);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {
    language: "ru",
    memory: { night: "off" },
  });
  assert.deepEqual(shown, ["core"]);
  assert.match((await core.render(state, context)).text, /Night: off/u);

  await core.on("night", [], state, context);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {
    language: "ru",
    memory: { night: "on" },
  });
  assert.deepEqual(shown, ["core", "core"]);
  assert.match((await core.render(state, context)).text, /Night: on/u);
});

void test("core interview stores the real reply identity and delivers a synthetic threaded distillation update", async (t) => {
  const vault = useVault(t);
  const { context, deliveries, admissions, screens } = makeContext();
  const state = makeState();
  const sourceMessage = {
    chat: { id: 44, type: "supergroup", title: "Family" },
    from: { id: 77, is_bot: false, first_name: "Сергей" },
    message_thread_id: 9,
  };

  await core.on("go", [], state, context);
  assert.deepEqual(state.awaitText, {
    kind: "interview",
    secret: false,
    data: {},
  });
  assert.match(screens.at(-1)?.text ?? "", /Как к тебе обращаться/);

  await core.texts.interview(
    "  Сергей, на ты  ",
    sourceMessage,
    state,
    context,
  );
  let handled: unknown;
  for (let index = 1; index < 6; index += 1)
    handled = await core.on("skip", [], state, context);

  assert.equal(handled, true);
  assert.equal(state.awaitText, null);
  assert.equal(deliveries.length, 1);
  assert.equal(admissions.length, 0);
  const [delivery] = deliveries;
  assert.equal(Number.isSafeInteger(delivery.update_id), true);
  assert.notEqual(delivery.update_id, 0);
  assert.deepEqual(delivery.message.chat, sourceMessage.chat);
  assert.deepEqual(delivery.message.from, sourceMessage.from);
  assert.equal(delivery.message.message_thread_id, 9);
  assert.match(delivery.message.text, /\[Настройка core memory\]/);
  assert.match(delivery.message.text, /Сергей, на ты/);
  assert.match(screens.at(-1)?.text ?? "", /Передал иве/);

  const archive = readFileSync(join(vault, "core-interview.md"), "utf8");
  assert.match(archive, /Сергей, на ты/);
  assert.match(archive, /—/);
});

void test("core durably owns the synthetic update when direct delivery is rejected", async (t) => {
  const vault = useVault(t);
  const { context, admissions, screens } = makeContext();
  context.deps.deliver = () => Promise.resolve(false);

  const handled = await core.on(
    "fin",
    [],
    makeState({
      data: { iv: { i: 0, qa: [], chat: null, from: null, threadId: null } },
    }),
    context,
  );

  assert.equal(handled, true);
  assert.equal(admissions.length, 1);
  assert.match(
    admissions[0].message.text,
    /Core memory setup|Настройка core memory/u,
  );
  assert.equal(
    screens.some(({ text }) => /Передал иве/u.test(text)),
    false,
  );
  assert.match(
    readFileSync(join(vault, "core-interview.md"), "utf8"),
    /Core interview/u,
  );
});

void test("core returns false when synthetic inbox ownership fails", async (t) => {
  useVault(t);
  const { context, admissions } = makeContext();
  context.deps.deliver = () => Promise.resolve(false);
  context.deps.admitSynthetic = (update) => {
    admissions.push(update);
    return Promise.resolve(false);
  };

  const handled = await core.on(
    "fin",
    [],
    makeState({
      data: { iv: { i: 0, qa: [], chat: null, from: null, threadId: null } },
    }),
    context,
  );

  assert.equal(handled, false);
  assert.equal(admissions.length, 1);
});

void test("core duplicate retry reuses one stable bounded synthetic identity", async (t) => {
  useVault(t);
  const english = makeContext("en");
  const russian = makeContext("ru");
  english.context.deps.deliver = () => Promise.resolve(false);
  russian.context.deps.deliver = () => Promise.resolve(false);
  const retryState = () =>
    makeState({
      data: {
        iv: {
          i: 1,
          qa: [{ q: "Name?", a: "Sergey" }],
          chat: { id: 44, type: "private" },
          from: { id: 77, is_bot: false },
          threadId: null,
        },
      },
    });

  assert.equal(await core.on("fin", [], retryState(), english.context), true);
  assert.equal(await core.on("fin", [], retryState(), russian.context), true);
  const admissions = [...english.admissions, ...russian.admissions];
  assert.equal(admissions.length, 2);
  assert.equal(admissions[0].update_id, admissions[1].update_id);
  assert.equal(
    admissions[0].message.message_id,
    admissions[1].message.message_id,
  );
  assert.equal(Number.isSafeInteger(admissions[0].update_id), true);
  assert.equal(Number.isSafeInteger(admissions[0].message.message_id), true);
  assert.ok(admissions[0].update_id < 0);
  assert.ok(admissions[0].message.message_id > 0);
  assert.equal(admissions[0].update_id, -admissions[0].message.message_id);
});

void test("core saves the interview but never delivers while the same threaded chat is running", async (t) => {
  const vault = useVault(t);
  const { context, deliveries, screens } = makeContext();
  const state = makeState({
    chatId: 88,
    data: {
      iv: {
        i: 1,
        qa: [{ q: "Как обращаться?", a: "Сергей" }],
        chat: { id: 88, type: "supergroup" },
        from: { id: 77, is_bot: false },
        threadId: 12,
      },
    },
  });
  const key = runStatus.chatKeyOf(88, 12);
  runStatus.setChatStatus(key, { status: "running", sessionId: "busy" });
  t.after(() => {
    runStatus.setChatStatus(key, { status: "idle", sessionId: null });
  });

  await core.on("fin", [], state, context);

  assert.equal(deliveries.length, 0);
  assert.equal(state.awaitText, null);
  assert.match(screens.at(-1)?.text ?? "", /сейчас занята/);
  assert.match(
    readFileSync(join(vault, "core-interview.md"), "utf8"),
    /Сергей/,
  );
});

void test("core keeps direct legacy error.message behavior for injectable delivery rejections", async (t) => {
  useVault(t);
  const { context } = makeContext();
  const logged: unknown[][] = [];
  context.deps.log = (...parts: unknown[]) => {
    logged.push(parts);
  };
  const interview = (): InterviewState => ({
    i: 0,
    qa: [],
    chat: null,
    from: null,
    threadId: null,
  });

  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- characterizes legacy non-Error rejection semantics.
  context.deps.deliver = () => Promise.reject("primitive delivery failure");
  await core.on("fin", [], makeState({ data: { iv: interview() } }), context);
  assert.deepEqual(logged, [["core deliver error:", undefined]]);

  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- characterizes legacy non-Error rejection semantics.
  context.deps.deliver = () => Promise.reject(null);
  await assert.rejects(
    core.on("fin", [], makeState({ data: { iv: interview() } }), context),
    TypeError,
  );
});
