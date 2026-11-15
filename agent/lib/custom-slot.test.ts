/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Слот живых скиллов (agent/skills/custom.ts): eve грузит его сам, поэтому тест
// лежит в agent/lib, а не рядом (как trace-hook.test.ts — eve считает артефактом
// каждый файл в слотах discovery). Проверяет проводку: turn.started отдаёт карту
// скиллов с диска, пустой каталог — null.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

const root = tempDir("iva-custom-slot-");
const DATA_DIR = join(root, "data");
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
process.env.ASSISTANT_VAULT_DIR = join(root, "vault");

await import("../../scripts/lib/ts-esm-hooks.ts");
const modulePath = fileURLToPath(
  new URL("../skills/custom.ts", import.meta.url),
);
const slot = (await import(
  pathToFileURL(modulePath).href
)) as typeof import("../skills/custom.ts");

const turnStarted = () => {
  const handler = slot.default.events["turn.started"];
  assert.ok(handler, "слот обязан висеть на turn.started");
  return handler({}, {} as never);
};

test("custom slot is wired to turn.started", () => {
  assert.equal(typeof slot.default, "object");
  assert.ok("turn.started" in slot.default.events);
});

test("empty skills dir resolves to null, not an empty map", async () => {
  assert.equal(await turnStarted(), null);
});

test("a skill file on disk is live on the next turn", async () => {
  const dir = join(DATA_DIR, "custom", "agent", "skills", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\ndescription: Says hello when asked\n---\n# Hello\nSay hello.\n",
  );
  try {
    const skills = await turnStarted();
    assert.ok(skills !== null);
    assert.ok("hello" in skills);
    assert.equal(skills.hello.description, "Says hello when asked");
  } finally {
    rmSync(join(DATA_DIR, "custom"), {
      recursive: true,
      force: true,
    });
  }
  assert.equal(await turnStarted(), null);
});
