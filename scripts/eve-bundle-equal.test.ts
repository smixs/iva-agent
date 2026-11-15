/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import test from "node:test";

import { compareChunks } from "./eve-bundle-equal.ts";

const EVE = "../../node_modules/eve/dist/src";
const chunk = (
  imports: string,
  modules: Record<string, string>,
  exports: string,
): string =>
  [
    imports,
    ...Object.entries(modules).map(
      ([id, code]) => `//#region ${EVE}/${id}\n${code}\n//#endregion`,
    ),
    exports,
  ].join("\n");

const BEFORE = chunk(
  `import { a as join, b as sep } from "node:path";\nimport fs from "node:fs";`,
  {
    "read.js": `function read$1(e, t) { let n = join(e, t); return fs.readFileSync(n, "utf8"); }`,
    "run.js": [
      `const VERSION = "0.51.1-iva.6";`,
      `function run(e) { let t = read$1(e, "a"), n = { t, size: t.length }; return n; }`,
      `function other(e) { let t = e + sep; return t; }`,
      `console.log("first");`,
      `globalThis.started = run;`,
    ].join("\n"),
  },
  `export { run as r, other as o };`,
);
/** The same program as the eve build writes it after a source file is removed. */
const RENAMED = chunk(
  `import fs from "node:fs";\nimport { b as sep$1, a as join } from "node:path";`,
  {
    "read.js": `function read(t, e) { let r = join(t, e); return fs.readFileSync(r, "utf8"); }`,
    "run.js": [
      `const VERSION = "0.51.1-iva.7";`,
      `function run(i) { let t = read(i, "a"), n = { t, size: t.length }; return n; }`,
      `function other(e) { let t = e + sep$1; return t; }`,
      `console.log("first");`,
      `globalThis.started = run;`,
    ].join("\n"),
  },
  `export { other as o, run as r };`,
);

const differences = (after: string): string[] =>
  compareChunks(BEFORE, after).different.map(
    ({ module, detail }) => `${module}: ${detail}`,
  );
const edit = (from: string, to: string): string => {
  assert.ok(RENAMED.includes(from), `the fixture lost «${from}»`);
  return RENAMED.replace(from, to);
};

test("renamed bindings, reordered imports and exports and the archive version leave the chunk equal", () => {
  const result = compareChunks(BEFORE, RENAMED);
  assert.deepEqual(result.different, []);
  assert.deepEqual([result.missing, result.added], [[], []]);
  assert.deepEqual(result.renamedTop, [
    ["read$1", "read"],
    ["sep", "sep$1"],
  ]);
  assert.equal(result.renamedLocal, 4);
  assert.equal(result.sameOrder, true);
});

const PLANTED: Record<string, [from: string, to: string]> = {
  "a changed literal": [`"a"`, `"b"`],
  "a removed statement": [`console.log("first");\n`, ""],
  "two statements with a side effect in the other order": [
    `console.log("first");\nglobalThis.started = run;`,
    `globalThis.started = run;\nconsole.log("first");`,
  ],
  "a changed property name": [`size: t.length`, `length: t.length`],
  "a changed operator": [`e + sep$1`, `e - sep$1`],
  "a shorthand property under another name": [
    `let t = read(i, "a"), n = { t, size: t.length }`,
    `let o = read(i, "a"), n = { o, size: o.length }`,
  ],
  "two bindings folded into one": [`let r = join(t, e)`, `let r = join(t, t)`],
  "one shared binding standing for two": [`e + sep$1`, `e + join`],
  "a renamed global": [`globalThis.started`, `globalThis$1.started`],
  "another import source": [`from "node:fs"`, `from "node:fs/promises"`],
  "another exported name": [`run as r`, `run as q`],
  "an export of another binding": [`other as o`, `read as o`],
};
for (const [name, [from, to]] of Object.entries(PLANTED))
  test(`${name} makes the chunk different`, () => {
    assert.notDeepEqual(differences(edit(from, to)), []);
  });

test("a missing and a new module are named", () => {
  const result = compareChunks(
    BEFORE,
    RENAMED.replace(`${EVE}/read.js`, `${EVE}/write.js`),
  );
  assert.deepEqual(result.missing, ["node_modules/eve/dist/src/read.js"]);
  assert.deepEqual(result.added, ["node_modules/eve/dist/src/write.js"]);
});

test("a chunk carried as base64 text is compared by the same rule", () => {
  const carry = (inner: string): string =>
    chunk(
      "",
      {
        "host.js": `const POST = ["${Buffer.from(inner).toString("base64").padEnd(200, "=")}"];`,
      },
      "",
    );
  const inner = (code: string): string =>
    `(function () {\n//#region dist/src/step.js\n${code}\n//#endregion\n})();`;
  const before = carry(inner(`function step(e) { return e + 1; }`));
  const [same] = compareChunks(
    before,
    carry(inner(`function step$1(t) { return t + 1; }`)),
  ).embedded;
  assert.deepEqual(same?.result.different, []);
  assert.deepEqual(same?.result.modules, ["(chunk)", "dist/src/step.js"]);
  const [changed] = compareChunks(
    before,
    carry(inner(`function step(e) { return e + 2; }`)),
  ).embedded;
  assert.equal(changed?.result.different[0]?.module, "dist/src/step.js");
});
