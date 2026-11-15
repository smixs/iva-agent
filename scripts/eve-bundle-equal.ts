/**
 * Compares the eve modules of two Iva builds up to a renaming of bindings
 * (ADR-0027). Removing eve source makes the eve build rename bindings in
 * modules that stay, so bytes differ where the program is the same.
 *
 * Usage: node scripts/eve-bundle-equal.ts <before>/.output/server <after>/.output/server
 *
 * Equal means: the same set of eve modules (`//#region` markers), and in each
 * module the same tokens in the same order, where binding names may differ as
 * long as bindings pair one to one. Literals, operators, property names and
 * statement order are compared as written; the eve archive version inside a
 * literal is the one accepted difference. Import and export declarations of a
 * chunk are compared as sets. Names nobody declares (globals) must match.
 * A chunk that a module carries as base64 text (the workflow bundle eve builds
 * from its own `dist/src`) is decoded and compared the same way.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import tseslint from "typescript-eslint";

interface Node {
  readonly type: string;
  readonly range: readonly [number, number];
  readonly [key: string]: unknown;
}
interface Variable {
  readonly name: string;
  readonly defs: readonly unknown[];
  readonly identifiers: readonly Node[];
  readonly scope: { readonly type: string };
}
interface Scope {
  readonly variables: readonly Variable[];
  readonly references: readonly {
    readonly identifier: Node;
    readonly resolved: Variable | null;
  }[];
}
interface Parsed {
  readonly ast: Node & {
    readonly body: readonly Node[];
    readonly tokens: readonly (Node & { readonly value: string })[];
  };
  readonly scopeManager: { readonly scopes: readonly Scope[] };
  readonly visitorKeys: Readonly<Record<string, readonly string[]>>;
}
const parse = (
  tseslint.parser as unknown as {
    parseForESLint: (text: string, options: object) => Parsed;
  }
).parseForESLint;

/** `local` pairs by position inside one module, `top` and `free` pair by name across a chunk. */
type TokenKind = "local" | "top" | "free" | "text";
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly name: string;
}
interface ModuleTokens {
  readonly tokens: Token[];
  /** `source\0imported` → local name, `source` alone for a bare import. */
  readonly imports: Map<string, string>;
  /** exported name → what it exports (a binding name, or a re-export source). */
  readonly exports: Map<string, string>;
  /** Base64 text the module carries, joined. */
  readonly embedded: string;
}
export interface Difference {
  readonly module: string;
  readonly detail: string;
}
export interface ChunkResult {
  readonly modules: string[];
  readonly missing: string[];
  readonly added: string[];
  readonly different: Difference[];
  readonly sameOrder: boolean;
  readonly renamedTop: [string, string][];
  readonly renamedLocal: number;
  readonly embedded: {
    readonly module: string;
    readonly result: ChunkResult;
  }[];
}

const OUTSIDE = "(chunk)";
const EVE_VERSION = /\d+\.\d+\.\d+-iva\.\d+/gu;
const BASE64 = /^"[A-Za-z0-9+/=]{200,}"$/u;
/** The directory of one build carries a random name. */
const moduleId = (raw: string): string =>
  raw
    .replace(/^(?:\.\.\/)+/u, "")
    .replace(/^\.eve\/builds\/[^/]+/u, ".eve/builds/*");
/** eve's own workflow bundle names its modules from the package root. */
export const isEveModule = (id: string): boolean =>
  id.startsWith("node_modules/eve/") || id.startsWith("dist/src/");
const decode = (base64: string): string =>
  Buffer.from(base64, "base64").toString("utf8");

/** Splits a chunk into module texts; what stands outside every region is one more module. */
export function splitModules(chunk: string): Map<string, string> {
  const modules = new Map<string, string[]>([[OUTSIDE, []]]);
  let current = OUTSIDE;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("//#region ")) {
      current = moduleId(line.slice("//#region ".length).trim());
      if (modules.has(current)) throw new Error(`Module twice: ${current}`);
      modules.set(current, []);
    } else if (line.startsWith("//#endregion")) current = OUTSIDE;
    else modules.get(current)?.push(line);
  }
  return new Map([...modules].map(([id, lines]) => [id, lines.join("\n")]));
}

function walk(
  node: Node,
  keys: Parsed["visitorKeys"],
  visit: (node: Node) => void,
): void {
  visit(node);
  for (const key of keys[node.type] ?? []) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child])
      if (item && typeof item === "object") walk(item as Node, keys, visit);
  }
}

const nameOf = (node: Node): string =>
  node.type === "Literal" ? String(node.value) : String(node.name);

export function tokenize(text: string): ModuleTokens {
  const { ast, scopeManager, visitorKeys } = parse(text, {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    tokens: true,
    lib: [],
    filePath: "module.mjs",
  });
  const bound = new Map<number, Variable>();
  const free = new Set<number>();
  for (const scope of scopeManager.scopes) {
    for (const variable of scope.variables)
      for (const id of variable.identifiers) bound.set(id.range[0], variable);
    for (const { identifier, resolved } of scope.references)
      if (resolved?.defs.length) bound.set(identifier.range[0], resolved);
      else free.add(identifier.range[0]);
  }
  // A shorthand writes a property name and a binding with one token: the name must match too.
  const shorthand = new Set<number>();
  walk(ast, visitorKeys, (node) => {
    if (node.type === "Property" && node.shorthand === true)
      shorthand.add((node.key as Node).range[0]);
  });

  const imports = new Map<string, string>();
  const exports = new Map<string, string>();
  const skipped: (readonly [number, number])[] = [];
  for (const statement of ast.body) {
    const source = statement.source as Node | null | undefined;
    const specifiers = statement.specifiers as Node[] | undefined;
    if (statement.type === "ImportDeclaration" && source) {
      const from = nameOf(source);
      if (!specifiers?.length) imports.set(from, "");
      for (const specifier of specifiers ?? []) {
        const imported =
          specifier.type === "ImportSpecifier"
            ? nameOf(specifier.imported as Node)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        imports.set(`${from}\0${imported}`, nameOf(specifier.local as Node));
      }
    } else if (
      statement.type === "ExportNamedDeclaration" &&
      !statement.declaration
    ) {
      for (const specifier of specifiers ?? [])
        exports.set(
          nameOf(specifier.exported as Node),
          source
            ? `\0${nameOf(source)}\0${nameOf(specifier.local as Node)}`
            : nameOf(specifier.local as Node),
        );
    } else continue;
    skipped.push(statement.range);
  }

  const locals = new Map<Variable, number>();
  const tokens: Token[] = [];
  let embedded = "";
  for (const token of ast.tokens) {
    const start = token.range[0];
    if (skipped.some(([from, to]) => start >= from && start < to)) continue;
    const carried = token.type === "String" && BASE64.test(token.value);
    if (carried) embedded += token.value.slice(1, -1);
    const literal = carried
      ? "<base64>"
      : token.value.replace(EVE_VERSION, "<eve-version>");
    const text = `${token.type} ${literal}`;
    const variable = bound.get(start);
    if (shorthand.has(start))
      tokens.push({ kind: "text", text: `shorthand ${literal}`, name: "" });
    if (variable && variable.scope.type !== "module") {
      if (!locals.has(variable)) locals.set(variable, locals.size);
      tokens.push({
        kind: "local",
        text: `local ${locals.get(variable)}`,
        name: token.value,
      });
    } else if (variable)
      tokens.push({ kind: "top", text: "top", name: token.value });
    else if (free.has(start))
      tokens.push({ kind: "free", text: "free", name: token.value });
    else tokens.push({ kind: "text", text, name: "" });
  }
  return { tokens, imports, exports, embedded };
}

/** One-to-one pairing of the names a chunk shares between its modules. */
class Pairing {
  readonly forward = new Map<string, string>();
  readonly backward = new Map<string, string>();
  pair(before: string, after: string): boolean {
    const known = this.forward.get(before);
    if (known !== undefined) return known === after;
    if (this.backward.has(after)) return false;
    this.forward.set(before, after);
    this.backward.set(after, before);
    return true;
  }
  adopt(other: Pairing): void {
    for (const [before, after] of other.forward) this.pair(before, after);
  }
}

const show = (tokens: Token[], at: number): string =>
  tokens
    .slice(Math.max(0, at - 6), at + 7)
    .map((token) => token.name || token.text.replace(/^\S+ /u, ""))
    .join(" ");

function compareTokens(
  before: Token[],
  after: Token[],
  names: Pairing,
): { detail?: string; renamedLocal: number } {
  const seen = new Set<string>();
  let renamedLocal = 0;
  const length = Math.min(before.length, after.length);
  for (let at = 0; at < length; at += 1) {
    const a = before[at];
    const b = after[at];
    const same =
      a.text === b.text &&
      (a.kind === "text" || a.kind === "local" || names.pair(a.name, b.name));
    if (!same)
      return {
        detail: `token ${at}: «${show(before, at)}» against «${show(after, at)}»`,
        renamedLocal,
      };
    if (a.kind === "local" && a.name !== b.name && !seen.has(a.text)) {
      seen.add(a.text);
      renamedLocal += 1;
    }
  }
  if (before.length !== after.length)
    return {
      detail: `${before.length} tokens against ${after.length}; the longer one goes on with «${show(before.length > after.length ? before : after, length)}»`,
      renamedLocal,
    };
  return { renamedLocal };
}

function compareSets(
  what: string,
  before: Map<string, string>,
  after: Map<string, string>,
  names: Pairing,
): string | undefined {
  const label = (key: string): string => key.replaceAll("\0", " ");
  for (const [key, name] of before) {
    const other = after.get(key);
    if (other === undefined) return `${what} ${label(key)} is gone`;
    const bothSources = name.startsWith("\0") || other.startsWith("\0");
    if (bothSources ? name !== other : !names.pair(name, other))
      return `${what} ${label(key)}: ${label(name)} against ${label(other)}`;
  }
  for (const key of after.keys())
    if (!before.has(key)) return `${what} ${label(key)} is new`;
  return undefined;
}

export function compareChunks(before: string, after: string): ChunkResult {
  const beforeModules = splitModules(before);
  const afterModules = splitModules(after);
  const modules = [...beforeModules.keys()];
  const names = new Pairing();
  const declared = { before: new Set<string>(), after: new Set<string>() };
  const sets = (): Record<"before" | "after", Map<string, string>> => ({
    before: new Map(),
    after: new Map(),
  });
  const imports = sets();
  const exports = sets();
  const different: Difference[] = [];
  const embedded: ChunkResult["embedded"] = [];
  let renamedLocal = 0;
  const collect = (side: "before" | "after", parsed: ModuleTokens): void => {
    for (const token of parsed.tokens)
      if (token.kind === "top") declared[side].add(token.name);
    for (const [key, name] of parsed.imports) {
      imports[side].set(key, name);
      if (name) declared[side].add(name);
    }
    for (const [key, name] of parsed.exports) exports[side].set(key, name);
  };
  for (const id of modules) {
    const other = afterModules.get(id);
    if (other === undefined) continue;
    const a = tokenize(beforeModules.get(id) as string);
    const b = tokenize(other);
    collect("before", a);
    collect("after", b);
    // A module that differs must not teach the chunk its wrong pairs.
    const attempt = new Pairing();
    attempt.adopt(names);
    const result = compareTokens(a.tokens, b.tokens, attempt);
    if (result.detail) different.push({ module: id, detail: result.detail });
    else {
      names.adopt(attempt);
      renamedLocal += result.renamedLocal;
    }
    if (a.embedded === "" && b.embedded === "") continue;
    const [carriedA, carriedB] = [decode(a.embedded), decode(b.embedded)];
    if (carriedA.includes("//#region ") && carriedB.includes("//#region "))
      embedded.push({ module: id, result: compareChunks(carriedA, carriedB) });
    else if (
      carriedA.replace(EVE_VERSION, "") !== carriedB.replace(EVE_VERSION, "")
    )
      different.push({ module: id, detail: "the base64 text differs" });
  }
  const setDifference =
    compareSets("import", imports.before, imports.after, names) ??
    compareSets("export", exports.before, exports.after, names);
  if (setDifference) different.push({ module: OUTSIDE, detail: setDifference });
  const renamedTop = [...names.forward].filter(([a, b]) => a !== b);
  for (const [a, b] of renamedTop)
    if (!declared.before.has(a) || !declared.after.has(b))
      different.push({
        module: OUTSIDE,
        detail: `a name nobody declares changed: ${a} against ${b}`,
      });
  const kept = modules.filter((id) => afterModules.has(id));
  return {
    modules,
    missing: modules.filter((id) => !afterModules.has(id)),
    added: [...afterModules.keys()].filter((id) => !beforeModules.has(id)),
    different,
    sameOrder:
      kept.join("\n") ===
      [...afterModules.keys()].filter((id) => beforeModules.has(id)).join("\n"),
    renamedTop,
    renamedLocal,
    embedded,
  };
}

function listChunks(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".mjs"))
    .sort();
}

/** Prints the comparison; false when the eve modules of the two builds differ. */
export function compareBuilds(beforeRoot: string, afterRoot: string): boolean {
  const beforeChunks = listChunks(beforeRoot);
  const afterChunks = new Set(listChunks(afterRoot));
  const eve = { before: 0, same: 0 };
  const failures: string[] = [];
  const notes: string[] = [];
  const report = (chunk: string, result: ChunkResult): void => {
    const eveModules = result.modules.filter(isEveModule);
    const sort = (id: string): string[] =>
      isEveModule(id) || (id === OUTSIDE && eveModules.length > 0)
        ? failures
        : notes;
    for (const id of result.missing) sort(id).push(`${chunk}: ${id} is gone`);
    for (const id of result.added) sort(id).push(`${chunk}: ${id} is new`);
    for (const { module, detail } of result.different)
      sort(module).push(`${chunk}: ${module}: ${detail}`);
    eve.before += eveModules.length;
    eve.same += eveModules.filter(
      (id) =>
        !result.missing.includes(id) &&
        !result.different.some(({ module }) => module === id),
    ).length;
    if (eveModules.length > 0) {
      const beyondSuffix = result.renamedTop.filter(
        ([a, b]) => a.replace(/\$\d+$/u, "") !== b.replace(/\$\d+$/u, ""),
      );
      console.log(
        `${chunk}: ${eveModules.length} eve modules, order ${result.sameOrder ? "same" : "DIFFERS"}; ` +
          `renamed bindings: ${result.renamedTop.length} shared (${beyondSuffix.length} beyond a $N suffix), ${result.renamedLocal} local`,
      );
      for (const [a, b] of beyondSuffix.slice(0, 20))
        console.log(`  ${a} → ${b}`);
    }
    for (const { module, result: carried } of result.embedded)
      report(`${chunk} » ${module} (base64)`, carried);
  };
  for (const chunk of beforeChunks) {
    const before = readFileSync(path.join(beforeRoot, chunk), "utf8");
    if (afterChunks.has(chunk))
      report(
        chunk,
        compareChunks(
          before,
          readFileSync(path.join(afterRoot, chunk), "utf8"),
        ),
      );
    else
      ([...splitModules(before).keys()].some(isEveModule)
        ? failures
        : notes
      ).push(`${chunk}: the chunk is gone`);
  }
  for (const chunk of afterChunks)
    if (!beforeChunks.includes(chunk)) notes.push(`${chunk}: the chunk is new`);
  console.log(
    `eve modules: ${eve.before} before, ${eve.same} equal up to binding names`,
  );
  for (const note of notes) console.log(`note (not eve): ${note}`);
  for (const failure of failures) console.log(`DIFFERENT: ${failure}`);
  console.log(failures.length === 0 ? "EQUAL" : "NOT EQUAL");
  return failures.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [beforeRoot, afterRoot] = process.argv.slice(2);
  if (!beforeRoot || !afterRoot) {
    console.error(
      "Usage: node scripts/eve-bundle-equal.ts <before>/.output/server <after>/.output/server",
    );
    process.exit(64);
  }
  process.exit(compareBuilds(beforeRoot, afterRoot) ? 0 : 1);
}
