/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Хук расхода (agent/hooks/usage.ts): `source` строки — вид хода Ивы, если сессию начал её
// bearer-клиент с атрибутом `iva_turn`; иначе вид канала, как раньше. Тест лежит в agent/lib,
// а не рядом с хуком: eve считает хуком каждый файл в agent/hooks (см. trace-hook.test.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setUsageRequest } from "./usage.ts";

await import("../../scripts/lib/ts-esm-hooks.ts");
const HOOK = (await import("../hooks/usage.ts")).default as unknown as {
  events: Record<string, (event: unknown, ctx: unknown) => void>;
};

const USAGE = {
  inputTokens: 1200,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const STEP = { data: { stepIndex: 0, turnId: "turn_0", usage: USAGE } };
const SUBAGENT_STEP = {
  data: {
    subagentName: "planner",
    event: { type: "step.completed", data: { stepIndex: 1, usage: USAGE } },
  },
};

type Initiator = {
  readonly authenticator: string;
  readonly attributes: Record<string, string>;
} | null;

/** Строки, которые хук записал на одно событие. */
function rowsAfter(
  name: "step.completed" | "subagent.event",
  initiator: Initiator | undefined,
  kind = "http",
): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "iva-usage-hook-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    HOOK.events[name](name === "step.completed" ? STEP : SUBAGENT_STEP, {
      session: {
        id: "s1",
        turn: { id: "turn_3", sequence: 3 },
        ...(initiator === undefined
          ? {}
          : { auth: { current: initiator, initiator } }),
      },
      channel: { kind },
    });
    return readFileSync(join(dir, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const bearer = (iva_turn: string): Initiator => ({
  authenticator: "iva-bearer",
  attributes: { iva_turn },
});

test("step fingerprints survive inline-subagent turn naming and are consumed once", () => {
  const request = {
    system: "12345678",
    cache: "23456789",
    tools: "34567890",
    toolCount: 2,
  };
  for (const name of ["step.completed", "subagent.event"] as const) {
    setUsageRequest(
      {
        sessionId: "s1",
        turnId: name === "step.completed" ? "turn_0" : "",
        step: name === "step.completed" ? 0 : 1,
      },
      request,
    );
    assert.deepEqual(rowsAfter(name, bearer("helper"))[0]?.request, request);
    assert.equal(rowsAfter(name, bearer("helper"))[0]?.request, undefined);
  }
});

test("a step of Iva's own turn is written under its kind, the subagent's step too", () => {
  for (const name of ["step.completed", "subagent.event"] as const) {
    assert.equal(rowsAfter(name, bearer("insight"))[0]?.source, "insight");
    assert.equal(rowsAfter(name, bearer("watch"))[0]?.source, "watch");
    assert.equal(rowsAfter(name, bearer("alert"))[0]?.source, "alert");
  }
});

test("another authenticator with an iva_turn attribute keeps the channel kind", () => {
  for (const name of ["step.completed", "subagent.event"] as const) {
    const telegram = {
      authenticator: "telegram",
      attributes: { iva_turn: "insight", chat_id: "777" },
    };
    assert.equal(
      rowsAfter(name, telegram, "channel:telegram")[0]?.source,
      "channel:telegram",
    );
  }
});

test("no initiator, no auth at all or a kind outside the list: the channel kind, as before", () => {
  for (const name of ["step.completed", "subagent.event"] as const) {
    assert.equal(rowsAfter(name, null)[0]?.source, "http");
    assert.equal(rowsAfter(name, undefined)[0]?.source, "http");
    assert.equal(rowsAfter(name, bearer("digest"))[0]?.source, "http");
    assert.equal(rowsAfter(name, bearer("__proto__"))[0]?.source, "http");
  }
});
