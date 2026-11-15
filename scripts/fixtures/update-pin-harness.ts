import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createVersionStore } from "../lib/version-store.ts";
import { finishVersionUpdate } from "../lib/version-update.ts";
import {
  beginUpdateRun,
  readUpdateRun,
  markUpdateRun,
} from "../lib/update-run-journal.ts";
export async function assertPinnedFinal(): Promise<void> {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1) });
  const savedEnv = { ...process.env };
  const root = mkdtempSync(
    join(process.env.TMPDIR ?? "/tmp", "settled-before-pin-"),
  );
  const home = join(root, "iva");
  mkdirSync(home);
  const OLD = "0.5.11-aaaaaaaaaaaa",
    NEW = "0.5.12-bbbbbbbbbbbb";
  const data = join(home, "data");
  process.env.ASSISTANT_DATA_DIR = data;
  process.env.AGENT_LANGUAGE = "en";
  process.env.TELEGRAM_BOT_TOKEN = "fixture";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const previousFetch = globalThis.fetch;
  try {
    writeFileSync(
      join(home, ".env"),
      `MODEL_PROVIDER=ollama\nASSISTANT_DATA_DIR=${data}\n`,
    );
    const store = createVersionStore(home);
    for (const name of [OLD, NEW]) {
      const dir = store.stage(name);
      mkdirSync(join(dir, ".output"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "iva",
          version: name.slice(0, 6),
          type: "module",
        }),
      );
      store.linkState(dir);
      store.complete(name);
    }
    store.activate(OLD);
    store.settle(OLD);
    store.activate(NEW);
    beginUpdateRun(data, {
      version: NEW,
      from: OLD,
      units: [
        {
          unit: "iva.service",
          loadState: "loaded",
          active: true,
          enabled: true,
        },
      ],
      quarantine: [],
    });
    // Stop exactly at the active.json commit. All preceding update code is real.
    const boundaryStore = {
      ...store,
      settle: () => {
        throw new Error("CUT_BEFORE_ACTIVE_JSON_COMMIT");
      },
    };
    await assert.rejects(
      finishVersionUpdate({
        home,
        name: NEW,
        store: boundaryStore,
        run: () => Promise.resolve({ code: 0, output: "" }),
        serving: () => Promise.resolve({ ok: true, log: "fixture answered" }),
      }),
      /CUT_BEFORE_ACTIVE_JSON_COMMIT/,
    );
    assert.equal(store.settled(), OLD);
    console.log(
      JSON.stringify({
        boundary: "before store.settle",
        current: store.currentName(),
        pinned: store.settled(),
        journalPhase: readUpdateRun(data)?.phase,
      }),
    );
    const jobs = join(data, "update-jobs");
    mkdirSync(jobs, { recursive: true });
    const job = join(jobs, "boundary.json");
    writeFileSync(
      job,
      JSON.stringify({
        chatId: 42,
        messageId: 100,
        locale: "en",
        startedAt: new Date(Date.now() - 120000).toISOString(),
        currentAtStart: OLD,
      }),
    );
    writeFileSync(job + ".retried", "");
    const messages: string[] = [];
    globalThis.fetch = (_url, init) => {
      assert.equal(typeof init?.body, "string");
      const body = JSON.parse(init!.body as string) as {
        rich_message?: { markdown?: string };
        text?: string;
      };
      messages.push(body.rich_message?.markdown ?? body.text ?? "");
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 100 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const { reconcileUpdateJobs } = await import("../poller/update-flow.ts");
    await Promise.all(
      await reconcileUpdateJobs({
        root: join(home, "current"),
        tickMs: 1,
        graceMs: 0,
        launchImpl: () => Promise.resolve({ ok: false, msg: "no launch" }),
      }),
    );
    assert.ok(
      !messages.some((t) => t.includes("Iva updated")),
      JSON.stringify(messages),
    );
    assert.ok(
      existsSync(job),
      "FinalOnlyWhenPinned: unfinished job remains owned",
    );
    assert.equal(store.settled(), OLD);
    console.log(
      JSON.stringify({
        final: messages.find((t) => t.includes("Iva updated")),
        jobRemoved: !existsSync(job),
        pinned: store.settled(),
      }),
    );

    assert.notEqual(
      readUpdateRun(data)?.phase,
      "settled",
      "FinalOnlyWhenPinned: journal must not announce success before active.json",
    );
    store.settle(NEW);
    markUpdateRun(data, NEW, "settled", {
      outcome: { status: "updated", before: OLD, after: NEW },
    });
    await Promise.all(
      await reconcileUpdateJobs({
        root: join(home, "current"),
        tickMs: 1,
        graceMs: 0,
        launchImpl: () => Promise.resolve({ ok: false, msg: "no launch" }),
      }),
    );
    assert.ok(
      messages.some((t) => t.includes("Iva updated")),
      JSON.stringify(messages),
    );
    assert.ok(!existsSync(job));
    console.log(
      JSON.stringify({
        finalAfterPin: true,
        pinned: store.settled(),
        jobRemoved: !existsSync(job),
      }),
    );
  } finally {
    mock.timers.reset();
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
}
