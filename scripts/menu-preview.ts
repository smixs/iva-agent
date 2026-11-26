// Сборщик превью нового меню /menu (T912): импортирует настоящие модули меню
// (scripts/lib/menu/*) и рендерер кнопок (scripts/lib/telegram-buttons.ts),
// прогоняет их в изолированной временной фикстуре и собирает одну самодостаточную
// HTML-страницу с интерактивным симулятором и карточками всех экранов.
//
// Запуск: node scripts/menu-preview.ts [--out <каталог>]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Lang = "ru" | "en";

interface ButtonSpec {
  text: string;
  callback_data?: string;
  style?: "danger" | "success" | "primary";
}

interface RenderedCard {
  id: string;
  section: string;
  badge: string;
  titleRu: string;
  titleEn: string;
  classicText: string;
  classicRows: ButtonSpec[][];
  richMarkdown: string;
  richHtml: string;
}

interface PreviewData {
  generatedFrom: string;
  rootCount: number;
  legacyCount: number;
  screens: Record<Lang, Record<string, RenderedCard>>;
  groups: ReadonlyArray<{
    sid: string;
    titleRu: string;
    titleEn: string;
    children: readonly string[];
  }>;
}

function parseOutDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  if (index >= 0 && typeof argv[index + 1] === "string") {
    return resolve(argv[index + 1]);
  }
  return resolve("docs/evidence/T912");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const RICH_BUTTON_RE = /<tg-button(?=[\s>])([^>]*)>([\s\S]*?)<\/tg-button>/gi;

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function richAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return match ? decodeAttribute(match[1]) : undefined;
}

function unescapeRichText(value: string): string {
  return value.replace(/\\([*_#|<])/g, "$1");
}

function renderRichButton(attrs: string, label: string): string | null {
  const text = label.replace(/<[^>]+>/g, "").trim();
  if (!text) return null;
  const data = richAttr(attrs, "data");
  const style = richAttr(attrs, "style");
  const styleClass =
    style === "danger" || style === "success" || style === "link"
      ? ` style-${style}`
      : "";
  const callback = data ? ` data-cb="${escapeHtml(data)}"` : "";
  return `<button type="button" class="tg-btn${styleClass}"${callback}>${escapeHtml(text)}</button>`;
}

function renderRichButtons(source: string): string {
  return [...source.matchAll(RICH_BUTTON_RE)]
    .map((match) => renderRichButton(match[1], match[2]))
    .filter((html): html is string => html !== null)
    .join("");
}

function renderRichMarkdownHtml(markdown: string): string {
  const html: string[] = [];
  for (const raw of markdown.split(/\n\n+/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^<tg-button-row\b/i.test(block)) {
      const lines = block.split("\n");
      const rowLine = lines[0].trim();
      const rowMatch =
        /^<tg-button-row\b[^>]*>([\s\S]*?)<\/tg-button-row>$/i.exec(rowLine);
      const buttons = renderRichButtons(rowMatch?.[1] ?? "");
      if (buttons) {
        html.push(
          `<div class="rich-buttons"><div class="tg-row">${buttons}</div></div>`,
        );
      }
      const caption = lines.slice(1).join("\n").trim();
      if (caption) {
        html.push(
          `<p>${escapeHtml(unescapeRichText(caption)).replaceAll("\n", "<br>")}</p>`,
        );
      }
      continue;
    }
    if (/^<tg-button(?=[\s>])/i.test(block)) {
      const buttons = renderRichButtons(block);
      if (buttons) {
        html.push(
          `<div class="rich-buttons"><div class="tg-row">${buttons}</div></div>`,
        );
      }
      const rest = unescapeRichText(block.replace(RICH_BUTTON_RE, "")).trim();
      if (rest) html.push(`<p>${escapeHtml(rest)}</p>`);
      continue;
    }
    if (/^#\s+/.test(block)) {
      html.push(
        `<div class="tg-title">${escapeHtml(block.replace(/^#+\s+/, ""))}</div>`,
      );
      continue;
    }
    const lines = block.split("\n");
    if (
      lines.length >= 2 &&
      lines[0].startsWith("|") &&
      lines[1].startsWith("| ---")
    ) {
      const header = lines[0]
        .slice(1, -1)
        .split("|")
        .map((cell) => `<th>${escapeHtml(cell.trim())}</th>`)
        .join("");
      const rows = lines
        .slice(2)
        .map((line) => {
          const cells = line
            .slice(1, -1)
            .split("|")
            .map(
              (cell) => `<td>${escapeHtml(unescapeRichText(cell.trim()))}</td>`,
            )
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      html.push(
        `<table class="tg-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`,
      );
      continue;
    }
    html.push(
      `<p>${escapeHtml(unescapeRichText(block)).replaceAll("\n", "<br>")}</p>`,
    );
  }
  return html.join("");
}

async function buildPreviewData(): Promise<PreviewData> {
  const work = mkdtempSync(join(tmpdir(), "iva-menu-preview-"));
  const homeDir = join(work, "home");
  const rootDir = join(work, "root");
  const dataDir = join(work, "data");
  const vaultDir = join(work, "vault");
  const envPath = join(rootDir, ".env");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(rootDir, ".eve"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });

  writeFileSync(join(rootDir, "package.json"), '{"version":"0.5.15"}\n');
  writeFileSync(
    envPath,
    [
      "MODEL_PROVIDER=claude",
      "CLAUDE_MODEL=claude-fable-5-2",
      "THINKING_EFFORT=medium",
      "SEARCH_PROVIDER=tavily",
      "TAVILY_API_KEY=preview-demo-key",
      "TELEGRAM_RICH_REPLIES=auto",
      "TELEGRAM_WIDGETS=auto",
      "DEEPGRAM_LANGUAGE=ru",
      "DEEPGRAM_KEYTERMS=Iva,Claude,Codex",
      "TELEGRAM_API_ID=123456",
      "TELEGRAM_API_HASH=preview-demo-hash",
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(vaultDir, "CORE.md"),
    "Owner: Product builder in Tashkent (UTC+5). Direct answers, concise plans, primary sources first.\n",
  );
  writeFileSync(
    join(rootDir, ".eve/agent-summary.json"),
    JSON.stringify({
      skills: [
        {
          name: "rich-replies",
          description: "Format tables, folds and interactive buttons",
        },
        {
          name: "widgets",
          description: "Render live interactive cards inside Telegram",
        },
        {
          name: "google-workspace",
          description: "Read and manage Gmail, Calendar, Drive and Tasks",
        },
        {
          name: "memory",
          description: "Search and update compiled truth cards in Vault",
        },
        {
          name: "reminders",
          description: "Schedule one-shot reminders and recurring routines",
        },
        {
          name: "colleagues",
          description: "Coordinate dedicated specialist colleague bots",
        },
      ],
    }),
  );
  writeFileSync(
    join(dataDir, "rollup-status.json"),
    JSON.stringify({
      "memory-night": { lastSuccessAt: Date.UTC(2026, 10, 26, 4, 0, 0) },
      proactive: { lastSuccessAt: Date.UTC(2026, 10, 26, 7, 30, 0) },
    }),
  );
  writeFileSync(
    join(dataDir, "tasks.json"),
    JSON.stringify([
      { text: "Review colleagues beta menu", done: false },
      { text: "Check weekly memory digest", done: false },
    ]),
  );

  const prevHome = process.env.HOME;
  const prevData = process.env.ASSISTANT_DATA_DIR;
  const prevVault = process.env.ASSISTANT_VAULT_DIR;
  process.env.HOME = homeDir;
  process.env.ASSISTANT_DATA_DIR = dataDir;
  process.env.ASSISTANT_VAULT_DIR = vaultDir;

  try {
    const { SCREENS } = await import("./lib/menu/index.ts");
    const { blockButtons, button, classicScreen } =
      await import("./lib/telegram-buttons.ts");
    const { modelIntroMarkdown, thinkingEffortMarkdown } =
      await import("./poller/wizards.ts");
    const { claudeReasoningLevels } =
      await import("./lib/claude-cli-status.ts");

    const writeFixtureSettings = (patch: Record<string, unknown>) => {
      writeFileSync(join(dataDir, "settings.json"), JSON.stringify(patch));
    };

    const groups = [
      {
        sid: "gm",
        titleRu: "🧠 Модель",
        titleEn: "🧠 Model",
        children: ["mdl", "thk", "srch", "turn"],
      },
      {
        sid: "gc",
        titleRu: "💬 Общение",
        titleEn: "💬 Chat",
        children: ["rich", "voice", "lang", "chr"],
      },
      {
        sid: "gmem",
        titleRu: "💾 Память",
        titleEn: "💾 Memory",
        children: ["core", "sk"],
      },
      {
        sid: "gcon",
        titleRu: "🔗 Подключения",
        titleEn: "🔗 Connections",
        children: ["gws", "ub", "col", "col_on"],
      },
      {
        sid: "gsch",
        titleRu: "⏰ Расписание",
        titleEn: "⏰ Schedule",
        children: ["cron", "ntc"],
      },
      {
        sid: "gsys",
        titleRu: "🛠 Система",
        titleEn: "🛠 System",
        children: ["st", "svc", "gsys_rich"],
      },
    ] as const;

    const screensByLang: Record<Lang, Record<string, RenderedCard>> = {
      ru: {},
      en: {},
    };

    for (const lang of ["ru", "en"] as const) {
      const tr = (en: string, ru: string) => (lang === "ru" ? ru : en);
      const makeCtx = () => ({
        lang,
        tr,
        getLang: () => lang,
        btn: (
          text: string,
          data: string,
          style?: "danger" | "success" | "link",
        ) => button(text, data, style),
        show: async () => {},
        backRow: (sid: string) => [
          button(
            sid === "r" ? tr("‹ Menu", "‹ Меню") : tr("‹ Back", "‹ Назад"),
            `iva_menu:${sid}:o`,
          ),
        ],
        flows: {
          get: () => null,
          screen: async () => {},
          end: async () => {},
        },
        deps: {
          root: rootDir,
          dataDir,
          envPath,
          sc: () => Promise.resolve(true),
          probeUserbotHealth: () =>
            Promise.resolve({ state: "off" as const, reason: "service_off" }),
        },
      });

      const capture = (
        id: string,
        section: string,
        badge: string,
        titleRu: string,
        titleEn: string,
        markdown: string,
      ) => {
        const classic = classicScreen(markdown);
        const richMarkdown = blockButtons(markdown);
        screensByLang[lang][id] = {
          id,
          section,
          badge,
          titleRu,
          titleEn,
          classicText: classic.text,
          classicRows: (classic.reply_markup?.inline_keyboard ?? []).map(
            (row) =>
              row.map((btn) => ({
                text: btn.text,
                ...(btn.callback_data
                  ? { callback_data: btn.callback_data }
                  : {}),
                ...(btn.style ? { style: btn.style } : {}),
              })),
          ),
          richMarkdown,
          richHtml: renderRichMarkdownHtml(richMarkdown),
        };
      };

      const renderReal = async (sid: keyof typeof SCREENS): Promise<string> => {
        const mod = SCREENS[sid] as {
          render: (
            state: Record<string, unknown>,
            ctx: ReturnType<typeof makeCtx>,
          ) => { text: string } | Promise<{ text: string }>;
        };
        const state = {
          flow: "menu",
          chatId: 100,
          userId: "42",
          screen: sid,
          page: 0,
          awaitText: null,
          data: {},
          msgId: 1,
        };
        const view = await mod.render(state, makeCtx());
        return view.text;
      };

      // Default settings: classic menu, colleagues off (default).
      writeFixtureSettings({ language: lang, menuStyle: "classic" });

      capture(
        "r",
        "root",
        "Стартовый экран",
        "⚙️ Настройки (/menu)",
        "⚙️ Settings (/menu)",
        await renderReal("r"),
      );
      capture(
        "gm",
        "gm",
        "Раздел 1/6",
        "🧠 Модель",
        "🧠 Model",
        await renderReal("gm"),
      );
      capture(
        "gc",
        "gc",
        "Раздел 2/6",
        "💬 Общение",
        "💬 Chat",
        await renderReal("gc"),
      );
      capture(
        "gmem",
        "gmem",
        "Раздел 3/6",
        "💾 Память",
        "💾 Memory",
        await renderReal("gmem"),
      );
      capture(
        "gcon",
        "gcon",
        "Раздел 4/6",
        "🔗 Подключения",
        "🔗 Connections",
        await renderReal("gcon"),
      );
      capture(
        "gsch",
        "gsch",
        "Раздел 5/6",
        "⏰ Расписание",
        "⏰ Schedule",
        await renderReal("gsch"),
      );
      capture(
        "gsys",
        "gsys",
        "Раздел 6/6",
        "🛠 Система",
        "🛠 System",
        await renderReal("gsys"),
      );

      // Rich-mode variant of System showing "◀︎ Старое меню".
      writeFixtureSettings({ language: lang, menuStyle: "rich" });
      capture(
        "gsys_rich",
        "gsys",
        "Rich-режим",
        "🛠 Система (выход в старое меню)",
        "🛠 System (classic menu switch)",
        await renderReal("gsys"),
      );

      // Restore classic default for leaf renders.
      writeFixtureSettings({ language: lang, menuStyle: "classic" });

      // Model & Thinking handoff previews use the same markdown builders as /model and /think.
      const previewModel = "claude-fable-5-2";
      capture(
        "mdl",
        "gm",
        "Штатный экран /model",
        "🧠 Выбор модели",
        "🧠 Model wizard",
        modelIntroMarkdown(
          {
            providerLabel: "claude",
            model: previewModel,
            effort: "medium",
            helperModel: "claude-sonnet-5-5",
          },
          tr,
        ),
      );
      capture(
        "thk",
        "gm",
        "Штатный экран /think",
        "🤔 Размышления",
        "🤔 Thinking wizard",
        thinkingEffortMarkdown(
          {
            model: previewModel,
            effort: "medium",
            efforts: claudeReasoningLevels(previewModel),
          },
          tr,
        ),
      );

      capture(
        "srch",
        "gm",
        "Экран",
        "🔍 Поиск",
        "🔍 Search",
        await renderReal("srch"),
      );
      capture(
        "turn",
        "gm",
        "Экран",
        "🔀 Новые сообщения",
        "🔀 New messages",
        await renderReal("turn"),
      );
      capture(
        "rich",
        "gc",
        "Экран",
        "💬 Богатые ответы",
        "💬 Rich replies",
        await renderReal("rich"),
      );
      capture(
        "voice",
        "gc",
        "Экран",
        "🎤 Голос",
        "🎤 Voice",
        await renderReal("voice"),
      );
      capture(
        "lang",
        "gc",
        "Экран",
        "🌐 Язык",
        "🌐 Language",
        await renderReal("lang"),
      );
      capture(
        "chr",
        "gc",
        "Экран",
        "🎭 Характер",
        "🎭 Character",
        await renderReal("chr"),
      );
      capture(
        "core",
        "gmem",
        "Экран",
        "💾 Память",
        "💾 Memory",
        await renderReal("core"),
      );
      capture(
        "sk",
        "gmem",
        "Экран",
        "🧩 Скиллы",
        "🧩 Skills",
        await renderReal("sk"),
      );
      capture(
        "gws",
        "gcon",
        "Экран",
        "🔗 Google",
        "🔗 Google",
        await renderReal("gws"),
      );
      capture(
        "ub",
        "gcon",
        "Экран",
        "📡 Userbot",
        "📡 Userbot",
        await renderReal("ub"),
      );

      // Colleagues OFF (default fresh install).
      capture(
        "col",
        "gcon",
        "По умолчанию выкл",
        "🤝 Коллеги (выкл)",
        "🤝 Colleagues (off)",
        await renderReal("col"),
      );

      // Colleagues ON (toggled via real colleagues.on("set", ["1"])).
      writeFixtureSettings({
        language: lang,
        menuStyle: "classic",
        colleagues: {
          enabled: false,
          items: {
            "7001": {
              botId: "7001",
              role: "critic",
              provider: "claude",
              model: "claude-fable-5-2",
              name: "Критик",
            },
            "7002": {
              botId: "7002",
              role: "programmer",
              provider: "codex",
              model: "gpt-5.5",
              name: "Программист",
            },
          },
        },
      });
      await SCREENS.col.on("set", ["1"], { page: 0 }, makeCtx());
      capture(
        "col_on",
        "gcon",
        "После включения",
        "🤝 Коллеги (вкл)",
        "🤝 Colleagues (on)",
        await renderReal("col"),
      );

      // Restore default settings before remaining screens.
      writeFixtureSettings({ language: lang, menuStyle: "classic" });
      capture(
        "cron",
        "gsch",
        "Экран",
        "⏰ Кроны",
        "⏰ Timers",
        await renderReal("cron"),
      );
      capture(
        "ntc",
        "gsch",
        "Экран",
        "🔔 Уведомления",
        "🔔 Notices",
        await renderReal("ntc"),
      );
      capture(
        "st",
        "gsys",
        "Экран",
        "📊 Статус",
        "📊 Status",
        await renderReal("st"),
      );
      capture(
        "svc",
        "gsys",
        "Экран",
        "🛠 Обслуживание",
        "🛠 Maintenance",
        await renderReal("svc"),
      );
    }

    return {
      generatedFrom:
        "scripts/lib/menu/* + scripts/poller/wizards.ts + scripts/lib/telegram-buttons.ts",
      rootCount: 6,
      legacyCount: 16,
      screens: screensByLang,
      groups,
    };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prevData;
    if (prevVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = prevVault;
    rmSync(work, { recursive: true, force: true });
  }
}

function renderHtml(data: PreviewData): string {
  const payload = safeJsonForScript(data);
  const title = escapeHtml("Iva /menu — 6 разделов и переключатель «Коллеги»");
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #f4f6f9;
      --surface: #ffffff;
      --border: #dde3ec;
      --ink: #17212b;
      --muted: #5d6b7a;
      --tg-chat: #dce8f2;
      --tg-bubble: #ffffff;
      --tg-btn: rgba(255, 255, 255, 0.92);
      --tg-btn-border: rgba(31, 61, 92, 0.14);
      --tg-btn-hover: #eef5fc;
      --tg-accent: #2481cc;
      --tg-success: #1f8b4c;
      --tg-success-bg: #e7f6ed;
      --tg-danger: #c62828;
      --tg-danger-bg: #fdecec;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--ink);
      font: 400 15px/1.48 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }
    .page {
      max-width: 1360px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    header.top {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand h1 {
      margin: 0 0 6px;
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .brand p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      max-width: 680px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .seg {
      display: inline-flex;
      background: #e7edf5;
      border-radius: 10px;
      padding: 3px;
      gap: 2px;
    }
    .seg button {
      border: 0;
      background: transparent;
      color: var(--muted);
      font: 500 13px/1 inherit;
      padding: 7px 12px;
      border-radius: 7px;
      cursor: pointer;
    }
    .seg button.active {
      background: var(--surface);
      color: var(--ink);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
      gap: 22px;
      margin-bottom: 34px;
      align-items: start;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
      min-width: 0;
    }
    .panel h2 {
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 600;
    }
    .panel .sub {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .sim-bar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 999px;
      background: #edf2f8;
      color: #2b4257;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tg-stage {
      background: var(--tg-chat);
      border-radius: 14px;
      padding: 14px;
      border: 1px solid #c9dae8;
    }
    .tg-bubble {
      background: var(--tg-bubble);
      border-radius: 12px 12px 12px 4px;
      padding: 11px 13px;
      box-shadow: 0 1px 2px rgba(16, 36, 56, 0.08);
      font-size: 13.5px;
      line-height: 1.44;
      color: var(--ink);
      word-break: break-word;
      overflow-x: auto;
    }
    .tg-bubble .tg-title {
      font-weight: 600;
      font-size: 14.5px;
      margin-bottom: 6px;
    }
    .tg-bubble p {
      margin: 0 0 7px;
      white-space: pre-wrap;
    }
    .tg-bubble p:last-child { margin-bottom: 0; }
    .tg-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
      margin: 6px 0;
    }
    .tg-table th, .tg-table td {
      text-align: left;
      padding: 4px 6px;
      border-bottom: 1px solid #e7edf3;
      vertical-align: top;
    }
    .tg-table th {
      color: var(--muted);
      font-weight: 500;
    }
    .tg-kbd {
      margin-top: 7px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .tg-row {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(0, 1fr);
      gap: 5px;
    }
    .tg-btn {
      appearance: none;
      border: 1px solid var(--tg-btn-border);
      background: var(--tg-btn);
      color: var(--ink);
      font: 500 13px/1.2 inherit;
      padding: 9px 8px;
      border-radius: 8px;
      text-align: center;
      cursor: pointer;
      transition: background 120ms ease, transform 80ms ease;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tg-btn:hover { background: var(--tg-btn-hover); }
    .tg-btn:active { transform: scale(0.985); }
    .tg-btn.style-success {
      background: var(--tg-success-bg);
      color: var(--tg-success);
      border-color: rgba(31, 139, 76, 0.28);
    }
    .tg-btn.style-danger {
      background: var(--tg-danger-bg);
      color: var(--tg-danger);
      border-color: rgba(198, 40, 40, 0.25);
    }
    .rich-buttons {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .rich-buttons .tg-btn {
      background: #f1f6fb;
      border-color: #d6e3f0;
    }
    .rich-buttons .tg-btn.style-success {
      background: var(--tg-success-bg);
      border-color: rgba(31, 139, 76, 0.28);
    }
    .rich-buttons .tg-btn.style-danger {
      background: var(--tg-danger-bg);
      border-color: rgba(198, 40, 40, 0.25);
    }
    .highlights {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .summary-list {
      margin: 0 0 16px;
      padding: 0;
      list-style: none;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .summary-list li {
      background: #f7f9fc;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
    }
    .summary-list strong {
      display: block;
      font-weight: 600;
      margin-bottom: 3px;
    }
    .summary-list span {
      color: var(--muted);
      font-size: 12px;
    }
    .section-band {
      margin-top: 30px;
    }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 12px;
    }
    .section-head h3 {
      margin: 0;
      font-size: 19px;
      font-weight: 600;
    }
    .section-head span {
      color: var(--muted);
      font-size: 13px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      align-items: start;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px;
      min-width: 0;
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .card-title {
      font-weight: 600;
      font-size: 14px;
    }
    .card-badge {
      font-size: 11px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 999px;
      background: #edf2f8;
      color: #36506b;
      white-space: nowrap;
    }
    .card-badge.accent {
      background: #e5f3ea;
      color: #186b3a;
    }
    footer.foot {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12.5px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
    }
    @media (max-width: 1120px) {
      .hero { grid-template-columns: 1fr; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .page { padding: 16px 12px 44px; }
      .brand h1 { font-size: 20px; }
      .highlights { grid-template-columns: 1fr; }
      .summary-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cards { grid-template-columns: 1fr; }
      .panel, .card { padding: 12px; }
      .tg-stage { padding: 10px; }
      .tg-btn { font-size: 12.5px; padding: 8px 6px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top">
      <div class="brand">
        <h1 id="page-title">Ива /menu — 6 разделов и переключатель «Коллеги»</h1>
        <p id="page-sub">Превью собрано напрямую из настоящих модулей <code>scripts/lib/menu/*</code>, визардов <code>scripts/poller/wizards.ts</code> и рендерера <code>scripts/lib/telegram-buttons.ts</code>. Все 16 прежних пунктов доступны внутри шести разделов; опция «🤝 Коллеги» в «Подключениях» выключена по умолчанию.</p>
      </div>
      <div class="controls">
        <div class="seg" role="group" aria-label="Language">
          <button type="button" data-lang="ru" class="active">Русский</button>
          <button type="button" data-lang="en">English</button>
        </div>
        <div class="seg" role="group" aria-label="Menu style">
          <button type="button" data-style="classic" class="active">Classic</button>
          <button type="button" data-style="rich">Rich</button>
        </div>
      </div>
    </header>

    <section class="hero">
      <div class="panel">
        <h2 id="sim-heading">Интерактивный симулятор /menu</h2>
        <p class="sub" id="sim-sub">Нажимайте кнопки внутри сообщения — переходы, возврат и переключатель «Коллеги» работают по настоящим callback_data.</p>
        <div class="sim-bar">
          <span id="sim-crumb">⚙️ Настройки</span>
          <span class="pill" id="sim-cb">iva_menu:r:o</span>
        </div>
        <div class="tg-stage" id="sim-stage"></div>
      </div>

      <div class="panel">
        <h2 id="map-heading">Карта 6 разделов → все 16 прежних пунктов + Коллеги</h2>
        <p class="sub" id="map-sub">Стартовый экран сокращён с 16 пунктов до 6. Переключатель «Коллеги» живёт в «Подключениях» и выключен по умолчанию.</p>
        <ul class="summary-list" id="summary-list"></ul>
        <div class="highlights" id="highlights"></div>
      </div>
    </section>

    <main id="gallery"></main>

    <footer class="foot">
      <span>Источник: <code>${escapeHtml(data.generatedFrom)}</code></span>
      <span>T912 · Коллеги Ивы 5/6 · Превью (не бой)</span>
    </footer>
  </div>

  <script id="menu-data" type="application/json">${payload}</script>
  <script>
    (function () {
      const DATA = JSON.parse(document.getElementById("menu-data").textContent);
      let lang = "ru";
      let style = "classic";
      let currentScreen = "r";
      let lastCb = "iva_menu:r:o";
      let colleaguesOn = false;

      const MAP_NOTES = {
        ru: [
          ["🧠 Модель", "Модель, размышления, поиск, новые сообщения"],
          ["💬 Общение", "Богатые ответы, голос, язык, характер"],
          ["💾 Память", "Память, скиллы"],
          ["🔗 Подключения", "Google, Userbot, 🤝 Коллеги"],
          ["⏰ Расписание", "Кроны, уведомления"],
          ["🛠 Система", "Статус, обслуживание, старое/новое меню"],
        ],
        en: [
          ["🧠 Model", "Model, thinking, search, new messages"],
          ["💬 Chat", "Rich replies, voice, language, character"],
          ["💾 Memory", "Memory, skills"],
          ["🔗 Connections", "Google, Userbot, 🤝 Colleagues"],
          ["⏰ Schedule", "Timers, notices"],
          ["🛠 System", "Status, maintenance, classic/new menu"],
        ],
      };

      function esc(s) {
        return String(s)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }


      function renderTelegramCard(card, interactive) {
        if (style === "rich") {
          return '<div class="tg-bubble">' + card.richHtml + '</div>';
        }
        const lines = card.classicText.split("\\n");
        const first = lines[0] || "";
        const rest = lines.slice(1).join("\\n").trim();
        const bubble =
          '<div class="tg-bubble">' +
          '<div class="tg-title">' + esc(first) + '</div>' +
          (rest ? '<p>' + esc(rest) + '</p>' : '') +
          '</div>';
        const kbd = card.classicRows.length
          ? '<div class="tg-kbd">' + card.classicRows.map((row) =>
              '<div class="tg-row">' + row.map((b) => {
                const cls = b.style ? " style-" + b.style : "";
                const cb = interactive && b.callback_data ? ' data-cb="' + esc(b.callback_data) + '"' : "";
                return '<button type="button" class="tg-btn' + cls + '"' + cb + '>' + esc(b.text) + '</button>';
              }).join("") + '</div>'
            ).join("") + '</div>'
          : '';
        return bubble + kbd;
      }

      function resolveScreenCard(id) {
        if (id === "col" && colleaguesOn) return DATA.screens[lang].col_on;
        if (id === "gsys" && style === "rich") return DATA.screens[lang].gsys_rich;
        return DATA.screens[lang][id] || DATA.screens[lang].r;
      }

      function handleCallback(cb) {
        lastCb = cb;
        if (cb === "iva_menu:r:x") {
          currentScreen = "r";
          renderAll();
          return;
        }
        if (cb === "iva_menu:svc:menu:rich") {
          style = "rich";
          currentScreen = "r";
          syncControls();
          renderAll();
          return;
        }
        if (cb === "iva_menu:svc:menu:classic") {
          style = "classic";
          currentScreen = "r";
          syncControls();
          renderAll();
          return;
        }
        if (cb === "iva_menu:lang:set:ru") {
          lang = "ru";
          currentScreen = "r";
          syncControls();
          renderAll();
          return;
        }
        if (cb === "iva_menu:lang:set:en") {
          lang = "en";
          currentScreen = "r";
          syncControls();
          renderAll();
          return;
        }
        if (cb === "iva_menu:col:set:1") {
          colleaguesOn = true;
          currentScreen = "col";
          renderAll();
          return;
        }
        if (cb === "iva_menu:col:set:0") {
          colleaguesOn = false;
          currentScreen = "col";
          renderAll();
          return;
        }
        const parts = cb.replace(/^iva_menu:/, "").split(":");
        const sid = parts[0];
        if (DATA.screens[lang][sid]) {
          currentScreen = sid;
          renderAll();
        }
      }

      function syncControls() {
        document.querySelectorAll("[data-lang]").forEach((el) => {
          el.classList.toggle("active", el.getAttribute("data-lang") === lang);
        });
        document.querySelectorAll("[data-style]").forEach((el) => {
          el.classList.toggle("active", el.getAttribute("data-style") === style);
        });
      }

      function renderSimulator() {
        const card = resolveScreenCard(currentScreen);
        const stage = document.getElementById("sim-stage");
        stage.innerHTML = renderTelegramCard(card, true);
        const title = lang === "ru" ? card.titleRu : card.titleEn;
        document.getElementById("sim-crumb").textContent = title;
        document.getElementById("sim-cb").textContent = lastCb;
        stage.querySelectorAll("[data-cb]").forEach((btn) => {
          btn.addEventListener("click", () => handleCallback(btn.getAttribute("data-cb")));
        });
      }

      function renderHighlights() {
        const list = document.getElementById("summary-list");
        list.innerHTML = MAP_NOTES[lang]
          .map(([head, desc]) => "<li><strong>" + esc(head) + "</strong><span>" + esc(desc) + "</span></li>")
          .join("");

        const box = document.getElementById("highlights");
        const pair = [DATA.screens[lang].col, DATA.screens[lang].col_on];
        box.innerHTML = pair.map((card) => {
          const title = lang === "ru" ? card.titleRu : card.titleEn;
          const accent = card.id === "col_on" ? " accent" : "";
          return (
            '<div class="card">' +
            '<div class="card-head">' +
            '<span class="card-title">' + esc(title) + '</span>' +
            '<span class="card-badge' + accent + '">' + esc(card.badge) + '</span>' +
            '</div>' +
            '<div class="tg-stage">' + renderTelegramCard(card, false) + '</div>' +
            '</div>'
          );
        }).join("");
      }

      function renderGallery() {
        const gallery = document.getElementById("gallery");
        const sections = DATA.groups.map((group) => {
          const headTitle = lang === "ru" ? group.titleRu : group.titleEn;
          const ids = [group.sid, ...group.children];
          const cardsHtml = ids.map((id) => {
            const card = DATA.screens[lang][id];
            if (!card) return "";
            const title = lang === "ru" ? card.titleRu : card.titleEn;
            const isGroup = id === group.sid;
            return (
              '<article class="card">' +
              '<div class="card-head">' +
              '<span class="card-title">' + esc(title) + '</span>' +
              '<span class="card-badge' + (isGroup ? ' accent' : '') + '">' + esc(card.badge) + '</span>' +
              '</div>' +
              '<div class="tg-stage">' + renderTelegramCard(card, false) + '</div>' +
              '</article>'
            );
          }).join("");
          return (
            '<section class="section-band">' +
            '<div class="section-head">' +
            '<h3>' + esc(headTitle) + '</h3>' +
            '<span>' + esc(ids.length + (lang === "ru" ? " экранов" : " screens")) + '</span>' +
            '</div>' +
            '<div class="cards">' + cardsHtml + '</div>' +
            '</section>'
          );
        });
        gallery.innerHTML = sections.join("");
      }

      function renderAll() {
        document.documentElement.lang = lang;
        renderSimulator();
        renderHighlights();
        renderGallery();
      }

      document.querySelectorAll("[data-lang]").forEach((btn) => {
        btn.addEventListener("click", () => {
          lang = btn.getAttribute("data-lang");
          syncControls();
          renderAll();
        });
      });
      document.querySelectorAll("[data-style]").forEach((btn) => {
        btn.addEventListener("click", () => {
          style = btn.getAttribute("data-style");
          syncControls();
          renderAll();
        });
      });

      renderAll();
    })();
  </script>
</body>
</html>
`;
}

const outDir = parseOutDir(process.argv.slice(2));
const data = await buildPreviewData();
mkdirSync(outDir, { recursive: true });
const html = renderHtml(data);
writeFileSync(join(outDir, "preview.html"), html, "utf8");
writeFileSync(join(outDir, "index.html"), html, "utf8");
console.log(
  `menu preview generated: ${join(outDir, "preview.html")} (${Object.keys(data.screens.ru).length} screens × 2 languages)`,
);
