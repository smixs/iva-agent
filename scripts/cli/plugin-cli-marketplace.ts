// The Marketplace side of `iva plugin`: the lists the owner keeps, what they offer, and the
// one name → source lookup an install goes through.
//
// A Marketplace is a JSON list in a git repository (`.agents/plugins/marketplace.json`, the
// convention of Codex): name → source. Not a registry - no centre (ADR-0009). The default
// list is reviewed by its maintainers (ADR-0029); to this code every list is still untrusted
// input, so everything a file can get wrong is a diagnostic here, and the parser that
// produces them lives in `scripts/lib/marketplace.ts`.
import { rmSync } from "node:fs";
import type { PluginsState } from "#lib/plugin-store.ts";
import {
  DEFAULT_MARKETPLACE,
  loadMarketplace,
  loadMarketplaces,
  marketplaceCachePath,
  MARKETPLACE_FILE,
  marketplaceSources,
  resolveMarketplacePlugin,
  type LoadedMarketplace,
} from "../lib/marketplace.ts";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "../lib/plugin-source.ts";
import type { PluginCliContext } from "./plugin-cli-context.ts";

/** Откуда пришёл плагин, когда его нашли по имени. */
export type Provenance = {
  readonly marketplace: string;
  /** Имя, которое Marketplace обещал: манифест обязан его подтвердить. */
  readonly expect: string;
};

export function createPluginMarketplaceCommands(context: PluginCliContext) {
  const { runtime, core, args, git, translate, log, locked, absolute } =
    context;
  const { C, ok, warn, bad, step, dataDirAbs } = runtime;
  const { readPluginsState, writePluginsState } = core.store;

  /**
   * Что с Marketplace не так — вслух, до того как его список пойдёт в работу.
   * Диагностики самого файла печатаются там, где владелец просил список
   * (`list --available`, `marketplace add|list`): повторять их на каждой установке
   * значит приучить их не читать.
   */
  function reportMarketplace(one: LoadedMarketplace, listing = true): void {
    if (one.problem)
      (one.stale ? warn : bad)(
        one.stale
          ? translate(
              `${one.label} could not be refreshed (${one.problem}) — using the cached list, it may be stale`,
              `${one.label} не обновился (${one.problem}) — беру список из кэша, он может быть устаревшим`,
            )
          : translate(
              `${one.label} could not be read: ${one.problem}`,
              `${one.label} не читается: ${one.problem}`,
            ),
      );
    // Отказ файлу целиком — причина, по которой имя не нашлось: она нужна и там,
    // где владелец просил не список, а установку.
    if (listing || one.market.name === null)
      for (const line of one.market.diagnostics) warn(`${one.label}: ${line}`);
  }

  /** Что предлагают Marketplace: имя, описание, чей список, стоит ли уже. */
  async function available(data: string, state: PluginsState): Promise<void> {
    const all = await loadMarketplaces(git, data, state.marketplaces, true);
    const installed = new Set(state.plugins.map((entry) => entry.name));
    const rows: string[][] = [];
    for (const one of all) {
      reportMarketplace(one);
      for (const entry of one.market.entries)
        rows.push([
          entry.name,
          entry.description.length > 60
            ? `${entry.description.slice(0, 59)}…`
            : entry.description || "-",
          one.label,
          installed.has(entry.name) ? "installed" : "available",
        ]);
    }
    if (rows.length === 0) {
      log(
        translate(
          "Nothing on offer. Add a marketplace: iva plugin marketplace add <source>",
          "Предлагать нечего. Добавить маркетплейс: iva plugin marketplace add <источник>",
        ),
      );
      return;
    }
    const header = ["NAME", "DESCRIPTION", "MARKETPLACE", ""];
    const width = (column: number): number =>
      Math.max(...[header, ...rows].map((row) => row[column].length));
    const line = (row: readonly string[]): string =>
      `${row[0].padEnd(width(0))}  ${row[1].padEnd(width(1))}  ${row[2].padEnd(width(2))}  ${row[3]}`;
    log(`${C.d}${line(header)}${C.x}`);
    for (const row of rows)
      log(row[3] === "installed" ? `${C.d}${line(row)}${C.x}` : line(row));
  }

  /**
   * `marketplace add`: клонируем один раз, чтобы прочитать файл, и только потом
   * записываем строку источника. Репозиторий без `marketplace.json` — не
   * Marketplace, и узнать это лучше сразу, а не при первом `add <имя>`.
   */
  async function marketplaceAdd(data: string): Promise<void> {
    const raw = args[1];
    if (!raw)
      throw new Error(
        "iva plugin marketplace add <source> — owner/repo[@ref], https://…, git@… or a local git repository",
      );
    const recorded = formatPluginSource(absolute(parsePluginSource(raw)));
    await locked(data, async () => {
      const state = await readPluginsState(data);
      if (marketplaceSources(state.marketplaces).includes(recorded)) {
        ok(
          translate(
            `${recorded} is already on the list`,
            `${recorded} в списке уже есть`,
          ),
        );
        return;
      }
      step(`Reading ${recorded}`);
      const one = await loadMarketplace(git, data, recorded, true);
      try {
        if (one.problem && !one.repo)
          throw new Error(
            translate(
              `${recorded} could not be read: ${one.problem}`,
              `${recorded} не читается: ${one.problem}`,
            ),
          );
        reportMarketplace(one);
        if (!one.market.name)
          throw new Error(
            translate(
              `${recorded} has no usable ${MARKETPLACE_FILE} — that file is what makes a repository a Marketplace`,
              `у ${recorded} нет пригодного ${MARKETPLACE_FILE} — именно этот файл делает репозиторий маркетплейсом`,
            ),
          );
        // Одно имя на два списка сделало бы `add <имя>@<marketplace>` невыразимым.
        const taken = (
          await loadMarketplaces(git, data, state.marketplaces, false)
        ).find((other) => other.market.name === one.market.name);
        if (taken)
          throw new Error(
            translate(
              `a marketplace named ${JSON.stringify(one.market.name)} is already on the list (${taken.recorded})`,
              `маркетплейс с именем ${JSON.stringify(one.market.name)} в списке уже есть (${taken.recorded})`,
            ),
          );
      } catch (error) {
        // Список не принят — его выкачанная копия в data/ тоже не нужна.
        rmSync(marketplaceCachePath(data, recorded), {
          recursive: true,
          force: true,
        });
        throw error;
      }
      // Первый свой список материализует и дефолт, первым: иначе «добавил свой»
      // молча отключало бы встроенный, и снять дефолт было бы нечем.
      await writePluginsState(data, {
        ...state,
        marketplaces: state.marketplaces.length
          ? [...state.marketplaces, recorded]
          : [DEFAULT_MARKETPLACE, recorded],
      });
      ok(
        translate(
          `${one.market.name} added — ${one.market.entries.length} plugin(s) on offer`,
          `${one.market.name} добавлен — плагинов на выбор: ${one.market.entries.length}`,
        ),
      );
    });
  }

  /** Запись списка по строке источника или по имени из файла. */
  async function findMarketplace(
    data: string,
    state: PluginsState,
    wanted: string,
  ): Promise<string> {
    let formatted: string | null = null;
    try {
      formatted = formatPluginSource(absolute(parsePluginSource(wanted)));
    } catch {
      // Не источник — значит имя из файла, его ищем ниже.
    }
    const bySource = state.marketplaces.find(
      (item) => item === wanted || item === formatted,
    );
    if (bySource) return bySource;
    for (const recorded of state.marketplaces) {
      const one = await loadMarketplace(git, data, recorded, false);
      if (one.market.name === wanted) return recorded;
    }
    throw new Error(
      translate(
        `${wanted} is not on the list — iva plugin marketplace list`,
        `${wanted} в списке нет — iva plugin marketplace list`,
      ),
    );
  }

  async function marketplaceRemove(data: string): Promise<void> {
    const wanted = args[1];
    if (!wanted)
      throw new Error(
        "iva plugin marketplace remove <name|source> — iva plugin marketplace list",
      );
    await locked(data, async () => {
      const state = await readPluginsState(data);
      if (state.marketplaces.length === 0) {
        const fallback = await loadMarketplace(
          git,
          data,
          DEFAULT_MARKETPLACE,
          false,
        );
        throw new Error(
          wanted === DEFAULT_MARKETPLACE || fallback.market.name === wanted
            ? translate(
                `${DEFAULT_MARKETPLACE} is the built-in default, not a list entry — add your own marketplace first, then remove this one`,
                `${DEFAULT_MARKETPLACE} — встроенный список по умолчанию, а не запись: сначала добавь свой маркетплейс, потом снимай этот`,
              )
            : translate(
                `${wanted} is not on the list — iva plugin marketplace list`,
                `${wanted} в списке нет — iva plugin marketplace list`,
              ),
        );
      }
      const target = await findMarketplace(data, state, wanted);
      await writePluginsState(data, {
        ...state,
        marketplaces: state.marketplaces.filter((item) => item !== target),
      });
      // Кэш наш и лежит в data/: снимаем его вместе с записью.
      rmSync(marketplaceCachePath(data, target), {
        recursive: true,
        force: true,
      });
      ok(translate(`${target} removed`, `${target} снят`));
    });
  }

  async function marketplaceList(data: string): Promise<void> {
    const state = await readPluginsState(data);
    const implicit = state.marketplaces.length === 0;
    for (const recorded of marketplaceSources(state.marketplaces)) {
      const one = await loadMarketplace(git, data, recorded, false);
      const mark = implicit ? `  ${C.d}(default)${C.x}` : "";
      if (one.problem) {
        bad(`${recorded}${mark}  ${one.problem}`);
        continue;
      }
      if (!one.repo) {
        log(
          `${C.b}${recorded}${C.x}${mark}  ${translate(
            "not read yet — run: iva plugin list --available",
            "ещё не читали — запусти: iva plugin list --available",
          )}`,
        );
        continue;
      }
      log(
        `${C.b}${one.label}${C.x}${mark}  ${recorded}  ${one.market.entries.length} plugin(s)  ${one.repo.sha.slice(0, 12)}`,
      );
      for (const line of one.market.diagnostics) warn(`  ${line}`);
    }
  }

  function marketplaceCommand(): Promise<void> {
    const data = dataDirAbs();
    switch (args[0] ?? "list") {
      case "add":
        return marketplaceAdd(data);
      case "remove":
        return marketplaceRemove(data);
      case "list":
        return marketplaceList(data);
      default:
        throw new Error(
          `unknown: iva plugin marketplace ${args[0]} — add, remove, list`,
        );
    }
  }

  /** Имя → источник и провенанс: списки лежат в том же состоянии, что плагины. */
  async function sourceByName(
    data: string,
    state: PluginsState,
    wanted: { readonly name: string; readonly marketplace: string | null },
  ): Promise<{
    readonly source: PluginSource;
    readonly provenance: Provenance;
    /** Имя взято из списка по умолчанию: только такая установка считается (ADR-0029). */
    readonly fromDefault: boolean;
  }> {
    const all = await loadMarketplaces(git, data, state.marketplaces, true);
    for (const one of all) reportMarketplace(one, false);
    const hit = resolveMarketplacePlugin(all, wanted, translate);
    return {
      source: hit.source,
      provenance: { marketplace: hit.marketplace, expect: hit.name },
      fromDefault: hit.recorded === DEFAULT_MARKETPLACE,
    };
  }

  /**
   * Есть ли имя в списке по умолчанию, каким он лежит в кэше. Спрашивает установка по
   * тапу: к ней плагин приходит папкой, и имя — всё, что связывает его со списком. В
   * сеть не идёт; владелец, снявший список по умолчанию, в счёт не попадает.
   */
  async function listedByDefault(
    data: string,
    state: PluginsState,
    name: string,
  ): Promise<boolean> {
    if (!marketplaceSources(state.marketplaces).includes(DEFAULT_MARKETPLACE))
      return false;
    const one = await loadMarketplace(git, data, DEFAULT_MARKETPLACE, false);
    return one.market.entries.some((entry) => entry.name === name);
  }

  return {
    cmdMarketplace: marketplaceCommand,
    /** Нужно `list --available` и установке по имени: та же диагностика, тот же кэш. */
    available,
    sourceByName,
    listedByDefault,
  };
}
