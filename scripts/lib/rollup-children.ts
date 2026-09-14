// Ссылки вниз у weekly/monthly/yearly. Сводка есть не за каждый день месяца и не за
// каждую неделю: «семь дней недели» модель разворачивает в семь ссылок, и те, за которыми
// файла нет, уходят в vault битыми — health графа падает, ночной graph.fix их не резолвит.
// Список дочерних сводок — lookup: одинаковый вход даёт одинаковый выход, значит код.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { monthOfWeek, weekOfDay } from "#lib/vault-links.ts";

/** Период, который собирается из сводок предыдущей ступени. */
export type ParentPeriod = "weekly" | "monthly" | "yearly";

const CHILD: Record<
  ParentPeriod,
  { readonly unit: string; readonly plural: string; readonly summary: string }
> = {
  weekly: { unit: "day", plural: "days", summary: "daily-summary" },
  monthly: { unit: "week", plural: "weeks", summary: "weekly-summary" },
  yearly: { unit: "month", plural: "months", summary: "monthly-summary" },
};

/** Все календарные дни месяца `YYYY-MM`. */
function daysOfMonth(month: string): string[] {
  const [year, number] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from(
    { length },
    (_unused, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
  );
}

/** Семь дней, заканчивающихся `lastDay` (для weekly это законченная ISO-неделя). */
function weekDays(lastDay: string): string[] {
  const [year, month, day] = lastDay.split("-").map(Number);
  const end = Date.UTC(year, month - 1, day);
  return Array.from({ length: 7 }, (_unused, index) =>
    new Date(end - (6 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * Пути дочерних сводок периода — те, что вообще могли быть написаны. `scope` — то же
 * значение, о котором говорит промпт: последний день недели для weekly, `YYYY-MM` для
 * monthly, `YYYY` для yearly.
 */
function childPaths(period: ParentPeriod, scope: string): string[] {
  if (period === "weekly")
    return weekDays(scope).map((day) => `summaries/daily/${day}`);
  if (period === "monthly") {
    // Неделя принадлежит месяцу своего четверга — по этой же связи её читает граф.
    const weeks = new Set(
      daysOfMonth(scope)
        .map(weekOfDay)
        .filter((week) => week !== null && monthOfWeek(week) === scope),
    );
    return [...weeks].map((week) => `weekly/${week}`);
  }
  return Array.from(
    { length: 12 },
    (_unused, index) =>
      `monthly/${scope}-${String(index + 1).padStart(2, "0")}`,
  );
}

/** Дочерние сводки периода, которые лежат в vault. */
export function childSummaries(
  period: ParentPeriod,
  scope: string,
  vault: string,
): string[] {
  return childPaths(period, scope).filter((path) =>
    existsSync(join(vault, `${path}.md`)),
  );
}

/**
 * Фраза промпта про ссылки вниз: перечень существующих сводок или прямое «их нет».
 * Без перечня модель выводит путь из заголовка и промахивается мимо файла.
 */
export function childLinkRule(
  period: ParentPeriod,
  scope: string,
  vault: string,
): string {
  const { unit, plural, summary } = CHILD[period];
  const children = childSummaries(period, scope, vault);
  if (children.length === 0)
    return (
      `No ${summary} of those ${plural} exists: name the ${plural} in plain text ` +
      `and link none of them. `
    );
  return (
    `Link exactly these files: ${children.map((path) => `[[${path}]]`).join(", ")}. ` +
    `A ${unit} whose ${summary} is missing is named in plain text, never as a link. `
  );
}
