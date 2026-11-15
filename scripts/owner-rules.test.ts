/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import type { ToolContext } from "eve/tools";

// Тесты источника правил и проводки write_file живут в scripts/: файл рядом с тулами
// eve счёл бы ещё одним тулом и сборка упала бы. Хук резолвинга идёт первым — тулы
// тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";
import { tempDir } from "./fixtures/temp-dir.ts";

const dataDir = tempDir("iva-owner-rules-");
process.env.ASSISTANT_DATA_DIR = dataDir;

// Гвард карточек T15 отказывает перезаписи существующего файла, если вольт
// не резолвится: слоту нужна перезапись, поэтому вольт в стенде настоящий.
const vaultDir = tempDir("iva-owner-rules-vault-");
mkdirSync(join(vaultDir, "cards"), { recursive: true });
process.env.ASSISTANT_VAULT_DIR = vaultDir;

const { default: writeFileTool } = await import("../agent/tools/write_file.ts");
const { default: ownerRulesSource } =
  await import("../agent/instructions/30-owner-rules.ts");
const { ownerRulesMarkdown } = await import("../agent/lib/owner-rules.ts");

type WriteFileAnswer =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly path: string; readonly error: string };

// Второй аргумент execute — контекст хода; тестам тулов он не нужен, а eve типизирует
// ответ тула как «значение или поток». Тул отвечает значением.
const ctx = {} as unknown as ToolContext;

const writeFile = (input: { path: string; content: string }) =>
  writeFileTool.execute(input, ctx) as Promise<WriteFileAnswer>;

const rulesDir = join(dataDir, "custom", "agent", "instructions");
const rulesPath = join(rulesDir, "rules.md");
const HEADER =
  "# Owner rules\n\nThese rules add to the bundled persona and load every turn.\n\n";

beforeEach(() => {
  rmSync(rulesDir, { recursive: true, force: true });
  rmSync(join(dataDir, "custom/agent/instructions.md"), { force: true });
});

test("a rule written through write_file is in the prompt on the next turn", async () => {
  mkdirSync(rulesDir, { recursive: true });
  const first = await writeFile({
    path: rulesPath,
    content: `${HEADER}- no emoji\n`,
  });
  assert.ok(first.ok);
  const second = await writeFile({
    path: rulesPath,
    content: `${HEADER}- no emoji\n- one paragraph per reply\n`,
  });
  assert.ok(second.ok);
  assert.deepEqual(
    readFileSync(rulesPath),
    Buffer.from(`${HEADER}- no emoji\n- one paragraph per reply\n`, "utf8"),
  );

  writeFileSync(join(rulesDir, "10-tone.md"), "- dry tone\n");
  const markdown = ownerRulesMarkdown(rulesDir);
  assert.ok(markdown.includes("### 10-tone.md"));
  assert.ok(markdown.includes("### rules.md"));
  assert.ok(
    markdown.indexOf("### 10-tone.md") < markdown.indexOf("### rules.md"),
  );
  assert.ok(markdown.includes("- dry tone"));
  assert.ok(markdown.includes("- no emoji"));

  // Проводка: default-экспорт источника отдаёт тот же текст на turn.started.
  const started = ownerRulesSource.events["turn.started"];
  assert.ok(started);
  const instructions = await started({}, {} as never);
  assert.ok(instructions);
  assert.match(JSON.stringify(instructions), /no emoji/u);
  assert.match(JSON.stringify(instructions), /dry tone/u);
});

test("write_file still writes ordinary files under data", async () => {
  const target = join(dataDir, "custom/agent/skills/x.md");
  const answer = await writeFile({ path: target, content: "skill\n" });
  assert.ok(answer.ok);
  assert.equal(readFileSync(target, "utf8"), "skill\n");
});

test("write_file writes the owner instruction files", async () => {
  mkdirSync(rulesDir, { recursive: true });
  for (const target of [rulesPath, join(rulesDir, "10-tone.md")]) {
    const answer = await writeFile({ path: target, content: "- mine\n" });
    assert.ok(answer.ok);
    assert.equal(readFileSync(target, "utf8"), "- mine\n");
  }
  assert.ok(existsSync(rulesPath));
});

test("the source stays silent without a directory and with an empty file", () => {
  assert.equal(ownerRulesMarkdown(rulesDir), "");

  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(rulesPath, "");
  assert.equal(ownerRulesMarkdown(rulesDir), "");

  writeFileSync(join(rulesDir, "10-tone.md"), "  \n");
  assert.equal(ownerRulesMarkdown(rulesDir), "");
});
