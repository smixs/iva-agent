/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// IMAP-источник проверки почты Watch: настройка, разбор заголовков и протокол.
// Сети нет: разговор с сервером играется записанными кусками через `ImapConnect` — проверяем
// ровно то, что уходит на провод (EXAMINE, BODY.PEEK, отсутствие STORE) и как разбирается ответ.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import {
  decodeWords,
  parseHeaderBlock,
  readImapConfig,
  readImapInbox,
  searchUids,
  type ImapConfig,
  type ImapConnect,
} from "./imap.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const DATA = mkdtempSync(join(tmpdir(), "iva-imap-"));
after(() => rmSync(DATA, { recursive: true, force: true }));

const CONFIG: ImapConfig = {
  host: "imap.example.org",
  port: 993,
  user: "owner@example.org",
  password: 'pa"ss\\word',
};

/**
 * Записанный сервер: на каждую команду по её метке — свой ответ. Приветствие уходит сразу после
 * подключения, остальное — после того, как клиент напишет команду (порядок команд виден в `sent`).
 * Куски ответа можно дробить как угодно: литерал `{N}` проверяется на склейке.
 */
/** Куски ответа; `{ end }` — сервер закрыл соединение с этой ошибкой. */
type Chunk = string | Buffer | { readonly end: string };

function scripted(answers: Readonly<Record<string, readonly Chunk[]>>) {
  const sent: string[] = [];
  let closed = false;
  const connect: ImapConnect = (_config, handlers) => {
    const send = (chunks: readonly Chunk[]) => {
      for (const chunk of chunks) {
        if (typeof chunk === "object" && !Buffer.isBuffer(chunk))
          handlers.end(new Error(chunk.end));
        else
          handlers.data(
            typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
          );
      }
    };
    queueMicrotask(() => send(answers.greeting ?? []));
    return {
      write: (text) => {
        sent.push(text);
        const tag = text.split(" ")[0] ?? "";
        const chunks = answers[tag] ?? [];
        queueMicrotask(() => send(chunks));
      },
      close: () => {
        closed = true;
      },
    };
  };
  return { connect, sent, isClosed: () => closed };
}

/** Строка FETCH с литералом: длина считается по байтам, как её печатает сервер. */
const fetch = (uid: number, block: string) =>
  `* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM SUBJECT LIST-UNSUBSCRIBE)] {${Buffer.byteLength(block, "utf8")}}\r\n${block})\r\n`;

const greeting = "* OK IMAP4rev1 ready\r\n";
const login = "A1 OK LOGIN completed\r\n";
const examined =
  "* 3 EXISTS\r\n* OK [UIDVALIDITY 42] UIDs valid\r\nA2 OK EXAMINE done\r\n";

test("readImapInbox: EXAMINE + UID SEARCH + BODY.PEEK headers, never a write command", async () => {
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: ["* SEARCH 5 9\r\nA3 OK SEARCH done\r\n"],
    // Литерал разрезан на куски: разбор обязан склеить его по счёту байт.
    A4: [
      fetch(5, "From: Air <noreply@air.example>\r\nSubject: Check-in\r\n\r\n"),
      fetch(
        9,
        "From: shop@shop.example\r\nList-Unsubscribe: <mailto:u@shop>\r\n\r\n",
      ),
      "A4 OK FETCH done\r\n",
    ],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.deepEqual(
    inbox.messages.map((m) => [m.uid, m.from, m.newsletter]),
    [
      [9, "shop@shop.example", true],
      [5, "Air <noreply@air.example>", false],
    ],
  );
  assert.equal(inbox.truncated, false);
  // Пароль в команде экранирован; ящик открыт EXAMINE; тело письма не запрашивается.
  assert.equal(
    wire.sent[0],
    `A1 LOGIN "owner@example.org" "pa\\"ss\\\\word"\r\n`,
  );
  assert.equal(wire.sent[1], "A2 EXAMINE INBOX\r\n");
  assert.equal(wire.sent[2], "A3 UID SEARCH UNSEEN\r\n");
  assert.equal(
    wire.sent[3],
    "A4 UID FETCH 5,9 (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT LIST-UNSUBSCRIBE)])\r\n",
  );
  for (const line of wire.sent)
    assert.ok(!/\b(STORE|EXPUNGE|COPY|SELECT)\b/u.test(line), line);
  assert.equal(wire.isClosed(), true);
});

test("readImapInbox: no unread letters — no FETCH at all, LOGOUT still goes out", async () => {
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: ["* SEARCH\r\nA3 OK SEARCH done\r\n"],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.deepEqual(inbox, { messages: [], truncated: false });
  assert.equal(wire.sent.length, 4);
  assert.equal(wire.sent[3], "A5 LOGOUT\r\n");
});

test("readImapInbox: more unread than the limit keeps the newest UIDs and says so", async () => {
  const uids = Array.from({ length: 25 }, (_, i) => i + 1);
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: [`* SEARCH ${uids.join(" ")}\r\nA3 OK SEARCH done\r\n`],
    A4: [fetch(25, "From: a@b.c\r\n\r\n"), "A4 OK FETCH done\r\n"],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.equal(inbox.truncated, true);
  assert.equal(wire.sent[3]?.startsWith("A4 UID FETCH 6,7,8"), true);
});

test("readImapInbox: a letter that vanished between SEARCH and FETCH is skipped", async () => {
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: ["* SEARCH 5 9\r\nA3 OK SEARCH done\r\n"],
    // Только 9: пятого уже нет.
    A4: [fetch(9, "From: x@y.z\r\n\r\n"), "A4 OK FETCH done\r\n"],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.deepEqual(
    inbox.messages.map((m) => m.uid),
    [9],
  );
});

test("readImapInbox: an unsolicited FLAGS FETCH does not become a letter", async () => {
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: ["* SEARCH 9\r\nA3 OK SEARCH done\r\n"],
    A4: [
      // Другой клиент снял флаг у письма 8, которое мы не просили: ни литерала, ни заголовков.
      "* 2 FETCH (UID 8 FLAGS (\\Seen))\r\n",
      // И то же письмо 9, но без заголовков — тоже не письмо.
      "* 3 FETCH (UID 9 FLAGS (\\Deleted))\r\n",
      fetch(9, "From: real@example.com\r\nSubject: Real\r\n\r\n"),
      "A4 OK FETCH done\r\n",
    ],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.deepEqual(
    inbox.messages.map((m) => [m.uid, m.from]),
    [[9, "real@example.com"]],
  );
});

test("readImapInbox: a SEARCH line longer than the general limit still works", async () => {
  // 20 000 шестизначных UID — около 140 КиБ в одной строке ответа SEARCH.
  const uids = Array.from({ length: 20_000 }, (_, i) => 100_000 + i);
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: [`* SEARCH ${uids.join(" ")}\r\nA3 OK SEARCH done\r\n`],
    A4: [fetch(119_999, "From: a@b.c\r\n\r\n"), "A4 OK FETCH done\r\n"],
  });
  const inbox = await readImapInbox(
    CONFIG,
    20,
    new AbortController().signal,
    wire.connect,
  );
  assert.deepEqual(
    inbox.messages.map((m) => m.uid),
    [119_999],
  );
  assert.equal(inbox.truncated, true);
});

test("readImapInbox: a refused login, a bad status or a closed socket is an error, not a hang", async () => {
  for (const [answers, reason] of [
    [
      {
        greeting: ["* OK ready\r\n"],
        A1: ["A1 NO [AUTHENTICATIONFAILED] bad password\r\n"],
      },
      /A1 LOGIN answered NO/u,
    ],
    [{ greeting: ["* BYE go away\r\n"] }, /greeting is not OK/u],
    [
      {
        greeting: [greeting],
        A1: [login],
        A2: [examined],
        A3: ["* SEARCH 5\r\nA3 BAD unknown\r\n"],
      },
      /A3 UID answered BAD/u,
    ],
    [
      {
        greeting: [greeting],
        A1: [login],
        A2: [examined],
        A3: ["* SEARCH 5\r\nA3 OK\r\n"],
        // Соединение закрылось посреди литерала — ждать нечего.
        A4: ["* 1 FETCH (UID 5 {20}\r\n", { end: "imap connection closed" }],
      },
      /closed/u,
    ],
  ] as const) {
    const wire = scripted(answers);
    await assert.rejects(
      readImapInbox(CONFIG, 20, new AbortController().signal, wire.connect),
      reason,
    );
    assert.equal(wire.isClosed(), true);
  }
});

test("readImapInbox: the deadline destroys the socket and rejects", async () => {
  const wire = scripted({
    greeting: [greeting],
    A1: [login],
    A2: [examined],
    A3: ["* SEARCH 5\r\n"],
  });
  const controller = new AbortController();
  const run = readImapInbox(CONFIG, 20, controller.signal, wire.connect);
  controller.abort(new Error("imap deadline passed"));
  await assert.rejects(run, /imap deadline passed/u);
  assert.equal(wire.isClosed(), true);
});

test("parseHeaderBlock: folding is unwound, names are case-insensitive, the first value wins", () => {
  const headers = parseHeaderBlock(
    [
      "From: Air <noreply@air.example>",
      "Subject: online check-in",
      " is open",
      "subject: second",
      "LIST-UNSUBSCRIBE: <mailto:u@air>",
      "broken line without a colon",
    ].join("\r\n"),
  );
  assert.equal(headers.get("from"), "Air <noreply@air.example>");
  assert.equal(headers.get("subject"), "online check-in is open");
  assert.equal(headers.get("list-unsubscribe"), "<mailto:u@air>");
  assert.equal(headers.size, 3);
});

test("decodeWords: B and Q encoded words, unknown charsets stay as they came", () => {
  assert.equal(
    decodeWords("=?UTF-8?B?0JDQvdC90LAg0J/QtdGC0YDQvtCy0LA=?="),
    "Анна Петрова",
  );
  assert.equal(decodeWords("=?utf-8?Q?Air=20lines?="), "Air lines");
  assert.equal(decodeWords("=?x-nope?B?0JDRgg==?="), "=?x-nope?B?0JDRgg==?=");
  assert.equal(decodeWords("plain name"), "plain name");
});

test("decodeWords: the gap between two encoded words is not a space", () => {
  // Так Яндекс режет длинную тему: слова по границе кодировки, пробел внутри payload.
  const raw =
    "=?UTF-8?B?0KPCoNCy0LDRgSDQtdGB0YLRjCDQt9Cw?=\r\n " +
    "=?UTF-8?B?0LTQvtC70LbQtdC90L3QvtGB0YLRjCDQt9Cw?=";
  assert.equal(
    decodeWords(raw.replace(/\r?\n /gu, " ")),
    "У\u00a0вас есть задолженность за",
  );
});

test(`PBT decodeWords: never throws on a header-shaped string (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const decoded = decodeWords(value);
      assert.equal(typeof decoded, "string");
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`PBT searchUids: sorted, unique, only positive numbers (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string(), fc.integer(), fc.constant("SEARCH")), {
        maxLength: 40,
      }),
      (tokens) => {
        const answer = [`SEARCH ${tokens.map(String).join(" ")}`];
        const uids = searchUids(answer);
        assert.deepEqual(
          uids,
          [...new Set(uids)].sort((a, b) => a - b),
        );
        assert.ok(uids.every((uid) => Number.isSafeInteger(uid) && uid > 0));
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

test(`PBT parseHeaderBlock: a header map, names lowercased, no empty names (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      const headers = parseHeaderBlock(raw);
      for (const [name, value] of headers) {
        assert.equal(name, name.toLowerCase());
        assert.notEqual(name, "");
        assert.equal(typeof value, "string");
      }
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test(`PBT readImapConfig: never throws, a config or a reason always comes back (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (host, password) => {
      const read = readImapConfig(DATA, {
        IVA_IMAP_HOST: host,
        IVA_IMAP_USER: "owner@example.org",
        IVA_IMAP_PASSWORD: password,
      });
      assert.ok("config" in read || "error" in read);
      if ("config" in read)
        assert.ok(read.config.port > 0 && read.config.port <= 65_535);
    }),
    { seed: SEED, numRuns: 200 },
  );
});

test("searchUids: numbers only, no repeats, ascending; other answers ignored", () => {
  assert.deepEqual(searchUids(["SEARCH 9 5 5 12", "OK done"]), [5, 9, 12]);
  assert.deepEqual(searchUids(["SEARCH", "SEARCH 007"]), [7]);
  assert.deepEqual(searchUids(["SEARCH ../x 1e3"]), []);
});

test("readImapConfig: the secret file, then IVA_IMAP_* over it, port defaults to 993", () => {
  const dir = join(DATA, "secrets-file");
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(
    join(dir, "secrets", "imap.json"),
    JSON.stringify({
      host: "imap.example.com",
      user: "owner@example.com",
      password: "app-password",
    }),
  );
  assert.deepEqual(readImapConfig(dir, {}), {
    config: {
      host: "imap.example.com",
      port: 993,
      user: "owner@example.com",
      password: "app-password",
    },
  });
  assert.deepEqual(
    readImapConfig(dir, {
      IVA_IMAP_HOST: "imap.other.example",
      IVA_IMAP_PORT: "143",
      IVA_IMAP_PASSWORD: "env-password",
    }),
    {
      config: {
        host: "imap.other.example",
        port: 143,
        user: "owner@example.com",
        password: "env-password",
      },
    },
  );
  assert.deepEqual(readImapConfig(join(DATA, "nothing"), {}), {
    error: "imap is not configured (data/secrets/imap.json or IVA_IMAP_*)",
  });
});

test("readImapConfig: a numeric port in the file is kept, not replaced by 993", () => {
  const dir = join(DATA, "port-number");
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(
    join(dir, "secrets", "imap.json"),
    JSON.stringify({
      host: "imap.example.com",
      port: 1993,
      user: "owner@example.com",
      password: "app-password",
    }),
  );
  const read = readImapConfig(dir, {});
  assert.equal("config" in read ? read.config.port : read.error, 1993);
  // Переменная окружения важнее файла.
  const overridden = readImapConfig(dir, { IVA_IMAP_PORT: "2993" });
  assert.equal(
    "config" in overridden ? overridden.config.port : overridden.error,
    2993,
  );
  // Не порт — отказ, а не тихая подмена 993.
  const bad = readImapConfig(dir, { IVA_IMAP_PORT: "imap" });
  assert.equal(
    "error" in bad ? bad.error : bad.config.port,
    "imap port is not a valid port",
  );
});

test("readImapConfig: the password keeps its edge whitespace, the others are trimmed", () => {
  const dir = join(DATA, "password-spaces");
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(
    join(dir, "secrets", "imap.json"),
    JSON.stringify({
      host: "  imap.example.com  ",
      user: "owner@example.com",
      password: "  pass with spaces  ",
    }),
  );
  const read = readImapConfig(dir, {});
  assert.deepEqual("config" in read ? read.config : read.error, {
    host: "imap.example.com",
    port: 993,
    user: "owner@example.com",
    password: "  pass with spaces  ",
  });
  const fromEnv = readImapConfig(dir, { IVA_IMAP_PASSWORD: " env pass " });
  assert.equal(
    "config" in fromEnv ? fromEnv.config.password : fromEnv.error,
    " env pass ",
  );
});

test("readImapConfig: garbage names the reason instead of throwing", () => {
  const write = (name: string, text: string) => {
    const dir = join(DATA, name);
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "imap.json"), text);
    return dir;
  };
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    [write("broken-json", "{oops"), {}, /not valid JSON/u],
    [write("array", "[]"), {}, /not a JSON object/u],
    [
      write("no-pass", '{"host":"h","user":"u"}'),
      {},
      /needs host, user and password/u,
    ],
    [
      write("bad-port", '{"host":"h","user":"u","password":"p","port":"x"}'),
      {},
      /port is not a valid port/u,
    ],
    [
      write("bad-host", '{"host":"h h","user":"u","password":"p"}'),
      {},
      /host is not a host name/u,
    ],
    [
      write("control", '{"host":"h","user":"u\\nA2 X","password":"p"}'),
      {},
      /control characters/u,
    ],
  ];
  for (const [dir, env, reason] of cases) {
    const read = readImapConfig(dir, env);
    assert.ok("error" in read, dir);
    assert.match(read.error, reason);
  }
});
