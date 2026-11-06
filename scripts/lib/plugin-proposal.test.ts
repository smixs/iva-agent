/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Предложение плагина на диске: разбор колбэка, забор тапом, уборка, тексты владельцу.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { pluginTreeDigest } from "#lib/plugin-reader.ts";
import {
  carriesCodeOrMcp,
  commandLines,
  findProposal,
  notInstalledText,
  parseProposalCallback,
  PROPOSAL_TTL_MS,
  proposalFolder,
  proposalText,
  proposalReadmeLines,
  returnProposal,
  sweepProposals,
  takenDir,
  takeProposal,
} from "./plugin-proposal.ts";

const SEED = 2_026_100_401;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const en = (english: string) => english;
const ru = (_english: string, russian: string) => russian;
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function proposals(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-proposal-"));
  dirs.push(dir);
  return dir;
}

test("d22 README: optional sections translate labels and stop at the next heading", async () => {
  const root = proposals();
  assert.deepEqual(await proposalReadmeLines(ru, root), []);
  writeFileSync(
    join(root, "README.md"),
    "## Keys\r\nSERVICE_KEY\r\n### Details\r\nnot a key\r\n## Network\r\napi.example.org\r\n# Usage\r\nnot a host\r\n",
  );
  assert.deepEqual(await proposalReadmeLines(ru, root), [
    "Ключи: SERVICE\\_KEY",
    "Сеть: api.example.org",
  ]);
  assert.deepEqual(await proposalReadmeLines(en, root), [
    "Keys: SERVICE\\_KEY",
    "Network: api.example.org",
  ]);
  writeFileSync(
    join(root, "README.md"),
    "# Keys\nnot a section\n## Usage\nold draft\n",
  );
  assert.deepEqual(await proposalReadmeLines(ru, root), []);
  writeFileSync(join(root, "README.md"), "## Keys\n\n## Network\nnone\n");
  assert.deepEqual(await proposalReadmeLines(ru, root), ["Сеть: none"]);
  rmSync(join(root, "README.md"));
  mkdirSync(join(root, "README.md"));
  assert.deepEqual(await proposalReadmeLines(ru, root), []);
});

test("d22 README: long Unicode data is clipped without breaking a surrogate pair", async () => {
  const root = proposals();
  writeFileSync(
    join(root, "README.md"),
    `## Keys\n${"🙂".repeat(200)}\n## Network\n${"<tg-button>".repeat(200)}\n`,
  );
  const lines = await proposalReadmeLines(en, root);
  assert.equal(lines[0], `Keys: ${"🙂".repeat(119)}…`);
  assert.ok(Array.from(lines[1].slice("Network: ".length)).length <= 120);
  assert.doesNotMatch(lines[1], /[<>]/u);
});

for (const seed of [182201, 182202]) {
  test(`d22 PROPERTY: README sections round-trip declarations and ignore unrelated content (seed=${seed})`, async () => {
    const root = proposals();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[A-Z][A-Z0-9]{0,8}$/u), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9]{0,8}\.example\.org$/u), {
          minLength: 1,
          maxLength: 3,
        }),
        fc.string({ unit: "grapheme", maxLength: 100 }),
        async (keys, hosts, noise) => {
          const sections = `## Keys\n${keys.join(", ")}\n## Network\n${hosts.join(", ")}\n`;
          writeFileSync(join(root, "README.md"), sections);
          const expected = [
            `Keys: ${keys.join(", ")}`,
            `Network: ${hosts.join(", ")}`,
          ];
          assert.deepEqual(await proposalReadmeLines(en, root), expected);
          writeFileSync(
            join(root, "README.md"),
            `# Readme\ntext\n${sections}## Other\n${noise.replace(/^#/gmu, "x")}\n`,
          );
          assert.deepEqual(await proposalReadmeLines(en, root), expected);
        },
      ),
      { seed, numRuns: 60 },
    );
  });
}

/** Предложение на диске, как его кладёт `propose`: папка `<name>-<digest12>`. */
async function plant(dir: string, name = "relay"): Promise<string> {
  const staging = join(dir, `.staging-${name}`);
  mkdirSync(staging);
  writeFileSync(join(staging, "plugin.json"), `{"name":"${name}"}`);
  writeFileSync(join(staging, "mcp.json"), "{}");
  const digest12 = (await pluginTreeDigest(staging)).slice(0, 12);
  const folder = join(dir, proposalFolder(name, digest12));
  renameSync(staging, folder);
  const stamp = new Date(NOW);
  utimesSync(folder, stamp, stamp);
  return digest12;
}

test(`PROPERTY: only iva_plugin:ok:<12 hex> is a proposal tap (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.string().map((tail) => `iva_plugin:ok:${tail}`),
        fc
          .stringMatching(/^[a-f0-9]{12}$/u)
          .map((hex) => `iva_plugin:ok:${hex}`),
      ),
      (data) => {
        const digest12 = parseProposalCallback(data);
        if (digest12 === null) return;
        assert.match(digest12, /^[a-f0-9]{12}$/u);
        assert.equal(data, `iva_plugin:ok:${digest12}`);
      },
    ),
    { seed: SEED },
  );
});

test("a path in the callback never names a folder", () => {
  for (const data of [
    "iva_plugin:ok:../../../etc",
    "iva_plugin:ok:0123456789ab/..",
    "iva_plugin:ok:.taken-01234",
  ])
    assert.equal(parseProposalCallback(data), null, data);
});

test("a tap takes the proposal once: the second tap of the pair finds nothing", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);
  const take = () =>
    takeProposal({ dir, digest12, nowMs: NOW, digest: pluginTreeDigest });

  const [first, second] = await Promise.all([take(), take()]);
  const outcomes = [first.status, second.status].sort();
  assert.deepEqual(outcomes, ["stale", "taken"]);
  assert.ok(existsSync(takenDir(dir, digest12)));
  assert.equal(findProposal(dir, digest12), null);
});

test("a proposal whose files changed after propose is not taken and is removed", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);
  writeFileSync(join(dir, proposalFolder("relay", digest12), "evil.sh"), "x");

  const outcome = await takeProposal({
    dir,
    digest12,
    nowMs: NOW,
    digest: pluginTreeDigest,
  });

  assert.deepEqual(outcome, { status: "stale", name: "relay" });
  assert.deepEqual(readdirSync(dir), []);
});

test("a proposal older than a day is stale even with a matching tree hash", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);

  const outcome = await takeProposal({
    dir,
    digest12,
    nowMs: NOW + PROPOSAL_TTL_MS + 1,
    digest: pluginTreeDigest,
  });

  assert.equal(outcome.status, "stale");
});

test("a proposal that cannot be read is stale, not a crash", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);

  const outcome = await takeProposal({
    dir,
    digest12,
    nowMs: NOW,
    digest: () => Promise.reject(new Error("EACCES")),
  });

  assert.equal(outcome.status, "stale");
});

test("returned proposal can be taken again", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);
  const take = () =>
    takeProposal({ dir, digest12, nowMs: NOW, digest: pluginTreeDigest });
  const first = await take();
  assert.equal(first.status, "taken");
  assert.equal(first.status === "taken" && first.proposedMs, NOW);

  returnProposal(
    dir,
    "relay",
    digest12,
    first.status === "taken" ? first.proposedMs : 0,
  );

  assert.equal(findProposal(dir, digest12), "relay");
  assert.equal((await take()).status, "taken");
});

test("sweep removes proposals and taken copies older than a day, and keeps fresh ones", async () => {
  const dir = proposals();
  const fresh = await plant(dir, "fresh");
  const old = await plant(dir, "old");
  mkdirSync(takenDir(dir, "aaaaaaaaaaaa"));
  const past = new Date(NOW - PROPOSAL_TTL_MS - 60_000);
  utimesSync(join(dir, proposalFolder("old", old)), past, past);
  utimesSync(takenDir(dir, "aaaaaaaaaaaa"), past, past);

  sweepProposals(dir, NOW);

  assert.deepEqual(readdirSync(dir), [proposalFolder("fresh", fresh)]);
});

test("mcp.json or sh.iva/ on disk makes a plugin proposal-only, even when broken", () => {
  const root = proposals();
  assert.equal(carriesCodeOrMcp(root), false);
  writeFileSync(join(root, "mcp.json"), "not json");
  assert.equal(carriesCodeOrMcp(root), true);
  rmSync(join(root, "mcp.json"));
  mkdirSync(join(root, "sh.iva"));
  assert.equal(carriesCodeOrMcp(root), true);
});

test("the message names at most ten commands of 120 characters and counts the rest", () => {
  const commands = Array.from(
    { length: 12 },
    (_, i) => `mcp s${i}: node ${"x".repeat(200)}`,
  );
  const lines = commandLines(en, { commands, code: true });

  assert.equal(lines.length, 11);
  assert.ok(lines.slice(0, 10).every((line) => line.length <= 120));
  assert.equal(lines[10], "… and 3 more");
  assert.deepEqual(commandLines(ru, { commands: [], code: true }), [
    "код расширения в процессе Ивы",
  ]);
});

test("owner texts follow the spec word for word in both languages", () => {
  assert.equal(
    proposalText(ru, "relay", ["mcp viewer: node serve.mjs"], 3),
    "Плагин relay просит установку. Будет запускать: mcp viewer: node serve.mjs. Файлов: 3. Установка перезапустит меня на минуту.",
  );
  assert.equal(
    proposalText(en, "relay", ["mcp viewer: node serve.mjs"], 3),
    "Plugin relay asks to be installed. It will run: mcp viewer: node serve.mjs. Files: 3. Installing will restart me for a minute.",
  );
  assert.equal(
    notInstalledText(ru, "relay", "x".repeat(400)),
    `Плагин relay не установился: ${"x".repeat(300)}`,
  );
});

// PluginProposal.TakeStamp -> Begin/SweepSparesTaken: the installer owns its
// copy for less than TTL after the tap, including taps long after propose.
test("a late tap keeps the taken plugin copy through a sweep while its installer holds it", async () => {
  const dir = proposals();
  const digest12 = await plant(dir);
  const tappedAt = NOW + 20 * 60 * 60 * 1_000;
  const outcome = await takeProposal({
    dir,
    digest12,
    nowMs: tappedAt,
    digest: pluginTreeDigest,
  });
  assert.equal(outcome.status, "taken");
  sweepProposals(dir, NOW + 26 * 60 * 60 * 1_000);
  const taken = takenDir(dir, digest12);
  assert.equal(
    existsSync(taken),
    true,
    "six hours of installation keep the taken copy",
  );
  assert.equal((await pluginTreeDigest(taken)).slice(0, 12), digest12);
});
