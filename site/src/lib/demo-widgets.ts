// Plays the widgets of the demonstration (components/DemoWidget.astro) by the film's frame: each
// builds up after its bubble has arrived, the taxi drives, the list is ticked off, the order is
// paid. What the visitor touches (a tab, a tick, the game) stays theirs until the replay.
import { T, widgetFrames, type DemoLang, type DemoMessage } from "../data/demo.ts";
import { listStruck, routePaths } from "../data/demo-widgets.ts";
import { FPS, clamp01, easeOut, ramp, springAt, type DemoState } from "./demo-state.ts";
import { mountGame } from "./demo-game.ts";

export type WidgetFrame = { f: number; reduced: boolean; state: DemoState };
type Part = { el: HTMLElement; a: number; b: number };
const num = (value: number) => String(Math.round(value * 1000) / 1000);
// When ramp() reaches `u`: the line's points pop as the drawing passes them.
const rampTime = (u: number) => u < 0.5 ? Math.cbrt(u / 4) : 1 - Math.cbrt((1 - u) * 2) / 2;
// A point and a heading on a polyline, `u` of the way along it.
function along(points: readonly (readonly number[])[], u: number) {
  const lengths = points.slice(1).map(([x, y], i) => Math.hypot(x - points[i][0], y - points[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const at = (distance: number) => {
    let left = Math.max(0, Math.min(total, distance));
    for (let i = 0; i < lengths.length; i++) {
      if (left <= lengths[i] || i === lengths.length - 1) {
        const k = lengths[i] ? left / lengths[i] : 0;
        return [points[i][0] + (points[i + 1][0] - points[i][0]) * k, points[i][1] + (points[i + 1][1] - points[i][1]) * k];
      }
      left -= lengths[i];
    }
    return [...points[0]];
  };
  const [x, y] = at(u * total), [x0, y0] = at(u * total - 5), [x1, y1] = at(u * total + 5);
  return { x, y, angle: Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI };
}

export function mountWidgets(root: HTMLElement, messages: DemoMessage[], lang: DemoLang, changed: () => void, signal: AbortSignal) {
  const style = (el: HTMLElement | SVGElement, property: string, value: string) => {
    if (el.style.getPropertyValue(property) !== value) el.style.setProperty(property, value);
  };
  const text = (el: Element, value: string) => { if (el.textContent !== value) el.textContent = value; };
  const attr = (el: Element, name: string, value: string) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };
  const all = <E extends Element = HTMLElement>(el: ParentNode, selector: string) => [...el.querySelectorAll<E>(selector)];
  const parts = (el: HTMLElement, name: string): Part[] => all(el, `[data-${name}]`).map(part => {
    const [a, b] = part.dataset[name]!.split(",").map(Number);
    return { el: part, a, b };
  });
  const views = all(root, "[data-widget]").map(el => {
    const host = el.closest<HTMLElement>("[data-message]")!;
    return {
      el, id: el.dataset.widget!, phase: "",
      message: messages.find(message => message.id === host.dataset.message)!,
      outcome: !!el.closest("[data-outcome]"),
      // The widget builds up once the words above it have been typed.
      words: all(host, "[data-word]").filter(word => word.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).length,
      ins: parts(el, "in"), draws: parts(el, "draw"), pops: parts(el, "pop"), fades: parts(el, "fade"),
      grows: parts(el, "grow"), rises: parts(el, "rise"), counts: parts(el, "count"),
    };
  });
  type View = typeof views[number];
  const view = (id: string) => views.find(item => item.id === id);
  const userChecks = new Map<number, boolean>();
  const userTabs = new Map<string, number>();
  let frozen: boolean[] | null = null;
  const game = mountGame(root, changed, signal);
  const gameView = view("game"), listView = view("list"), summaryView = view("summary");
  const gameStart = gameView ? gameView.message.at + 30 : Infinity;
  const tabAt = summaryView ? summaryView.message.at + 130 : Infinity;
  const yes = (state: DemoState, action?: string) => !!action && state.decisions[action as keyof DemoState["decisions"]]?.value === "yes";

  function startOf(item: View, state: DemoState): number {
    const { message } = item;
    if (message.when && !yes(state, message.when)) return Infinity;
    if (!item.outcome) return message.at + 8 + item.words * FPS / 25;
    const decision = message.action && state.decisions[message.action];
    return decision && decision.value === "yes" ? decision.at + 28 : Infinity;
  }
  // The entrance every widget shares; `t` is frames since the widget's start.
  function stage(item: View, t: number) {
    const phase = t < 0 ? "before" : t > 170 ? "after" : "live";
    if (phase !== "live" && phase === item.phase) return;
    item.phase = phase;
    for (const { el, a } of item.ins) {
      const y = (1 - easeOut(t, a * 4, a * 4 + 20)) * 8;
      style(el, "opacity", num(easeOut(t, a * 4, a * 4 + 14)));
      style(el, "transform", y < .02 ? "none" : `translateY(calc(${num(y)} * var(--vp)))`);
    }
    for (const { el, a, b } of item.draws) style(el, "stroke-dashoffset", num(1 - ramp(t, a, b)));
    for (const { el, a } of item.fades) style(el, "opacity", num(easeOut(t, a, a + 16)));
    for (const { el, a } of item.grows) style(el, "transform", `scaleX(${num(easeOut(t, a, a + 26))})`);
    for (const { el, a } of item.rises) style(el, "transform", `scaleY(${num(Math.max(0, t === Infinity ? 1 : springAt(t, a, "settle")))})`);
    const [draw] = item.draws;
    for (const { el, a } of item.pops) {
      const at = draw.a + rampTime(a) * (draw.b - draw.a) - 2;
      style(el, "opacity", num(easeOut(t, at, at + 8)));
      style(el, "transform", `scale(${num(.5 + .5 * (t === Infinity ? 1 : springAt(t, at, "land")))})`);
    }
    for (const { el, a } of item.counts) {
      const value = Math.round(a * easeOut(t, 6, 50));
      text(el, `$${value.toLocaleString(lang === "ru" ? "ru-RU" : "en-US").replace(/\s/g, " ")}`);
    }
  }

  const checked = (state: DemoState, f: number) => all(listView?.el ?? root, "[data-check]").map((_, i) =>
    userChecks.get(i) ?? ((listStruck as readonly number[]).includes(i) && f >= widgetFrames.strike[listStruck.indexOf(i as 2 | 4)] && yes(state, "shopping")));
  function tabs(item: View, tab: number) {
    all(item.el, "[data-tab]").forEach((button, i) => attr(button, "aria-pressed", String(i === tab)));
    all(item.el, "[data-pane]").forEach((pane, i) => {
      pane.toggleAttribute("data-off", i !== tab);
      pane.inert = i !== tab;
    });
  }
  function route(item: View, t: number, f: number, start: number) {
    const el = item.el;
    const waitFrom = start + 16, waitTo = Math.max(waitFrom + 60, widgetFrames.game - 70), rideTo = T(2760) - 60;
    const waited = clamp01((f - waitFrom) / (waitTo - waitFrom)), ridden = ramp(f, waitTo + 20, rideTo);
    const phase = f < waitTo ? "wait" : f < rideTo ? "ride" : "done";
    const spot = phase === "wait" ? along(routePaths.approach, waited) : along(routePaths.trip, ridden);
    const car = el.querySelector<SVGGElement>("[data-car]")!;
    attr(car, "transform", `translate(${num(spot.x)} ${num(spot.y)})`);
    attr(car.querySelector("[data-car-body]")!, "transform", `rotate(${num(spot.angle)})`);
    attr(car.querySelector("[data-car-halo]")!, "r", num(phase === "wait" ? 11 + 3 * (.5 + .5 * Math.sin(f / 9)) : 11));
    style(car, "opacity", num(easeOut(t, 10, 24)));
    style(el.querySelector<SVGElement>("[data-approach]")!, "opacity", num(easeOut(t, 4, 20) * (1 - easeOut(f, waitTo, waitTo + 20))));
    const label = el.querySelector<HTMLElement>("[data-eta-label]")!, value = el.querySelector<HTMLElement>("[data-eta]")!;
    text(label, label.dataset[phase]!);
    const seconds = Math.ceil(60 * (1 - waited));
    text(value, phase === "wait" ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : phase === "ride" ? `${Math.ceil(35 * (1 - ridden))} ${value.dataset.min}` : value.dataset.done!);
    value.classList.toggle("is-done", phase === "done");
    style(el.querySelector<HTMLElement>("[data-eta-bar]")!, "transform", `scaleX(${num(phase === "wait" ? waited : phase === "ride" ? ridden : 1)})`);
  }
  function list(item: View, ticks: boolean[]) {
    all(item.el, "[data-check]").forEach((button, i) => attr(button, "aria-pressed", String(ticks[i])));
    text(item.el.querySelector("[data-list-left]")!, String(ticks.filter(tick => !tick).length));
  }
  function order(item: View, ticks: boolean[], { f, reduced, state }: WidgetFrame) {
    const el = item.el, decision = state.decisions.order;
    // The basket is what was still unticked when the order was placed.
    frozen = decision?.value === "yes" ? frozen ?? ticks : null;
    const basket = frozen ?? ticks;
    let total = 0;
    all(el, "[data-order-item]").forEach((row, i) => {
      row.hidden = basket[i];
      if (!basket[i]) total += Number(row.dataset.price);
    });
    text(el.querySelector("[data-order-total]")!, `$${total}`);
    const paidAt = decision?.value === "yes" ? decision.at + 40 : Infinity;
    const status = !decision || decision.value !== "yes" ? "cart" : f < paidAt && !reduced ? "paying" : "paid";
    const chip = el.querySelector<HTMLElement>("[data-order-state]")!;
    attr(chip, "data-state", status);
    text(chip.lastElementChild!, chip.dataset[status]!);
    el.querySelector<HTMLElement>("[data-order-number]")!.hidden = status !== "paid";
    const since = (f - paidAt) / FPS, burst = !reduced && since >= 0 && since < 1.2;
    all(el, "[data-confetti] i").forEach((piece, i) => {
      if (!burst) { style(piece, "opacity", "0"); return; }
      const r = (n: number) => { const v = Math.sin((i + 1) * 12.9898 * n) * 43758.5453; return v - Math.floor(v); };
      const vx = -(30 + 230 * r(1)) * (r(3) < .2 ? -.3 : 1), vy = -(50 + 170 * r(2));
      style(piece, "background", ["#a4dc55", "#62a2dc", "#ffd257", "#ffffff", "#86c140"][i % 5]);
      style(piece, "transform", `translate(calc(${num(292 + vx * since)} * var(--vp)), calc(${num(22 + vy * since + 260 * since * since)} * var(--vp)))`);
      style(piece, "opacity", num(1 - clamp01((since - .7) / .5)));
    });
  }

  root.addEventListener("click", event => {
    const target = event.target as Element;
    const check = target.closest<HTMLElement>("[data-check]");
    if (check) userChecks.set(Number(check.dataset.check), check.getAttribute("aria-pressed") !== "true");
    const tab = target.closest<HTMLElement>("[data-tab]");
    if (tab) userTabs.set(tab.closest<HTMLElement>("[data-widget]")!.dataset.widget!, Number(tab.dataset.tab));
    if (check || tab) changed();
  }, { signal });

  return {
    // The visitor is playing: the film waits.
    holding: () => !!game?.holding(),
    render(frame: WidgetFrame) {
      const { f, reduced, state } = frame;
      const ticks = checked(state, f);
      for (const item of views) {
        const start = startOf(item, state);
        const t = start === Infinity ? -Infinity : reduced ? Infinity : f - start;
        stage(item, t);
        if (start === Infinity) continue;
        if (item.id === "route") route(item, t, f, start);
        if (item.id === "list") list(item, ticks);
        if (item.id === "order") order(item, ticks, frame);
        if (item.id === "day") tabs(item, userTabs.get("day") ?? 0);
        if (item.id === "summary") tabs(item, userTabs.get("summary") ?? (!reduced && f >= tabAt ? 1 : 0));
        if (item.id === "game") game?.render(f - gameStart);
      }
    },
    // Taps the film makes itself, each with the frame of the touch.
    ghosts({ f, reduced, state }: WidgetFrame): { at: number; el: Element }[] {
      const taps: { at: number; el: Element }[] = [];
      if (reduced) return taps;
      if (listView && yes(state, "shopping")) {
        listStruck.forEach((index, i) => {
          if (!userChecks.has(index)) taps.push({ at: widgetFrames.strike[i], el: listView.el.querySelector(`[data-check="${index}"] > i`)! });
        });
      }
      if (game && gameView && !game.live() && yes(state, "taxi")) for (const tap of game.taps) taps.push({ at: gameStart + tap, el: game.canvas });
      if (summaryView && !userTabs.has("summary") && f < tabAt + 60) taps.push({ at: tabAt, el: summaryView.el.querySelector('[data-tab="1"]')! });
      return taps;
    },
    reset() {
      userChecks.clear();
      userTabs.clear();
      frozen = null;
      game?.reset();
      for (const item of views) item.phase = "";
    },
  };
}
