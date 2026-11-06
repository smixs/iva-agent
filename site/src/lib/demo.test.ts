import assert from "node:assert/strict";
import test from "node:test";
import { demoMessages, demoMenuEntries } from "../data/demo.ts";
import { DEMO_FRAMES, actions, advance, choose, demoFrame, filmFrame, freshDemo, freshInteractions, menuCommand, selectInstall, selectInstallFromButton, beginInstallCopy, finishInstallCopy, replayInteractions, iosPush, chatAt, springAt, tapPhase } from "./demo-state.ts";

test("phone footage keeps scene order; the team brief and Marina fill the stretch of the film's titles", () => {
  assert.equal(filmFrame(0), 360);
  assert.equal(filmFrame(179), 539);
  assert.equal(filmFrame(180), 540);
  assert.equal(filmFrame(1499), 1859);
  assert.equal(filmFrame(1500), 1980);
  assert.equal(filmFrame(2280), 2880);
  assert.equal(filmFrame(DEMO_FRAMES), 6240);
  for (const frame of [360, 595, 970, 1240, 2060, 2420, 2950, 3220, 3640, 3950, 4226, 4380, 4660, 4950, 5320, 5710, 6000]) assert.equal(filmFrame(demoFrame(frame)), frame);
  assert.deepEqual(demoMessages("ru").map(m => m.id), ["morning", "team", "marina", "voice", "crm", "who-ask", "who", "reminder", "flight-ask", "taxi", "invoice", "restaurant", "shopping", "goal-ask", "goal", "next-day", "done", "ads", "stock", "payment", "contract-ask", "contract", "post-ask", "post", "summary"]);
});
test("every autoplay contact selects the affirmative branch exactly once", () => {
  const state = freshDemo();
  advance(state, DEMO_FRAMES);
  assert.equal(Object.keys(state.decisions).length, 11);
  for (const id of actions) {
    assert.equal(state.decisions[id]?.value, "yes");
    assert.equal(state.decisions[id]?.source, "auto");
    assert.equal(choose(state, id, "no"), false);
  }
});
test("a user decline wins against future automatic clicks, double clicks and opposite clicks", () => {
  const state = freshDemo();
  advance(state, demoFrame(2180));
  assert.equal(choose(state, "reminder", "no"), true);
  const decision = state.decisions.reminder;
  assert.equal(choose(state, "reminder", "yes"), false);
  advance(state, DEMO_FRAMES);
  assert.equal(state.decisions.reminder, decision);
  assert.equal(decision?.value, "no");
  assert.equal(decision?.source, "user");
});
test("declining restaurant never opens Maria, delivers a venue or claims confirmation", () => {
  const state = freshDemo();
  advance(state, demoFrame(3300));
  choose(state, "restaurant", "no");
  for (const f of [3300, 3392, 3440, 3500, 3530, 3640, 4380]) {
    assert.deepEqual(chatAt(state, "maria", f), { pushed: false, p: 0, venue: false, confirmed: false });
  }
});
test("accepting restaurant follows the film push, delivery and pop relative to the winning contact", () => {
  const state = freshDemo();
  advance(state, demoFrame(3362));
  assert.equal(state.decisions.restaurant?.at, 3362);
  assert.equal(chatAt(state, "maria", 3392).p, 0);
  assert.equal(chatAt(state, "maria", 3426).p, 1);
  assert.equal(chatAt(state, "maria", 3439).venue, false);
  assert.equal(chatAt(state, "maria", 3440).venue, true);
  assert.equal(chatAt(state, "maria", 3499).confirmed, false);
  assert.equal(chatAt(state, "maria", 3500).confirmed, true);
  assert.equal(chatAt(state, "maria", 3564).p, 0);
});
test("manual reduced-motion advances leave buttons available until the reader chooses", () => {
  const state = freshDemo();
  advance(state, demoFrame(2190), false);
  assert.deepEqual(state.decisions, {});
  choose(state, "reminder", "no");
  advance(state, demoFrame(2580), false);
  assert.equal(state.decisions.reminder?.value, "no");
  assert.equal(state.decisions.taxi, undefined);
});
test("replay owns a fresh empty decision set and does not mutate the previous showing", () => {
  const old = freshDemo();
  advance(old, DEMO_FRAMES);
  const next = freshDemo();
  assert.deepEqual(next, { frame: 0, decisions: {} });
  assert.equal(Object.keys(old.decisions).length, 11);
});
test("film spring, word ramp, iOS push and tap retain exact end states and a small landing overshoot", () => {
  assert.equal(springAt(9, 10, "arrive"), 0);
  assert.equal(springAt(10, 10, "arrive"), 0);
  assert.ok(springAt(15, 0, "land") > 1);
  assert.equal(springAt(180, 0, "arrive"), 1);
  assert.equal(iosPush(10, 10), 0);
  assert.equal(iosPush(44, 10), 1);
  assert.deepEqual(tapPhase(9, 10), { d: 0, opacity: 0, pressed: 0 });
  assert.equal(tapPhase(100, 10).opacity, 0);
});

test("every negative choice remains negative when the complete autoplay catches up", () => {
  for (const id of actions) {
    const state = freshDemo();
    const at = { marina: 1075, reminder: 2190, taxi: 2580, invoice: 3080, restaurant: 3340, shopping: 3780, ads: 4510, stock: 4790, payment: 5090, contract: 5470, post: 5850 }[id];
    advance(state, demoFrame(at));
    assert.equal(choose(state, id, "no"), true);
    advance(state, DEMO_FRAMES);
    assert.equal(state.decisions[id]?.value, "no");
    assert.equal(state.decisions[id]?.source, "user");
    assert.equal(choose(state, id, "yes"), false);
    for (const other of actions.filter(value => value !== id)) assert.equal(state.decisions[other]?.value, "yes");
  }
});
test("Marina's card takes any of its three answers once, and autoplay answers with the first", () => {
  for (const pick of ["yes", "no", "open"] as const) {
    const state = freshDemo();
    advance(state, demoFrame(1075));
    assert.equal("marina" in state.decisions, false);
    assert.equal(choose(state, "marina", pick), true);
    assert.equal(choose(state, "marina", pick === "yes" ? "open" : "yes"), false);
    advance(state, DEMO_FRAMES);
    assert.equal(state.decisions.marina?.value, pick);
  }
  const auto = freshDemo();
  advance(auto, DEMO_FRAMES);
  assert.equal(auto.decisions.marina?.value, "yes");
  assert.equal(auto.decisions.marina?.at, 1097);
});
test("opening Marina's chat slides it in and back like Maria's, while her card's answer lands", () => {
  const state = freshDemo();
  advance(state, demoFrame(1060));
  assert.equal(choose(state, "marina", "open"), true);
  assert.equal(chatAt(state, "marina", 1090).p, 0);
  assert.equal(chatAt(state, "marina", 1124).p, 1);
  assert.equal(chatAt(state, "marina", 1124).venue, false);
  assert.equal(chatAt(state, "marina", 1197).confirmed, false);
  assert.equal(chatAt(state, "marina", 1198).confirmed, true);
  assert.equal(chatAt(state, "marina", 1262).p, 0);
  assert.equal(chatAt(state, "maria", 1124).pushed, false);
  for (const pick of ["yes", "no"] as const) {
    const other = freshDemo();
    advance(other, demoFrame(1060));
    choose(other, "marina", pick);
    for (const f of [1090, 1124, 1198, 1300]) assert.deepEqual(chatAt(other, "marina", f), { pushed: false, p: 0, venue: false, confirmed: false });
  }
  const auto = freshDemo();
  advance(auto, DEMO_FRAMES);
  assert.equal(chatAt(auto, "marina", 1124).pushed, false);
});

test("menu model changes wait for restart confirmation and reject stale or unsupported selections", () => {
  const state = freshInteractions("ru");
  assert.equal(menuCommand(state, "model:gpt-6-sol"), false);
  menuCommand(state, "open");
  menuCommand(state, "root:model");
  menuCommand(state, "provider:claude");
  assert.equal(menuCommand(state, "model:invented-model"), false);
  assert.equal(menuCommand(state, "model:claude-sonnet-5-5"), true);
  assert.equal(state.menu, "restart");
  assert.equal(state.provider, "codex");
  assert.equal(state.model, "gpt-6.1-sol");
  assert.equal(menuCommand(state, "restart:yes"), true);
  assert.equal(state.provider, "claude");
  assert.equal(state.model, "claude-sonnet-5-5");
  assert.equal(state.pending, null);
  assert.equal(state.restarted, true);
  assert.equal(menuCommand(state, "restart:yes"), false);
});
test("menu notices are idempotent and language changes immediately in the same menu", () => {
  const state = freshInteractions("ru");
  menuCommand(state, "open");
  menuCommand(state, "root:notices");
  menuCommand(state, "notices:0");
  menuCommand(state, "notices:0");
  assert.equal(state.writes, false);
  assert.equal(menuCommand(state, "notices:other"), false);
  menuCommand(state, "back");
  menuCommand(state, "root:language");
  assert.equal(menuCommand(state, "language:en"), true);
  assert.equal(state.language, "en");
  assert.equal(state.menu, "root");
  assert.equal(state.writes, false);
  assert.equal(menuCommand(state, "language:ru"), false);
});
test("all shown root menu entries navigate and provide a working return path", () => {
  for (const entry of Object.keys(demoMenuEntries)) {
    const state = freshInteractions("en");
    menuCommand(state, "open");
    assert.equal(menuCommand(state, `root:${entry}`), true);
    assert.equal(state.menu, entry);
    assert.equal(menuCommand(state, "back"), true);
    assert.equal(state.menu, "root");
    assert.equal(menuCommand(state, "close"), true);
    assert.equal(state.menu, null);
  }
});
test("closing menu discards an unconfirmed model while preserving applied preferences", () => {
  const state = freshInteractions("en");
  menuCommand(state, "open");
  menuCommand(state, "root:model");
  menuCommand(state, "provider:ollama");
  menuCommand(state, "model:deepseek-v4-pro");
  menuCommand(state, "close");
  assert.equal(state.provider, "codex");
  assert.equal(state.model, "gpt-6.1-sol");
  assert.equal(state.pending, null);
  assert.equal(state.menu, null);
});
test("end installation choice is single-assignment and denial never reports a successful copy", () => {
  const state = freshInteractions("ru");
  assert.equal(finishInstallCopy(state, true), false);
  assert.equal(selectInstall(state, true), true);
  assert.equal(state.copy, "pending");
  assert.equal(selectInstall(state, false), false);
  assert.equal(finishInstallCopy(state, false), true);
  assert.equal(state.copy, "denied");
  assert.equal(finishInstallCopy(state, true), false);
  const declined = freshInteractions("en");
  selectInstall(declined, false);
  assert.equal(declined.copy, "idle");
  assert.equal(finishInstallCopy(declined, true), false);
});
test("replay clears end CTA and menu transient state while retaining chosen local settings", () => {
  const state = freshInteractions("ru");
  menuCommand(state, "open");
  menuCommand(state, "root:notices");
  menuCommand(state, "notices:0");
  selectInstall(state, true);
  finishInstallCopy(state, true);
  const replayed = replayInteractions(state);
  assert.equal(replayed.menu, null);
  assert.equal(replayed.install, null);
  assert.equal(replayed.copy, "idle");
  assert.equal(replayed.writes, false);
  assert.equal(replayed.language, "ru");
  assert.equal(replayed.model, state.model);
  assert.equal(state.install, true);
});

test("final CTA ignores bubbled Next/root status and unrelated clicks until an answer button is pressed", () => {
  const state = freshInteractions("ru");
  for (const installChoice of ["", "no", "yes"]) {
    assert.equal(selectInstallFromButton(state, { tagName: "FIGURE", dataset: { installChoice } }), false);
    assert.equal(state.install, null);
  }
  assert.equal(selectInstallFromButton(state, { tagName: "BUTTON", dataset: {} }), false);
  assert.equal(selectInstallFromButton(state, null), false);
  assert.equal(state.install, null);
  assert.equal(selectInstallFromButton(state, { tagName: "BUTTON", dataset: { installChoice: "yes" } }), true);
  assert.equal(state.install, true);
  assert.equal(state.copy, "pending");
  const declined = freshInteractions("en");
  assert.equal(selectInstallFromButton(declined, { tagName: "BUTTON", dataset: { installChoice: "no" } }), true);
  assert.equal(declined.install, false);
});

test("blue menu toggles close from a nested screen and keeps its first-open hint dismissed on replay", () => {
  const state = freshInteractions("ru");
  assert.equal(state.menuSeen, false);
  assert.equal(menuCommand(state, "toggle"), true);
  assert.equal(state.menu, "root");
  assert.equal(state.menuSeen, true);
  menuCommand(state, "root:model");
  menuCommand(state, "provider:claude");
  menuCommand(state, "model:claude-opus-5-5");
  assert.equal(menuCommand(state, "toggle"), true);
  assert.equal(state.menu, null);
  assert.equal(state.pending, null);
  assert.equal(state.model, "gpt-6.1-sol");
  assert.equal(replayInteractions(state).menuSeen, true);
});
test("menu installation uses the same copy result flow and permits an explicit retry after No or clipboard denial", () => {
  const state = freshInteractions("ru");
  selectInstall(state, false);
  assert.equal(beginInstallCopy(state), true);
  assert.equal(state.install, true);
  assert.equal(state.copy, "pending");
  assert.equal(beginInstallCopy(state), false);
  assert.equal(finishInstallCopy(state, false), true);
  assert.equal(state.copy, "denied");
  assert.equal(beginInstallCopy(state), true);
  assert.equal(finishInstallCopy(state, true), true);
  assert.equal(state.copy, "copied");
});
