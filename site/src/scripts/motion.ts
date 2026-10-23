// Page motion: reveal on scroll (pixel glitch, CSS), the hero chat sequence and copy buttons.
// Text never moves; only pixels, photos, plates, icons, buttons and the chat inside the phone.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ru = document.documentElement.lang === "ru";
// Hover glitches only where a real pointer hovers (no sticky hover on touch).
if (matchMedia("(hover: hover) and (pointer: fine)").matches)
  document.documentElement.classList.add("can-hover");

const reveal = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
if (still || !("IntersectionObserver" in window))
  reveal.forEach((el) => el.classList.add("is-in"));
else {
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }),
    { rootMargin: "0px 0px -12% 0px", threshold: 0.2 },
  );
  reveal.forEach((el) => io.observe(el));
}

// Hero chat: the film's order (STYLE.md §10). Each step arrives on the "arrive" spring;
// the header shows «печатает» while the draft «Думаю…» is up, then the reply replaces it.
const chat = document.querySelector<HTMLElement>("[data-chat]");
if (chat) {
  const step = (n: number) =>
    chat.querySelector<HTMLElement>(`[data-step="${n}"]`)!;
  const finish = () => chat.classList.add("is-done");
  if (still) finish();
  else {
    chat.classList.add("is-playing");
    const plan: [number, () => void][] = [
      [450, () => step(1).classList.add("is-in")],
      [1900, () => step(2).classList.add("is-in")],
      [3300, () => step(3).classList.add("is-in")],
      [4300, () => (chat.classList.add("is-typing"), step(4).classList.add("is-in"))],
      [
        5900,
        () => {
          step(4).classList.remove("is-in");
          step(5).classList.add("is-in");
          chat.classList.remove("is-typing");
        },
      ],
      [6900, finish],
    ];
    const start = () => plan.forEach(([at, fn]) => setTimeout(fn, at));
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      start();
    });
    io.observe(chat);
  }
}

// Copy the install phrase or command; on failure select it so it can be copied by hand.
const timers = new WeakMap<HTMLElement, number>();
document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) =>
  button.addEventListener("click", async () => {
    const text = button.dataset.copy!;
    const isPrompt = text.includes("install.txt");
    const status =
      button
        .closest(".hero-cta, .final")
        ?.querySelector<HTMLElement>("[data-copy-status]") ?? null;
    let message: string;
    try {
      await navigator.clipboard.writeText(text);
      message = isPrompt
        ? ru
          ? "Скопировано. Вставьте фразу в своего ИИ-агента."
          : "Copied. Paste it into your AI agent."
        : ru
          ? "Скопировано."
          : "Copied.";
      window.dispatchEvent(
        new CustomEvent("iva:analytics", {
          detail: { name: isPrompt ? "copy_prompt" : "copy_command" },
        }),
      );
    } catch {
      const code = [...document.querySelectorAll("code")].find(
        (el) => el.textContent === text,
      );
      if (code) {
        code.closest("details")?.setAttribute("open", "");
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        code.scrollIntoView({ block: "center" });
      }
      message = ru
        ? "Не удалось скопировать. Выделите текст и скопируйте вручную."
        : "Could not copy. Select the text and copy it manually.";
    }
    if (!status) return;
    clearTimeout(timers.get(status));
    status.textContent = message;
    timers.set(
      status,
      window.setTimeout(() => (status.textContent = ""), 4000),
    );
  }),
);

document.querySelectorAll("[data-install-guide]").forEach((link) =>
  link.addEventListener("click", () =>
    window.dispatchEvent(
      new CustomEvent("iva:analytics", {
        detail: { name: "open_install_guide" },
      }),
    ),
  ),
);
