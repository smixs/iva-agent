import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { cluster, veil, initials, type Corner } from "./pixels.ts";

const corners: Corner[] = ["tl", "tr", "bl", "br"];
const read = (style: string) =>
  Object.fromEntries(
    style.split(";").map((p) => {
      const [k, v] = p.split(":");
      return [k, v];
    }),
  );

test("a cluster is the same for the same seed and never stacks two pixels", () => {
  fc.assert(
    fc.property(
      fc.integer(),
      fc.constantFrom(...corners),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 2, max: 16 }),
      fc.boolean(),
      (seed, at, count, cell, edge) => {
        const a = cluster(seed, at, count, cell, edge);
        assert.deepEqual(a, cluster(seed, at, count, cell, edge));
        assert.ok(a.length <= count);
        const places = a.map((s) => {
          const p = read(s);
          return p["--x"] + "," + p["--y"];
        });
        assert.equal(new Set(places).size, places.length);
        for (const s of a) {
          const p = read(s);
          assert.match(p["--c"], /^var\(--(blue|blue-soft|leaf|leaf-deep)\)$/);
          assert.ok(parseInt(p["--d"]) >= 0);
          const size = parseFloat(p["--s"]);
          assert.ok(size === cell || (cell >= 8 && size === cell / 2));
        }
      },
    ),
  );
});

test("the veil covers every square once, starting at its corner", () => {
  fc.assert(
    fc.property(fc.integer(), fc.constantFrom(...corners), (seed, at) => {
      const d = veil(seed, at);
      assert.equal(d.length, 48);
      assert.ok(d.every((x) => x >= 0 && x % 40 === 0 && x <= 760));
      const corner = { tl: 0, tr: 7, bl: 40, br: 47 }[at];
      const far = { tl: 47, tr: 40, bl: 7, br: 0 }[at];
      assert.ok(d[corner] < d[far]);
    }),
  );
});

test("monograms draw two letters on a 5 x 7 grid", () => {
  const m = initials("МШ");
  assert.equal(m.w, 11);
  assert.ok(m.cells.every(([x, y]) => x >= 0 && x < 11 && y >= 0 && y < 7));
  assert.deepEqual(initials("АК"), initials("AK"));
  fc.assert(
    fc.property(fc.string({ maxLength: 4 }), (s) => {
      const { w, cells } = initials(s);
      assert.ok(cells.every(([x, y]) => x < Math.max(w, 0) + 1 && y < 7));
    }),
  );
});
