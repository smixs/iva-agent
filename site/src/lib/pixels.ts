// Seeded layouts for the pixel-glitch motif: square brand pixels that gather at an edge
// when it scrolls into view and shuffle on hover. Positions are fixed at build time, so the
// page is the same on every load; motion itself is CSS (global.css, "Pixel glitch").

// mulberry32, the film's seeded random (iva-demo-film/src/lib.tsx).
export const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export type Corner = "tl" | "tr" | "bl" | "br";
const COLORS = ["var(--blue)", "var(--blue-soft)", "var(--blue)", "var(--leaf)"];

// A cluster of `count` pixels around a corner. Cells sit on a grid of `cell` px; density falls
// off with distance from the corner, and a few pixels hang outside the edge, as in design-5.
export function cluster(seed: number, at: Corner, count = 11, cell = 9) {
  const rnd = mulberry(seed);
  const sx = at.endsWith("l") ? 1 : -1;
  const sy = at.startsWith("t") ? 1 : -1;
  const taken = new Set<string>();
  const out: string[] = [];
  for (let tries = 0; out.length < count && tries < 400; tries++) {
    const gx = Math.floor(Math.pow(rnd(), 1.6) * 7) - 2;
    const gy = Math.floor(Math.pow(rnd(), 1.6) * 7) - 2;
    if (gx + gy > 6) continue;
    const key = gx + ":" + gy;
    if (taken.has(key)) continue;
    taken.add(key);
    const small = rnd() < 0.22;
    const size = small ? cell / 2 : cell;
    const color =
      out.length === 3 ? "var(--leaf)" : COLORS[Math.floor(rnd() * 3)];
    const delay = Math.round((gx + gy + 2) * 45 + rnd() * 90);
    const dx = Math.round((-sx * (2 + rnd() * 5) - sx * gx) * cell);
    const dy = Math.round((-sy * (1 + rnd() * 4) - sy * gy) * cell);
    const hx = (rnd() < 0.5 ? -1 : 1) * cell;
    out.push(
      `--x:${sx * gx * cell - (sx < 0 ? size : 0)}px;--y:${sy * gy * cell - (sy < 0 ? size : 0)}px;--s:${size}px;--c:${color};--d:${delay}ms;--dx:${dx}px;--dy:${dy}px;--hx:${hx}px`,
    );
  }
  return out;
}

// Delays for a cols x rows veil over a photo: squares drop out in a noisy wave that starts
// at the corner where the pixel cluster sits.
export function veil(seed: number, at: Corner, cols = 8, rows = 6) {
  const rnd = mulberry(seed);
  const ox = at.endsWith("l") ? 0 : cols - 1;
  const oy = at.startsWith("t") ? 0 : rows - 1;
  const max = Math.hypot(cols - 1, rows - 1);
  return Array.from({ length: cols * rows }, (_, i) => {
    const x = i % cols;
    const y = Math.floor(i / cols);
    const d = (Math.hypot(x - ox, y - oy) / max) * 520 + rnd() * 220;
    return Math.round(d / 40) * 40;
  });
}
