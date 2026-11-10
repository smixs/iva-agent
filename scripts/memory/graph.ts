import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatterOrSkip } from "#lib/frontmatter.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { linkTargetsIn, vaultLinks } from "#lib/vault-links.ts";

// Граф ссылок vault для memory_search: узлы с входящими и исходящими [[ссылками]] и
// список битых. Brain пересобирает его ночью. Куда ведёт ссылка, решает тот же индекс,
// которым write_card и write_file отказывают на записи (#lib/vault-links.ts): принятая
// на записи ссылка ночью битой не становится.

type GraphNode = { incoming: string[]; outgoing: string[] };
export interface VaultGraph {
  readonly version: 1;
  readonly nodes: Record<string, GraphNode>;
  readonly broken: Array<{ source: string; target: string }>;
}

/** Тело карточки без frontmatter; исчезла между обходом и чтением — пустое. */
function bodyOf(root: string, card: string): string {
  const file = join(root, `${card}.md`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  return parseFrontmatterOrSkip(text, file)?.body ?? text;
}

export function buildVaultGraph(root: string, today?: number): VaultGraph {
  const links = vaultLinks(root, { today });
  const nodes: Record<string, GraphNode> = {};
  const broken: VaultGraph["broken"] = [];
  for (const source of links.cards) {
    const outgoing = new Set<string>();
    for (const raw of linkTargetsIn(bodyOf(root, source))) {
      const verdict = links.judge(raw, source);
      if (verdict.card !== null) outgoing.add(verdict.card);
      else if (verdict.broken) broken.push({ source, target: verdict.target });
    }
    nodes[source] = { incoming: [], outgoing: [...outgoing] };
  }
  for (const [source, node] of Object.entries(nodes))
    for (const to of node.outgoing) nodes[to]?.incoming.push(source);
  return { version: 1, nodes, broken };
}

export function writeVaultGraph(root: string): string {
  const file = join(root, ".graph", "vault-graph.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomicSync(
    file,
    `${JSON.stringify(buildVaultGraph(root), null, 2)}\n`,
  );
  return file;
}
