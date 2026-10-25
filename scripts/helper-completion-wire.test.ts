/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
import "./fixtures/no-host-anthropic.ts";
import "./lib/ts-esm-hooks.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "eve/client";
import { wireTurn } from "./fixtures/helper-turn.test-fixture.ts";
import {
  foldHelperSnapshot,
  isHelperTerminalEvent,
} from "../agent/lib/helper-snapshot.ts";
import { runHelperTick } from "../agent/lib/helper-tick.ts";
import { OWNER_STARTED_AT } from "../agent/lib/schedule-runner.ts";
import * as s from "../agent/lib/helper-store.ts";
import {
  readHelperOutcome,
  noteHelperReply,
  finishHelperOutcomes,
  helperOutcomesMarkdown,
} from "../agent/lib/helper-outcome.ts";
import { createHelperOutcomeScan } from "./poller/helper-outcomes.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "fixture";

test("real eve completed stream crosses HTTP snapshot, deadline/restart and duplicate delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iva-helper-completion-"));
  const previous = { ...process.env };
  const actual = await wireTurn({ kind: "helper", calls: 50 });
  const events = actual.events;
  const folded = foldHelperSnapshot(events);
  assert.equal(folded.outcome, "done");
  assert.equal(folded.steps, 51);
  assert.equal(folded.tokens, 112);
  const calls: string[] = [];
  const requestedPaths: string[] = [];
  let stalledTail = false;
  let wireEvents = events;
  let tailScans = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    calls.push(url.pathname.split("/").at(-1)!);
    requestedPaths.push(url.pathname);
    if (url.pathname.endsWith("/stream")) {
      assert.ok([null, "1"].includes(url.searchParams.get("includeTailIndex")));
      if (url.searchParams.has("includeTailIndex")) tailScans++;
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-eve-stream-version": "25",
        "x-eve-stream-tail-index": String(
          wireEvents.length - 1 + Number(stalledTail),
        ),
      });
      // Exercise a split JSON line and UTF-8 decode through the real Client reader.
      const bytes = Buffer.from(
        wireEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      response.write(bytes.subarray(0, 17));
      if (stalledTail) response.write(bytes.subarray(17));
      else response.end(bytes.subarray(17));
    } else if (/\/(?:cancel|reset)$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "no_active_turn" }));
    } else {
      response.writeHead(500);
      response.end("unexpected fixture request");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const host = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, {
    ASSISTANT_HOST: host,
    ASSISTANT_BEARER: "fixture",
    ASSISTANT_DATA_DIR: dir,
    ASSISTANT_TIMEZONE: "UTC",
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    for (const key of [
      "ASSISTANT_HOST",
      "ASSISTANT_BEARER",
      "ASSISTANT_DATA_DIR",
      "ASSISTANT_TIMEZONE",
    ])
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    await rm(dir, { recursive: true, force: true });
  });
  const snapshot = await new Client({ host }).sessions
    .attach("fixture")
    .snapshot();
  assert.deepEqual(snapshot.events, JSON.parse(JSON.stringify(events)));
  assert.deepEqual(foldHelperSnapshot(snapshot.events), folded);
  const chat = { id: "42", threadId: null };
  const scan = createHelperOutcomeScan();
  const admitted: unknown[] = [];
  const admit = (update: unknown) => {
    admitted.push(update);
    return Promise.resolve("owned" as const);
  };
  await scan(admit);
  for (const old of [false, true]) {
    const added = await s.addHelper(
      { task: "fixture", may: "draft", chat },
      1000,
    );
    assert.ok(added.ok);
    const id = added.row.id;
    await s.claimHelper(
      id,
      { ownerStartedAt: OWNER_STARTED_AT - Number(old) },
      2000,
    );
    await s.recordHelperSession(id, 2000, "fixture");
    const now = 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS;
    await Promise.all([
      runHelperTick({ nowMs: now, log: () => {} }),
      runHelperTick({ nowMs: now, log: () => {} }),
    ]);
    const row = await s.getHelper(id);
    assert.equal(row?.outcome, "done");
    assert.equal(row?.steps, folded.steps);
    assert.equal(row?.tokens, folded.tokens);
    assert.equal(await readFile(s.helperResultPath(id), "utf8"), folded.text);
    await scan(admit);
    await scan(admit);
    assert.equal(admitted.length, 1 + Number(old));
    const key = { sessionId: `owner-${old}`, turnId: "turn" };
    const outcome = JSON.parse(await readHelperOutcome(id, chat, key)) as {
      outcome: unknown;
    };
    assert.equal(outcome.outcome, "done");
    noteHelperReply(key, "Fixture result delivered");
    await finishHelperOutcomes(key, now + 1);
    await runHelperTick({ nowMs: now + 2, log: () => {} });
    await scan(admit);
    assert.equal((await s.getHelper(id))?.deliveredAt, now + 1);
    assert.equal(await helperOutcomesMarkdown(chat), "");
    assert.equal(admitted.length, 1 + Number(old));
  }
  assert.ok(calls.includes("stream"));
  assert.ok(!calls.includes("session"));
  const added = await s.addHelper(
    { task: "stalled tail", may: "draft", chat },
    1000,
  );
  assert.ok(added.ok);
  await s.claimHelper(added.row.id, { ownerStartedAt: OWNER_STARTED_AT }, 2000);
  await s.recordHelperSession(added.row.id, 2000, "fixture");
  stalledTail = true;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(100));
  await runHelperTick({
    nowMs: 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
    log: () => {},
  });
  assert.equal((await s.getHelper(added.row.id))?.outcome, "done");
  assert.equal(
    await readFile(s.helperResultPath(added.row.id), "utf8"),
    folded.text,
  );
  const unfinished = await s.addHelper(
    { task: "incomplete prefix", may: "draft", chat },
    1000,
  );
  assert.ok(unfinished.ok);
  await s.claimHelper(
    unfinished.row.id,
    { ownerStartedAt: OWNER_STARTED_AT },
    2000,
  );
  await s.recordHelperSession(unfinished.row.id, 2000, unfinished.row.id);
  wireEvents = events.filter((event) => !isHelperTerminalEvent(event.type));
  await runHelperTick({ nowMs: 3000, log: () => {} });
  assert.ok((await s.getHelper(unfinished.row.id))?.run);
  assert.equal((await s.getHelper(unfinished.row.id))?.outcome, null);
  await runHelperTick({ nowMs: 2000 + s.HELPER_DEADLINE_MS, log: () => {} });
  assert.equal((await s.getHelper(unfinished.row.id))?.stop, "deadline");
  assert.ok(
    requestedPaths.some(
      (path) =>
        path.includes(`/${unfinished.row.id}/`) && path.endsWith("/cancel"),
    ),
  );
  await runHelperTick({
    nowMs: 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
    log: () => {},
  });
  assert.equal((await s.getHelper(unfinished.row.id))?.outcome, "deadline");
  assert.equal((await s.getHelper(unfinished.row.id))?.summary, folded.text);
  assert.equal((await s.getHelper(unfinished.row.id))?.steps, folded.steps);
  assert.equal((await s.getHelper(unfinished.row.id))?.tokens, folded.tokens);
  assert.equal(
    await readFile(s.helperResultPath(unfinished.row.id), "utf8"),
    folded.text,
  );
  for (const stop of ["restart", "closed", "ceiling"] as const) {
    const added = await s.addHelper({ task: stop, may: "draft", chat }, 1000);
    assert.ok(added.ok);
    await s.claimHelper(
      added.row.id,
      { ownerStartedAt: OWNER_STARTED_AT - Number(stop === "restart") },
      2000,
    );
    await s.recordHelperSession(added.row.id, 2000, added.row.id);
    if (stop === "closed") await s.closeHelper(added.row.id, chat, 2100);
    if (stop === "ceiling") await s.stopHelper(added.row.id, 2000, "ceiling");
    await runHelperTick({
      nowMs: 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
      log: () => {},
    });
    const row = await s.getHelper(added.row.id);
    assert.equal(
      row?.outcome,
      stop === "restart"
        ? "interrupted"
        : stop === "closed"
          ? "stopped"
          : "ceiling",
    );
    assert.equal(row?.steps, folded.steps);
    assert.equal(row?.tokens, folded.tokens);
    assert.equal(
      await readFile(s.helperResultPath(added.row.id), "utf8"),
      folded.text,
    );
  }
  wireEvents = [];
  const empty = await s.addHelper(
    { task: "empty abort", may: "draft", chat },
    1000,
  );
  assert.ok(empty.ok);
  await s.claimHelper(empty.row.id, { ownerStartedAt: OWNER_STARTED_AT }, 2000);
  await s.recordHelperSession(empty.row.id, 2000, empty.row.id);
  await runHelperTick({ nowMs: 2000 + s.HELPER_DEADLINE_MS, log: () => {} });
  assert.equal((await s.getHelper(empty.row.id))?.stop, null);
  assert.equal((await s.getHelper(empty.row.id))?.outcome, null);
  assert.ok(
    !requestedPaths.some(
      (path) => path.includes(`/${empty.row.id}/`) && path.endsWith("/cancel"),
    ),
  );
  await runHelperTick({
    nowMs: 2000 + s.HELPER_DEADLINE_MS + s.HELPER_GRACE_MS,
    log: () => {},
  });
  const emptyRow = await s.getHelper(empty.row.id);
  assert.equal(emptyRow?.outcome, "deadline");
  assert.equal(emptyRow?.summary, null);
  assert.equal(emptyRow?.steps, 0);
  assert.equal(emptyRow?.tokens, 0);
  await assert.rejects(readFile(s.helperResultPath(empty.row.id), "utf8"), {
    code: "ENOENT",
  });
  assert.equal(
    tailScans,
    1,
    "only the explicit snapshot probe scans the durable tail",
  );
});
