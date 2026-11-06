/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { readCustomSkills } from "#lib/custom-skills.ts";
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import { pluginRoot, readPluginsState } from "#lib/plugin-store.ts";
import { createPluginCommands } from "./plugin.ts";
import { createCliRuntime } from "./runtime.ts";

const SEED = Number(process.env.FC_SEED ?? 1018120);

async function checkDescription(
  description: string,
  action: "add" | "propose",
  draft: boolean,
) {
  const root = mkdtempSync(join(tmpdir(), "iva-description-cap-"));
  try {
    const data = join(root, "data");
    // A prefix sibling must remain an ordinary external source.
    const source = join(
      data,
      "custom",
      draft ? "plugin-drafts" : "plugin-drafts-other",
      "case",
    );
    mkdirSync(join(source, "skills/case"), { recursive: true });
    writeFileSync(
      join(source, "plugin.json"),
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "case" }),
    );
    writeFileSync(
      join(source, "skills/case/SKILL.md"),
      `---\nname: case\ndescription: ${JSON.stringify(description)}\n---\nBody.\n`,
    );
    if (action === "propose")
      writeFileSync(
        join(source, "mcp.json"),
        JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: {} }),
      );
    const warnings: string[] = [],
      screens: string[] = [];
    const runtime = {
      ...createCliRuntime(root),
      hasSystemd: () => false,
      readEnv: () => ({
        TELEGRAM_BOT_TOKEN: "424242:test-token",
        TELEGRAM_ALLOWED_USER_IDS: "42",
      }),
      warn: (line: string) => warnings.push(line),
      ok: () => {},
      bad: () => {},
      step: () => {},
    };
    const { cmdPlugin } = createPluginCommands(runtime, {
      interactive: () => false,
      cwd: () => root,
      log: () => {},
      translate: (en) => en,
      sends: {
        screen: (_token, _chat, text) => {
          screens.push(text);
          return Promise.resolve({ ok: true, error: "" });
        },
      },
    });
    const problem = `описание скилла case — ${description.length} знаков, предел 120; сократи до триггера "Use when…"`;
    await cmdPlugin([action, source]);
    assert.equal(
      action === "add"
        ? (await readPluginsState(data)).plugins.length
        : screens.length,
      1,
    );
    assert.equal(warnings.includes(problem), description.length > 120);
    const installedSource =
      action === "add" ? pluginRoot(data, "case") : source;
    const skills = await readCustomSkills(
      join(installedSource, "skills"),
      () => {},
    );
    assert.ok(skills.case.description.length <= 120);
    if (description.length <= 120)
      assert.equal(skills.case.description, description);
    else assert.ok(skills.case.description.endsWith("…"));
    if (draft && action === "add" && description.length === 120) {
      writeFileSync(
        join(source, "skills/case/SKILL.md"),
        `---\nname: case\ndescription: ${JSON.stringify(`${description}x`)}\n---\nBody.\n`,
      );
      await cmdPlugin(["update", "case"]);
      assert.ok(
        warnings.some((line) => line.includes("121 знаков, предел 120")),
      );
      assert.equal((await readPluginsState(data)).plugins.length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const action of ["add", "propose"] as const) {
  test(`${action}: draft boundary 120/121 and external compatibility`, async () => {
    await checkDescription("a".repeat(120), action, true);
    await checkDescription("a".repeat(121), action, true);
    await checkDescription("a".repeat(200), action, true);
    await checkDescription("a".repeat(121), action, false);
    // 60 emoji occupy 120 UTF-16 code units, despite being 60 code points.
    await checkDescription("🙂".repeat(60), action, true);
    await checkDescription(`${"🙂".repeat(60)}я`, action, true);
  });
}

test(`draft length policy and external warnings over Unicode (seed ${SEED})`, async () => {
  console.error(`[plugin-description-cap] seed ${SEED}`);
  await fc.assert(
    fc.asyncProperty(
      fc
        .array(fc.constantFrom("a", "я", "界", "🙂", "e\u0301"), {
          minLength: 55,
          maxLength: 130,
        })
        .map((parts) => parts.join("")),
      fc.boolean(),
      async (description, draft) => {
        for (const action of ["add", "propose"] as const)
          await checkDescription(description, action, draft);
      },
    ),
    { seed: SEED, numRuns: 32 },
  );
});
