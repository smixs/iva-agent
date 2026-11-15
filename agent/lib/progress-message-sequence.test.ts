// Random interleavings of the status message against a fake Telegram, checking the invariants of
// specs/ProgressMessage.tla on the real stream, the real record writers and the real deleter.
// Every Telegram call is held until the driver releases it, so a post, an edit and a delete can
// be in flight while the other turn starts, finishes, is reset or the process dies.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import fc from "fast-check";

const dataDir = mkdtempSync(join(tmpdir(), "iva-progress-sequence-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

const run = await import("./run-status.ts");
const draft = await import("./telegram-draft.ts");
const turnStart = await import("./telegram-turn-start.ts");
import type { StatusReply, StatusTransport } from "./outbox.ts";

const SEED = 1115006;
const RUNS = 80;
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

type Outcome = "ok" | "gone" | "wait" | "error" | "lost";
type Command =
  | { k: "start" | "final" | "finish" | "cancel"; t: 1 | 2 }
  | { k: "step"; t: 1 | 2; text: "A" | "B" | "C" }
  | { k: "foreign" | "crash" | "userDelete" }
  // warm: the turn starts, runs past the threshold and its first status lands;
  // edit: time passes and a new text lands as an edit.
  | { k: "warm" | "edit"; t: 1 | 2 }
  | { k: "advance"; ms: number }
  | { k: "release"; n: number }
  | { k: "answers"; list: Outcome[] };

// What the runs reached: a property that never posts proves nothing.
const reached = {
  send: 0,
  edit: 0,
  remove: 0,
  shown: 0,
  stale: 0,
  claimed: 0,
  leaky: 0,
};
const turnOf = (t: number) => `turn-${t}`;
const sessionOf = (run: number, t: number) => `seq-${run}-s${t}`;

let clock = 5_000_000;
mock.method(Date, "now", () => clock);

let runIndex = 0;
async function play(picks: readonly number[]): Promise<void> {
  const id = ++runIndex;
  const chatId = `${9000 + id}`;
  const key = run.chatKeyOf(chatId);
  const handle = {
    chatId,
    request: () => Promise.resolve({ ok: true, body: { ok: true } }),
  };
  // Telegram: the messages that exist, and the calls waiting for an answer.
  const msgs = new Set<number>();
  let nextId = 100;
  let epoch = 0;
  let leaky = false;
  let answers: Outcome[] = [];
  let answerAt = 0;
  const pending: Array<() => void> = [];
  const closed = new Set<number>();
  const sends = new Map<number, number>();
  const answered = new Set<number>();
  const staleSeen = new Set<number>();
  let lastId: number | undefined;
  const fail = (message: string) =>
    assert.fail(`${message} (seed ${SEED}, run ${id})`);

  const check = () => {
    const record = run.getChatStatus(key);
    const word = run.progressMessageOf(record);
    const now = record?.progressMessageId;
    if (word !== "none") reached[word]++;
    if (word === "stale" && now !== undefined) staleSeen.add(now);
    if (word === "shown" && now !== undefined && staleSeen.has(now))
      fail(`StaleIsFinal: id ${now} is live again`);
    if (lastId !== undefined && now === undefined && !answered.has(lastId))
      fail(`ClearOnlyByAnswer: id ${lastId} left the record unanswered`);
    lastId = now;
  };

  const transportOf = (t: number): StatusTransport => {
    const hold = (
      kind: "send" | "edit" | "remove",
      issue: () => void,
      answer: (outcome: Outcome, dead: boolean) => StatusReply,
    ) =>
      new Promise<StatusReply>((resolve, reject) => {
        reached[kind]++;
        issue();
        const born = epoch;
        pending.push(() => {
          const dead = born < epoch;
          // One answer per call, in the order planned; then Telegram answers ok.
          const outcome = answers[answerAt++] ?? "ok";
          const reply = answer(outcome, dead);
          if (dead || (reply as { lost?: boolean }).lost)
            reject(new Error("response lost"));
          else resolve(reply);
          check();
        });
      });
    const refuse = (status: number, description = "x"): StatusReply => ({
      ok: false,
      status,
      description,
    });
    return {
      send: (text, mode) =>
        hold(
          "send",
          () => {
            const record = run.getChatStatus(key);
            if (closed.has(t)) fail("NoStatusAfterFinal: post after close");
            if (run.progressMessageOf(record) !== "claimed")
              fail(
                `NoPostOverId: post with ${run.progressMessageOf(record)} record`,
              );
            if (record?.turnId !== turnOf(t)) fail("post by a foreign pair");
            sends.set(t, (sends.get(t) ?? 0) + 1);
            if ((sends.get(t) ?? 0) > 1) fail(`Once: turn ${t} posted twice`);
            assert.ok(text.length > 0 && mode === "html");
          },
          (outcome, dead) => {
            if (dead || outcome === "ok" || outcome === "lost") {
              msgs.add(++nextId);
              if (dead || outcome === "lost") leaky = true;
              return {
                ok: true,
                status: 200,
                result: { message_id: nextId },
                lost: dead || outcome === "lost",
              } as StatusReply;
            }
            return outcome === "wait"
              ? refuse(429)
              : outcome === "gone"
                ? refuse(403)
                : refuse(500);
          },
        ),
      edit: (messageId) =>
        hold(
          "edit",
          () => {
            const record = run.getChatStatus(key);
            if (closed.has(t)) fail("NoStatusAfterFinal: edit after close");
            if (record?.progressMessageId !== messageId)
              fail("edit of an id that is not the recorded one");
          },
          (outcome, dead) => {
            if (!msgs.has(messageId)) {
              answered.add(messageId);
              return refuse(400, "Bad Request: message to edit not found");
            }
            if (dead) return { ok: true, status: 200 };
            return outcome === "wait"
              ? refuse(429)
              : outcome === "error"
                ? refuse(500)
                : { ok: true, status: 200 };
          },
        ),
      remove: (messageId) =>
        hold(
          "remove",
          () => {
            const record = run.getChatStatus(key);
            if (record?.progressMessageId === messageId) {
              if (run.progressMessageOf(record) !== "stale")
                fail(
                  `NoDeleteLive: delete of ${messageId} while ${run.progressMessageOf(record)}`,
                );
            }
          },
          (outcome, dead) => {
            if (!msgs.has(messageId)) {
              answered.add(messageId);
              return refuse(400, "Bad Request: message to delete not found");
            }
            const frame =
              run.getChatStatus(key)?.progressMessageId !== messageId;
            if (dead) {
              msgs.delete(messageId);
              return { ok: true, status: 200 };
            }
            if (outcome === "wait" || outcome === "error") {
              if (frame) leaky = true;
              return outcome === "wait" ? refuse(429) : refuse(500);
            }
            msgs.delete(messageId);
            if (outcome === "lost") {
              return { ok: true, status: 200, lost: true } as StatusReply;
            }
            answered.add(messageId);
            return { ok: true, status: 200 };
          },
        ),
    };
  };

  // eve runs the events of one session in order: one chain per session.
  const chains = new Map<number, Promise<void>>();
  const started = new Set<number>();
  const finished = new Set<number>();
  // A finish queued behind a crash never runs: the turn is still open, and its record waits for the reaper.
  const ran = new Set<number>();
  const enqueue = (t: number, fn: () => Promise<void>) => {
    const born = epoch;
    chains.set(
      t,
      (chains.get(t) ?? Promise.resolve())
        .then(() => (born === epoch ? fn() : undefined))
        .catch(() => undefined),
    );
  };
  const streamOf = (t: number) =>
    draft.telegramDraftTurn(handle, sessionOf(id, t), turnOf(t), false);
  const finishOf = (t: number, mode: "completed" | "cancelled" | "failed") => {
    closed.add(t);
    finished.add(t);
    enqueue(t, async () => {
      ran.add(t);
      await draft.finishTelegramStatus(
        { telegram: handle, statusTransport: transportOf(t) },
        sessionOf(id, t),
        mode,
        turnOf(t),
      );
    });
  };

  const apply = (command: Command) => {
    switch (command.k) {
      case "start": {
        const t = command.t;
        if (started.has(t)) return;
        started.add(t);
        enqueue(t, async () => {
          await draft.retireProgressMessage(key, transportOf(t));
          const draftId = 41 + t;
          const published = await turnStart.publishTelegramTurnStarted({
            chatKey: key,
            sessionId: sessionOf(id, t),
            turnId: turnOf(t),
            draftId,
            getStatusImpl: run.getChatStatus,
            setStatusIfImpl: run.setChatStatusIf,
          });
          draft.telegramDraftTurn(
            handle,
            sessionOf(id, t),
            turnOf(t),
            false,
            { sessionId: sessionOf(id, t), turnId: turnOf(t), draftId },
            published,
          );
        });
        return;
      }
      case "step": {
        const t = command.t;
        enqueue(t, async () => {
          const stream = streamOf(t);
          if (!stream) return;
          stream.completeStep(0, command.text);
          await stream.status(0, command.text, transportOf(t));
        });
        return;
      }
      case "final":
        closed.add(command.t);
        enqueue(command.t, async () => {
          await draft.closeTelegramDraftChat(
            handle,
            sessionOf(id, command.t),
            turnOf(command.t),
          );
        });
        return;
      case "finish":
        return finishOf(command.t, "completed");
      case "cancel":
        return finishOf(command.t, "cancelled");
      case "foreign":
        // The Bridge reset or reap: the turn fields go, from another process.
        run.setChatStatus(key, { status: "idle", ...run.TURN_FIELDS_CLEARED });
        return;
      case "crash":
        epoch++;
        chains.clear();
        for (const t of [1, 2])
          void draft.closeTelegramDraftTurn(
            sessionOf(id, t),
            undefined,
            0,
            true,
          );
        for (const t of started) closed.delete(t);
        return;
      case "advance":
        clock += command.ms;
        return;
      case "release": {
        const next = pending.splice(
          command.n % Math.max(1, pending.length),
          1,
        )[0];
        next?.();
        return;
      }
      case "userDelete":
        // The person deletes the status message in the chat.
        msgs.delete([...msgs][0]);
        return;
      case "warm":
      case "edit":
        // Macros are run by the driver, which can await: see below.
        return;
      case "answers":
        answers = command.list;
        answerAt = 0;
        return;
    }
  };

  const settle = async () => {
    for (let spin = 0; spin < 400; spin++) {
      await immediate();
      const next = pending.shift();
      if (!next) {
        await immediate();
        if (pending.length === 0) return;
      } else next();
    }
    fail("the sequence did not settle");
  };

  try {
    let crashed = false;
    for (const pick of picks) {
      // The driver picks among the commands enabled now, so that a run reaches posts, edits and deletes.
      const options: Command[] = [];
      const times = (n: number, command: Command) => {
        for (let i = 0; i < n; i++) options.push(command);
      };
      for (const t of [1, 2] as const) {
        if (!started.has(t)) {
          times(2, { k: "start", t });
          times(6, { k: "warm", t });
        } else if (!finished.has(t)) {
          for (const text of ["A", "B", "C"] as const)
            times(3, { k: "step", t, text });
          times(4, { k: "edit", t });
          times(2, { k: "final", t });
          times(1, { k: "finish", t });
          times(1, { k: "cancel", t });
        }
      }
      for (const ms of [0, 1000, 6000, 6000, 70_000, 70_000])
        times(3, { k: "advance", ms });
      if (pending.length > 0)
        for (const n of [0, 0, 1, 2]) times(5, { k: "release", n });
      options.push({ k: "foreign" });
      if (msgs.size > 0) options.push({ k: "userDelete" });
      if (!crashed) options.push({ k: "crash" });
      for (const list of [
        [],
        ["error"],
        ["wait"],
        ["gone"],
        ["lost"],
        ["ok", "error"],
      ] as Outcome[][])
        options.push({ k: "answers", list });
      const command = options[pick % options.length];
      if (command.k === "crash") crashed = true;
      if (command.k === "warm" || command.k === "edit") {
        const t = command.t;
        const macro: Command[] =
          command.k === "warm"
            ? [
                { k: "start", t },
                { k: "advance", ms: 70_000 },
                { k: "step", t, text: "A" },
              ]
            : [
                { k: "advance", ms: 6000 },
                { k: "step", t, text: (["A", "B", "C"] as const)[pick % 3] },
              ];
        for (const part of macro) {
          apply(part);
          await immediate();
          check();
        }
        // Half of the macros leave their call in flight; the others get Telegram's answer.
        for (let i = 0; i < 3 && pending.length > 0 && pick % 2 === 0; i++) {
          apply({ k: "release", n: 0 });
          await immediate();
          check();
        }
        continue;
      }
      apply(command);
      await immediate();
      check();
    }
    // Telegram answers from now on; every started turn ends; the next turn.started comes.
    answers = [];
    await settle();
    for (const t of started)
      if (!ran.has(t)) {
        closed.delete(t);
        finishOf(t, "completed");
      }
    await settle();
    const trigger = draft.retireProgressMessage(key, transportOf(1));
    await settle();
    await trigger;
    const record = run.getChatStatus(key);
    if (run.progressMessageOf(record) === "stale")
      fail("EventuallyGone: a stale id outlived the next trigger");
    if (leaky) reached.leaky++;
    if (!leaky && msgs.size > 0)
      fail(
        `NoOrphanWithoutCrash: messages ${[...msgs].join(", ")} outlived their turns`,
      );
  } finally {
    for (const t of [1, 2])
      await draft.closeTelegramDraftTurn(sessionOf(id, t), undefined, 0, true);
  }
}

await test(`status message: random interleavings keep the invariants of ProgressMessage.tla (seed ${SEED})`, async () => {
  const silence = console.error;
  console.error = () => {};
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(10_000), { minLength: 25, maxLength: 80 }),
        play,
      ),
      { seed: SEED, numRuns: RUNS, endOnFailure: false },
    );
  } finally {
    console.error = silence;
  }
  for (const [name, count] of Object.entries(reached))
    assert.ok(
      count >= (name === "leaky" ? 3 : 20),
      `the runs reached ${name} only ${count} times`,
    );
});

// Anchors: the counterexamples the mutants of the model produce, as plain scenarios.
await test("a late answer of an old delete never erases a newer id (clear by value)", async () => {
  const key = run.chatKeyOf("9100");
  const handle = {
    chatId: "9100",
    request: () => Promise.resolve({ ok: true, body: {} }),
  };
  void handle;
  run.setChatStatus(key, { status: "idle", progressMessageId: 1 });
  let release!: (reply: StatusReply) => void;
  const held = new Promise<StatusReply>((resolve) => {
    release = resolve;
  });
  const slow: StatusTransport = {
    send: () => Promise.reject(new Error("unused")),
    edit: () => Promise.reject(new Error("unused")),
    remove: () => held,
  };
  const old = draft.retireProgressMessage(key, slow);
  await immediate();
  // meanwhile another deleter finished and a new message was recorded
  run.setChatStatus(key, { progressMessageId: 2 });
  release({
    ok: false,
    status: 400,
    description: "message to delete not found",
  });
  await old;
  assert.equal(run.getChatStatus(key)?.progressMessageId, 2);
});

await test("the deleter never touches a shown, claimed or absent id", async () => {
  const calls: number[] = [];
  const t: StatusTransport = {
    send: () => Promise.reject(new Error("unused")),
    edit: () => Promise.reject(new Error("unused")),
    remove: (id) => {
      calls.push(id);
      return Promise.resolve({ ok: true, status: 200 });
    },
  };
  for (const [name, patch] of [
    ["shown", { progressClaimed: true, progressMessageId: 5 }],
    ["claimed", { progressClaimed: true }],
    ["none", {}],
  ] as const) {
    const key = run.chatKeyOf(`9101-${name}`);
    run.setChatStatus(key, {
      status: "running",
      sessionId: "s",
      turnId: "t",
      ...patch,
    });
    await draft.retireProgressMessage(key, t);
  }
  assert.deepEqual(calls, []);
});

await test("a closed stream makes no status call", async () => {
  const key = run.chatKeyOf("9102");
  run.setChatStatus(key, {
    status: "running",
    sessionId: "s9102",
    turnId: "t",
    draftId: 3,
    turnAt: clock - 10 * draft.PROGRESS_MIN_TURN_MS,
  });
  const stream = draft.telegramDraftTurn(
    { chatId: "9102", request: () => Promise.resolve({ ok: true, body: {} }) },
    "s9102",
    "t",
    false,
    { sessionId: "s9102", turnId: "t", draftId: 3 },
  );
  assert.ok(stream);
  await stream.close();
  const calls: string[] = [];
  const t: StatusTransport = {
    send: () => (
      calls.push("send"),
      Promise.resolve({ ok: true, status: 200, result: { message_id: 1 } })
    ),
    edit: () => (
      calls.push("edit"),
      Promise.resolve({ ok: true, status: 200 })
    ),
    remove: () => (
      calls.push("remove"),
      Promise.resolve({ ok: true, status: 200 })
    ),
  };
  stream.completeStep(0, "late");
  await stream.status(0, "late", t);
  assert.deepEqual(calls, []);
  await draft.closeTelegramDraftTurn("s9102", undefined, 0, true);
});

// Anchors for NoStatusAfterFinal and NoPostOverId: a shown or stale record on a running turn.
function runningStream(chatId: string) {
  const key = run.chatKeyOf(chatId);
  const session = `s${chatId}`;
  run.setChatStatus(key, {
    status: "running",
    sessionId: session,
    turnId: "t",
    draftId: 3,
    turnAt: clock - 10 * draft.PROGRESS_MIN_TURN_MS,
  });
  const stream = draft.telegramDraftTurn(
    { chatId, request: () => Promise.resolve({ ok: true, body: {} }) },
    session,
    "t",
    false,
    { sessionId: session, turnId: "t", draftId: 3 },
  );
  assert.ok(stream);
  const calls: string[] = [];
  const t: StatusTransport = {
    send: () => (
      calls.push("send"),
      Promise.resolve({ ok: true, status: 200, result: { message_id: 9 } })
    ),
    edit: () => (
      calls.push("edit"),
      Promise.resolve({ ok: true, status: 200 })
    ),
    remove: () => (
      calls.push("remove"),
      Promise.resolve({ ok: true, status: 200 })
    ),
  };
  return { key, session, stream, calls, t };
}

await test("an edit never starts after the stream is closed", async () => {
  const { key, session, stream, calls, t } = runningStream("9103");
  run.setChatStatus(key, { progressClaimed: true, progressMessageId: 9 });
  clock += 10 * draft.STATUS_EDIT_MIN_MS;
  await stream.close();
  stream.completeStep(0, "after the final");
  await stream.status(0, "after the final", t);
  assert.deepEqual(calls, []);
  await draft.closeTelegramDraftTurn(session, undefined, 0, true);
});

await test("a status is never posted over an id that is still in the record", async () => {
  const { key, session, stream, calls, t } = runningStream("9104");
  run.setChatStatus(key, { progressMessageId: 9 });
  assert.equal(run.progressMessageOf(run.getChatStatus(key)), "stale");
  stream.completeStep(0, "new turn");
  await stream.status(0, "new turn", t);
  assert.deepEqual(calls, []);
  assert.equal(run.getChatStatus(key)?.progressClaimed, undefined);
  await draft.closeTelegramDraftTurn(session, undefined, 0, true);
});

await test("close returns the later of the draft pause and the status pause", async () => {
  const { key, session, stream, t } = runningStream("9106");
  run.setChatStatus(key, { progressClaimed: true, progressMessageId: 9 });
  clock += 10 * draft.STATUS_EDIT_MIN_MS;
  const limited: StatusTransport = {
    ...t,
    edit: () =>
      Promise.resolve({
        ok: false,
        status: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 3 },
      }),
  };
  stream.completeStep(0, "new text");
  await stream.status(0, "new text", limited);
  assert.equal(await stream.close(0), clock + 3_000);
  await draft.closeTelegramDraftTurn(session, undefined, 0, true);
});
