import { actionFrames, demoCopy, demoMessages, demoProviders, demoMenuEntries, demoMenuInfo, demoMenuCopy, type DemoProvider, type DemoMenuEntry, type ActionId, type DemoLang } from "../data/demo.ts";
import {
  DEMO_FRAMES, FPS, actions, advance, choose, clamp01, clockAt, demoFrame,
  easeOut, filmFrame, freshDemo, type Choice, freshInteractions, menuCommand, selectInstallFromButton, beginInstallCopy, finishInstallCopy, replayInteractions, mariaAt, sceneAt, sceneFrames, springAt, swapAt, tapPhase,
} from "./demo-state.ts";

export function mountDemos() {
  document.querySelectorAll<HTMLElement>("[data-demo]").forEach(mountDemo);
}
function mountDemo(root: HTMLElement) {
  if (root.dataset.mounted) return;
  root.dataset.mounted = "true";
  const lang: DemoLang = root.dataset.lang === "ru" ? "ru" : "en";
  const copy = demoCopy[lang];
  const messages = demoMessages(lang);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const iva = get('[data-screen="iva"]');
  const maria = get('[data-screen="maria"]');
  const view = get('[data-viewport="iva"]');
  const mariaView = get('[data-viewport="maria"]');
  const play = get<HTMLButtonElement>("[data-play]");
  const replay = get<HTMLButtonElement>("[data-replay]");
  const playLabel = get("[data-play-label]");
  const icon = root.querySelector<SVGPathElement>("[data-play-icon] path")!;
  const sceneLabel = get("[data-scene]");
  const photo = root.querySelector<HTMLImageElement>("[data-photo]");
  const announcement = get("[data-announcement]");
  const clock = get("[data-demo-clock]");
  const tap = get("[data-tap]");
  const venue = get("[data-venue]");
  const dim = get("[data-dim]");
  const dots = [...iva.querySelectorAll<HTMLElement>("[data-typing] i")];
  const buttonRows = new Map(actions.map(id => [id, get(`[data-action="${id}"]`)]));
  const refs = messages.map(message => {
    const el = get(`[data-message="${message.id}"]`);
    const body = el.querySelector<HTMLElement>("[data-arrival-body]")!;
    return {
      message, el, body,
      think: root.querySelector<HTMLElement>(`[data-think="${message.id}"]`),
      words: [...el.querySelectorAll<HTMLElement>("[data-word]")],
      after: el.querySelector<HTMLElement>("[data-after-index]"),
      buttons: [...el.querySelectorAll<HTMLButtonElement>("[data-choice]")],
    };
  });
  let state = freshDemo();
  let interaction = freshInteractions(lang);
  const menuEntry = get("[data-demo-menu]");
  const endCta = get("[data-end-cta]");
  let menuShown = false;
  let menuSignature = "";
  let menuReturnFocus: HTMLElement | null = null;
  let copiedPhrase = "";
  let reduced = motion.matches;
  let userPaused = false;
  let focusPaused = false;
  let inView = true;
  let raf = 0;
  let lastTime: number | null = null;
  let previousScene = -1;
  let disposed = false;
  let suspended = false;
  const abort = new AbortController();
  const on = { signal: abort.signal };
  // The page opening (Home.astro) runs first; the story starts once the phone has landed.
  let introHold = ["play", "fly", "land"].includes(document.documentElement.dataset.intro ?? "");
  if (introHold) {
    const release = () => { if (introHold) { introHold = false; sync(); } };
    window.addEventListener("iva:intro-done", release, { once: true });
    window.setTimeout(release, 8000);
  }
  const playing = () => !disposed && !suspended && !introHold && interaction.menu === null && !reduced && !userPaused && !focusPaused && !document.hidden && inView && state.frame < DEMO_FRAMES;
  const setText = (el: Element, value: string) => {
    if (el.textContent !== value) el.textContent = value;
  };
  const style = (el: HTMLElement, property: string, value: string) => {
    if (el.style.getPropertyValue(property) !== value) el.style.setProperty(property, value);
  };
  function arrival(el: HTMLElement, f: number, at: number) {
    const visible = f >= at;
    el.hidden = !visible;
    if (!visible) return;
    const grow = reduced ? 1 : springAt(f, at, "arrive");
    const vis = reduced ? 1 : easeOut(f, at, at + 14);
    const rise = reduced ? 0 : 1 - springAt(f, at + 2, "land");
    style(el, "grid-template-rows", `${Math.max(0, grow)}fr`);
    const body = el.querySelector<HTMLElement>(".v7-arrival-body")!;
    style(body, "opacity", String(vis));
    style(body, "filter", vis < 1 ? `blur(calc(${(1 - vis) * 4} * var(--vp)))` : "none");
    style(body, "transform", Math.abs(rise * 18) < .02 ? "none" : `translateY(calc(${rise * 18} * var(--vp)))`);
  }
  function render() {
    const f = filmFrame(state.frame);
    // The post's photo starts loading a scene ahead, so it is already there when the message arrives.
    if (photo && f >= 5200) photo.loading = "eager";
    let thinking: { start: number; end: number } | undefined;
    for (const ref of refs) {
      const { message, el, think, words, after, buttons } = ref;
      el.inert = interaction.menu !== null;
      if (think) think.inert = interaction.menu !== null;
      arrival(el, f, message.at);
      if (think && message.think !== undefined) {
        arrival(think, f, message.think);
        if (f >= message.think) {
          const swap = swapAt(f, message.at - 6);
          if (f >= message.at + 90) think.hidden = true;
          else {
            const collapse = think.firstElementChild as HTMLElement;
            style(collapse, "opacity", String(swap.a * (.86 + .14 * Math.cos(2 * Math.PI * (f - message.think) / 54))));
            style(think, "grid-template-rows", `${1 - swap.k}fr`);
          }
        }
        if (f >= message.think && f < message.at) thinking = { start: message.think, end: message.at };
      }
      if (el.hidden) continue;
      const limit = reduced ? Infinity : Math.max(0, (f - message.at - 6) * 25 / FPS);
      for (const word of words) style(word, "opacity", String(clamp01((limit - Number(word.dataset.word)) / 3)));
      if (after) style(after, "opacity", String(clamp01((limit - Number(after.dataset.afterIndex)) / 6)));
      if (!message.action) continue;
      const id = message.action;
      const row = buttonRows.get(id)!;
      const decision = state.decisions[id];
      const swapStart = id === "restaurant" && decision?.value === "yes" ? decision.at + 138 : decision ? decision.at + 18 : Infinity;
      const swap = reduced && decision && !(id === "restaurant" && decision.value === "yes" && !mariaAt(state).confirmed)
        ? { k: 1, a: 0, b: 1 } : swapAt(f, swapStart);
      const before = row.querySelector<HTMLElement>("[data-before]")!;
      const afterSwap = row.querySelector<HTMLElement>("[data-after]")!;
      before.hidden = swap.k >= .9999;
      style(before, "grid-template-rows", `${1 - swap.k}fr`);
      style(before, "opacity", String(swap.a));
      afterSwap.hidden = !decision || f < swapStart && !reduced;
      style(afterSwap, "grid-template-rows", `${swap.k}fr`);
      style(afterSwap, "opacity", String(swap.b));
      row.dataset.decision = decision?.value ?? "";
      if (decision) for (const outcome of row.querySelectorAll<HTMLElement>("[data-outcome]")) outcome.hidden = outcome.dataset.outcome !== decision.value;
      const pressStart = decision ? decision.at - 12 : actionFrames[id];
      const phase = reduced ? { pressed: 0 } : tapPhase(f, pressStart);
      for (const button of buttons) {
        button.disabled = !!decision || limit < Number(after?.dataset.afterIndex ?? 0) + 6;
        const selected = button.dataset.choice === (decision?.value ?? "yes");
        const pressed = selected ? phase.pressed : 0;
        style(button, "transform", `scale(${1 - .03 * pressed},${1 - .06 * pressed})`);
        const primary = button.dataset.choice === "yes";
        style(button, "background", pressed > .5 ? primary ? "#0473d6" : "#d5d4d8" : primary ? "#0589ff" : "#e7e6e9");
      }
    }
    const pushed = mariaAt(state);
    const p = interaction.menu !== null ? 0 : reduced ? pushed.p > .5 ? 1 : 0 : pushed.p;
    style(iva, "transform", `translateX(${-30 * p}%)`);
    style(maria, "transform", `translateX(${100 * (1 - p)}%)`);
    style(maria, "box-shadow", p > 0 && p < 1 ? `calc(-6 * var(--vp)) 0 calc(18 * var(--vp)) rgba(10,20,16,${.22 * (1-p)})` : "none");
    style(dim, "opacity", String(.18 * p));
    const mariaActive = p > .5;
    iva.inert = mariaActive;
    iva.setAttribute("aria-hidden", String(mariaActive));
    maria.inert = !mariaActive;
    maria.setAttribute("aria-hidden", String(!mariaActive));
    const share = state.decisions.restaurant;
    // No restaurant choice means no delivery, including in the hidden transcript.
    arrival(venue, f, share?.value === "yes" ? share.at + 78 : Infinity);
    setText(get('[data-message-time="restaurant"]'), pushed.confirmed ? "17:42" : "17:41");
    iva.classList.toggle("is-thinking", !!thinking);
    get("[data-bot]").hidden = !!thinking;
    get("[data-typing]").hidden = !thinking;
    get("[data-mic]").toggleAttribute("hidden", !!thinking);
    get("[data-stop]").hidden = !thinking;
    if (thinking) {
      const phase = ((f - thinking.start) / 54) % 1;
      dots.forEach((dot, i) => {
        const local = ((phase * 3 - i) % 3 + 3) % 3;
        style(dot, "opacity", String(.35 + .65 * Math.max(0, Math.sin(Math.PI * Math.min(local, 1.5) / 1.5))));
      });
    }
    // Install reveal/copy feedback and menu edits change the feed's height.
    // Commit them before measuring the bottom, including the final reduced-motion step.
    renderMenu();
    renderInstall();
    setText(clock, clockAt(f));
    // Match List's bottom anchoring: growing message height moves earlier messages upward.
    // Pausing gives the reader a normal, keyboard-accessible scrollable transcript.
    if (interaction.menu === null && (!userPaused && !focusPaused || reduced)) {
      view.scrollTop = view.scrollHeight;
      mariaView.scrollTop = mariaView.scrollHeight;
    }
    tap.hidden = true;
    if (!reduced && !mariaActive && interaction.menu === null) {
      for (const id of actions) {
        const decision = state.decisions[id];
        const phase = tapPhase(f, decision ? decision.at - 12 : actionFrames[id]);
        if (phase.opacity <= .001 || phase.d <= 1) continue;
        const button = buttonRows.get(id)!.querySelector<HTMLElement>(`[data-choice="${decision?.value ?? "yes"}"]`)!;
        const targetBox = button.getBoundingClientRect();
        const screenBox = iva.parentElement!.getBoundingClientRect();
        const scale = screenBox.width / 402;
        const d = phase.d * scale;
        tap.hidden = false;
        style(tap, "left", `${targetBox.left - screenBox.left + targetBox.width / 2 - d / 2}px`);
        style(tap, "top", `${targetBox.top - screenBox.top + targetBox.height / 2 - d / 2}px`);
        style(tap, "width", `${d}px`);
        style(tap, "height", `${d}px`);
        style(tap, "opacity", String(phase.opacity));
        break;
      }
    }
    const complete = state.frame >= DEMO_FRAMES;
    const isPlaying = playing();
    root.dataset.state = interaction.menu !== null ? "paused" : complete ? "complete" : isPlaying ? "playing" : "paused";
    const filmScene = sceneAt(f);
    // Maria's chat is its own scene while it is open, and only then.
    const scene = mariaActive ? 9 : filmScene === 9 ? 8 : filmScene;
    root.dataset.sceneNumber = String(scene);
    if (scene !== previousScene) {
      setText(sceneLabel, copy.scenes[scene]);
      previousScene = scene;
    }
    const controlLabel = complete ? copy.viewed : reduced ? copy.next : isPlaying ? copy.pause : copy.play;
    setText(playLabel, controlLabel);
    play.hidden = !reduced || complete;
    play.disabled = complete || interaction.menu !== null;
    play.setAttribute("aria-label", controlLabel);
    icon.setAttribute("d", complete ? "M2 8l4 4 8-8" : reduced ? "M3 3l7 5-7 5M12 3v10" : isPlaying ? "M5 3v10M11 3v10" : "M4 2.5l9 5.5L4 13.5Z");
    if (complete && root.dataset.announcedComplete !== "true") {
      setText(announcement, copy.end);
      root.dataset.announcedComplete = "true";
    }
  }

  function renderMenu() {
    const signature = JSON.stringify([interaction.menu, interaction.language, interaction.provider, interaction.model, interaction.browsing, interaction.pending, interaction.writes, interaction.restarted, interaction.menuSeen, interaction.copy]);
    if (signature === menuSignature) return;
    menuSignature = signature;
    const language = interaction.language;
    const text = demoMenuCopy[language];
    const opened = interaction.menu !== null;
    const readOnly = interaction.menu !== null && (Object.hasOwn(demoMenuInfo, interaction.menu) || interaction.menu === "status");
    const hint = interaction.menu === null ? copy.hint
      : interaction.menu === "restart" ? text.restartNote
      : interaction.restarted ? text.restarted
      : interaction.menu === "language" ? text.languageNote
      : readOnly ? text.preview : text.demo;
    setText(get("[data-demo-hint]"), hint);
    menuEntry.hidden = !menuShown;
    root.dataset.menu = interaction.menu ?? "closed";
    root.dataset.menuSeen = String(interaction.menuSeen);
    get("[data-menu-cue]").toggleAttribute("hidden", interaction.menuSeen);
    get("[data-menu-install-footer]").hidden = interaction.menu !== "root" && interaction.copy === "idle";
    get("button[data-menu-install]").hidden = interaction.menu !== "root";
    root.dataset.model = interaction.model;
    root.dataset.provider = interaction.provider;
    root.dataset.writes = String(interaction.writes);
    root.dataset.menuLanguage = language;
    root.querySelectorAll<HTMLButtonElement>("[data-demo-menu-open]").forEach(button => {
      button.setAttribute("aria-expanded", String(opened));
      button.setAttribute("aria-label", text.open);
    });
    const title = get("[data-menu-title]");
    const description = get("[data-menu-description]");
    const keyboard = get("[data-menu-keyboard]");
     description.replaceChildren();
    keyboard.replaceChildren();
    keyboard.classList.toggle("is-root", interaction.menu === "root");
     const line = (value: string) => {
      const p = document.createElement("p"); p.textContent = value; description.append(p);
    };
    const button = (label: string, action: string, selected?: boolean) => {
      const node = document.createElement("button");
      node.type = "button"; node.textContent = label; node.dataset.menuAction = action;
      if (selected !== undefined) node.setAttribute("aria-pressed", String(selected));
      keyboard.append(node);
    };
    const current = `${text.now}: ${demoProviders[interaction.provider][language]} · ${interaction.model}`;
    if (interaction.menu === null) {
      setText(title, text.closed);
      line(current);
      return;
    }
    const page = interaction.menu;
    setText(title, page === "root" ? text.settings
      : page === "models" || page === "restart" ? demoMenuEntries.model[language]
      : demoMenuEntries[page][language]);
    if (page === "root") {
      for (const id of Object.keys(demoMenuEntries) as DemoMenuEntry[]) button(demoMenuEntries[id][language], `root:${id}`);
    } else if (page === "model") {
      line(current);
       line(text.provider);
      for (const id of Object.keys(demoProviders) as DemoProvider[]) {
        const selected = interaction.provider === id;
        button(`${selected ? "✓ " : ""}${demoProviders[id][language]}`, `provider:${id}`, selected);
      }
    } else if (page === "models") {
      const models: readonly string[] = demoProviders[interaction.browsing].models;
      line(demoProviders[interaction.browsing][language]);
      line(models.length ? text.chooseModel : text.customModels);
      for (const model of models) {
        const selected = interaction.provider === interaction.browsing && interaction.model === model;
        button(`${selected ? "✓ " : ""}${model}`, `model:${model}`, selected);
      }
    } else if (page === "restart") {
      line(interaction.pending?.model ?? interaction.model);
      line(text.restart);
       button(text.restartButton, "restart:yes");
    } else if (page === "notices") {
      line(text.notices);
      button(`${interaction.writes ? "✓" : "○"} ${text.writes} · ${interaction.writes ? text.on : text.off}`, `notices:${interaction.writes ? "0" : "1"}`, interaction.writes);
    } else if (page === "language") {
       button(`Русский${language === "ru" ? " ✓" : ""}`, "language:ru", language === "ru");
      button(`English${language === "en" ? " ✓" : ""}`, "language:en", language === "en");
    } else if (page === "status") {
      line(current);
      line(`${text.writes}: ${interaction.writes ? text.on : text.off}`);
      line(`${text.language}: ${language === "ru" ? "Русский" : "English"}`);
     } else {
      const info = demoMenuInfo[page];
      if (info) line(info[language]);
     }
    if (page !== "root") button(text.back, "back");
    button(text.close, "close");
  }

  function renderCopyFeedback(container: HTMLElement, includeDecline: boolean) {
    const text = demoMenuCopy[interaction.language];
    const response = container.querySelector<HTMLElement>("[data-copy-response]")!;
    response.hidden = interaction.install === null || interaction.copy === "pending" || !includeDecline && interaction.install === false;
    setText(response, interaction.install ? text.installNext : text.installLater);
    const status = container.querySelector<HTMLElement>("[data-copy-status]")!;
    status.hidden = interaction.install !== true;
    setText(status, interaction.copy === "pending" ? text.copyPending : interaction.copy === "copied" ? text.copied : text.copyDenied);
    const fallback = container.querySelector<HTMLElement>("[data-copy-phrase]")!;
    fallback.hidden = interaction.copy !== "denied";
    setText(fallback, copiedPhrase || (interaction.language === "ru" ? endCta.dataset.copyRu! : endCta.dataset.copyEn!));
  }
  function renderInstall() {
    const complete = state.frame >= DEMO_FRAMES;
    endCta.hidden = !complete;
    endCta.inert = interaction.menu !== null;
    const text = demoMenuCopy[interaction.language];
    const installPhrase = interaction.language === "ru" ? endCta.dataset.copyRu! : endCta.dataset.copyEn!;
    const menuInstall = get<HTMLButtonElement>("button[data-menu-install]");
    setText(menuInstall, text.installIva);
    menuInstall.dataset.copy = installPhrase;
    menuInstall.disabled = interaction.copy === "pending";
    renderCopyFeedback(menuEntry, false);
    root.dataset.installChoice = interaction.install === null ? "" : interaction.install ? "yes" : "no";
    root.dataset.copyState = interaction.copy;
    if (!complete) return;
    const yes = get<HTMLButtonElement>('button[data-install-choice="yes"]');
    const no = get<HTMLButtonElement>('button[data-install-choice="no"]');
    setText(get("[data-install-question]"), text.install);
    setText(yes, text.yes); yes.dataset.copy = installPhrase;
    setText(no, text.no);
    get("[data-install-buttons]").hidden = interaction.install !== null;
    renderCopyFeedback(endCta, true);
  }
  function openMenu(trigger: HTMLElement, toggle = false) {
    menuCommand(interaction, toggle ? "toggle" : "open");
    if (interaction.menu === null) {
      sync();
      restoreMenuFocus();
      return;
    }
    menuShown = true;
    menuReturnFocus = trigger;
    const feed = view.querySelector<HTMLElement>(".v7-feed")!;
    const last = [...feed.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== menuEntry && !node.hidden).at(-1);
    if (last) last.after(menuEntry);
    sync();
    view.scrollTop = menuEntry.offsetTop;
    get<HTMLButtonElement>("[data-menu-keyboard] button").focus({ preventScroll: true });
  }
  function closeMenu() {
    menuCommand(interaction, "close");
    sync();
    restoreMenuFocus();
  }
  function restoreMenuFocus() {
    const target = menuReturnFocus && !menuReturnFocus.closest("[inert]")
      ? menuReturnFocus : root.querySelector<HTMLElement>('[data-screen]:not([inert]) [data-demo-menu-open]');
    target?.focus({ preventScroll: true });
  }

  function schedule() {
    if (!playing() || raf) return;
    raf = requestAnimationFrame(tick);
  }
  function tick(now: number) {
    raf = 0;
    if (!playing()) { lastTime = null; render(); return; }
    if (lastTime !== null) advance(state, state.frame + (now - lastTime) / 1000 * FPS);
    lastTime = now;
    render();
    schedule();
  }
  function sync() {
    cancelAnimationFrame(raf);
    raf = 0;
    lastTime = null;
    render();
    schedule();
  }
  function nextScene() {
    const f = filmFrame(state.frame);
    // Manual reduced-motion playback settles pending choices before moving on.
    for (const id of actions) {
      if (!state.decisions[id] && f >= actionFrames[id] - 20) choose(state, id, "yes", "auto");
    }
    let next = sceneFrames.find(at => at > f + 10);
    if (next === 3470 && state.decisions.restaurant && state.decisions.restaurant.value !== "yes") next = 3780;
    advance(state, next === undefined ? DEMO_FRAMES : demoFrame(next), false);
    render();
  }

  root.addEventListener("click", event => {
    const target = event.target as Element;
    const opener = target.closest<HTMLElement>("[data-demo-menu-open]");
    if (opener) { openMenu(opener, true); return; }
    const menuInstall = target.closest<HTMLButtonElement>("button[data-menu-install]");
    if (menuInstall) {
      if (!beginInstallCopy(interaction)) return;
      copiedPhrase = "";
      sync();
      return;
    }
    const command = target.closest<HTMLButtonElement>("[data-menu-action]");
    if (command) {
      if (command.dataset.menuAction === "close") { closeMenu(); return; }
      if (!menuCommand(interaction, command.dataset.menuAction!)) return;
      sync();
      view.scrollTop = menuEntry.offsetTop;
      get<HTMLButtonElement>("[data-menu-keyboard] button").focus({ preventScroll: true });
      return;
    }
    const install = target.closest<HTMLButtonElement>("button[data-install-choice]");
    if (state.frame < DEMO_FRAMES || !selectInstallFromButton(interaction, install)) return;
    sync();
  }, on);
  root.addEventListener("iva:copy-result", event => {
    const target = event.target as Element;
    if (!target.closest('button[data-install-choice="yes"],button[data-menu-install]')) return;
    const result = (event as CustomEvent<{ ok: boolean; text: string }>).detail;
    if (!result || typeof result.ok !== "boolean" || !finishInstallCopy(interaction, result.ok)) return;
    copiedPhrase = result.text;
    sync();
    if (target.closest("button[data-menu-install]")) view.scrollTop = view.scrollHeight;
    setText(announcement, demoMenuCopy[interaction.language].installNext);
    if (!result.ok) get(target.closest("button[data-menu-install]") ? "[data-menu-copy-phrase]" : "[data-install-phrase]").focus({ preventScroll: true });
  }, on);
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || interaction.menu === null) return;
    event.preventDefault();
    closeMenu();
  }, on);
  document.addEventListener("click", event => {
    const opener = (event.target as Element).closest<HTMLElement>("[data-open-demo-menu]");
    if (!opener) return;
    openMenu(opener);
    root.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, on);

  root.addEventListener("click", event => {
    if (interaction.menu !== null) return;
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-choice]");
    if (!button || button.disabled) return;
    const row = button.closest<HTMLElement>("[data-action]")!;
    const id = row.dataset.action as ActionId;
    if (!choose(state, id, button.dataset.choice as Choice)) return;
    focusPaused = false;
    const decision = state.decisions[id]!;
    const choice: { accepted: string; declined: string; opened?: string } = copy.choices[id];
    setText(announcement, decision.value === "yes"
      ? id === "shopping" ? copy.shopping.map(item => item.text).join(", ") : choice.accepted
      : decision.value === "open" ? choice.opened ?? "" : choice.declined);
    if (reduced && id === "restaurant" && decision.value === "yes") advance(state, demoFrame(decision.at + 80), false);
    sync();
  }, on);
  root.addEventListener("focusin", event => {
    if (!(event.target as Element).closest("[data-choice]") || focusPaused) return;
    focusPaused = true;
    sync();
  }, on);
  root.addEventListener("focusout", event => {
    if (!(event.target as Element).closest("[data-choice]") || !focusPaused) return;
    queueMicrotask(() => {
      const nextPaused = !!root.querySelector("[data-choice]:enabled:focus");
      if (nextPaused === focusPaused) return;
      focusPaused = nextPaused;
      sync();
    });
  }, on);
  play.addEventListener("click", () => {
    if (reduced) nextScene();
    else {
      userPaused = !userPaused;
      focusPaused = false;
      sync();
    }
  }, on);
  replay.addEventListener("click", () => {
    state = freshDemo();
    interaction = replayInteractions(interaction);
    menuShown = false;
    menuSignature = "";
    menuEntry.hidden = true;
    copiedPhrase = "";
    userPaused = false;
    focusPaused = false;
    delete root.dataset.announcedComplete;
    setText(announcement, copy.scenes[0]);
    sync();
  }, on);
  document.addEventListener("visibilitychange", sync, on);
  motion.addEventListener("change", () => {
    reduced = motion.matches;
    sync();
  }, on);
  const observer = new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    sync();
  }, { threshold: .05 });
  observer.observe(root);
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    abort.abort();
  }
  window.addEventListener("pagehide", event => {
    if (!event.persisted) {
      dispose();
      return;
    }
    // BFCache keeps this DOM and its listeners: freeze the timeline without disposing it.
    suspended = true;
    sync();
  }, on);
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    suspended = false;
    sync();
  }, on);
  document.addEventListener("astro:before-swap", dispose, { once: true, signal: abort.signal });
  get("[data-controls]").hidden = false;
  sync();
}
