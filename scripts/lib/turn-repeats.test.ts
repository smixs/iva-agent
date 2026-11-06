import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  listTurnRepeats,
  TRACE_REPEAT_BYTES_PER_FILE,
} from "./turn-repeats.ts";
import { readTrace } from "./turn-failures.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
type Row = {
  ts: string;
  source: string;
  session: string;
  turn: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
};
const event = (
  at: number,
  session: string,
  turn: string,
  kind: string,
  name: string,
  data: Record<string, unknown>,
  source = "telegram",
): Row => ({
  ts: new Date(at).toISOString(),
  source,
  session,
  turn,
  kind,
  name,
  data,
});
const TOOL = (toolName: string) => ({ kind: "tool-call", toolName });
const CHAIN = [TOOL("bash"), { kind: "load-skill" }, TOOL("send_file")];

function turn(
  id: number,
  at: number,
  {
    actions = CHAIN,
    args = [{ command: "gws gmail list --query private" }, { name: "x" }, {}],
    steps = 3,
    request = "Проверь письма и пришли файл",
    session = `s${id}`,
    source = "telegram",
  }: {
    actions?: unknown[];
    args?: unknown[];
    steps?: number;
    request?: string;
    session?: string;
    source?: string;
  } = {},
): Row[] {
  const key = `tg:1:${id}`;
  const ref = `turn_${id}`;
  return [
    event(
      at,
      "",
      key,
      "inbound",
      "received",
      { text: request, allowlisted: true },
      source,
    ),
    event(at + 1, session, ref, "turn", "bound", { updateKey: key }, source),
    event(
      at + 2,
      session,
      ref,
      "eve",
      "actions.requested",
      { actions, args },
      source,
    ),
    ...Array.from({ length: steps }, (_, stepIndex) =>
      event(
        at + 3 + stepIndex,
        session,
        ref,
        "eve",
        "step.completed",
        { stepIndex, usage: { in: 7, out: 3 } },
        source,
      ),
    ),
  ];
}

function journal(t: TestContext, rows: readonly (Row | string)[]) {
  const dir = mkdtempSync(join(tmpdir(), "iva-turn-repeats-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "trace"));
  const files = new Map<string, string[]>();
  for (const row of rows) {
    const day = typeof row === "string" ? "2026-10-18" : row.ts.slice(0, 10);
    const lines = files.get(day) ?? [];
    files.set(day, lines);
    lines.push(typeof row === "string" ? row : JSON.stringify(row));
  }
  for (const [day, lines] of files)
    writeFileSync(join(dir, "trace", `${day}.jsonl`), `${lines.join("\n")}\n`);
  return dir;
}

void test("three Telegram turns on two days give one maximal repeat with the newest request and reference", (t) => {
  const dir = journal(t, [
    ...turn(1, NOW - 2 * DAY),
    ...turn(2, NOW - DAY, { steps: 5 }),
    ...turn(3, NOW - 60_000, { steps: 7, request: "Последняя просьба" }),
  ]);
  const lines = listTurnRepeats(dir, NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /3× repeat bash:gws gmail → skill:x → send_file/u);
  assert.match(lines[0], /median steps 5.*tokens 150.*skill yes/u);
  assert.match(lines[0], /Последняя просьба.*iva trace show s3\/turn_3$/u);
  assert.equal(lines[0].includes("private"), false);
});

void test("subchains with identical turn support collapse, distinct support survives", (t) => {
  const four = [...CHAIN, TOOL("write_card")];
  const dir = journal(t, [
    ...turn(1, NOW - 2 * DAY, { actions: four }),
    ...turn(2, NOW - DAY, { actions: four }),
    ...turn(3, NOW - 60_000, { actions: four }),
    ...turn(4, NOW - DAY / 2),
  ]);
  const lines = listTurnRepeats(dir, NOW);
  assert.equal(lines.length, 2);
  assert.ok(
    lines.some((line) =>
      line.startsWith("4× repeat bash:gws gmail → skill:x → send_file"),
    ),
  );
  assert.ok(
    lines.some((line) =>
      line.startsWith(
        "3× repeat bash:gws gmail → skill:x → send_file → write_card",
      ),
    ),
  );
});

void test("one day, two turns, reading heads and repeated occurrences inside one turn are insufficient", (t) => {
  for (const rows of [
    [
      ...turn(1, NOW - 60_000),
      ...turn(2, NOW - 50_000),
      ...turn(3, NOW - 40_000),
    ],
    [...turn(1, NOW - DAY), ...turn(2, NOW - 60_000)],
    turn(1, NOW - 60_000, { actions: [...CHAIN, ...CHAIN, ...CHAIN] }),
    ...["cat", "iva trace show s/turn_0"].map((command) =>
      [1, 2, 3].flatMap((id) =>
        turn(id, NOW - (id * DAY) / 2, { args: [{ command }, {}, {}] }),
      ),
    ),
  ])
    assert.deepEqual(listTurnRepeats(journal(t, rows), NOW), []);
});

void test("four owner messages in thirty minutes plus a stop form a guided case", (t) => {
  const rows = [1, 2, 3, 4].flatMap((id) =>
    turn(id, NOW - (5 - id) * 5 * 60_000, {
      actions: [],
      args: [],
      session: "guided",
    }),
  );
  rows.push(event(NOW - 60_000, "guided", "turn_4", "stop", "requested", {}));
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /4× guided.*iva trace show guided\/turn_4$/u);
  assert.deepEqual(
    listTurnRepeats(
      journal(
        t,
        rows.filter((row) => row.kind !== "stop"),
      ),
      NOW,
    ),
    [],
  );
});

void test("a ten-step turn also selects a guided case; widely spaced messages do not", (t) => {
  const rows = [1, 2, 3, 4].flatMap((id) =>
    turn(id, NOW - id * 60_000, {
      actions: [],
      args: [],
      steps: id === 1 ? 10 : 1,
      session: "guided",
    }),
  );
  assert.match(listTurnRepeats(journal(t, rows), NOW)[0], /4× guided/u);
  const sparse = [1, 2, 3, 4].flatMap((id) =>
    turn(id, NOW - id * 31 * 60_000, {
      actions: [],
      args: [],
      steps: 10,
      session: "guided",
    }),
  );
  assert.deepEqual(listTurnRepeats(journal(t, sparse), NOW), []);
});

void test("fifteen-step turns without load_skill fold by the first two action heads", (t) => {
  const options = {
    actions: [TOOL("bash"), TOOL("web_fetch"), TOOL("send_file")],
    args: [
      { command: "python3 /private/script.py --key secret" },
      { url: "https://example.org/path?token=secret" },
      {},
    ],
    steps: 15,
  };
  const lines = listTurnRepeats(
    journal(t, [
      ...turn(1, NOW - DAY, options),
      ...turn(2, NOW - 60_000, options),
    ]),
    NOW,
  );
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /2× long without skill bash:python3 → web_fetch:example.org/u,
  );
  assert.match(lines[0], /iva trace show s2\/turn_2$/u);
  assert.equal(lines[0].includes("secret"), false);
  assert.deepEqual(
    listTurnRepeats(
      journal(t, turn(1, NOW - 60_000, { ...options, steps: 14 })),
      NOW,
    ),
    [],
  );
  assert.deepEqual(
    listTurnRepeats(journal(t, turn(1, NOW - 60_000, { steps: 15 })), NOW),
    [],
  );
});

void test("the 14-day window excludes future, old, child and non-Telegram turns", (t) => {
  const rows = [
    ...turn(1, NOW - 15 * DAY, { steps: 15 }),
    ...turn(2, NOW + 60_000, { steps: 15 }),
    ...turn(3, NOW - DAY, { steps: 15, source: "helper" }),
  ];
  rows.push(
    ...turn(4, NOW - 60_000, { actions: [TOOL("send_file")], steps: 15 }).map(
      (row) => ({ ...row, turn: `${row.turn}#child` }),
    ),
  );
  assert.deepEqual(listTurnRepeats(journal(t, rows), NOW), []);
});

void test("bounded Trace reading keeps the newest complete UTF-8 lines and leaves failure reading unlimited", (t) => {
  const rows = turn(1, NOW - 60_000, {
    actions: [TOOL("send_file")],
    args: [{}],
    steps: 15,
    request: "📬 кириллица",
  });
  const dir = journal(t, rows);
  const file = join(dir, "trace", "2026-10-18.jsonl");
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(file, "я".repeat(TRACE_REPEAT_BYTES_PER_FILE) + "\n" + body);
  assert.match(listTurnRepeats(dir, NOW)[0], /📬 кириллица/u);
  assert.equal(
    readTrace(dir, 1, Buffer.byteLength(body)).lines.length,
    rows.length,
  );
  assert.equal(readTrace(dir, 1).unreadable, 1);
  assert.equal(readTrace(dir, 1).lines.length, rows.length);
});

for (const seed of [181001, 181002]) {
  void test(`PROPERTY: mixed valid cases preserve the ten-line limit and known turn references (seed=${seed})`, (t) => {
    const dir = journal(t, []);
    const file = join(dir, "trace", "2026-10-18.jsonl");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.jsonValue(),
        (count, args) => {
          const rows = Array.from({ length: count }, (_, id) =>
            turn(id, NOW - (id + 1) * 60_000, {
              actions: [TOOL(`case_${id}`)],
              args: [args],
              steps: 15,
            }),
          ).flat();
          writeFileSync(
            file,
            rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          );
          const lines = listTurnRepeats(dir, NOW);
          assert.equal(lines.length, Math.min(count, 10));
          for (const [i, line] of lines.entries())
            assert.ok(line.endsWith(`iva trace show s${i}/turn_${i}`));
        },
      ),
      { seed, numRuns: 50 },
    );
  });
  void test(`PROPERTY: malformed JSONL cannot invent candidates or hide a planted Telegram case (seed=${seed})`, (t) => {
    const dir = journal(t, []);
    const file = join(dir, "trace", "2026-10-18.jsonl");
    const planted = turn(99, NOW - 60_000, {
      actions: [TOOL("send_file")],
      args: [{}],
      steps: 15,
    });
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string({ unit: "grapheme", maxLength: 100 }),
            fc.jsonValue().map((value) => JSON.stringify(value)),
          ),
          { maxLength: 40 },
        ),
        fc.string({ unit: "grapheme", maxLength: 120 }),
        (junk, request) => {
          const noisy = [
            ...junk,
            ...planted.map((row) =>
              JSON.stringify(
                row.kind === "inbound"
                  ? { ...row, data: { ...row.data, text: request } }
                  : row,
              ),
            ),
          ];
          writeFileSync(file, noisy.join("\n") + "\n");
          const lines = listTurnRepeats(dir, NOW);
          assert.equal(lines.length, 1);
          assert.ok(
            lines.every(
              (line) =>
                !line.includes("\n") &&
                line.includes("iva trace show s99/turn_99"),
            ),
          );
          assert.deepEqual(lines, listTurnRepeats(dir, NOW));
        },
      ),
      { seed, numRuns: 100 },
    );
  });
  void test(`PROPERTY: service sources and missing turn ids never enter the ten-line list (seed=${seed})`, (t) => {
    const dir = journal(t, []);
    const file = join(dir, "trace", "2026-10-18.jsonl");
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "insight",
            "watch",
            "brief",
            "helper",
            "rollup",
            "cron",
            "unknown",
            "http",
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (sources) => {
          const rows = sources.flatMap((source, index) =>
            turn(index, NOW - 60_000, {
              source,
              actions: [TOOL("send_file")],
              args: [{}],
              steps: 15,
            }),
          );
          rows.push(
            ...turn(50, NOW - 60_000, { steps: 15 }).map((row) => ({
              ...row,
              turn: "",
            })),
          );
          writeFileSync(
            file,
            rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          );
          assert.deepEqual(listTurnRepeats(dir, NOW), []);
        },
      ),
      { seed, numRuns: 40 },
    );
  });
}

void test("more than ten distinct cases keep exactly the ten newest references", (t) => {
  const rows = Array.from({ length: 15 }, (_, id) =>
    turn(id, NOW - (id + 1) * 60_000, {
      actions: [TOOL(`tool_${id}`)],
      args: [{}],
      steps: 15,
    }),
  ).flat();
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 10);
  assert.match(lines[0], /iva trace show s0\/turn_0$/u);
  assert.match(lines[9], /iva trace show s9\/turn_9$/u);
});

void test("six long web hosts keep the opener intact within the Gate's line budget", (t) => {
  const host = Array.from({ length: 4 }, () => "a".repeat(60)).join(".");
  const rows = [1, 2, 3].flatMap((id) =>
    turn(id, NOW - (id * DAY) / 2, {
      actions: Array.from({ length: 6 }, () => TOOL("web_fetch")),
      args: Array.from({ length: 6 }, () => ({
        url: `https://${host}/private`,
      })),
    }),
  );
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 1000);
  assert.ok(lines[0].endsWith("iva trace show s1/turn_1"));
});

const c1Shape = (rows: Row[]) =>
  rows.map((row) =>
    row.kind === "eve" ? { ...row, source: "channel:telegram" } : row,
  );

for (const [command, expected] of [
  ["sudo -U alice gh api", "gh api"],
  ["sudo -h myhost", ""],
  ["sudo -p hunter2", ""],
  ["sudo -iu root gh api", "gh api"],
  ["env -P /opt/secretdir gh api", "gh api"],
  ["ssh myhost uptime", "ssh"],
  ["gh abcdef0123456789", "gh"],
  [`gh ${"x".repeat(21)}`, "gh"],
] as const) {
  void test(`R317b: ${command} keeps only the program and a permitted subcommand`, (t) => {
    const rows = turn(1, NOW - 60_000, {
      actions: [TOOL("bash")],
      args: [{ command }],
      steps: 15,
    });
    const [line] = listTurnRepeats(journal(t, rows), NOW);
    assert.ok(line);
    const head = expected ? ` bash:${expected}` : "";
    assert.ok(line.startsWith(`1× long without skill${head} ·`), line);
    assert.doesNotMatch(
      line,
      /alice|myhost|hunter2|root|secretdir|abcdef0123456789/u,
    );
  });
}

void test("R317b: known subcommands retain the 20-character boundary and the reading stop-list", (t) => {
  for (const [command, expected] of [
    [`gh ${"x".repeat(20)}`, `bash:gh ${"x".repeat(20)}`],
    ["gws gmail list", "bash:gws gmail"],
    ["iva trace show", ""],
    ["git status", "bash:git status"],
  ]) {
    const rows = turn(1, NOW - 60_000, {
      actions: [TOOL("bash")],
      args: [{ command }],
      steps: 15,
    });
    const [line] = listTurnRepeats(journal(t, rows), NOW);
    assert.ok(
      line.startsWith(
        `1× long without skill${expected ? ` ${expected}` : ""} ·`,
      ),
      line,
    );
  }
});

for (const seed of [1831711, 1831712]) {
  void test(`R317b PROPERTY: wrapper values and secret-shaped subcommands stay out of heads (seed=${seed})`, (t) => {
    const dir = journal(t, []);
    const file = join(dir, "trace", "2026-10-18.jsonl");
    fc.assert(
      fc.property(
        fc.constantFrom(..."pUhrtDRTP"),
        fc.constantFrom("", "i", "iv"),
        fc.stringMatching(/^[a-f][0-9a-f]{11,18}$/u),
        (flag, cluster, secret) => {
          for (const command of [
            `sudo -${cluster}${flag} private-${secret} gh api`,
            `gh ${secret}`,
          ]) {
            const rows = turn(1, NOW - 60_000, {
              actions: [TOOL("bash")],
              args: [{ command }],
              steps: 15,
            });
            writeFileSync(
              file,
              rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
            );
            const [line] = listTurnRepeats(dir, NOW);
            assert.ok(
              line.startsWith(
                `1× long without skill bash:gh${command.startsWith("sudo") ? " api" : ""} ·`,
              ),
              line,
            );
            assert.equal(line.includes(secret), false, line);
            assert.equal(line.includes("private-"), false, line);
          }
        },
      ),
      { seed, numRuns: 60 },
    );
  });
}

void test("R317-1: Eve channel:telegram events join Telegram inbound while http stays excluded", (t) => {
  const options = { actions: [TOOL("send_file")], args: [{}], steps: 15 };
  const rows = c1Shape(turn(1, NOW - 60_000, options));
  rows.push(...turn(2, NOW - 30_000, { ...options, source: "http" }));
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /long without skill.*median steps 15.*s1\/turn_1$/u);
});

void test("R317-2: load-skill uses args.skill even when its result name is empty", (t) => {
  const rows = [1, 2, 3].flatMap((id) =>
    turn(id, NOW - (id * DAY) / 2, {
      actions: [
        TOOL("bash"),
        { kind: "load-skill", name: "" },
        TOOL("send_file"),
      ],
      args: [{ command: "gh api /repos" }, { skill: "watch" }, {}],
    }),
  );
  rows.push(
    event(NOW - DAY / 2 + 20, "s1", "turn_1", "eve", "action.result", {
      name: "",
      status: "completed",
    }),
  );
  assert.match(
    listTurnRepeats(journal(t, rows), NOW)[0],
    /bash:gh api → skill:watch → send_file/u,
  );
});

void test("R317-3: bash heads skip assignments, wrappers and working-directory prefixes", (t) => {
  for (const command of [
    "GH_TOKEN=ghp_123456 gh api /private/repo",
    "env TOKEN='12345 secret' gh api /private/repo",
    "timeout -s TERM 30s gh api /private/repo",
    "sudo -u root gh api /private/repo",
    "nice -n 10 nohup gh api /private/repo",
    "cd '/private/secret path' && gh api /private/repo",
    "cd /private/secret; TOKEN=12345 env timeout 30 gh api /private/repo",
    "env -u GH_TOKEN /usr/bin/gh api /private/repo",
    "/usr/bin/env TOKEN=123456 /usr/bin/timeout 30 /usr/bin/gh api /private/repo",
  ]) {
    const rows = [1, 2, 3].flatMap((id) =>
      turn(id, NOW - (id * DAY) / 2, {
        args: [{ command }, { name: "x" }, {}],
      }),
    );
    const lines = listTurnRepeats(journal(t, rows), NOW);
    assert.equal(lines.length, 1, command);
    assert.match(lines[0], /repeat bash:gh api → skill:x/u, command);
    assert.doesNotMatch(lines[0], /GH_TOKEN|TOKEN|12345|private|secret/u);
  }
});

void test("R317-4: c1-shaped mixed-source actions preserve skills and safe bash heads", (t) => {
  const rows = [1, 2, 3].flatMap((id) =>
    c1Shape(
      turn(id, NOW - (id * DAY) / 2, {
        actions: [
          TOOL("bash"),
          TOOL("bash"),
          { kind: "load-skill" },
          TOOL("send_file"),
        ],
        args: [
          { command: "cd /private/data && gh api /repos" },
          { command: "TOKEN=123456 cmd run" },
          { skill: "watch" },
          {},
        ],
      }),
    ),
  );
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /3× repeat bash:gh api → bash:cmd → skill:watch → send_file/u,
  );
  assert.match(lines[0], /median steps 3.*tokens 90.*skill yes.*s1\/turn_1$/u);
  assert.doesNotMatch(lines[0], /TOKEN|123456|private/u);
});

void test("R317-5: shell-only noise cannot form a repeated chain", (t) => {
  for (const command of [
    "cd /tmp",
    "export TOKEN=123456",
    "sleep 30",
    "echo secret",
  ]) {
    const rows = [1, 2, 3].flatMap((id) =>
      turn(id, NOW - (id * DAY) / 2, { args: [{ command }, {}, {}] }),
    );
    assert.deepEqual(listTurnRepeats(journal(t, rows), NOW), [], command);
  }
});

void test("R317-6: a guided session selects its latest qualifying window", (t) => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((id) =>
    turn(id, NOW - (id <= 4 ? 4 * 60 * 60_000 : 0) - (9 - id) * 60_000, {
      actions: [],
      args: [],
      steps: id === 1 || id === 5 ? 10 : 1,
      session: "guided",
      request: id <= 4 ? "Старое дело" : "Новое дело",
    }),
  );
  const lines = listTurnRepeats(journal(t, rows), NOW);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /4× guided.*Новое дело.*guided\/turn_8$/u);
  assert.doesNotMatch(lines[0], /Старое дело/u);
});

void test("R317-7: a two-MiB day retains its morning within a bounded four-MiB read", (t) => {
  const dir = journal(t, [
    ...turn(1, NOW - 10 * 60 * 60_000, {
      actions: [TOOL("send_file")],
      args: [{}],
      steps: 15,
      request: "Утреннее дело",
    }),
    event(NOW - 60_000, "", "", "gate", "inbound", {
      text: "x".repeat(2 * 1024 * 1024),
    }),
  ]);
  assert.match(
    listTurnRepeats(dir, NOW)[0] ?? "",
    /Утреннее дело.*s1\/turn_1$/u,
  );
  assert.equal(TRACE_REPEAT_BYTES_PER_FILE, 4 * 1024 * 1024);
});

for (const seed of [1831701, 1831702]) {
  void test(`R317-3 PROPERTY: bash arguments and secret tokens never enter heads (seed=${seed})`, (t) => {
    const dir = journal(t, []);
    const file = join(dir, "trace", "2026-10-18.jsonl");
    fc.assert(
      fc.property(
        fc.integer({ min: 100000000, max: 999999999 }),
        fc.constantFrom("TOKEN=", "/private/", ""),
        fc.constantFrom(
          "",
          "env ",
          "timeout 30 ",
          "sudo -u root ",
          "nice -n 10 ",
          "nohup ",
          "cd /private/data && ",
        ),
        (secret, prefix, wrapper) => {
          const token = `${prefix}${secret}`;
          const command = `${wrapper}AUTH=${secret} gh ${token} /private/secret`;
          const rows = turn(1, NOW - 60_000, {
            actions: [TOOL("bash")],
            args: [{ command }],
            steps: 15,
          });
          writeFileSync(
            file,
            rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          );
          const lines = listTurnRepeats(dir, NOW);
          assert.equal(lines.length, 1);
          assert.match(lines[0], /long without skill bash:gh ·/u);
          assert.doesNotMatch(
            lines[0],
            new RegExp(`${secret}|AUTH|TOKEN|private|=`, "u"),
          );
        },
      ),
      { seed, numRuns: 80 },
    );
  });
}
