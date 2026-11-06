/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
import {
  eventCases,
  eventProbe,
} from "./fixtures/helper-events-r3.test-fixture.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "chat-fixture";
const base = JSON.parse(
  await readFile(
    new URL("./fixtures/helper-events-base.json", import.meta.url),
    "utf8",
  ),
) as {
  base: string;
  archive: string;
  cases: Record<string, Awaited<ReturnType<typeof eventProbe>>>;
};
assert.equal(base.base, "21f447ed");
assert.equal(base.archive, "0.51.1-iva.1");
test("L3 the extra goal tool is present on the wire", async () => {
  assert.ok((await wireTurn()).wire.tools.some((tool) => tool.name === "goal"));
});
for (const mode of ["conversation", "task"] as const)
  for (const scenario of eventCases)
    test(`L3 unlimited ${mode}/${scenario} preserves base events and outcome`, async () => {
      const expected = base.cases[`${mode}/${scenario}`];
      assert.deepEqual(await eventProbe(mode, scenario), {
        ...expected,
        tools: expected.tools.map((n) => (n ? n - 1 : 0)),
      });
    });
