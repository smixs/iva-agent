// Какие скиллы отдаёт плагин — ОДИН список на всю Иву.
//
// Его читает и ридер плагина (`iva plugin add`, `list`, `doctor`), и живой резолвер
// скиллов (agent/skills/custom.ts). Два разных ответа на этот вопрос уже стоили бы
// дорого: гейт коллизий на установке пропускал бы то, что агент потом грузит, а
// `list` показывал бы владельцу не тот набор, что уходит в промпт.
//
// Правило — по спеке Agent Plugins §7.1: только непосредственные дети `skills/`,
// в каждом обычный файл `SKILL.md`, рекурсии нет. Содержимое `SKILL.md` обязано
// удовлетворять спеке Agent Skills: frontmatter с `name` и `description`. Скилл,
// который правилу не отвечает, пропускается поимённо — соседи грузятся.
//
// Функция НИКОГДА не кидает: на входе путь, на выходе список и диагностики.
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

// Имя скилла становится ОДНИМ сегментом пути в песочнице eve, и eve его проверяет
// (shared/skill-package.js → assertSafeSkillPackageName). Имя вне правила eve бросит
// уже у себя, и ход останется вообще без динамических скиллов.
export const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SKILLS_DIR = "skills";

export type PluginSkillRef = {
  readonly name: string;
  /** Путь папки скилла относительно корня плагина, POSIX-разделители. */
  readonly path: string;
  /** Абсолютный путь той же папки — им читают содержимое. */
  readonly dir: string;
};

type PluginSkillListing = {
  readonly skills: readonly PluginSkillRef[];
  readonly diagnostics: readonly string[];
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** Причина, по которой `SKILL.md` не годится, или null. */
function skillProblem(markdown: string): string | null {
  let fields;
  try {
    fields = parseFrontmatter(markdown).fields;
  } catch (error) {
    return `SKILL.md frontmatter is damaged: ${reason(error)}`;
  }
  if (!fields) return "SKILL.md has no frontmatter";
  for (const field of ["name", "description"] as const) {
    const value = fields[field];
    if (typeof value !== "string" || !value.trim())
      return `SKILL.md frontmatter is missing ${JSON.stringify(field)}`;
  }
  return null;
}

/**
 * Скиллы одного плагина по его корню. Нет каталога `skills/` — пустой список без
 * диагностики (§6.2: отсутствие фиксированного места компоненты не ошибка).
 */
export async function listPluginSkills(
  root: string,
): Promise<PluginSkillListing> {
  const skillsDir = join(root, SKILLS_DIR);
  const diagnostics: string[] = [];
  let stat;
  try {
    stat = await lstat(skillsDir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      diagnostics.push(`skills: unreadable: ${reason(error)}`);
    return { skills: [], diagnostics };
  }
  if (!stat.isDirectory()) {
    diagnostics.push("skills: not a directory; skills component skipped");
    return { skills: [], diagnostics };
  }

  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(`skills: unreadable: ${reason(error)}`);
    return { skills: [], diagnostics };
  }

  const skills: PluginSkillRef[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // Обычный файл в `skills/` просто не скилл: детьми считаются только папки.
    if (!entry.isDirectory()) continue;
    if (!SAFE_SKILL_NAME.test(entry.name)) {
      diagnostics.push(
        `skills/${entry.name}: skipped: name must match ${SAFE_SKILL_NAME.source}`,
      );
      continue;
    }
    const dir = join(skillsDir, entry.name);
    const markdownPath = join(dir, "SKILL.md");
    let markdown: string;
    try {
      if (!(await lstat(markdownPath)).isFile()) {
        diagnostics.push(
          `skills/${entry.name}: skipped: SKILL.md is not a regular file`,
        );
        continue;
      }
      markdown = await readFile(markdownPath, "utf8");
    } catch (error) {
      diagnostics.push(
        `skills/${entry.name}: skipped: ${
          errorCode(error) === "ENOENT" ? "no SKILL.md" : reason(error)
        }`,
      );
      continue;
    }
    const problem = skillProblem(markdown);
    if (problem) {
      diagnostics.push(`skills/${entry.name}: skipped: ${problem}`);
      continue;
    }
    skills.push({
      name: entry.name,
      path: `${SKILLS_DIR}/${entry.name}`,
      dir,
    });
  }
  return { skills, diagnostics };
}
