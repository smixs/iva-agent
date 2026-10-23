import { existsSync } from "node:fs";
import path from "node:path";
export const docsRoot = path.resolve("../docs");
export function docUrl(relative: string): string {
  const parts = relative.replace(/\.md$/i, "").split("/");
  const ru = parts[0] === "ru";
  if (ru) parts.shift();
  if (parts.at(-1)?.toLowerCase() === "readme") parts.pop();
  return `${ru ? "/ru" : ""}/docs/${parts.length ? parts.join("/") + "/" : ""}`;
}
export function rewriteUrl(url: string, source: string): string {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(url)) return url;
  const [file, fragment] = url.split("#");
  const resolved = path.resolve(path.dirname(source), decodeURI(file));
  const repoRoot = path.resolve("..");
  if (resolved.startsWith(docsRoot + "/") || resolved === docsRoot) {
    const relative = path.relative(docsRoot, resolved);
    if (/\.md$/i.test(file) && existsSync(resolved))
      return docUrl(relative) + (fragment ? "#" + fragment : "");
    if (existsSync(resolved) && !path.extname(resolved))
      return docUrl(relative + "/README.md");
    return "/" + relative + (fragment ? "#" + fragment : "");
  }
  if (
    resolved.startsWith(path.join(repoRoot, "assets") + path.sep) &&
    existsSync(resolved)
  )
    return "/" + path.relative(repoRoot, resolved);
  return (
    "https://github.com/smixs/iva-agent/blob/main/" +
    path.relative(repoRoot, resolved) +
    (fragment ? "#" + fragment : "")
  );
}
export function docLinks() {
  return (tree: any, file: any) => {
    const source = String(file.path || file.history?.[0] || "");
    function walk(node: any) {
      if (
        (node.type === "link" ||
          node.type === "image" ||
          node.type === "definition") &&
        node.url
      )
        node.url = rewriteUrl(node.url, source);
      node.children?.forEach(walk);
    }
    walk(tree);
  };
}
