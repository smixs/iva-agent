// `iva proactive show | on | off | set <ключ> <значение>` — настройки Watch, Brief и Insight
// (ADR-0020, ADR-0022).
// Модель зовёт её по фразе владельца («пиши реже», «обзор в 9», «жена — срочно»), оператор —
// из терминала. Пишет только ключ `proactive` целиком через updateSettings: прочитать,
// поменять поле, записать весь файл под замком настроек; соседние ключи не трогаются. Битые
// настройки или неверный вход — отказ с кодом 1, файл на месте. Импорты authored tree —
// ленивые: команда грузится и на установке без agent/ (scripts/authored-tree-guard.test.ts).
import { join } from "node:path";
import { resolveTimeZone } from "../../packages/timezone/index.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

const USAGE =
  "usage: iva proactive show | on | off | set <key> <value> (lists: comma-separated)";

export function createProactiveCommand(
  runtime: Pick<CliRuntime, "ok" | "dataDirAbs" | "readEnv">,
  { now = () => Date.now() }: { readonly now?: () => number } = {},
) {
  const { ok, dataDirAbs, readEnv } = runtime;

  async function show(dir: string, timeZone: string): Promise<void> {
    const { readSettings } = await import("#lib/settings.ts");
    const { parseProactive, PROACTIVE_KEYS } =
      await import("#lib/proactive-config.ts");
    const config = parseProactive(readSettings(join(dir, "settings.json")));
    for (const key of PROACTIVE_KEYS) {
      const value = config[key];
      console.log(
        `${key}: ${Array.isArray(value) ? value.join(",") : String(value)}`,
      );
    }
    const { countToday, readProactiveState } =
      await import("../proactive/state.ts");
    const { zonedParts } = await import("#lib/zoned-time.ts");
    const { y, m, d } = zonedParts(now(), timeZone);
    const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    let state;
    try {
      state = readProactiveState(join(dir, "proactive.json"));
    } catch (error) {
      // Битое состояние останавливает тик (выход 1 каждый прогон): show говорит об этом отказом.
      throw new Error(
        `${(error as Error).message}; the tick exits 1 until it is fixed or removed`,
        { cause: error },
      );
    }
    console.log(`wakes today: ${state ? countToday(state.wakes, day) : 0}`);
    console.log(
      `model wakes today: ${state ? countToday(state.modelWakes, day) : 0}`,
    );
  }

  async function set(dir: string, key: string, text: string): Promise<void> {
    const { proactiveValue, withProactive } =
      await import("#lib/proactive-config.ts");
    const parsed = proactiveValue(key, text);
    if ("error" in parsed) throw new Error(parsed.error);
    const { updateSettings } = await import("#lib/settings.ts");
    updateSettings(
      (current) => withProactive(current, key as never, parsed.value),
      join(dir, "settings.json"),
    );
    ok(
      `proactive ${key}: ${Array.isArray(parsed.value) ? parsed.value.join(",") : String(parsed.value)}`,
    );
  }

  return async function cmdProactive(args: readonly string[]): Promise<void> {
    const [subcommand, key, value, ...rest] = args;
    const env = readEnv();
    const dir = dataDirAbs(env);
    if (subcommand === "show" && key === undefined)
      return show(dir, resolveTimeZone(env.ASSISTANT_TIMEZONE));
    if ((subcommand === "on" || subcommand === "off") && key === undefined)
      return set(dir, "enabled", subcommand);
    if (subcommand === "set" && key && value !== undefined && rest.length === 0)
      return set(dir, key, value);
    throw new Error(USAGE);
  };
}
