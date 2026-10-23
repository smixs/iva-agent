import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { files } from "../src/lib/build.ts";
const dist = path.resolve("dist");
const copy = JSON.parse(readFileSync("src/data/home.json", "utf8"));
// Emoji are allowed only inside the Telegram chat (data-tg-content), where they are
// part of how Telegram looks. Everything else on the site uses SVG icons.
const emoji = /\p{Extended_Pictographic}|\uFE0F/u;
const notEmoji = new Set(["\u00A9", "\u00AE", "\u2122"]);
const findEmoji = (html: string) =>
  [...html.matchAll(new RegExp(emoji, "gu"))]
    .map((m) => m[0])
    .filter((ch) => !notEmoji.has(ch));
const outsideChat = (html: string) => {
  let out = "",
    i = 0;
  for (const m of html.matchAll(/<div class="tg-list" data-tg-content[^>]*>/g)) {
    out += html.slice(i, m.index);
    // The chat list ends where the scroll edge starts.
    const end = html.indexOf('<div class="tg-edge-top"', m.index);
    i = end;
  }
  return out + html.slice(i);
};
const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .replace(/ (?=[.,!?;:])/g, "")
    .trim();
const old = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", "origin/main", "docs"],
  { cwd: "..", encoding: "utf8" },
)
  .trim()
  .split("\n")
  .map((p) => p.slice(5));
const replaced = [
  "index.html",
  "ru/index.html",
  "about/index.html",
  "ru/about/index.html",
  "privacy/index.html",
  "404.html",
  "sitemap.xml",
  "robots.txt",
  "llms.txt",
];
for (const file of old)
  assert.ok(
    existsSync(path.join(dist, file)) ||
      (file === "sitemap.xml" &&
        existsSync(path.join(dist, "sitemap-index.xml"))),
    `Legacy address missing: ${file}`,
  );
assert.deepEqual(
  readFileSync("dist/install.txt"),
  readFileSync("../docs/install.txt"),
);
assert.deepEqual(
  readFileSync("dist/install.sh"),
  readFileSync("../install.sh"),
);
console.log(
  `Legacy: ${old.length} paths present; install.txt and install.sh byte-identical. Replaced: ${replaced.join(", ")}`,
);
const pages = files(dist).filter(
  (f) => f.endsWith(".html") && !/googlef78|yandex_a/.test(f),
);
const failures: string[] = [];
let links = 0,
  json = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${page}: one H1`);
  for (const img of html.matchAll(/<img\b[^>]*>/g))
    assert.ok(/\balt(?:=|\s|\/?>)/.test(img[0]), `${page}: missing alt`);
  for (const block of html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    JSON.parse(block[1]);
    json++;
  }
  for (const ref of html.matchAll(/\b(?:href|src)="([^"#]*)[^\"]*"/g)) {
    let value = ref[1].replaceAll("&amp;", "&");
    if (
      !value ||
      /^(?:https?:|\/\/|mailto:|tel:|data:|javascript:)/.test(value)
    )
      continue;
    value = decodeURI(value.split("?")[0]);
    let target = value.startsWith("/")
      ? path.join(dist, value)
      : path.resolve(path.dirname(page), value);
    if (existsSync(target) && statSync(target).isDirectory())
      target = path.join(target, "index.html");
    links++;
    if (!existsSync(target))
      failures.push(`${path.relative(dist, page)}: ${value}`);
  }
}
for (const page of pages) {
  for (const image of readFileSync(page, "utf8").matchAll(
    /<(?:img|video)\b[^>]*>/g,
  ))
    assert.ok(
      /\bwidth=/.test(image[0]) && /\bheight=/.test(image[0]),
      `${page}: missing dimensions`,
    );
}
for (const file of ["dist/404.html", "dist/ru/404.html"])
  assert.ok(
    readFileSync(file, "utf8").includes('name="robots" content="noindex"'),
  );
assert.ok(
  readFileSync("dist/privacy/index.html", "utf8").includes('lang="ru"'),
);
for (const home of ["dist/index.html", "dist/ru/index.html"]) {
  const html = readFileSync(home, "utf8")
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  for (const id of [
    "features",
    "memory",
    "install",
    "userbot",
    "security",
    "works",
    "menu",
    "asks",
  ])
    assert.equal(
      (html.match(new RegExp('id="' + id + '"', "g")) || []).length,
      1,
      `${home}: ${id}`,
    );
  const schemas = [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map((m) => JSON.parse(m[1]));
  assert.equal(
    schemas.find((s) => s["@type"] === "SoftwareApplication").description,
    html.match(/<meta name="description" content="([^"]*)"/)![1],
  );
  const faq = schemas.find((s) => s["@type"] === "FAQPage");
  assert.equal(faq.mainEntity.length, 10);
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(
    html,
    /<video\b|id="video"|data-seek=|VideoObject|iva-demo-v5|demo-poster/,
  );
  const homeURL = new URL(
    home.includes("/ru/") ? "/ru/" : "/",
    "https://iva-agent.com",
  );
  for (const match of visible.matchAll(/\bhref="([^"]+)"/g)) {
    const url = new URL(match[1], homeURL);
    if (
      url.origin === homeURL.origin &&
      url.pathname === homeURL.pathname &&
      url.hash
    )
      assert.ok(
        visible.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
        `${home}: missing anchor ${url.hash}`,
      );
  }
  const faqHTML = visible.match(/<section id="faq"[\s\S]*?<\/section>/)![0];
  const actualFAQ = [
    ...faqHTML.matchAll(
      /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>/g,
    ),
  ].map((m) => ({
    question: m[1].trim(),
    answer: m[2].replace(/<[^>]*>/g, "").trim(),
  }));
  assert.equal(actualFAQ.length, 10);
  faq.mainEntity.forEach((question: any, index: number) => {
    assert.equal(actualFAQ[index].question, question.name);
    assert.equal(actualFAQ[index].answer, question.acceptedAnswer.text);
  });
  const lang = home.includes("/ru/") ? "ru" : "en";
  const c = copy[lang];
  assert.equal((visible.match(/class="review"/g) || []).length, 2);
  assert.equal((visible.match(/class="case"/g) || []).length, 4);
  const final = visible.match(/<section id="install"[\s\S]*?<\/section>/)![0];
  assert.ok(final.includes(c.final.cta));
  assert.ok(final.includes("install.txt</code>"));
  const main = visible.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)![1];
  const headings = [...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    plain(m[1]),
  );
  assert.deepEqual(headings, [
    c.cases.h2,
    c.data.h2,
    c.compare.h2,
    c.world.h2.join(" "),
    c.faq.h2,
    c.final.h2,
  ]);
  const content = plain(visible);
  for (const value of [
    ...c.hero.h1,
    ...c.hero.lead,
    c.hero.cta,
    ...c.cases.items.flatMap((i: any) => [i.title, i.text]),
    ...c.data.lead,
    ...c.data.points.map((p: string[]) => p[1]),
    ...c.compare.rows,
  ])
    assert.ok(content.includes(plain(value)), `${home}: missing copy: ${value}`);
  const stray = findEmoji(outsideChat(html));
  assert.deepEqual(stray, [], `${home}: emoji outside the chat`);
}
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const chrome = [
    ...(html.match(/<header class="header[\s\S]*?<\/header>/) || []),
    ...(html.match(/<footer class="footer[\s\S]*?<\/footer>/) || []),
  ].join("");
  assert.deepEqual(
    findEmoji(chrome),
    [],
    `${path.relative(dist, page)}: emoji in header or footer`,
  );
}
console.log(
  `HTML: ${pages.length} pages; ${json} JSON-LD blocks parsed; 10 FAQ entries per locale; ${links} internal references checked.`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("PASS");
