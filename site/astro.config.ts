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
      // hreflang pairs in the sitemap, the same as in each page's head: /x/ and /ru/x/ when both exist.
      i18n: { defaultLocale: "en", locales: { en: "en", ru: "ru" } },
      serialize(item) {
        const p = new URL(item.url).pathname;
        // The plugin shares one links array between the pages of a pair: copy, never push.
        const en = item.links?.find((l) => l.lang === "en");
        if (en && !item.links!.some((l) => l.lang === "x-default"))
          item.links = [...item.links!, { lang: "x-default", url: en.url }];
        if (p === "/" || p === "/ru/") {
          // The home page is put together from the components, the copy and the data.
          item.lastmod = new Date(
            Math.max(
              ...["src/components", "src/data", "src/layouts"].map((d) =>
                lastModified(d).getTime(),
              ),
            ),
          ).toISOString();
          return item;
        }
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
        } else if (p.includes("about"))
          source = p.startsWith("/ru/") ? "src/data/about-ru.html" : "src/data/about-en.html";
        else if (p === "/privacy/") source = "src/data/privacy.html";
        item.lastmod = lastModified(source).toISOString();
        return item;
      },
    }),
    copyLegacy(),
  ],
});
