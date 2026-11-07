import {
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { imageMetadata } from "astro/assets/utils";
import type { AstroIntegration } from "astro";
import { docUrl } from "./doc-links.ts";
export function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
export function lastModified(source: string): Date {
  try {
    const date = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", source],
      { encoding: "utf8" },
    ).trim();
    if (date) return new Date(date);
  } catch {}
  return statSync(source).mtime;
}
export function copyLegacy(): AstroIntegration {
  return {
    name: "iva-legacy-addresses",
    hooks: {
      // The build copies ../docs into the site; the dev server serves the same files
      // so the logo, favicons and brand images load while working locally.
      "astro:server:setup": ({ server }) => {
        const root = path.resolve("../docs");
        const types: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain; charset=utf-8" };
        server.middlewares.use((req, res, next) => {
          const pathname = decodeURIComponent((req.url || "").split("?")[0]);
          const type = types[path.extname(pathname)];
          const file = path.resolve(root, "." + pathname);
          if (!type || !file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) return next();
          res.setHeader("Content-Type", type);
          res.end(readFileSync(file));
        });
      },
      "astro:build:done": async ({ dir }: { dir: URL }) => {
        const out = dir.pathname;
        cpSync(
          path.join(out, "sitemap-index.xml"),
          path.join(out, "sitemap.xml"),
        );
        cpSync(
          path.join(out, "ru/404/index.html"),
          path.join(out, "ru/404.html"),
        );
        const replaced = new Set([
          "index.html",
          "ru/index.html",
          "about/index.html",
          "ru/about/index.html",
          "privacy/index.html",
          "404.html",
          "sitemap.xml",
          "robots.txt",
          "llms.txt",
          "site.webmanifest",
        ]);
        for (const file of files("../docs")) {
          const relative = path.relative("../docs", file);
          if (replaced.has(relative)) continue;
          cpSync(file, path.join(out, relative), { recursive: true });
        }
        if (existsSync("../assets"))
          cpSync("../assets", path.join(out, "assets"), { recursive: true });
        cpSync("../install.sh", path.join(out, "install.sh"));
        for (const page of files(out).filter((f) => f.endsWith(".html"))) {
          let html = readFileSync(page, "utf8");
          const images = [...html.matchAll(/<img\b[^>]*>/g)];
          for (const match of images) {
            const tag = match[0];
            const src = tag.match(/src="([^"]+)"/)?.[1];
            if (!src?.startsWith("/")) continue;
            const asset = path.join(out, src);
            if (!existsSync(asset)) continue;
            let next = tag;
            if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) {
              const metadata = await imageMetadata(readFileSync(asset), src);
              next = next.replace(
                /\s*\/?>$/,
                ` width="${metadata.width}" height="${metadata.height}">`,
              );
            }
            if (!/\bdecoding=/.test(next))
              next = next.replace(/\s*\/?>$/, ' decoding="async">');
            if (
              page.includes("/docs/") &&
              !/\bloading=/.test(next) &&
              !src.includes("/brand/")
            )
              next = next.replace(/\s*\/?>$/, ' loading="lazy">');
            html = html.replace(tag, next);
          }
          writeFileSync(page, html);
        }
        const markdown = files("../docs")
          .filter((f) => f.endsWith(".md"))
          .sort();
        writeFileSync(
          path.join(out, "llms-full.txt"),
          markdown
            .map(
              (f) =>
                `# https://iva-agent.com${docUrl(path.relative("../docs", f))}\n\n${readFileSync(f, "utf8")}`,
            )
            .join("\n\n---\n\n"),
        );
        writeFileSync(
          path.join(out, "llms.txt"),
          `# Iva\n\n> Free personal AI assistant for Telegram. Open source, MIT. By Majento, Tashkent.\n\nPrice: free; about $14-15/mo for model and server on the default stack, $0 on top with an existing ChatGPT or Claude subscription.\nPlatforms: Ubuntu/Debian or Mac.\nSix model providers: ChatGPT subscription, Claude Pro/Max subscription, OpenCode Go, Ollama Cloud, OpenRouter, any OpenAI-compatible endpoint.\nMemory: daily logs, nightly weekly/monthly/yearly summaries and cards, plain markdown in your own git. Voice, reminders, daily brief, Watch, goals and helpers.\n\n## Install\n- [Instructions for an AI agent](https://iva-agent.com/install.txt)\n- [Documentation](https://iva-agent.com/docs/)\n- [Full documentation](https://iva-agent.com/llms-full.txt)\n- [GitHub](https://github.com/smixs/iva-agent)\n\n## Guides\n${markdown.map((f) => `- [${path.relative("../docs", f)}](https://iva-agent.com${docUrl(path.relative("../docs", f))})`).join("\n")}\n`,
        );
      },
    },
  };
}
