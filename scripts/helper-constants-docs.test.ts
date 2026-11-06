/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as constants from "../agent/lib/helper-store.ts";
test("English and Russian helper limit tables match every exported constant", async () => {
  const expected = Object.entries(constants).filter(([name]) =>
    name.startsWith("HELPER_"),
  );
  assert.equal(expected.length, 9);
  for (const file of ["../docs/helpers.md", "../docs/ru/helpers.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    const found = [
      ...text.matchAll(/\|\s*`(HELPER_[A-Z_]+)`\s*\|\s*(\d+)\s*\|/g),
    ].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(found.sort(), expected.sort());
  }
});
test("helper and goal models use the enforced running capacity", async () => {
  for (const name of ["HelperRun", "GoalCheck"]) {
    const text = await readFile(
      new URL(`../specs/${name}.tla`, import.meta.url),
      "utf8",
    );
    const match = /RunningLimit == (\d+)/.exec(text);
    assert.ok(match, name);
    assert.equal(Number(match[1]), constants.HELPER_MAX_RUNNING, name);
  }
  assert.ok(constants.HELPER_MAX_OPEN >= constants.HELPER_MAX_RUNNING);
});
