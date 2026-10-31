import { defineTool } from "eve/tools";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { resolveVaultDir } from "@iva/vault-dir";
import {
  ALIASES_MAX,
  aliasList,
  cardStatuses,
  disappearedLines,
  extractH1,
  listCardFiles,
  logFactKey,
  mergeAliases,
  mergeRelated,
  normalizeName,
  replaceH2Sections,
  sanitizeField,
  sectionRows,
  slugify,
  truthOf,
  TYPE_DIR,
  unionList,
  withCardLock,
  compiledTruthError,
  compiledTruthInput,
  parseCardSections,
  withTruth,
} from "../lib/card-store.ts";
import {
  parseFrontmatterOrSkip,
  renderCardDocument,
  type FmFields,
  type ParsedFrontmatter,
} from "../lib/frontmatter.ts";
import { brokenLinksIn } from "../lib/vault-links.ts";
import { writeFileAtomicSync } from "../lib/fs-atomic.ts";
import { commitVaultWrite } from "../lib/vault-commit.ts";
import { localStamp } from "../lib/vault-daily.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";

const TYPES = Object.keys(TYPE_DIR) as [string, ...string[]];
const oneLine = z
  .string()
  .min(1)
  .refine(
    (value) => !/[\r\n]/u.test(value),
    "значение должно быть одной строкой",
  );

const factInput = z.object({
  operation: z.literal("fact"),
  type: z.enum(TYPES),
  title: oneLine,
  text: oneLine,
  description: oneLine.max(500).optional(),
  tags: z.array(oneLine).max(6).default([]),
  aliases: z.array(oneLine.max(80)).max(ALIASES_MAX).default([]),
  source: oneLine.optional(),
  status: z.string().optional(),
});
const truthInput = z.object({
  operation: z.literal("truth"),
  type: z.enum(TYPES),
  title: oneLine,
  text: z.string(),
  description: oneLine.max(500).optional(),
  reason: oneLine,
  source: oneLine.optional(),
  status: z.string().optional(),
});
const mergeInput = z.object({
  operation: z.literal("merge"),
  target: oneLine,
  duplicate: oneLine,
  confirmed_by_owner: z.literal(true),
});

// На провод уходит плоский object; строгую форму операции проверяет execute и отвечает
// модели текстом, потому что объединения схем в корне провайдеры не принимают.
const wireInput = z.object({
  operation: z
    .enum(["fact", "truth", "merge"])
    .describe(
      "fact: type, title, text (одна строка), по желанию description, tags, aliases, source, status. " +
        "truth: type, title, text (новый Compiled Truth), reason, по желанию description (выжимка), source и status. " +
        "merge: target, duplicate, confirmed_by_owner=true.",
    ),
  type: z.enum(TYPES).optional().describe("fact, truth: тип Card"),
  title: z.string().optional().describe("fact, truth: имя Card"),
  text: z
    .string()
    .optional()
    .describe("fact: факт одной строкой; truth: новый Compiled Truth"),
  description: z
    .string()
    .optional()
    .describe(
      "fact: выжимка; truth: необязательная выжимка новой правды, иначе первая фраза; до 500 символов",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("fact: новой Card обязательны 2–5 тегов kebab-case; до 6"),
  aliases: z.array(z.string()).optional().describe("fact: другие написания"),
  source: z.string().optional().describe("fact, truth: откуда факт"),
  reason: z.string().optional().describe("truth: почему меняется истина"),
  status: z
    .string()
    .optional()
    .describe(
      "fact, truth: новый статус Card только по слову владельца (проект закрыт → done, решение отменено → reverted); допустимые по типу — в schema.json vault",
    ),
  target: z.string().optional().describe("merge: Card, которая остаётся"),
  duplicate: z.string().optional().describe("merge: дубль, который вливается"),
  confirmed_by_owner: z
    .boolean()
    .optional()
    .describe("merge: true только по явной просьбе владельца"),
});

const operationSchemas = z.discriminatedUnion("operation", [
  factInput,
  truthInput,
  mergeInput,
]);

const callExamples = {
  fact: {
    operation: "fact",
    type: "note",
    title: "Имя Card",
    text: "Факт одной строкой",
    tags: ["тема-card", "контекст"],
  },
  truth: {
    operation: "truth",
    type: "note",
    title: "Имя существующей Card",
    text: "Новый Compiled Truth целиком",
    reason: "Почему меняется правда",
  },
  merge: {
    operation: "merge",
    target: "Имя Card, которая остаётся",
    duplicate: "Имя Card-дубля",
    confirmed_by_owner: true,
  },
} satisfies Record<
  z.infer<typeof wireInput>["operation"],
  z.input<typeof operationSchemas>
>;

function callExample(
  operation: z.infer<typeof wireInput>["operation"],
): string {
  return `Пример формы ${operation} (подставь свои данные): ${JSON.stringify(callExamples[operation])}`;
}

const inputGuidance =
  "Не передавай незаданные optional-поля; tags и aliases — массивы строк. " +
  "confirmed_by_owner=true допустим только после явной просьбы владельца о merge; пример не является подтверждением.";

// Keep Zod's validation and wire JSON Schema; enrich the Standard Schema refusal
// itself, before Eve/AI can reject the call without reaching execute.
const actionableInput = {
  "~standard": {
    ...wireInput["~standard"],
    vendor: "iva",
    async validate(value: unknown) {
      const result = await wireInput["~standard"].validate(value);
      if (!result.issues) return result;
      const operation =
        typeof value === "object" && value !== null && "operation" in value
          ? value.operation
          : undefined;
      const examples =
        operation === "fact" || operation === "truth" || operation === "merge"
          ? [callExample(operation)]
          : [callExample("fact"), callExample("truth"), callExample("merge")];
      const guidance = [
        "Исправь указанное поле по схеме; не повторяй тот же неверный вызов и не ищи параметры в исходниках.",
        ...examples,
        inputGuidance,
      ].join("\n");
      return {
        issues: result.issues.map((issue, index) =>
          index === 0
            ? { ...issue, message: `${issue.message}\n${guidance}` }
            : issue,
        ),
      };
    },
  },
};

function operationInput(
  raw: z.infer<typeof wireInput>,
): z.infer<typeof operationSchemas> | { error: string } {
  const parsed = operationSchemas.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
  return {
    error: `write_card ${raw.operation}: ${issues}\n${callExample(raw.operation)}\n${inputGuidance}`,
  };
}

interface CardRecord {
  readonly file: string;
  readonly path: string;
  readonly title: string;
  readonly aliases: string[];
  readonly parsed: ParsedFrontmatter;
}

function cardPath(vault: string, file: string): string {
  return relative(vault, file).split(sep).join("/").replace(/\.md$/u, "");
}

function readCards(vault: string): CardRecord[] {
  return listCardFiles(vault).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    const parsed = parseFrontmatterOrSkip(content, file);
    if (!parsed) return [];
    const title = extractH1(parsed.body) ?? basename(file, ".md");
    const aliases = aliasList(parsed.fields?.aliases);
    return [{ file, path: cardPath(vault, file), title, aliases, parsed }];
  });
}

function candidates(cards: readonly CardRecord[], value: string): CardRecord[] {
  const direct = value.replace(/^vault\//u, "").replace(/\.md$/u, "");
  const byPath = cards.filter((card) => card.path === direct);
  if (byPath.length) return byPath;
  const key = normalizeName(value);
  return cards.filter((card) =>
    [
      card.title,
      card.title.replace(/\s*\([^()]*\)\s*$/u, ""),
      basename(card.file, ".md"),
      ...card.aliases,
    ]
      .map(normalizeName)
      .includes(key),
  );
}

/** Незакрытый блок кода делает границы разделов неоднозначными. */
function fenced(...cards: CardRecord[]) {
  const card = cards.find(
    (item) => parseCardSections(item.parsed.body.split("\n")).open,
  );
  return card
    ? { ok: false, error: `Card ${card.path}: незакрытый блок кода` }
    : null;
}

// Правка записана — ход не падает; отказ коммита шов сам пишет в журнал (vault-commit).
async function save(vault: string, files: string[], message: string) {
  await commitVaultWrite(message, files, vault);
}

type FactInput = z.infer<typeof factInput>;
type TruthInput = z.infer<typeof truthInput>;

/** status вне допустимых для типу Card — отказ текстом с подсказкой; null — годится. */
function statusError(
  vault: string,
  card: CardRecord,
  input: FactInput | TruthInput,
) {
  if (input.status === undefined) return null;
  const type = String(card.parsed.fields?.type ?? input.type);
  const allowed = cardStatuses(vault)[type] ?? ["active"];
  if (allowed.includes(input.status)) return null;
  return {
    ok: false,
    error: `status ${JSON.stringify(input.status.slice(0, 80))} не годится для Card типа ${type}. Допустимы: ${allowed.join(", ")}; или не передавай status.`,
  };
}

/** Статус по слову владельца и его дата: ночь того же дня его не меняет. */
function withStatus(
  fields: FmFields,
  status: string | undefined,
  date: string,
) {
  return status ? { ...fields, status, status_date: date } : fields;
}

function newCard(vault: string, input: FactInput, date: string): CardRecord {
  const title = sanitizeField(input.title, 160);
  const file = join(
    vault,
    "cards",
    TYPE_DIR[input.type],
    `${slugify(title)}.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  const fields: FmFields = {
    type: input.type,
    description: sanitizeField(input.description ?? input.text),
    tags: input.tags.map((tag) => sanitizeField(tag, 80)),
    aliases: input.aliases.map((alias) => sanitizeField(alias, 80)),
    status: input.status ?? "active",
    ...(input.status ? { status_date: date } : {}),
    created: date,
    source: input.source ?? `daily/${date}.md`,
  };
  const body = `# ${title}\n\n## Log\n\n## Related\n\n## History\n`;
  const parsed = { fields, body, lines: [] };
  return { file, path: cardPath(vault, file), title, aliases: [], parsed };
}

function selectFactCard(
  vault: string,
  input: FactInput,
  date: string,
):
  | { ok: true; card: CardRecord; existing: boolean }
  | { ok: false; error: string } {
  const found = candidates(readCards(vault), input.title);
  if (found.length > 1)
    return {
      ok: false,
      error: `Неоднозначная Card: ${found.map((c) => c.path).join(", ")}`,
    };
  const card = found[0] ?? newCard(vault, input, date);
  if (!found[0] && existsSync(card.file))
    return {
      ok: false,
      error: `Card ${card.path} есть, но не читается; поправь её`,
    };
  // schema.json vault требует tags у каждого типа Card: новая Card без них не пишется.
  if (!found[0] && !input.tags.length)
    return {
      ok: false,
      error: `Новой Card ${card.path} нужны tags: 2–5 тегов kebab-case по смыслу Card.\n${callExample("fact")}\n${inputGuidance}`,
    };
  return { ok: true, card, existing: found.length === 1 };
}

function existingFact(
  card: CardRecord,
  input: FactInput,
  date: string,
  rows: string[],
) {
  const fields: FmFields = withStatus(
    { ...(card.parsed.fields ?? {}), updated: date },
    input.status,
    date,
  );
  const { aliases, dropped } = mergeAliases(
    fields.aliases,
    input.aliases.map((value) => sanitizeField(value, 80)),
  );
  if (aliases.length) fields.aliases = aliases;
  const tags = unionList(
    fields.tags,
    input.tags.map((value) => sanitizeField(value, 80)),
  );
  if (tags?.length) fields.tags = tags;
  let body = replaceH2Sections(card.parsed.body, "Log", rows);
  if (!input.description) return { fields, body, dropped };
  const next = sanitizeField(input.description);
  const before = fields.description;
  if (typeof before === "string" && before !== next) {
    const history = sectionRows(body, "History");
    if (history === null) return { error: "History неоднозначный", dropped };
    body = replaceH2Sections(body, "History", [
      ...history,
      `- ${date}: ${before}`,
    ]);
  }
  fields.description = next;
  return { fields, body, dropped };
}

function factChange(
  card: CardRecord,
  input: FactInput,
  rows: string[],
  state: { date: string; existing: boolean },
) {
  const { date, existing } = state;
  const row = `- ${date}: ${sanitizeField(input.text)} · ${input.source ?? `[[daily/${date}]]`}`;
  const duplicate = rows.some(
    (stored) => logFactKey(stored) === logFactKey(row),
  );
  return existing
    ? existingFact(card, input, date, duplicate ? rows : [...rows, row])
    : {
        fields: card.parsed.fields ?? {},
        body: replaceH2Sections(card.parsed.body, "Log", [...rows, row]),
        dropped: [],
      };
}

function factReply(path: string, dropped: string[]) {
  const reply: { ok: true; action: "fact"; file: string; note?: string } = {
    ok: true,
    action: "fact",
    file: path,
  };
  if (dropped.length)
    reply.note = `Алиасы не поместились (потолок ${ALIASES_MAX}): ${dropped.join(", ")}`;
  return reply;
}

async function writeFact(input: FactInput) {
  const vault = resolveVaultDir(process.cwd());
  const date = localStamp().date;
  const selected = selectFactCard(vault, input, date);
  if (!selected.ok) return selected;
  const { card, existing } = selected;
  const badStatus = statusError(vault, card, input);
  if (badStatus) return badStatus;
  const rows = sectionRows(card.parsed.body, "Log");
  if (fenced(card)) return fenced(card);
  if (rows === null)
    return { ok: false, error: `Card ${card.path}: неоднозначный Log` };
  const linkError = brokenLinksIn(input.text, {
    vaultDir: vault,
    source: card.path,
  });
  if (linkError) return { ok: false, error: linkError };
  const changed = factChange(card, input, rows, { date, existing });
  if ("error" in changed)
    return { ok: false, error: `Card ${card.path}: ${changed.error}` };
  const next = renderCardDocument(card.parsed, changed.fields, changed.body);
  if (!existing || next !== readFileSync(card.file, "utf8")) {
    writeFileAtomicSync(card.file, next);
    await save(vault, [card.file], `card ${basename(card.file, ".md")}: fact`);
  }
  return factReply(card.path, changed.dropped);
}

function truthChange(
  card: CardRecord,
  input: TruthInput,
  history: string[],
  date: string,
) {
  const next = compiledTruthInput(input.text);
  const source = input.source ?? `[[daily/${date}]]`;
  const disappeared = disappearedLines(truthOf(card.parsed.body), next);
  const description = truthDescription(input);
  const beforeDescription = card.parsed.fields?.description;
  if (
    typeof beforeDescription === "string" &&
    beforeDescription !== description &&
    !disappeared.includes(beforeDescription)
  )
    disappeared.push(beforeDescription);
  const moved = disappeared.map(
    (line) => `- ${date}: ${line} (${sanitizeField(input.reason)} · ${source})`,
  );
  const body = replaceH2Sections(withTruth(card.parsed.body, next), "History", [
    ...history,
    ...moved,
  ]);
  const fields: FmFields = withStatus(
    {
      ...(card.parsed.fields ?? {}),
      ...(description ? { description } : {}),
      truth_date: date,
    },
    input.status,
    date,
  );
  delete fields.truth_pending;
  return { body, fields };
}

function truthDescription(input: z.infer<typeof truthInput>): string {
  const first = input.text.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  const phrase = /^.*?[.!?…](?:\s|$)/u.exec(first)?.[0] ?? first;
  return input.description ?? sanitizeField(phrase);
}

async function writeTruth(input: z.infer<typeof truthInput>) {
  const vault = resolveVaultDir(process.cwd());
  const found = candidates(readCards(vault), input.title);
  if (found.length !== 1)
    return {
      ok: false,
      error: found.length
        ? "Card неоднозначна"
        : "Card не найдена; truth не создаёт Card",
    };
  const card = found[0];
  if (fenced(card)) return fenced(card);
  const badStatus = statusError(vault, card, input);
  if (badStatus) return badStatus;
  const history = sectionRows(card.parsed.body, "History");
  if (history === null)
    return { ok: false, error: `Card ${card.path}: неоднозначный History` };
  const truthError = compiledTruthError(input.text);
  if (truthError) return { ok: false, error: truthError };
  const linkError = brokenLinksIn(input.text, {
    vaultDir: vault,
    source: card.path,
  });
  if (linkError) return { ok: false, error: linkError };
  const date = localStamp().date;
  const { body, fields } = truthChange(card, input, history, date);
  writeFileAtomicSync(
    card.file,
    renderCardDocument(card.parsed, fields, body, ["truth_pending"]),
  );
  await save(vault, [card.file], `card ${basename(card.file, ".md")}: truth`);
  return { ok: true, action: "truth", file: card.path };
}

function mergedSections(target: CardRecord, duplicate: CardRecord) {
  let body = target.parsed.body;
  for (const heading of ["Log", "History"]) {
    const left = sectionRows(target.parsed.body, heading);
    const right = sectionRows(duplicate.parsed.body, heading);
    if (left === null || right === null)
      return { error: `${heading} неоднозначный` };
    const key = (row: string) => (heading === "Log" ? logFactKey(row) : row);
    const seen = new Set(left.filter((row) => row.startsWith("- ")).map(key));
    let append = true;
    const fresh = right.filter((row) => {
      if (row.startsWith("- ")) {
        append = !seen.has(key(row));
        seen.add(key(row));
      }
      return append;
    });
    body = replaceH2Sections(body, heading, [...left, ...fresh]);
  }
  const related = sectionRows(duplicate.parsed.body, "Related");
  if (related === null) return { error: "Related неоднозначный" };
  body = replaceH2Sections(body, "Related", [
    ...new Set([...(sectionRows(body, "Related") ?? []), ...related]),
  ]);
  return { body: mergeRelated(body, [duplicate.path]) };
}

function carriedKnowledge(duplicate: CardRecord): string {
  const lines = duplicate.parsed.body.split("\n");
  const parsed = parseCardSections(lines);
  const sections = parsed.sections.filter((section) => section.level === 2);
  const h1 = parsed.sections.find((section) => section.level === 1)?.start;
  const carried = lines.flatMap((line, index) => {
    const section = sections.find((item) => item.start === index);
    const dropped = sections.some(
      (item) =>
        ["log", "history", "related"].includes(item.key) &&
        index >= item.start &&
        index < item.end,
    );
    if (dropped || index === h1) return [];
    return [section ? line.replace(/^ {0,3}##/u, "###") : line];
  });
  const description = duplicate.parsed.fields?.description;
  return [
    typeof description === "string" ? `Описание: ${description}` : "",
    carried.join("\n").trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function selectMergeCards(
  cards: readonly CardRecord[],
  input: z.infer<typeof mergeInput>,
) {
  const targets = candidates(cards, input.target);
  const duplicates = candidates(cards, input.duplicate);
  if (targets.length !== 1 || duplicates.length !== 1)
    return { error: "merge требует две однозначные существующие Card" };
  const [target, duplicate] = [targets[0], duplicates[0]];
  if (target.file === duplicate.file)
    return { error: "Card нельзя склеить с самой собой" };
  const fenceError = fenced(target, duplicate);
  return fenceError ?? { target, duplicate };
}

function mergedFields(target: CardRecord, duplicate: CardRecord): FmFields {
  const { aliases } = mergeAliases(
    target.parsed.fields?.aliases,
    [duplicate.title, ...duplicate.aliases].map((value) =>
      sanitizeField(value, 80),
    ),
  );
  const tags = unionList(
    target.parsed.fields?.tags,
    aliasList(duplicate.parsed.fields?.tags),
  );
  return {
    ...(target.parsed.fields ?? {}),
    aliases,
    ...(tags?.length ? { tags } : {}),
  };
}

async function mergeCards(input: z.infer<typeof mergeInput>) {
  const vault = resolveVaultDir(process.cwd());
  const selected = selectMergeCards(readCards(vault), input);
  if ("error" in selected) return { ok: false, error: selected.error };
  const { target, duplicate } = selected;
  const combined = mergedSections(target, duplicate);
  if ("error" in combined) return { ok: false, error: combined.error };
  let { body } = combined;
  const knowledge = carriedKnowledge(duplicate);
  if (knowledge)
    body = `${body.trimEnd()}\n\n## Из ${duplicate.title}\n\n${knowledge}\n`;
  writeFileAtomicSync(
    target.file,
    renderCardDocument(target.parsed, mergedFields(target, duplicate), body),
  );
  const duplicateFields = {
    ...(duplicate.parsed.fields ?? {}),
    status: "superseded",
    superseded_by: `[[${target.path}]]`,
  };
  writeFileAtomicSync(
    duplicate.file,
    renderCardDocument(
      duplicate.parsed,
      duplicateFields,
      `# ${duplicate.title}\n\nСклеено с [[${target.path}]].\n`,
    ),
  );
  await save(
    vault,
    [target.file, duplicate.file],
    `cards: merge ${basename(duplicate.file, ".md")} into ${basename(target.file, ".md")}`,
  );
  return {
    ok: true,
    action: "merge",
    file: target.path,
    duplicate: duplicate.path,
  };
}

export default defineTool({
  description:
    "Card памяти: fact дописывает факт (и может создать Card после поиска), truth меняет Compiled Truth с архивом, merge склеивает дубль только по явной просьбе владельца. fact и truth меняют status Card, когда владелец сказал о нём (проект закрыт, решение принято).\n" +
    [
      callExample("fact"),
      callExample("truth"),
      callExample("merge"),
      inputGuidance,
    ].join("\n"),
  inputSchema: actionableInput,
  async execute(raw) {
    if (raw.operation === "merge" && raw.status !== undefined)
      return {
        ok: false,
        error:
          "write_card merge: status не меняется склейкой; смени его отдельным fact или truth.",
      };
    const input = operationInput(raw);
    if ("error" in input) return { ok: false, error: input.error };
    try {
      // Одна правка Card за раз (и с ночью): параллельные ходы не сливаются в коммит.
      return await withCardLock(resolveVaultDir(process.cwd()), async () => {
        if (input.operation === "fact") return await writeFact(input);
        if (input.operation === "truth") return await writeTruth(input);
        return await mergeCards(input);
      });
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, error: text };
      throw error;
    }
  },
});
