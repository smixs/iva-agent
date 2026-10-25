import { actionFrames, demoProviders, demoMenuEntries, type DemoProvider, type DemoMenuEntry, type DemoLang, type ActionId } from "../data/demo.ts";

export const FPS = 60;
// Only phone footage remains. Morning starts with the fully readable film card.
const spans = [[360, 540], [1200, 1860], [1980, 2760], [2880, 4380]] as const;
export const DEMO_FRAMES = spans.reduce((sum, [a, b]) => sum + b - a, 0);
export const actions = Object.keys(actionFrames) as ActionId[];
export type Decision = { value: boolean; at: number; source: "user" | "auto" };
export type DemoState = { frame: number; decisions: Partial<Record<ActionId, Decision>> };
export const freshDemo = (): DemoState => ({ frame: 0, decisions: {} });
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function filmFrame(frame: number): number {
  let left = Math.max(0, frame);
  for (const [a, b] of spans) {
    if (left < b - a) return a + left;
    left -= b - a;
  }
  return 4380;
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
export function choose(state: DemoState, action: ActionId, value: boolean, source: Decision["source"] = "user"): boolean {
  if (state.decisions[action]) return false;
  state.decisions[action] = { value, at: filmFrame(state.frame), source };
  return true;
}
export function advance(state: DemoState, frame: number, automatic = true): void {
  state.frame = Math.min(DEMO_FRAMES, Math.max(state.frame, frame));
  if (!automatic) return;
  const f = filmFrame(state.frame);
  for (const action of actions) {
    const at = actionFrames[action] + 12; // film's contact frame, after the ring approaches
    if (!state.decisions[action] && f >= at) {
      state.decisions[action] = { value: true, at, source: "auto" };
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
export function mariaAt(state: DemoState, f = filmFrame(state.frame)) {
  const choice = state.decisions.restaurant;
  if (!choice?.value) return { p: 0, venue: false, confirmed: false };
  const push = choice.at + 30, pop = choice.at + 168;
  return {
    p: f < pop ? iosPush(f, push) : 1 - iosPush(f, pop),
    venue: f >= choice.at + 78,
    confirmed: f >= choice.at + 138,
  };
}
export const sceneFrames = [360, 1460, 1710, 2190, 2580, 3080, 3340, 3470, 3780, 4160, 4300];
export function sceneAt(f: number): number {
  const starts = [360, 1240, 1530, 2010, 2330, 2910, 3180, 3392, 3600, 3950, 4220];
  let scene = 0;
  starts.forEach((at, i) => { if (f >= at) scene = i; });
  return scene;
}
export function clockAt(f: number): string {
  const marks: [number, string][] = [[0, "9:41"], [1220, "12:04"], [1510, "12:10"], [2000, "13:00"], [2310, "15:20"], [2900, "16:05"], [3170, "17:41"], [3440, "17:42"], [3590, "18:30"], [3930, "19:04"], [4220, "14:31"]];
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
