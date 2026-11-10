import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, renameSync } from "node:fs";
import { rmSync, statSync, writeSync } from "node:fs";
import { relative } from "node:path";
import { vaultMarkdownFiles } from "../../packages/vault-walk/index.ts";

// Чистка старых раздутых vault: давний баг удваивал сложенный `description` при каждой
// перезаписи, и файлы вырастали до сотен мегабайт. Файл целиком в память не читается:
// frontmatter идёт построчно с пределом длины строки, повтор в description схлопывается,
// тело копируется байт в байт со смещения конца frontmatter.

const CHUNK = 1 << 20;
const LINE_CAP = 1 << 16;
const BLOCK_SMALL = 4096;
const FM_MAX_LINES = 10_000;
const DESCRIPTION_CAP = 500;

/** Порт collapse_repeated_description и cap_description v0.4.8. Длины — в символах (code
 * points), как len() в Python: половины только у строки длиннее 40, период только у
 * единицы длиннее 20, иначе законный короткий повтор («Duran Duran») остаётся. */
export function collapseRepeatedDescription(value: string): string {
  let text = value.trim();
  for (let chars = [...text]; chars.length > 40; chars = [...text]) {
    const half = chars.length >> 1;
    const first = chars.slice(0, half).join("").trim();
    if (!first || first !== chars.slice(half).join("").trim()) break;
    text = first;
  }
  const unit = `${text} `;
  const size = [...unit].length;
  const period = [...unit.slice(0, (unit + unit).indexOf(unit, 1))].length;
  return period > 20 && period < size && size % period === 0
    ? [...unit].slice(0, period).join("").trim()
    : text;
}

export function capDescription(value: string): string {
  const chars = [...value];
  if (chars.length <= DESCRIPTION_CAP) return value;
  const prefix = chars.slice(0, DESCRIPTION_CAP).join("");
  const space = prefix.lastIndexOf(" ");
  return `${space >= 0 ? prefix.slice(0, space) : prefix}…`;
}

/** Огромная строка: единица повтора ищется по первым 200 знакам. */
function collapseSample(sample: string): string {
  const text = sample.trim();
  const index = text.indexOf(text.slice(0, 200), 1);
  const unit = index > 20 ? text.slice(0, index).trimEnd() : "";
  const tiled = unit
    ? `${unit} `.repeat(Math.ceil(text.length / (unit.length + 1)) + 1)
    : "";
  return capDescription(
    unit && text === tiled.slice(0, text.length) ? unit : text,
  );
}

type Line = { text: string | null; truncated: boolean; next: number };

/** Строка файла с позиции pos: не длиннее LINE_CAP байт, остаток до \n пропускается.
 * text null — байты не UTF-8. null — конец файла. */
function readLine(fd: number, pos: number, chunk: Buffer): Line | null {
  const head: Buffer[] = [];
  let size = 0;
  for (let at = pos; ;) {
    const read = readSync(fd, chunk, 0, CHUNK, at);
    if (read === 0) return at === pos ? null : line(head, size > LINE_CAP, at);
    const newline = chunk.subarray(0, read).indexOf(10);
    const end = newline < 0 ? read : newline;
    if (size < LINE_CAP)
      head.push(Buffer.from(chunk.subarray(0, Math.min(end, LINE_CAP - size))));
    size += end;
    at += read;
    if (newline >= 0)
      return line(head, size > LINE_CAP, at - read + newline + 1);
  }
}

/** Голова строки как UTF-8; обрезанная по середине символа — на 1–3 байта короче. */
function line(head: Buffer[], truncated: boolean, next: number): Line {
  const bytes = Buffer.concat(head);
  const cuts = truncated ? [0, 1, 2, 3] : [0];
  const cut = cuts.find((n) => isUtf8(bytes.subarray(0, bytes.length - n)));
  const text =
    cut === undefined
      ? null
      : bytes.subarray(0, bytes.length - cut).toString("utf8");
  return { text, truncated, next };
}

const formatDescription = (value: string) =>
  `description: ${JSON.stringify(value)}`;

type Block = { lines: string[]; sample: string | null };
type Header = { output: string[]; changed: boolean; block: Block | null };

function flushBlock(header: Header): void {
  const block = header.block!;
  header.block = null;
  if (block.sample !== null) {
    header.output.push(formatDescription(collapseSample(block.sample)));
    header.changed = true;
    return;
  }
  const raw = block.lines.join(" ").trim();
  const value = capDescription(collapseRepeatedDescription(raw));
  if (value !== raw) {
    header.output.push(formatDescription(value));
    header.changed = true;
  } else
    header.output.push(
      raw ? "description: >-" : "description:",
      ...block.lines.map((row) => `  ${row}`),
    );
}

/** Продолжение блочного description: короткие строки копятся, огромная — образец. */
function blockLine(block: Block, row: Line): void {
  const text = row.text!;
  if (row.truncated || text.length > BLOCK_SMALL) block.sample ??= text.trim();
  else if (block.sample === null) block.lines.push(text.trim());
}

/** Однострочный description: раздутый — схлопнут; >- и | — начало блока. */
function fieldLine(header: Header, text: string): void {
  const value = /^description:(.*)$/u.exec(text.trim())?.[1].trim();
  const bare = value?.replace(/^(['"])(.*)\1$/u, "$2") ?? "";
  const collapsed = capDescription(collapseRepeatedDescription(bare));
  if (value !== undefined && [">-", ">", "|-", "|", ""].includes(value))
    header.block = { lines: [], sample: null };
  else if (value !== undefined && collapsed !== bare) {
    header.output.push(formatDescription(collapsed));
    header.changed = true;
  } else header.output.push(text);
}

/** Строка frontmatter: "end" — закрыли, "bad" — не frontmatter, иначе дальше. */
function acceptLine(header: Header, row: Line): "end" | "bad" | "next" {
  const text = row.text!;
  if (header.block && (row.truncated || /^[ \t]/u.test(text))) {
    blockLine(header.block, row);
    return "next";
  }
  if (header.block) flushBlock(header);
  if (text.trim() === "---") return "end";
  if (row.truncated) return "bad";
  fieldLine(header, text);
  return "next";
}

/** Конец frontmatter (смещение тела) и новые строки, если есть что чистить. */
function scanHeader(fd: number): { output: string[]; body: number } | null {
  const chunk = Buffer.allocUnsafe(CHUNK);
  const first = readLine(fd, 0, chunk);
  if (!first || first.truncated || first.text !== "---") return null;
  const header: Header = { output: [], changed: false, block: null };
  for (let pos = first.next, count = 0; count < FM_MAX_LINES; count++) {
    const row = readLine(fd, pos, chunk);
    if (!row || row.text === null) return null;
    pos = row.next;
    const verdict = acceptLine(header, row);
    if (verdict === "bad") return null;
    if (verdict === "end")
      return header.changed ? { output: header.output, body: pos } : null;
  }
  return null;
}

function copyRest(source: number, target: number, from: number): void {
  const chunk = Buffer.allocUnsafe(CHUNK);
  for (
    let at = from, read;
    (read = readSync(source, chunk, 0, CHUNK, at)) > 0;
    at += read
  )
    writeSync(target, chunk.subarray(0, read));
}

function cleanVaultFile(
  file: string,
  apply: boolean,
): { oldSize: number; newSize: number } | null {
  const oldSize = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const scanned = scanHeader(fd);
    if (!scanned) return null;
    const header = Buffer.from(`---\n${scanned.output.join("\n")}\n---\n`);
    const newSize = header.length + oldSize - scanned.body;
    if (!apply) return { oldSize, newSize };
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const target = openSync(temp, "wx", 0o600);
    try {
      writeSync(target, header);
      copyRest(fd, target, scanned.body);
    } finally {
      closeSync(target);
    }
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    return { oldSize, newSize };
  } finally {
    closeSync(fd);
  }
}

type CleanupSummary = { cleaned: number; saved: number; failures: string[] };

export function cleanupVault(
  root: string,
  apply: boolean,
  verbose = false,
): CleanupSummary {
  let [cleaned, saved] = [0, 0];
  const failures: string[] = [];
  // Нечитаемый каталог останавливает чистку: молча пропустить часть vault нельзя.
  const files = vaultMarkdownFiles(root, (_dir, error) => {
    throw error;
  });
  for (const file of files)
    try {
      const result = cleanVaultFile(file, apply);
      if (!result) continue;
      cleaned++;
      saved += result.oldSize - result.newSize;
      if (verbose || result.oldSize > 1_000_000)
        console.log(
          `  ${apply ? "cleaned" : "would clean"} ${relative(root, file)}: ${result.oldSize.toLocaleString("en-US")} → ${result.newSize.toLocaleString("en-US")} bytes`,
        );
    } catch (error) {
      failures.push(`${relative(root, file)}: ${String(error)}`);
    }
  return { cleaned, saved, failures };
}
