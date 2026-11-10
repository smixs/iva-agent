import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";
import { tmpdir } from "node:os";
import type { FormatSample } from "../fixtures/historical-smoke-formats.ts";
import { fc, smokeParameters } from "./pbt.ts";
import * as queue from "../lib/telegram-queue.ts";
import { createVersionStore, readActiveState } from "../lib/version-store.ts";
import { markUpdateRun, readUpdateRun } from "../lib/update-run-journal.ts";

const root = mkdtempSync(join(tmpdir(), "iva-smoke-formats-"));
// run-status resolves its directory at import, after the scenario's environment is set.
process.env.ASSISTANT_DATA_DIR = join(root, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const reminders = await import("../../agent/lib/reminder-store.ts");
const { readSettings, updateSettings } =
  await import("../../agent/lib/settings.ts");
const chat = await import("../../agent/lib/run-status.ts");
const NOW = Date.UTC(2026, 10, 1);
const corpus = JSON.parse(
  readFileSync(
    new URL("../fixtures/smoke-formats.json", import.meta.url),
    "utf8",
  ),
) as FormatSample[];
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
function put(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

await test("P-formats: every tagged writer survives read-write-read, supported unknown fields survive", async (t) => {
  let passed = false;
  t.after(() => {
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`P-formats evidence: ${root}`);
  });
  mock.timers.enable({ apis: ["Date"], now: NOW });
  t.after(() => mock.timers.reset());
  assert.equal(corpus.filter((s) => s.tag.startsWith("v0.5.")).length, 13);
  assert.ok(corpus.some((s) => s.journal !== null));
  const store = createVersionStore(join(root, "installation"));
  const name = "0.5.0-aaaaaaaaaaaa";
  const dir = store.stage(name);
  store.linkState(dir);
  store.complete(name);
  store.activate(name);
  const chatFile = join(
    root,
    "data/run-status.d",
    `${Buffer.from("42:").toString("base64url")}.json`,
  );
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 80 }).map((value) => "smoke " + value),
      fc.jsonValue(),
      fc.integer({ min: 1, max: 1000 }),
      async (text, unknown, count) => {
        for (const sample of corpus) {
          const label = sample.tag;
          const reminderFile = join(root, "reminders.json");
          const table = structuredClone(object(sample.reminders));
          const rows = table.rows as Record<string, unknown>[];
          rows[0].text = text;
          put(reminderFile, table);
          const first = await reminders.list(reminderFile);
          assert.deepEqual(
            first,
            rows,
            `${label}: reminder fields survive initial reading`,
          );
          await reminders.reschedule(
            first[0].id,
            { nowMs: first[0].nextRunAtMs },
            reminderFile,
          );
          assert.deepEqual(
            await reminders.list(reminderFile),
            first,
            `${label}: reminders`,
          );
          const queueFile = join(root, "queue.json");
          const doc = structuredClone(object(sample.queue));
          const items = object(doc.queues)["42:"] as Record<string, unknown>[];
          items[0].legacyText = text;
          items[0].futureField = unknown;
          put(queueFile, doc);
          const loaded = await queue.loadQueueFile(queueFile, { strict: true });
          await queue.writeQueueFileAtomic(queueFile, loaded.document);
          assert.deepEqual(
            (await queue.loadQueueFile(queueFile, { strict: true })).document,
            loaded.document,
            `${label}: queue`,
          );
          assert.equal(
            (await queue.loadQueueFile(queueFile, { strict: true })).document
              .queues["42:"][0].legacyText,
            text,
          );
          assert.deepEqual(
            json(queueFile),
            doc,
            `${label}: queue payload and unknown item fields`,
          );
          put(chatFile, {
            ...object(sample.chat),
            futureField: { value: unknown },
          });
          const beforeChat = chat.getChatStatus("42:");
          assert.ok(beforeChat);
          assert.deepEqual(beforeChat, {
            ...object(sample.chat),
            futureField: { value: unknown },
          });
          chat.setChatStatus("42:", { resetAt: count });
          assert.deepEqual(
            object(json(chatFile)).futureField,
            { value: unknown },
            `${label}: chat unknown fields`,
          );
          assert.equal(chat.getChatStatus("42:")?.resetAt, count);
          const activeFile = join(store.layout.data, "active.json");
          put(activeFile, sample.active);
          assert.equal(store.settled(), name, `${label}: active reader`);
          assert.deepEqual(readActiveState(activeFile), {
            kind: "valid",
            state: sample.active,
          });
          store.settle(name);
          assert.equal(store.settled(), name);
          assert.equal(readActiveState(activeFile).kind, "valid");
          if (sample.journal !== null) {
            put(join(root, "update-run.json"), sample.journal);
            const before = readUpdateRun(root);
            assert.ok(before);
            assert.deepEqual(before, sample.journal);
            markUpdateRun(root, before.version, before.phase);
            assert.deepEqual(readUpdateRun(root), before, `${label}: journal`);
          }
          const settingsFile = join(root, "settings.json");
          const settings = { ...object(sample.settings), futureField: unknown };
          put(settingsFile, settings);
          assert.deepEqual(readSettings(settingsFile), settings);
          updateSettings(
            (current) => ({ ...current, smokeText: text }),
            settingsFile,
          );
          assert.deepEqual(
            readSettings(settingsFile),
            { ...settings, smokeText: text },
            `${label}: settings unknown fields`,
          );
        }
      },
    ),
    smokeParameters(),
  );
  passed = true;
});

await test("P-formats: future schemas refuse without changing bytes; schema-free files preserve new fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-smoke-future-formats-"));
  let passed = false;
  try {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 1000 }), async (future) => {
        const reminderFile = join(dir, "reminders.json");
        put(reminderFile, {
          ...object(corpus[0].reminders),
          schemaVersion: future,
        });
        const reminderBytes = readFileSync(reminderFile);
        await assert.rejects(
          reminders.list(reminderFile),
          /newer|более новой/u,
        );
        await assert.rejects(
          reminders.add(
            {
              id: "r-new",
              text: "new",
              schedule: { kind: "at", atMs: NOW + 1000 },
            },
            { file: reminderFile },
          ),
          /newer|более новой/u,
        );
        assert.deepEqual(readFileSync(reminderFile), reminderBytes);
        for (const value of [{ version: future, queues: {} }]) {
          const file = join(dir, "queue.json");
          put(file, value);
          const bytes = readFileSync(file);
          await assert.rejects(
            queue.loadQueueFile(file, { strict: true }),
            /newer|более новой/u,
          );
          await assert.rejects(
            queue.writeQueueFileAtomic(file, value),
            /newer|более новой/u,
          );
          assert.deepEqual(readFileSync(file), bytes);
        }
        const home = join(dir, "install");
        const store = createVersionStore(home);
        const activeFile = join(store.layout.data, "active.json");
        put(activeFile, {
          ...object(corpus[0].active),
          schema: `iva-active/v${future}`,
        });
        const activeBytes = readFileSync(activeFile);
        assert.throws(() => store.settled());
        assert.deepEqual(readFileSync(activeFile), activeBytes);
        const futureJournal = {
          ...object(corpus.find((s) => s.journal !== null)!.journal),
          schema: `iva-update-run/v${future}`,
        };
        const file = join(dir, "update-run.json");
        put(file, futureJournal);
        const bytes = readFileSync(file);
        assert.equal(readUpdateRun(dir), null);
        markUpdateRun(dir, "0.5.0-aaaaaaaaaaaa", "done");
        assert.deepEqual(readFileSync(file), bytes);
      }),
      smokeParameters(),
    );
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
    else console.error(`P-formats evidence: ${dir}`);
  }
});
