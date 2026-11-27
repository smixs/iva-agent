/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import root from "./root.ts";
import {
  chatGroup,
  connectionsGroup,
  memoryGroup,
  modelGroup,
  scheduleGroup,
  systemGroup,
} from "./groups.ts";
import { createMenu, SCREENS } from "./index.ts";
import { createFlows } from "../tg-flow.ts";
import { tempDir } from "../../fixtures/temp-dir.ts";

// Rich-кнопка живёт строкой в markdown: подпись и callback_data достаём из тега.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

function makeCtx(lang: string) {
  return {
    tr: (en: string, ru: string) => (lang === "ru" ? ru : en),
  };
}

const englishRootButtons: Array<[string, string]> = [
  ["🧠 Model", "iva_menu:gm:o"],
  ["💬 Chat", "iva_menu:gc:o"],
  ["💾 Memory", "iva_menu:gmem:o"],
  ["🔗 Connections", "iva_menu:gcon:o"],
  ["⏰ Schedule", "iva_menu:gsch:o"],
  ["🛠 System", "iva_menu:gsys:o"],
  ["✖ Close", "iva_menu:r:x"],
];

const russianRootButtons: Array<[string, string]> = [
  ["🧠 Модель", "iva_menu:gm:o"],
  ["💬 Общение", "iva_menu:gc:o"],
  ["💾 Память", "iva_menu:gmem:o"],
  ["🔗 Подключения", "iva_menu:gcon:o"],
  ["⏰ Расписание", "iva_menu:gsch:o"],
  ["🛠 Система", "iva_menu:gsys:o"],
  ["✖ Закрыть", "iva_menu:r:x"],
];

test("root shows exactly six sections plus Close in English", () => {
  const state = { page: 3 };
  const view = root.render(state, makeCtx("en"));

  assert.match(view.text, /^# ⚙️ Settings$/m);
  assert.deepEqual(buttonsOf(view.text), englishRootButtons);
  assert.equal(
    view.text.match(/<tg-button /g)?.length,
    englishRootButtons.length,
  );
  assert.equal(
    view.text.match(/\n\n<tg-button /g)?.length,
    englishRootButtons.length,
  );
  assert.deepEqual(state, { page: 3 });
});

test("root translates the six sections without changing callback routing", () => {
  const view = root.render({}, makeCtx("ru"));

  assert.match(view.text, /^# ⚙️ Настройки$/m);
  assert.deepEqual(buttonsOf(view.text), russianRootButtons);
  assert.deepEqual(
    buttonsOf(view.text).map(([, callback]) => callback),
    englishRootButtons.map(([, callback]) => callback),
  );
});

test("root keeps six sections even when menuStyle is rich (classic toggle lives in System)", () => {
  const prev = process.env.ASSISTANT_DATA_DIR;
  const dir = tempDir("iva-root-rich-");
  try {
    process.env.ASSISTANT_DATA_DIR = dir;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ menuStyle: "rich" }),
    );
    const rootButtons = buttonsOf(root.render({}, makeCtx("ru")).text);
    assert.deepEqual(rootButtons, russianRootButtons);

    const sysButtons = buttonsOf(systemGroup.render({}, makeCtx("ru")).text);
    assert.deepEqual(sysButtons, [
      ["📊 Статус", "iva_menu:st:o"],
      ["🛠 Обслуживание", "iva_menu:svc:o"],
      ["◀︎ Старое меню", "iva_menu:svc:menu:classic"],
      ["‹ Меню", "iva_menu:r:o"],
    ]);
  } finally {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
  }
});

test("root exposes the top-level screen contract", () => {
  assert.equal(root.parent, null);
  assert.equal(root.on("ignored", [], {}, makeCtx("en")), undefined);
});

test("every one of the 16 legacy items, Colleagues, and menu-style switch is reachable from root", () => {
  const prev = process.env.ASSISTANT_DATA_DIR;
  const dir = tempDir("iva-menu-walk-");
  try {
    process.env.ASSISTANT_DATA_DIR = dir;
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ menuStyle: "classic" }),
    );
    const ctx = makeCtx("ru");

    const rootButtons = buttonsOf(root.render({}, ctx).text);
    const groupSids = rootButtons
      .filter(([, data]) => data !== "iva_menu:r:x")
      .map(([, data]) => {
        const match = /^iva_menu:([^:]+):o$/u.exec(data);
        assert.ok(match, `unexpected root callback: ${data}`);
        return match[1];
      });
    assert.deepEqual(groupSids, ["gm", "gc", "gmem", "gcon", "gsch", "gsys"]);

    const expectedGroups: Record<string, Array<[string, string]>> = {
      gm: [
        ["🧠 Модель", "iva_menu:mdl"],
        ["🤔 Размышления", "iva_menu:thk"],
        ["🔍 Поиск", "iva_menu:srch:o"],
        ["🔀 Новые сообщения", "iva_menu:turn:o"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
      gc: [
        ["💬 Богатые ответы", "iva_menu:rich:o"],
        ["🎤 Голос", "iva_menu:voice:o"],
        ["🌐 Язык", "iva_menu:lang:o"],
        ["🎭 Характер", "iva_menu:chr:o"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
      gmem: [
        ["💾 Память", "iva_menu:core:o"],
        ["🧩 Скиллы", "iva_menu:sk:o"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
      gcon: [
        ["🔗 Google", "iva_menu:gws:o"],
        ["📡 Userbot", "iva_menu:ub:o"],
        ["🤝 Коллеги", "iva_menu:col:o"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
      gsch: [
        ["⏰ Кроны", "iva_menu:cron:o"],
        ["🔔 Уведомления", "iva_menu:ntc:o"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
      gsys: [
        ["📊 Статус", "iva_menu:st:o"],
        ["🛠 Обслуживание", "iva_menu:svc:o"],
        ["✨ Новое меню", "iva_menu:svc:menu:rich"],
        ["‹ Меню", "iva_menu:r:o"],
      ],
    };

    const legacyTargets = [
      "iva_menu:mdl",
      "iva_menu:thk",
      "iva_menu:srch:o",
      "iva_menu:rich:o",
      "iva_menu:voice:o",
      "iva_menu:lang:o",
      "iva_menu:chr:o",
      "iva_menu:core:o",
      "iva_menu:ub:o",
      "iva_menu:gws:o",
      "iva_menu:cron:o",
      "iva_menu:ntc:o",
      "iva_menu:sk:o",
      "iva_menu:st:o",
      "iva_menu:turn:o",
      "iva_menu:svc:o",
    ];
    assert.equal(legacyTargets.length, 16);

    const discovered = new Map<string, string>();
    for (const sid of groupSids) {
      const mod = SCREENS[sid as keyof typeof SCREENS] as {
        parent: string;
        render: (
          st: Record<string, unknown>,
          c: ReturnType<typeof makeCtx>,
        ) => { text: string };
      };
      assert.equal(mod.parent, "r", `${sid}.parent`);
      const buttons = buttonsOf(mod.render({}, ctx).text);
      assert.deepEqual(buttons, expectedGroups[sid], `group ${sid}`);
      for (const [, data] of buttons) {
        assert.ok(
          Buffer.byteLength(data, "utf8") <= 64,
          `callback exceeds 64 bytes: ${data}`,
        );
        if (data === "iva_menu:r:o") continue;
        discovered.set(data, sid);
        const childSid = data.replace(/^iva_menu:/u, "").split(":")[0];
        if (childSid !== "mdl" && childSid !== "thk") {
          assert.ok(
            Object.hasOwn(SCREENS, childSid),
            `unknown child sid ${childSid} in ${sid}`,
          );
          const child = SCREENS[childSid as keyof typeof SCREENS] as {
            parent: string | null;
          };
          assert.equal(
            child.parent,
            sid,
            `${childSid}.parent must point back to ${sid}`,
          );
        }
      }
    }

    for (const target of legacyTargets) {
      assert.ok(
        discovered.has(target),
        `legacy item ${target} is missing from the six groups`,
      );
    }
    assert.equal(discovered.get("iva_menu:col:o"), "gcon");
    assert.equal(discovered.get("iva_menu:svc:menu:rich"), "gsys");

    // Verify every exported group screen is registered in SCREENS.
    assert.equal(SCREENS.gm, modelGroup);
    assert.equal(SCREENS.gc, chatGroup);
    assert.equal(SCREENS.gmem, memoryGroup);
    assert.equal(SCREENS.gcon, connectionsGroup);
    assert.equal(SCREENS.gsch, scheduleGroup);
    assert.equal(SCREENS.gsys, systemGroup);
  } finally {
    if (prev === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prev;
  }
});

test("createMenu engine navigates from root into every one of the 16 legacy items and toggles Colleagues", async () => {
  const prevData = process.env.ASSISTANT_DATA_DIR;
  const prevVault = process.env.ASSISTANT_VAULT_DIR;
  const rootDir = tempDir("iva-menu-e2e-");
  const dataDir = join(rootDir, "data");
  const vaultDir = join(rootDir, "vault");
  const envPath = join(rootDir, ".env");
  writeFileSync(join(rootDir, "package.json"), '{"version":"0.5.15"}\n');
  writeFileSync(envPath, "MODEL_PROVIDER=claude\nSEARCH_PROVIDER=tavily\n");
  process.env.ASSISTANT_DATA_DIR = dataDir;
  process.env.ASSISTANT_VAULT_DIR = vaultDir;

  try {
    const rendered: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    let seq = 100;
    const tg = (method: string, params: Record<string, unknown>) => {
      rendered.push({ method, params });
      return Promise.resolve({ ok: true, result: { message_id: seq++ } });
    };
    const flows = createFlows({ tg });
    const handoffs: string[] = [];
    const menu = createMenu({
      flows,
      tg,
      deps: {
        root: rootDir,
        dataDir,
        envPath,
        allowed: new Set(["42"]),
        deliver: () => Promise.resolve(true),
        admitSynthetic: () => Promise.resolve(true),
        handleModelCmd: () => {
          handoffs.push("mdl");
        },
        handleThinkCmd: () => {
          handoffs.push("thk");
        },
        reply: () => Promise.resolve(),
        sc: () => Promise.resolve(true),
        probeUserbotHealth: () =>
          Promise.resolve({ state: "off" as const, reason: "service_off" }),
      },
    });

    const st = await menu.open(10, "42");
    assert.equal(st.screen, "r");

    const tap = (data: string) =>
      menu.onCallback({
        id: `cb-${data}`,
        from: { id: "42" },
        message: { chat: { id: 10, type: "private" }, message_id: st.msgId! },
        data,
      });

    const walk: Array<[string, string[]]> = [
      [
        "gm",
        ["iva_menu:mdl", "iva_menu:thk", "iva_menu:srch:o", "iva_menu:turn:o"],
      ],
      [
        "gc",
        [
          "iva_menu:rich:o",
          "iva_menu:voice:o",
          "iva_menu:lang:o",
          "iva_menu:chr:o",
        ],
      ],
      ["gmem", ["iva_menu:core:o", "iva_menu:sk:o"]],
      ["gcon", ["iva_menu:gws:o", "iva_menu:ub:o", "iva_menu:col:o"]],
      ["gsch", ["iva_menu:cron:o", "iva_menu:ntc:o"]],
      ["gsys", ["iva_menu:st:o", "iva_menu:svc:o"]],
    ];

    let visitedLeaves = 0;
    for (const [groupSid, targets] of walk) {
      await tap(`iva_menu:${groupSid}:o`);
      assert.equal(st.screen, groupSid);
      for (const target of targets) {
        await tap(target);
        visitedLeaves += 1;
        if (target === "iva_menu:mdl" || target === "iva_menu:thk") continue;
        const leafSid = target.replace(/^iva_menu:/u, "").split(":")[0];
        assert.equal(st.screen, leafSid);
        // Navigate back to the section group.
        await tap(`iva_menu:${groupSid}:o`);
        assert.equal(st.screen, groupSid);
      }
      // Navigate back to root.
      await tap("iva_menu:r:o");
      assert.equal(st.screen, "r");
    }

    assert.equal(visitedLeaves, 17); // 16 legacy items + Colleagues
    assert.deepEqual(handoffs, ["mdl", "thk"]);

    // Toggle Colleagues via Connections → Colleagues → On → Off.
    await tap("iva_menu:gcon:o");
    await tap("iva_menu:col:o");
    assert.equal(st.screen, "col");
    await tap("iva_menu:col:set:1");
    assert.equal(st.screen, "col");
    await tap("iva_menu:col:set:0");
    assert.equal(st.screen, "col");
  } finally {
    if (prevData === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = prevData;
    if (prevVault === undefined) delete process.env.ASSISTANT_VAULT_DIR;
    else process.env.ASSISTANT_VAULT_DIR = prevVault;
  }
});
