/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fastForwardOffset, loadOffset, saveOffset } from "./poller/offset.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

type Call = unknown[];

test("corrupt JSON fails closed before getUpdates(-1)", async () => {
  const dir = tempDir("iva-offset-corrupt-test-");
  const file = join(dir, "telegram-offset.json");
  writeFileSync(file, "{broken");
  let getUpdatesCalls = 0;

  await assert.rejects(async () => {
    const loaded = await loadOffset({ file });
    if (loaded.offset === null) {
      await fastForwardOffset({
        tgImpl: async () => {
          getUpdatesCalls++;
          return { ok: true, result: [] };
        },
      });
    }
  }, /failed to load Telegram offset/u);
  assert.equal(getUpdatesCalls, 0);
  assert.equal(readFileSync(file, "utf8"), "{broken");
});

test("ENOENT is the only first-run path and fast-forwards to the Telegram tail", async () => {
  const dir = tempDir("iva-offset-first-run-test-");
  const file = join(dir, "telegram-offset.json");
  assert.deepEqual(await loadOffset({ file }), {
    offset: null,
    delivered: null,
  });

  const calls: Call[] = [];
  const offset = await fastForwardOffset({
    tgImpl: async (method, body) => {
      calls.push([method, body]);
      return { ok: true, result: [{ update_id: 40 }, { update_id: 41 }] };
    },
  });
  assert.equal(offset, 42);
  assert.deepEqual(calls, [["getUpdates", { offset: -1, timeout: 0 }]]);
});

test("first-run fast-forward propagates Telegram and response-shape failures", async () => {
  for (const tgImpl of [
    async () => {
      throw new Error("network down");
    },
    async () => ({ ok: false, description: "Telegram unavailable" }),
    async () => ({ ok: true, result: null }),
    async () => ({ ok: "true", result: [] }),
    async () => ({ ok: true, result: [{}] }),
    async () => ({ ok: true, result: [{ update_id: null }] }),
    async () => ({ ok: true, result: [{ update_id: "41" }] }),
    async () => ({ ok: true, result: [{ update_id: -1 }] }),
    async () => ({
      ok: true,
      result: [{ update_id: Number.MAX_SAFE_INTEGER }],
    }),
  ]) {
    const logs = [];
    await assert.rejects(
      fastForwardOffset({
        tgImpl,
        logImpl: (...args) => logs.push(args.join(" ")),
      }),
      /failed to fast-forward Telegram offset/u,
    );
    assert.equal(logs.length, 1);
  }
});

test("saveOffset propagates the canonical durable-write failure", async () => {
  const dataDir = tempDir("iva-offset-write-error-test-");
  const file = join(dataDir, "telegram-offset-test.json");
  const calls: Call[] = [];
  await assert.rejects(
    saveOffset(42, 41, {
      file,
      writeFileImpl: async (path, _data, options) => {
        calls.push(["write", path, options]);
        throw new Error("injected write failure");
      },
    }),
    /injected write failure/u,
  );
  assert.deepEqual(calls, [["write", file, { mode: 0o600 }]]);
});

test("saveOffset delegates one private replacement to the canonical primitive", async () => {
  const dir = tempDir("iva-offset-save-test-");
  const file = join(dir, "telegram-offset.json");
  const calls: Call[] = [];
  const { writeFileAtomic } = await import("#lib/fs-atomic.ts");
  const writeFileImpl: typeof writeFileAtomic = async (path, data, options) => {
    calls.push(["write", path, options]);
    await writeFileAtomic(path, data, options);
  };
  await saveOffset(42, 41, {
    file,
    writeFileImpl,
  });
  assert.deepEqual(calls, [["write", file, { mode: 0o600 }]]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    offset: 42,
    delivered: 41,
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
