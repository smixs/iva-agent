// Service marks on their tiles: the art, the tile colour and the mark colour. One list for the
// services flying into the hero phone (HeroApps) and the services section (Connections).
const svg = import.meta.glob<string>("../assets/logos/*.svg", { query: "?raw", import: "default", eager: true });
const logo = (id: string) => svg[`../assets/logos/${id}.svg`];
const b24 = (logo("bitrix24").match(/<path[^>]*d="(M132[^"]+)"/) || [])[1];
const taxi = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 3.2h4.8l.5 2H9.1z"/><path d="M7.4 6.4h9.2c.8 0 1.5.5 1.8 1.2l1.4 3.6c.9.3 1.6 1.2 1.6 2.2V17c0 .6-.4 1-1 1h-1.1a2.4 2.4 0 0 1-4.7 0H9.6a2.4 2.4 0 0 1-4.7 0H3.6c-.6 0-1-.4-1-1v-3.6c0-1 .7-1.9 1.6-2.2l1.4-3.6c.3-.7 1-1.2 1.8-1.2zm.4 1.9-1 2.7h10.4l-1-2.7z"/></svg>`;
const bag = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round"><path d="M5.2 8.2h13.6l-1.1 11.6a1.4 1.4 0 0 1-1.4 1.3H7.7a1.4 1.4 0 0 1-1.4-1.3z" fill="currentColor"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" stroke="#ff6a2b"/></svg>`;
const mail = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="m4 7.2 8 6 8-6"/></svg>`;
const browser = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3.4 12h17.2M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3z"/></svg>`;
const more = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const box = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.8 3.8 7v10l8.2 4.2 8.2-4.2V7z"/><path d="m3.8 7 8.2 4.2L20.2 7M12 11.2v10"/></svg>`;
const notes = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><rect x="4.8" y="3.4" width="14.4" height="17.2" rx="2.6"/><path d="M8.4 8.6h7.2M8.4 12.2h7.2M8.4 15.8h4.4"/></svg>`;
const person = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8.4" r="4.1"/><path d="M4.4 20.2c.7-4.2 3.9-6.6 7.6-6.6s6.9 2.4 7.6 6.6z"/></svg>`;
export type Mark = [art: string, tile: string, colour: string];
export const marks: Record<string, Mark> = {
  taxi: [taxi, "#ffd23f", "#141414"],
  gmail: [logo("gmail"), "#fff", "#ea4335"],
  mail: [mail, "#fff", "#1a73e8"],
  bitrix24: [`<svg viewBox="131 -1 41 27.6" fill="currentColor"><path d="${b24}"/></svg>`, "#2fc6f6", "#fff"],
  delivery: [bag, "#fff", "#ff6a2b"],
  googlecalendar: [logo("googlecalendar"), "#fff", "#1a73e8"],
  browser: [browser, "#fff", "#0f9d58"],
  "1c": [logo("1c"), "#ffe14d", "#d52b1e"],
  notion: [logo("notion"), "#fff", "#111"],
  googlesheets: [logo("googlesheets"), "#fff", "#0f9d58"],
  slack: [logo("slack"), "#fff", "#4a154b"],
  googledrive: [logo("googledrive"), "#fff", "#1fa463"],
  todoist: [logo("todoist"), "#fff", "#e44332"],
  github: [logo("github"), "#17211d", "#fff"],
  obsidian: [logo("obsidian"), "#fff", "#7c3aed"],
  linear: [logo("linear"), "#fff", "#5e6ad2"],
  googledocs: [logo("googledocs"), "#fff", "#4285f4"],
  googletasks: [logo("googletasks"), "#fff", "#1a73e8"],
  more: [more, "#a4dc55", "#17211d"],
  amocrm: [logo("amocrm"), "#fff", "#1c5bd8"],
  warehouse: [box, "#1b8fd8", "#fff"],
  notes: [notes, "#ffd60a", "#3b3326"],
  contacts: [person, "#8e8e93", "#fff"],
  meta: [logo("meta"), "#fff", "#0668e1"],
  facebook: [logo("facebook"), "#0866ff", "#fff"],
  instagram: [logo("instagram"), "linear-gradient(45deg, #f9ce34, #ee2a7b 55%, #6228d7)", "#fff"],
  threads: [logo("threads"), "#111", "#fff"],
  whatsapp: [logo("whatsapp"), "#25d366", "#fff"],
  telegram: [logo("telegram"), "#26a5e4", "#fff"],
  youtube: [logo("youtube"), "#fff", "#ff0000"],
  tiktok: [logo("tiktok"), "#111", "#fff"],
  x: [logo("x"), "#111", "#fff"],
  vk: [logo("vk"), "#0077ff", "#fff"],
  linkedin: [logo("linkedin"), "#0a66c2", "#fff"],
  googleads: [logo("googleads"), "#fff", "#4285f4"],
  googleanalytics: [logo("googleanalytics"), "#fff", "#e37400"],
  google: [logo("google"), "#fff", "#4285f4"],
  yandex: [logo("yandex"), "#fc3f1d", "#fff"],
  semrush: [logo("semrush"), "#ff642d", "#fff"],
  openai: [logo("openai"), "#111", "#fff"],
  nanobanana: [logo("googlegemini"), "#ffe135", "#2b2b2b"],
  seedance: [logo("bytedance"), "#fff", "#3c8cff"],
  asana: [logo("asana"), "#fff", "#f06a6a"],
  trello: [logo("trello"), "#0052cc", "#fff"],
  jira: [logo("jira"), "#fff", "#0052cc"],
  clickup: [logo("clickup"), "#fff", "#7b68ee"],
  things: [logo("things"), "#fff", "#3b8df0"],
  airtable: [logo("airtable"), "#fff", "#18bfff"],
  figma: [logo("figma"), "#fff", "#f24e1e"],
  excel: [logo("microsoftexcel"), "#107c41", "#fff"],
  word: [logo("microsoftword"), "#185abd", "#fff"],
  outlook: [logo("microsoftoutlook"), "#0078d4", "#fff"],
  teams: [logo("microsoftteams"), "#5b5fc7", "#fff"],
  pdf: [logo("adobeacrobatreader"), "#ec1c24", "#fff"],
  shopify: [logo("shopify"), "#95bf47", "#fff"],
  stripe: [logo("stripe"), "#635bff", "#fff"],
  canva: [logo("canva"), "linear-gradient(135deg, #00c4cc, #7d2ae8)", "#fff"],
  hubspot: [logo("hubspot"), "#ff7a59", "#fff"],
  perplexity: [logo("perplexity"), "#1f1f1f", "#20b8cd"],
  maildotru: [logo("maildotru"), "#fff", "#005ff9"],
  dropbox: [logo("dropbox"), "#fff", "#0061ff"],
  miro: [logo("miro"), "#ffd02f", "#050038"],
  zoom: [logo("zoom"), "#0b5cff", "#fff"],
};
// Marks wider than tall get more of their tile.
export const wide = new Set(["1c", "bitrix24", "amocrm", "zoom"]);
// Services flying into the hero phone one at a time: the owner's everyday tools first,
// neighbours always from different kinds of work, then the whole list again shuffled.
export const stream = [
  "bitrix24", "gmail", "1c", "meta", "amocrm", "googlecalendar", "warehouse", "instagram", "excel", "openai",
  "taxi", "notion", "linkedin", "pdf", "nanobanana", "todoist", "yandex", "telegram", "word", "delivery",
  "jira", "semrush", "things", "youtube", "googlesheets", "asana", "google", "tiktok", "trello", "seedance",
  "whatsapp", "clickup", "googledrive", "notes", "facebook", "linear", "contacts", "googleads", "slack", "vk",
  "airtable", "googleanalytics", "x", "zoom", "threads", "canva", "shopify", "stripe", "hubspot", "figma",
  "miro", "dropbox", "obsidian", "github", "perplexity", "maildotru", "outlook", "teams", "googletasks", "googledocs",
];
// Every mark as a symbol, drawn once inside the page (end of Home.astro): the hero stream and the
// services section both point at it, so a tile never waits on a file and never shows up empty.
// Kept out of view rather than display:none, which would switch off the marks' gradients.
const symbol = (id: string, art: string) => {
  const [, attrs, inner] = art.match(/<svg([^>]*)>([\s\S]*)<\/svg>/)!;
  const box = attrs.match(/viewBox="([^"]+)"/)![1];
  const rest = attrs.replace(/\s(viewBox|xmlns|aria-hidden)="[^"]*"/g, "");
  return `<symbol id="svc-${id}" viewBox="${box}"><g${rest}>${inner}</g></symbol>`;
};
export const sprite = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute;overflow:hidden">${Object.entries(marks).map(([id, [art]]) => symbol(id, art)).join("")}</svg>`;
