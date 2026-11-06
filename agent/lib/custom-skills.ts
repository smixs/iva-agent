// Скиллы, прочитанные с диска на ходу, а не собранные: свой Custom layer
// (data/custom/agent/skills/) и `skills/` включённых плагинов (data/custom/plugins/).
//
// Зачем: скилл, созданный ивой во время разговора, должен работать сразу. Встроенные
// скиллы вкомпилированы в бандл при сборке, поэтому новый файл рядом с ними виден только
// после `iva update`. Здесь тот же каталог читается на ходу, а eve отдаёт результат
// модели как динамический скилл (agent/skills/custom.ts).
//
// Формы каталога своего слоя — те же две, что понимает eve: пакет `<name>/SKILL.md`
// с соседними файлами и плоский `<name>.md`. Имя скилла = имя папки или файла без
// `.md`. У плагина форма одна, пакетная: так велит спека Agent Plugins.
//
// Функция чистая и не знает про eve: на вход путь, на выход карта скиллов. Она НИКОГДА
// не кидает наружу — резолвер, бросивший исключение, лишает ход всех динамических
// скиллов сразу (eve ловит его и пропускает резолвер целиком). Битая запись пропускается
// одной строкой в лог, остальные скиллы отдаются.
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { dataDir } from "./data-dir.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { listPluginSkills, SAFE_SKILL_NAME } from "./plugin-skills.ts";
import {
  enabledPlugins,
  pluginRoot,
  readPluginsStateSafe,
} from "./plugin-store.ts";

export type CustomSkill = {
  readonly description: string;
  readonly markdown: string;
  /** Соседние файлы пакета (references/, scripts/, assets/) — путь относительно пакета. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
};

/** Каталог пользовательских скиллов; сюда же кладёт скиллы сама ива. */
export function customSkillsDir(): string {
  return join(dataDir(), "custom", "agent", "skills");
}

// Описание попадает в системный промпт на каждом ходу. Файл без frontmatter, у которого
// первая строка длиной в абзац, иначе раздувал бы промпт — режем.
export const DESCRIPTION_CAP = 120;

type Kind = "package" | "flat";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** Пакет, плоский `.md` или ничего. Симлинк разбирается по цели. */
async function kindOf(dir: string, entry: Dirent): Promise<Kind | null> {
  let isDirectory = entry.isDirectory();
  if (entry.isSymbolicLink()) {
    try {
      isDirectory = (await stat(join(dir, entry.name))).isDirectory();
    } catch {
      return null; // битый симлинк — тот же случай, что и отсутствующая запись
    }
  } else if (!isDirectory && !entry.isFile()) {
    return null;
  }
  if (isDirectory) return "package";
  return entry.name.endsWith(".md") ? "flat" : null;
}

function skillName(name: string, kind: Kind): string {
  return kind === "package" ? name : name.slice(0, -".md".length);
}

/** Первая осмысленная строка тела — тот же фолбэк описания, что у eve для плоских `.md`. */
function firstMeaningfulLine(body: string): string | null {
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line) continue;
    // Маркеры снимаются по одному, пока они есть: цитата с заголовком («> ## Заголовок»)
    // прячет текст за двумя.
    let stripped = line;
    for (let i = 0; i < 4; i++) {
      const next = stripped.replace(/^[#>*-]+\s*/u, "").trim();
      if (next === stripped) break;
      stripped = next;
    }
    if (stripped) return stripped;
  }
  return null;
}

type Described = {
  readonly description: string;
  /** Длина описания до усечения; null — описание уложилось в DESCRIPTION_CAP. */
  readonly truncatedFrom: number | null;
};

export function describeSkill(name: string, markdown: string): Described {
  let description: string | null;
  try {
    const { fields, body } = parseFrontmatter(markdown);
    const declared = fields?.description;
    description =
      typeof declared === "string" && declared.trim()
        ? declared.trim()
        : firstMeaningfulLine(body);
  } catch {
    // Битый frontmatter — не повод терять скилл: описание берём из тела.
    description = firstMeaningfulLine(markdown);
  }
  // Тот же слабый фолбэк, что у eve: скилл остаётся загружаемым по имени.
  if (!description)
    return {
      description: `Instructions for the ${name} skill.`,
      truncatedFrom: null,
    };
  if (description.length > DESCRIPTION_CAP) {
    // Не оставлять одинокий старший суррогат: эмодзи на границе усечения превращался
    // в «�» в индексе скиллов - тем же приёмом режет CORE (agent/lib/core-clamp.ts).
    let end = DESCRIPTION_CAP - 1;
    if (
      end > 0 &&
      /[\uD800-\uDBFF]/.test(description[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(description[end])
    )
      end -= 1;
    return {
      description: `${description.slice(0, end).trimEnd()}…`,
      truncatedFrom: description.length,
    };
  }
  return { description, truncatedFrom: null };
}

// Потолок одного файла скилла: тело и соседи читаются на каждом ходу, поэтому
// без потолка один гигант тормозит ход и раздувает контекст. Настоящие скиллы —
// десятки килобайт (самый большой встроенный — 56 КБ), запас четырёхкратный.
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Соседние файлы пакета. Пути, которые eve не примет, и нечитаемые файлы отбрасываются. */
async function packageFiles(
  packageDir: string,
  name: string,
  log: (line: string) => void,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let entries: Dirent[];
  try {
    entries = await readdir(packageDir, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    log(`[skills] custom skill ${name} files skipped: ${reason(error)}`);
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relative(packageDir, absolute).split(sep).join("/");
    // SKILL.md eve генерирует сам из markdown и бросает, если он пришёл файлом.
    if (path === "SKILL.md") continue;
    if (path.includes("\\")) continue; // eve примет только POSIX-путь
    let size: number;
    try {
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile()) continue;
      size = fileStat.size;
    } catch (error) {
      log(
        `[skills] custom skill ${name} file ${path} skipped: ${reason(error)}`,
      );
      continue;
    }
    if (size > MAX_SKILL_FILE_BYTES) {
      log(
        `[skills] custom skill ${name} file ${path} skipped: ${size} bytes, cap ${MAX_SKILL_FILE_BYTES}`,
      );
      continue;
    }
    try {
      files[path] = await readFile(absolute);
    } catch (error) {
      log(
        `[skills] custom skill ${name} file ${path} skipped: ${reason(error)}`,
      );
    }
  }
  return files;
}

async function readOne(
  dir: string,
  entryName: string,
  kind: Kind,
  name: string,
  log: (line: string) => void,
  label = "custom skill",
): Promise<CustomSkill | null> {
  const markdownPath =
    kind === "package"
      ? join(dir, entryName, "SKILL.md")
      : join(dir, entryName);
  const source = kind === "package" ? join(entryName, "SKILL.md") : entryName;
  // Читать только обычный файл: блочное/символьное устройство и FIFO без писателя
  // отдают бесконечный поток — readFile ждёт EOF, которого нет, и виснет весь ход
  // (eve ждёт резолвер без дедлайна). stat идёт за симлинком, как и чтение.
  try {
    const target = await stat(markdownPath);
    if (!target.isFile()) {
      log(`[skills] ${label} ${name} skipped: ${source} is not a regular file`);
      return null;
    }
    if (target.size > MAX_SKILL_FILE_BYTES) {
      log(
        `[skills] ${label} ${name} skipped: ${source} is ${target.size} bytes, cap ${MAX_SKILL_FILE_BYTES}`,
      );
      return null;
    }
  } catch (error) {
    log(
      `[skills] ${label} ${name} skipped: ${
        code(error) === "ENOENT" && kind === "package"
          ? "no SKILL.md"
          : reason(error)
      }`,
    );
    return null;
  }
  let markdown: string;
  try {
    markdown = await readFile(markdownPath, "utf8");
  } catch (error) {
    log(
      `[skills] ${label} ${name} skipped: ${
        code(error) === "ENOENT" && kind === "package"
          ? "no SKILL.md"
          : reason(error)
      }`,
    );
    return null;
  }
  const { description, truncatedFrom } = describeSkill(name, markdown);
  if (truncatedFrom !== null) {
    const key = `description-cap\u0000${label}\u0000${name}\u0000${source}\u0000${truncatedFrom}`;
    if (!reportedDiagnostics.has(key)) {
      reportedDiagnostics.add(key);
      log(
        `[skills] ${label} ${name} (${source}) description is ${truncatedFrom} characters, cap ${DESCRIPTION_CAP}; truncated in the prompt index`,
      );
    }
  }
  if (kind === "flat") return { description, markdown };
  const files = await packageFiles(join(dir, entryName), name, log);
  return Object.keys(files).length > 0
    ? { description, markdown, files }
    : { description, markdown };
}

/**
 * Карта скиллов из каталога: имя → скилл. Каталога нет — пустая карта без шума
 * (обычное состояние установки, где пользователь ещё ничего не написал).
 */
export async function readCustomSkills(
  dir: string,
  log: (line: string) => void = console.error,
): Promise<Record<string, CustomSkill>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (code(error) !== "ENOENT")
      log(`[skills] custom skills unreadable: ${reason(error)}`);
    return {};
  }

  // Пакет старше плоского файла с тем же именем: он несёт ещё и соседние файлы, а
  // eve всё равно принял бы только одно имя.
  const chosen = new Map<string, { entryName: string; kind: Kind }>();
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const kind = await kindOf(dir, entry);
    if (kind === null) continue;
    const name = skillName(entry.name, kind);
    if (!SAFE_SKILL_NAME.test(name)) {
      log(
        `[skills] custom skill ${name} skipped: name must match ${SAFE_SKILL_NAME.source}`,
      );
      continue;
    }
    // Сортировка ставит папку `foo` перед файлом `foo.md`, поэтому первым всегда
    // приходит пакет — второму с тем же именем места нет.
    const previous = chosen.get(name);
    if (previous) {
      log(
        `[skills] custom skill ${name} skipped: ${entry.name} loses to ${previous.entryName}`,
      );
      continue;
    }
    chosen.set(name, { entryName: entry.name, kind });
  }

  const skills: Record<string, CustomSkill> = {};
  for (const [name, { entryName, kind }] of [...chosen].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const skill = await readOne(dir, entryName, kind, name, log);
    if (skill) skills[name] = skill;
  }
  return skills;
}

// Одна и та же жалоба не должна повторяться на каждом ходу: и про битый
// plugins.json, и про кривой скилл плагина, и про усечённое описание кастомного
// скилла достаточно сказать один раз за жизнь процесса. Набор маленький и ограничен
// числом скиллов на диске.
let damagedStateReported = false;
const reportedDiagnostics = new Set<string>();

/**
 * Все скиллы, которые агент видит с диска на этом ходу: свой Custom layer плюс
 * `skills/` ВКЛЮЧЁННЫХ плагинов (ADR-0009). Сборка и рестарт не нужны — поставил
 * плагин, со следующего хода его скиллы работают.
 *
 * Какие скиллы предлагает плагин, решает listPluginSkills — тот же список, что
 * видят `iva plugin add` и `iva doctor`. Содержимое читается ТОЛЬКО у победителей:
 * скилл, проигравший имя, стоил бы чтения всех своих файлов впустую, а платит за
 * это каждый ход.
 *
 * Порядок при совпадении имён: свой Custom layer ближе плагина и побеждает его,
 * плагин побеждает ядровой скилл (это делает сам eve: динамический скилл
 * перекрывает встроенный). Одно имя у ДВУХ плагинов `iva plugin add` не пускает;
 * если такое состояние всё же сложилось, выигрывает первый по алфавиту, а второй
 * уходит в лог — тихо терять скилл нельзя.
 *
 * Как и readCustomSkills, наружу НИКОГДА не кидает и НИЧЕГО не пишет: исключение
 * здесь стоило бы ходу всех динамических скиллов сразу, а запись на горячем пути —
 * молчаливой потери списка плагинов.
 */
export async function readLiveSkills(
  log: (line: string) => void = console.error,
): Promise<Record<string, CustomSkill>> {
  const data = dataDir();
  const own = await readCustomSkills(customSkillsDir(), log);
  const { state, damaged } = await readPluginsStateSafe(data);
  if (damaged && !damagedStateReported) {
    damagedStateReported = true;
    log(`[skills] plugins are not loaded: ${damaged.message}`);
  }

  const skills: Record<string, CustomSkill> = { ...own };
  const owner = new Map<string, string>();
  for (const plugin of enabledPlugins(state)) {
    const root = pluginRoot(data, plugin.name);
    const listing = await listPluginSkills(root);
    for (const line of listing.diagnostics) {
      const once = `${plugin.name}\u0000${line}`;
      if (reportedDiagnostics.has(once)) continue;
      reportedDiagnostics.add(once);
      log(`[skills] plugin ${plugin.name}: ${line}`);
    }
    for (const ref of listing.skills) {
      if (Object.hasOwn(own, ref.name)) {
        log(
          `[skills] plugin skill ${ref.name} from ${plugin.name} shadowed by data/custom/agent/skills`,
        );
        continue;
      }
      const previous = owner.get(ref.name);
      if (previous !== undefined) {
        log(
          `[skills] plugin skill ${ref.name} from ${plugin.name} skipped: ${previous} already provides it`,
        );
        continue;
      }
      owner.set(ref.name, plugin.name);
      const skill = await readOne(
        dirname(ref.dir),
        ref.name,
        "package",
        ref.name,
        log,
        "plugin skill",
      );
      if (skill) skills[ref.name] = skill;
    }
  }
  return skills;
}
