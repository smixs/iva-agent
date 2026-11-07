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
import { markdownDescription, plainMarkdown, textLang } from "./seo.ts";
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
        writeFileSync(path.join(out, "llms.txt"), llmsTxt(markdown));
        writeFileSync(
          path.join(out, "llms-full.txt"),
          `# Iva: full documentation\n\n> Every Markdown page of the Iva docs (https://iva-agent.com/docs/), one after another. Summary and index: https://iva-agent.com/llms.txt\n\n---\n\n` +
            markdown
              .map(
                (f) =>
                  `# https://iva-agent.com${docUrl(path.relative("../docs", f))}\n\n${readFileSync(f, "utf8")}`,
              )
              .join("\n\n---\n\n"),
        );
      },
    },
  };
}

// llms.txt (llmstxt.org): what Iva is, in the words of the home page and the docs, and a map of
// every docs page with its own one-line summary, for AI assistants that answer about Iva.
function llmsTxt(markdown: string[]): string {
  const copy = JSON.parse(readFileSync("src/data/copy.json", "utf8"));
  const usecases = JSON.parse(readFileSync("src/data/usecases.json", "utf8"));
  const section = (n: number) => copy.en.find((s: any) => s.number === n);
  const page = (f: string) => {
    const source = readFileSync(f, "utf8");
    const title = plainMarkdown(source.match(/^# (.+)$/m)?.[1] || path.basename(f, ".md"));
    return {
      relative: path.relative("../docs", f),
      title,
      lang: textLang(source),
      line: `- [${title}](https://iva-agent.com${docUrl(path.relative("../docs", f))}): ${markdownDescription(source, title)}`,
    };
  };
  const pages = markdown.map(page);
  // Architecture decisions and the method: why Iva is built so, mostly written in Russian.
  const decision = (p: (typeof pages)[number]) =>
    p.relative.startsWith("adr/") || (!p.relative.startsWith("ru/") && p.lang === "ru");
  const english = pages.filter((p) => !p.relative.startsWith("ru/") && !decision(p));
  const russian = pages.filter((p) => p.relative.startsWith("ru/"));
  const decisions = pages.filter(decision);
  const list = (items: typeof pages) => items.map((p) => p.line).join("\n");
  return `# Iva

> Iva (in Russian: Ива) is an open-source personal AI assistant in Telegram. ${section(0).groups.Description[0]} MIT license. Made by Majento, Tashkent, Uzbekistan.

- Price: Iva is free. The model and server on the default stack run about $14-15/mo; with a ChatGPT or Claude subscription you already have, the model adds $0 on top.
- Runs on: your own Ubuntu or Debian server, or a Mac that stays on. You talk to Iva through Telegram.
- Models: ChatGPT subscription, Claude Pro or Max subscription, OpenCode Go, Ollama Cloud, OpenRouter, any OpenAI-compatible endpoint.
- Memory: a daily log of every conversation; each night Iva turns it into cards and daily, weekly, monthly and yearly summaries. Plain Markdown files in your own git.\n- Also: voice messages, reminders, a daily brief, Watch, goals and helpers.
- Install: send an AI coding agent (Claude Code or Codex) on your server or Mac the phrase "Install Iva for me, instructions: https://iva-agent.com/install.txt".

## Site
- [Iva: personal AI assistant in Telegram](https://iva-agent.com/): the home page in English
- [Ива: личный AI ассистент в телеграм](https://iva-agent.com/ru/): the home page in Russian
- [Who builds Iva: Majento](https://iva-agent.com/about/): the team behind Iva
- [Source code on GitHub](https://github.com/smixs/iva-agent): MIT license, changelog, issues

## What Iva does
${usecases.en.rows.map((r: any) => `- ${r.title}: ${plainMarkdown(r.text)}`).join("\n")}

## FAQ
${section(10).faq.map((f: any) => `- ${f.question} ${plainMarkdown(f.answer)}`).join("\n")}

## Install
- [Instructions for an AI agent](https://iva-agent.com/install.txt): the text Claude Code or Codex follows to install Iva
- [Install guide](https://iva-agent.com/docs/install/): the same steps for a person

## Docs
${list(english)}

## Документация на русском
${list(russian)}

## Optional
- [Full documentation in one file](https://iva-agent.com/llms-full.txt): every docs page above, in Markdown
${list(decisions)}
`;
}
