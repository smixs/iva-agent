import test from "node:test";
import assert from "node:assert/strict";
import {
  compactionThreshold,
  compactionThresholdPercent,
} from "./compaction.ts";

// Порог свёртки — решение владельца 24.10.2026: T = min(300 000, ⌊0,8·W⌋).
// Тест держит обе части формулы на реальных окнах провайдеров.
test("compactionThreshold: минимум из 80% окна и 300 тыс.", () => {
  assert.equal(compactionThreshold(131_072), 104_857); // 0.8·131072 = 104857.6
  assert.equal(compactionThreshold(272_000), 217_600); // окно Codex
  assert.equal(compactionThreshold(200_000), 160_000); // старые Claude
  assert.equal(compactionThreshold(1_000_000), 300_000); // потолок владельца
  assert.equal(compactionThreshold(500_000), 300_000); // уже за потолком
});

test("compactionThresholdPercent: доля окна, которую eve применяет к W модели", () => {
  assert.equal(compactionThresholdPercent(272_000), 0.8);
  // ⌊0,8·W⌋/W и ⌊·⌋ на обратном пути возвращают порог eve ровно.
  assert.equal(
    Math.floor(compactionThresholdPercent(131_072) * 131_072),
    104_857,
  );
  // За потолком 300 тыс. доля падает: thresholdPercent·W обязана вернуть порог ровно.
  assert.equal(
    Math.floor(compactionThresholdPercent(1_000_000) * 1_000_000),
    300_000,
  );
  assert.equal(
    Math.floor(compactionThresholdPercent(500_000) * 500_000),
    300_000,
  );
});
