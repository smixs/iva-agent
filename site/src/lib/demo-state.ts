import { T, actionFrames, actionNeeds, widgetFrames, demoProviders, demoMenuEntries, type DemoProvider, type DemoMenuEntry, type DemoLang, type ActionId } from "../data/demo.ts";

export const FPS = 60;
// The film runs a fifth faster than it was shot: the widget scenes made it longer (owner, 11.11.2026).
export const RATE = 1.2;
// Only phone footage remains. Morning starts with the fully readable film card; the team brief
// and Helga's message fill the stretch where the film had its titles.
// T() adds the frames of the widget scenes, which the film did not have.
const spans = [[360, 1860], [1980, 2760], [2880, 6240]].map(([a, b]) => [T(a), T(b)] as const);
export const DEMO_FRAMES = spans.reduce((sum, [a, b]) => sum + b - a, 0);
export const actions = Object.keys(actionFrames) as ActionId[];
// Most cards ask yes or no; Helga's also offers to open her chat.
export type Choice = "yes" | "no" | "open";
export type Decision = { value: Choice; at: number; source: "user" | "auto" };
export type DemoState = { frame: number; decisions: Partial<Record<ActionId, Decision>> };
export const freshDemo = (): DemoState => ({ frame: 0, decisions: {} });
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function filmFrame(frame: number): number {
  let left = Math.max(0, frame);
  for (const [a, b] of spans) {
    if (left < b - a) return a + left;
    left -= b - a;
  }
  return spans[spans.length - 1][1];
}
export function demoFrame(film: number): number {
  let sum = 0;
  for (const [a, b] of spans) {
    if (film <= b) return sum + Math.max(0, film - a);
    sum += b - a;
  }
  return DEMO_FRAMES;
}
// Single assignment: user input and autoplay race through this one function.
export function choose(state: DemoState, action: ActionId, value: Choice, source: Decision["source"] = "user"): boolean {
  if (state.decisions[action]) return false;
  state.decisions[action] = { value, at: filmFrame(state.frame), source };
  return true;
}
// An answer that depends on another is offered only after that one was "yes".
export const offered = (state: DemoState, action: ActionId): boolean => {
  const need = actionNeeds[action];
  return !need || state.decisions[need]?.value === "yes";
};
// The stretch a declined answer leaves empty: the game after the taxi, the order after the list.
const skips: { action: ActionId; from: number; to: number }[] = [
  { action: "taxi", from: widgetFrames.game - 60, to: T(2760) },
  { action: "shopping", from: widgetFrames.order - 60, to: T(3950) - 20 },
];
export function advance(state: DemoState, frame: number, automatic = true): void {
  state.frame = Math.min(DEMO_FRAMES, Math.max(state.frame, frame));
  for (const { action, from, to } of skips) {
    const f = filmFrame(state.frame), choice = state.decisions[action];
    if (f >= from && f < to && choice && choice.value !== "yes") state.frame = demoFrame(to);
  }
  if (!automatic) return;
  const f = filmFrame(state.frame);
  for (const action of actions) {
    const at = actionFrames[action] + 12; // film's contact frame, after the ring approaches
    if (!state.decisions[action] && f >= at && offered(state, action)) {
      state.decisions[action] = { value: "yes", at, source: "auto" };
    }
  }
}
export const springConfig = {
  arrive: { damping: 17, stiffness: 170, mass: 1 },
  press: { damping: 14, stiffness: 420, mass: 0.6 },
  settle: { damping: 22, stiffness: 140, mass: 1 },
  release: { damping: 9, stiffness: 260, mass: 0.6 },
  land: { damping: 12, stiffness: 210, mass: 1 },
} as const;
// The same damped oscillator as Remotion spring(), evaluated analytically. The film's
// springAt snap threshold and all five physical configurations are unchanged.
export function springAt(frame: number, at: number, name: keyof typeof springConfig): number {
  if (frame < at) return 0;
  const { damping: c, stiffness: k, mass: m } = springConfig[name];
  const t = (frame - at) / FPS;
  const w0 = Math.sqrt(k / m);
  const z = c / (2 * Math.sqrt(k * m));
  const w1 = w0 * Math.sqrt(1 - z * z);
  const v = 1 - Math.exp(-z * w0 * t) * (Math.cos(w1 * t) + z * w0 / w1 * Math.sin(w1 * t));
  return frame - at > FPS && Math.abs(1 - v) < 5e-4 ? 1 : v;
}
export const easeOut = (f: number, a: number, b: number) => 1 - (1 - clamp01((f - a) / (b - a))) ** 3;
export function ramp(f: number, a: number, b: number): number {
  const t = clamp01((f - a) / (b - a));
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}
export function swapAt(f: number, at: number) {
  return { k: clamp01(springAt(f, at + 2, "settle")), a: 1 - ramp(f, at, at + 12), b: easeOut(f, at + 5, at + 22) };
}
export function tapPhase(f: number, start: number) {
  const t = f - start;
  if (t < 0) return { d: 0, opacity: 0, pressed: 0 };
  const g = 1 - (1 - clamp01(t / 12)) ** 3;
  const press = springAt(f, start + 12, "press");
  const release = springAt(f, start + 20, "settle");
  const bounce = springAt(f, start + 20, "release");
  const fade = clamp01((t - 30) / 14);
  return {
    d: (0.5 + 0.5 * g) * (1 - 0.14 * press) * (1 - 0.2 * release) * 54,
    opacity: Math.min(1, g * 1.4) * (1 - fade * fade * (3 - 2 * fade)),
    pressed: press - bounce,
  };
}
// Film's Easing.bezier(.32,.72,0,1), solved for x without a runtime dependency.
export function iosPush(f: number, at: number): number {
  const x = clamp01((f - at) / 34);
  let lo = 0, hi = 1, t = x;
  const bezier = (n: number, a: number, b: number) => 3 * (1 - n) ** 2 * n * a + 3 * (1 - n) * n * n * b + n ** 3;
  for (let i = 0; i < 22; i++) {
    t = (lo + hi) / 2;
    if (bezier(t, 0.32, 0) < x) lo = t; else hi = t;
  }
  return x === 0 || x === 1 ? x : bezier(t, 0.72, 1);
}
// A chat that slides in over Iva's and back: Maria's once the restaurant is shared with her,
// Helga's once her chat is opened from her card. The card's answer lands while it is open.
const chats = { maria: ["restaurant", "yes"], helga: ["helga", "open"] } as const;
export type Chat = keyof typeof chats;
export const chatOf: Partial<Record<ActionId, Chat>> = { restaurant: "maria", helga: "helga" };
export function chatAt(state: DemoState, chat: Chat, f = filmFrame(state.frame)) {
  const [action, value] = chats[chat];
  const choice = state.decisions[action];
  if (choice?.value !== value) return { pushed: false, p: 0, venue: false, confirmed: false };
  const push = choice.at + 30, pop = choice.at + 168;
  return {
    pushed: true,
    p: f < pop ? iosPush(f, push) : 1 - iosPush(f, pop),
    venue: chat === "maria" && f >= choice.at + 78,
    confirmed: f >= choice.at + 138,
  };
}
// Where each scene stands complete, and the answer a scene waits for, if any.
export const sceneFrames = [360, 700, T(760), T(1075), T(1460), T(1710), T(2190), T(2580), T(2760) - 60, T(3080), T(3340), T(3470), T(3780), actionFrames.order - 10, T(4160), T(4300), T(4510), T(4790), T(5090), T(5470), T(5850), T(6100)];
export const sceneNeeds: Record<number, ActionId> = { 8: "taxi", 11: "restaurant", 13: "shopping" };
export const MARIA_SCENE = 11;
export function sceneAt(f: number): number {
  const starts = [360, widgetFrames.weather - 45, T(540), T(915), T(1240), T(1530), T(2010), T(2330), widgetFrames.game - 50, T(2910), T(3180), T(3392), T(3600), widgetFrames.order - 50, T(3950), T(4220), T(4330), T(4620), T(4910), T(5220), T(5600), T(5950)];
  let scene = 0;
  starts.forEach((at, i) => { if (f >= at) scene = i; });
  return scene;
}
export function clockAt(f: number): string {
  const marks: [number, string][] = [[0, "9:41"], [T(540), "9:42"], [T(905), "11:25"], [T(1220), "12:04"], [T(1510), "12:10"], [T(2000), "13:00"], [T(2310), "15:20"], [widgetFrames.game - 60, "15:24"], [T(2900), "16:05"], [T(3170), "17:41"], [T(3440), "17:42"], [T(3590), "18:30"], [widgetFrames.order - 60, "18:34"], [T(3930), "19:04"], [T(4220), "14:31"], [T(4330), "15:10"], [T(4620), "16:02"], [T(4910), "16:40"], [T(5220), "17:15"], [T(5600), "18:20"], [T(5950), "20:00"]];
  return marks.reduce((time, [at, value]) => f >= at ? value : time, "9:41");
}


// Local, explicit demo interactions; no keys, accounts or network state.
export type DemoInteractions = {
  menu: "root" | "models" | "restart" | DemoMenuEntry | null;
  menuSeen: boolean; language: DemoLang; provider: DemoProvider; model: string; browsing: DemoProvider;
  pending: { provider: DemoProvider; model: string } | null;
  writes: boolean; restarted: boolean; install: boolean | null;
  copy: "idle" | "pending" | "copied" | "denied";
};
export function freshInteractions(language: DemoLang): DemoInteractions {
  return { menu: null, menuSeen: false, language, provider: "codex", model: "gpt-6.1-sol", browsing: "codex",
    pending: null, writes: true, restarted: false, install: null, copy: "idle" };
}
export function menuCommand(state: DemoInteractions, action: string): boolean {
  if (action === "toggle") return menuCommand(state, state.menu === null ? "open" : "close");
  if (action === "open") { state.menu = "root"; state.menuSeen = true; state.restarted = false; return true; }
  if (action === "close") { state.menu = null; state.pending = null; return true; }
  if (!state.menu) return false;
  if (action === "back") {
    state.menu = state.menu === "models" ? "model" : state.menu === "restart" ? "models" : "root";
    state.pending = null;
    return true;
  }
  const [kind, value] = action.split(":");
  if (kind === "root" && Object.hasOwn(demoMenuEntries, value)) {
    state.menu = value as DemoMenuEntry;
    state.restarted = false;
    return true;
  }
  if (kind === "provider" && state.menu === "model" && Object.hasOwn(demoProviders, value)) {
    state.browsing = value as DemoProvider; state.menu = "models"; return true;
  }
  if (kind === "model" && state.menu === "models" && (demoProviders[state.browsing].models as readonly string[]).includes(value)) {
    state.pending = { provider: state.browsing, model: value };
    state.menu = "restart"; return true;
  }
  if (action === "restart:yes" && state.menu === "restart" && state.pending) {
    state.provider = state.pending.provider; state.model = state.pending.model;
    state.pending = null; state.restarted = true; state.menu = "model"; return true;
  }
  if (kind === "notices" && state.menu === "notices" && (value === "0" || value === "1")) {
    state.writes = value === "1"; return true;
  }
  if (kind === "language" && state.menu === "language" && (value === "ru" || value === "en")) {
    state.language = value; state.menu = "root"; return true;
  }
  return false;
}
export function selectInstall(state: DemoInteractions, value: boolean): boolean {
  if (state.install !== null) return false;
  state.install = value; state.copy = value ? "pending" : "idle"; return true;
}
export function finishInstallCopy(state: DemoInteractions, ok: boolean): boolean {
  if (state.install !== true || state.copy !== "pending") return false;
  state.copy = ok ? "copied" : "denied"; return true;
}
export function replayInteractions(state: DemoInteractions): DemoInteractions {
  return { ...state, menu: null, pending: null, restarted: false, install: null, copy: "idle" };
}

// Accept only an explicit inline-keyboard button. Root status data attributes
// and unrelated controls must never be interpreted as an installation answer.
export function selectInstallFromButton(
  state: DemoInteractions,
  button: { tagName: string; dataset: { installChoice?: string } } | null,
): boolean {
  if (button?.tagName !== "BUTTON") return false;
  const value = button.dataset.installChoice;
  return value === "yes" || value === "no" ? selectInstall(state, value === "yes") : false;
}

// The menu's explicit installation action can be retried after a declined end CTA
// or a denied clipboard permission, through the same shared copy-result transition.
export function beginInstallCopy(state: DemoInteractions): boolean {
  if (state.copy === "pending") return false;
  state.install = true;
  state.copy = "pending";
  return true;
}
