/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства тика Watch на последовательностях (спека проактивности, раздел 6): произвольные
// приходы, прочтения, ошибки источника, тики с опозданием 0–90 с и ответы модели. Сид
// печатается в имени теста и повторяется через FC_SEED=<сид>.
//   (а) ключ попадает в ход не больше одного раза между ростами `unread`;
//   (б) подъёмов с сообщением от обычных пунктов за день ≤ watchCapPerDay;
//   (в) ходов Watch без сбоев за день ≤ modelWakesPerDay;
//   (г) в тихие часы ход только при срочном отправителе;
//   (д) обычный пункт, отфильтрованный тихими часами или пределом, не помечен `reported` и
//       приходит позже.
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";

const ROOT = mkdtempSync(join(tmpdir(), "iva-proactive-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { PROACTIVE_DEFAULTS, isQuietHour } =
  await import("#lib/proactive-config.ts");
const { runProactiveTick } = await import("./tick.ts");
import type { ProactiveConfig } from "#lib/proactive-config.ts";
import type { WatchItem } from "./precheck.ts";
import type { ProactiveState } from "./state.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 9, 5, 0, 0);
const KEYS = ["tg:1", "tg:2", "tg:3"] as const;
const URGENT = "tg:3";

type Step =
  | { readonly kind: "arrive"; readonly key: number }
  | { readonly kind: "readAll"; readonly key: number }
  | { readonly kind: "readSome"; readonly key: number }
  | { readonly kind: "error"; readonly on: boolean }
  | {
      readonly kind: "tick";
      readonly jitterMs: number;
      readonly quiet: boolean;
    };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("arrive" as const), key: fc.nat(2) }),
  fc.record({ kind: fc.constant("readAll" as const), key: fc.nat(2) }),
  fc.record({ kind: fc.constant("readSome" as const), key: fc.nat(2) }),
  fc.record({ kind: fc.constant("error" as const), on: fc.boolean() }),
  fc.record({
    kind: fc.constant("tick" as const),
    jitterMs: fc.integer({ min: 0, max: 90_000 }),
    quiet: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("tick" as const),
    jitterMs: fc.integer({ min: 0, max: 90_000 }),
    quiet: fc.boolean(),
  }),
);

const config: fc.Arbitrary<ProactiveConfig> = fc.record({
  enabled: fc.constant(true),
  // Почта — в ветке gmail, как у установки без ключа: шум почты проверяют свои тесты.
  mailProvider: fc.constant("gmail"),
  quietFromHour: fc.integer({ min: 0, max: 23 }),
  quietToHour: fc.integer({ min: 0, max: 23 }),
  staleMinutes: fc.constantFrom(0, 30, 60, 120),
  watchCapPerDay: fc.integer({ min: 0, max: 3 }),
  modelWakesPerDay: fc.integer({ min: 0, max: 4 }),
  ceilingTokensPerDay: fc.constant(0),
  briefTimes: fc.constant(PROACTIVE_DEFAULTS.briefTimes),
  insightTimes: fc.constant([]),
  urgentSenders: fc.constant(["wife"]),
});

/** Мир одной последовательности: источник, ход и наблюдения за ходами. */
class World {
  readonly unread = [0, 0, 0];
  readonly gen = [0, 0, 0];
  error = false;
  hour = 0;
  quietReply = false;
  readonly statePath: string;
  /** Ходы: час, день, ключи с поколением, ушло ли сообщение. */
  readonly turns: Array<{
    readonly at: number;
    readonly keys: Array<{ key: string; gen: number }>;
    sent: boolean;
  }> = [];

  readonly cfg: ProactiveConfig;

  constructor(cfg: ProactiveConfig) {
    this.cfg = cfg;
    this.statePath = join(mkdtempSync(join(ROOT, "w-")), "proactive.json");
  }

  items(): WatchItem[] {
    return KEYS.flatMap((key, i) =>
      (this.unread[i] ?? 0) > 0
        ? [
            {
              key,
              unread: this.unread[i] ?? 0,
              from: { name: key === URGENT ? "Wife" : `Чат ${i}` },
            },
          ]
        : [],
    );
  }

  state(): ProactiveState | null {
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as ProactiveState;
    } catch {
      return null;
    }
  }

  async tick(jitterMs: number): Promise<void> {
    const at = START + this.hour * HOUR;
    this.hour++;
    const before = this.state();
    const now = Math.floor((at + jitterMs) / MIN) * MIN;
    let current: (typeof this.turns)[number] | undefined;
    const code = await runProactiveTick(now, {
      config: () => this.cfg,
      timeZone: "UTC",
      statePath: this.statePath,
      sources: [
        {
          name: "telegram",
          prefix: "tg:",
          check: () =>
            Promise.resolve(
              this.error
                ? { items: [], error: "ECONNREFUSED" }
                : { items: this.items(), error: null },
            ),
        },
      ],
      runTurn: (prompt) => {
        // Ход Brief или Insight — не ход Watch: в счётчики Watch не идёт (их свойства —
        // brief.test.ts и insight.test.ts).
        if (prompt.startsWith("Brief:") || prompt.startsWith("Insight:"))
          return Promise.resolve({
            status: "completed" as const,
            message: "QUIET",
            feedback: () => Promise.resolve(),
          });
        const keys = KEYS.flatMap((key, i) =>
          prompt.includes(`- ${key} `) ? [{ key, gen: this.gen[i] ?? 0 }] : [],
        );
        current = { at, keys, sent: false };
        this.turns.push(current);
        return Promise.resolve({
          status: "completed" as const,
          message: this.quietReply ? "QUIET" : "Сообщение",
          feedback: () => Promise.resolve(),
        });
      },
      send: (_part, source) => {
        if (current && source === "watch") current.sent = true;
        return Promise.resolve({ ok: true, error: "" });
      },
      translate: () =>
        Promise.resolve((_english: string, russian: string) => russian),
      log: () => undefined,
    });
    assert.equal(code, 0);
    // (д), первая половина: пункт, не попавший в ход, не помечен `reported` этим прогоном.
    const after = this.state();
    for (const key of KEYS) {
      const was = before?.seen[key];
      const now2 = after?.seen[key];
      if (
        was &&
        was.reported === false &&
        now2 &&
        !current?.keys.some((k) => k.key === key)
      )
        assert.equal(
          now2.reported,
          false,
          `${key} was not in the turn but became reported`,
        );
    }
  }

  apply(s: Step): Promise<void> | undefined {
    const i = "key" in s ? s.key : 0;
    if (s.kind === "arrive") {
      this.unread[i] = (this.unread[i] ?? 0) + 1;
      this.gen[i] = (this.gen[i] ?? 0) + 1;
    } else if (s.kind === "readAll") this.unread[i] = 0;
    else if (s.kind === "readSome" && (this.unread[i] ?? 0) > 1)
      this.unread[i] = (this.unread[i] ?? 0) - 1;
    else if (s.kind === "error") this.error = s.on;
    else if (s.kind === "tick") {
      this.quietReply = s.quiet;
      return this.tick(s.jitterMs);
    }
    return undefined;
  }
}

const dayOf = (at: number) => Math.floor((at - START) / DAY);
const hourOf = (at: number) => new Date(at).getUTCHours();

async function assertEventuallyReported(world: World): Promise<void> {
  const cfg = world.cfg;
  if (cfg.watchCapPerDay === 0 || cfg.modelWakesPerDay === 0) return;
  world.error = false;
  const pending = world.state()?.seen ?? {};
  const waiting = KEYS.filter(
    (key, i) => pending[key]?.reported === false && (world.unread[i] ?? 0) > 0,
  );
  if (waiting.length === 0) return;
  const remaining = new Set<string>(waiting);
  world.quietReply = false;
  // state.ts:countToday и Proactive.tla:NewDay обновляют пределы по дням.
  // После последнего прихода каждый ключ (Keys модели) требует максимум один ход.
  // Сначала ждём staleMinutes и обновление уже потраченного дня; затем даём по
  // суточной ёмкости min(Cap, modelWakesPerDay) на все непрочитанные ключи. Тихие
  // часы берём из того же isQuietHour, что admit; в TLA+ это фильтр Precheck.
  // Это конечная граница данной последовательности, а не срок доставки любой истории.
  const dailyCapacity = Math.min(cfg.watchCapPerDay, cfg.modelWakesPerDay);
  const deliveryDays = Math.ceil(world.items().length / dailyCapacity);
  const quietHours = Array.from(
    { length: DAY / HOUR },
    (_, hour) => hour,
  ).filter((hour) => isQuietHour(cfg, hour)).length;
  const stopAt =
    START +
    world.hour * HOUR +
    cfg.staleMinutes * MIN +
    (1 + deliveryDays) * DAY +
    quietHours * HOUR;
  while (START + world.hour * HOUR <= stopAt) {
    const from = world.turns.length;
    await world.tick(0);
    for (const turn of world.turns.slice(from))
      for (const { key } of turn.keys) remaining.delete(key);
    if (remaining.size === 0) break;
  }
  assert.equal(
    remaining.size,
    0,
    `${[...remaining].join(", ")} was held back and never came`,
  );
}

test("Watch delivers the held-back item from seed 890724119 (anchor)", async () => {
  const world = new World({
    ...PROACTIVE_DEFAULTS,
    quietFromHour: 0,
    quietToHour: 2,
    staleMinutes: 0,
    watchCapPerDay: 1,
    modelWakesPerDay: 1,
    urgentSenders: ["wife"],
  });
  const steps: readonly Step[] = [
    { kind: "arrive", key: 2 },
    { kind: "error", on: true },
    { kind: "tick", jitterMs: 0, quiet: false },
    { kind: "arrive", key: 1 },
    { kind: "arrive", key: 0 },
    { kind: "readAll", key: 0 },
    { kind: "error", on: false },
    { kind: "tick", jitterMs: 0, quiet: false },
    { kind: "arrive", key: 2 },
  ];
  for (const step of steps) await world.apply(step);
  assert.equal(world.state()?.seen["tg:2"]?.reported, false);
  await assertEventuallyReported(world);
  const ordinary = world.turns.filter((turn) =>
    turn.keys.some(({ key }) => key === "tg:2"),
  );
  assert.equal(ordinary.length, 1);
  const urgentDays = Math.ceil(
    (world.gen[KEYS.indexOf(URGENT)] ?? 0) / world.cfg.modelWakesPerDay,
  );
  assert.equal(
    ordinary[0]?.at,
    START + urgentDays * DAY + world.cfg.quietToHour * HOUR,
  );
  assert.equal(ordinary[0]?.sent, true);
});

test(`Watch keeps its promises on any sequence of arrivals, reads, errors and ticks (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      config,
      fc.array(step, { minLength: 5, maxLength: 60 }),
      async (cfg, steps) => {
        const world = new World(cfg);
        for (const s of steps) await world.apply(s);

        // (а) одно поколение ключа — не больше одного хода.
        const taken = new Set<string>();
        for (const turn of world.turns)
          for (const { key, gen } of turn.keys) {
            assert.ok(
              !taken.has(`${key}#${gen}`),
              `${key} went to two turns at growth ${gen}`,
            );
            taken.add(`${key}#${gen}`);
          }
        const perDay = new Map<number, { wakes: number; turns: number }>();
        for (const turn of world.turns) {
          const day = perDay.get(dayOf(turn.at)) ?? { wakes: 0, turns: 0 };
          day.turns++;
          if (turn.sent && turn.keys.some((k) => k.key !== URGENT)) day.wakes++;
          perDay.set(dayOf(turn.at), day);
          // (г) в тихие часы — только срочный отправитель.
          if (isQuietHour(cfg, hourOf(turn.at)))
            assert.ok(
              turn.keys.every((k) => k.key === URGENT),
              "a quiet-hour turn with an ordinary item",
            );
        }
        for (const { wakes, turns } of perDay.values()) {
          assert.ok(
            wakes <= cfg.watchCapPerDay,
            "(б) wakes over watchCapPerDay",
          ); // (б)
          assert.ok(
            turns <= cfg.modelWakesPerDay,
            "(в) turns over modelWakesPerDay",
          ); // (в)
        }

        // (д), вторая половина: после прекращения приходов и ошибок пункт приходит позже.
        await assertEventuallyReported(world);
      },
    ),
    { seed: SEED, numRuns: 100 },
  );
});
