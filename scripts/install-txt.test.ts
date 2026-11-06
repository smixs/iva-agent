import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSTALL_URL = "https://iva-agent.com/install.txt";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const phrases = {
  en: `Install Iva for me, instructions: ${INSTALL_URL}`,
  ru: `Установи мне Иву, инструкция: ${INSTALL_URL}`,
};

void test("install.txt pins every link to an existing file in the current or next patch release", () => {
  const { version } = JSON.parse(read("package.json")) as { version: string };
  // A beta prerelease (0.5.6-beta.1) already names its coming release.
  const [core = "", prerelease] = version.split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  const unreleased = /^## (?:\[Unreleased\]|Unreleased)$/mu.test(
    read("CHANGELOG.md"),
  );
  const tags = [`v${core}`];
  if (prerelease === undefined && unreleased)
    tags.push(`v${major}.${minor}.${patch + 1}`);
  const links = read("docs/install.txt").match(/https?:\/\/[^\s<>]+/gu) ?? [];
  assert.ok(links.length > 0);
  for (const link of links) {
    const url = new URL(link);
    assert.equal(url.origin, "https://raw.githubusercontent.com");
    const prefix = tags
      .map((tag) => `/smixs/iva-agent/${tag}/`)
      .find((candidate) => url.pathname.startsWith(candidate));
    assert.ok(prefix, `${link} must use ${tags.join(" or ")}`);
    const path = url.pathname.slice(prefix.length);
    assert.ok(resolve(ROOT, path).startsWith(ROOT));
    assert.ok(existsSync(join(ROOT, path)), `missing ${path}`);
  }
});

void test("install.txt lists the complete skill with no duplicate or missing files", () => {
  const dir = "skills/install-iva";
  const expected = readdirSync(join(ROOT, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length))
    .sort();
  const actual = [
    ...read("docs/install.txt").matchAll(
      /https:\/\/raw\.githubusercontent\.com\/smixs\/iva-agent\/[^/]+\/(skills\/install-iva\/[^\s]+)/gu,
    ),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(actual, expected);
});

for (const lang of ["en", "ru"] as const) {
  const readme = lang === "en" ? "README.md" : "README.ru.md";
  const site = lang === "en" ? "docs/index.html" : "docs/ru/index.html";
  const guide = lang === "en" ? "docs/install.md" : "docs/ru/install.md";

  void test(`${lang}: README, site and guide give the same copyable install phrase`, () => {
    const phrase = phrases[lang];
    assert.equal(read(readme).split(phrase).length - 1, 2);
    assert.equal(
      read(readme).match(
        /\[!\[.*?\]\(https:\/\/img\.shields\.io\/badge\/.*?style=for-the-badge\)\]\(https:\/\/iva-agent\.com\/install\.txt\)/gu,
      )?.length,
      2,
    );
    assert.ok(read(guide).includes(phrase));
    const page = read(site);
    assert.ok(page.replace(/\s+/gu, " ").includes(phrase));
    assert.match(page, /<button\s+id="copy-ai"/u);
    assert.match(page, /wireCopy\("copy-ai", "agent-prompt"\)/u);
    assert.ok(page.indexOf('id="copy-ai"') < page.indexOf('id="cmd"'));
    assert.ok(
      read(readme).indexOf(phrase) < read(readme).indexOf("curl -fsSL"),
    );
    assert.match(page, /Claude Code, Codex (?:or|или) Claude Desktop/u);
  });

  for (const clipboard of ["available", "denied", "missing"]) {
    void test(`${lang}: install button copies or selects the phrase when clipboard is ${clipboard}`, async () => {
      const page = read(site);
      const script = page.slice(
        page.indexOf("function wireCopy("),
        page.indexOf('wireCopy("copy-ai"'),
      );
      let click: (() => void) | undefined;
      let copied = "";
      let selected = false;
      const promptText = /id="agent-prompt"[^>]*>([\s\S]*?)<\/code/u.exec(
        page,
      )?.[1];
      assert.ok(promptText);
      const source = { textContent: promptText, hidden: true };
      const label = { textContent: "Install" };
      const button = {
        textContent: "Install",
        querySelector: (selector: string) =>
          selector === ".lbl" ? label : null,
        classList: { add: () => {}, remove: () => {} },
        addEventListener: (_event: string, listener: () => void) => {
          click = listener;
        },
      };
      const elements: Record<string, unknown> = {
        "copy-ai": button,
        "agent-prompt": source,
      };
      runInNewContext(`${script}\nwireCopy("copy-ai", "agent-prompt");`, {
        document: {
          getElementById: (id: string) => elements[id],
          createRange: () => ({
            selectNodeContents: (node: unknown) => assert.equal(node, source),
          }),
        },
        navigator:
          clipboard === "missing"
            ? {}
            : {
                clipboard: {
                  writeText: (text: string) => {
                    if (clipboard === "denied")
                      return Promise.reject(new Error("denied"));
                    copied = text;
                    return Promise.resolve();
                  },
                },
              },
        window: {
          getSelection: () => ({
            removeAllRanges: () => {},
            addRange: () => {
              selected = true;
            },
          }),
        },
        setTimeout: () => {},
      });
      assert.ok(click);
      click();
      await new Promise((done) => setImmediate(done));
      assert.notEqual(label.textContent, "Install");
      if (clipboard === "available") assert.equal(copied, phrases[lang]);
      else {
        assert.equal(selected, true);
        assert.equal(source.hidden, false);
      }
    });
  }
}

void test("llms.txt links agents to install.txt once", () => {
  assert.equal(read("docs/llms.txt").split(INSTALL_URL).length - 1, 1);
});

void test("the install skill offers only main and the official IVA_BETA=1 path", () => {
  const skill = read("skills/install-iva/references/iva-state.md");
  assert.match(
    skill,
    /https:\/\/raw\.githubusercontent\.com\/smixs\/iva-agent\/main\/install\.sh \| bash -s -- --env-file/u,
  );
  assert.match(
    skill,
    /https:\/\/raw\.githubusercontent\.com\/smixs\/iva-agent\/beta\/install\.sh \| IVA_BETA=1 bash -s -- --env-file/u,
  );
  assert.doesNotMatch(skill, /IVA_INSTALL_BRANCH|BRANCH=|<branch>/u);
});
