/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Guard for the authored tree: eve rebuilds `agent/` at service start, so any module
// specifier there that resolves outside `agent/` drags `scripts/` into the bundle — the
// failure that produced the 0.3.14 crash loop (issue #176). agent/ never imports
// scripts/; the only exits are shared packages via @iva/*, and the explicit edge
// list is pinned by the test below — a new edge out of `agent/` is red on sight.
//
// What replaced the last of them is the seam: the half the authored tree needs lives in
// `agent/lib`, the half `iva` loads on an install whose `agent/` is missing stays in
// `scripts/`, and neither reaches the other at load time. Where the two halves must know
// the same thing anyway — an env-var name, the OAuth constants, the reasoning vocabulary —
// each side is deliberately self-contained and a test pins the copies together, the way
// `usage` shares only its log path (docs/tech-debt.md §3).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { RUNTIME_SOURCE_TREES } from "./lib/custom-layer.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AUTHORED = join(ROOT, "agent");

// Every module-looking literal, not just `import`/`export` clauses: a specifier parked in
// a `const` and fed to a dynamic `import()` escapes the tree exactly as hard. Bare npm
// packages are none of the guard's business, but the manifest-resolved forms are matched
// without an extension too: `@iva/<name>` (a `file:packages/<name>` dependency) and
// `#<alias>/<path>` (the `imports` map). A string has to be exactly the specifier, so prose
// that merely names one (`# Iva diagnose package`, `#planner` in a comment) stays out.
const MODULE_LITERAL =
  /"((?:@iva\/[^"\n]+)|(?:#[A-Za-z0-9._-]+\/[^"\n]*)|(?:[^"\n]+\.(?:ts|mts|mjs|js)))"/gu;

const importsMap = (): [string, string][] => {
  const manifest: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const entries =
    typeof manifest === "object" && manifest !== null && "imports" in manifest
      ? Object.entries(manifest.imports as Record<string, string>)
      : [];
  // Node picks the most specific pattern; longest prefix first reproduces that.
  return entries.sort(
    ([left], [right]) => right.indexOf("*") - left.indexOf("*"),
  );
};

// `@iva/<name>` — единственные bare-спецификаторы, ведущие в это же дерево: манифест
// объявляет их как `file:packages/<name>`, а не как npm-версию. Неизвестное имя обязано
// упасть с названием: опечатка в импорте не должна молча выпасть из обхода.
function localPackageDir(specifier: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const dependencies =
    typeof manifest === "object" &&
    manifest !== null &&
    "dependencies" in manifest
      ? (manifest.dependencies as Record<string, unknown>)
      : {};
  const mapped = dependencies[specifier];
  if (typeof mapped !== "string" || !mapped.startsWith("file:packages/"))
    throw new Error(
      `${specifier}: package.json has no "file:packages/<name>" dependency for it, so the guard cannot resolve the import`,
    );
  return join(ROOT, mapped.slice("file:".length));
}

// Absolute path the specifier points at, or null when it names a bare package/builtin.
function targetOf(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("."))
    return resolve(dirname(join(ROOT, fromFile)), specifier);
  if (specifier.startsWith("@iva/"))
    return join(localPackageDir(specifier), "index.ts");
  if (!specifier.startsWith("#")) return null;
  for (const [pattern, mapped] of importsMap()) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) return join(ROOT, mapped);
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (
      specifier.length >= head.length + tail.length &&
      specifier.startsWith(head) &&
      specifier.endsWith(tail)
    ) {
      const filled = specifier.slice(
        head.length,
        specifier.length - tail.length,
      );
      return join(ROOT, mapped.replace("*", filled));
    }
  }
  return null;
}

function productionTypeScriptFiles(tree: string): string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      // Tests and their fixtures (`*.test-fixture.ts`, imported by tests only) are not shipped
      // in the bundle eve rebuilds, so they cannot drag `scripts/` into it; the guard judges
      // the production surface only.
      else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".test-fixture.ts")
      )
        files.push(relativePath);
    }
  };
  visit(tree);
  return files.sort();
}

// Every edge out of the authored tree, as "file -> specifier".
function escapes(): string[] {
  const found = new Set<string>();
  for (const file of productionTypeScriptFiles("agent")) {
    for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(
      MODULE_LITERAL,
    )) {
      const target = targetOf(match[1], file);
      if (target !== null && relative(AUTHORED, target).startsWith(".."))
        found.add(`${file} -> ${match[1]}`);
    }
  }
  return [...found].sort();
}

// OpenCode has two runtime consumers of the same protocol resolver: model-provider
// selects reasoning controls, and provider selects the transport factory. Sharing the
// validated vocabulary with setup prevents the UI and runtime accepting different values.
test("the authored tree has only its explicit shared-package edges", () => {
  assert.deepEqual(
    escapes(),
    [
      "agent/instructions/05-language.ts -> @iva/data-dir",
      "agent/instructions/20-core.ts -> @iva/vault-dir",
      "agent/instructions/25-persona.ts -> @iva/vault-dir",
      "agent/instructions/now.ts -> @iva/data-dir",
      "agent/instructions/now.ts -> @iva/timezone",
      "agent/lib/claude-cli.ts -> ../../packages/claude-command/index.ts",
      "agent/lib/context-window.ts -> ../../packages/context-window/index.ts",
      "agent/lib/data-dir.ts -> ../../packages/data-dir/index.ts",
      "agent/lib/job-facts.ts -> ../../packages/secret-redaction/index.ts",
      "agent/lib/model-auth-alert.ts -> ../../packages/alert-state/index.ts",
      "agent/lib/model-provider.ts -> @iva/opencode-protocol",
      "agent/lib/security-gate.ts -> ../../packages/secret-redaction/index.ts",
      "agent/lib/telegram-media-cache.ts -> @iva/vault-dir",
      "agent/lib/telegram-media.ts -> @iva/vault-dir",
      "agent/lib/telegram-turn-start.ts -> @iva/vault-dir",
      "agent/lib/timezone.ts -> @iva/timezone",
      "agent/lib/vault-daily.ts -> @iva/vault-dir",
      "agent/lib/vault-error.ts -> @iva/vault-dir",
      "agent/lib/vault-file-search.ts -> @iva/vault-dir",
      "agent/provider.ts -> @iva/opencode-protocol",
      "agent/tools/memory_search.ts -> @iva/vault-dir",
      "agent/tools/send_file.ts -> ../../packages/secret-redaction/index.ts",
      "agent/tools/write_card.ts -> @iva/vault-dir",
      "agent/tools/write_file.ts -> @iva/vault-dir",
    ],
    "agent/ may leave its tree only for the shared packages Eve bundles: @iva/data-dir, @iva/vault-dir, @iva/timezone, @iva/context-window and @iva/opencode-protocol, plus the one rule that cuts secrets for both `iva diagnose` and the schedule log tail the agent reads (a second copy of that rule is how a token inside `bot<token>` stayed in data/jobs.json), and the one rule that finds the claude CLI for both the runtime and `iva doctor` (two copies let the doctor pass a command the runtime could not start)",
  );
});

// Which top-level tree a resolved target belongs to, or null when the literal leaves the
// repository — a path assembled for a temporary tree in a fixture is text, not an edge of
// this build.
function treeOf(target: string): string | null {
  const inside = relative(ROOT, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`)) return null;
  return inside.split(sep)[0];
}

// Every foreign tree the runtime source reaches into, as "file -> specifier -> tree".
function crossTreeEdges(): string[] {
  const edges = new Set<string>();
  for (const tree of RUNTIME_SOURCE_TREES)
    for (const file of productionTypeScriptFiles(tree))
      for (const match of readFileSync(join(ROOT, file), "utf8").matchAll(
        MODULE_LITERAL,
      )) {
        const target = targetOf(match[1], file);
        const referenced = target === null ? null : treeOf(target);
        if (referenced === null || referenced === tree) continue;
        edges.add(`${file} -> ${match[1]} -> ${referenced}`);
      }
  return [...edges].sort();
}

function treesTheRuntimeImports(): string[] {
  return [
    ...new Set(
      crossTreeEdges().map((edge) => edge.slice(edge.lastIndexOf(" ") + 1)),
    ),
  ].sort();
}

test("every tree the runtime imports is carried into the promoted runtime", () => {
  const carried = new Set<string>(RUNTIME_SOURCE_TREES);
  assert.deepEqual(
    crossTreeEdges().filter(
      (edge) => !carried.has(edge.slice(edge.lastIndexOf(" ") + 1)),
    ),
    [],
    "materializeCustomLayer copies only RUNTIME_SOURCE_TREES into data/custom/runtimes, so a tree missing from that list leaves the promoted agent with an import eve cannot resolve — add it in scripts/lib/custom-layer.ts",
  );
});

test("the cross-tree scan reads the edges it judges", () => {
  // Both halves are pinned: a scan that stopped matching would pass the guard above
  // vacuously, and a new tree in the topology has to be seen by a human.
  assert.deepEqual(treesTheRuntimeImports(), ["agent", "packages"]);
});

// eve bundles every authored module as one chunk (`buildSingleRolldownChunk` in
// node_modules/eve/dist/src/internal/authored-module-loader.js, code splitting off), and a
// dynamic `import()` in the authored tree does not survive it: 49c69eb3 put one inside the
// status module, and `eve build` failed with "Failed to evaluate authored module" on the
// Telegram channel. scripts/ keeps its dynamic imports — eve does not bundle it. Read by
// the TypeScript parser rather than a regex: a type-position `import("…")` (`typeof
// import("node:sqlite")`, `import("node:sqlite").DatabaseSync`) is erased and stays allowed,
// and an `import()` named in a comment or a string is not code.
function dynamicImports(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      found.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

test("the authored tree has no dynamic import()", () => {
  assert.deepEqual(
    productionTypeScriptFiles("agent").flatMap((file) =>
      dynamicImports(file, readFileSync(join(ROOT, file), "utf8")),
    ),
    [],
    "eve bundles every authored module as one chunk, so a dynamic import() in agent/ breaks `eve build` (Failed to evaluate authored module) — import the module statically; a process that must load without it gets its own module without that import",
  );
});

test("the dynamic import() scan sees value imports and lets erased type imports pass", () => {
  // Both halves are pinned: a scan that stopped seeing import() would pass the guard above
  // vacuously. The first line is statusPhrase as 49c69eb3 wrote it.
  assert.deepEqual(
    dynamicImports(
      "probe.ts",
      [
        'const { redactNotice } = await import("./outbox.ts");',
        'const later = () => import("#lib/outbox.ts");',
        'type Sqlite = typeof import("node:sqlite");',
        'let db: import("node:sqlite").DatabaseSync;',
        '// await import("./outbox.ts") named in a comment',
        "const prose = \"await import('./outbox.ts')\";",
      ].join("\n"),
    ),
    ["probe.ts:1", "probe.ts:2"],
  );
});

// Only `from "..."` clauses: a dynamic import() is exactly the escape hatch a CLI module
// uses when it needs the authored tree at call time but must still load without it.
// Passing here therefore does not make a module movable — a command may still need it at
// call time; `scripts/cli/account-entrypoints.test.ts` runs the commands themselves.
// Anchored at the start of a line, where a static import/export clause is the only thing
// that can stand: prose in a comment naming an import no longer counts as one.
const FROM_CLAUSE =
  /^\s*(?:import|export)\b(?<clause>[^"]*?)\bfrom\s+"(?<specifier>[^"\n]+)"/gmu;

// A side-effect import binds no name and so has no `from`, but it loads the module just the
// same — which is all the permanent `.mjs` entry shims do (`import "./setup/main.ts"`).
const SIDE_EFFECT_IMPORT = /^\s*import\s+"(?<specifier>[^"\n]+)"/gmu;

// Specifiers a load actually resolves. `import type`/`export type` clauses are erased by
// the compiler, so they emit no require of the authored tree at run time and cannot break
// a CLI running without it; an inline `{ type X }` inside a value clause still loads the
// module, so only the type-only form is dropped.
function loadTimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(FROM_CLAUSE)) {
    const { clause, specifier } = match.groups as {
      clause: string;
      specifier: string;
    };
    if (/^\s*type\b/u.test(clause)) continue;
    specifiers.push(specifier);
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT))
    specifiers.push((match.groups as { specifier: string }).specifier);
  return specifiers;
}

// Processes that must load on an install whose `agent/` is missing, beyond `scripts/cli/*` —
// exactly the "broken tree" state of ADR-0003. The walk stops at a child process, so every
// separate node run has to be named. These three are the ones no systemd unit starts: the
// setup wizard (install.sh and `iva config`), the vault template copy install.sh runs before
// eve has ever built the tree, and the updater's second half, which the previous version
// spawns inside the version it just fetched.
const SPAWNED_ENTRYPOINTS = [
  "scripts/setup.mjs",
  "scripts/init-vault.mjs",
  "scripts/update-finish.ts",
];

// The bridge is the one unit that is meant to load the authored tree: it renders Iva's own
// Telegram UI (`#lib/i18n.ts`, `#lib/run-status.ts`) and runs beside `iva.service`, which is
// what builds the tree in the first place.
const AUTHORED_TREE_UNITS = new Set(["scripts/telegram-poll.mjs"]);

const UNIT_EXEC_START = /^ExecStart=.*?(scripts\/\S+\.(?:ts|mjs))/gmu;

// Every node process `deploy/` starts as a unit of its own, read out of the units instead of
// listed by hand: the nightly brain got coupled to the authored tree precisely because
// a hand-written list did not know its unit existed.
function unitNodeEntrypoints(): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(join(ROOT, "deploy"))) {
    if (!name.endsWith(".service")) continue;
    const unit = readFileSync(join(ROOT, "deploy", name), "utf8");
    for (const match of unit.matchAll(UNIT_EXEC_START)) found.add(match[1]);
  }
  return [...found].sort();
}

function brokenTreeUnitEntrypoints(): string[] {
  return unitNodeEntrypoints().filter(
    (entrypoint) => !AUTHORED_TREE_UNITS.has(entrypoint),
  );
}

// Every edge the CLI would resolve at load time, as "importer -> specifier".
function cliEdgesIntoAuthoredTree(): string[] {
  const edges: string[] = [];
  const seen = new Set<string>();
  const queue = readdirSync(join(ROOT, "scripts/cli"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => posix.join("scripts/cli", name))
    .concat(SPAWNED_ENTRYPOINTS, brokenTreeUnitEntrypoints());
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of loadTimeSpecifiers(
      readFileSync(join(ROOT, file), "utf8"),
    )) {
      const target = targetOf(specifier, file);
      if (target === null) continue;
      if (!relative(AUTHORED, target).startsWith(".."))
        edges.push(`${file} -> ${specifier}`);
      else queue.push(posix.normalize(relative(ROOT, target)));
    }
  }
  return edges.sort();
}

test("the CLI loads without the authored tree present", () => {
  assert.deepEqual(
    cliEdgesIntoAuthoredTree(),
    [],
    "iva update and iva doctor run on installs whose agent/ is missing or half-written — reach the authored tree through a dynamic import inside the call that needs it",
  );
});

test("the broken-tree walk covers every node unit deploy/ starts", () => {
  // Both halves are pinned: the full read proves the units are actually being parsed and
  // shows a new one, and the filtered read proves the bridge is the only thing excused —
  // an exemption for a unit that no longer exists cannot sit here unnoticed.
  assert.deepEqual(unitNodeEntrypoints(), [
    "scripts/check-update.mjs",
    "scripts/memory/brain.ts",
    "scripts/telegram-poll.mjs",
  ]);
  assert.deepEqual(brokenTreeUnitEntrypoints(), [
    "scripts/check-update.mjs",
    "scripts/memory/brain.ts",
  ]);
});

test("the CLI walk keeps value imports and drops only the erased type-only ones", () => {
  assert.deepEqual(
    loadTimeSpecifiers(
      'import { runScheduledJob } from "#lib/schedule-runner.ts";',
    ),
    ["#lib/schedule-runner.ts"],
    "a value import of the authored tree must still fail the CLI load-time walk",
  );
  assert.deepEqual(
    loadTimeSpecifiers(
      'import { readFileSync, type Stats } from "#lib/schedule-runner.ts";\nexport * from "#lib/settings.ts";',
    ),
    ["#lib/schedule-runner.ts", "#lib/settings.ts"],
  );
  assert.deepEqual(
    loadTimeSpecifiers(
      'import type { ScheduleCron } from "#lib/schedule-table.ts";\nexport type { ScheduleName } from "#lib/schedule-table.ts";',
    ),
    [],
  );
  // The entry shims import for side effect only; missing those would leave every process
  // behind a shim unwalked.
  assert.deepEqual(loadTimeSpecifiers('import "./setup/main.ts";'), [
    "./setup/main.ts",
  ]);
  // A dynamic import is the escape hatch, and stays invisible to the walk.
  assert.deepEqual(
    loadTimeSpecifiers(
      'const { clampCore } = await import("#lib/core-clamp.ts");',
    ),
    [],
  );
});

test("the guard resolves #-aliases through package.json instead of trusting the prefix", () => {
  assert.equal(
    targetOf("#lib/i18n.ts", "agent/agent.ts"),
    join(AUTHORED, "lib/i18n.ts"),
  );
  assert.equal(
    targetOf("#evals/smoke.ts", "agent/agent.ts"),
    join(ROOT, "evals/smoke.ts"),
  );
  assert.equal(targetOf("eve/channels", "agent/agent.ts"), null);
});

test("a missing @iva package is a named error, not a silent null", () => {
  // Объявленный пакет резолвится по манифесту: `file:packages/<name>` → `packages/<name>/index.ts`.
  assert.equal(
    targetOf("@iva/vault-dir", "agent/agent.ts"),
    join(ROOT, "packages/vault-dir/index.ts"),
  );
  // Неизвестный обязан назвать себя: тихий null выбросил бы импорт из обхода молча.
  assert.throws(
    () => targetOf("@iva/несуществующий", "agent/agent.ts"),
    /@iva\/несуществующий/u,
  );
});

// The literal username "user" is the portable fixture, never a machine identity.
const MACHINE_HOME =
  /\/(?:home|Users)\/(?!user(?=[^A-Za-z0-9._-]|$))[A-Za-z][A-Za-z0-9._-]*(?=[^A-Za-z0-9._-]|$)/u;
test("tracked product files use portable home paths", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const offenders = tracked.filter(
    (file) =>
      !file.startsWith("eve/") &&
      MACHINE_HOME.test(readFileSync(join(ROOT, file), "utf8")),
  );
  assert.deepEqual(offenders, [], "machine home path in tracked file");
});
test("home-path guard catches Linux and macOS names and allows portable fixtures", () => {
  for (const prefix of ["/home/", "/Users/"]) {
    assert.equal(MACHINE_HOME.test(`${prefix}fixture-owner/iva`), true);
    assert.equal(MACHINE_HOME.test(`${prefix}fixture.owner`), true);
    assert.equal(
      MACHINE_HOME.test(`HOME=${prefix}alice and "${prefix}bob"`),
      true,
    );
    assert.equal(MACHINE_HOME.test(`${prefix}user/iva`), false);
    assert.equal(MACHINE_HOME.test(`${prefix}user`), false);
    assert.equal(MACHINE_HOME.test(`${prefix}username`), true);
  }
});
