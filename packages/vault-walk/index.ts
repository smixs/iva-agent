import { readdirSync } from "node:fs";
import { join } from "node:path";

// Один обход «все .md vault» для поиска, индекса ссылок, эмбеддингов и чистки. Технические
// каталоги пишут программы, карточек человека там нет: их пропускает каждый обход. Всё
// остальное — содержимое человека, и обход его видит; кому в названный каталог человека
// заходить нельзя (чистке — в archive, индексу ссылок — в attachments), называет его сам.
const TECHNICAL_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".obsidian",
  ".claude",
  ".trash",
  ".graph",
  ".index",
  ".cache",
  ".next",
  "dist",
  "node_modules",
  "__pycache__",
]);

export interface VaultWalkOptions {
  /** Каталоги человека, в которые этот обход не заходит, — сверх технических. */
  readonly skip?: readonly string[];
  /** Узнаёт о нечитаемом каталоге и может бросить, если обход обязан быть полным. */
  readonly onUnreadable?: (dir: string, error: unknown) => void;
}

/**
 * Все .md под `dir`, кроме технических каталогов и названных в `skip`: абсолютные пути по
 * алфавиту. Сам `dir` под пропуск не попадает. Нечитаемый каталог пропускается.
 */
export function vaultMarkdownFiles(
  dir: string,
  options: VaultWalkOptions = {},
): string[] {
  const skip = new Set([...TECHNICAL_DIRS, ...(options.skip ?? [])]);
  const walk = (at: string): string[] => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch (error) {
      options.onUnreadable?.(at, error);
      return [];
    }
    return entries
      .flatMap((entry) => {
        const path = join(at, entry.name);
        if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(path);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      })
      .sort();
  };
  return walk(dir);
}
