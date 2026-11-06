/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Проверка перед ходом Watch: источники Telegram (прокси юзербота по MCP) и почта (gws).
// На проводе — настоящий MCP-клиент против фикстуры MCP-сервера по streamable-http с bearer:
// какие аргументы уходят в `list_chats` и как разбирается ответ той формы, что отдаёт
// telegram-mcp f1a2d8e. Почта — подменённый запуск gws: коды выхода и формы ответа из пробы.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  MAIL_QUERY,
  mailSource,
  parseChats,
  proxyCallTool,
  senderOf,
  telegramSource,
  type GwsRun,
} from "./precheck.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const DATA = mkdtempSync(join(tmpdir(), "iva-precheck-"));
after(() => rmSync(DATA, { recursive: true, force: true }));

type Proxy = {
  readonly url: string;
  readonly calls: Array<Record<string, unknown>>;
  readonly close: () => Promise<void>;
};

/** Фикстура прокси юзербота: MCP по streamable-http, bearer обязателен. */
async function startProxy(
  token: string,
  answer: (args: Record<string, unknown>) => string,
  messageTools?: (name: string, args: Record<string, unknown>) => string,
): Promise<Proxy> {
  const calls: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const mcp = new McpServer({ name: "telegram-fixture", version: "1" });
    mcp.registerTool(
      "list_chats",
      {
        inputSchema: {
          chat_type: z.string().optional(),
          limit: z.number().optional(),
          unread_only: z.boolean().optional(),
          unmuted_only: z.boolean().optional(),
          archived: z.boolean().optional(),
        },
      },
      (args) => {
        calls.push(args);
        return { content: [{ type: "text" as const, text: answer(args) }] };
      },
    );
    if (messageTools) {
      for (const name of ["list_messages", "get_message_link"]) {
        mcp.registerTool(
          name,
          {
            inputSchema: {
              chat_id: z.number(),
              limit: z.number().optional(),
              message_id: z.number().optional(),
            },
          },
          (args) => ({
            content: [
              { type: "text" as const, text: messageTools(name, args) },
            ],
          }),
        );
      }
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    void mcp.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const results = (rows: unknown[]) => JSON.stringify({ results: rows });

test("on the wire: list_chats gets the documented arguments and a bearer; the answer becomes items", async (t) => {
  const proxy = await startProxy("tok", (args) =>
    args.chat_type === "user"
      ? results([
          {
            chat_id: 11,
            name: "Иван",
            type: "User",
            username: "ivan",
            unread: 2,
            muted: false,
            archived: false,
          },
          {
            chat_id: 12,
            name: "Отметка",
            type: "User",
            unread: 0,
            unread_mark: true,
          },
          { chat_id: 123456, name: "Iva bot", type: "User", unread: 4 },
          // Бот — не человек, который ждёт ответа (случай c1: herdrmebot, 24 непрочитанных).
          {
            chat_id: 13,
            name: "herdrme",
            type: "User",
            username: "herdrmeBot",
            unread: 24,
          },
        ])
      : results([
          {
            chat_id: -1001,
            title: "Команда",
            type: "Supergroup",
            unread: 40,
            unread_mentions: 1,
          },
          { chat_id: -1002, title: "Шумная", type: "Group", unread: 99 },
        ]),
  );
  t.after(() => proxy.close());
  const source = telegramSource(
    { TELEGRAM_BOT_TOKEN: "123456:secret" },
    DATA,
    proxyCallTool(proxy.url, "tok"),
  );
  const result = await source.check();
  assert.deepEqual(proxy.calls, [
    {
      chat_type: "user",
      unread_only: true,
      unmuted_only: true,
      archived: false,
      limit: 500,
    },
    {
      chat_type: "group",
      unread_only: true,
      unmuted_only: true,
      archived: false,
      limit: 200,
    },
  ]);
  assert.equal(result.error, null);
  assert.deepEqual(result.items, [
    { key: "tg:11", unread: 2, from: { username: "ivan", name: "Иван" } },
    { key: "tg:12", unread: 1, from: { username: undefined, name: "Отметка" } },
    {
      key: "tg:-1001",
      unread: 1,
      from: { username: undefined, name: "Команда" },
    },
  ]);
});

test("on the wire: a wrong bearer (401), a stopped proxy and a non-JSON answer are a source error", async (t) => {
  const proxy = await startProxy("tok", (args) =>
    args.chat_type === "user"
      ? "An error occurred (code: CHAT-ERR-123). Check mcp_errors.log for details."
      : results([]),
  );
  t.after(() => proxy.close());
  const wrong = await telegramSource(
    {},
    DATA,
    proxyCallTool(proxy.url, "nope"),
  ).check();
  assert.deepEqual(wrong.items, []);
  assert.notEqual(wrong.error, null);
  const text = await telegramSource(
    {},
    DATA,
    proxyCallTool(proxy.url, "tok"),
  ).check();
  assert.match(
    text.error ?? "",
    /list_chats answered not \{"results":\[…\]\}: An error occurred/u,
  );
  const stopped = await telegramSource(
    {},
    DATA,
    proxyCallTool("http://127.0.0.1:9/mcp", "tok"),
  ).check();
  assert.deepEqual(stopped.items, []);
  assert.notEqual(stopped.error, null);
});

test("a proxy that does not answer within the deadline is a source error", async (t) => {
  const hung = createServer(() => undefined);
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    hung.closeAllConnections();
    hung.close();
  });
  const { port } = hung.address() as { port: number };
  const started = Date.now();
  const result = await telegramSource(
    {},
    DATA,
    proxyCallTool(`http://127.0.0.1:${port}/mcp`, "tok", 300),
  ).check();
  assert.deepEqual(result.items, []);
  assert.match(result.error ?? "", /timed out/iu);
  assert.ok(Date.now() - started < 5_000);
});

test("no proxy token anywhere: Telegram is not connected — empty, no error", async () => {
  const dir = mkdtempSync(join(DATA, "no-token-"));
  assert.deepEqual(await telegramSource({}, dir).check(), {
    items: [],
    error: null,
  });
});

test("TELEGRAM_WATCH_URL points Watch at the owner's own proxy with its own token", async (t) => {
  // Случай c1: прокси владельца живёт не на 127.0.0.1:8724, и токена Ивы у него нет.
  const proxy = await startProxy(
    "watch-tok",
    () => "No chats found matching the criteria.",
  );
  t.after(() => proxy.close());
  const dir = mkdtempSync(join(DATA, "watch-url-"));
  const env = {
    TELEGRAM_WATCH_URL: proxy.url,
    TELEGRAM_WATCH_TOKEN: "watch-tok",
  };
  assert.deepEqual(await telegramSource(env, dir).check(), {
    items: [],
    error: null,
  });
  assert.equal(proxy.calls.length, 2);
  // Адрес без своего токена — не подключён: токен Ивы чужому прокси не уходит.
  writeFileSync(join(dir, "telegram-userbot.token"), "iva-own\n");
  assert.deepEqual(
    await telegramSource({ TELEGRAM_WATCH_URL: proxy.url }, dir).check(),
    { items: [], error: null },
  );
  assert.equal(proxy.calls.length, 2);
});

test("the token comes from TELEGRAM_MCP_TOKEN, then data/telegram-userbot.token", async (t) => {
  const proxy = await startProxy(
    "from-file",
    () => "No chats found matching the criteria.",
  );
  t.after(() => proxy.close());
  const dir = mkdtempSync(join(DATA, "token-"));
  writeFileSync(join(dir, "telegram-userbot.token"), "from-file\n");
  const port = new URL(proxy.url).port;
  assert.deepEqual(
    await telegramSource({ TELEGRAM_MCP_PORT: port }, dir).check(),
    {
      items: [],
      error: null,
    },
  );
  assert.equal(proxy.calls.length, 2);
  const wrongEnv = await telegramSource(
    { TELEGRAM_MCP_PORT: port, TELEGRAM_MCP_TOKEN: "env" },
    dir,
  ).check();
  assert.notEqual(wrongEnv.error, null, "the env token wins over the file");
});

test("an answer exactly at the limit is logged", async () => {
  const logs: string[] = [];
  const rows = Array.from({ length: 500 }, (_, i) => ({
    chat_id: i + 1,
    type: "User",
    unread: 1,
  }));
  const source = telegramSource(
    {},
    DATA,
    (_name, args) =>
      Promise.resolve(args.chat_type === "user" ? results(rows) : results([])),
    (line) => logs.push(line),
  );
  const { items } = await source.check();
  assert.equal(items.length, 500);
  assert.deepEqual(logs, ["proactive: telegram user chats hit the limit 500"]);
});

test(`parseChats never throws anything but an Error and keeps only objects (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
      try {
        const rows = parseChats(text);
        assert.ok(rows.every((row) => typeof row === "object" && row !== null));
      } catch (error) {
        assert.ok(error instanceof Error);
      }
    }),
    { seed: SEED, numRuns: 500 },
  );
});

test(`a group's unread growing without new mentions changes nothing (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.array(fc.integer({ min: 0, max: 10_000 }), {
        minLength: 2,
        maxLength: 6,
      }),
      async (mentions, unreads) => {
        const seen = new Set<string>();
        for (const unread of unreads) {
          const source = telegramSource({}, DATA, (_n, args) =>
            Promise.resolve(
              args.chat_type === "group"
                ? results([
                    {
                      chat_id: -5,
                      title: "Группа",
                      type: "Supergroup",
                      unread,
                      unread_mentions: mentions,
                    },
                  ])
                : results([]),
            ),
          );
          const { items } = await source.check();
          seen.add(JSON.stringify(items));
        }
        assert.equal(seen.size, 1);
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});

// ── Почта ────────────────────────────────────────────────────────────────────────────────

function gws(answers: Record<string, Awaited<ReturnType<GwsRun>>>) {
  const calls: Array<readonly string[]> = [];
  const run: GwsRun = (args) => {
    calls.push(args);
    const params = JSON.parse(args[5] ?? "{}") as { id?: string };
    const answer = answers[params.id ?? "list"];
    return Promise.resolve(answer ?? { code: 1, stdout: "" });
  };
  return { run, calls };
}

const metadata = (headers: Record<string, string>) => ({
  code: 0,
  stdout: JSON.stringify({
    id: "x",
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
  }),
});

test("mail: unread inbox without categories, a newsletter (List-Unsubscribe) is not an item", async () => {
  const { run, calls } = gws({
    list: {
      code: 0,
      stdout: JSON.stringify({
        messages: [
          { id: "a1", threadId: "t" },
          { id: "b2", threadId: "t" },
        ],
        resultSizeEstimate: 2,
      }),
    },
    a1: metadata({ From: '"Анна Петрова" <anna@example.com>' }),
    b2: metadata({
      From: "news@shop.example",
      "List-Unsubscribe": "<mailto:u@shop.example>",
    }),
  });
  const result = await mailSource(run).check();
  assert.deepEqual(result, {
    items: [
      {
        key: "mail:a1",
        unread: 1,
        from: { email: "anna@example.com", name: "Анна Петрова" },
      },
    ],
    error: null,
  });
  assert.deepEqual(calls[0], [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({ userId: "me", q: MAIL_QUERY, maxResults: 20 }),
  ]);
  assert.match(
    String(calls[1]?.[5]),
    /"format":"metadata","metadataHeaders":\["From","List-Unsubscribe"\]/u,
  );
});

test("mail: no messages key means empty", async () => {
  const { run } = gws({
    list: { code: 0, stdout: '{"resultSizeEstimate":0}' },
  });
  assert.deepEqual(await mailSource(run).check(), { items: [], error: null });
});

test("mail: gws missing or not authorised (code 2) is not connected — empty, no error", async () => {
  for (const code of ["missing", 2] as const) {
    const { run } = gws({ list: { code, stdout: "" } });
    assert.deepEqual(await mailSource(run).check(), { items: [], error: null });
  }
});

test("mail: a non-zero code, a timeout or garbage is a source error", async () => {
  for (const [answer, reason] of [
    [{ code: 1, stdout: '{"error":{"code":400}}' }, /gws list exited 1/u],
    [{ code: "timeout", stdout: "" }, /gws timed out after 20000 ms/u],
    [
      { code: 0, stdout: "Using keyring backend" },
      /gws list answered not a JSON object/u,
    ],
    [{ code: 0, stdout: "[]" }, /gws list answered not a JSON object/u],
  ] as const) {
    const { run } = gws({ list: answer });
    const result = await mailSource(run).check();
    assert.deepEqual(result.items, []);
    assert.match(result.error ?? "", reason);
  }
  const { run } = gws({
    list: { code: 0, stdout: JSON.stringify({ messages: [{ id: "a1" }] }) },
    a1: { code: 1, stdout: "" },
  });
  assert.match(
    (await mailSource(run).check()).error ?? "",
    /gws get exited 1/u,
  );
});

test("mail: at most 20 letters per run, ids that are not Gmail ids are dropped", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}` }));
  const answers: Record<string, Awaited<ReturnType<GwsRun>>> = {
    list: {
      code: 0,
      stdout: JSON.stringify({ messages: [{ id: "../x" }, ...ids] }),
    },
  };
  for (const { id } of ids) answers[id] = metadata({ From: "a@b.c" });
  const { run, calls } = gws(answers);
  const result = await mailSource(run).check();
  assert.equal(result.items.length, 20);
  assert.equal(calls.length, 21);
});

test("senderOf: the address in angle brackets, or a bare address", () => {
  assert.deepEqual(senderOf("Boss <boss@example.com>"), {
    email: "boss@example.com",
    name: "Boss",
  });
  assert.deepEqual(senderOf("boss@example.com"), {
    email: "boss@example.com",
    name: undefined,
  });
  assert.deepEqual(senderOf(""), { email: undefined, name: undefined });
});

test(`PBT senderOf: never throws, never invents an address or a name (seed ${SEED})`, () => {
  const local = fc.stringMatching(/^[a-z0-9._+-]{1,12}$/u);
  const domain = fc.stringMatching(/^[a-z0-9-]{1,10}\.[a-z]{2,4}$/u);
  const address = fc.tuple(local, domain).map(([l, d]) => `${l}@${d}`);
  const display = fc
    .string({ maxLength: 30 })
    .filter((n) => !/[<>"@]/u.test(n));
  const from = fc.oneof(
    fc.string({ maxLength: 80 }),
    fc.string({ unit: "grapheme", maxLength: 40 }),
    address,
    fc.tuple(display, address).map(([n, a]) => `${n} <${a}>`),
    fc.tuple(display, address).map(([n, a]) => `"${n}" <${a}>`),
  );
  fc.assert(
    fc.property(from, (value) => {
      const sender = senderOf(value);
      if (sender.email !== undefined) {
        assert.ok(
          value.includes(sender.email),
          "the address is from the input",
        );
        assert.match(sender.email, /^[^\s<>]+@[^\s<>]+$/u);
      }
      if (sender.name !== undefined) {
        assert.notEqual(sender.name.trim(), "");
        const plain = value.replace(/<[^<>]*>/u, "").replace(/"/gu, "");
        assert.ok(plain.includes(sender.name), "the name is from the input");
        assert.notEqual(sender.name, sender.email);
      }
    }),
    { seed: SEED, numRuns: 1000 },
  );
  fc.assert(
    fc.property(display, address, (name, addr) => {
      const sender = senderOf(`${name} <${addr}>`);
      assert.equal(sender.email, addr);
      assert.equal(sender.name, name.trim() === "" ? undefined : name.trim());
    }),
    { seed: SEED, numRuns: 500 },
  );
});

test("Telegram group items carry the latest message and forum topic to Watch", async () => {
  for (const [username, link, topic] of [
    [undefined, "https://t.me/c/4398169447/40", undefined],
    [undefined, "https://t.me/c/4398169447/12/40", 12],
    ["public_team", "https://t.me/public_team/40", undefined],
    ["public_team", "https://t.me/public_team/12/40", 12],
    [undefined, "https://t.me/c/4398169447/40?thread=12", 12],
    [undefined, "https://t.me/c/111/12/40", undefined],
    [undefined, "https://t.me/c/4398169447/12/41", undefined],
    [undefined, "https://t.me/c/4398169447/0/40", undefined],
  ] as const) {
    const calls: string[] = [];
    const source = telegramSource({}, DATA, (name, args) =>
      Promise.resolve().then(() => {
        calls.push(name);
        if (name === "list_chats")
          return results(
            args.chat_type === "group"
              ? [
                  {
                    chat_id: -1004398169447,
                    type: "Supergroup",
                    title: "Team",
                    username,
                    unread_mentions: 1,
                  },
                ]
              : [],
          );
        if (name === "list_messages") {
          assert.deepEqual(args, { chat_id: -1004398169447, limit: 1 });
          return results([{ id: 40, reply_to: 7 }]);
        }
        assert.equal(name, "get_message_link");
        assert.deepEqual(args, { chat_id: -1004398169447, message_id: 40 });
        return `Link: ${link}\nHTML: ignored`;
      }),
    );
    const checked = await source.check();
    assert.equal(checked.error, null);
    assert.equal(checked.items[0]?.message_id, 40);
    assert.equal(checked.items[0]?.topic_id, topic);
    assert.equal(checked.items[0]?.from.username, username);
    assert.deepEqual(calls, [
      "list_chats",
      "list_chats",
      "list_messages",
      "get_message_link",
    ]);
  }
});

test("missing Telegram message metadata keeps the item without a fabricated id", async () => {
  for (const answer of [
    "No messages found matching the criteria.",
    results([{ id: -1 }]),
    results([{ id: "40" }]),
    "failure",
  ]) {
    const source = telegramSource({}, DATA, (name, args) =>
      Promise.resolve().then(() => {
        if (name === "list_chats")
          return results(
            args.chat_type === "group"
              ? [
                  {
                    chat_id: -1004398169447,
                    type: "Supergroup",
                    unread_mentions: 1,
                  },
                ]
              : [],
          );
        if (answer === "failure") throw new Error("offline");
        return answer;
      }),
    );
    const checked = await source.check();
    assert.equal(checked.items.length, 1);
    assert.equal(checked.items[0]?.message_id, undefined);
    assert.equal(checked.items[0]?.topic_id, undefined);
  }
});

test("a refused message link preserves the known message id", async () => {
  const source = telegramSource(
    {},
    DATA,
    (name, args) =>
      Promise.resolve().then(() => {
        if (name === "list_chats")
          return results(
            args.chat_type === "group"
              ? [
                  {
                    chat_id: -1004398169447,
                    type: "Supergroup",
                    unread_mentions: 1,
                  },
                ]
              : [],
          );
        if (name === "list_messages") return results([{ id: 40 }]);
        throw new Error("export unavailable");
      }),
    () => undefined,
  );
  assert.deepEqual((await source.check()).items[0], {
    key: "tg:-1004398169447",
    unread: 1,
    from: { name: undefined, username: undefined },
    message_id: 40,
  });
});

test("on the wire: group metadata uses read tools with the same chat and message", async (t) => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const proxy = await startProxy(
    "tok",
    (args) =>
      results(
        args.chat_type === "group"
          ? [
              {
                chat_id: -1004398169447,
                type: "Supergroup",
                unread_mentions: 1,
              },
            ]
          : [],
      ),
    (name, args) => {
      seen.push({ name, args });
      return name === "list_messages"
        ? results([{ id: 40 }])
        : "Link: https://t.me/c/4398169447/12/40";
    },
  );
  t.after(() => proxy.close());
  const checked = await telegramSource(
    {},
    DATA,
    proxyCallTool(proxy.url, "tok"),
  ).check();
  assert.equal(checked.items[0]?.message_id, 40);
  assert.equal(checked.items[0]?.topic_id, 12);
  assert.deepEqual(seen, [
    { name: "list_messages", args: { chat_id: -1004398169447, limit: 1 } },
    {
      name: "get_message_link",
      args: { chat_id: -1004398169447, message_id: 40 },
    },
  ]);
});

test(`PBT exported topic belongs to the selected chat and latest message (seed=${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1000000, max: 9999999999 }),
      fc.integer({ min: 1, max: 2147483647 }),
      fc.integer({ min: 1, max: 2147483647 }),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      async (peer, message, topic, publicChat, query, mismatch) => {
        const chat_id = Number(`-100${peer}`);
        const source = telegramSource({}, DATA, (name, args) =>
          Promise.resolve().then(() => {
            if (name === "list_chats")
              return results(
                args.chat_type === "group"
                  ? [
                      {
                        chat_id,
                        type: "Supergroup",
                        username: publicChat ? "public_team" : undefined,
                        unread_mentions: 1,
                      },
                    ]
                  : [],
              );
            if (name === "list_messages") return results([{ id: message }]);
            const target = publicChat ? "public_team" : `c/${peer}`;
            return `Link: https://t.me/${target}/${query ? `${message + Number(mismatch)}?thread=${topic}` : `${topic}/${message + Number(mismatch)}`}`;
          }),
        );
        const item = (await source.check()).items[0];
        assert.equal(item?.message_id, message);
        assert.equal(item?.topic_id, mismatch ? undefined : topic);
      },
    ),
    { seed: SEED, numRuns: 80 },
  );
});
