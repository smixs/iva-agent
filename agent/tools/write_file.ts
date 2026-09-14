import { defineTool } from "eve/tools";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../lib/fs-atomic.js";
import { parseFrontmatterOrSkip } from "../lib/frontmatter.js";
import { resolveVaultDir } from "@iva/vault-dir";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import {
  brokenLinksError,
  unresolvedLinkTargets,
  wikilinkTargets,
} from "../lib/vault-links.ts";

// Host-native запись файла. Переопределяет встроенный write_file eve: пишет реальный
// файл на VPS через каноническую атомарную запись, создавая родительские директории.
//
// Единственное ограничение: перезапись СУЩЕСТВУЮЩЕЙ карточки в <vault>/cards/** запрещена —
// это полная замена файла, из-за которой терялись поля (tier/relevance/phone…) и старый текст.
// Такие правки идут через write_card (он сливает). Всё остальное (vault/CORE.md, daily,
// новые файлы в cards/) write_file пишет как раньше — см. instructions/10-map.md.

type PathProbe =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

// Сравниваем РЕАЛЬНЫЕ пути (realpath), а не лексические: симлинк vault/alias → cards
// не должен обходить гард. Три исхода, а не два: «нет» и «не смог посмотреть» ведут к
// противоположным решениям, и склеивать их нельзя.
function probe(path: string): PathProbe {
  try {
    return { kind: "path", path: realpathSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", reason: (error as Error).message };
  }
}

type CardVerdict =
  { readonly card: boolean } | { readonly undecidable: string };

// Решить «карточка или нет» можно, только зная, где вольт. Раньше нерезолвимый вольт
// читался как «не карточка», то есть гвард открывался наружу и молчал: путь к вольту по
// умолчанию относительный (`vault`), так что любой процесс с другим рабочим каталогом
// затирал карточку целиком и возвращал модели ok:true.
function cardVerdict(path: string): CardVerdict {
  const abs = resolve(path);
  // Файла нет — перезаписывать нечего, и где вольт, знать не требуется.
  if (!existsSync(abs)) return { card: false };

  const vault = resolveVaultDir(process.cwd());
  const cardsPath = join(vault, "cards");
  const root = probe(vault);
  if (root.kind === "absent")
    return {
      undecidable: `каталога вольта ${vault} нет (ASSISTANT_VAULT_DIR задан относительно рабочего каталога?)`,
    };
  if (root.kind === "unreadable") return { undecidable: root.reason };

  const cards = probe(join(root.path, "cards"));
  // Вольт на месте, а cards/ в нём ещё нет — защищать нечего.
  if (cards.kind === "absent") return { card: false };
  if (cards.kind === "unreadable") return { undecidable: cards.reason };

  const real = probe(abs);
  // Исчез между проверкой и резолвом — перезаписывать снова нечего.
  if (real.kind === "absent") return { card: false };
  if (real.kind === "unreadable")
    return { undecidable: `${cardsPath}: ${real.reason}` };

  return {
    card: real.path === cards.path || real.path.startsWith(cards.path + sep),
  };
}

// Ссылки [[…]] внутри вольта: цель, которой нет, режет health score графа, и ночной
// graph.fix её не чинит. Проверяется только markdown внутри вольта — файл снаружи и
// не-markdown к графу отношения не имеют. Корень берём реальный (симлинк не должен
// увести путь мимо проверки), а если вольта нет — проверять нечего и не по чему.
function vaultRelPath(path: string): string | null {
  if (!path.toLowerCase().endsWith(".md")) return null;
  const vault = resolveVaultDir(process.cwd());
  const root = probe(vault);
  if (root.kind !== "path") return null;
  const abs = resolve(path);
  const rel = relative(root.path, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/").replace(/\.md$/i, "");
}

export default defineTool({
  description:
    "Записать файл (UTF-8) на хост; директории создаются, файл перезаписывается целиком. " +
    "Возвращает { ok, path, bytes }. " +
    "Карточку vault/cards/** нельзя — используй write_card.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Абсолютный путь"),
    content: z.string().describe("Содержимое (UTF-8)"),
  }),
  async execute({ path, content }) {
    let verdict: CardVerdict;
    let source: string | null;
    try {
      verdict = cardVerdict(path);
      source = vaultRelPath(path);
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, path, error: text };
      throw error;
    }
    if ("undecidable" in verdict) {
      const error = `не могу проверить ${join(resolveVaultDir(process.cwd()), "cards")}: ${verdict.undecidable}`;
      console.error(`[write_file] ${error}`);
      return { ok: false, path, error };
    }
    if (verdict.card) {
      return {
        ok: false,
        path,
        error:
          "Карточка уже существует — write_file затёр бы её целиком (поля вне схемы и старый текст). " +
          "Используй write_card: он сливает новое содержимое со старым.",
      };
    }
    if (source !== null) {
      // Ночной обход графа читает ТЕЛО карточки; ссылка во frontmatter ему не ссылка,
      // и отказывать по ней нельзя. Битый frontmatter — читаем файл целиком, как graph.py.
      const body =
        parseFrontmatterOrSkip(content, path, () => {})?.body || content;
      const broken = unresolvedLinkTargets(wikilinkTargets(body), {
        vaultDir: resolveVaultDir(process.cwd()),
        source,
      });
      if (broken.length)
        return { ok: false, path, error: brokenLinksError(broken) };
    }
    await writeFileAtomic(path, content);
    return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
  },
});
