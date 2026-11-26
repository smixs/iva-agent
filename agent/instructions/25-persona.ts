import { colleagueBotIdOfTurn, isHelperTurn } from "../lib/eve-auth.ts";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  vaultDirErrorText,
  vaultMisconfiguredMarkdown,
} from "../lib/vault-error.ts";
import { resolveVaultDir } from "@iva/vault-dir";

// Динамическая инструкция: каждый турн инжектит PERSONA Ивы (vault/PERSONA.md) в
// системный промпт — тон, инициативность, стиль ответов, настроенные тестом-квизом в
// /menu. Живёт рядом с CORE (20-core.ts): always-on, переживает компактацию
// (инструкции — не часть сжимаемой истории диалога), применяется со следующего
// сообщения без рестарта (квиз пишет файл — инструкция его подхватывает на очередном
// турне). Самодостаточна — только eve + node fs/path (гоча eve 0.11.4).
const MAX_CHARS = 800; // жёсткий лимит персоны — держим always-on пол плоским.

function personaMarkdown(): string {
  let persona: string;
  try {
    persona = readFileSync(
      join(resolveVaultDir(process.cwd()), "PERSONA.md"),
      "utf8",
    ).trim();
  } catch (error) {
    // Неверная настройка — блок с причиной владельцу; отсутствие файла — тишина.
    if (vaultDirErrorText(error) !== null)
      return vaultMisconfiguredMarkdown(error);
    return ""; // нет файла (квиз не пройден) — молча ничего не инжектим.
  }
  if (!persona) return ""; // пустой файл — тоже ничего не инжектим.
  if (persona.length > MAX_CHARS) {
    persona = persona.slice(0, MAX_CHARS) + "\n…(PERSONA усечена)";
  }
  return `## PERSONA — стиль общения (настроен тестом /menu)\n${persona}`;
}

export default defineDynamic({
  events: {
    // turn.started — перечитывается каждый турн, чтобы смена PERSONA в /menu применялась
    // со следующего сообщения без рестарта.
    "turn.started": (_event, ctx) =>
      isHelperTurn(ctx) || colleagueBotIdOfTurn(ctx) !== null
        ? null
        : defineInstructions({ markdown: personaMarkdown() }),
  },
});
