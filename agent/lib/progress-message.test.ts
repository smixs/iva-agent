// The status message of a long turn (specs/ProgressMessage.tla): the state word of the chat
// record, the Outbox seam of post, edit and delete, and the writers that must not erase the id.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";

const dataDir = mkdtempSync(join(tmpdir(), "iva-progress-message-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

const runStatus = await import("./run-status.ts");
const turnStart = await import("./telegram-turn-start.ts");
const {
  deleteStatusThroughOutbox,
  editStatusThroughOutbox,
  postStatusThroughOutbox,
} = await import("./outbox.ts");
import type { StatusReply, StatusTransport } from "./outbox.ts";

const SECRET = `sk-${"a".repeat(24)}`;

// ── progressMessageOf ─────────────────────────────────────────────────────────────────────
await test("progressMessageOf is total and stale means an id without a claim (seed 1115001)", () => {
  const anything = fc.anything({ withNullPrototype: false });
  fc.assert(
    fc.property(
      fc.record(
        {
          progressClaimed: fc.oneof(fc.constant(true), anything),
          progressMessageId: fc.oneof(fc.integer(), anything),
        },
        { requiredKeys: [] },
      ),
      (record) => {
        const word = runStatus.progressMessageOf(record);
        assert.ok(["none", "claimed", "shown", "stale"].includes(word));
        const claimed = record.progressClaimed === true;
        const posted =
          typeof record.progressMessageId === "number" &&
          !Number.isNaN(record.progressMessageId);
        assert.equal(word === "stale", posted && !claimed);
        assert.equal(word === "shown", posted && claimed);
        assert.equal(word === "claimed", !posted && claimed);
        assert.equal(word === "none", !posted && !claimed);
      },
    ),
    { seed: 1115001, numRuns: 500 },
  );
  assert.equal(runStatus.progressMessageOf(null), "none");
  assert.equal(runStatus.progressMessageOf(undefined), "none");
});

await test("the four combinations of the claim and the id are all legal records", () => {
  for (const [claimed, id, word] of [
    [false, false, "none"],
    [true, false, "claimed"],
    [true, true, "shown"],
    [false, true, "stale"],
  ] as const) {
    const key = `legal-${word}:`;
    const record = runStatus.setChatStatus(key, {
      status: "running",
      sessionId: "s",
      turnId: "t",
      ...(claimed ? { progressClaimed: true } : {}),
      ...(id ? { progressMessageId: 7 } : {}),
    });
    assert.equal(runStatus.chatRecordViolations(record).length, 0);
    assert.equal(
      runStatus.progressMessageOf(runStatus.getChatStatus(key)),
      word,
    );
  }
});

// ── the id is a mark: no writer that clears turn fields removes it ───────────────────────
await test("no patch that clears the turn fields removes progressMessageId (seed 1115002)", () => {
  assert.ok(!("progressMessageId" in runStatus.TURN_FIELDS_CLEARED));
  const patches: Array<[string, Record<string, unknown>]> = [
    [
      "TURN_FIELDS_CLEARED",
      { status: "idle", ...runStatus.TURN_FIELDS_CLEARED },
    ],
    [
      "chatTakeOverPatch",
      turnStart.chatTakeOverPatch({ sessionId: "s2" }),
    ],
    [
      "chatTakeOverPatch (ingress)",
      turnStart.chatTakeOverPatch({ ingressId: "i2", ingressAt: 5 }),
    ],
    [
      "reset",
      {
        status: "idle",
        ...runStatus.TURN_FIELDS_CLEARED,
        wasCancelled: null,
        retiredSessionId: null,
        restartRetryData: null,
        ...runStatus.QUEUED_STATUS_CLEARED,
        resetAt: 5,
      },
    ],
    [
      "reap",
      {
        status: "idle",
        ...runStatus.TURN_FIELDS_CLEARED,
        wasCancelled: null,
        ...runStatus.QUEUED_STATUS_CLEARED,
        resetAt: 9,
        restartRetryData: "x",
      },
    ],
  ];
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 31 }),
      fc.boolean(),
      fc.constantFrom(...patches),
      (id, claimed, [, patch]) => {
        const key = `mark-${id}-${claimed}:`;
        runStatus.setChatStatus(key, {
          status: "running",
          sessionId: "s",
          turnId: "t",
          draftId: 3,
          turnAt: 1,
          ...(claimed ? { progressClaimed: true } : {}),
          progressMessageId: id,
        });
        runStatus.setChatStatus(key, patch);
        const after = runStatus.getChatStatus(key);
        assert.equal(after?.progressMessageId, id);
        assert.equal(after?.progressClaimed, undefined);
        assert.equal(runStatus.progressMessageOf(after), "stale");
      },
    ),
    { seed: 1115002, numRuns: 150 },
  );
});

await test("startup recovery of a retired compacting record keeps progressMessageId (seed 1115007)", async () => {
  const { rewriteRunStatusesForUpdate } =
    await import("../../scripts/lib/wf-store.ts");
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 2 ** 31 }),
      fc.boolean(),
      (id, claimed) => {
        const key = `recover-${id}-${claimed}:`;
        // Запись свёртки версии до 24.10.2026: такие файлы могут остаться на диске после
        // обновления — карантин их тихо гасит (см. wf-store.ts).
        runStatus.setChatStatus(key, {
          status: "running",
          sessionId: "s",
          compacting: true,
          ...(claimed ? { progressClaimed: true } : {}),
          progressMessageId: id,
        } as never);
        rewriteRunStatusesForUpdate(dataDir, true);
        const after = runStatus.getChatStatus(key);
        assert.equal(after?.status, "idle");
        assert.equal(after?.progressMessageId, id);
        assert.equal(runStatus.progressMessageOf(after), "stale");
      },
    ),
    { seed: 1115007, numRuns: 40 },
  );
});

await test("a change of the pair keeps the id while the legacy indicator traces are dropped", () => {
  const key = "pair-change:";
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s",
    turnId: "t1",
    progressClaimed: true,
    progressMessageId: 11,
    statusMessageId: 5,
  } as never);
  runStatus.setChatStatus(key, { turnId: "t2", progressClaimed: null });
  const after = runStatus.getChatStatus(key) as Record<string, unknown>;
  assert.equal(after.progressMessageId, 11);
  assert.equal(after.statusMessageId, undefined);
});

// ── the seam ────────────────────────────────────────────────────────────────────────────────
type Wire = {
  method: "send" | "edit" | "remove";
  text?: string;
  id?: number;
  mode?: string;
};
function transport(reply: (wire: Wire, index: number) => StatusReply | Error) {
  const wires: Wire[] = [];
  const answer = (wire: Wire): Promise<StatusReply> => {
    wires.push(wire);
    const r = reply(wire, wires.length - 1);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  const t: StatusTransport = {
    send: (text, mode) => answer({ method: "send", text, mode }),
    edit: (id, text, mode) => answer({ method: "edit", id, text, mode }),
    remove: (id) => answer({ method: "remove", id }),
  };
  return { wires, t };
}
const okReply = (id = 42): StatusReply => ({
  ok: true,
  status: 200,
  result: { message_id: id },
});
const refused = (
  status: number,
  description = "",
  extra = {},
): StatusReply => ({
  ok: false,
  status,
  description,
  ...extra,
});

const arbText = fc.oneof(
  fc.string({
    unit: fc.constantFrom(...'ab *_#|`[]()~$&\\<>"\n', "я", "😀"),
    maxLength: 600,
  }),
  fc.string({
    unit: fc.constantFrom("a", "<", "&", "я", "\n"),
    minLength: 4000,
    maxLength: 14_000,
  }),
  fc.constantFrom("", "   ", "\n\n", "```", "| a |\n| - |\n| b |"),
);

await test("the seam sends any text as exactly one plain-HTML message of at most 4096 characters (seed 1115003)", async () => {
  await fc.assert(
    fc.asyncProperty(arbText, fc.boolean(), async (text, edit) => {
      const { wires, t } = transport(() => okReply());
      const ack = edit
        ? await editStatusThroughOutbox(9, text, t)
        : await postStatusThroughOutbox(text, t);
      assert.ok(wires.length <= 1);
      for (const wire of wires) {
        assert.equal(wire.mode, "html");
        assert.ok(
          (wire.text ?? "").length > 0 && (wire.text ?? "").length <= 4096,
        );
      }
      if (wires.length === 0) assert.equal(ack.kind, "error");
      else assert.equal(ack.kind, "ok");
    }),
    { seed: 1115003, numRuns: 300 },
  );
});

await test("a secret never reaches the wire on post or edit (seed 1115004)", async () => {
  const origin = console.error;
  console.error = () => {};
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        fc.boolean(),
        async (before, after, edit) => {
          const { wires, t } = transport(() => okReply());
          const text = `${before} ${SECRET} ${after}`;
          if (edit) await editStatusThroughOutbox(3, text, t);
          else await postStatusThroughOutbox(text, t);
          assert.ok(wires.length >= 1);
          for (const wire of wires)
            assert.ok(!(wire.text ?? "").includes(SECRET));
        },
      ),
      { seed: 1115004, numRuns: 100 },
    );
  } finally {
    console.error = origin;
  }
});

await test("the ack table: post, edit and delete classify every Bot API answer (seed 1115005)", async () => {
  // ok with an id; without an id it is still ok, the caller then has nothing to track
  assert.deepEqual(
    await postStatusThroughOutbox("x", transport(() => okReply(77)).t),
    {
      kind: "ok",
      messageId: 77,
    },
  );
  assert.deepEqual(
    await postStatusThroughOutbox(
      "x",
      transport(() => ({ ok: true, status: 200, result: {} })).t,
    ),
    { kind: "ok" },
  );
  assert.deepEqual(
    await postStatusThroughOutbox(
      "x",
      transport(() => ({ ok: true, status: 200 })).t,
    ),
    { kind: "ok" },
  );
  // "message is not modified" counts as landed, on edit only
  const notModified = refused(
    400,
    "Bad Request: message is not modified: specified new message content",
  );
  assert.equal(
    (await editStatusThroughOutbox(1, "x", transport(() => notModified).t))
      .kind,
    "ok",
  );
  assert.equal(
    (await postStatusThroughOutbox("x", transport(() => notModified).t)).kind,
    "gone",
  );
  // 429 waits for retry_after, at least a second
  assert.deepEqual(
    await editStatusThroughOutbox(
      1,
      "x",
      transport(() =>
        refused(429, "Too Many Requests", { parameters: { retry_after: 7 } }),
      ).t,
    ),
    { kind: "wait", retryAfterMs: 7000 },
  );
  assert.deepEqual(
    await editStatusThroughOutbox(1, "x", transport(() => refused(429)).t),
    { kind: "wait", retryAfterMs: 1000 },
  );
  // delete
  assert.equal(
    (
      await deleteStatusThroughOutbox(
        1,
        transport(() => ({ ok: true, status: 200 })).t,
      )
    ).kind,
    "ok",
  );
  assert.equal(
    (
      await deleteStatusThroughOutbox(
        1,
        transport(() => refused(400, "message to delete not found")).t,
      )
    ).kind,
    "gone",
  );
  assert.equal(
    (
      await deleteStatusThroughOutbox(
        1,
        transport(() => new Error("socket hang up")).t,
      )
    ).kind,
    "error",
  );
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 300, max: 599 }),
      fc.constantFrom("post", "edit", "remove"),
      async (status, method) => {
        const { t } = transport(() =>
          refused(status, "Bad Request: something else"),
        );
        const ack =
          method === "post"
            ? await postStatusThroughOutbox("x", t)
            : method === "edit"
              ? await editStatusThroughOutbox(1, "x", t)
              : await deleteStatusThroughOutbox(1, t);
        const expected =
          status === 429
            ? "wait"
            : status >= 400 && status < 500
              ? "gone"
              : "error";
        assert.equal(ack.kind, expected);
      },
    ),
    { seed: 1115005, numRuns: 300 },
  );
});

await test("a markup refusal is retried once as plain text, on post and on edit", async () => {
  for (const edit of [false, true]) {
    const { wires, t } = transport((wire) =>
      wire.mode === "html"
        ? refused(
            400,
            "Bad Request: can't parse entities: Unsupported start tag",
          )
        : okReply(5),
    );
    const ack = edit
      ? await editStatusThroughOutbox(5, "a <b> & c", t)
      : await postStatusThroughOutbox("a <b> & c", t);
    assert.equal(ack.kind, "ok");
    assert.deepEqual(
      wires.map((w) => w.mode),
      ["html", "plain"],
    );
    assert.ok(!wires[1].text?.includes("&amp;"));
  }
  // the retry is refused as well: no third request
  const stuck = transport(() =>
    refused(400, "Bad Request: can't parse entities"),
  );
  assert.equal((await postStatusThroughOutbox("x", stuck.t)).kind, "gone");
  assert.equal(stuck.wires.length, 2);
});

await test("a network failure on the wire is an error ack and never throws", async () => {
  for (const call of [
    (t: StatusTransport) => postStatusThroughOutbox("x", t),
    (t: StatusTransport) => editStatusThroughOutbox(1, "x", t),
    (t: StatusTransport) => deleteStatusThroughOutbox(1, t),
  ]) {
    const ack = await call(transport(() => new Error("ETIMEDOUT")).t);
    assert.equal(ack.kind, "error");
  }
});
