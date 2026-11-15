import test from "node:test";
import assert from "node:assert/strict";
import { parseOffsetFile, serializeOffsetFile } from "./offset-store.ts";

void test("round-trip offset", () => {
  assert.deepEqual(parseOffsetFile(serializeOffsetFile(42)), { offset: 42 });
  assert.throws(() => parseOffsetFile("garbage"), SyntaxError);
});

// specs/UpdateFloor.tla: Served. Releases before 0.3.24 moved `delivered`, and the value
// rode along in the file of every installation that came from them.
void test("a file that still carries delivered is read by its offset", () => {
  for (const raw of [
    '{"offset":7,"delivered":41}',
    '{"offset":7,"delivered":null}',
    '{"offset":7,"delivered":"7"}',
  ])
    assert.deepEqual(parseOffsetFile(raw), { offset: 7 });
});

void test("невалидные значения делают существующий файл невалидным", () => {
  for (const raw of [
    "[]",
    "{}",
    '{"offset":1.5}',
    '{"offset":9007199254740992}',
    '{"offset":-1}',
    '{"offset":"7"}',
  ]) {
    assert.throws(() => parseOffsetFile(raw), /invalid schema/u);
  }
});
