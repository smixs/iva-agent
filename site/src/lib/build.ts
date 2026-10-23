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
export function copyLegacy() {
  return {
    name: "iva-legacy-addresses",
    hooks: {
      "astro:build:done": ({ dir }: { dir: URL }) => {
        const out = dir.pathname;
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
        ]);
        for (const file of files("../docs")) {
          const relative = path.relative("../docs", file);
          if (replaced.has(relative)) continue;
          cpSync(file, path.join(out, relative), { recursive: true });
        }
        if (existsSync("../assets"))
          cpSync("../assets", path.join(out, "assets"), { recursive: true });
        cpSync("../install.sh", path.join(out, "install.sh"));
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
