// Якоря контракта журнала хода: схема строки, тумблер содержимого, чистка по имени
// файла, безопасность записи и события швов. Свойства (обрезка, невалидный вход,
// произвольные наборы файлов) живут в trace.property.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Писатель читает каталог данных на каждой записи, а settings.ts фиксирует свой путь
// на загрузке — окружение выставляем ДО импорта модуля.
const root = mkdtempSync(join(tmpdir(), "iva-trace-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("./trace.ts");

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// Свежий каталог данных под тест, которому нужен свой файл журнала.

function last(
  events: Record<string, unknown>[],
  match: (event: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return events.filter(match).at(-1);
}

function world(): string {
  const dir = mkdtempSync(join(root, "world-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  return join(dir, "data");
}

const DATA = process.env.ASSISTANT_DATA_DIR;

function lines(dir: string, day: string): Record<string, unknown>[] {
  return readFileSync(trace.traceFilePath(day, dir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AT = new Date("2026-08-17T10:20:30.000Z");

void test("путь журнала следует ASSISTANT_DATA_DIR", () => {
  assert.equal(
    trace.traceFilePath("2026-08-17"),
    join(root, "data", "trace", "2026-08-17.jsonl"),
  );
  assert.equal(
    trace.traceFilePath("2026-08-17", "/tmp/iva"),
    "/tmp/iva/trace/2026-08-17.jsonl",
  );
});

void test("событие ложится одной строкой фиксированной схемы", () => {
  const dir = world();
  trace.appendTrace(
    {
      kind: "inbound",
      name: "received",
      turn: "tg:77:5",
      session: "wrun_1",
      source: "telegram",
      data: { chatId: "77" },
      content: { text: "привет" },
    },
    { dir, now: AT, captureContent: true },
  );
  trace.appendTrace(
    { kind: "eve", name: "turn.started", turn: "turn_1" },
    { dir, now: AT, captureContent: true },
  );

  const raw = readFileSync(trace.traceFilePath("2026-08-17", dir), "utf8");
  assert.equal(raw.split("\n").length, 3); // две записи и завершающий перевод строки
  const [first, second] = lines(dir, "2026-08-17");
  assert.deepEqual(Object.keys(first), [
    "ts",
    "turn",
    "session",
    "source",
    "kind",
    "name",
    "data",
  ]);
  assert.deepEqual(first, {
    ts: "2026-08-17T10:20:30.000Z",
    turn: "tg:77:5",
    session: "wrun_1",
    source: "telegram",
    kind: "inbound",
    name: "received",
    data: { chatId: "77", textChars: 6, text: "привет" },
  });
  // Пустые поля заголовка остаются пустыми строками, а не исчезают: схема одна на все события.
  assert.deepEqual(second, {
    ts: "2026-08-17T10:20:30.000Z",
    turn: "turn_1",
    session: "",
    source: "",
    kind: "eve",
    name: "turn.started",
    data: {},
  });
});

void test("captureContent=false оставляет имена, тайминги и размеры", () => {
  const dir = world();
  const input = {
    kind: "outbox",
    name: "delivered",
    turn: "turn_1",
    data: { ok: true, ms: 12 },
    content: { text: "секретный ответ" },
  };
  trace.appendTrace(input, { dir, now: AT, captureContent: false });

  const [event] = lines(dir, "2026-08-17");
  assert.deepEqual(event.data, { ok: true, ms: 12, textChars: 15 });
  assert.equal(JSON.stringify(event).includes("секретный"), false);
});

void test("тумблер captureContent читается из settings.json РЯДОМ с журналом", () => {
  const dir = world();
  // Значение по умолчанию — включено: файла настроек ещё нет.
  assert.equal(trace.captureContentEnabled(dir), true);

  // Настройки читаются по тому же каталогу данных, в который идёт запись: у моста,
  // агента и теста каталоги разные, и тумблер обязан следовать за журналом.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ captureContent: false }),
  );
  assert.equal(trace.captureContentEnabled(dir), false);
  trace.appendTrace(
    { kind: "eve", name: "message.completed", content: { message: "текст" } },
    { dir, now: AT },
  );
  assert.deepEqual(lines(dir, "2026-08-17")[0].data, { messageChars: 5 });

  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ captureContent: true }),
  );
  assert.equal(trace.captureContentEnabled(dir), true);
  trace.appendTrace(
    { kind: "eve", name: "message.completed", content: { message: "текст" } },
    { dir, now: AT },
  );
  assert.deepEqual(lines(dir, "2026-08-17")[1].data, {
    messageChars: 5,
    message: "текст",
  });
});

void test("журнал не создаёт каталог данных там, где его нет", () => {
  const absent = join(root, "no-install", "data");
  trace.appendTrace({ kind: "eve", name: "turn.started" }, { dir: absent });
  assert.equal(existsSync(absent), false);
});

void test("ошибка записи не выходит наружу", (t) => {
  const dir = world();
  // Каталог журнала занят файлом: mkdir и append обязаны провалиться.
  writeFileSync(trace.traceDir(dir), "not a directory");
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  // Часы сдвинуты вперёд на весь тест: сколько бы жалоб ни случилось ДО него в этом
  // файле, интервал дросселя заведомо истёк. Порядок тестов на результат не влияет.
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  t.after(() => {
    console.error = original;
    Date.now = realNow;
  });

  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() =>
      trace.appendTrace(
        { kind: "eve", name: "turn.started" },
        { dir, now: AT },
      ),
    );
  }
  // Полный диск не имеет права залить journal службы: одна жалоба в минуту.
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("[trace] событие не записано:"));
});

void test("чистка оставляет 30 дней ПО ИМЕНИ, удаляет 31-й и не трогает чужие", () => {
  const dir = world();
  mkdirSync(trace.traceDir(dir), { recursive: true });
  // 31 день подряд до сегодняшнего: 2026-07-18 … 2026-08-17.
  const days = Array.from({ length: 31 }, (_, back) =>
    new Date(Date.UTC(2026, 7, 17 - back)).toISOString().slice(0, 10),
  );
  const foreign = ["notes.md", "2026-07-05.jsonl.bak", "old.jsonl"];
  const names = [...days.map((day) => `${day}.jsonl`), "2026-07-01.jsonl"];
  for (const name of [...names, ...foreign])
    writeFileSync(join(trace.traceDir(dir), name), "");

  const removed = trace.pruneTrace(dir, "2026-08-17");

  assert.deepEqual(removed.sort(), ["2026-07-01.jsonl", "2026-07-18.jsonl"]);
  assert.deepEqual(
    readdirSync(trace.traceDir(dir)).sort(),
    [...names.slice(0, 30), ...foreign].sort(),
  );
});

void test("новый день чистит журнал сам, один раз", () => {
  const dir = world();
  mkdirSync(trace.traceDir(dir), { recursive: true });
  writeFileSync(join(trace.traceDir(dir), "2026-07-01.jsonl"), "");

  trace.appendTrace({ kind: "eve", name: "turn.started" }, { dir, now: AT });

  assert.deepEqual(readdirSync(trace.traceDir(dir)).sort(), [
    "2026-08-17.jsonl",
  ]);
});

void test("ход связывается с апдейтом через ключ чата", () => {
  const message = {
    chat: { id: "77", type: "private" },
    from: { id: "42" },
    messageId: "5",
    text: "привет",
    caption: "",
  };

  trace.traceInboundReceived(message);
  trace.traceInboundOutcome(message, "77", ["[reply]"], true);
  trace.traceTurnBound("77", "wrun_1", "turn_3");

  const events = lines(DATA, trace.traceDay());
  const received = events.find((event) => event.name === "received");
  const accepted = events.find((event) => event.name === "accepted");
  const bound = events.find((event) => event.name === "bound");
  assert.deepEqual(received?.data, {
    chatId: "77",
    chatType: "private",
    messageId: "5",
    userId: "42",
    allowlisted: true,
    textChars: 6,
    text: "привет",
  });
  assert.equal(received?.turn, "tg:77:5");
  assert.equal(accepted?.turn, "tg:77:5");
  assert.deepEqual(bound, {
    ts: bound?.ts,
    turn: "turn_3",
    session: "wrun_1",
    source: "telegram",
    kind: "turn",
    name: "bound",
    data: { chatKey: "77", updateKey: "tg:77:5" },
  });
});

void test("отброшенный апдейт ход не помечает", () => {
  const message = {
    chat: { id: "78", type: "group" },
    from: { id: "9" },
    messageId: "6",
    text: "чужое",
    caption: "",
  };
  trace.traceInboundOutcome(message, "78", undefined, false);
  trace.traceTurnBound("78", "wrun_2", "turn_4");

  const events = lines(DATA, trace.traceDay());
  const dropped = events.find((event) => event.name === "dropped");
  const bound = last(events, (event) => event.name === "bound");
  assert.equal(dropped?.turn, "tg:78:6");
  assert.deepEqual(dropped?.data, {
    chatId: "78",
    chatKey: "78",
    parts: 0,
    partChars: [],
    context: [],
  });
  assert.deepEqual(bound?.data, { chatKey: "78", updateKey: "" });
});

void test("мост пишет свои события тем же ключом апдейта", () => {
  const update = {
    update_id: 900,
    message: { message_id: 5, chat: { id: 77 } },
  };
  trace.traceBridgeAdmission(update, "owned");
  trace.traceBridgeDelivery(update, true, 42);
  trace.traceBridgeAdmission(
    {
      update_id: 901,
      callback_query: { id: "cb1", message: { chat: { id: 77 } } },
    },
    "terminal-drop",
  );

  const events = lines(DATA, trace.traceDay());
  const admitted = events.find(
    (event) => event.kind === "bridge" && event.name === "admitted",
  );
  const delivered = events.find((event) => event.name === "delivered");
  const callback = last(
    events,
    (event) => event.kind === "bridge" && event.name === "dropped",
  );
  assert.equal(admitted?.turn, "tg:77:5");
  assert.equal(admitted?.source, "bridge");
  assert.deepEqual(admitted?.data, {
    updateId: 900,
    chatId: 77,
    messageId: "5",
    kind: "message",
    decision: "owned",
  });
  assert.deepEqual(delivered?.data, {
    updateId: 900,
    chatId: 77,
    messageId: "5",
    kind: "message",
    accepted: true,
    ms: 42,
    parts: 1,
  });
  assert.equal(callback?.turn, "tg:77:cb:cb1");
  assert.deepEqual(
    (callback?.data as Record<string, unknown>).decision,
    "terminal-drop",
  );
});

void test("мост пишет постановку в очередь и число частей пачки без содержимого", () => {
  const queued = {
    update_id: 910,
    message: { message_id: 11, chat: { id: 77 }, text: "слова-постановки-910" },
  };
  trace.traceBridgeQueued(queued, 2, "chat busy: turn");
  const batch = {
    update_id: 913,
    message: {
      message_id: 11,
      chat: { id: 77 },
      text: "слова-первое",
      iva_parts: [
        { text: "слова-первое" },
        { text: "слова-второе" },
        { text: "слова-третье" },
      ],
    },
  };
  trace.traceBridgeDelivery(batch, true, 7);
  trace.traceBridgeDelivery({ ...batch, update_id: 914 }, false, 5_000);

  const events = lines(DATA, trace.traceDay());
  const enqueued = last(
    events,
    (event) => event.kind === "bridge" && event.name === "queued",
  );
  assert.equal(enqueued?.turn, "tg:77:11");
  assert.deepEqual(enqueued?.data, {
    updateId: 910,
    chatId: 77,
    messageId: "11",
    kind: "message",
    count: 2,
    parts: 1,
    reason: "chat busy: turn",
  });
  const delivered = last(
    events,
    (event) => event.name === "delivered" && event.turn === "tg:77:11",
  );
  assert.deepEqual(delivered?.data, {
    updateId: 913,
    chatId: 77,
    messageId: "11",
    kind: "message",
    accepted: true,
    ms: 7,
    parts: 3,
  });
  const rejected = last(events, (event) => event.name === "rejected");
  assert.equal((rejected?.data as Record<string, unknown>).parts, 3);
  assert.equal(
    JSON.stringify([enqueued, delivered, rejected]).includes("слова-"),
    false,
  );
});

void test("вердикт гейта пишется только внутри хода", async () => {
  const before = lines(DATA, trace.traceDay()).length;

  // Вне хода журнал молчит: чистый примитив ничего не кладёт на диск.
  trace.traceInboundGate(
    "telegram",
    { blocked: false, reason: "clean", flags: [], truncatedChars: 0 },
    10,
  );
  trace.traceOutboundGate(true, [], 10, "чисто");
  assert.equal(lines(DATA, trace.traceDay()).length, before);

  // Внутри хода — с ключом хода из контекста.
  await trace.traceWithScope(
    { turn: "tg:77:5", session: "wrun_1", source: "telegram" },
    () => {
      trace.traceInboundGate(
        "telegram",
        {
          blocked: true,
          reason: "Prompt injection",
          flags: ["overrides=3"],
          truncatedChars: 4,
        },
        120,
      );
      trace.traceInboundGate(
        "web",
        {
          blocked: false,
          reason: "clean",
          flags: ["lookalikes=2"],
          truncatedChars: 0,
        },
        900,
      );
      trace.traceOutboundGate(
        false,
        [{ type: "api_key", name: "openai" }],
        55,
        "ключ: [REDACTED]",
      );
      return Promise.resolve();
    },
  );

  const events = lines(DATA, trace.traceDay());
  const inbound = last(
    events,
    (event) => event.kind === "gate" && event.name === "inbound",
  );
  const web = last(
    events,
    (event) => event.kind === "gate" && event.name === "web",
  );
  const outbound = last(
    events,
    (event) => event.kind === "gate" && event.name === "outbound",
  );
  assert.equal(inbound?.turn, "tg:77:5");
  assert.equal(inbound?.session, "wrun_1");
  assert.deepEqual(inbound?.data, {
    surface: "telegram",
    blocked: true,
    reason: "Prompt injection",
    flags: ["overrides=3"],
    truncatedChars: 4,
    chars: 120,
  });
  assert.equal(web?.source, "web");
  assert.equal(web?.turn, "tg:77:5");
  assert.deepEqual(outbound?.data, {
    clean: false,
    findings: ["api_key:openai"],
    chars: 55,
    textChars: 16,
    text: "ключ: [REDACTED]",
  });
});

void test("одна отправка — одно событие Outbox, каким бы путём она ни ушла", async () => {
  const before = lines(DATA, trace.traceDay()).length;

  const result = await trace.traceOutbox(
    { turn: "turn_3", session: "wrun_1", source: "rollup" },
    "ответ",
    () => {
      // Внутри отправки контекст хода виден — на нём держится вердикт гейта.
      trace.traceOutboundGate(true, [], 5, "ответ");
      return Promise.resolve({
        ok: true,
        delivered: 1,
        fellBack: false,
        error: "",
      });
    },
  );

  assert.deepEqual(result, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
  });
  const added = lines(DATA, trace.traceDay()).slice(before);
  assert.deepEqual(
    added.map((event) => `${String(event.kind)}.${String(event.name)}`),
    ["gate.outbound", "outbox.delivered"],
  );
  // Источник не зашит: ночной ход называется своим именем, а не «telegram».
  assert.equal(added[0].source, "rollup");
  assert.equal(added[1].source, "rollup");
  assert.equal(added[1].turn, "turn_3");
  const data = added[1].data as Record<string, unknown>;
  assert.equal(data.ok, true);
  assert.equal(data.chars, 5);
  assert.equal(typeof data.ms, "number");
  // Текст «как ушёл» лежит в событии гейта — уже после редактуры.
  assert.equal((added[0].data as Record<string, unknown>).text, "ответ");
});

void test("Стоп несёт ход и сессию из статуса чата", () => {
  trace.traceStop(
    "77:",
    { turnId: "turn_3", sessionId: "wrun_1" },
    "requested",
  );
  trace.traceStop("78:", null, "idle");

  const events = lines(DATA, trace.traceDay());
  const idle = last(events, (event) => event.name === "idle");
  const stop = last(
    events,
    (event) => event.kind === "stop" && event.name === "requested",
  );
  assert.equal(stop?.turn, "turn_3");
  assert.equal(stop?.session, "wrun_1");
  assert.deepEqual(stop?.data, { chatKey: "77:", outcome: "requested" });
  assert.equal(idle?.turn, "");
  assert.deepEqual(idle?.data, { chatKey: "78:", outcome: "idle" });
});

void test("состав контекста снимается с файлов памяти в момент старта хода", (t) => {
  const vault = mkdtempSync(join(root, "vault-"));
  mkdirSync(join(vault, "daily"), { recursive: true });
  writeFileSync(join(vault, "CORE.md"), "ядро");
  writeFileSync(join(vault, "PERSONA.md"), "персона!");
  writeFileSync(join(vault, "daily", "2026-08-17.md"), "день");
  t.after(() => rmSync(vault, { recursive: true, force: true }));

  trace.traceContextParts("turn_9", "wrun_9", vault, "2026-08-17");

  const event = last(
    lines(DATA, trace.traceDay()),
    (e) => e.kind === "context",
  );
  assert.equal(event?.name, "parts");
  assert.equal(event?.turn, "turn_9");
  assert.deepEqual(event?.data, {
    core: 8, // «ядро» в utf-8 — 8 байт
    persona: 15,
    moc: 0, // файла нет — в промпт ничего не уедет
    daily: 8,
    unit: "bytes",
    approximate: true,
  });
});

void test("строка режется по БАЙТАМ, а содержимое уходит первым", () => {
  // Кириллица стоит 2 байта на знак: по знакам это 20 000 (влезло бы), по байтам 40 000.
  const content: Record<string, string> = {};
  for (let i = 0; i < 6; i++) content[`out${i}`] = "я".repeat(2000);
  const body = Object.values(content).join("");
  // По знакам событие влезло бы в потолок, по байтам — нет. На этой разнице и ловится
  // подмена Buffer.byteLength на .length.
  assert.ok(body.length < trace.TRACE_LINE_LIMIT);
  assert.ok(Buffer.byteLength(body, "utf8") > trace.TRACE_LINE_LIMIT);
  const line = trace.traceLine(
    {
      kind: "eve",
      name: "action.result",
      turn: "turn_1",
      data: { toolName: "bash" },
      content,
    },
    { captureContent: true },
  );

  assert.ok(Buffer.byteLength(line, "utf8") <= trace.TRACE_LINE_LIMIT);
  const event = JSON.parse(line) as { data: Record<string, unknown> };
  // Имя тула и размеры содержимого пережили обрезку, само содержимое — нет.
  assert.equal(event.data.toolName, "bash");
  assert.equal(event.data.out0Chars, 2000);
  assert.equal(event.data.out5Chars, 2000);
  assert.equal(event.data.traceTrimmed, true);
  for (let i = 0; i < 6; i++) assert.equal(`out${i}` in event.data, false);
});

void test("если не влезает само data, размеры содержимого остаются", () => {
  // 30 ключей по 2000 тибетских знаков (3 байта каждый) — data одно больше потолка.
  const data: Record<string, string> = {};
  for (let i = 0; i < 30; i++) data[`k${i}`] = "\u0f00".repeat(2000);
  const line = trace.traceLine(
    {
      kind: "eve",
      name: "action.result",
      turn: "turn_1",
      data,
      content: { text: "x" },
    },
    { captureContent: false },
  );
  assert.ok(Buffer.byteLength(line, "utf8") <= trace.TRACE_LINE_LIMIT);
  const event = JSON.parse(line) as { data: Record<string, unknown> };
  // Контракт docs/trace.md: имена могут уйти, размеры содержимого — никогда.
  assert.equal(event.data.textChars, 1);
  assert.equal(event.data.traceTrimmed, true);
  assert.equal("k0" in event.data, false);
});

void test("чужие типы в data не разворачиваются поэлементно", () => {
  const line = trace.traceLine(
    {
      kind: "eve",
      name: "action.result",
      data: {
        buffer: Buffer.alloc(5_000_000),
        typed: new Uint8Array(1024),
        when: new Date("2026-08-17T10:20:30.000Z"),
        boom: new Error("provider refused"),
        map: new Map([["a", 1]]),
        set: new Set([1, 2]),
      },
    },
    { captureContent: true },
  );

  const event = JSON.parse(line) as { data: Record<string, unknown> };
  assert.deepEqual(event.data.buffer, { bytes: 5_000_000 });
  assert.deepEqual(event.data.typed, { bytes: 1024 });
  assert.equal(event.data.when, "2026-08-17T10:20:30.000Z");
  assert.equal(event.data.boom, "Error: provider refused");
  assert.deepEqual(event.data.map, [["a", 1]]);
  assert.deepEqual(event.data.set, [1, 2]);
});

void test("обрезанный по числу полей объект помечен, как и массив", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 40; i++) wide[`k${i}`] = i;
  const line = trace.traceLine(
    { kind: "eve", name: "action.result", data: { wide } },
    { captureContent: true },
  );

  const event = JSON.parse(line) as {
    data: { wide: Record<string, unknown> };
  };
  assert.equal(Object.keys(event.data.wide).length, 31); // 30 полей и пометка
  assert.equal(event.data.wide["…[keys]"], 40);
});

void test("ключ __proto__ в чужих данных остаётся полем, а не прототипом", () => {
  const line = trace.traceLine(
    {
      kind: "eve",
      name: "actions.requested",
      // Именно так поле приезжает из чужого JSON: собственный ключ "__proto__", а не
      // синтаксис литерала (тот меняет прототип и никакого поля не создаёт).
      data: {
        args: JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown,
      },
      content: { text: "…" },
    },
    { captureContent: true },
  );

  assert.equal(line.includes("__proto__"), true);
  const event = JSON.parse(line) as {
    data: { args: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(event.data.args), ["__proto__", "ok"]);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(event.data.args, "__proto__")?.value,
    { polluted: true },
  );
});

void test("протухшая метка хода не приписывает вердикт чужому ходу", () => {
  const before = lines(DATA, trace.traceDay()).length;

  trace.traceEnterScope({ turn: "tg:77:5", source: "telegram" });
  trace.traceInboundGate(
    "telegram",
    { blocked: false, reason: "clean", flags: [], truncatedChars: 0 },
    10,
  );
  const fresh = lines(DATA, trace.traceDay()).slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].turn, "tg:77:5");

  // Метка живёт в асинхронном контексте дольше самого шва: спустя TTL она уже не
  // описывает происходящее, и событие не пишется вовсе.
  const realNow = Date.now;
  Date.now = () => realNow() + trace.TRACE_SCOPE_TTL_MS + 1;
  try {
    trace.traceInboundGate(
      "telegram",
      { blocked: false, reason: "clean", flags: [], truncatedChars: 0 },
      10,
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal(lines(DATA, trace.traceDay()).length, before + 1);
});

void test("native draft stop intake uses its update id and private chat in Trace", () => {
  const before = lines(DATA, trace.traceDay()).length;
  trace.traceBridgeAdmission(
    {
      update_id: 991,
      stopped_message_generation: { chat: { id: 77 }, draft_id: 41 },
    },
    "owned",
  );
  const event = lines(DATA, trace.traceDay())
    .slice(before)
    .find((row) => row.turn === "tg:77:stop:991");
  assert.ok(event);
});
