/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  eventCases,
  eventProbe,
} from "./fixtures/helper-events-r3.test-fixture.ts";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
const base = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-w3-base.json", import.meta.url),
    "utf8",
  ),
) as {
  base: string;
  archive: string;
  cases: Record<string, Record<string, unknown>>;
  wires: Record<string, unknown>;
};
assert.equal(base.base, "91dd9bb6");
assert.equal(base.archive, "0.51.1-iva.2");
const enabledWire = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-enabled-wire.json", import.meta.url),
    "utf8",
  ),
) as { tools: unknown[]; ruPrefix: unknown[] };
const projection = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (key: string, value: unknown) =>
      ["eve.harness.modelCalls", "providerModelId"].includes(key)
        ? undefined
        : value,
    ),
  ) as { tools: unknown[]; ruPrefix: unknown[] };
for (const mode of ["conversation", "task"] as const)
  for (const scenario of eventCases)
    test(`91dd9bb6 complete events/history/state/manifest/prefix ${mode}/${scenario}`, async (t) => {
      const expected = base.cases[`${mode}/${scenario}`];
      const { clock, wireKey, ...rest } = expected;
      t.mock.timers.enable({ apis: ["Date"], now: Number(clock) });
      assert.equal(typeof wireKey, "string");
      assert.deepEqual(
        projection(await eventProbe(mode, scenario, true)),
        projection({
          ...rest,
          tools: (rest.tools as number[]).map((n) => (n ? n - 1 : 0)),
          wire: {
            tools: [
              ...enabledWire.tools,
              ...(
                base.wires[wireKey as string] as { tools: { name: string }[] }
              ).tools.filter((t) => t.name === "final_output"),
            ],
            prefix: enabledWire.ruPrefix,
          },
        }),
      );
    });
