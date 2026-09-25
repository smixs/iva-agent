// Чтение и запись .env мастером установки. Путь приходит параметром: живой .env, файл-кандидат
// `iva config` или временный файл теста.
import { readFile } from "node:fs/promises";
import {
  formatEnvLine,
  parseEnvText,
  writeEnvAtomicSync,
} from "../lib/env-file.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import type { Env, ThrownSetupError } from "./steps.ts";

/** Абсолютный каталог data настройки (тот же, что видит агент из cwd=root): там codex-auth.json. */
export function dataDirOf(root: string, env: Env | null | undefined): string {
  return resolveDataDir(root, env?.ASSISTANT_DATA_DIR);
}

/** Порядок ключей в записанном .env; чужие ключи идут следом в своём порядке. */
const ENV_ORDER = [
  "AGENT_LANGUAGE",
  "MODEL_PROVIDER",
  "OLLAMA_API_KEY",
  "OLLAMA_MODEL",
  "OLLAMA_VISION_MODEL",
  "OLLAMA_CONTEXT_WINDOW",
  "OPENCODE_API_KEY",
  "OPENCODE_MODEL",
  "OPENCODE_VISION_MODEL",
  "OPENCODE_CONTEXT_WINDOW",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_VISION_MODEL",
  "OPENROUTER_CONTEXT_WINDOW",
  "CODEX_MODEL",
  "CODEX_CONTEXT_WINDOW",
  "CLAUDE_MODEL",
  "CLAUDE_CONTEXT_WINDOW",
  "CLAUDE_COMMAND",
  "CUSTOM_BASE_URL",
  "CUSTOM_API_KEY",
  "CUSTOM_MODEL",
  "CUSTOM_VISION_MODEL",
  "CUSTOM_CONTEXT_WINDOW",
  "CUSTOM_REASONING",
  "REQUESTY_API_KEY",
  "REQUESTY_MODEL",
  "REQUESTY_VISION_MODEL",
  "REQUESTY_CONTEXT_WINDOW",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_DIGEST_CHAT_ID",
  "DEEPGRAM_API_KEY",
  "DEEPGRAM_LANGUAGE",
  "SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "MEMORY_SEARCH_MODE",
  "JINA_API_KEY",
  "DEEPINFRA_API_KEY",
  "ASSISTANT_TIMEZONE",
  "ASSISTANT_VAULT_DIR",
  "ASSISTANT_DATA_DIR",
  "IVA_PORT",
  "ASSISTANT_HOST",
  "ASSISTANT_BEARER",
];

/** Текущий .env; нет файла — пустая настройка, любой другой сбой чтения — отказ. */
export async function loadEnvFile(path: string): Promise<Env> {
  try {
    // parseEnvText, а не своя регулярка: мастер обязан судить о существующей
    // настройке по тому значению, которое получит запущенный агент.
    return parseEnvText(await readFile(path, "utf8"));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return {};
    throw error;
  }
}

const codeOf = (error: unknown) =>
  (error as ThrownSetupError | null | undefined)?.code;

/** Ключи в порядке записи. */
export function orderedKeys(out: Env): string[] {
  return [
    ...ENV_ORDER.filter((k) => out[k] != null),
    ...Object.keys(out).filter((k) => !ENV_ORDER.includes(k)),
  ];
}

// Строку, которую мастер сочинил сам, он обязан записать в безопасном подмножестве -
// это и проверяется при каждом вопросе. Но в .env попадает и то, что уже лежало там
// до нас: чужой ключ вроде `my.key`, значение с кириллицей, краевым пробелом или
// переносом строки. Дословно такую строку не записать: значение с переносом строки
// разваливается надвое, и вторая половина становится настоящей переменной, которой
// владелец не задавал (так подменялся ASSISTANT_DATA_DIR). Поэтому строка не пишется
// вовсе, а ключ называется вслух (`dropped`) - молча терять строку владельца нельзя.
// Уронить весь прогон на последнем шаге и потерять все ответы хуже и того, и другого.
// Файл пишется синхронно при вызове; обещание — ради общего вида с остальным контекстом.
export function writeEnvFile(
  path: string,
  out: Env,
  dropped: (key: string) => void,
): Promise<void> {
  const lines = orderedKeys(out).flatMap((k) => envLine(k, out[k], dropped));
  writeEnvAtomicSync(path, lines.join("\n") + "\n");
  return Promise.resolve();
}

function envLine(
  key: string,
  value: string,
  dropped: (key: string) => void,
): string[] {
  try {
    return [formatEnvLine(key, String(value))];
  } catch {
    dropped(key);
    return [];
  }
}
