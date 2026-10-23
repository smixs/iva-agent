import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cellVisible, inWindow, renderScene, type Scene } from "./mosaic.ts";
test("memory card windows include the start, exclude the end and wrap through zero", () => {
  assert.equal(inWindow(0.2, 0.2, 0.6), true);
  assert.equal(inWindow(0.6, 0.2, 0.6), false);
  assert.equal(inWindow(0.9, 0.8, 0.1), true);
  assert.equal(inWindow(0.05, 0.8, 0.1), true);
  assert.equal(inWindow(0.5, 0.8, 0.1), false);
});
test("pixel threshold and phase follow the supplied display-list formula", () => {
  const c = {
    x: 0,
    y: 0,
    c: "#368AD2",
    o: 1,
    n: 0.7,
    g: 1,
    b: 0.5,
    k: 1,
    p: 0,
  };
  assert.equal(cellVisible(c, 0.25), true);
  assert.equal(cellVisible(c, 0.75), false);
});
test("inside glitch draws the full photo and clips moving bands to the unshifted frame", () => {
  const rectangles: number[][] = [],
    draws: any[] = [];
  const context = {
    canvas: { width: 1200 },
    save() {},
    restore() {},
    beginPath() {},
    clip() {},
    rect(...args: number[]) {
      rectangles.push(args);
    },
    setTransform() {},
    fillRect() {},
    drawImage(...args: any[]) {
      draws.push(args);
    },
  } as unknown as CanvasRenderingContext2D;
  const scene: Scene = {
    size: [1200, 1500],
    background: "#FFFFFF",
    loop_seconds: 5,
    still_t: 0,
    layers: [
      {
        type: "glitch",
        inside: true,
        src: "photo",
        x: 240,
        y: 140,
        w: 840,
        h: 1160,
        bands: [
          { y: 140, h: 200, dx: 0, amp: 0, k: 1, p: 0 },
          { y: 340, h: 100, dx: 20, amp: 10, k: 1, p: 0 },
        ],
      },
    ],
  };
  renderScene(
    context,
    scene,
    0.25,
    new Map([["photo", {} as CanvasImageSource]]),
  );
  assert.equal(draws.length, 2);
  assert.deepEqual(rectangles, [[240, 340, 840, 100]]);
  assert.equal(draws[1][1], 270);
});
test("final scenes keep at most two green pixels and the userbot keeps inside clipping", () => {
  for (const id of [
    "hero",
    "hero-mobile",
    "memory",
    "memory-mobile",
    "writes-first",
    "userbot",
    "privacy",
    "install",
    "price",
  ]) {
    const scene = JSON.parse(
      readFileSync(
        new URL(`../data/mosaics/${id}.json`, import.meta.url),
        "utf8",
      ),
    );
    const green = scene.layers
      .flatMap((l: any) => l.items || [])
      .filter((p: any) => p.c === "#A4DC55");
    assert.ok(green.length <= 2, id);
    if (id === "userbot") assert.equal(scene.layers[0].inside, true);
  }
});
