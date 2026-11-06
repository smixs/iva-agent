import { join } from "node:path";
import { noticeTranslator } from "../lib/notice-policy.ts";
import type { NightKey } from "#lib/memory-night-constants.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;

type NightCommand =
  { kind: "show" } | { kind: "set"; key: NightKey; value: number };

function parseNightArgs(
  args: readonly string[],
  keys: readonly NightKey[],
  usage: string,
): NightCommand {
  if (args.length === 1 && args[0] === "show") return { kind: "show" };
  const [subcommand, key, text] = args;
  const name = keys.find((name) => name === key);
  if (args.length !== 3 || subcommand !== "set" || !name || !text?.trim())
    throw new Error(usage);
  return { kind: "set", key: name, value: Number(text) };
}

/** Ленивые authored-импорты: остальные команды доступны и до сборки agent/. */
export function createNightCommand(
  runtime: Pick<CliRuntime, "ok" | "dataDirAbs" | "readEnv">,
) {
  return async function cmdNight(args: readonly string[]): Promise<void> {
    const env = runtime.readEnv();
    const file = join(runtime.dataDirAbs(env), "settings.json");
    const { readSettings, SettingsWriteError } =
      await import("#lib/settings.ts");
    const T = await noticeTranslator(env, () =>
      Promise.resolve({
        getLang: () => {
          const language = readSettings(file).language;
          return language === "ru" || language === "en"
            ? language
            : env.AGENT_LANGUAGE === "en"
              ? "en"
              : "ru";
        },
      }),
    );
    const { NIGHT_KEYS, readNightSettings, setNightSetting } =
      await import("#lib/memory-night-constants.ts");
    const usage = T(
      "Usage: iva night show | set <key> <value>. Values are positive integers; raisesPerNight also accepts 0. Each limit must fit its ceiling.",
      "Команда: iva night show | set <ключ> <значение>. Значения — целые положительные числа; raisesPerNight также принимает 0. Каждый предел должен помещаться под потолком.",
    );
    const command = parseNightArgs(args, NIGHT_KEYS, usage);
    if (command.kind === "show") {
      const { values, invalid } = readNightSettings(file);
      for (const name of NIGHT_KEYS) console.log(`${name}: ${values[name]}`);
      if (invalid.length)
        console.log(
          T(
            `Using defaults for: ${invalid.join(", ")}`,
            `Значения по умолчанию для: ${invalid.join(", ")}`,
          ),
        );
      return;
    }
    try {
      setNightSetting(command.key, command.value, file);
    } catch (error) {
      if (error instanceof SettingsWriteError)
        throw new Error(
          T(
            "Night settings could not be saved: the file is damaged, unreadable or busy. Try again after checking settings.json.",
            "Сохранить настройки ночи пока не удалось: файл повреждён, недоступен или занят. Проверь settings.json и повтори команду.",
          ),
          { cause: error },
        );
      throw new Error(usage, { cause: error });
    }
    runtime.ok(
      T(
        `Night ${command.key}: ${command.value}`,
        `Ночь ${command.key}: ${command.value}`,
      ),
    );
  };
}
