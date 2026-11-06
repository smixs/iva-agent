/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// System входит в кэшируемый префикс запроса: меняется system — провайдер заново пишет в кэш
// весь запрос (#236). Поэтому ни одна инструкция Iva не кладёт в system то, что меняется
// между ходами одних суток, а время приходит user-сообщением. Лежит в scripts/, а не в
// agent/instructions/: там eve принял бы файл за инструкцию.
//
// Модули инструкций читают часовой пояс и data dir на загрузке, поэтому окружение задаётся
// до динамического import. Часы подменяются mock.timers, моменты перебирает fast-check;
// seed печатается (IVA_INSTRUCTIONS_PBT_SEED, прогонов IVA_INSTRUCTIONS_PBT_RUNS).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import fc from "fast-check";

const SEED = Number(process.env.IVA_INSTRUCTIONS_PBT_SEED ?? 20_260_923);
const RUNS = Number(process.env.IVA_INSTRUCTIONS_PBT_RUNS ?? 50);
const ROOT = process.cwd();
const INSTRUCTIONS = join(ROOT, "agent/instructions");
const TIME_ZONE = "Asia/Tashkent";
/** Полночь 23.09.2026 в Ташкенте (UTC+5, без перехода на летнее время). */
const LOCAL_MIDNIGHT = Date.UTC(2026, 8, 22, 19, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

test("long commands stay in the helper turn; later Reminders require the owner's request", () => {
  const skills = readFileSync(join(INSTRUCTIONS, "15-skills.md"), "utf8")
    .split("### Delegate long work from the owner's chat")[1]
    .replace(/\s+/gu, " ");
  assert.doesNotMatch(
    skills,
    /\bbackground\b(?!-check)|nohup|setsid|disown|detach|\s&\s|scheduled check/iu,
  );
  assert.match(skills, /Delegate commands[^.]*to a helper/u);
  assert.match(
    skills,
    /helper waits[^.]*with bash `timeoutMs` covering the expected duration[^.]*45-minute/u,
  );
  assert.match(skills, /Reminder[^.]*only[^.]*owner asks/u);
});

type Resolved = { content: string; role: string };
type Resolver = () => unknown;

const home = mkdtempSync(join(tmpdir(), "iva-instructions-stable-"));
process.env.ASSISTANT_TIMEZONE = TIME_ZONE;
process.env.ASSISTANT_DATA_DIR = join(home, "data");
process.env.ASSISTANT_VAULT_DIR = join(home, "vault");

const resolvers = new Map<string, Resolver>();
for (const file of readdirSync(INSTRUCTIONS).filter((name) =>
  name.endsWith(".ts"),
)) {
  const loaded = (await import(
    pathToFileURL(join(INSTRUCTIONS, file)).href
  )) as { default: { events?: Record<string, Resolver> } };
  const resolver = loaded.default.events?.["turn.started"];
  if (resolver !== undefined) resolvers.set(file, resolver);
}

/** Результат каждой инструкции в момент `now`, приведённый к виду eve: без role — system. */
async function resolveAt(
  timers: { setTime: (ms: number) => void },
  now: number,
): Promise<Map<string, Resolved>> {
  timers.setTime(now);
  const results = new Map<string, Resolved>();
  for (const [file, resolver] of resolvers) {
    const result = await resolver();
    if (result !== null) {
      const instruction = result as { content: string; role?: string };
      results.set(file, {
        content: instruction.content,
        role: instruction.role ?? "system",
      });
    }
  }
  return results;
}

test("в system нет часов: за одни сутки меняется только user-строка времени", async (t) => {
  console.error(
    `[instructions-stable property] seed ${SEED}, прогонов ${RUNS}`,
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: LOCAL_MIDNIGHT });
  assert.ok(resolvers.has("now.ts"), "инструкция времени найдена");
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: DAY_MS - 1 }),
      fc.integer({ min: 0, max: DAY_MS - 1 }),
      async (first, second) => {
        const a = await resolveAt(t.mock.timers, LOCAL_MIDNIGHT + first);
        const b = await resolveAt(t.mock.timers, LOCAL_MIDNIGHT + second);
        for (const [file, result] of a)
          if (result.role === "system")
            assert.equal(
              b.get(file)?.content,
              result.content,
              `${file} меняет system внутри суток`,
            );
        const now = a.get("now.ts")!;
        assert.equal(now.role, "user");
        if (Math.floor(first / 60_000) !== Math.floor(second / 60_000))
          assert.notEqual(
            b.get("now.ts")!.content,
            now.content,
            "минута видна",
          );
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});
