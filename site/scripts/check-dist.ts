import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { files } from "../src/lib/build.ts";
const dist = path.resolve("dist");
const copy = JSON.parse(readFileSync("src/data/copy.json", "utf8"));
const scenes = JSON.parse(readFileSync("src/data/scenes.json", "utf8"));
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
  assert.equal((visible.match(/class="review"/g) || []).length, 11);
  const lang = home.includes("/ru/") ? "ru" : "en";
  assert.equal((visible.match(/class="scene-card"/g) || []).length, 12);
  const main = visible.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)![1];
  const headings = [...main.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
    plain(m[1]),
  );
  assert.deepEqual(
    headings,
    copy[lang].slice(2).map((section: any) => section.groups.H2[0]),
  );
  const content = plain(visible);
  for (const scene of scenes[lang]) {
    for (const value of [
      scene.caption,
      ...scene.messages.map((m: any) => m.text),
      ...scene.buttons,
    ]) {
      assert.ok(
        content.includes(plain(value)),
        `${home}: missing scene copy: ${value}`,
      );
    }
  }
  for (const section of copy[lang].slice(1)) {
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
        assert.ok(content.includes(plain(value)), `${home}: v2 copy: ${value}`);
    }
  }
}
console.log(
  `HTML: ${pages.length} pages; ${json} JSON-LD blocks parsed; 10 FAQ entries per locale; ${links} internal references checked.`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("PASS");
