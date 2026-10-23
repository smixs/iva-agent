import copy from "../data/copy.json";
export type Lang = "ru" | "en";
export const homeCopy = copy;
export const phrase = (lang: Lang) =>
  lang === "ru"
    ? "Установи мне Иву, инструкция: https://iva-agent.com/install.txt"
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
