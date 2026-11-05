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
};
