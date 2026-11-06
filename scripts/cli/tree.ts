import { readFileSync as nodeReadFileSync } from "node:fs";
import { join } from "node:path";

const TREE_RAMP = " .:;!icoa*xw#%$&@"; // the same set as the art generator
const TREE_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type TreeSignal = (typeof TREE_SIGNALS)[number];
type TreeBackgroundCell = { readonly ch: string; readonly bg: true };
type TreeColorCell = {
  readonly ch: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly bg?: false;
};
type TreeCell = TreeBackgroundCell | TreeColorCell;
export type TreeGrid = TreeCell[][];

type TreeOutput = {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(text: string): unknown;
};

type TreeEnvironment = Readonly<Record<string, string | undefined>>;

type TreeDependencies = {
  readonly stdout?: TreeOutput;
  readonly env?: TreeEnvironment;
  readonly readFile?: (path: string) => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly once?: (signal: TreeSignal, handler: () => void) => unknown;
  readonly removeListener?: (
    signal: TreeSignal,
    handler: () => void,
  ) => unknown;
  readonly kill?: (pid: number, signal: TreeSignal) => unknown;
  readonly pid?: number;
};

/** Create the ANSI tree renderer without reading install.sh or touching the terminal. */
export function createTreeRenderer(
  root: string,
  dependencies: TreeDependencies = {},
) {
  const readFile =
    dependencies.readFile ??
    ((path: string): string => nodeReadFileSync(path, "utf8"));
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const once =
    dependencies.once ??
    ((signal: TreeSignal, handler: () => void) =>
      process.once(signal, handler));
  const removeListener =
    dependencies.removeListener ??
    ((signal: TreeSignal, handler: () => void) =>
      process.removeListener(signal, handler));
  const kill =
    dependencies.kill ??
    ((pid: number, signal: TreeSignal) => process.kill(pid, signal));

  // Parse the heredoc into a grid of cells: {ch,r,g,b} for a colored glyph, {ch:" ",bg} for background.
  function loadTreeGrid(): TreeGrid | null {
    const sh = readFile(join(root, "install.sh"));
    const body = sh.split("<<'IVA_TREE'\n")[1]?.split("\nIVA_TREE")[0];
    if (!body) return null;
    // eslint-disable-next-line no-control-regex -- The install art contains literal ANSI escape sequences.
    const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S])|\x1b\[0m|([\s\S])/g;
    return body
      .replace(/\\033/g, "\x1b")
      .split("\n")
      .map((line) => {
        const cells: TreeCell[] = [];
        let match: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((match = re.exec(line))) {
          if (match[4] !== undefined)
            cells.push({
              ch: match[4],
              r: +match[1],
              g: +match[2],
              b: +match[3],
            });
          else if (match[5] !== undefined)
            cells.push({ ch: match[5], bg: true });
        }
        return cells;
      });
  }

  const clampByte = (value: number): number =>
    value < 0 ? 0 : value > 255 ? 255 : value;
  const clamp = (value: number, low: number, high: number): number =>
    value < low ? low : value > high ? high : value;

  // One frame. live=false → reference (no sway/shimmer) for the final resting state.
  function renderTreeFrame(
    grid: TreeGrid,
    time: number,
    live: boolean,
  ): string {
    const rows = grid.length;
    let out = "";
    for (let y = 0; y < rows; y++) {
      const cells = grid[y];
      let lead = 0;
      while (lead < cells.length && cells[lead].bg) lead++;
      let last = cells.length - 1;
      while (last >= 0 && cells[last].bg) last--;
      // the tree stays still — only the glyphs and their colors come alive
      let line = " ".repeat(lead);
      for (let x = lead; x <= last; x++) {
        const cell = cells[x];
        if (cell.bg) {
          line += " ";
          continue;
        }
        let { r, g, b, ch } = cell;
        if (live) {
          const shimmer = 1 + 0.16 * Math.sin(time * 0.6 + x * 0.45 + y * 0.3); // brightness shimmer
          r = clampByte(Math.round(r * shimmer));
          g = clampByte(Math.round(g * shimmer));
          b = clampByte(Math.round(b * shimmer));
          const index = TREE_RAMP.indexOf(ch); // glyph breathes ±1 along the ramp (not into background)
          if (index > 0)
            ch =
              TREE_RAMP[
                clamp(
                  index +
                    Math.round(0.9 * Math.sin(time * 0.5 + x * 0.7 + y * 1.1)),
                  1,
                  TREE_RAMP.length - 1,
                )
              ];
        }
        line += `\x1b[38;2;${r};${g};${b}m${ch}`;
      }
      out += line + "\x1b[0m\x1b[K\n";
    }
    return out;
  }

  async function showTree(): Promise<void> {
    const stdout = dependencies.stdout ?? process.stdout;
    const env = dependencies.env ?? process.env;
    if (!stdout.isTTY || env.NO_COLOR || env.TERM === "dumb") return;
    let cursorHidden = false;
    const restoreCursor = () => {
      if (cursorHidden) stdout.write("\x1b[?25h");
      cursorHidden = false;
    };
    const handlers = Object.fromEntries(
      TREE_SIGNALS.map((signal) => [
        signal,
        () => {
          restoreCursor();
          for (const name of TREE_SIGNALS) removeListener(name, handlers[name]);
          kill(dependencies.pid ?? process.pid, signal);
        },
      ]),
    ) as Record<TreeSignal, () => void>;
    try {
      const grid = loadTreeGrid();
      if (!grid) return;
      const rows = grid.length;
      const width = Math.max(...grid.map((row) => row.length)) + 3;
      stdout.write("\n");
      // a narrow window breaks cursor-based redraw — show it statically
      if ((stdout.columns || 80) < width || env.IVA_NO_ANIM) {
        stdout.write(renderTreeFrame(grid, 0, false) + "\n");
        return;
      }
      stdout.write("\x1b[?25l"); // hide the cursor
      cursorHidden = true;
      for (const signal of TREE_SIGNALS) once(signal, handlers[signal]);
      const FRAMES = 36,
        DELAY = 70;
      for (let frame = 0; frame < FRAMES; frame++) {
        if (frame > 0) stdout.write(`\x1b[${rows}A`);
        stdout.write(renderTreeFrame(grid, frame * 0.7, true));
        await sleep(DELAY);
      }
      stdout.write(`\x1b[${rows}A` + renderTreeFrame(grid, 0, false));
      restoreCursor();
      stdout.write("\n");
    } catch {
      restoreCursor();
    } finally {
      for (const signal of TREE_SIGNALS)
        removeListener(signal, handlers[signal]);
    }
  }

  return { loadTreeGrid, renderTreeFrame, showTree };
}
