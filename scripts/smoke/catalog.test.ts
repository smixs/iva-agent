import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

void test("smoke scenario ids and executable todos match the testing table", async (t) => {
  const docs = await readFile(
    new URL("../../docs/testing.md", import.meta.url),
    "utf8",
  );
  const documented = [...docs.matchAll(/^\|\s*([SP]-[\w-]+)\s*\|/gmu)].map(
    (m) => m[1],
  );
  const implemented: string[] = [];
  const pending: string[] = [];
  for (const name of await readdir(new URL("./", import.meta.url))) {
    if (!name.endsWith(".smoke.ts")) continue;
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        assert.notEqual(
          node.expression.getText(ast),
          "test.todo",
          `${name}: todo requires an executable body`,
        );
        if (
          node.expression.getText(ast) === "test" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const id = /^([SP]-[\w-]+):/u.exec(node.arguments[0].text)?.[1];
          if (id) {
            const body = node.arguments.at(-1)!;
            assert.ok(
              ts.isArrowFunction(body) ||
                ts.isFunctionExpression(body) ||
                ts.isIdentifier(body),
              `${id}: missing test body`,
            );
            implemented.push(id);
            const options = node.arguments[1];
            if (
              options &&
              ts.isObjectLiteralExpression(options) &&
              options.properties.some(
                (p) =>
                  ts.isPropertyAssignment(p) && p.name.getText(ast) === "todo",
              )
            )
              pending.push(id);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  assert.equal(
    new Set(documented).size,
    documented.length,
    "duplicate table id",
  );
  assert.equal(
    new Set(implemented).size,
    implemented.length,
    "duplicate test id",
  );
  assert.equal(documented.length, 10);
  assert.deepEqual(
    implemented.filter((id) => id !== "S-update-cycle-pin").sort(),
    documented.sort(),
  );
  assert.deepEqual(pending.sort(), ["S-rem-reset", "S-update-cycle-pin"]);
  for (const id of pending)
    assert.ok(
      docs
        .split("\n")
        .some(
          (row) =>
            row.startsWith("|") &&
            row.includes(id) &&
            row.includes("ждёт починки"),
        ),
      `${id}: missing pending documentation`,
    );
  t.diagnostic(
    `smoke scenarios: ${documented.length}; executable todo cases: ${pending.join(", ")}`,
  );
});
