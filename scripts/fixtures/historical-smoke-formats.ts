// Regenerate the corpus with the unchanged writers from each supported release:
// node scripts/fixtures/historical-smoke-formats.ts --generate <output.json>
import "./no-host-anthropic.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";
import { tempDir } from "./temp-dir.ts";

const ROOT = join(import.meta.dirname, "../..");
const NOW = Date.UTC(2026, 10, 1);
const FILES = [
  "agent/lib/reminder-store.ts",
  "scripts/lib/telegram-queue.ts",
  "agent/lib/run-status.ts",
  "scripts/lib/version-store.ts",
  "scripts/lib/update-run-journal.ts",
  "agent/lib/settings.ts",
];
export type FormatSample = {
  tag: string;
  sources: Record<string, string | null>;
  reminders: unknown;
  queue: unknown;
  chat: unknown;
  active: unknown;
  journal: unknown;
  settings: unknown;
};

async function writer(tree: string, output: string) {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = join(tree, "sample/data");
  mkdirSync(data, { recursive: true });
  process.env.ASSISTANT_DATA_DIR = data;
  const load = (
    path: string,
  ): Promise<Record<string, (...args: never[]) => unknown>> =>
    import(pathToFileURL(join(tree, path)).href);
  // These public APIs are unchanged across v0.5.0-v0.5.12; runtime calls use their own imports.
  const reminders = (await load(
    FILES[0],
  )) as unknown as typeof import("../../agent/lib/reminder-store.ts");
  await reminders.add(
    {
      id: "r-historical",
      text: "historical reminder",
      chat: { id: "42", threadId: null },
      schedule: { kind: "at", atMs: NOW + 3600000 },
    },
    { file: join(data, "reminders.json") },
  );
  const queue = (await load(
    FILES[1],
  )) as unknown as typeof import("../lib/telegram-queue.ts");
  const raw = existsSync(join(tree, FILES[4]))
    ? {
        version: 1,
        queues: {
          "42:": [
            {
              version: 1,
              updateId: -1,
              legacyText: "historical legacy question",
            },
          ],
        },
      }
    : { "42:": ["historical legacy question"] };
  const normalized = queue.normalizeQueueDocument(raw).document;
  await queue.writeQueueFileAtomic(
    join(data, "telegram-queue.json"),
    normalized,
  );
  const chat = (await load(
    FILES[2],
  )) as unknown as typeof import("../../agent/lib/run-status.ts");
  chat.setChatStatus("42:", { status: "idle", resetAt: 2 });
  const versions = (await load(
    FILES[3],
  )) as unknown as typeof import("../lib/version-store.ts");
  const store = versions.createVersionStore(join(tree, "sample"));
  const name = "0.5.0-aaaaaaaaaaaa";
  const dir = store.stage(name);
  writeFileSync(
    join(dir, "package.json"),
    '{"type":"module","version":"0.5.0"}',
  );
  store.linkState(dir);
  store.complete(name);
  store.activate(name);
  store.settle(name);
  const settings = (await load(
    FILES[5],
  )) as unknown as typeof import("../../agent/lib/settings.ts");
  settings.writeSettings({
    locale: "ru",
    telegramTurnPolicy: "queue",
    historicalUnknown: { kept: true },
  });
  let journal: unknown = null;
  if (existsSync(join(tree, FILES[4]))) {
    const update = (await load(
      FILES[4],
    )) as unknown as typeof import("../lib/update-run-journal.ts");
    update.beginUpdateRun(data, {
      version: name,
      from: null,
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
    journal = JSON.parse(readFileSync(join(data, "update-run.json"), "utf8"));
  }
  const json = (file: string): unknown =>
    JSON.parse(readFileSync(join(data, file), "utf8"));
  writeFileSync(
    output,
    JSON.stringify({
      reminders: json("reminders.json"),
      queue: json("telegram-queue.json"),
      chat: json(
        `run-status.d/${Buffer.from("42:").toString("base64url")}.json`,
      ),
      active: json("active.json"),
      journal,
      settings: json("settings.json"),
    }),
  );
}

if (process.argv[2] === "--writer")
  await writer(process.argv[3], process.argv[4]);
if (process.argv[2] === "--generate") {
  const corpus: FormatSample[] = [];
  const current = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const tags = [
    ...Array.from({ length: 13 }, (_, patch) => `v0.5.${patch}`),
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
  ];
  for (const [patch, tag] of tags.entries()) {
    const tree = tempDir(`iva-format-${patch}-`);
    try {
      execFileSync("tar", ["-xf", "-", "-C", tree], {
        input: execFileSync(
          "git",
          ["archive", tag, "agent", "scripts", "packages", "package.json"],
          { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
        ),
      });
      const old = JSON.parse(
        readFileSync(join(tree, "package.json"), "utf8"),
      ) as typeof current;
      // The format writers use zod and croner. Do not silently substitute different releases.
      for (const dep of ["zod", "croner"])
        assert.equal(
          old.dependencies[dep],
          current.dependencies[dep],
          `${tag}: ${dep}`,
        );
      symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
      const output = join(tree, "sample.json");
      execFileSync(
        process.execPath,
        [import.meta.filename, "--writer", tree, output],
        {
          cwd: tree,
          env: {
            ...process.env,
            ASSISTANT_DATA_DIR: join(tree, "sample/data"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const sources = Object.fromEntries(
        FILES.map((file) => [
          file,
          existsSync(join(tree, file))
            ? execFileSync("git", ["rev-parse", `${tag}:${file}`], {
                cwd: ROOT,
                encoding: "utf8",
              }).trim()
            : null,
        ]),
      );
      corpus.push({
        tag,
        sources,
        ...(JSON.parse(readFileSync(output, "utf8")) as Omit<
          FormatSample,
          "tag" | "sources"
        >),
      });
      console.log(
        `${tag}: six formats (${sources[FILES[4]] ? "journal writer present" : "journal absent"})`,
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
  writeFileSync(process.argv[3], JSON.stringify(corpus, null, 2) + "\n");
}
