import home from "../data/home.json";
export type Lang = "ru" | "en";
// Typographic glue: a short preposition or conjunction stays with the next word, and a
// dash stays with the word before it, so no line ends on «с», «в» or «—».
const glue = (s: string) =>
  s
    .replace(/(^|[\s(«])(с|в|и|а|к|у|о|на|за|по|до|из|от|не|или|the|a|an|to|of|in|on|by|or)\s/giu, "$1$2\u00A0")
    .replace(/(^|[\s(«])(с|в|и|а|к|у|о|на|за|по|до|из|от|не|или|the|a|an|to|of|in|on|by|or)\s/giu, "$1$2\u00A0")
    .replace(/ — /g, "\u00A0— ");
const deep = <T,>(v: T): T =>
  (typeof v === "string"
    ? glue(v)
    : Array.isArray(v)
      ? v.map(deep)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
        : v) as T;
// The chat inside the phone keeps the film's line breaks, so it is left as written.
export const homeCopy = Object.fromEntries(
  Object.entries(home).map(([lang, v]) => [lang, { ...deep(v), chat: v.chat }]),
) as typeof home;
export const phrase = (lang: Lang) =>
  lang === "ru"
    ? "Установи Иву, инструкции: https://iva-agent.com/install.txt"
    : "Install Iva for me, instructions: https://iva-agent.com/install.txt";
export const command =
  "curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash";
export const rich = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.*?)`/g, "<code>$1</code>");
