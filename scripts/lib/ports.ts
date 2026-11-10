// SOLID-ядро проверки портов Iva. Им пользуется настройка (scripts/setup/).
//
//   • Probe (SRP/ISP)   — один способ детекта «занят ли порт»: bind / /proc / docker.
//   • PortChecker (DIP) — агрегирует инъецированные Probe, не зная их реализации.
//   • PortSelector      — выбор свободного порта поверх PortChecker.
//   • OCP: новый способ детекта = новый Probe в массиве, без правок PortChecker/PortSelector.

import net from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

export const DEFAULT_PORT = 8723;

export interface ProbeResult {
  occupied: boolean;
  holder?: string;
}

export interface PortProbe {
  name: string;
  check(port: number): Promise<ProbeResult>;
}

export interface PortCheckResult {
  port: number;
  occupied: boolean;
  holders: string[];
}

export interface OccupiedPortDetails {
  port: number;
  holders: string[];
}

// ── Probe-контракт (LSP): { name, check(port) -> Promise<{ occupied, holder? }> } ──

// Источник правды: пытаемся сами занять порт — ровно то, что делает eve-сервер на старте.
export const bindProbe = {
  name: "bind",
  check(port: number): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const srv = net.createServer();
      srv.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          occupied: code === "EADDRINUSE",
          holder: code === "EADDRINUSE" ? "порт занят" : undefined,
        });
      });
      srv.once("listening", () =>
        srv.close(() => resolve({ occupied: false })),
      );
      srv.listen(port, "0.0.0.0"); // 0.0.0.0 перекрывает и 127.0.0.1, и чужой wildcard-биндинг
    });
  },
} satisfies PortProbe;

// Атрибуция (Linux): кто слушает порт — из /proc/net/tcp{,6}. uid=0 → root/docker.
export const procProbe = {
  name: "proc",
  // Keep every probe asynchronous even when its implementation uses synchronous sources.
  // eslint-disable-next-line @typescript-eslint/require-await
  async check(port: number): Promise<ProbeResult> {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (!c[1] || c[3] !== "0A") continue; // 0A = LISTEN
        if (c[1].endsWith(":" + hex))
          return { occupied: true, holder: `uid=${c[7]} inode=${c[9]}` };
      }
    }
    return { occupied: false };
  },
} satisfies PortProbe;

function lsofListeners(port: number) {
  return spawnSync(
    process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8", timeout: 5000 },
  );
}

export const lsofProbe: PortProbe = {
  name: "lsof",
  check(port) {
    const result = lsofListeners(port);
    const out = result.stdout ?? "";
    const occupied = /\(LISTEN\)/u.test(out);
    return Promise.resolve(
      result.error || (result.status !== 0 && result.status !== 1)
        ? { occupied: false, holder: "неизвестно (lsof недоступен)" }
        : { occupied, holder: occupied ? out.trim() : undefined },
    );
  },
};

// Атрибуция: опубликованные docker-порты (именно это сломало :3000 на VPS).
export const dockerProbe = {
  name: "docker",
  // Keep every probe asynchronous even when its implementation uses synchronous sources.
  // eslint-disable-next-line @typescript-eslint/require-await
  async check(port: number): Promise<ProbeResult> {
    try {
      const out = execFileSync(
        "docker",
        ["ps", "--format", "{{.Names}}\t{{.Ports}}"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      for (const line of out.split("\n")) {
        const [name, ports] = line.split("\t");
        if (ports && new RegExp(`[:.]${port}->`).test(ports))
          return { occupied: true, holder: `docker:${name}` };
      }
    } catch {
      /* docker нет/недоступен — мягко пропускаем (Probe деградирует, а не падает) */
    }
    return { occupied: false };
  },
} satisfies PortProbe;

// ── PortChecker (DIP): зависит от абстракции Probe[], а не от их реализаций ──
export class PortChecker {
  probes: PortProbe[];

  constructor(probes: PortProbe[]) {
    this.probes = probes;
  }
  async check(port: number): Promise<PortCheckResult> {
    const holders: string[] = [];
    let occupied = false;
    for (const p of this.probes) {
      const r = await p.check(port);
      if (r.occupied) {
        occupied = true;
        if (r.holder) holders.push(`${p.name}: ${r.holder}`);
      }
    }
    return { port, occupied, holders };
  }
}

// ── PortSelector: ближайший свободный порт поверх checker ──
export class PortSelector {
  checker: PortChecker;

  constructor(checker: PortChecker) {
    this.checker = checker;
  }
  async firstFree(start: number, span = 50): Promise<number | null> {
    for (let p = start; p < start + span && p <= 65535; p++) {
      if (!(await this.checker.check(p)).occupied) return p;
    }
    return null;
  }
}

// An unchanged port can be occupied by Iva or by an unrelated process that took
// the socket while Iva was down. Holder heuristics cannot prove ownership, so
// reuse is allowed only after an explicit user confirmation.
export async function confirmOccupiedCurrentPort({
  port,
  currentPort,
  holders = [],
  confirm,
}: {
  port: number | string;
  currentPort: number | string;
  holders?: string[];
  confirm?: (details: OccupiedPortDetails) => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (Number(port) !== Number(currentPort)) return false;
  if (typeof confirm !== "function")
    throw new TypeError("occupied port reuse requires confirm(details)");
  return Boolean(await confirm({ port: Number(port), holders }));
}

// Готовый чекер со всеми доступными способами детекта.
export function defaultChecker(): PortChecker {
  return new PortChecker([
    bindProbe,
    process.platform === "darwin" ? lsofProbe : procProbe,
    dockerProbe,
  ]);
}
