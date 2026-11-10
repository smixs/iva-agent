import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../../packages/data-dir/index.ts";
import { alertOnce, noticeTranslator } from "../lib/notice-policy.ts";
import { notificationChat } from "../../packages/notification-chat/index.ts";
import { vaultDirOrExit } from "../lib/vault-boundary.ts";

const vault = vaultDirOrExit();
const dataDir = resolveDataDir(process.cwd());

/** Агентское дерево — динамическим импортом: юнит грузится и на установке, где agent/
 * нет или он переписан наполовину (scripts/authored-tree-guard.test.ts). */
async function authoredTree() {
  return {
    ...(await import("#lib/core-cap.ts")),
    ...(await import("#lib/vault-commit.ts")),
    ...(await import("../lib/telegram-send.ts")),
    ...(await import("./graph.ts")),
  };
}
let tree: Awaited<ReturnType<typeof authoredTree>>;
// Язык владельца (settings.language), как в v0.4.8: каждый Alert — парой en/ru.
let T: Awaited<ReturnType<typeof noticeTranslator>>;

// Alert тем же швом, что у ночи и сторожа: Outbox, разметка, трасса.
async function send(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = notificationChat();
  const sent =
    token && chat ? await tree.sendTelegramHtml(token, chat, text) : null;
  if (!sent?.ok)
    console.error(`brain alert: ${text} (${sent?.error ?? "no chat"})`);
  return sent?.ok ?? false;
}

async function commitOwnerChanges(): Promise<boolean> {
  const result = await tree.commitVaultSweep("brain: owner changes", vault);
  if (!result.ok)
    console.error(`brain: backup commit failed: ${result.reason ?? "unknown"}`);
  return result.ok;
}

// Граф - производные данные: .gitignore vault из шаблона исключает .graph/, в git он не идёт.
function refreshGraph(): boolean {
  try {
    tree.writeVaultGraph(vault);
    return true;
  } catch (error) {
    console.error("brain: graph failed:", error);
    return false;
  }
}

async function alertCoreCap(): Promise<void> {
  const core = join(vault, "CORE.md");
  if (!existsSync(core)) return;
  const length = readFileSync(core, "utf8").length;
  if (length <= tree.CORE_CAP) return;
  await alertOnce(dataDir, "core-over-cap", String(length), () =>
    send(
      T(
        `CORE.md is longer than ${tree.CORE_CAP} characters (${length}). Shorten it in the vault; Brain does not trim the file itself.`,
        `CORE.md длиннее ${tree.CORE_CAP} знаков (${length}). Сократи его в vault; Brain не режет файл автоматически.`,
      ),
    ),
  );
}

/** Индекс эмбеддингов hybrid-поиска (vault/.index), как в v0.4.8: только при hybrid; без
 * ключа embed-index сам выходит с кодом 0. Провал не отменяет бэкап, владелец слышит Alert. */
async function refreshEmbeddings(): Promise<boolean> {
  if (process.env.MEMORY_SEARCH_MODE !== "hybrid") return true;
  const script = join(import.meta.dirname, "embed-index.ts");
  const args = ["--env-file-if-exists=.env", script];
  const { status } = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (status === 0) return true;
  console.error(`brain: embed-index failed (exit ${status})`);
  await alertOnce(dataDir, "embed-index", "failed", () =>
    send(
      T(
        "The hybrid search index was not rebuilt: new Cards are found by words only. Check the embeddings key and run: node --env-file=.env scripts/memory/embed-index.ts",
        "Индекс эмбеддингов не пересобран: новые Card находятся только по словам. Проверь ключ эмбеддингов и выполни: node --env-file=.env scripts/memory/embed-index.ts",
      ),
    ),
  );
  return false;
}

const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: vault, encoding: "utf8" });

// Alert дросселируется по сути (как "missing" в v0.4.8), текст локализуется отдельно:
// смена языка не делает ту же проблему новой.
type Missing = { essence: string; text: string };
const noRemote = (): Missing => ({
  essence: "missing",
  text: T(
    "Memory is not backed up: the vault has no git remote. On the server run: gh auth login (repo scope). Brain then creates a private iva-vault repository and turns the backup on.",
    "Память не бэкапится: у vault нет git remote. Зайди на сервер и выполни: gh auth login (scope repo). Brain сам создаст приватный репозиторий iva-vault и включит бэкап.",
  ),
});

/** origin vault: настроенный владельцем не трогается; нет — приватный iva-vault через уже
 * авторизованный gh. Уже существующий iva-vault привязывается, только если gh подтвердил,
 * что он приватный. null — remote есть, иначе суть и текст Alert. */
function ensureRemote(): Missing | null {
  const origin = () => run("git", ["remote", "get-url", "origin"]).status === 0;
  if (origin()) return null;
  if (run("gh", ["auth", "status"]).status !== 0) return noRemote();
  run("gh", ["auth", "setup-git"]);
  const create = ["repo", "create", "iva-vault", "--private", "--source"];
  if (!run("gh", [...create, vault, "--remote", "origin", "--push"]).status)
    return origin() ? null : noRemote();
  const login = run("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
  const repo = `${login}/iva-vault`;
  const view = ["repo", "view", repo, "--json", "visibility", "--jq"];
  if (!login || run("gh", [...view, ".visibility"]).stdout.trim() !== "PRIVATE")
    return {
      essence: `not-private:${repo}`,
      text: T(
        `The vault backup is off: the repository ${repo} is not private or gh could not check it, so Brain did not attach it. Make it private (gh repo edit ${repo} --visibility private) or set your own origin.`,
        `Бэкап vault не включён: репозиторий ${repo} не приватный или gh не смог это проверить, Brain его не привязал. Сделай его приватным (gh repo edit ${repo} --visibility private) или укажи свой origin.`,
      ),
    };
  run("git", ["remote", "add", "origin", `https://github.com/${repo}.git`]);
  return origin() ? null : noRemote();
}

async function pushBackup(): Promise<boolean> {
  const missing = ensureRemote();
  if (missing) {
    console.error("brain: no private remote — backup skipped");
    await alertOnce(dataDir, "vault-remote", missing.essence, () =>
      send(missing.text),
    );
    return false;
  }
  const push = run("git", ["push", "origin", "HEAD"]);
  if (push.status === 0) return true;
  const reason = (push.stderr || push.stdout || "git push failed").trim();
  console.error(`brain: backup push failed: ${reason}`);
  await alertOnce(dataDir, "brain-backup", reason, () =>
    send(
      T(
        "The vault backup did not reach the git remote. Check `git -C vault push origin HEAD` and access to the remote.",
        "Бэкап vault не ушёл в git remote. Проверь `git -C vault push origin HEAD` и доступ к remote.",
      ),
    ),
  );
  return false;
}

async function main(): Promise<number> {
  if (!existsSync(vault)) {
    console.error(`brain: vault not found: ${vault}`);
    return 1;
  }
  T = await noticeTranslator();
  try {
    tree = await authoredTree();
  } catch (error) {
    console.error(`brain: agent tree did not load: ${String(error)}`);
    return 1;
  }
  // Индекс до коммита, как в v0.4.8: он уходит в бэкап той же ночью.
  const indexed = await refreshEmbeddings();
  const ownerCommitted = await commitOwnerChanges();
  const graphRefreshed = refreshGraph();
  await alertCoreCap();
  const pushed = await pushBackup();
  return ownerCommitted && graphRefreshed && indexed && pushed ? 0 : 1;
}

process.exitCode = await main();
