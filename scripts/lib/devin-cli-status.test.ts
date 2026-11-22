import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { devinStatus, listDevinModels } from "./devin-cli-status.ts";
import { validateModelSelection } from "./model-validation.ts";
import { fetchModelOptions } from "./model-catalog.ts";

void test("Devin catalog drives model validation and menu; unavailable models are refused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-devin-catalog-"));
  const command = join(dir, "devin");
  const data = join(dir, "catalog.json");
  writeFileSync(
    command,
    `#!${process.execPath}\nconst fs=require('node:fs'); console.log(process.argv[2]==='auth'?'Logged in (via Devin).':fs.readFileSync(${JSON.stringify(data)},'utf8'));\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    data,
    JSON.stringify({
      families: [
        {
          variants: [
            { model_uid: "swe-2-high" },
            { model_uid: "swe-2-high" },
            { model_uid: "swe-2-flash-medium" },
          ],
        },
      ],
    }),
  );
  const old = process.env.DEVIN_COMMAND;
  process.env.DEVIN_COMMAND = command;
  t.after(() => {
    if (old === undefined) delete process.env.DEVIN_COMMAND;
    else process.env.DEVIN_COMMAND = old;
    rmSync(dir, { recursive: true, force: true });
  });
  await devinStatus();
  assert.deepEqual(await listDevinModels(), [
    "swe-2-high",
    "swe-2-flash-medium",
  ]);
  assert.deepEqual(
    (await fetchModelOptions("devin")).map((x) => x.id),
    ["swe-2-high", "swe-2-flash-medium"],
  );
  assert.equal(
    (await validateModelSelection({ provider: "devin", model: "swe-2-high" }))
      .id,
    "swe-2-high",
  );
  await assert.rejects(
    validateModelSelection({ provider: "devin", model: "made-up" }),
    /unavailable/,
  );
  writeFileSync(
    data,
    JSON.stringify({ families: [{ variants: [{ model_uid: 42 }] }] }),
  );
  await assert.rejects(listDevinModels(), /Invalid Devin model id/);
  writeFileSync(data, "{}");
  await assert.rejects(listDevinModels(), /Invalid Devin model catalog/);
});

void test("Devin probes honor configured executable and private proxy without global env changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-devin-config-"));
  const command = join(dir, "configured-devin");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    command,
    `#!${process.execPath}
if(process.env.HTTPS_PROXY!=='http://test.proxy:3128'||process.env.http_proxy!=='http://test.proxy:3128')process.exit(42);
console.log(process.argv[2]==='auth'?'Logged in.':JSON.stringify({families:[{variants:[{model_uid:'swe-2-high'}]}]}));
`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    DEVIN_COMMAND: command,
    DEVIN_PROXY_URL: "http://test.proxy:3128",
  };
  const before = process.env.HTTPS_PROXY;
  await devinStatus(env);
  assert.deepEqual(await listDevinModels(env), ["swe-2-high"]);
  assert.deepEqual(
    (await fetchModelOptions("devin", undefined, { devinEnv: env })).map(
      (x) => x.id,
    ),
    ["swe-2-high"],
  );
  assert.equal(
    (
      await validateModelSelection({
        provider: "devin",
        model: "swe-2-high",
        devinEnv: env,
      })
    ).id,
    "swe-2-high",
  );
  assert.equal(process.env.HTTPS_PROXY, before);
});
