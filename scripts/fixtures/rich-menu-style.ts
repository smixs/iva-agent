// Тестовая фикстура: свежий каталог данных с menuStyle=rich, чтобы тесты отправки экранов
// проверяли rich-путь (по умолчанию у пользователя classic). Импортировать ПЕРВОЙ строкой:
// каталог фиксируется модулем settings на его импорте.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

if (!process.env.ASSISTANT_DATA_DIR) {
  process.env.ASSISTANT_DATA_DIR = tempDir("iva-rich-menu-");
}
writeFileSync(
  join(process.env.ASSISTANT_DATA_DIR, "settings.json"),
  JSON.stringify({ menuStyle: "rich" }),
  { mode: 0o600 },
);
