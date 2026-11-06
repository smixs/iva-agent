// Расход компактации eve в usage.jsonl. Компактация идёт настоящая, из eve: тот же
// compactMessages, что зовёт tool-loop, с моделью, обёрнутой нашим звеном. Так тест
// пинует и признак вызова (system-промпт eve), и форму расхода провайдера.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; fc.assert(prop, { seed: SEED, path }).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import fc from "fast-check";
import {
  compactionUsageMiddleware,
  providerUsageTokens,
  recordTapUsage,
  recordVisionStreamUsage,
  recordVisionUsage,
  sdkUsageTokens,
  stepUsageLabel,
  type UsageLabel,
} from "#lib/usage-tap.ts";
import { formatUsageReport, readEntries, summarize } from "./usage.ts";
import { appendUsage } from "#lib/usage.ts";

const SEED = 20_260_924;

// Внутренний модуль eve: публичного экспорта у компактации нет, а проверить нужно именно
// её вызов модели, а не наш пересказ этого вызова.
const { compactMessages } = (await import(
  new URL(
    "../../node_modules/eve/dist/src/harness/compaction.js",
    import.meta.url,
  ).href
)) as {
  compactMessages: (
    messages: unknown[],
    model: unknown,
    config: Record<string, number>,
    providerOptions?: unknown,
    telemetry?: unknown,
    headers?: unknown,
    abortSignal?: unknown,
    force?: boolean,
  ) => Promise<unknown[]>;
};

type Usage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
};

function usage(input: number, cacheRead: number, output: number): Usage {
  return {
    inputTokens: {
      total: input,
      noCache: input - cacheRead,
      cacheRead,
      cacheWrite: 0,
    },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function mockModel(reply: Usage) {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text", text: "summary of the conversation" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: reply,
        warnings: [],
      }),
  });
}

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "iva-usage-tap-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  const restore = (): void => {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = run(dir);
    if (result instanceof Promise)
      return result.finally(restore) as unknown as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const HISTORY = [
  { role: "user", content: "расскажи про план ".repeat(40) },
  { role: "assistant", content: "план такой ".repeat(40) },
  { role: "user", content: "дальше" },
];
const CONFIG = {
  threshold: 100_000,
  recentWindowSize: 1,
  thresholdPercent: 0.7,
};
const LABEL: UsageLabel = { sessionId: "s1", turnId: "turn_3", step: 2 };

await test("fingerprint failures preserve model params and usage, with one warning per process", (t) =>
  withDir(async (dir) => {
    await import("./ts-esm-hooks.ts");
    const hook = (await import("../../agent/hooks/usage.ts"))
      .default as unknown as {
      events: Record<string, (event: unknown, ctx: unknown) => void>;
    };
    const warnings: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) =>
      warnings.push(args),
    );
    const received: unknown[] = [];
    const bare = new MockLanguageModelV4({
      doGenerate: (params) => {
        received.push(params);
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(12, 0, 1),
          warnings: [],
        });
      },
    });
    let model = wrapLanguageModel({
      model: bare,
      middleware: [compactionUsageMiddleware(LABEL)],
    });
    const valid = {
      prompt: [{ role: "system", content: "Iva" }],
    } satisfies Parameters<typeof model.doGenerate>[0];
    // A failed retry must also discard an earlier fingerprint for this step.
    await model.doGenerate(valid);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const broken of [cycle, { anthropic: { value: 1n } }]) {
      model = wrapLanguageModel({
        model: bare,
        middleware: [compactionUsageMiddleware(LABEL)],
      });
      const params = {
        prompt: [{ role: "system", content: "Iva", providerOptions: broken }],
      } as unknown as Parameters<typeof model.doGenerate>[0];
      const result = await model.doGenerate(params);
      assert.equal(received.at(-1), params);
      assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
      hook.events["step.completed"](
        {
          data: {
            turnId: LABEL.turnId,
            stepIndex: LABEL.step,
            usage: { inputTokens: 12, outputTokens: 1 },
          },
        },
        { session: { id: LABEL.sessionId }, channel: { kind: "http" } },
      );
      assert.equal("request" in readEntries(dir).at(-1)!, false);
    }
    assert.equal(received.length, 3);
    assert.equal(readEntries(dir).length, 2);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /fingerprint/iu);
  }));

await test("компактация eve пишет строку расхода source=compaction с usage провайдера", () =>
  withDir(async (dir) => {
    const model = wrapLanguageModel({
      model: mockModel(usage(5000, 1000, 300)),
      middleware: [compactionUsageMiddleware(LABEL)],
    });
    await compactMessages(
      HISTORY,
      model,
      CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const rows = readEntries(dir);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    const [row] = rows;
    assert.equal(row.source, "compaction");
    assert.equal(row.sessionId, "s1");
    assert.equal(row.turnId, "turn_3#compaction");
    assert.equal(row.step, 2);
    assert.deepEqual(
      [row.in, row.out, row.cacheRead, row.cacheWrite, row.total],
      [5000, 300, 1000, 0, 5300],
    );
  }));

await test("обычный generateText через ту же модель строку компактации не пишет", () =>
  withDir(async (dir) => {
    const model = wrapLanguageModel({
      model: mockModel(usage(700, 0, 5)),
      middleware: [compactionUsageMiddleware(LABEL)],
    });
    await generateText({ model, system: "Ты Ива.", prompt: "What colour?" });
    assert.deepEqual(readEntries(dir), []);
  }));

await test("компактация входит в итог хода, но не выдаёт себя за контекст сессии", () =>
  withDir((dir) => {
    recordTapUsage(
      { source: "compaction", model: "m", label: LABEL },
      { in: 90_000, out: 2_000, cacheRead: 0, cacheWrite: 0 },
    );
    appendUsage(
      {
        ts: new Date().toISOString(),
        source: "channel:telegram",
        provider: "ollama",
        model: "m",
        sessionId: "s1",
        turnId: "turn_3",
        step: 2,
        in: 12_000,
        out: 100,
        cacheRead: 0,
        cacheWrite: 0,
        total: 12_100,
      },
      dir,
    );
    const entries = readEntries(dir);
    const last = summarize(entries, { window: "last" }).last;
    assert.ok(last);
    assert.equal(
      last.in,
      12_000,
      "контекст — вход шага, не транскрипт компактации",
    );
    assert.equal(last.total, 92_000 + 12_100);
    assert.equal(last.turns, 1);
    const bySource = formatUsageReport(
      summarize(entries, { window: "by-source" }),
    );
    assert.match(bySource, /compaction: 92 000 tokens/u);
  }));

// --- Свойства --------------------------------------------------------------------------

const NUMBER = fc.oneof(
  fc.integer({ min: 0, max: 5_000_000 }),
  fc.constantFrom(undefined, -1, 0.5, 1e308, Number.NaN, Infinity),
);

const USAGE: fc.Arbitrary<Usage> = fc.record({
  inputTokens: fc.record({
    total: NUMBER,
    noCache: NUMBER,
    cacheRead: NUMBER,
    cacheWrite: NUMBER,
  }),
  outputTokens: fc.record({ total: NUMBER, text: NUMBER, reasoning: NUMBER }),
});

const valid = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0);

await test(`расход провайдера: строка только из целых чисел, и ровно они (seed ${SEED})`, (t) => {
  const original = console.error;
  console.error = () => undefined;
  t.after(() => {
    console.error = original;
  });
  fc.assert(
    fc.property(USAGE, (reply) => {
      withDir((dir) => {
        recordTapUsage(
          { source: "compaction", model: "m", label: LABEL },
          providerUsageTokens(reply),
        );
        const rows = readEntries(dir);
        const input = reply.inputTokens;
        const numbers = [
          input.total,
          reply.outputTokens.total,
          input.cacheRead,
          input.cacheWrite,
        ];
        const nonZero = numbers.some((value) => (value ?? 0) > 0);
        if (!numbers.every(valid) || !nonZero) {
          assert.deepEqual(rows, [], `записан мусор: ${JSON.stringify(reply)}`);
          return;
        }
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.deepEqual(
          [row.in, row.out, row.cacheRead, row.cacheWrite],
          numbers.map((value) => value ?? 0),
        );
        assert.equal(row.total, row.in + row.out);
      });
    }),
    { seed: SEED, numRuns: 200 },
  );
});

await test(`метка шага из события резолвера не падает на мусоре (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.anything(), fc.string(), (event, sessionId) => {
      const label = stepUsageLabel(event, sessionId);
      assert.equal(label.sessionId, sessionId);
      assert.equal(typeof label.turnId, "string");
      assert.ok(Number.isSafeInteger(label.step));
    }),
    { seed: SEED, numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.string(),
      fc.nat(),
      fc.string(),
      (turnId, stepIndex, sessionId) => {
        const label = stepUsageLabel(
          { type: "step.started", data: { sequence: 1, stepIndex, turnId } },
          sessionId,
        );
        assert.deepEqual(label, { sessionId, turnId, step: stepIndex });
      },
    ),
    { seed: SEED, numRuns: 200 },
  );
});

// --- Строки без хода: читатель не склеивает их в ложный ход ------------------------------

type StepRow = Parameters<typeof appendUsage>[0];

function step(
  sessionId: string,
  turnId: string,
  input: number,
  output: number,
): StepRow {
  return {
    ts: new Date().toISOString(),
    source: "channel:telegram",
    provider: "ollama",
    model: "m",
    sessionId,
    turnId,
    step: 0,
    in: input,
    out: output,
    cacheRead: 0,
    cacheWrite: 0,
    total: input + output,
  };
}

const TOKENS = (input: number, output: number) => ({
  in: input,
  out: output,
  cacheRead: 0,
  cacheWrite: 0,
});

await test("зрение и компактация без метки не становятся последним ходом и не считаются ходами", () =>
  withDir((dir) => {
    recordVisionUsage("vm", TOKENS(1000, 50));
    appendUsage(step("s1", "turn_0", 20_000, 10), dir);
    recordTapUsage({ source: "compaction", model: "m" }, TOKENS(70_000, 900));
    appendUsage(step("s1", "turn_1", 30_000, 100), dir);
    // Зрение идёт до хода с фото: пока шаг не дошёл, его строка в логе последняя.
    recordVisionUsage("vm", TOKENS(1200, 40));
    const entries = readEntries(dir);
    assert.equal(entries.length, 5);

    const last = summarize(entries, { window: "last" }).last;
    assert.ok(last);
    assert.equal(last.total, 30_100, JSON.stringify(last));
    assert.equal(last.in, 30_000);
    assert.equal(last.steps, 1);
    assert.equal(last.contextFromSubagent, false);
    assert.equal(last.source, "channel:telegram");

    const today = summarize(entries, { window: "today" });
    assert.equal(today.totals.turns, 2, "ходов два, строки без хода — не ход");
    assert.equal(
      today.totals.total,
      1050 + 20_010 + 70_900 + 30_100 + 1240,
      "расход без хода входит в итог окна",
    );
    assert.match(formatUsageReport(today), /· 2 turns/u);
  }));

await test("строка компактации с меткой, последняя в логе, не подменяет контекст хода", () =>
  withDir((dir) => {
    appendUsage(step("s1", "turn_3", 12_000, 100), dir);
    recordTapUsage(
      { source: "compaction", model: "m", label: LABEL },
      TOKENS(90_000, 2_000),
    );
    const last = summarize(readEntries(dir), { window: "last" }).last;
    assert.ok(last);
    assert.equal(last.in, 12_000);
    assert.equal(last.contextFromSubagent, false);
    assert.equal(last.total, 12_100 + 92_000);
    assert.equal(last.steps, 2);
  }));

await test("компактация нового хода до его первого шага не выдаёт себя за ход", () =>
  withDir((dir) => {
    appendUsage(step("s1", "turn_2", 12_000, 100), dir);
    recordTapUsage(
      { source: "compaction", model: "m", label: LABEL },
      TOKENS(90_000, 2_000),
    );
    const last = summarize(readEntries(dir), { window: "last" }).last;
    assert.ok(last);
    assert.equal(last.total, 12_100, "последний ход — последний с шагом");
    assert.equal(last.in, 12_000);
  }));

const OWNED = fc.record({
  kind: fc.constant("step" as const),
  session: fc.constantFrom("s1", "s2"),
  turn: fc.constantFrom("turn_0", "turn_1", "turn_2"),
  input: fc.integer({ min: 1, max: 100_000 }),
  output: fc.integer({ min: 0, max: 5_000 }),
});
const LOOSE = fc.record({
  kind: fc.constantFrom("vision" as const, "compaction" as const),
  input: fc.integer({ min: 1, max: 100_000 }),
  output: fc.integer({ min: 0, max: 5_000 }),
});

await test(`строки без хода не меняют последний ход и число ходов (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(OWNED, LOOSE), { minLength: 1, maxLength: 12 }),
      (rows) => {
        withDir((dir) => {
          for (const row of rows) {
            if (row.kind === "step")
              appendUsage(
                step(row.session, row.turn, row.input, row.output),
                dir,
              );
            else if (row.kind === "vision")
              recordVisionUsage("vm", TOKENS(row.input, row.output));
            else
              recordTapUsage(
                { source: "compaction", model: "m" },
                TOKENS(row.input, row.output),
              );
          }
          const all = readEntries(dir);
          const steps = all.filter(
            (entry) => entry.source === "channel:telegram",
          );
          const withLoose = summarize(all, { window: "last" }).last;
          const stepsOnly = summarize(steps, { window: "last" }).last;
          assert.deepEqual(
            withLoose && { ...withLoose, when: "" },
            stepsOnly && { ...stepsOnly, when: "" },
          );
          const today = summarize(all, { window: "today" }).totals;
          const todaySteps = summarize(steps, { window: "today" }).totals;
          assert.equal(today.turns, todaySteps.turns);
          assert.equal(
            today.total,
            rows.reduce((sum, row) => sum + row.input + row.output, 0),
          );
        });
      },
    ),
    { seed: SEED, numRuns: 150 },
  );
});

// --- Сбой учёта не ломает вызов модели ---------------------------------------------------

await test("сбой записи строки не бросает: компактация и зрение идут дальше", (t) => {
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  t.after(() => {
    console.error = original;
  });
  withDir((dir) => {
    // Каталог на месте файла лога: appendFileSync упадёт с EISDIR.
    mkdirSync(join(dir, "usage.jsonl"));
    assert.equal(
      recordTapUsage(
        { source: "compaction", model: "m", label: LABEL },
        TOKENS(10, 1),
      ),
      false,
    );
    assert.equal(recordVisionUsage("vm", TOKENS(10, 1)), false);
  });
  assert.ok(logged.length >= 2, "сбой назван в журнале");
});

await test("компактация проходит, даже если лог не пишется", () =>
  withDir(async (dir) => {
    mkdirSync(join(dir, "usage.jsonl"));
    const original = console.error;
    console.error = () => undefined;
    try {
      const model = wrapLanguageModel({
        model: mockModel(usage(5000, 1000, 300)),
        middleware: [compactionUsageMiddleware(LABEL)],
      });
      const out = await compactMessages(
        HISTORY,
        model,
        CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
      assert.ok(out.length > 0);
    } finally {
      console.error = original;
    }
  }));

await test("расход без вложенных объектов читается как ноль, а не падает", () => {
  assert.doesNotThrow(() =>
    providerUsageTokens({} as Parameters<typeof providerUsageTokens>[0]),
  );
  assert.doesNotThrow(() =>
    sdkUsageTokens({ inputTokens: 5 } as Parameters<typeof sdkUsageTokens>[0]),
  );
  assert.deepEqual(
    sdkUsageTokens({ inputTokens: 5 } as Parameters<typeof sdkUsageTokens>[0]),
    { in: 5, out: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

await test("отказ обещания usage у стрима зрения — строки нет, ошибка не наружу", async (t) => {
  const original = console.error;
  console.error = () => undefined;
  t.after(() => {
    console.error = original;
  });
  await withDir(async (dir) => {
    const written = await recordVisionStreamUsage(
      "vm",
      Promise.reject(new Error("stream aborted")),
    );
    assert.equal(written, false);
    assert.deepEqual(readEntries(dir), []);
    assert.equal(
      await recordVisionStreamUsage(
        "vm",
        Promise.resolve({
          inputTokens: 700,
          outputTokens: 20,
        } as Parameters<typeof sdkUsageTokens>[0] & object),
      ),
      true,
    );
    assert.equal(readEntries(dir).length, 1);
  });
});

await test("R1 compaction usage records each selected step model", () =>
  withDir(async (dir) => {
    for (const modelName of ["chat-model", "helper-model"]) {
      const model = wrapLanguageModel({
        model: mockModel(usage(5000, 1000, 300)),
        middleware: [compactionUsageMiddleware(LABEL, modelName)],
      });
      await compactMessages(
        HISTORY,
        model,
        CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );
    }
    assert.deepEqual(
      readEntries(dir).map((row) => row.model),
      ["chat-model", "helper-model"],
    );
  }));
