import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import { copyLegacy, lastModified, files } from "./src/lib/build.ts";
import { docLinks } from "./src/lib/doc-links.ts";
import { existsSync } from "node:fs";
export default defineConfig({
  site: "https://iva-agent.com",
  output: "static",
  trailingSlash: "always",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "ru"],
    routing: { prefixDefaultLocale: false },
  },
  markdown: { processor: unified({ remarkPlugins: [docLinks] }) },
  integrations: [
    sitemap({
      filter: (page) => !page.includes("404"),
      serialize(item) {
        const p = new URL(item.url).pathname;
        let source = "src/components/Home.astro";
        if (p.includes("/docs/")) {
          const relative = p
            .replace(/^\/(ru\/)?docs\//, "$1")
            .replace(/\/$/, "");
          source = "../docs/" + (relative ? relative + ".md" : "README.md");
          if (!existsSync(source))
            source = "../docs/" + relative + "/README.md";
          if (!existsSync(source)) {
            const directory = "../docs/" + relative;
            if (existsSync(directory)) {
              item.lastmod = new Date(
                Math.max(
                  ...files(directory).map((f) => lastModified(f).getTime()),
                ),
              ).toISOString();
              return item;
            }
            source = "../docs/README.md";
          }
        } else if (p.includes("about") || p === "/privacy/")
          source = "../docs/" + p.slice(1) + "index.html";
        item.lastmod = lastModified(source).toISOString();
        return item;
      },
    }),
    copyLegacy(),
  ],
});
