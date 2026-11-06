/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  pluginUnitScope,
  scopedPluginUnitName,
  markPluginUnit,
  readPluginUnitMarker,
  pluginUnitPayload,
} from "./plugin-unit-scope.ts";

const scope = pluginUnitScope("/data/Ива with space");
const identity = {
  scope,
  kind: "service" as const,
  plugin: "a-b",
  part: "c",
  layout: "legacy" as const,
};
test("scope is data identity, independent of the code executor", () => {
  assert.deepEqual(pluginUnitScope(scope.dataRoot), scope);
  assert.notEqual(pluginUnitScope("/data/B").id, scope.id);
  assert.throws(() => pluginUnitScope("relative"));
  assert.throws(() => pluginUnitScope("/data/../B"));
});
test("marker decodes a complete stale legacy key without splitting its name", () => {
  const body = markPluginUnit("[Service]\n", identity);
  assert.deepEqual(
    readPluginUnitMarker(body, "iva-plugin-a-b-c.service"),
    identity,
  );
  const other = { ...identity, plugin: "a", part: "b-c" };
  assert.notEqual(markPluginUnit("[Service]\n", other), body);
  assert.equal(scopedPluginUnitName(other), scopedPluginUnitName(identity));
});
test("marker framing, closed tuple, owner, name and digest fail closed", () => {
  const body = markPluginUnit("[Service]\n", identity);
  const encoded = /v1:([0-9a-f]+)/u.exec(body)![1];
  const tuple = JSON.parse(
    Buffer.from(encoded, "hex").toString("utf8"),
  ) as unknown[];
  const replace = (value: unknown) =>
    body.replace(encoded, Buffer.from(JSON.stringify(value)).toString("hex"));
  for (const invalid of ["f", "zz", "ff", "7b"])
    assert.equal(
      readPluginUnitMarker(
        body.replace(encoded, invalid),
        "iva-plugin-a-b-c.service",
      ),
      null,
    );
  for (const value of [
    tuple.slice(1),
    [...tuple, "extra"],
    tuple.map((v, i) => (i === 0 ? 2 : v)),
    tuple.map((v, i) => (i === 3 ? "bad" : v)),
    tuple.map((v, i) => (i === 4 ? "../x" : v)),
    tuple.map((v, i) => (i === 1 ? "f".repeat(64) : v)),
  ])
    assert.equal(
      readPluginUnitMarker(replace(value), "iva-plugin-a-b-c.service"),
      null,
    );
  assert.equal(
    readPluginUnitMarker(`${body}changed`, "iva-plugin-a-b-c.service"),
    null,
  );
  assert.equal(readPluginUnitMarker(body, "iva-plugin-other.service"), null);
  assert.equal(
    readPluginUnitMarker(body + body, "iva-plugin-a-b-c.service"),
    null,
  );
});
test("marker roundtrip preserves arbitrary payload bytes and XML comments", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const payload = `[Service]\n# ${value}\n`;
      const marked = markPluginUnit(payload, identity);
      assert.deepEqual(
        readPluginUnitMarker(marked, scopedPluginUnitName(identity)),
        identity,
      );
      assert.equal(pluginUnitPayload(marked), payload);
    }),
    { seed: 378, numRuns: 100 },
  );
  const xml = '<?xml version="1.0"?>\n<plist/>\n';
  assert.deepEqual(
    readPluginUnitMarker(
      markPluginUnit(xml, identity),
      scopedPluginUnitName(identity),
    ),
    identity,
  );
});
test("scoped names retain the existing tuple collision and bound filename bytes", () => {
  const name = scopedPluginUnitName({ ...identity, layout: "scoped" });
  assert.ok(name.includes(scope.id));
  assert.throws(
    () => scopedPluginUnitName({ ...identity, part: "x".repeat(256) }),
    /255/u,
  );
});
