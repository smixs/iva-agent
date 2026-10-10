/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Что проверяет: у каждого production-файла (agent/**, scripts/**, кроме тестов
// и фикстур) есть хотя бы один *.test.ts, который его грузит: импорт, dynamic
// import, запуск дочерним процессом, чтение исходника как текста, сверка набора
// файлов каталога. Либо путь лежит в BLIND_SPOT с причиной одной строкой.
// Чего не проверяет: глубину покрытия (это делает test:coverage), transitively
// загруженные модули без прямого теста, изменения графа импортов без новых путей.
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

// Слепое пятно: модули без прямого теста. Причина — одна строка на путь.
// Путь сюда попадает, только если ни один тест его не грузит (проверяется ниже);
// у каждого пути с тестом место вне списка.
const BLIND_SPOT: ReadonlyArray<{
  readonly path: string;
  readonly why: string;
}> = [
  // Границы фреймворка: грузит только eve, тесты гоняют швы вокруг.
  { path: "agent/agent.ts", why: "сборка eve; тесты держат провайдер и тулзы" },
  {
    path: "agent/channels/eve.ts",
    why: "адаптер канала eve; тесты идут через инбаунд",
  },
  {
    path: "agent/instructions/05-language.ts",
    why: "динамика eve; язык проверен через ходы",
  },
  // Транзитивно покрыты: свой тест грузит соседа, этот едет прицепом.
  {
    path: "agent/lib/plugin-skills.ts",
    why: "прицеп plugin-store/reader; листинг в их тестах",
  },
  {
    path: "agent/lib/telegram-allowlist.ts",
    why: "прицеп инбаунда; allowlist гоняют его тесты",
  },
  {
    path: "agent/lib/telegram-private-chat.ts",
    why: "прицеп канала; приватный чат в тестах канала",
  },
  {
    path: "scripts/lib/cli-translate.ts",
    why: "прицеп plugin/trace CLI; перевод в их тестах",
  },
  {
    path: "scripts/lib/plugin-core.ts",
    why: "прицеп plugin CLI; ядро в его тестах",
  },
  {
    path: "scripts/cli/plugin-cli-install.ts",
    why: "прицеп plugin CLI; install-команды в его тестах",
  },
  {
    path: "scripts/cli/plugin-cli-marketplace.ts",
    why: "прицеп plugin CLI; маркетплейс в его тестах",
  },
  {
    path: "scripts/cli/plugin-cli-trust.ts",
    why: "прицеп plugin CLI; trust-юниты в его тестах",
  },
  // Отдельные процессы: выполняются только на живой установке.
  {
    path: "scripts/check-bash-cwd.ts",
    why: "ручная проверка разработчика, не рантайм",
  },
  {
    path: "scripts/migrations/001-iva-port.ts",
    why: "одноразовая миграция версии 0.3.3",
  },
  {
    path: "scripts/replica-smoke.ts",
    why: "ручной стенд; e2e идет через capture/analyze",
  },
  {
    path: "scripts/live-turn.ts",
    why: "стенд приёмки: живой ход на настоящем провайдере, сам и есть проверка",
  },
];

const EXPECTED_COVERAGE_COMMAND =
  'node --test --test-concurrency=4 --experimental-test-coverage --test-coverage-include="agent/**/*.ts" --test-coverage-include="scripts/**/*.ts" --test-coverage-exclude="**/*.test.ts" --test-coverage-exclude="scripts/fixtures/**/*.ts" --test-coverage-lines=75 --test-coverage-branches=77 --test-coverage-functions=71 "agent/**/*.test.ts" "scripts/**/*.test.ts"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (relativePath !== "scripts/fixtures") visit(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  }

  visit("agent");
  visit("scripts");
  return files.sort();
}

function testFiles(): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".test.ts"))
        files.push(relativePath);
    }
  }

  visit("agent");
  visit("scripts");
  visit("services");
  return files.sort();
}

function importsMap(): Array<[string, string]> {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  if (!isRecord(parsed) || !isRecord(parsed.imports)) return [];
  return Object.entries(parsed.imports).flatMap(([pattern, mapped]) =>
    typeof mapped === "string" ? [[pattern, mapped] as [string, string]] : [],
  );
}

// Абсолютный путь, на который указывает specifier из файла, или null.
// Карта импортов читается из package.json, а не из префикса: префиксу нельзя верить.
function targetOfSpecifier(
  specifier: string,
  fromFile: string,
  imports: Array<[string, string]>,
): string | null {
  const clean = specifier.split("?")[0];
  if (clean.startsWith(".")) {
    const direct = resolve(dirname(join(ROOT, fromFile)), clean);
    if (direct.startsWith(`${ROOT}${sep}`) && existsSync(direct)) return direct;
    // Спецификатор вида ./agent/... из теста внутри дерева: меряют от корня
    // (рантайм-харнессы вроде runInRepo исполняют код с cwd корня).
    const fromRoot = resolve(ROOT, clean);
    if (fromRoot.startsWith(`${ROOT}${sep}`) && existsSync(fromRoot))
      return fromRoot;
    return direct.startsWith(`${ROOT}${sep}`) ? direct : null;
  }
  if (!clean.startsWith("#")) return null;
  for (const [pattern, mapped] of imports) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === clean) return join(ROOT, mapped);
      continue;
    }
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (
      clean.length >= head.length + tail.length &&
      clean.startsWith(head) &&
      clean.endsWith(tail)
    ) {
      const filled = clean.slice(head.length, clean.length - tail.length);
      return join(ROOT, mapped.replace("*", filled));
    }
  }
  return null;
}

function toProductionPath(absolute: string): string | null {
  const relative = absolute.startsWith(`${ROOT}${sep}`)
    ? absolute
        .slice(ROOT.length + 1)
        .split(sep)
        .join("/")
    : null;
  if (
    relative === null ||
    !(relative.startsWith("agent/") || relative.startsWith("scripts/"))
  )
    return null;
  const candidates = [relative];
  if (relative.endsWith(".js")) candidates.push(`${relative.slice(0, -3)}.ts`);
  if (relative.endsWith(".mjs")) candidates.push(`${relative.slice(0, -4)}.ts`);
  if (!/\.(m?[jt]s)$/.test(relative))
    candidates.push(`${relative}.ts`, `${relative}/index.ts`);
  for (const candidate of candidates) {
    if (
      candidate.endsWith(".ts") &&
      existsSync(join(ROOT, ...candidate.split("/")))
    )
      return candidate;
  }
  return null;
}

// Строковые эвристики вместо парсера JS: путь в комментарии или в образце кода
// для парсера — не ссылка. Поэтому: режем комментарии (parity по кавычкам),
// затем считаем литерал ссылкой, только если он стоит в load-позиции: импорт,
// dynamic import, new URL, запуск процессом, чтение файла/каталога,
// поле file: контрактов, сборка пути через join, имя каталога + имена файлов.
// argv-массивов здесь нет сознательно: раннер-тесты подменяют spawn, и argv там —
// инертные данные, а не тест файла (прецедент: schedule-runner.test.ts).
function quoteParity(text: string): number {
  const matches = text.match(/['"`]/g);
  return matches === null ? 0 : matches.length % 2;
}

function codeLines(source: string): string[] {
  const out: string[] = [];
  let block = false;
  for (const rawLine of source.split("\n")) {
    let line = rawLine;
    if (block) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      block = false;
    }
    for (;;) {
      let slashSlash = -1;
      for (let i = 0; i < line.length - 1; i += 1) {
        if (
          line[i] === "/" &&
          line[i + 1] === "/" &&
          quoteParity(line.slice(0, i)) % 2 === 0
        ) {
          slashSlash = i;
          break;
        }
      }
      let slashStar = -1;
      for (let i = 0; i < line.length - 1; i += 1) {
        if (
          line[i] === "/" &&
          line[i + 1] === "*" &&
          quoteParity(line.slice(0, i)) % 2 === 0
        ) {
          slashStar = i;
          break;
        }
      }
      if (slashSlash !== -1 && (slashStar === -1 || slashSlash < slashStar)) {
        line = line.slice(0, slashSlash);
        break;
      }
      if (slashStar === -1) break;
      const end = line.indexOf("*/", slashStar + 2);
      if (end === -1) {
        line = line.slice(0, slashStar);
        block = true;
        break;
      }
      line = `${line.slice(0, slashStar)}${line.slice(end + 2)}`;
    }
    out.push(line);
  }
  return out;
}

type Quoted = { readonly value: string; readonly index: number };

function quotedOn(line: string): Quoted[] {
  const found: Quoted[] = [];
  const pattern = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const raw = match[0];
    let value = raw.slice(1, -1);
    if (raw[0] === "`") value = value.replace(/\$\{[^{}]*\}/g, "");
    found.push({ value, index: match.index });
  }
  return found;
}

// Литерал внутри строки-образца: чужие кавычки до него на строке непарны.
function insideForeignString(line: string, index: number): boolean {
  return quoteParity(line.slice(0, index)) % 2 === 1;
}

const WRITE_CALLS = new Set([
  "writeFileSync",
  "appendFileSync",
  "writeFile",
  "appendFile",
  "mkdirSync",
  "mkdir",
  "rmSync",
  "rm",
  "renameSync",
  "rename",
  "symlinkSync",
  "symlink",
  "chmodSync",
  "chmod",
  "truncateSync",
  "utimesSync",
  "mkdtempSync",
]);

const LOAD_CALLS = new Set([
  "spawnSync",
  "spawn",
  "execFileSync",
  "execFile",
  "fork",
  "exec",
  "readFileSync",
  "readFile",
  "existsSync",
  "readdirSync",
  "pathToFileURL",
  "createRequire",
  "cpSync",
  "copyFileSync",
]);

function callNameBefore(line: string, index: number): string | null {
  const before = line.slice(0, index);
  const openParen = before.lastIndexOf("(");
  if (openParen === -1) return null;
  const between = before.slice(openParen);
  if (/[);]/.test(between)) return null;
  return (
    before.slice(0, openParen).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? null
  );
}

// Аргументы вызова с балансом скобок на одной строке.
function callArgs(line: string, nameIndex: number): string | null {
  const openParen = line.indexOf("(", nameIndex);
  if (openParen === -1) return null;
  let depth = 0;
  let i = openParen;
  let quote: string | null = null;
  while (i < line.length) {
    const char = line[i];
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return line.slice(openParen + 1, i);
    }
    i += 1;
  }
  return null;
}

function topLiterals(args: string): string[] {
  const found: string[] = [];
  const pattern = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    const raw = match[0];
    let value = raw.slice(1, -1);
    if (raw[0] === "`") value = value.replace(/\$\{[^{}]*\}/g, "");
    found.push(value);
  }
  return found;
}

function referencesOf(
  testFile: string,
  imports: Array<[string, string]>,
): Set<string> {
  const found = new Set<string>();
  const raw = readFileSync(join(ROOT, testFile), "utf8");
  const lines = codeLines(raw);
  const text = lines.join("\n");
  // Константы вида const P = "./x.ts" для позднейшего import(P): устоявшийся
  // паттерн динамических импортов (menu/status, poller/transport).
  const constPaths = new Map<string, string>();
  for (const line of lines) {
    const decl = line.match(
      /(?:^|[^\w$])const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(\.\.?\/[^\s"']+\.m?[jt]s)\1/,
    );
    if (decl !== null && !insideForeignString(line, line.indexOf(decl[0])))
      constPaths.set(decl[1], decl[3]);
  }
  const testDir = posix.dirname(testFile);

  const claimAbsolute = (absolute: string | null) => {
    if (absolute === null) return;
    const production = toProductionPath(absolute);
    if (production !== null) {
      found.add(production);
    }
  };

  // Спецификатор позиции импорта: тест рядом (testdir), затем корень
  // (./agent/... из тестов внутри дерева меряют от корня).
  const claimSpecifier = (spec: string) => {
    const clean = spec.split("?")[0];
    if (clean.startsWith("#") || clean.startsWith(".")) {
      claimAbsolute(targetOfSpecifier(clean, testFile, imports));
    } else {
      for (const base of [testDir, posix.dirname(testDir), "."]) {
        claimAbsolute(
          join(
            ROOT,
            ...posix
              .normalize(base === "." ? clean : `${base}/${clean}`)
              .split("/"),
          ),
        );
      }
    }
  };

  const claimBare = (value: string) => {
    claimAbsolute(
      join(ROOT, ...posix.normalize(`${testDir}/${value}`).split("/")),
    );
  };

  const claimRooted = (value: string) => {
    claimAbsolute(join(ROOT, ...posix.normalize(value).split("/")));
  };

  const dirEvidence = new Set<string>();
  const baseEvidence = new Set<string>();
  const wordEvidence = new Set<string>();

  const noteDir = (value: string) => {
    const clean = value.split("?")[0].replace(/\/$/, "");
    for (const absolute of [
      targetOfSpecifier(clean, testFile, imports),
      ...[testDir, posix.dirname(testDir), "."].map((base) =>
        join(
          ROOT,
          ...posix
            .normalize(base === "." ? clean : `${base}/${clean}`)
            .split("/"),
        ),
      ),
    ]) {
      if (absolute === null) continue;
      const relative = absolute.startsWith(`${ROOT}${sep}`)
        ? absolute
            .slice(ROOT.length + 1)
            .split(sep)
            .join("/")
        : null;
      if (
        relative !== null &&
        (relative.startsWith("agent/") || relative.startsWith("scripts/"))
      ) {
        try {
          if (readdirSync(absolute, { withFileTypes: true }).length >= 0)
            dirEvidence.add(relative);
        } catch {
          /* не каталог */
        }
      }
    }
  };

  // База join: полный статик — цепочка; dirname — рядом с файлом;
  // ALLCAPS (ROOT/REPO/PROJECT_ROOT) — рядом и корень; строчная temp — только рядом.
  const handleJoinLiterals = (args: string) => {
    const literals = topLiterals(args).filter(
      (literal) => literal.length > 0 && literal.length <= 500,
    );
    for (const literal of literals) {
      if (!literal.endsWith(".ts") && !literal.endsWith(".js"))
        noteDir(literal);
    }
    const dotTs = literals.filter(
      (literal) => literal.endsWith(".ts") || literal.endsWith(".js"),
    );
    if (dotTs.length === 0) return;
    const firstArg = args.split(",")[0];
    const stripped = args
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "")
      .replace(/[\s,]/g, "");
    if (stripped === "") {
      for (const literal of dotTs) claimSpecifier(literal);
    } else if (/dirname|import\.meta\.url|__dirname/.test(firstArg)) {
      for (const literal of dotTs) claimBare(literal);
    } else if (/^\s*[A-Z_][A-Z0-9_]*\s*,/.test(args)) {
      for (const literal of dotTs) {
        claimRooted(literal);
        claimBare(literal);
      }
    } else {
      for (const literal of dotTs) claimBare(literal);
    }
  };

  const lineStarts: number[] = [0];
  for (const line of lines)
    lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);

  const locate = (
    absPos: number,
  ): { readonly lineNo: number; readonly col: number } => {
    let lineNo = 0;
    while (lineNo + 1 < lineStarts.length && lineStarts[lineNo + 1] <= absPos)
      lineNo += 1;
    return { lineNo, col: absPos - lineStarts[lineNo] };
  };

  const parityAt = (absPos: number): number => {
    const { lineNo, col } = locate(absPos);
    return quoteParity(lines[lineNo].slice(0, col)) % 2;
  };

  // Сбалансированные аргументы вызова с абсолютной позиции имени.
  const balancedArgs = (absName: number): string | null => {
    const openParen = text.indexOf("(", absName);
    if (openParen === -1) return null;
    let depth = 0;
    let i = openParen;
    let quote: string | null = null;
    while (i < text.length) {
      const char = text[i];
      if (quote !== null) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = null;
      } else if (char === "'" || char === '"' || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(openParen + 1, i);
      }
      i += 1;
    }
    return null;
  };

  const nameAt = (absPos: number): boolean =>
    absPos > 0 && /[\w$]/.test(text[absPos - 1]);

  // Позиция 2: load-вызовы (многострочные тоже). Вложенные join разбираются
  // по своей базе до остатка: фикстура в temp не засчитывает настоящий файл.
  for (const load of LOAD_CALLS) {
    let at = -1;
    for (;;) {
      at = text.indexOf(load, at + 1);
      if (at === -1) break;
      if (nameAt(at) || parityAt(at) === 1) continue;
      const args = balancedArgs(at);
      if (args === null) continue;
      const argsAbs = text.indexOf("(", at) + 1;
      let rest = args;
      let restAbs = argsAbs;
      for (;;) {
        const next = rest.indexOf("join");
        if (next === -1) break;
        if (next > 0 && /[\w$]/.test(rest[next - 1])) {
          rest = `${rest.slice(0, next)} ${rest.slice(next + 4)}`;
          continue;
        }
        const joinArgs = balancedArgs(restAbs + next);
        if (joinArgs === null) break;
        handleJoinLiterals(joinArgs);
        const openParen = rest.indexOf("(", next);
        if (openParen === -1) {
          rest = `${rest.slice(0, next)} ${rest.slice(next + 4)}`;
          continue;
        }
        const blanked = `${rest.slice(0, next)}    ${" ".repeat(openParen - next)}(${" ".repeat(joinArgs.length)} )${rest.slice(openParen + 1 + joinArgs.length)}`;
        restAbs += blanked.length - rest.length;
        rest = blanked;
      }
      for (const literal of topLiterals(rest)) {
        if (literal.length === 0 || literal.length > 500) continue;
        if (literal.endsWith(".ts") || literal.endsWith(".js")) {
          claimSpecifier(literal);
        } else if (!literal.includes(".") || literal.endsWith("/")) {
          noteDir(literal.replace(/\/$/, ""));
        } else if (!literal.includes("/")) {
          wordEvidence.add(literal);
        }
      }
    }
  }

  // Позиция 0: import(КОНСТАНТА) по constPaths, затем позиции 1-6 построчно.
  const constImport = /import\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let constUse: RegExpExecArray | null;
  while ((constUse = constImport.exec(text)) !== null) {
    const target = constPaths.get(constUse[1]);
    if (target !== undefined) claimBare(target);
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    // Позиция 1: спецификаторы импорта, new URL и продолжения `} from`.
    const specPattern =
      /(?:^|[^\w$])(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+(?:[^'";]*?\s+from\s+)?|require\s*\(|import\s*\(|new\s+URL\s*\()\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
    let spec: RegExpExecArray | null;
    while ((spec = specPattern.exec(line)) !== null) {
      // Parity — до открывающей кавычки: образец кода внутри строки
      // ('import "./x"') иначе сошёл бы за настоящий импорт.
      const quotePos = spec.index + spec[0].indexOf(spec[1]);
      if (quoteParity(line.slice(0, quotePos)) % 2 === 1) continue;
      let value = spec[2];
      if (spec[1] === "`") value = value.replace(/\$\{[^{}]*\}/g, "");
      claimSpecifier(value);
    }
    // Продолжение многострочного импорта: строка вида `} from "./x";`.
    const cont = line.match(
      /^\s*}?\s*from\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1\s*;?\s*$/,
    );
    if (
      cont !== null &&
      quoteParity(line.slice(0, line.indexOf(cont[1]))) % 2 === 0
    ) {
      let value = cont[2];
      if (cont[1] === "`") value = value.replace(/\$\{[^{}]*\}/g, "");
      claimSpecifier(value);
    }

    // Позиция 3: поле file: контрактов, runInRepo-программы.
    const codeLike =
      /(?:^|[^\w$])file\s*:/.test(line) ||
      line.includes("runInRepo(") ||
      (line.includes("--eval") && line.includes("spawn"));
    if (codeLike) {
      for (const { value, index } of quotedOn(line)) {
        if (insideForeignString(line, index)) continue;
        if (value.length === 0 || value.length > 500) continue;
        if (value.includes("import") || value.includes("require(")) {
          const inner = value.match(
            /(?:import\s*\(|require\s*\()\s*["']([^"']+)["']/g,
          );
          for (const hit of inner ?? []) {
            const innerSpec = hit.match(/["']([^"']+)["']/)?.[1] ?? "";
            if (innerSpec.startsWith("./")) claimRooted(innerSpec.slice(2));
            else claimSpecifier(innerSpec);
          }
        }
        claimSpecifier(value);
      }
    }

    // Позиция 4: join() вне вызовов (запись фикстур молчит, load разобран выше).
    let joinAt = -1;
    while ((joinAt = line.indexOf("join", joinAt + 1)) !== -1) {
      if (joinAt > 0 && /[\w$]/.test(line[joinAt - 1])) continue;
      if (insideForeignString(line, joinAt)) continue;
      const caller = callNameBefore(line, joinAt);
      if (caller !== null && WRITE_CALLS.has(caller)) continue;
      if (caller !== null && LOAD_CALLS.has(caller)) continue;
      const args = callArgs(line, joinAt);
      if (args === null) continue;
      handleJoinLiterals(args);
    }

    // Позиция 5: голые пути рядом с файлом: basename x.ts и ./x.ts (константа
    // для позднейшего dynamic import). Только рядом: иначе фикстура чужого
    // каталога засчитала бы настоящий файл.
    for (const { value, index } of quotedOn(line)) {
      if (insideForeignString(line, index)) continue;
      if (/^[A-Za-z0-9_.-]+\.ts$/.test(value)) {
        claimBare(value);
        continue;
      }
      if (/^\.\.?\/[^\s]+\.m?[jt]s$/.test(value)) claimBare(value);
    }

    // Позиция 6: улики слов для правила dir+basename. Слова — только элементы
    // массивов (константы имён вроде WEB_TOOL_NAMES): слово из join() фикстуры
    // совпадёт с чем угодно.
    for (const { value, index } of quotedOn(line)) {
      if (insideForeignString(line, index)) continue;
      const caller = callNameBefore(line, index);
      if (caller !== null && WRITE_CALLS.has(caller)) continue;
      if (/^[A-Za-z0-9_.-]+\.ts$/.test(value)) baseEvidence.add(value);
      else if (
        /^[A-Za-z0-9_@-]+$/.test(value) &&
        /\[[^[\](){};]*$/.test(line.slice(0, index))
      )
        wordEvidence.add(value);
    }
  }

  // Правило dir+basename: тест, пинующий набор файлов каталога, грузит каждый файл.
  for (const dir of dirEvidence) {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, ...dir.split("/")));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      if (baseEvidence.has(entry)) found.add(`${dir}/${entry}`);
      const stem = entry.slice(0, -3);
      if (wordEvidence.has(stem)) found.add(`${dir}/${entry}`);
    }
  }
  return found;
}

test("every production path has a test or a blind-spot reason", () => {
  const production = productionTypeScriptFiles();
  assert.ok(production.length > 100, "инвентарь обойдён пустотой");
  const imports = importsMap();
  assert.ok(imports.length > 0, "карта импортов не прочитана");

  const referenced = new Map<string, string[]>();
  for (const testFile of testFiles()) {
    if (testFile === "scripts/coverage-policy.test.ts") continue;
    for (const path of referencesOf(testFile, imports)) {
      const list = referenced.get(path) ?? [];
      list.push(testFile);
      referenced.set(path, list);
    }
  }

  const blind = new Map(BLIND_SPOT.map((entry) => [entry.path, entry.why]));
  assert.equal(
    blind.size,
    BLIND_SPOT.length,
    "BLIND_SPOT содержит дублирующиеся пути",
  );
  const blindWithTests = [...blind.keys()].filter((path) =>
    referenced.has(path),
  );
  assert.deepEqual(
    blindWithTests,
    [],
    "BLIND_SPOT держит пути с тестами — убери: " +
      blindWithTests
        .map((path) => `${path} (${referenced.get(path)?.join(", ")})`)
        .join("; "),
  );
  for (const path of blind.keys()) {
    assert.ok(
      production.includes(path),
      `BLIND_SPOT ссылается мимо инвентаря: ${path}`,
    );
  }

  const orphaned = production.filter(
    (path) => !referenced.has(path) && !blind.has(path),
  );
  assert.deepEqual(
    orphaned,
    [],
    `production-пути без теста и без причины: ${orphaned.join(", ")}`,
  );
});

test("coverage command is the exact cross-platform production policy", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  assert.ok(isRecord(parsed));
  assert.ok(isRecord(parsed.scripts));
  const command = parsed.scripts["test:coverage"];
  if (typeof command !== "string") {
    throw new TypeError("test:coverage must be a package script");
  }
  assert.equal(command, EXPECTED_COVERAGE_COMMAND);
});
