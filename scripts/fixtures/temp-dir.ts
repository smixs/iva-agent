// Временный каталог теста с уборкой. Каждый тест-файл идёт своим процессом, и каталоги
// убираются на его выходе. Хук `after` из node:test тут не годится: корневой хук файла с
// `await test(…)` на верхнем уровне срабатывает после первого же дождавшегося теста, и
// каталог, созданный на уровне файла, исчезал бы под следующими тестами.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
