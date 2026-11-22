// Builds src/data/plugins.json and the authors' pictures from Iva's default Marketplace.
//
//   node scripts/sync-plugins.ts [path to a checkout of smixs/iva-plugins]
//
// Without a path the list is fetched from GitHub. The list (`.agents/plugins/marketplace.json`)
// says what installs by name, `cards.json` beside it carries what a person reads; the version
// and the parts of each plugin are read from its folder at the listed commit. A plugin kept in
// another repository is fetched at that commit and only read: nothing from it is run.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LIST = "https://github.com/smixs/iva-plugins";
const site = path.resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "iva-plugins-sync-"));

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** One commit of a repository in a folder of its own, files only. */
function fetchAt(url: string, commit: string | null): string {
  const dir = mkdtempSync(path.join(scratch, "repo-"));
  git(["init", "-q"], dir);
  git(["fetch", "-q", "--depth", "1", url, commit ?? "HEAD"], dir);
  git(["checkout", "-q", "FETCH_HEAD"], dir);
  return dir;
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

type Source =
  | string
  | { source: "url"; url: string; sha: string }
  | { source: "git-subdir"; url: string; path: string; sha: string };

try {
  const list = process.argv[2] ? path.resolve(process.argv[2]) : fetchAt(LIST, null);
  const listCommit = git(["rev-parse", "HEAD"], list);
  const market = json(path.join(list, ".agents/plugins/marketplace.json"));
  const cards = json(path.join(list, "cards.json"));
  const authors = path.join(site, "public/media/authors");
  mkdirSync(authors, { recursive: true });
  const pictures = new Map<string, string>();

  const plugins = [];
  for (const entry of market.plugins as {
    name: string;
    source: Source;
    description: string;
  }[]) {
    const card = cards.plugins[entry.name];
    if (!card) throw new Error(`${entry.name}: no card in cards.json`);
    const source = entry.source;
    const local = typeof source === "string";
    const root = local
      ? path.join(list, source)
      : path.join(
          fetchAt(source.url, source.sha),
          source.source === "git-subdir" ? source.path : "",
        );
    const manifest = json(path.join(root, "plugin.json"));
    if (manifest.name !== entry.name)
      throw new Error(`${entry.name}: the manifest calls it ${manifest.name}`);
    const skills = existsSync(path.join(root, "skills"))
      ? readdirSync(path.join(root, "skills"), { withFileTypes: true })
          .filter(
            (item) =>
              item.isDirectory() &&
              existsSync(path.join(root, "skills", item.name, "SKILL.md")),
          )
          .map((item) => item.name)
          .sort()
      : [];
    const services = path.join(root, "sh.iva/services");
    const login: string = card.author.github;
    if (!pictures.has(login)) {
      const response = await fetch(`https://github.com/${login}.png?size=96`);
      if (!response.ok) throw new Error(`${login}: no picture (${response.status})`);
      const type = response.headers.get("content-type") ?? "";
      const extension = type.includes("jpeg") ? "jpg" : "png";
      const file = `${login.toLowerCase()}.${extension}`;
      writeFileSync(path.join(authors, file), Buffer.from(await response.arrayBuffer()));
      pictures.set(login, `/media/authors/${file}`);
    }
    plugins.push({
      name: entry.name,
      title: card.title,
      description: entry.description,
      category: card.category,
      author: { ...card.author, picture: pictures.get(login) },
      repository: card.repository,
      added: card.added,
      version: manifest.version,
      // The commit people install: the one the entry pins, or the list's own for its folders.
      commit: local ? listCommit : source.sha,
      summary: card.summary,
      runs: card.runs,
      keys: card.keys,
      network: card.network,
      parts: {
        skills,
        code: existsSync(path.join(root, "sh.iva/package.json")),
        services: existsSync(services)
          ? readdirSync(services, { withFileTypes: true })
              .filter((item) => item.isDirectory())
              .map((item) => item.name)
              .sort()
          : [],
        mcp: existsSync(path.join(root, "mcp.json"))
          ? Object.keys(json(path.join(root, "mcp.json")).mcpServers ?? {}).sort()
          : [],
      },
    });
  }
  writeFileSync(
    path.join(site, "src/data/plugins.json"),
    JSON.stringify(
      { list: LIST, commit: listCommit, categories: cards.categories, plugins },
      null,
      2,
    ) + "\n",
  );
  console.log(`ok: ${plugins.length} plugins at ${listCommit.slice(0, 12)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
