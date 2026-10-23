import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
export const collections = {
  docs: defineCollection({
    loader: glob({
      pattern: "**/*.md",
      base: "../docs",
      generateId: ({ entry }) => entry.replace(/\.md$/, ""),
    }),
  }),
};
