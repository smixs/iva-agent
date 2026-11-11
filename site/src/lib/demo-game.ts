// "Grow a willow": the game Iva sends for the taxi ride. A cloud drifts over the tree; a tap lets
// its drop fall, and a drop that lands on the crown makes the willow taller. The film plays it by
// its own frame; the visitor's first tap takes the game over.
export const GAME_W = 116, GAME_H = 72;
// Film frames per game tick, and how long the film's player keeps tapping.
export const GAME_STEP = 2, GAME_TICKS = 250, GAME_REST = 330;
const GROUND = 62, CENTER = 58, LEFT = 12, RIGHT = 104, TOP_LEVEL = 7;

export type Game = {
  tick: number; x: number; dir: 1 | -1; drop: { x: number; y: number } | null;
  score: number; taps: number; flash: number; splash: { x: number; y: number; age: number } | null;
};
export const freshGame = (): Game => ({ tick: 0, x: LEFT + 2, dir: 1, drop: null, score: 0, taps: 0, flash: 0, splash: null });
const level = (game: Game) => Math.min(game.score, TOP_LEVEL);
const speed = (game: Game) => 2.2 + Math.min(game.score, 14) * 0.45;
function tree(game: Game) {
  const lv = level(game);
  const trunk = 6 + lv * 2, rx = 6 + lv * 1.75, ry = 5 + lv * 1.25;
  return { trunk, rx, ry, cy: GROUND - trunk - ry + 2 };
}
// One tick. `tap` lets the drop go if the cloud still holds it.
export function stepGame(game: Game, tap: boolean): void {
  game.tick++;
  if (game.flash) game.flash--;
  if (game.splash && ++game.splash.age > 5) game.splash = null;
  game.x += game.dir * speed(game);
  if (game.x >= RIGHT) { game.x = RIGHT; game.dir = -1; }
  if (game.x <= LEFT) { game.x = LEFT; game.dir = 1; }
  if (tap && !game.drop) { game.drop = { x: Math.round(game.x), y: 10 }; game.taps++; }
  const drop = game.drop;
  if (!drop) return;
  drop.y += 3;
  const { rx, ry, cy } = tree(game);
  const dx = drop.x - CENTER;
  if (Math.abs(dx) <= rx && drop.y >= cy - ry * Math.sqrt(1 - (dx / rx) ** 2)) {
    game.score++;
    game.flash = 7;
    game.drop = null;
  } else if (drop.y >= GROUND - 1) {
    game.splash = { x: drop.x, y: GROUND - 1, age: 0 };
    game.drop = null;
  }
}
// The film's player: waits for the cloud to reach the tree, and lets one drop go too early.
export function botTaps(game: Game): boolean {
  if (game.drop || game.tick < 24 || game.tick > GAME_TICKS) return false;
  const reach = speed(game) / 2 + 0.5;
  const aim = game.taps === 3 ? CENTER - game.dir * (tree(game).rx + 9) : CENTER;
  return Math.abs(game.x + game.dir * speed(game) - aim) <= reach;
}
// Film frames, counted from the game's start, at which the film's player taps.
export function filmTaps(): number[] {
  const game = freshGame(), taps: number[] = [];
  while (game.tick < GAME_TICKS) {
    const tap = botTaps(game);
    if (tap) taps.push(game.tick * GAME_STEP);
    stepGame(game, tap);
  }
  return taps;
}

const STARS = [[9, 14], [23, 6], [38, 21], [79, 17], [92, 8], [107, 24], [101, 38], [14, 36]];
function draw(ctx: CanvasRenderingContext2D, game: Game) {
  const rect = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
  rect(0, 0, GAME_W, GAME_H, "#0f2233");
  STARS.forEach(([x, y], i) => rect(x, y, 1, 1, (game.tick + i * 9) % 40 < 30 ? "#3f78ab" : "#d6e7f5"));
  rect(0, GROUND, GAME_W, 1, "#86c140");
  rect(0, GROUND + 1, GAME_W, 1, "#5a9a30");
  rect(0, GROUND + 2, GAME_W, GAME_H - GROUND - 2, "#1d3d2a");
  const { trunk, cy } = tree(game);
  const swell = game.flash > 3 ? 1 : 0;
  const rx = tree(game).rx + swell, ry = tree(game).ry + swell;
  rect(CENTER - 1, GROUND - trunk, 1, trunk, "#3f78ab");
  rect(CENTER, GROUND - trunk, 1, trunk, "#2b6291");
  rect(CENTER + 1, GROUND - trunk, 1, trunk, "#1f4d75");
  // The strands hang from the crown's lower edge and sway.
  for (let sx = Math.ceil(CENTER - rx) + 1; sx <= CENTER + rx - 1; sx += 2) {
    const dx = sx - CENTER;
    if (Math.abs(dx) < 2) continue;
    const from = cy + ry * Math.sqrt(1 - (dx / rx) ** 2);
    const length = 3 + (Math.abs(sx * 7) % 5) + level(game);
    for (let j = 0; j < length && from + j < GROUND - 1; j++) {
      const sway = Math.round(Math.sin(game.tick * 0.12 + sx * 0.5) * j / length * 1.3);
      rect(sx + sway, from + j, 1, 1, (sx + j) % 3 ? "#86c140" : "#a4dc55");
    }
  }
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.floor(CENTER - rx); x <= CENTER + rx; x++) {
      const nx = (x - CENTER) / rx, ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      const shade = ny + nx * 0.35;
      rect(x, y, 1, 1, shade < -0.4 ? "#c9ea96" : shade < 0.3 ? "#a4dc55" : "#86c140");
    }
  }
  if (game.flash) {
    const r = 9 - game.flash;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1.4, .2], [1.4, .2], [0, -1.5]]) rect(CENTER + dx * (rx + r), cy - ry * 0.4 + dy * (ry * 0.6 + r), 1, 1, "#ffffff");
  }
  const cx = Math.round(game.x);
  rect(cx - 3, 3, 6, 1, "#d6e7f5");
  rect(cx - 6, 4, 12, 2, "#d6e7f5");
  rect(cx - 5, 6, 10, 1, "#62a2dc");
  if (game.drop) {
    rect(game.drop.x, game.drop.y - 3, 1, 1, "#d6e7f5");
    rect(game.drop.x - 1, game.drop.y - 2, 2, 2, "#62a2dc");
  } else {
    rect(cx - 1, 8, 2, 2, "#62a2dc");
  }
  if (game.splash) {
    const { x, y, age } = game.splash;
    for (const side of [-1, 1]) rect(x + side * (1 + age), y - Math.max(0, 2 - Math.abs(age - 2)), 1, 1, "#d6e7f5");
  }
}

// The game on the page. `changed` is called when the visitor starts or stops playing.
export function mountGame(root: HTMLElement, changed: () => void, signal: AbortSignal) {
  const canvas = root.querySelector<HTMLCanvasElement>("canvas[data-game]");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return null;
  const score = root.querySelector<HTMLElement>("[data-game-score]")!;
  const hint = root.querySelector<HTMLElement>("[data-game-hint]")!;
  const button = root.querySelector<HTMLButtonElement>("[data-game-tap]")!;
  const taps = filmTaps();
  let game = freshGame();
  let live = false, holding = false, drawn = -1, lastTap = 0, lastTime = 0, debt = 0, raf = 0, pending = false;
  const paint = () => {
    if (drawn === game.tick) return;
    drawn = game.tick;
    draw(ctx, game);
    const value = String(game.score);
    if (score.textContent !== value) score.textContent = value;
  };
  function loop(now: number) {
    raf = 0;
    debt = Math.min(200, debt + now - lastTime);
    lastTime = now;
    while (debt >= 1000 / 30) {
      stepGame(game, pending);
      pending = false;
      debt -= 1000 / 30;
    }
    paint();
    // The film goes on once the visitor has left the game alone for a while.
    if (now - lastTap > 3500 && !game.drop) { holding = false; changed(); return; }
    raf = requestAnimationFrame(loop);
  }
  function tap() {
    if (!live) { live = true; hint.hidden = true; }
    pending = true;
    lastTap = lastTime = performance.now();
    if (holding) return;
    holding = true;
    debt = 0;
    raf = requestAnimationFrame(loop);
    changed();
  }
  button.addEventListener("pointerdown", event => { if (event.button === 0) tap(); }, { signal });
  // A keyboard press arrives as a click with no pointer behind it.
  button.addEventListener("click", event => { if (event.detail === 0) tap(); }, { signal });
  signal.addEventListener("abort", () => cancelAnimationFrame(raf));
  return {
    canvas, taps,
    live: () => live,
    holding: () => holding,
    // The film's own game at `frames` film frames after its start.
    render(frames: number) {
      if (live) return;
      const tick = Math.max(0, Math.min(GAME_REST, Math.floor(frames / GAME_STEP)));
      if (tick < game.tick) game = freshGame();
      while (game.tick < tick) stepGame(game, botTaps(game));
      paint();
    },
    reset() {
      cancelAnimationFrame(raf);
      raf = 0;
      game = freshGame();
      live = holding = pending = false;
      hint.hidden = false;
      drawn = -1;
    },
  };
}
