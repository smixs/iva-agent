// Временный каталог теста с уборкой. Каждый тест-файл идёт своим процессом, и каталоги
// убираются на его выходе. Хук `after` из node:test тут не годится: корневой хук файла с
// `await test(…)` на верхнем уровне срабатывает после первого же дождавшегося теста, и
// каталог, созданный на уровне файла, исчезал бы под следующими тестами.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

// Отказ удаления одного каталога (недоступный потомок) называется и не прерывает уборку
// остальных.
process.on("exit", () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`tempDir: ${dir} is left behind: ${String(error)}`);
    }
  }
});

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
