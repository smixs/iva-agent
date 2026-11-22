// The plugins of Iva's default Marketplace as the site shows them. The data is written by
// scripts/sync-plugins.ts from smixs/iva-plugins; nothing here is typed in by hand.
import data from "../data/plugins.json";
import type { Lang } from "./copy";

export type Plugin = (typeof data.plugins)[number];
export const plugins: Plugin[] = data.plugins;
export const categories = data.categories;
export const LIST = data.list;

export const pluginsUrl = (lang: Lang) =>
  lang === "ru" ? "/ru/plugins/" : "/plugins/";
export const pluginUrl = (lang: Lang, name: string) =>
  pluginsUrl(lang) + name + "/";
export const categoryName = (lang: Lang, id: string) =>
  categories.find((category) => category.id === id)?.[lang] ?? id;

/** The address of the plugin's files at the commit people install. */
export function sourceUrl(plugin: Plugin): string {
  const [, repository, folder] =
    /^(https:\/\/github\.com\/[^/]+\/[^/]+)(?:\/tree\/[^/]+\/(.+))?$/.exec(
      plugin.repository,
    ) ?? [];
  if (!repository) return plugin.repository;
  return `${repository}/tree/${plugin.commit}${folder ? "/" + folder : ""}`;
}

export const labels = {
  en: {
    title: "Plugins for Iva",
    lead: "A new skill, one phrase in Telegram",
    description:
      "Plugins for Iva, the personal AI assistant in Telegram: voice replies, Yandex Alice, taxi, Russian shops and tools. Each one is reviewed and installs with one command.",
    search: "Find a plugin",
    all: "All",
    sort: "Sort",
    popular: "Popular",
    newest: "New",
    byName: "By name",
    empty: "Nothing found.",
    reset: "Clear the search",
    filter: "Category",
    makeTitle: "Make your own plugin",
    makeText: "Ask Iva to build it, put it on GitHub, send it to the list",
    runbook: "Publishing runbook",
    guide: "How a plugin is built",
    topic: "More plugins on GitHub",
    install: "Install",
    terminal: "In the terminal",
    orAsk: "Or write to Iva:",
    phrase: (name: string) => `Install the ${name} plugin`,
    copy: "Copy",
    copied: "Copied",
    author: "Author",
    repository: "Repository",
    version: "Version",
    runs: "What it starts",
    keys: "Keys",
    noKeys: "None needed",
    network: "Network",
    noNetwork: "Connects nowhere",
    installs: "Installs",
    back: "All plugins",
    home: "Home",
    plugins: "Plugins",
  },
  ru: {
    title: "Плагины для Ивы",
    lead: "Новое умение — одной фразой в Telegram",
    description:
      "Плагины для Ивы, личного AI-ассистента в Telegram: голосовые ответы, Яндекс Алиса, такси, российские магазины и инструменты. Каждый проверен и ставится одной командой.",
    search: "Найти плагин",
    all: "Все",
    sort: "Сортировка",
    popular: "Популярные",
    newest: "Новые",
    byName: "По названию",
    empty: "Ничего не нашлось.",
    reset: "Сбросить поиск",
    filter: "Категория",
    makeTitle: "Сделайте свой плагин",
    makeText: "Попросите Иву собрать его, выложите на GitHub, отправьте в список",
    runbook: "Ранбук публикации",
    guide: "Как устроен плагин",
    topic: "Ещё плагины на GitHub",
    install: "Установка",
    terminal: "В терминале",
    orAsk: "Или напишите Иве:",
    phrase: (name: string) => `Поставь плагин ${name}`,
    copy: "Скопировать",
    copied: "Скопировано",
    author: "Автор",
    repository: "Репозиторий",
    version: "Версия",
    runs: "Что запускает",
    keys: "Ключи",
    noKeys: "Не нужны",
    network: "Сеть",
    noNetwork: "Никуда не ходит",
    installs: "Установок",
    back: "Все плагины",
    home: "Главная",
    plugins: "Плагины",
  },
} as const;
