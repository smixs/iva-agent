// Search and AI-answer metadata in one place: page titles and descriptions for pages built from
// the repo's Markdown, and the JSON-LD the pages carry. Every structured-data fact here is one the
// visitor can also read on the page or in the docs.
import type { Lang } from "./copy";

export const SITE = "https://iva-agent.com";
export const BRAND = { en: "Iva", ru: "Ива" } as const;

const cyrillic = /[а-яё]/gi;
const latin = /[a-z]/gi;
// The language a text is written in: several English-folder docs (ADRs, the philosophy) are Russian.
export function textLang(text: string): Lang {
  const ru = text.match(cyrillic)?.length || 0;
  const en = text.match(latin)?.length || 0;
  return ru > en ? "ru" : "en";
}

// Shortens to at most `max` characters, at a sentence end when one is close, else at a word.
export function clip(text: string, max = 158): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= max * 0.55) return cut.slice(0, sentence + 1);
  const word = cut.slice(0, max - 1).replace(/[\s,;:—–-]+\S*$/, "");
  return word.replace(/[\s,;:—–-]+$/, "") + "…";
}

// Plain text of inline Markdown: links keep their words, images, code marks and emphasis go.
export function plainMarkdown(s: string): string {
  // Code spans first, so that a tag written as code (`<tg-button>`) stays as words.
  const code: string[] = [];
  return s
    .replace(/`([^`]*)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)])
    .replace(/\s+/g, " ")
    .trim();
}

// The description of a Markdown page: its first prose paragraphs, skipping the title, notes in
// quotes, pictures, tables, code and lists, up to a search-snippet length.
export function markdownDescription(source: string, fallback: string): string {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  const paragraphs: string[] = [];
  let fence = false;
  for (const block of body.split(/\n\s*\n/)) {
    const first = block.trimStart();
    if (/^(```|~~~)/.test(first)) {
      const fences = (block.match(/^\s*(```|~~~)/gm) || []).length;
      if (fences % 2) fence = !fence;
      continue;
    }
    if (fence) {
      if ((block.match(/^\s*(```|~~~)/gm) || []).length % 2) fence = false;
      continue;
    }
    if (/^(#|>|!\[|\||<|[-*+] |\d+\. |=|-{3,})/.test(first)) continue;
    const text = plainMarkdown(block);
    if (text.length < 20) continue;
    paragraphs.push(text);
    if (paragraphs.join(" ").length >= 120) break;
  }
  return clip(paragraphs.join(" ") || fallback);
}

// "<page> | Iva" (a docs page: "| Iva docs") while it fits a search title; a title that already
// names Iva stands alone.
export function pageTitle(title: string, lang: Lang, docs = false): string {
  if (/\b(Iva|IVA)\b|Ив[аеуыо]/.test(title)) return title;
  const brand = docs ? (lang === "ru" ? "документация Ивы" : "Iva docs") : BRAND[lang];
  const full = `${title} | ${brand}`;
  return full.length <= 62 ? full : title;
}

const ORG = SITE + "/#organization";
const APP = SITE + "/#software";
const WEBSITE = SITE + "/#website";

export const organization = (lang: Lang) => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": ORG,
  name: "Majento",
  url: "https://majento.ai/",
  description:
    lang === "ru"
      ? "Majento — компания из Ташкента, которая разрабатывает программные продукты и внедряет AI в бизнес-процессы. Majento делает Иву."
      : "Majento is a software company based in Tashkent, Uzbekistan. It builds products, implements AI in business workflows and makes Iva.",
  address: {
    "@type": "PostalAddress",
    addressLocality: lang === "ru" ? "Ташкент" : "Tashkent",
    addressCountry: "UZ",
  },
  brand: { "@type": "Brand", name: "Iva", logo: SITE + "/brand/mark-512.png" },
  sameAs: ["https://github.com/smixs/iva-agent"],
});

export const website = (lang: Lang) => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": WEBSITE,
  url: SITE + "/",
  name: "Iva",
  alternateName: ["Ива", "IVA", "Iva agent"],
  inLanguage: lang,
  publisher: { "@id": ORG },
});

export const softwareApplication = (
  lang: Lang,
  description: string,
  features: string[],
) => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": APP,
  name: "Iva",
  alternateName: ["Ива", "IVA"],
  url: SITE + "/",
  description,
  applicationCategory: "BusinessApplication",
  applicationSubCategory:
    lang === "ru" ? "Личный AI ассистент в Telegram" : "Personal AI assistant in Telegram",
  operatingSystem: "Ubuntu, Debian, macOS",
  featureList: features,
  isAccessibleForFree: true,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  license: "https://opensource.org/license/mit",
  image: SITE + "/brand/mark-512.png",
  installUrl: SITE + (lang === "ru" ? "/ru/docs/install/" : "/docs/install/"),
  softwareHelp: {
    "@type": "CreativeWork",
    url: SITE + (lang === "ru" ? "/ru/docs/" : "/docs/"),
  },
  sameAs: ["https://github.com/smixs/iva-agent"],
  author: { "@id": ORG },
  publisher: { "@id": ORG },
});

export const faqPage = (lang: Lang, faq: { question: string; answer: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  inLanguage: lang,
  mainEntity: faq.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: { "@type": "Answer", text: f.answer.replace(/`/g, "") },
  })),
});

export const breadcrumbs = (crumbs: { name: string; url: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: crumbs.map((c, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: c.name,
    item: new URL(c.url, SITE).href,
  })),
});
