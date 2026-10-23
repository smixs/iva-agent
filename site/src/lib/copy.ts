import copy from "../data/copy.json";
export type Lang = "ru" | "en";
export const homeCopy = copy;
export const phrase = (lang: Lang) =>
  lang === "ru"
    ? "Установи мне Иву, инструкция: https://iva-agent.com/install.txt"
    : "Install Iva for me, instructions: https://iva-agent.com/install.txt";
export const rich = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.*?)`/g, "<code>$1</code>");
// Russian typesetting: a short preposition or conjunction never ends a line, and a
// spaced hyphen becomes a dash. Applied to visible copy only.
export const glue = (s: string) =>
  s
    .replace(/ - /g, " — ")
    .replace(/(^|[\s(«])([а-яёА-ЯЁ]{1,2}) /g, "$1$2 ")
    .replace(/(^|[\s(«])([а-яёА-ЯЁ]{1,2}) /g, "$1$2 ");
