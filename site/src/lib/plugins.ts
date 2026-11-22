// The plugins of Iva's default Marketplace as the site shows them. The data is written by
// scripts/sync-plugins.ts from smixs/iva-plugins; nothing here is typed in by hand.
import data from "../data/plugins.json";
import type { Lang } from "./copy";

export type Plugin = (typeof data.plugins)[number];
export const plugins: Plugin[] = data.plugins;
export const categories = data.categories;
export const LIST = data.list;

export const pluginsUrl = (lang: Lang) => (lang === "ru" ? "/ru/plugins/" : "/plugins/");
export const pluginUrl = (lang: Lang, name: string) => pluginsUrl(lang) + name + "/";
export const categoryName = (lang: Lang, id: string) =>
  categories.find((category) => category.id === id)?.[lang] ?? id;

/** The address of the plugin's files at the commit people install. */
export function sourceUrl(plugin: Plugin): string {
  const [, repository, folder] =
    /^(https:\/\/github\.com\/[^/]+\/[^/]+)(?:\/tree\/[^/]+\/(.+))?$/.exec(plugin.repository) ?? [];
  if (!repository) return plugin.repository;
  return `${repository}/tree/${plugin.commit}${folder ? "/" + folder : ""}`;
}

export const labels = {
  en: {
    title: "Plugins for Iva",
    lead: "A new skill installs with one command, or with one phrase in Telegram. Every plugin on this list was read before it was listed: what it runs on the server, which keys it reads and where it connects.",
    description:
      "Plugins for Iva, the personal AI assistant in Telegram: voice replies, Yandex Alice, taxi, Russian shops and tools. Each one is reviewed and installs with one command.",
    search: "Find a plugin",
    all: "All",
    sort: "Sort",
    popular: "Popular",
    newest: "New",
    byName: "By name",
    by: "by",
    empty: "Nothing found.",
    reset: "Clear the search",
    counted:
      "Installs are counted by Iva herself: after a plugin from this list is installed, she sends its name here, and nothing else. One line in .env turns it off.",
    countedLink: "How the count works",
    makeTitle: "Make your own plugin",
    makeText:
      "Tell Iva what is missing: she builds a plugin and installs it for you. If it turns out useful, put it in a GitHub repository of your own and send it to this list. The runbook walks you, or your agent, through every step.",
    runbook: "Publishing runbook",
    guide: "How a plugin is built",
    topic: "Plugins outside the list, on GitHub",
    install: "Install",
    terminal: "In the server's terminal",
    orAsk: "Or write to Iva in Telegram:",
    phrase: (name: string) => `Install the ${name} plugin`,
    copy: "Copy",
    copied: "Copied",
    author: "Author",
    repository: "Repository",
    version: "Version",
    category: "Category",
    runs: "What it starts",
    keys: "Keys",
    noKeys: "None needed",
    network: "Network",
    noNetwork: "Connects nowhere",
    parts: "Inside",
    skills: "skills",
    code: "code in the agent's process",
    services: "services",
    mcp: "MCP servers",
    added: "On the list since",
    installs: "Installs",
    risk: "A plugin works with the keys of your Iva. Being listed means this commit was read; it does not make the plugin safe for every machine.",
    riskLink: "What you risk",
    back: "All plugins",
    home: "Home",
    plugins: "Plugins",
  },
  ru: {
    title: "Плагины для Ивы",
    lead: "Новое умение ставится одной командой или одной фразой в Telegram. Каждый плагин в списке прочитан до публикации: что он запускает на сервере, какие ключи читает и куда ходит в сеть.",
    description:
      "Плагины для Ивы, личного AI-ассистента в Telegram: голосовые ответы, Яндекс Алиса, такси, российские магазины и инструменты. Каждый проверен и ставится одной командой.",
    search: "Найти плагин",
    all: "Все",
    sort: "Сортировка",
    popular: "Популярные",
    newest: "Новые",
    byName: "По названию",
    by: "автор",
    empty: "Ничего не нашлось.",
    reset: "Сбросить поиск",
    counted:
      "Установки считает сама Ива: после установки плагина из этого списка она отправляет сюда его имя, и больше ничего. Выключается одной строкой в .env.",
    countedLink: "Как устроен счёт",
    makeTitle: "Сделайте свой плагин",
    makeText:
      "Расскажите Иве, чего не хватает: она соберёт плагин и поставит его вам. Если он пригодился, выложите его в свой репозиторий на GitHub и отправьте в этот список. Ранбук проведёт вас или вашего агента по всем шагам.",
    runbook: "Ранбук публикации",
    guide: "Как устроен плагин",
    topic: "Плагины вне списка на GitHub",
    install: "Установка",
    terminal: "В терминале сервера",
    orAsk: "Или напишите Иве в Telegram:",
    phrase: (name: string) => `Поставь плагин ${name}`,
    copy: "Скопировать",
    copied: "Скопировано",
    author: "Автор",
    repository: "Репозиторий",
    version: "Версия",
    category: "Категория",
    runs: "Что запускает",
    keys: "Ключи",
    noKeys: "Не нужны",
    network: "Сеть",
    noNetwork: "Никуда не ходит",
    parts: "Состав",
    skills: "скиллы",
    code: "код в процессе агента",
    services: "сервисы",
    mcp: "MCP-серверы",
    added: "В списке с",
    installs: "Установок",
    risk: "Плагин работает с ключами вашей Ивы. Запись в списке значит, что этот коммит прочитан, а не что плагин безопасен на любой машине.",
    riskLink: "Чем вы рискуете",
    back: "Все плагины",
    home: "Главная",
    plugins: "Плагины",
  },
} as const;
