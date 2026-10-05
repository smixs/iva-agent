/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations; request doubles keep the async boundary. */
// Свёртка между ходами: когда канал просит eve пересказать историю и когда перестаёт.
//
// КАК ВОСПРОИЗВЕСТИ: при провале fast-check печатает seed и path; передать их вторым
// аргументом fc.assert(prop, { seed, path }), прогон повторится байт в байт.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  compactionThresholdPercent,
  IDLE_COMPACTION_MAX_TOKENS,
  IDLE_COMPACTION_PERCENT,
  idleCompactionLimit,
} from "./compaction.ts";
import * as idle from "./idle-compaction.ts";

const WINDOW = 100_000;
const LIMIT = idleCompactionLimit(WINDOW);
let seq = 0;
const fresh = () => `s-${++seq}`;

/** Один ход: turn.started → шаги → turn.completed. */
function turn(
  sessionId: string,
  steps: readonly (number | null)[],
  inTurnCompaction = false,
) {
  idle.openIdleCompactionTurn(sessionId);
  for (const tokens of steps) idle.recordStepInput(sessionId, tokens);
  // Страховка eve внутри хода шлёт то же compaction.completed.
  if (inTurnCompaction) idle.completeIdleCompaction(sessionId);
  idle.closeIdleCompactionTurn(sessionId, WINDOW);
}

type Outcome = "accepted" | "gone" | "throws";
/** session.waiting: что сделал канал. */
async function waiting(
  sessionId: string,
  {
    outcome = "accepted",
    chatFree = true,
  }: { outcome?: Outcome; chatFree?: boolean } = {},
) {
  const seen = { claimed: false, asked: false, released: false };
  const accepted = await idle.startIdleCompaction({
    sessionId,
    claimImpl: () => {
      seen.claimed = true;
      return chatFree;
    },
    requestImpl: async () => {
      seen.asked = true;
      if (outcome === "throws") throw new Error("route is down");
      return outcome === "accepted";
    },
    releaseImpl: async () => {
      seen.released = true;
    },
    logImpl: () => {},
  });
  return { ...seen, accepted };
}
const NOTHING = {
  claimed: false,
  asked: false,
  released: false,
  accepted: false,
};
const ASKED = { claimed: true, asked: true, released: false, accepted: true };

test("порог — 60 % окна, но не больше 275 тыс. токенов; страховка внутри хода на четверть выше", () => {
  assert.equal(IDLE_COMPACTION_PERCENT, 0.6);
  assert.equal(IDLE_COMPACTION_MAX_TOKENS, 275_000);
  assert.equal(idleCompactionLimit(100_000), 60_000);
  assert.equal(idleCompactionLimit(131_072), 78_643);
  assert.equal(idleCompactionLimit(272_000), 163_200);
  assert.equal(idleCompactionLimit(1_000_000), 275_000);
  assert.equal(compactionThresholdPercent(100_000), 0.75);
  assert.equal(compactionThresholdPercent(1_000_000), 0.34375);
  fc.assert(
    fc.property(fc.integer({ min: 1_000, max: 5_000_000 }), (window) => {
      const limit = idleCompactionLimit(window);
      const inTurn = compactionThresholdPercent(window) * window;
      assert.ok(limit <= IDLE_COMPACTION_MAX_TOKENS && limit <= window * 0.6);
      assert.ok(inTurn > limit, "страховка выше свёртки между ходами");
      assert.ok(inTurn <= window * 0.75 + 1e-6, "и оставляет запас до окна");
    }),
  );
});

test("ход под порогом ничего не просит, ход на пороге занимает чат и просит пересказ", async () => {
  const id = fresh();
  turn(id, [LIMIT - 1]);
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("решает вход последнего шага хода, а не первого", async () => {
  const low = fresh();
  turn(low, [LIMIT + 5, LIMIT - 1]);
  assert.deepEqual(await waiting(low), NOTHING);
  const high = fresh();
  turn(high, [10, LIMIT]);
  assert.deepEqual(await waiting(high), ASKED);
});

test("неизвестный вход последнего шага и сессия без turn.started пересказ не просят", async () => {
  const unknown = fresh();
  turn(unknown, [LIMIT, null]);
  assert.deepEqual(await waiting(unknown), NOTHING);
  const background = fresh();
  idle.recordStepInput(background, LIMIT * 2);
  idle.closeIdleCompactionTurn(background, WINDOW);
  assert.deepEqual(await waiting(background), NOTHING);
});

test("на один законченный ход одна просьба: второй session.waiting (конец пересказа) молчит", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
  assert.deepEqual(await waiting(id), NOTHING);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("чат уже занят (успело прийти сообщение): просьбы нет, и этот ход её больше не повторяет", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id, { chatFree: false }), {
    ...NOTHING,
    claimed: true,
  });
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id), ASKED, "следующий ход решает заново");
});

test("начавшийся ход снимает решение прошлого хода", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  idle.openIdleCompactionTurn(id);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("законченный пересказ, после которого первый шаг всё ещё на пороге, выключает свёртку до конца сессии", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT, LIMIT + 10]);
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT * 2]);
  assert.deepEqual(await waiting(id), NOTHING, "и дальше молчит");
});

test("пересказ помог: первый шаг под порогом, следующий перебор сворачивает снова", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT - 100, LIMIT + 1]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("оборванный пересказ (нет compaction.completed) ничего не выключает", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.endIdleCompaction(id); // парковка сняла запись оборванного пересказа
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("пересказ страховки внутри хода — не наш: оборванная свёртка плюс страховка не выключают", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id); // просьба принята, но пересказ оборвало сообщение
  idle.endIdleCompaction(id);
  turn(id, [LIMIT, LIMIT + 1], true); // в этом ходе сработала страховка eve
  assert.deepEqual(await waiting(id), ASKED, "свёртка между ходами жива");
});

test("eve отказала: чат освобождён, следующий ход просит снова", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id, { outcome: "gone" }), {
    claimed: true,
    asked: true,
    released: true,
    accepted: false,
  });
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), ASKED, "отказ не считается пересказом");
});

test("ответа eve нет: исход неизвестен — чат не освобождаем (его снимет парковка или срок), наружу ничего не летит", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.deepEqual(await waiting(id, { outcome: "throws" }), {
    claimed: true,
    asked: true,
    released: false,
    accepted: false,
  });
  assert.deepEqual(
    await waiting(id),
    NOTHING,
    "второй просьбы на этот ход нет",
  );
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(
    await waiting(id),
    NOTHING,
    "просьба ещё может быть у eve: следующую не шлём",
  );
  idle.endIdleCompaction(id); // парковка сняла запись: пересказ (если был) кончился
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), ASKED, "неизвестный исход не выключает");
});

test("compaction.completed раньше ответа роута всё равно свой: бесполезный пересказ выключает свёртку", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.equal(
    await idle.startIdleCompaction({
      sessionId: id,
      claimImpl: () => true,
      requestImpl: async () => {
        idle.completeIdleCompaction(id); // eve успела пересказать до разбора ответа
        return true;
      },
      releaseImpl: () => {},
      logImpl: () => {},
    }),
    true,
  );
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("исход неизвестен, а eve пересказала: завершение засчитано, бесполезный пересказ выключает свёртку", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id, { outcome: "throws" });
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), NOTHING);
});

test("отказ eve завершением не считается, даже если следом пришло чужое compaction.completed", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id, { outcome: "gone" });
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(await waiting(id), ASKED);
});

test("первый шаг без названного входа: о пользе пересказа судит первый известный вход хода", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id);
  turn(id, [null, LIMIT + 1]);
  assert.deepEqual(await waiting(id), NOTHING, "пересказ не помог — выключено");
});

test("упавший или отменённый ход пересказа не просит и чужой пересказ своим не делает", async () => {
  const id = fresh();
  idle.openIdleCompactionTurn(id);
  idle.recordStepInput(id, LIMIT * 2);
  idle.dropIdleCompactionTurn(id);
  assert.deepEqual(await waiting(id), NOTHING);
  turn(id, [LIMIT]);
  assert.deepEqual(
    await waiting(id),
    ASKED,
    "следующий законченный ход решает сам",
  );
});

test("упавший ход после полезного пересказа не переносит замер на следующий ход: свёртка не выключается", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  await waiting(id);
  idle.completeIdleCompaction(id); // пересказ помог: вход упал
  idle.endIdleCompaction(id);
  idle.openIdleCompactionTurn(id);
  idle.recordStepInput(id, LIMIT - 500);
  idle.dropIdleCompactionTurn(id); // ход упал
  turn(id, [LIMIT, LIMIT + 1]); // история выросла за два хода
  assert.deepEqual(await waiting(id), ASKED, "свёртка между ходами жива");
});

test("начало пересказа занимает чат ещё раз: запоздалая просьба не оставляет пересказ без записи", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  let claims = 0;
  const claimImpl = () => {
    claims += 1;
    return true;
  };
  // Ответа нет: исход неизвестен, eve тем временем провела ход по пришедшему сообщению.
  await idle.startIdleCompaction({
    sessionId: id,
    claimImpl,
    requestImpl: async () => {
      throw new Error("timeout");
    },
    releaseImpl: () => {},
    logImpl: () => {},
  });
  assert.equal(claims, 1);
  turn(id, [LIMIT, LIMIT]);
  assert.deepEqual(
    await waiting(id),
    NOTHING,
    "прошлая просьба ещё может быть у eve: вторую не шлём",
  );
  // eve всё-таки приняла просьбу и начинает пересказ после этого хода.
  await idle.beginIdleCompaction(id);
  assert.equal(claims, 2, "чат занят заново");
  await idle.beginIdleCompaction(id);
  assert.equal(claims, 2, "один раз на просьбу");
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT - 1, LIMIT]);
  assert.deepEqual(
    await waiting(id),
    ASKED,
    "после пересказа свёртка снова доступна",
  );
});

test("запоздалый пересказ после промежуточного хода остаётся своим: бесполезный выключает свёртку", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  assert.equal((await waiting(id, { outcome: "throws" })).asked, true);
  turn(id, [LIMIT, LIMIT]); // ход по пришедшему сообщению закрыл замер
  await idle.beginIdleCompaction(id, () => {}); // eve начала принятый пересказ
  idle.completeIdleCompaction(id);
  turn(id, [LIMIT, LIMIT]); // первый шаг всё ещё на пороге
  assert.deepEqual(await waiting(id), NOTHING, "второй платной просьбы нет");
});

test("счёт идущего хода, решения и открытой просьбы не вытесняется другими сессиями", async () => {
  const due = fresh();
  turn(due, [LIMIT]); // решение ждёт парковки
  const pending = fresh();
  turn(pending, [LIMIT]);
  let claims = 0;
  await idle.startIdleCompaction({
    sessionId: pending,
    claimImpl: () => {
      claims += 1;
      return true;
    },
    requestImpl: async () => {
      throw new Error("timeout");
    },
    releaseImpl: () => {},
    logImpl: () => {},
  });
  const open = fresh();
  idle.openIdleCompactionTurn(open);
  idle.recordStepInput(open, LIMIT);
  for (let other = 0; other < 250; other++) turn(fresh(), [1]);
  assert.deepEqual(await waiting(due), ASKED, "решение цело");
  await idle.beginIdleCompaction(pending, () => {});
  assert.equal(claims, 2, "запоздалая просьба занимает чат");
  idle.closeIdleCompactionTurn(open, WINDOW);
  assert.deepEqual(await waiting(open), ASKED, "идущий ход цел");
});

test("просьба без ответа, о которой eve так и не объявила, через полчаса забыта: свёртка снова доступна", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  let clock = 1_000_000;
  const ask = (requestImpl: () => Promise<boolean>) =>
    idle.startIdleCompaction({
      sessionId: id,
      claimImpl: () => true,
      requestImpl,
      releaseImpl: () => {},
      now: () => clock,
      logImpl: () => {},
    });
  await ask(async () => {
    throw new Error("timeout");
  });
  turn(id, [LIMIT, LIMIT]);
  clock += idle.ASK_FORGOTTEN_MS - 1;
  assert.equal(await ask(async () => true), false);
  turn(id, [LIMIT, LIMIT]);
  clock += 1;
  assert.equal(await ask(async () => true), true);
});

test("начало пересказа внутри хода и без нашей просьбы чат не занимает и наружу не бросает", async () => {
  const id = fresh();
  let claims = 0;
  await idle.beginIdleCompaction(id);
  turn(id, [LIMIT]);
  await idle.startIdleCompaction({
    sessionId: id,
    claimImpl: () => {
      claims += 1;
      if (claims > 1) throw new Error("run-status lock timeout");
      return true;
    },
    requestImpl: async () => true,
    releaseImpl: () => {},
    logImpl: () => {},
  });
  idle.openIdleCompactionTurn(id);
  await idle.beginIdleCompaction(id); // страховка eve внутри хода
  assert.equal(claims, 1);
  idle.closeIdleCompactionTurn(id, WINDOW);
  await idle.beginIdleCompaction(id, () => {}); // между ходами: занять, сбой проглочен
  assert.equal(claims, 2);
});

test("сбой занятия и сбой освобождения чата наружу не летят", async () => {
  const id = fresh();
  turn(id, [LIMIT]);
  const boom = () => {
    throw new Error("run-status lock timeout");
  };
  let asked = false;
  assert.equal(
    await idle.startIdleCompaction({
      sessionId: id,
      claimImpl: boom,
      requestImpl: async () => (asked = true),
      releaseImpl: async () => {},
      logImpl: () => {},
    }),
    false,
  );
  assert.equal(asked, false, "чат не занят — просьбы нет");
  turn(id, [LIMIT]);
  assert.equal(
    await idle.startIdleCompaction({
      sessionId: id,
      claimImpl: () => true,
      requestImpl: async () => false,
      releaseImpl: async () => boom(),
      logImpl: () => {},
    }),
    false,
  );
});

type Step = {
  first: number | null;
  last: number | null;
  inTurn: boolean;
  chatFree: boolean;
  outcome: Outcome;
  completes: boolean;
};
const tokens = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 0, max: WINDOW * 2 }),
  fc.constantFrom(LIMIT - 1, LIMIT, LIMIT + 1),
);
const stepArb: fc.Arbitrary<Step> = fc.record({
  first: tokens,
  last: tokens,
  inTurn: fc.boolean(),
  chatFree: fc.boolean(),
  outcome: fc.constantFrom<Outcome>("accepted", "gone", "throws"),
  completes: fc.boolean(),
});

test("property: просьба уходит только за порогом и в свободный чат, раз на ход, и после бесполезного пересказа не повторяется", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { maxLength: 30 }), async (script) => {
      const id = fresh();
      let off = false;
      let asked = false;
      let compacted = false;
      for (const step of script) {
        const firstKnown = step.first ?? step.last;
        if (asked) {
          if (compacted && firstKnown !== null && firstKnown >= LIMIT)
            off = true;
          asked = false;
          compacted = false;
        }
        turn(id, [step.first, step.last], step.inTurn);
        const due: boolean = !off && step.last !== null && step.last >= LIMIT;
        const result = await waiting(id, step);
        assert.equal(result.claimed, due);
        assert.equal(result.asked, due && step.chatFree);
        const accepted: boolean =
          due && step.chatFree && step.outcome === "accepted";
        assert.equal(result.accepted, accepted);
        assert.equal(
          result.released,
          due && step.chatFree && step.outcome === "gone",
        );
        assert.deepEqual(await waiting(id, step), NOTHING, "вторая парковка");
        // Просьба считается ушедшей и при неизвестном исходе: eve могла её принять.
        if (due && step.chatFree && step.outcome !== "gone") {
          asked = true;
          if (step.completes) {
            idle.completeIdleCompaction(id);
            compacted = true;
          }
          idle.endIdleCompaction(id); // парковка после пересказа
        }
      }
    }),
  );
});
