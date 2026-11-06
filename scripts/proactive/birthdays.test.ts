/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { PROACTIVE_DEFAULTS } from "#lib/proactive-config.ts";
import {
  birthdayName,
  birthdaySource,
  readBirthdays,
  type Birthdays,
} from "./birthdays.ts";
import type { GwsRun } from "./precheck.ts";
import { initialState, writeProactiveState } from "./state.ts";
import { runProactiveTick, type TickDeps } from "./tick.ts";

const NOW = Date.parse("2026-12-29T03:30:00Z");
const ZONE = "Asia/Tashkent";
const event = (name: string, date: string, id = name) => ({
  id,
  eventType: "birthday",
  birthdayProperties: {
    type: "birthday",
    contact: `people/c${encodeURIComponent(id)}`,
  },
  summary: name,
  start: { date },
});
const page = (items: unknown[], nextPageToken?: string) => ({
  kind: "calendar#events",
  items,
  ...(nextPageToken ? { nextPageToken } : {}),
});
const run =
  (value: unknown): GwsRun =>
  () =>
    Promise.resolve({ code: 0, stdout: JSON.stringify(value) });

test("birthday names preserve Latin, Cyrillic, Unicode and internal apostrophes", () => {
  for (const [summary, name] of [
    ["Alex's birthday", "Alex"],
    ["День рождения: Мария Иванова", "Мария Иванова"],
    ["O'Connor's birthday", "O'Connor"],
    ["Нигина О’Коннор’s birthday", "Нигина О’Коннор"],
    ["李明's birthday", "李明"],
    ["День рождения: Alex's birthday", "День рождения: Alex"],
  ])
    assert.equal(birthdayName(summary), name);
});

const SEED = Number(process.env.FC_SEED ?? 20261025);
test(`birthday name suffix removes only the suffix, seed=${SEED}`, () => {
  const name = fc
    .array(fc.constantFrom("A", "z", "Ж", "ё", "李", "🙂", "'", "’", "-"), {
      minLength: 1,
      maxLength: 80,
    })
    .map((letters) => letters.join(""));
  fc.assert(
    fc.property(name, (person) => {
      assert.equal(birthdayName(`${person}'s birthday`), person);
      assert.equal(birthdayName(`${person}’s birthday`), person);
      assert.equal(birthdayName(`День рождения: ${person}`), person);
    }),
    { seed: SEED, numRuns: 200 },
  );
});

test("gws wire uses Contacts, expanded events and the complete inclusive window across New Year", async () => {
  const calls: { args: readonly string[]; timeout: number }[] = [];
  const result = await readBirthdays(NOW, ZONE, (args, timeout) => {
    calls.push({ args, timeout });
    return run(
      page([
        event("Yesterday's birthday", "2026-12-28"),
        event("Today's birthday", "2026-12-29"),
        event("День рождения: Ольга", "2027-01-01"),
        event("Last's birthday", "2027-01-05"),
        event("Outside's birthday", "2027-01-06"),
        event("Invalid's birthday", "2026-12-32"),
        { ...event("Cancelled's birthday", "2027-01-01"), status: "cancelled" },
        { summary: "Timed", start: { dateTime: "2027-01-01T10:00:00+05:00" } },
      ]),
    )(args, timeout);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "calendar",
    "events",
    "list",
    "--params",
  ]);
  assert.deepEqual(JSON.parse(calls[0].args[4]), {
    calendarId: "primary",
    eventTypes: ["birthday"],
    singleEvents: true,
    orderBy: "startTime",
    timeZone: ZONE,
    timeMin: "2026-12-28T19:00:00.000Z",
    timeMax: "2027-01-05T19:00:00.000Z",
  });
  assert.ok(calls[0].timeout > 0 && calls[0].timeout <= 20_000);
  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.items.map(({ name, daysUntil }) => [name, daysUntil]),
    [
      ["Today", 0],
      ["Ольга", 3],
      ["Last", 7],
    ],
  );
});

test("owner-local dates and DST preserve a full day +7", async () => {
  let params: Record<string, unknown> = {};
  const result = await readBirthdays(
    Date.parse("2026-03-08T07:30:00Z"),
    "America/New_York",
    (args) => {
      params = JSON.parse(args[4]) as Record<string, unknown>;
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(page([event("DST's birthday", "2026-03-15")])),
      });
    },
  );
  assert.equal(params.timeMin, "2026-03-08T05:00:00.000Z");
  assert.equal(params.timeMax, "2026-03-16T04:00:00.000Z");
  assert.equal(result.items[0]?.daysUntil, 7);
  const local = await readBirthdays(
    Date.parse("2026-12-28T20:00:00Z"),
    ZONE,
    run(page([event("Local's birthday", "2026-12-29")])),
  );
  assert.equal(local.items[0]?.daysUntil, 0);
});

test("date window property rejects outside dates and includes every day from zero through seven", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: -20, max: 20 }), async (offset) => {
      const date = new Date(Date.UTC(2026, 11, 29 + offset))
        .toISOString()
        .slice(0, 10);
      const result = await readBirthdays(
        NOW,
        ZONE,
        run(page([event("Person's birthday", date)])),
      );
      assert.equal(result.items.length, offset >= 0 && offset <= 7 ? 1 : 0);
      if (result.items.length) assert.equal(result.items[0].daysUntil, offset);
    }),
    { seed: SEED, numRuns: 100 },
  );
});

test("all calendar pages are read and a broken continuation never becomes a partial success", async () => {
  const tokens: unknown[] = [];
  const result = await readBirthdays(NOW, ZONE, (args) => {
    const { pageToken: token } = JSON.parse(args[4]) as { pageToken?: string };
    tokens.push(token);
    return run(
      token
        ? page([event("Second's birthday", "2027-01-01")])
        : page([event("First's birthday", "2026-12-29")], "next"),
    )(args, 100);
  });
  assert.deepEqual(tokens, [undefined, "next"]);
  assert.equal(result.items.length, 2);
  const broken = await readBirthdays(
    NOW,
    ZONE,
    run(page([event("First's birthday", "2026-12-29")], "repeated")),
  );
  assert.deepEqual(broken, { status: "unavailable", items: [] });
});

test("Google absent and calendar absent are quiet; other failures remain unknown", async () => {
  for (const code of ["missing", 2] as const) {
    const result = await readBirthdays(NOW, ZONE, () =>
      Promise.resolve({ code, stdout: "" }),
    );
    assert.deepEqual(result, { status: "not-connected", items: [] });
    assert.deepEqual(
      await birthdaySource(() => Promise.resolve(result), NOW, ZONE).check(),
      { items: [], error: null },
    );
  }
  for (const output of [
    { stdout: JSON.stringify({ error: { reason: "notFound" } }) },
    { stdout: JSON.stringify({ error: { code: 404, message: "Not Found" } }) },
    {
      stdout: "",
      stderr: JSON.stringify({ error: { code: 404, reason: "notFound" } }),
    },
  ]) {
    const result = await readBirthdays(NOW, ZONE, () =>
      Promise.resolve({ code: 1, ...output }),
    );
    assert.deepEqual(result, { status: "missing", items: [] });
    assert.equal(
      (await birthdaySource(() => Promise.resolve(result), NOW, ZONE).check())
        .error,
      null,
    );
  }
  for (const response of [
    { code: 1, stdout: JSON.stringify({ error: { code: 403 } }) },
    { code: "timeout" as const, stdout: "" },
    { code: 0, stdout: "not JSON" },
  ])
    assert.deepEqual(
      await readBirthdays(NOW, ZONE, () => Promise.resolve(response)),
      { status: "unavailable", items: [] },
    );
});

async function scenario(
  read: () => Promise<Birthdays>,
  briefTimes: readonly string[],
  body: (deps: TickDeps, prompts: string[], sent: string[]) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "iva-birthdays-"));
  const prompts: string[] = [];
  const sent: string[] = [];
  const config = { ...PROACTIVE_DEFAULTS, briefTimes, staleMinutes: 0 };
  const deps: TickDeps = {
    statePath: join(dir, "proactive.json"),
    timeZone: ZONE,
    config: () => config,
    sources: [birthdaySource(read, NOW, ZONE)],
    birthdays: read,
    runTurn: async (prompt) => {
      prompts.push(prompt);
      return Promise.resolve({
        status: "completed",
        message:
          (await read()).items
            .map((item) => `<!-- iva:item ${item.key} -->\n${item.name}`)
            .join("\n<!-- iva:next -->\n") || "QUIET",
        feedback: () => Promise.resolve(),
      });
    },
    send: (part) => {
      sent.push(part);
      return Promise.resolve({ ok: true, error: "" });
    },
    translate: () => Promise.resolve((_en, ru) => ru),
    log: () => undefined,
  };
  try {
    await writeProactiveState(deps.statePath, initialState(NOW));
    await body(deps, prompts, sent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Watch wakes for day three and today without unread mail or Telegram; repeats stay confirmed", async () => {
  const data = await readBirthdays(
    NOW,
    ZONE,
    run(
      page([
        event("Today’s birthday", "2026-12-29"),
        event("Soon's birthday", "2027-01-01"),
        event("Next's birthday", "2027-01-05"),
      ]),
    ),
  );
  await scenario(
    () => Promise.resolve(data),
    [],
    async (deps, prompts) => {
      assert.equal(await runProactiveTick(NOW + 1_800_000, deps), 0);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /^Watch:/u);
      assert.match(prompts[0], /"daysUntil":0/u);
      assert.match(prompts[0], /"daysUntil":3/u);
      assert.doesNotMatch(prompts[0], /"daysUntil":7/u);
      assert.equal(await runProactiveTick(NOW + 5_400_000, deps), 0);
      assert.equal(prompts.length, 1);
    },
  );
  const noon = await birthdaySource(
    () => Promise.resolve(data),
    Date.parse("2026-12-29T07:00:00Z"),
    ZONE,
  ).check();
  assert.equal(noon.items.length, 1);
  assert.match(noon.items[0].note ?? "", /"daysUntil":3/u);
});

test("scheduled Brief receives the ready birthday list and distinguishes absent from failed reads", async () => {
  for (const status of [
    "ready",
    "missing",
    "not-connected",
    "unavailable",
  ] as const) {
    const data =
      status === "ready"
        ? await readBirthdays(
            NOW,
            ZONE,
            run(page([event("Alex's birthday", "2027-01-05")])),
          )
        : { status, items: [] };
    await scenario(
      () => Promise.resolve(data),
      ["08:30"],
      async (deps, prompts) => {
        assert.equal(await runProactiveTick(NOW, deps), 0);
        assert.match(prompts[0], /^Brief:/u);
        assert.match(
          prompts[0],
          new RegExp(`Google Contacts birthdays .*"status":"${status}"`, "u"),
        );
        if (status === "ready") assert.match(prompts[0], /"daysUntil":7/u);
      },
    );
  }
});
