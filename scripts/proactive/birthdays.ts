/// <reference lib="es2024.string" />
// Один read-only вход Google для Brief и Watch; доставка и seen остаются прежними.
import {
  BIRTHDAY_LOOKAHEAD_DAYS,
  BIRTHDAY_MORNING_END_HOUR,
  BIRTHDAY_NOTICE_DAYS,
  BIRTHDAY_TIMEOUT_MS,
} from "#lib/proactive-config.ts";
import { addDaysToDate, zonedParts, zonedToUtcMs } from "#lib/zoned-time.ts";
import { runGws, type Birthday, type GwsRun, type Source } from "./precheck.ts";

const BIRTHDAY_KEY_PREFIX = "birthday:contact:";

/** Только новый ключ ДР означает подтверждение доставки, старый мог быть заявкой. */
export const isContactBirthdayKey = (key: string): boolean =>
  key.startsWith(BIRTHDAY_KEY_PREFIX);

export type Birthdays = {
  readonly status: "ready" | "not-connected" | "missing" | "unavailable";
  readonly items: readonly Birthday[];
};

const DAY_MS = 86_400_000;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function json(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Удаляем только известный префикс/суффикс, сохраняя апострофы и Unicode имени. */
export function birthdayName(summary: string): string {
  const text = summary.trim();
  return (
    /['’]s birthday$/iu.test(text)
      ? text.replace(/['’]s birthday$/iu, "")
      : text.replace(/^День рождения:\s*/iu, "")
  ).trim();
}

function dateEpoch(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const epoch = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(epoch) &&
    new Date(epoch).toISOString().slice(0, 10) === date
    ? epoch
    : null;
}

/** Контактный id непрозрачен; некорректный UTF-16 исключает только эту строку. */
function linkedContact(row: Record<string, unknown>): string | null {
  const properties = object(row.birthdayProperties);
  const contact = properties.contact;
  return row.eventType === "birthday" &&
    properties.type === "birthday" &&
    typeof contact === "string" &&
    /^people\/[^\s<>/]+$/u.test(contact) &&
    contact.isWellFormed()
    ? contact
    : null;
}

function birthday(value: unknown, today: number): Birthday | null {
  const row = object(value);
  const date = object(row.start).date;
  const contact = linkedContact(row);
  if (
    contact === null ||
    row.status === "cancelled" ||
    typeof row.summary !== "string" ||
    typeof date !== "string"
  )
    return null;
  const epoch = dateEpoch(date);
  if (epoch === null) return null;
  const daysUntil = (epoch - today) / DAY_MS;
  const name = birthdayName(row.summary);
  if (!name || daysUntil < 0 || daysUntil > BIRTHDAY_LOOKAHEAD_DAYS)
    return null;
  return {
    key: `${BIRTHDAY_KEY_PREFIX}${encodeURIComponent(contact)}:${date}:${daysUntil}`,
    name,
    date,
    daysUntil,
  };
}

/** Google timeMax исключён: конец окна — полночь после дня +7, в зоне владельца. */
function windowOf(now: number, timeZone: string) {
  const { y, m, d } = zonedParts(now, timeZone);
  const end = addDaysToDate(y, m, d, BIRTHDAY_LOOKAHEAD_DAYS + 1);
  return {
    today: Date.UTC(y, m - 1, d),
    params: {
      calendarId: "primary",
      eventTypes: ["birthday"],
      singleEvents: true,
      orderBy: "startTime",
      timeZone,
      timeMin: new Date(zonedToUtcMs(y, m, d, 0, 0, timeZone)).toISOString(),
      timeMax: new Date(
        zonedToUtcMs(end.y, end.m, end.d, 0, 0, timeZone),
      ).toISOString(),
    },
  };
}

function failure(
  result: Awaited<ReturnType<GwsRun>>,
): Birthdays["status"] | null {
  if (result.code === "missing" || result.code === 2) return "not-connected";
  const error = object(
    json(result.stdout).error ?? json(result.stderr ?? "").error,
  );
  if (
    error.code === 404 ||
    error.status === "NOT_FOUND" ||
    error.reason === "notFound"
  )
    return "missing";
  return result.code === 0 ? null : "unavailable";
}

async function birthdayPage(
  run: GwsRun,
  params: Record<string, unknown>,
  deadline: number,
): Promise<
  { status: Birthdays["status"] } | { items: unknown[]; next?: string }
> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { status: "unavailable" };
  const result = await run(
    ["calendar", "events", "list", "--params", JSON.stringify(params)],
    remaining,
  );
  const status = failure(result);
  if (status) return { status };
  const page = json(result.stdout);
  // Отсутствующее items у корректного Events list — пустой календарь.
  const items =
    page.items === undefined && page.kind === "calendar#events"
      ? []
      : page.items;
  if (!Array.isArray(items)) return { status: "unavailable" };
  return {
    items,
    next:
      typeof page.nextPageToken === "string" ? page.nextPageToken : undefined,
  };
}

export async function readBirthdays(
  now: number,
  timeZone: string,
  run: GwsRun = runGws,
): Promise<Birthdays> {
  const { today, params } = windowOf(now, timeZone);
  const deadline = Date.now() + BIRTHDAY_TIMEOUT_MS;
  const tokens = new Set<string>();
  const items = new Map<string, Birthday>();
  let pageToken: string | undefined;
  do {
    const page = await birthdayPage(
      run,
      { ...params, ...(pageToken ? { pageToken } : {}) },
      deadline,
    );
    if ("status" in page) return { status: page.status, items: [] };
    for (const row of page.items) {
      const item = birthday(row, today);
      if (item) items.set(item.key, item);
    }
    pageToken = page.next;
    if (pageToken) {
      if (tokens.has(pageToken)) return { status: "unavailable", items: [] };
      tokens.add(pageToken);
    }
  } while (pageToken);
  return {
    status: "ready",
    items: [...items.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
    ),
  };
}

export function birthdaySource(
  read: () => Promise<Birthdays>,
  now: number,
  timeZone: string,
): Source {
  return {
    name: "birthdays",
    prefix: "birthday:",
    check: async () => {
      const result = await read();
      const morning = zonedParts(now, timeZone).hh < BIRTHDAY_MORNING_END_HOUR;
      return {
        items: result.items
          .filter(
            (item) =>
              item.daysUntil === BIRTHDAY_NOTICE_DAYS ||
              (item.daysUntil === 0 && morning),
          )
          .map((item) => ({
            key: item.key,
            unread: 1,
            from: {},
            birthday: item,
            note: `Birthday from Google Contacts (data): ${JSON.stringify(item)}`,
          })),
        error:
          result.status === "unavailable"
            ? "birthdays calendar could not be read"
            : null,
      };
    },
  };
}
