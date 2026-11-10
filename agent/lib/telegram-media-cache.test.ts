/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getTelegramMediaCacheEntry,
  saveTelegramMediaCacheEntry,
  TELEGRAM_MEDIA_CACHE_LIMIT,
} from "./telegram-media-cache.ts";
import { tempDir } from "../../scripts/fixtures/temp-dir.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixture() {
  const root = tempDir("iva-media-cache-test-");
  const dataDir = join(root, "data");
  const vaultDir = join(root, "vault");
  const attachment = join(vaultDir, "attachments", "2026-08-04", "photo.jpg");
  mkdirSync(join(vaultDir, "attachments", "2026-08-04"), { recursive: true });
  writeFileSync(attachment, "image");
  return { root, dataDir, vaultDir, attachment };
}

test("media cache misses, then reuses a valid attachment and derived text", async () => {
  const { dataDir, vaultDir } = fixture();
  assert.equal(
    await getTelegramMediaCacheEntry("photo-1", { dataDir, vaultDir }),
    null,
  );

  const entry = {
    path: "attachments/2026-08-04/photo.jpg",
    vision: "a whiteboard",
    transcript: "",
    at: 10,
  };
  await saveTelegramMediaCacheEntry("photo-1", entry, { dataDir });
  assert.deepEqual(
    await getTelegramMediaCacheEntry("photo-1", { dataDir, vaultDir }),
    entry,
  );
});

test("invalid entries, missing files and paths outside attachments are cache misses", async () => {
  const { root, dataDir, vaultDir, attachment } = fixture();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "media-cache.json"),
    JSON.stringify({
      malformed: { path: 42, at: "yesterday" },
      outside: { path: "../secret.txt", at: 2 },
      missing: { path: "attachments/2026-08-04/missing.jpg", at: 3 },
    }),
  );
  writeFileSync(join(root, "secret.txt"), "secret");

  for (const key of ["malformed", "outside", "missing"]) {
    assert.equal(
      await getTelegramMediaCacheEntry(key, { dataDir, vaultDir }),
      null,
    );
  }
  assert.equal(readFileSync(attachment, "utf8"), "image");
});

test("corrupt media cache is quarantined and recreated without blocking processing", async () => {
  const { dataDir, vaultDir } = fixture();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "media-cache.json"), "{broken");
  const logs: string[] = [];

  assert.equal(
    await getTelegramMediaCacheEntry("photo-1", {
      dataDir,
      vaultDir,
      log: (line) => logs.push(line),
    }),
    null,
  );
  await saveTelegramMediaCacheEntry(
    "photo-1",
    { path: "attachments/2026-08-04/photo.jpg", at: 10 },
    { dataDir, log: (line) => logs.push(line) },
  );
  assert.ok(logs.some((line) => line.includes("media-cache")));
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, "media-cache.json"), "utf8")),
    {
      "photo-1": { path: "attachments/2026-08-04/photo.jpg", at: 10 },
    },
  );
});

test("media cache keeps only the 500 newest entries", async () => {
  const { dataDir } = fixture();
  mkdirSync(dataDir, { recursive: true });
  const oversized = Object.fromEntries(
    Array.from({ length: TELEGRAM_MEDIA_CACHE_LIMIT + 1 }, (_, index) => [
      `old-${index}`,
      { path: `attachments/2026-08-04/${index}.jpg`, at: index },
    ]),
  );
  writeFileSync(join(dataDir, "media-cache.json"), JSON.stringify(oversized));

  await saveTelegramMediaCacheEntry(
    "newest",
    { path: "attachments/2026-08-04/photo.jpg", at: 10_000 },
    { dataDir },
  );
  const stored: unknown = JSON.parse(
    readFileSync(join(dataDir, "media-cache.json"), "utf8"),
  );
  assert.ok(isRecord(stored));
  assert.equal(Object.keys(stored).length, TELEGRAM_MEDIA_CACHE_LIMIT);
  assert.ok(stored.newest);
  assert.equal(stored["old-0"], undefined);
  assert.equal(stored["old-1"], undefined);
});
