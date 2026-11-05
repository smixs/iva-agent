import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { files } from "../src/lib/build.ts";
const dist = path.resolve(process.argv[2] || "dist");
const copy = JSON.parse(readFileSync("src/data/copy.json", "utf8"));
const usecases = JSON.parse(readFileSync("src/data/usecases.json", "utf8"));
// Emoji are allowed only inside the Telegram demo (data-ui), where they are
// part of how Telegram looks. Everything else on the site uses SVG icons.
const emoji = /\p{Extended_Pictographic}|\uFE0F/u;
// Text symbols that are pictographic only with U+FE0F: ©, ®, ™ and arrows like ↗.
const notEmoji = new Set([
  "\u00A9",
  "\u00AE",
  "\u2122",
  "\u2194",
  "\u2195",
  "\u2196",
  "\u2197",
  "\u2198",
  "\u2199",
]);
const findEmoji = (html: string) =>
  [...html.matchAll(new RegExp(emoji, "gu"))]
    .map((m) => m[0])
    .filter((ch) => !notEmoji.has(ch));
const outsideChat = (html: string) => {
  // Match the demo's enclosing element, preserving siblings and nested markup.
  const root = /<([a-z][a-z0-9-]*)\b[^>]*\bdata-ui="telegram-demo"[^>]*>/i.exec(
    html,
  );
  assert.ok(root, "Home must identify the interactive Telegram demo");
  const tag = root[1];
  const start = root.index;
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tokens.lastIndex = start + root[0].length;
  let depth = 1;
  for (let match; (match = tokens.exec(html));) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(tokens.lastIndex);
  }
  throw new Error("Unclosed Telegram demo root");
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
  readFileSync(path.join(dist, "install.txt")),
  readFileSync("../docs/install.txt"),
);
assert.deepEqual(
  readFileSync(path.join(dist, "install.sh")),
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
for (const file of [path.join(dist, "404.html"), path.join(dist, "ru/404.html")])
  assert.ok(
    readFileSync(file, "utf8").includes('name="robots" content="noindex"'),
  );
assert.ok(
  readFileSync(path.join(dist, "privacy/index.html"), "utf8").includes('lang="ru"'),
);
for (const home of [path.join(dist, "index.html"), path.join(dist, "ru/index.html")]) {
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
  assert.equal(faq.mainEntity.length, 6);
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
      /<summary class="faq-question"[^>]*>([\s\S]*?)<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>/g,
    ),
  ].map((m) => ({
    question: plain(m[1]),
    answer: plain(m[2]),
  }));
  assert.equal(actualFAQ.length, 6);
  assert.match(faqHTML, /<details class="faq-group"\s*>/);
  faq.mainEntity.forEach((question: any, index: number) => {
    assert.equal(actualFAQ[index].question, plain(question.name));
    assert.equal(actualFAQ[index].answer, plain(question.acceptedAnswer.text));
  });
  assert.equal((visible.match(/class="review"/g) || []).length, 3);
  const lang = home.includes("/ru/") ? "ru" : "en";
  const publishedReviews = JSON.parse(
    readFileSync("src/data/reviews.json", "utf8"),
  );
  const localeReviews = publishedReviews.filter(
    (review: any) => review.lang === lang,
  );
  assert.equal(localeReviews.length, 3);
  for (const review of localeReviews) {
    assert.ok(visible.includes(review.url), `${home}: review source link`);
    assert.ok(
      plain(visible).includes(plain(review.short)),
      `${home}: published review text`,
    );
  }

  assert.equal((visible.match(/class="usecase-row"/g) || []).length, usecases[lang].rows.length);
  const casesHTML = visible.match(
    /<section id="features"[\s\S]*?<\/section>/,
  )![0];
  assert.match(casesHTML, /aria-label="/);
  assert.ok(
    !casesHTML.includes('id="usecases-title"'),
    `${home}: redundant scenario heading`,
  );
  for (const row of casesHTML.matchAll(/<article\b[\s\S]*?<\/article>/g)) {
    assert.ok(
      row[0].indexOf("<h2") < row[0].indexOf("<picture"),
      `${home}: scenario copy precedes picture`,
    );
  }

  const main = visible.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)![1];
  const headings = [...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    plain(m[1]),
  );
  assert.deepEqual(headings, [
    ...usecases[lang].rows.map((row: any) => row.title),
    ...copy[lang]
      .filter((section: any) => [3, 7, 9, 10].includes(section.number))
      .map((section: any) => section.groups.H2[0]),
  ]);
  assert.ok(
    ![...main.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)].some((m) =>
      plain(m[1]).includes("."),
    ),
    `${home}: full stop in heading`,
  );
  const content = plain(visible);
  for (const row of usecases[lang].rows) {
    for (const value of [row.title, row.text]) {
      assert.ok(
        content.includes(plain(value)),
        `${home}: missing usecase copy: ${value}`,
      );
    }
  }
  for (const section of copy[lang].filter((section: any) =>
    [1, 3, 7, 9, 10].includes(section.number),
  )) {
    for (const [key, values] of Object.entries(section.groups)) {
      if (
        [
          "Кнопки",
          "Кнопка",
          "Подвал",
          "Главы",
          "Крупно",
          "Цифры",
          "Строка доверия",
        ].includes(key)
      )
        continue;
      for (const value of values as string[])
        assert.ok(content.includes(plain(value)), `${home}: V7 copy: ${value}`);
    }
  }
}
// Home pages: no emoji anywhere outside the chat. Other pages render the repo docs as
// written, so only their header and footer are checked.
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const home = /^(ru\/)?index\.html$/.test(path.relative(dist, page));
  const scope = home
    ? outsideChat(html)
    : [
        ...(html.match(/<header class="header[\s\S]*?<\/header>/) || []),
        ...(html.match(/<footer class="footer[\s\S]*?<\/footer>/) || []),
      ].join("");
  assert.deepEqual(
    findEmoji(scope),
    [],
    `${path.relative(dist, page)}: emoji outside the chat`,
  );
}
console.log(
  `HTML: ${pages.length} pages; ${json} JSON-LD blocks parsed; 6 FAQ entries per locale; ${links} internal references checked.`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("PASS");
