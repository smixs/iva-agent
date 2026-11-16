// Процесс-приёмник для scripts/lib/version-store-session.test.ts: свежий процесс,
// который читает сохранённую запись сессии just-bash, подключается к ней на
// каталоге версии и печатает отложенный файл. Только так проверяется возврат
// сессии после отката — reattach в том же процессе держал бы sandbox живым.
import { readFileSync } from "node:fs";
import { justbash } from "eve/sandbox/just-bash";

const [appRoot, statePath, filePath] = process.argv.slice(2);
const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
  sessionKey: string;
  metadata: Record<string, unknown>;
};
const backend = justbash();
const handle = await backend.create({
  existingMetadata: persisted.metadata,
  runtimeContext: { appRoot },
  sessionKey: persisted.sessionKey,
  templateKey: null,
});
const content = await handle.session.readTextFile({ path: filePath });
await handle.shutdown();
if (content === null) {
  console.error(`sandbox session lost: ${filePath} not found`);
  process.exit(1);
}
process.stdout.write(content);
