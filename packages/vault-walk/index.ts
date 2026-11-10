import { readdirSync } from "node:fs";
import { join } from "node:path";

// Один обход «все .md vault» для поиска, индекса ссылок, эмбеддингов и чистки: что видит
// один, видят все. Раньше у каждого был свой список пропуска, и карточку в archive/ поиск
// находил, а ссылку на неё запись отклоняла.
const SKIP_DIRS = new Set([
  ".obsidian",
  "attachments",
  ".git",
  ".graph",
  ".claude",
  ".trash",
  "backup",
  "archive",
  "__pycache__",
]);

/**
 * Все .md под `dir`, кроме каталогов из списка пропуска: абсолютные пути по алфавиту.
 * Сам `dir` под список не попадает. Нечитаемый каталог пропускается; `onUnreadable`
 * узнаёт о нём и может бросить, если обход обязан быть полным.
 */
export function vaultMarkdownFiles(
  dir: string,
  onUnreadable: (dir: string, error: unknown) => void = () => {},
): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    onUnreadable(dir, error);
    return [];
  }
  return entries
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return SKIP_DIRS.has(entry.name)
          ? []
          : vaultMarkdownFiles(path, onUnreadable);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
    .sort();
}
