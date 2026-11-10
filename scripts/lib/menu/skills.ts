// Экран скиллов: read-only список из .eve/agent-summary.json (skills[] {name, description}),
// по 8 на страницу. Файл — продукт сборки eve; путь от deps.root (корень репо). В worktree
// его может не быть — тогда честный текст, а не пустой экран. Пагинацию (pg) двигает движок.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  button,
  buttonRow,
  escapeRichText,
  menuBackLine,
} from "../telegram-buttons.ts";

const PER_PAGE = 8;

interface SkillsContext {
  deps: { root: string };
  tr: (english: string, russian: string) => string;
}

interface SkillsState {
  page?: number;
}

interface Skill {
  name?: unknown;
  description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function skillFrom(value: unknown): Skill {
  return isRecord(value) ? value : {};
}

function displayText(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- JSON values retain the JavaScript screen's original String coercion.
  return String(value);
}

export default {
  parent: "r",
  render(st: SkillsState, ctx: SkillsContext) {
    const T = ctx.tr;
    let skills: unknown[] | null;
    try {
      const data: unknown = JSON.parse(
        readFileSync(join(ctx.deps.root, ".eve/agent-summary.json"), "utf8"),
      );
      const candidate = isRecord(data) ? data.skills : undefined;
      skills = Array.isArray(candidate) ? candidate : [];
    } catch {
      skills = null; // файла нет / битый — отличаем от «список пуст»
    }
    if (skills === null) {
      return {
        text: [
          `# ${T("🧩 Skills", "🧩 Скиллы")}`,
          T(
            "Skill list is unavailable — .eve/agent-summary.json not found (it appears after a build).",
            "Список недоступен — .eve/agent-summary.json не найден (появляется после сборки).",
          ),
          menuBackLine({ tr: T }, "r"),
        ].join("\n\n"),
      };
    }
    if (skills.length === 0) {
      return {
        text: [
          `# ${T("🧩 Skills", "🧩 Скиллы")}`,
          T("No skills registered.", "Скиллов не зарегистрировано."),
          menuBackLine({ tr: T }, "r"),
        ].join("\n\n"),
      };
    }
    const pages = Math.ceil(skills.length / PER_PAGE);
    const page = Math.min(Math.max(st.page || 0, 0), pages - 1);
    st.page = page;
    const body = skills
      .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
      .map((value) => {
        const skill = skillFrom(value);
        const name = escapeRichText(displayText(skill.name, "?"));
        const desc = escapeRichText(
          displayText(skill.description, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60),
        );
        return `• ${name}${desc ? ` — ${desc}` : ""}`;
      })
      .join("\n");
    const lines = [
      `# ${T(`🧩 Skills (${skills.length})`, `🧩 Скиллы (${skills.length})`)}`,
      body,
    ];
    if (pages > 1) {
      lines.push(
        buttonRow([
          button("‹", `iva_menu:sk:pg:${page > 0 ? page - 1 : 0}`),
          button(`${page + 1}/${pages}`, `iva_menu:sk:pg:${page}`),
          button(
            "›",
            `iva_menu:sk:pg:${page < pages - 1 ? page + 1 : pages - 1}`,
          ),
        ]),
      );
    }
    lines.push(menuBackLine({ tr: T }, "r"));
    return { text: lines.join("\n\n") };
  },
  on(...args: unknown[]) {
    void args;
  },
};
