import assert from "node:assert/strict";
import test from "node:test";
import { T, actionFrames, demoMessages, demoMenuEntries, widgetFrames } from "../data/demo.ts";
import { GAME_TICKS, botTaps, filmTaps, freshGame, stepGame } from "./demo-game.ts";
import { DEMO_FRAMES, actions, advance, choose, demoFrame, filmFrame, freshDemo, freshInteractions, menuCommand, selectInstall, selectInstallFromButton, beginInstallCopy, finishInstallCopy, replayInteractions, iosPush, chatAt, offered, sceneAt, sceneFrames, springAt, tapPhase } from "./demo-state.ts";

test("phone footage keeps scene order; the team brief and Helga fill the stretch of the film's titles", () => {
  assert.equal(filmFrame(0), 360);
  assert.equal(filmFrame(179), 539);
  assert.equal(filmFrame(180), 540);
  const first = T(1860) - 360;
  assert.equal(filmFrame(first - 1), T(1860) - 1);
  assert.equal(filmFrame(first), T(1980));
  assert.equal(filmFrame(first + T(2760) - T(1980)), T(2880));
  assert.equal(filmFrame(DEMO_FRAMES), T(6240));
  for (const frame of [360, 595, 970, 1240, 2060, 2420, 2950, 3220, 3640, 3950, 4226, 4380, 4660, 4950, 5320, 5710, 6000].map(T)) assert.equal(filmFrame(demoFrame(frame)), frame);
  for (const frame of [widgetFrames.weather, widgetFrames.game, widgetFrames.order]) assert.equal(filmFrame(demoFrame(frame)), frame);
  const messages = demoMessages("ru");
  assert.deepEqual(messages.map(m => m.id), ["morning", "weather", "team", "helga", "voice", "crm", "who-ask", "who", "reminder", "flight-ask", "taxi", "game", "invoice", "restaurant", "shopping", "order", "goal-ask", "goal", "next-day", "done", "ads", "stock", "payment", "contract-ask", "contract", "post-ask", "post", "summary"]);
  messages.forEach((message, i) => assert.ok(i === 0 || message.at > messages[i - 1].at, message.id));
});
test("the widget scenes are frames added to the film: its own frames only move later", () => {
  assert.deepEqual([539, 540, 2759, 2760, 3949, 3950].map(T), [539, 740, 2959, 3620, 4809, 5240]);
  assert.equal(sceneFrames.length, 22);
  sceneFrames.forEach((at, scene) => {
    assert.ok(scene === 0 || at > sceneFrames[scene - 1]);
    assert.equal(sceneAt(at), scene);
  });
});
test("the game comes only with the taxi and the order only with the list: a decline passes over them", () => {
  // The taxi's stretch ends on a cut of the film, so the next frame is the footage after it.
  for (const [action, hidden, next] of [["taxi", widgetFrames.game, T(2880)], ["shopping", widgetFrames.order, T(3950) - 20]] as const) {
    const state = freshDemo();
    advance(state, demoFrame(actionFrames[action]));
    choose(state, action, "no");
    advance(state, demoFrame(hidden - 61));
    assert.ok(filmFrame(state.frame) < hidden - 60);
    advance(state, state.frame + 2);
    assert.equal(filmFrame(state.frame), next);
  }
  const state = freshDemo();
  assert.equal(offered(state, "order"), false);
  assert.equal(offered(state, "taxi"), true);
  advance(state, demoFrame(actionFrames.shopping));
  choose(state, "shopping", "no");
  advance(state, DEMO_FRAMES);
  assert.equal(state.decisions.order, undefined);
  const accepted = freshDemo();
  advance(accepted, demoFrame(widgetFrames.order));
  assert.equal(offered(accepted, "order"), true);
  assert.equal(filmFrame(accepted.frame), widgetFrames.order);
});
test("the film's player grows the willow with one drop wasted, the same way on every run", () => {
  const play = () => {
    const game = freshGame();
    while (game.tick < GAME_TICKS + 40) stepGame(game, botTaps(game));
    return game;
  };
  const game = play();
  assert.deepEqual(play(), game);
  assert.equal(game.taps, filmTaps().length);
  assert.equal(game.taps - game.score, 1);
  assert.ok(game.score >= 5);
  assert.equal(game.drop, null);
  const idle = freshGame();
  for (let i = 0; i < 400; i++) stepGame(idle, false);
  assert.equal(idle.score, 0);
});
test("every autoplay contact selects the affirmative branch exactly once", () => {
  const state = freshDemo();
  advance(state, DEMO_FRAMES);
  assert.equal(Object.keys(state.decisions).length, 12);
  for (const id of actions) {
    assert.equal(state.decisions[id]?.value, "yes");
    assert.equal(state.decisions[id]?.source, "auto");
    assert.equal(choose(state, id, "no"), false);
  }
});
test("a user decline wins against future automatic clicks, double clicks and opposite clicks", () => {
  const state = freshDemo();
  advance(state, demoFrame(T(2180)));
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
  advance(state, demoFrame(T(3300)));
  choose(state, "restaurant", "no");
  for (const f of [3300, 3392, 3440, 3500, 3530, 3640, 4380].map(T)) {
    assert.deepEqual(chatAt(state, "maria", f), { pushed: false, p: 0, venue: false, confirmed: false });
  }
});
test("accepting restaurant follows the film push, delivery and pop relative to the winning contact", () => {
  const state = freshDemo();
  advance(state, demoFrame(T(3362)));
  assert.equal(state.decisions.restaurant?.at, T(3362));
  assert.equal(chatAt(state, "maria", T(3392)).p, 0);
  assert.equal(chatAt(state, "maria", T(3426)).p, 1);
  assert.equal(chatAt(state, "maria", T(3439)).venue, false);
  assert.equal(chatAt(state, "maria", T(3440)).venue, true);
  assert.equal(chatAt(state, "maria", T(3499)).confirmed, false);
  assert.equal(chatAt(state, "maria", T(3500)).confirmed, true);
  assert.equal(chatAt(state, "maria", T(3564)).p, 0);
});
test("manual reduced-motion advances leave buttons available until the reader chooses", () => {
  const state = freshDemo();
  advance(state, demoFrame(T(2190)), false);
  assert.deepEqual(state.decisions, {});
  choose(state, "reminder", "no");
  advance(state, demoFrame(T(2580)), false);
  assert.equal(state.decisions.reminder?.value, "no");
  assert.equal(state.decisions.taxi, undefined);
});
test("replay owns a fresh empty decision set and does not mutate the previous showing", () => {
  const old = freshDemo();
  advance(old, DEMO_FRAMES);
  const next = freshDemo();
  assert.deepEqual(next, { frame: 0, decisions: {} });
  assert.equal(Object.keys(old.decisions).length, 12);
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
    advance(state, demoFrame(actionFrames[id] - 10));
    assert.equal(choose(state, id, "no"), true);
    advance(state, DEMO_FRAMES);
    assert.equal(state.decisions[id]?.value, "no");
    assert.equal(state.decisions[id]?.source, "user");
    assert.equal(choose(state, id, "yes"), false);
    // Without the list there is nothing to order: that question is never asked.
    for (const other of actions.filter(value => value !== id)) assert.equal(state.decisions[other]?.value, id === "shopping" && other === "order" ? undefined : "yes");
  }
});
test("Helga's card takes any of its three answers once, and autoplay answers with the first", () => {
  for (const pick of ["yes", "no", "open"] as const) {
    const state = freshDemo();
    advance(state, demoFrame(T(1075)));
    assert.equal("helga" in state.decisions, false);
    assert.equal(choose(state, "helga", pick), true);
    assert.equal(choose(state, "helga", pick === "yes" ? "open" : "yes"), false);
    advance(state, DEMO_FRAMES);
    assert.equal(state.decisions.helga?.value, pick);
  }
  const auto = freshDemo();
  advance(auto, DEMO_FRAMES);
  assert.equal(auto.decisions.helga?.value, "yes");
  assert.equal(auto.decisions.helga?.at, T(1097));
});
test("opening Helga's chat slides it in and back like Maria's, while her card's answer lands", () => {
  const state = freshDemo();
  advance(state, demoFrame(T(1060)));
  assert.equal(choose(state, "helga", "open"), true);
  assert.equal(chatAt(state, "helga", T(1090)).p, 0);
  assert.equal(chatAt(state, "helga", T(1124)).p, 1);
  assert.equal(chatAt(state, "helga", T(1124)).venue, false);
  assert.equal(chatAt(state, "helga", T(1197)).confirmed, false);
  assert.equal(chatAt(state, "helga", T(1198)).confirmed, true);
  assert.equal(chatAt(state, "helga", T(1262)).p, 0);
  assert.equal(chatAt(state, "maria", T(1124)).pushed, false);
  for (const pick of ["yes", "no"] as const) {
    const other = freshDemo();
    advance(other, demoFrame(T(1060)));
    choose(other, "helga", pick);
    for (const f of [1090, 1124, 1198, 1300].map(T)) assert.deepEqual(chatAt(other, "helga", f), { pushed: false, p: 0, venue: false, confirmed: false });
  }
  const auto = freshDemo();
  advance(auto, DEMO_FRAMES);
  assert.equal(chatAt(auto, "helga", T(1124)).pushed, false);
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
