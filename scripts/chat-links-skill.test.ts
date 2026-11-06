/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = (name: string) =>
  readFileSync(
    new URL(`../agent/skills/${name}/SKILL.md`, import.meta.url),
    "utf8",
  ).replace(/\s+/gu, " ");

test("Watch teaches message links, forum links and safe missing-data choices", () => {
  const watch = skill("watch");
  for (const example of [
    "https://t.me/c/4398169447/40",
    "https://t.me/c/4398169447/12/40",
    "https://t.me/public_team/40",
  ])
    assert.ok(watch.includes(example), example);
  assert.match(watch, /message_id is unknown[^.]*omit the chat URL button/u);
  assert.match(
    watch,
    /person without a username[^.]*name in the text[^.]*omit the chat URL button/u,
  );
  assert.match(watch, /get_message_link/u);
  assert.doesNotMatch(watch, /→ `https:\/\/t\.me\/c\/<n>`/u);
  assert.doesNotMatch(watch, /→ `tg:\/\/user\?id=/u);
});

test("Brief and rich replies use Watch's common chat link rules", () => {
  for (const name of ["brief", "rich-replies"])
    assert.match(skill(name), /chat links[^.]*watch/iu);
});
