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
// Photo edges in design-5 carry a ladder of pixels, about half of them green.
const EDGE = ["var(--blue)", "var(--leaf)", "var(--leaf-deep)", "var(--blue-soft)"];

// A cluster of `count` pixels around a corner. Cells sit on a grid of `cell` px; density falls
// off with distance from the corner, and a few pixels hang outside the edge, as in design-5.
export function cluster(
  seed: number,
  at: Corner,
  count = 11,
  cell = 9,
  edge = false,
) {
  const rnd = mulberry(seed);
  const sx = at.endsWith("l") ? 1 : -1;
  const sy = at.startsWith("t") ? 1 : -1;
  const taken = new Set<string>();
  const out: string[] = [];
  for (let tries = 0; out.length < count && tries < 400; tries++) {
    // A compact clump at the corner, or (edge) a ladder running down the vertical edge.
    const gx = edge
      ? Math.floor(Math.pow(rnd(), 1.6) * 3) - 1
      : Math.floor(Math.pow(rnd(), 1.6) * 7) - 2;
    const gy = edge
      ? Math.floor(Math.pow(rnd(), 1.2) * 12) - 1
      : Math.floor(Math.pow(rnd(), 1.6) * 7) - 2;
    if (gx + gy > (edge ? 12 : 6)) continue;
    const key = gx + ":" + gy;
    if (taken.has(key)) continue;
    taken.add(key);
    // Half-size pixels only where they stay whole device pixels.
    const small = rnd() < (edge ? 0.1 : 0.22) && cell >= 8;
    const size = small ? cell / 2 : cell;
    const color = edge
      ? EDGE[Math.floor(rnd() * 4)]
      : out.length === 3
        ? "var(--leaf)"
        : COLORS[Math.floor(rnd() * 3)];
    const delay = Math.round((gx + gy + 4) * 40 + rnd() * 90);
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

// 5 x 7 pixel glyphs for review monograms. Cyrillic letters that look like Latin ones
// share a bitmap. Unknown letters fall back to a full block.
const G: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001",
  B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01111 10000 10000 10000 10000 10000 01111",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 10101 10011 10001 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  Д: "00110 01010 01010 01010 01010 11111 10001",
  И: "10001 10001 10011 10101 11001 10001 10001",
  Л: "00111 01001 01001 01001 01001 01001 11001",
  Ш: "10101 10101 10101 10101 10101 10101 11111",
};
const SAME: Record<string, string> = {
  А: "A", В: "B", С: "C", Е: "E", Н: "H", К: "K", М: "M", О: "O", Р: "P", Т: "T",
};
export function initials(letters: string) {
  const cells: [number, number][] = [];
  const chars = [...letters.toUpperCase()].slice(0, 2);
  chars.forEach((ch, n) => {
    const rows = (G[SAME[ch] ?? ch] ?? "11111 11111 11111 11111 11111 11111 11111").split(" ");
    rows.forEach((row, y) =>
      [...row].forEach((bit, x) => bit === "1" && cells.push([n * 6 + x, y])),
    );
  });
  return { w: chars.length * 6 - 1, cells };
}
