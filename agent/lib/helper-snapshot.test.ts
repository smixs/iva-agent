/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { isQuietReply as originalQuiet } from "../../scripts/lib/reminder-turn.ts";
const seed = Number(process.env.FC_SEED ?? 20261014);
test(`v7 snapshot fold: first terminal, last string, exact usage and model; seed ${seed}`, async () => {
  const { foldHelperSnapshot } = await import("./helper-snapshot.ts");
  const terminal = {
    "turn.completed": "done",
    "session.completed": "done",
    "turn.failed": "failed",
    "session.failed": "failed",
    "input.requested": "failed",
    "authorization.required": "failed",
    "turn.cancelled": "interrupted",
  } as const;
  fc.assert(
    fc.property(
      fc.array(
        fc.oneof(
          fc.record({
            kind: fc.constant("text"),
            value: fc.option(fc.string(), { nil: null }),
          }),
          fc.record({
            kind: fc.constant("usage"),
            input: fc.nat(1000),
            output: fc.nat(100),
            model: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          }),
          fc.record({
            kind: fc.constant("start"),
            value: fc.string({ minLength: 1 }),
          }),
          fc.record({
            kind: fc.constant("end"),
            value: fc.constantFrom(...Object.keys(terminal)),
          }),
          fc.record({ kind: fc.constant("delta"), value: fc.string() }),
        ),
        { maxLength: 40 },
      ),
      (records) => {
        const events = records.map((r) =>
          r.kind === "text"
            ? { type: "message.completed", data: { message: r.value } }
            : r.kind === "usage"
              ? {
                  type: "step.completed",
                  data: {
                    usage: { inputTokens: r.input, outputTokens: r.output },
                    providerModelId: r.model,
                  },
                }
              : r.kind === "start"
                ? { type: "step.started", data: { modelId: r.value } }
                : r.kind === "end"
                  ? {
                      type: r.value,
                      ...(r.value === "session.completed"
                        ? {}
                        : {
                            data: {
                              sequence: 1,
                              turnId: "turn",
                              message: "failure cause",
                            },
                          }),
                    }
                  : {
                      type: "message.appended",
                      data: { messageDelta: r.value },
                    },
        );
        const texts = records.filter((r) => r.kind === "text");
        const expectedText =
          texts.filter((r) => typeof r.value === "string").at(-1)?.value ??
          null;
        const usage = records.filter((r) => r.kind === "usage");
        const inputs = usage.map((r) => r.input),
          outputs = usage.map((r) => r.output);
        const work =
          outputs.reduce((a, b) => a + b, 0) +
          inputs.reduce(
            (sum, n, i) => sum + Math.max(0, n - (inputs[i - 1] ?? 0)),
            0,
          );
        const first = records.find((r) => r.kind === "end");
        const expectedModel =
          usage.at(-1)?.model ??
          records.filter((r) => r.kind === "start").at(-1)?.value ??
          null;
        const actual = foldHelperSnapshot(events);
        assert.equal(actual.text, expectedText);
        assert.equal(actual.steps, usage.length);
        assert.equal(actual.tokens, work);
        assert.equal(actual.model, expectedModel);
        assert.equal(actual.ended, !!first);
        const expected = first
          ? terminal[first.value as keyof typeof terminal]
          : "empty";
        assert.equal(
          actual.outcome,
          expected === "done" &&
            (!expectedText?.trim() || originalQuiet(expectedText))
            ? "empty"
            : expected,
        );
      },
    ),
    { seed, numRuns: 500 },
  );
});
test(`v7 quiet check equals the original for Unicode and decorated QUIET; summary bounds; seed ${seed}`, async () => {
  const { isQuietReply, helperSummary, foldHelperSnapshot } =
    await import("./helper-snapshot.ts");
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string({ maxLength: 3000 }),
        fc.string().map((s) => `${s}QUIET${s}`),
        fc.constantFrom(" QUIET ", "**quiet**", "\u200B«QUIET».", "quiet work"),
      ),
      (text) => {
        assert.equal(isQuietReply(text), originalQuiet(text));
        const summary = helperSummary(text);
        assert.ok(summary === null || summary.length <= 1500);
        if (text.trim().length > 1500) assert.ok(summary?.endsWith("…"));
      },
    ),
    { seed, numRuns: 500 },
  );
  assert.equal(helperSummary("x\n\n" + "😀".repeat(1500))?.endsWith("…"), true);
  const summaryText =
    "Остановилась на пределе входных токенов. Вот что успела: нашла документ.";
  const f = foldHelperSnapshot([
    { type: "message.completed", data: { message: summaryText } },
    {
      type: "turn.completed",
      data: { sequence: 1, turnId: "turn", reason: "step-limit" },
    },
  ]);
  assert.equal(f.outcome, "ceiling");
  assert.equal(f.text, summaryText);
  assert.equal(f.reason, "предел работы");
  assert.equal(
    foldHelperSnapshot([
      { type: "authorization.required", data: { sequence: 1, turnId: "turn" } },
    ]).reason,
    "помощник ждал авторизации",
  );
  assert.equal(
    foldHelperSnapshot([
      { type: "input.requested", data: { sequence: 1, turnId: "turn" } },
    ]).reason,
    "помощник ждал ответа",
  );
});

test(`v7 K1: malformed consumed event fields reject the snapshot; seed ${seed}`, async () => {
  const { foldHelperSnapshot } = await import("./helper-snapshot.ts");
  const ends = [
    "turn.completed",
    "turn.cancelled",
    "turn.failed",
    "session.failed",
    "input.requested",
    "authorization.required",
  ];
  fc.assert(
    fc.property(
      fc.constantFrom(...ends),
      fc.oneof(
        fc.integer(),
        fc.string(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.array(fc.integer()),
      ),
      (type, data) => {
        assert.throws(() => foldHelperSnapshot([{ type, data }]));
      },
    ),
    { seed, numRuns: 500 },
  );
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.array(fc.integer()),
      ),
      (wrong) => {
        assert.throws(() =>
          foldHelperSnapshot([
            {
              type: "turn.completed",
              data: { sequence: wrong, turnId: "turn" },
            },
          ]),
        );
        assert.throws(() =>
          foldHelperSnapshot([
            {
              type: "turn.completed",
              data: {
                sequence: 1,
                turnId: "turn",
                reason:
                  typeof wrong === "string" || wrong === undefined ? 7 : wrong,
              },
            },
          ]),
        );
        for (const field of ["inputTokens", "outputTokens"])
          assert.throws(() =>
            foldHelperSnapshot([
              {
                type: "step.completed",
                data: { usage: { [field]: wrong === undefined ? "7" : wrong } },
              },
            ]),
          );
      },
    ),
    { seed, numRuns: 500 },
  );
  for (const type of ["turn.failed", "session.failed"])
    assert.throws(() =>
      foldHelperSnapshot([{ type, data: { sequence: 1, message: 7 } }]),
    );
  assert.throws(() =>
    foldHelperSnapshot([{ type: "step.completed", data: { usage: null } }]),
  );
  assert.equal(foldHelperSnapshot([{ type: "session.completed" }]).ended, true);
});

test(`snapshot shape: session.completed rejects data; seed ${seed}`, async () => {
  const { foldHelperSnapshot } = await import("./helper-snapshot.ts");
  assert.throws(() =>
    foldHelperSnapshot([{ type: "session.completed", data: 7 }]),
  );
  fc.assert(
    fc.property(fc.jsonValue(), (data) => {
      assert.throws(() =>
        foldHelperSnapshot([{ type: "session.completed", data }]),
      );
    }),
    { seed, numRuns: 500 },
  );
  assert.equal(
    foldHelperSnapshot([{ type: "session.completed" }]).outcome,
    "empty",
  );
});

test(`snapshot shape: message.completed validates data and message; seed ${seed}`, async () => {
  const { foldHelperSnapshot } = await import("./helper-snapshot.ts");
  for (const data of [7, { message: 7 }])
    assert.throws(() =>
      foldHelperSnapshot([{ type: "message.completed", data }]),
    );
  const invalid = fc
    .jsonValue()
    .filter((value) => value !== null && typeof value !== "string");
  fc.assert(
    fc.property(invalid, (message) => {
      assert.throws(() =>
        foldHelperSnapshot([{ type: "message.completed", data: { message } }]),
      );
    }),
    { seed, numRuns: 500 },
  );
  const invalidData = fc.oneof(
    fc
      .jsonValue()
      .filter(
        (data) =>
          data === null || typeof data !== "object" || Array.isArray(data),
      ),
    fc.constant(undefined),
    fc.constant({}),
  );
  fc.assert(
    fc.property(invalidData, (data) => {
      assert.throws(() =>
        foldHelperSnapshot([{ type: "message.completed", data }]),
      );
    }),
    { seed, numRuns: 500 },
  );
  assert.equal(
    foldHelperSnapshot([
      { type: "message.completed", data: { message: "saved" } },
      { type: "message.completed", data: { message: null } },
      { type: "session.completed" },
    ]).text,
    "saved",
  );
});
