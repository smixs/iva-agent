// Слив очереди Bridge как модель (спека L5 v2, §6; модель specs/QueueDrain.tla). Генератор
// строит последовательность шагов одного группового чата с двумя авторами: приход,
// маршрут через настоящий routeMessageUpdate в текущем режиме, снятие головы inbox
// автора, проход настоящего drainReadyQueueHeads, ход занимает и освобождает чат,
// переключение «Очередь» / «Перебивать», отказ снятия один раз, «ledger забыл id»,
// сброс /new (clearChatQueue убирает из очереди id не больше своего, а id не обязаны
// расти) и перезапуск Bridge (новые pins, inFlight и settleUntil; inbox, очередь и
// ledger eve остаются). Подделка eve ведёт ledger по update_id доставки, как
// agent/lib/telegram-acceptance.ts, и читает части тем же messageParts, что и ход.
//
// После каждого шага: (1) нет потери — каждое пришедшее сообщение лежит в inbox, в
// очереди, было в каком-то ходе или его намеренно убрал сброс; (2) дубль — только у сообщения, чью доставку оборвал
// перезапуск (пачка в закрепе, маршрут без снятия с inbox), чья прямая доставка принята
// после срока Bridge, или чей id доставки забыл ledger; (3) первые появления сообщений
// из очереди идут в порядке постановки; (4) команда, ответ, тап никогда не делят ход.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`
// и сжатый список шагов. Подставь seed и path в параметры fc.assert — прогон пройдёт
// заново байт в байт; список шагов можно вставить в runSteps отдельным тестом.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  messageParts,
  TELEGRAM_BUTTON_TAP_FIELD,
} from "#lib/telegram-parts.ts";

const root = mkdtempSync(join(tmpdir(), "iva-queue-drain-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
process.env.TELEGRAM_BOT_TOKEN ??= "1:test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42,43";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const routing = await import("./routing.ts");
const {
  createQueueItem,
  enqueueItem,
  removeQueueItems,
  TELEGRAM_QUEUE_ACK_ROLLED_BACK,
} = await import("../lib/telegram-queue.ts");
type Doc = import("../lib/telegram-queue.ts").TelegramQueueDocument;
type Update = import("../lib/telegram-queue.ts").TelegramQueueUpdate;
type QueuePhase = import("./queue.ts").QueuePhase;

const SEED = 20_261_013;
const KEY = "-100:";
const MAX_MESSAGES = 7;

type Kind = "plain" | "document" | "contact" | "command" | "reply" | "tap";
const ALONE: ReadonlySet<Kind> = new Set(["command", "reply", "tap"]);
type Outcome = "accept" | "reject" | "late";
type Author = 0 | 1;

type Step =
  | { t: "arrive"; author: Author; kind: Kind }
  | { t: "route"; author: Author; outcome: Outcome }
  | { t: "inboxAck"; author: Author }
  | { t: "promote"; author: Author; outcome: Outcome }
  | { t: "drain"; outcome: Outcome }
  | { t: "busy" }
  | { t: "free" }
  | { t: "switch" }
  | { t: "ackFail" }
  | { t: "forget"; pick: number }
  | { t: "reset"; pick: number }
  | { t: "restart" };

const AUTHOR_IDS = [42, 43] as const;

function buildUpdate(
  seq: number,
  updateId: number,
  author: Author,
  kind: Kind,
) {
  const base = {
    message_id: seq,
    date: 1,
    chat: { id: -100, type: "supergroup" },
    from: { id: AUTHOR_IDS[author], is_bot: false },
  };
  const message =
    kind === "document"
      ? { ...base, caption: `file ${seq}`, document: { file_id: `f${seq}` } }
      : kind === "contact"
        ? { ...base, contact: { first_name: "Ada", phone_number: `${seq}` } }
        : kind === "command"
          ? { ...base, text: `/x ${seq}` }
          : kind === "reply"
            ? {
                ...base,
                text: `answer ${seq}`,
                reply_to_message: {
                  message_id: 1,
                  from: { id: 999, is_bot: true },
                },
              }
            : kind === "tap"
              ? {
                  ...base,
                  text: `tap ${seq}`,
                  [TELEGRAM_BUTTON_TAP_FIELD]: true,
                }
              : { ...base, text: `m${seq}` };
  return { update_id: updateId, message } satisfies Update;
}

class Machine {
  document: Doc = { version: 1, queues: {} };
  inbox: Update[][] = [[], []];
  routed = [false, false];
  busy = false;
  generation = 0;
  policy: "queue" | "steer";
  ledger = new Set<number>();
  recordedBy = new Map<number, number[]>();
  pins = new Map<string, readonly number[]>();
  inFlight = new Map<string, QueuePhase>();
  settleUntil = new Map<string, number>();
  rotation: { afterKey: string | null } = { afterKey: null };
  arrived = 0;
  kindOf = new Map<number, Kind>();
  seqOfUpdate = new Map<number, number>();
  seen = new Set<number>();
  exposed = new Set<number>();
  discarded = new Set<number>();
  enqueuedAt = new Map<number, number>();
  enqueues = 0;
  failAck = false;
  outcome: Outcome = "accept";
  violations: string[] = [];

  private readonly updateIds: readonly number[];

  constructor(policy: "queue" | "steer", updateIds: readonly number[]) {
    this.policy = policy;
    this.updateIds = updateIds;
  }

  private seqs(update: Update): number[] {
    return messageParts(update.message ?? {}).map(
      (part) => part.message_id as number,
    );
  }

  private startTurn(seqs: number[], fromQueue: boolean) {
    for (const seq of seqs) {
      if (this.seen.has(seq) && !this.exposed.has(seq))
        this.violations.push(`message ${seq} reached a second turn`);
    }
    if (seqs.length > 1 && seqs.some((seq) => ALONE.has(this.kindOf.get(seq)!)))
      this.violations.push(`alone message merged into turn ${seqs.join(",")}`);
    if (fromQueue) {
      for (const [index, later] of seqs.entries()) {
        const laterAt = this.enqueuedAt.get(later);
        if (this.seen.has(later) || laterAt === undefined) continue;
        for (const [earlier, earlierAt] of this.enqueuedAt) {
          if (earlierAt >= laterAt || this.seen.has(earlier)) continue;
          if (this.discarded.has(earlier)) continue;
          const position = seqs.indexOf(earlier);
          if (position < 0 || position > index)
            this.violations.push(`message ${later} overtook queued ${earlier}`);
        }
      }
    }
    for (const seq of seqs) this.seen.add(seq);
  }

  // Подделка eve: ledger по update_id доставки, ход занимает чат раньше ответа.
  private deliver(fromQueue: boolean) {
    return (update: Update): Promise<boolean | "handled"> => {
      if (this.ledger.has(update.update_id)) return Promise.resolve("handled");
      if (this.outcome === "reject") return Promise.resolve(false);
      const seqs = this.seqs(update);
      this.startTurn(seqs, fromQueue);
      this.ledger.add(update.update_id);
      this.recordedBy.set(update.update_id, seqs);
      this.busy = true;
      this.generation++;
      if (this.outcome === "late") {
        if (!fromQueue) for (const seq of seqs) this.exposed.add(seq);
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    };
  }

  private status = () =>
    this.busy
      ? ({
          status: "running",
          sessionId: "s",
          generation: this.generation,
        } as const)
      : ({ status: "idle", generation: this.generation } as const);

  async step(step: Step) {
    switch (step.t) {
      case "arrive": {
        if (this.arrived >= MAX_MESSAGES) return;
        const seq = ++this.arrived;
        const updateId = this.updateIds[seq - 1];
        this.kindOf.set(seq, step.kind);
        this.seqOfUpdate.set(updateId, seq);
        this.inbox[step.author].push(
          buildUpdate(seq, updateId, step.author, step.kind),
        );
        return;
      }
      case "route": {
        const head = this.inbox[step.author][0];
        if (!head || this.routed[step.author]) return;
        this.outcome = step.outcome;
        const result = await routing.routeMessageUpdate(head, {
          chatKeyImpl: () => KEY,
          loadQueueImpl: () => Promise.resolve(this.document),
          runningImpl: () => this.busy,
          turnPolicyImpl: () => this.policy,
          inFlight: this.inFlight,
          shouldQueueImpl: () => true,
          enqueueImpl: (key, candidate) => {
            const result = enqueueItem(
              this.document,
              key,
              createQueueItem(candidate, 1),
            );
            this.document = result.document;
            const seq = this.seqOfUpdate.get(candidate.update_id)!;
            if (result.added && !this.enqueuedAt.has(seq))
              this.enqueuedAt.set(seq, ++this.enqueues);
            return Promise.resolve({
              count: result.count,
              added: result.added,
            });
          },
          acknowledgeImpl: () => Promise.resolve(),
          traceQueuedImpl: () => {},
          deliverImpl: this.deliver(false),
          statusImpl: this.status,
          setStatusIfImpl: () => null,
          sendFailureImpl: () => Promise.resolve(),
          alertImpl: () => Promise.resolve("sent" as const),
          alertResolvedImpl: () => {},
          alertDataDir: root,
          now: () => 1_000,
          logImpl: () => {},
          resetPendingImpl: () => false,
          compactingImpl: () => false,
        });
        if (result === "queued" || result === "delivered")
          this.routed[step.author] = true;
        return;
      }
      case "inboxAck":
        if (!this.routed[step.author]) return;
        this.inbox[step.author].shift();
        this.routed[step.author] = false;
        return;
      // Главный цикл: маршрут головы inbox и её снятие подряд (promoteReadyInbox).
      case "promote":
        await this.step({ ...step, t: "route" });
        await this.step({ t: "inboxAck", author: step.author });
        return;
      case "drain":
        this.outcome = step.outcome;
        await routing.drainReadyQueueHeads({
          loadImpl: () => Promise.resolve(this.document),
          runningImpl: () => this.busy,
          statusImpl: this.status,
          deliverImpl: this.deliver(true),
          acknowledgeImpl: (key, updateIds) => {
            if (this.failAck) {
              this.failAck = false;
              return Promise.reject(
                Object.assign(new Error("injected ack rollback"), {
                  code: TELEGRAM_QUEUE_ACK_ROLLED_BACK,
                }),
              );
            }
            try {
              this.document = removeQueueItems(
                this.document,
                key,
                updateIds,
              ).document;
            } catch (error) {
              this.violations.push(`batch ${updateIds.join(",")} not at head`);
              throw error;
            }
            return Promise.resolve();
          },
          settleUntil: this.settleUntil,
          inFlight: this.inFlight,
          pins: this.pins,
          rotationState: this.rotation,
          now: () => 1_000,
          resetPendingImpl: () => false,
        });
        return;
      case "busy":
        if (this.busy) return;
        this.busy = true;
        this.generation++;
        return;
      case "free":
        if (!this.busy) return;
        this.busy = false;
        this.generation++;
        return;
      case "switch":
        this.policy = this.policy === "queue" ? "steer" : "queue";
        return;
      case "ackFail":
        this.failAck = true;
        return;
      case "forget": {
        const ledger = [...this.ledger];
        if (!ledger.length) return;
        const updateId = ledger[step.pick % ledger.length];
        this.ledger.delete(updateId);
        for (const seq of this.recordedBy.get(updateId) ?? [])
          this.exposed.add(seq);
        return;
      }
      // Сброс /new между проходами: фильтр clearChatQueue (queue.ts) по update_id;
      // порог — один из id, чтобы он чаще резал очередь посередине.
      case "reset": {
        const through = this.updateIds[step.pick % MAX_MESSAGES];
        const items = this.document.queues[KEY] ?? [];
        const kept = items.filter((item) => item.updateId > through);
        for (const item of items)
          if (!kept.includes(item))
            this.discarded.add(this.seqOfUpdate.get(item.updateId)!);
        const queues = { ...this.document.queues };
        if (kept.length) queues[KEY] = kept;
        else delete queues[KEY];
        this.document = { version: 1, queues };
        return;
      }
      case "restart":
        for (const pinned of this.pins.values())
          for (const updateId of pinned)
            this.exposed.add(this.seqOfUpdate.get(updateId)!);
        for (const author of [0, 1] as const) {
          const head = this.inbox[author][0];
          if (this.routed[author] && head)
            this.exposed.add(this.seqOfUpdate.get(head.update_id)!);
        }
        this.pins = new Map();
        this.inFlight = new Map();
        this.settleUntil = new Map();
        this.rotation = { afterKey: null };
        this.routed = [false, false];
        return;
    }
  }

  check(step: Step) {
    const held = new Set<number>();
    for (const box of this.inbox)
      for (const update of box)
        held.add(this.seqOfUpdate.get(update.update_id)!);
    for (const items of Object.values(this.document.queues))
      for (const item of items) held.add(this.seqOfUpdate.get(item.updateId)!);
    for (let seq = 1; seq <= this.arrived; seq++) {
      if (!held.has(seq) && !this.seen.has(seq) && !this.discarded.has(seq))
        this.violations.push(
          `message ${seq} lost after ${JSON.stringify(step)}`,
        );
    }
  }
}

async function runSteps(
  policy: "queue" | "steer",
  updateIds: readonly number[],
  steps: readonly Step[],
): Promise<Machine> {
  const machine = new Machine(policy, updateIds);
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const step of steps) {
      await machine.step(step);
      machine.check(step);
      if (machine.violations.length) break;
    }
  } finally {
    console.log = originalLog;
  }
  return machine;
}

// Перевес одного автора и обычных сообщений: так в очереди чаще копятся пачки.
const author = fc.constantFrom<Author>(0, 0, 0, 1);
const outcome = fc.constantFrom<Outcome>(
  "accept",
  "accept",
  "accept",
  "reject",
  "late",
);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("arrive" as const),
      author,
      kind: fc.constantFrom<Kind>(
        "plain",
        "plain",
        "plain",
        "plain",
        "plain",
        "document",
        "contact",
        "command",
        "reply",
        "tap",
      ),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("promote" as const),
      author,
      outcome,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("route" as const), author, outcome }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("inboxAck" as const), author }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("drain" as const), outcome }),
  },
  { weight: 2, arbitrary: fc.constant({ t: "busy" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "free" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "switch" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "ackFail" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("forget" as const),
      pick: fc.nat({ max: 10 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("reset" as const),
      pick: fc.nat({ max: MAX_MESSAGES - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ t: "restart" as const }) },
);

// Хвост после случайных шагов: ход кончается, главный цикл продвигает inbox и сливает
// очередь, eve принимает. Так накопленное за ходом уходит пачками, а в конце каждое
// сообщение обязано побывать в ходе.
const SETTLE: readonly Step[] = Array.from({ length: 12 }, () => [
  { t: "free" as const },
  { t: "promote" as const, author: 0 as const, outcome: "accept" as const },
  { t: "promote" as const, author: 1 as const, outcome: "accept" as const },
  { t: "drain" as const, outcome: "accept" as const },
]).flat();

// update_id Telegram уникален, но не обязан расти: скачки и убывание в случайном порядке.
const updateIds = fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
  minLength: MAX_MESSAGES,
  maxLength: MAX_MESSAGES,
});

await test("property: the queue drain never loses a message, duplicates only after a break, keeps order and alone stays alone", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<"queue" | "steer">("queue", "steer"),
      updateIds,
      fc.array(step, { minLength: 10, maxLength: 60, size: "max" }),
      async (policy, ids, steps) => {
        const machine = await runSteps(policy, ids, [...steps, ...SETTLE]);
        assert.deepEqual(machine.violations, []);
        assert.equal(
          new Set([...machine.seen, ...machine.discarded]).size,
          machine.arrived,
          "everything reached a turn or was discarded by a reset",
        );
      },
    ),
    { seed: SEED, numRuns: 600 },
  );
});

// Контрпример F1 из модели (QueueDrain-switch.cfg): у автора в очереди 1 и 2, Bridge
// перезапускается между маршрутом 2 и снятием 2 с inbox, владелец включает
// «Перебивать». Без R1 сообщение 2 ушло бы прямой доставкой в ledger, пачка 1+2 с id 2
// получила бы handled, и 1 пропало бы. С R1 2 встаёт за 1.
await test("a restart between the route and the inbox removal, then steer, keeps every message", async () => {
  const machine = await runSteps(
    "queue",
    [501, 502, 503, 504, 505, 506, 507],
    [
      { t: "arrive", author: 0, kind: "plain" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "busy" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "route", author: 0, outcome: "accept" },
      { t: "restart" },
      { t: "switch" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "free" },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual([...machine.seen].sort(), [1, 2]);
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});

await test("switching to steer while messages wait keeps the new message behind them", async () => {
  const machine = await runSteps(
    "queue",
    [9, 3, 7, 1, 5, 2, 4],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "switch" },
      { t: "free" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "inboxAck", author: 0 },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual(machine.recordedBy.get(3), [1, 2], "one turn for both");
});

// Сброс /new режет закреплённую пачку: id не обязаны расти, и фильтр clearChatQueue
// уносит из пачки 1000+5 только 5. Остаток 1000 уже был в ходе с id 5 и обязан уйти
// под тем же id: ledger отвечает handled, второго хода с 1000 нет.
await test("a reset that cuts a pinned batch does not start a second turn with its rest", async () => {
  const machine = await runSteps(
    "queue",
    [1000, 5, 7, 8, 9, 10, 11],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "free" },
      { t: "ackFail" },
      { t: "drain", outcome: "accept" },
      { t: "reset", pick: 1 },
      { t: "free" },
      { t: "drain", outcome: "accept" },
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual(machine.recordedBy.get(5), [1, 2], "one turn for both");
  assert.equal(machine.recordedBy.size, 1);
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});

// Сброс унёс последний id закрепа, а маршрут из inbox после перезапуска вернул его в
// хвост за чужим сообщением. Снятие берёт только голову, иначе пачка «не с головы» и
// чат встаёт; сам возвращённый id получает handled — он уже был в ходе.
await test("a reset id that comes back behind another author's message does not block the chat", async () => {
  const machine = await runSteps(
    "queue",
    [453256, 2, 3, 4, 5, 6, 7],
    [
      { t: "busy" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "promote", author: 0, outcome: "accept" },
      { t: "arrive", author: 0, kind: "plain" },
      { t: "route", author: 0, outcome: "accept" },
      { t: "restart" },
      { t: "free" },
      { t: "ackFail" },
      { t: "drain", outcome: "accept" },
      { t: "reset", pick: 1 },
      { t: "arrive", author: 1, kind: "plain" },
      { t: "promote", author: 1, outcome: "accept" },
      { t: "promote", author: 0, outcome: "accept" },
      ...SETTLE,
    ],
  );
  assert.deepEqual(machine.violations, []);
  assert.deepEqual([...machine.seen].sort(), [1, 2, 3]);
  assert.equal(machine.recordedBy.get(453256), undefined, "no turn under 1");
  assert.deepEqual(machine.document, { version: 1, queues: {} });
});
