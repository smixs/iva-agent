// PBT-MUSE-4: движок /menu под криворуким пользователем. Мусорные callback_data,
// протухшие кнопки, двойные тапы: движок обязан не кидать, не отдавать тап в eve
// (возвращать true) и не создавать мёртвых состояний молча.
//
// SEED: свойства ниже детерминированы, кроме property (seed в вызове);
// воспроизведение — сам файл.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { TelegramFlowState } from "../tg-flow.ts";
import { createMenu } from "./index.ts";

const SEED = 20260401;

type Call = { method: string; params: Record<string, unknown> };
type State = TelegramFlowState;

const STUB_SCREENS = {
  // texts.k — экран владеет тем же kind, что ждёт живое меню: только такое ожидание
  // усыновление забирает с собой (чужой kind обрабатывать нечем).
  srch: {
    render: () => Promise.resolve({ text: "stub" }),
    texts: { k: () => Promise.resolve() },
  },
};

function rig(screens?: Record<string, unknown>) {
  const calls: Call[] = [];
  const delivered: unknown[] = [];
  const states = new Map<string, State>();
  const tg = (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return Promise.resolve({ ok: true, result: { message_id: 9 } });
  };
  const flows = {
    get: (chatId: string | number, userId: string | number) =>
      states.get(`${String(chatId)}:${String(userId)}`) ?? null,
    start: (
      chatId: string | number,
      userId: string | number,
      flow: string,
      extra: Record<string, unknown> = {},
    ) => {
      const st: State = {
        flow,
        chatId,
        userId,
        createdAt: Date.now(),
        msgId: null,
        provider: null,
        modelOptions: null,
        model: null,
        efforts: null,
        effort: null,
        step: null,
        awaitText: null,
        screen: null,
        page: 0,
        data: {},
        ...extra,
      };
      states.set(`${String(chatId)}:${String(userId)}`, st);
      return st;
    },
    touch: () => {},
    screen: (_st: unknown, text: string) => {
      calls.push({ method: "flows.screen", params: { text } });
      return Promise.resolve();
    },
    end: (st: State, text: string) => {
      calls.push({ method: "flows.end", params: { text } });
      states.delete(`${String(st.chatId)}:${String(st.userId)}`);
      return Promise.resolve();
    },
  };
  const deps = {
    allowed: new Set(["111"]),
    deliver: (update: unknown) => {
      delivered.push(update);
    },
    admitSynthetic: () => false,
    handleModelCmd: () => {},
    handleThinkCmd: () => {},
    reply: () => {},
  };
  const menu = createMenu({
    flows,
    tg,
    deps,
    ...(screens ? { screens } : {}),
  });
  const tap = (data: unknown, overrides: Record<string, unknown> = {}) =>
    menu.onCallback(
      {
        id: "cb1",
        data,
        from: { id: 111 },
        message: {
          message_id: 7,
          chat: { id: 11, type: "private" },
        },
        ...overrides,
      } as never,
      4242,
    );
  return { calls, delivered, states, menu, tap };
}

// F-MENU: тап по мёртвому экрану отвечает «устарело» тостом и перерисовывает
// корень (а не усыновляет мёртвое состояние молча); data-тап по неизвестному sid —
// тост «устарело» и корень, даже на свежем состоянии; усыновление не теряет
// живой awaitText (иначе следующий секрет ушёл бы мимо перехвата).
await test("F-MENU: мёртвый экран — тост «устарело» и живой корень", async () => {
  const { calls, states, tap } = rig();
  try {
    const first = await tap("iva_menu:zzz:o");
    assert.equal(first, true);
    const ack = calls.find((call) => call.method === "answerCallbackQuery");
    assert.ok(ack, "спиннер погашен");
    const toast: unknown = (ack.params as { text?: unknown }).text;
    assert.ok(typeof toast === "string", "тост — строка");
    assert.match(toast, /устарело|expired/i, "тост говорит про устарело");
    const st = states.get("11:111");
    assert.ok(st, "состояние создано");
    assert.equal(st.screen, "r", "усыновлён корень, а не мусор");
    assert.ok(
      calls.some((call) => call.method === "flows.screen"),
      "корень перерисован",
    );
    // Второй тап — data-верб по неизвестному sid в СВЕЖЕЕ сообщение: тост «устарело»,
    // рабочий корень с клавиатурой и снятое ожидание ввода. Правка без клавиатуры
    // оставляла живое меню без кнопок и с заряженным ожиданием, которому в мёртвом
    // экране нет обработчика.
    calls.length = 0;
    st.awaitText = { kind: "k", secret: true };
    const second = await tap("iva_menu:zzz:set:x");
    assert.equal(second, true);
    const ack2 = calls.find((call) => call.method === "answerCallbackQuery");
    assert.ok(ack2, "спиннер погашен");
    const toast2: unknown = (ack2.params as { text?: unknown }).text;
    assert.ok(typeof toast2 === "string", "тост — строка");
    assert.match(toast2, /устарело|expired/i);
    assert.ok(
      calls.some((call) => call.method === "flows.screen"),
      "корень перерисован",
    );
    assert.equal(states.get("11:111")?.screen, "r", "экран — корень");
    assert.equal(states.get("11:111")?.awaitText, null, "флоу не заряжен");
  } finally {
    states.clear();
  }
});

// Усыновление не теряет живой awaitText, если экран-получатель владеет его kind: иначе
// следующий секрет прошёл бы мимо перехвата (не удалён из чата, ушёл в eve).
await test("F-MENU: усыновление сохраняет живой awaitText своего экрана", async () => {
  const { states, tap } = rig(STUB_SCREENS);
  try {
    states.set("11:111", {
      flow: "menu",
      chatId: 11,
      userId: "111",
      createdAt: Date.now(),
      msgId: 100,
      provider: null,
      modelOptions: null,
      model: null,
      efforts: null,
      effort: null,
      step: null,
      awaitText: { kind: "k", secret: true },
      screen: "r",
      page: 0,
      data: {},
    });
    const result = await tap("iva_menu:srch:o", {
      message: { message_id: 200, chat: { id: 11, type: "private" } },
    });
    assert.equal(result, true);
    const st = states.get("11:111");
    assert.ok(st);
    assert.equal(st.screen, "srch");
    assert.deepEqual(st.awaitText, { kind: "k", secret: true });
  } finally {
    states.clear();
  }
});

// Матрица мусора: движок не кидает, тап глотается (true), в eve ничего не уходит.
await test("property: любой мусор в callback_data глотается молча", async () => {
  const hostile = fc.constantFrom(
    "iva_menu:",
    "iva_menu:::",
    "iva_menu:o",
    "iva_menu:zzz:o",
    "iva_menu:zzz:set:x",
    "iva_menu:r:pg:9999999999999999999999",
    "iva_menu:r:pg:-3",
    "iva_menu:r:pg:abc",
    "iva_menu:sk:pg:0:extra:args:here",
    "iva_menu",
    "iva_menu:mdl",
    "iva_menu:thk",
    `iva_menu:${"s".repeat(5000)}:${"v".repeat(5000)}`,
    "iva_menu:пр:уст:😀",
    "iva_menu:r:x",
    "iva_menu:r:rf",
    "",
  );
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(hostile, fc.string({ maxLength: 200 })),
      async (data) => {
        const { delivered, tap } = rig();
        const result = await tap(data);
        assert.equal(result, true);
        assert.deepEqual(delivered, []);
      },
    ),
    { seed: SEED + 1, numRuns: 150 },
  );
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Монте-Карло шторма тапов: длина серии × доля мусора × вероятность повтора
// (двойные нажатия). Оси повторяемости — фиксированные сееды. Таблица в stdout.
await test("monte-carlo: шторм тапов", async () => {
  const verbs = [
    "r:o",
    "r:rf",
    "r:pg:2",
    "sk:o",
    "sk:pg:1",
    "r:x",
    "mdl",
    "zzz:o",
    "zzz:set:x",
  ];
  const garbage = [
    "",
    ":::",
    "r:pg:NaN",
    "sk:pg:-1",
    "\u0000",
    "x".repeat(300),
  ];
  console.log("len | garbage | repeat | renders | expired-or-closed | errors");
  for (const len of [5, 20]) {
    for (const garbageShare of [0, 0.5]) {
      for (const repeatProb of [0, 0.5]) {
        let renders = 0;
        let closed = 0;
        let errors = 0;
        for (const seed of [20260411, 20260412, 20260413]) {
          const rand = mulberry32(
            seed +
              len * 131 +
              Math.round(garbageShare * 17) * 7 +
              Math.round(repeatProb * 17),
          );
          const { calls, tap } = rig();
          let last = "";
          for (let i = 0; i < len; i += 1) {
            const roll = rand();
            const data =
              roll < repeatProb && last !== ""
                ? last
                : rand() < garbageShare
                  ? garbage[Math.floor(rand() * garbage.length)]
                  : verbs[Math.floor(rand() * verbs.length)];
            last = `iva_menu:${data}`;
            try {
              await tap(last);
            } catch {
              errors += 1;
            }
          }
          for (const call of calls) {
            if (call.method === "flows.screen") renders += 1;
            else if (call.method === "flows.end") closed += 1;
            else if (
              call.method === "sendMessage" ||
              call.method === "editMessageText"
            ) {
              const text: unknown = (call.params as { text?: unknown }).text;
              if (
                typeof text === "string" &&
                (text.includes("устарело") || text.includes("закрыто"))
              )
                closed += 1;
              else renders += 1;
            }
          }
        }
        console.log(
          `${len} | ${garbageShare} | ${repeatProb} | ${renders} | ${closed} | ${errors}`,
        );
        assert.equal(errors, 0);
      }
    }
  }
});

// Двойной тап и двойной /menu: оба оседают, состояние одно, исключений нет.
await test("двойной тап и двойной open не плодят состояний", async () => {
  const { calls, states, menu, tap } = rig();
  try {
    const [first, second] = await Promise.all([
      tap("iva_menu:r:rf"),
      tap("iva_menu:r:rf"),
    ]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(states.size, 1);
    const st1 = await menu.open(11, "111");
    const st2 = await menu.open(11, "111");
    assert.equal(states.size, 1);
    assert.notEqual(st1, st2);
    // Клавиатуру со старого меню больше не снимают (кнопка — часть rich-текста), но
    // свежий корень обязан быть отрисован: flows.screen здесь — это Bot API на живом стенде.
    assert.ok(
      calls.some(
        (call) =>
          call.method === "flows.screen" ||
          call.method === "editMessageReplyMarkup" ||
          call.method === "editMessageText" ||
          call.method === "sendMessage" ||
          call.method === "sendRichMessage",
      ),
    );
  } finally {
    states.clear();
  }
});
