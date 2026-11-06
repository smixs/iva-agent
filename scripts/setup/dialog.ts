// Диалог мастера установки: вопрос и ответ, язык подсказок, проверка значения для .env,
// выбор из списка и выбор свободного порта. Строки ввода и печать приходят параметром,
// поэтому диалог проверяется in-process (scripts/setup/dialog.test.ts), а живой readline
// подключает только scripts/setup/main.ts.
import { envValueRejection, type EnvValueRejection } from "../lib/env-file.ts";
import {
  confirmOccupiedCurrentPort,
  PortSelector,
  type OccupiedPortDetails,
  type PortChecker,
} from "../lib/ports.ts";
import { isYesAnswer } from "./answers.ts";
import { C, type AskRequiredOptions, type SetupIo } from "./steps.ts";

/** Ввод и вывод мастера: в бою readline и stdout, в тестах сценарий ответов. */
type DialogPort = {
  readonly question: (prompt: string) => Promise<string>;
  readonly print: (...args: unknown[]) => void;
  readonly write: (text: string) => void;
};

export type Dialog = SetupIo & { readonly setLang: (lang: string) => void };

type Translate = (en: string, ru: string) => string;
type Core = DialogPort & {
  readonly nonInteractive: boolean;
  readonly t: Translate;
  readonly checker: PortChecker;
};
/** Что подставит Enter: значение по умолчанию и значение из текущего .env. */
type Offer = { readonly def: string; readonly existing: string };

const TOTAL_STEPS = 5;

export function createDialog(
  port: DialogPort,
  checker: PortChecker,
  nonInteractive = false,
): Dialog {
  let lang = "ru";
  const t: Translate = (en, ru) => (lang === "en" ? en : ru);
  const d: Core = { ...port, t, checker, nonInteractive };
  return {
    nonInteractive,
    t,
    lang: () => lang,
    setLang: (next) => {
      lang = next;
    },
    print: port.print,
    write: port.write,
    ask: (q, def, existing) => ask(d, q, def, existing),
    askYesNo: (q, def) => askYesNo(d, q, def),
    askRequired: (label, options) => askRequired(d, label, options),
    mask: (value) => mask(d, value),
    pickFromList: (items, current, recommended) =>
      pickFromList(d, items, current, recommended),
    pickPort: (def) => pickPort(d, def),
    head: (step, title) => head(d, step, title),
    hr: () => hr(d),
  };
}

/** Повторяет раунд, пока он не вернёт ответ (null — спросить снова). */
async function untilAnswered<T>(round: () => Promise<T | null>): Promise<T> {
  for (;;) {
    const answer = await round();
    if (answer !== null) return answer;
  }
}

const keepMark = (d: Core) => d.t("…(keep)", "…(оставить)");

function problemWords(t: Translate): Record<EnvValueRejection, string> {
  return {
    newline: t("a line break", "перенос строки"),
    control: t(
      "a hidden control character (check the paste)",
      "невидимый управляющий символ (проверьте вставку)",
    ),
    "non-ascii": t(
      "a character outside the Latin alphabet",
      "символ вне латиницы",
    ),
    special: t("one of # \" ' ` \\", "один из знаков # \" ' ` \\"),
    "edge-space": t(
      "a space at the start or end",
      "пробел в начале или в конце",
    ),
  };
}

/** Почему `.env` не примет это значение, словами владельца, или null. */
export function envComplaint(t: Translate, value: string): string | null {
  const rejection = envValueRejection(value);
  if (!rejection) return null;
  const problem = problemWords(t)[rejection];
  return t(
    `The value has ${problem}. The service and the iva command would read it differently, so .env cannot hold it — enter it without that character.`,
    `В значении ${problem}. Сервис и команда iva прочитали бы его по-разному, поэтому .env такое не хранит — введите значение без этого знака.`,
  );
}

// Один вопрос мастера. `existing` - значение из текущего .env: показывается маской и
// подставляется по Enter. Проверяется ИТОГОВОЕ значение, а не только набранное: иначе
// негодное значение, уже лежащее в файле, доживает до записи и роняет прогон на
// последнем шаге, унося все ответы владельца.
function ask(
  d: Core,
  q: string,
  def?: string,
  existing?: string,
): Promise<string> {
  const offer = carriedOffer(d, { def: def ?? "", existing: existing ?? "" });
  return untilAnswered(() => askRound(d, q, offer));
}

// Негодное значение из существующего .env не предлагается по Enter: иначе вопрос
// зациклится (Enter → отказ → тот же вопрос). Говорим о нём один раз и спрашиваем
// заново с чистого листа.
function carriedOffer(d: Core, offer: Offer): Offer {
  const complaint = envComplaint(d.t, offer.existing || offer.def);
  if (!complaint) return offer;
  if (d.nonInteractive) throw new Error(complaint);
  d.print(
    `${C.y}  ⚠ ${d.t("The value in .env cannot stay", "Значение из .env оставить нельзя")}: ${complaint}${C.x}\n`,
  );
  return { def: "", existing: "" };
}

async function askRound(
  d: Core,
  q: string,
  offer: Offer,
): Promise<string | null> {
  const answer = settle(
    d,
    (d.nonInteractive ? "" : await d.question(prompt(q, offer.def))).trim(),
    offer,
  );
  const complaint = envComplaint(d.t, answer);
  if (!complaint) return answer;
  d.print(`${C.y}  ⚠ ${complaint}${C.x}\n`);
  return null;
}

const prompt = (q: string, def: string) => (def ? `${q} [${def}]: ` : `${q}: `);

/** Набранное, или текущее значение по Enter и по его маске, или значение по умолчанию. */
function settle(d: Core, typed: string, offer: Offer): string {
  if (keepsExisting(d, typed, offer.existing)) return offer.existing;
  return typed || offer.def;
}

const keepsExisting = (d: Core, typed: string, existing: string) =>
  Boolean(existing) && (!typed || typed.endsWith(keepMark(d)));

// Ответ «да/нет» в .env не пишется, поэтому проверка значения для .env его не касается:
// иначе русское «да» отвергалось как символ вне латиницы.
async function askYesNo(d: Core, q: string, def = false): Promise<boolean> {
  if (d.nonInteractive) return def;
  const answer = (await d.question(`${q} (${yesNoHint(def)}): `)).trim();
  return answer ? isYesAnswer(answer) : def;
}

const yesNoHint = (def: boolean) => (def ? "Y/n" : "y/N");

function mask(d: Core, value: string): string {
  return value ? value.slice(0, 6) + keepMark(d) : "";
}

function hr(d: Core): void {
  d.print(`${C.c}  ────────────────────────────────────────────${C.x}`);
}

function head(d: Core, step: number, title: string): void {
  d.print(
    `\n${C.b}${C.c}  ${d.t("Step", "Шаг")} ${step}/${TOTAL_STEPS}: ${title}${C.x}`,
  );
}

// Повторяет вопрос, пока не получит непустое и (если задана проверка) годное значение.
function askRequired(
  d: Core,
  label: string,
  options: AskRequiredOptions = {},
): Promise<string> {
  return untilAnswered(() => requiredRound(d, label, options));
}

async function requiredRound(
  d: Core,
  label: string,
  options: AskRequiredOptions,
): Promise<string | null> {
  printHelp(d, options.help);
  const existing = options.existing ?? "";
  const answer = (await ask(d, label, mask(d, existing), existing)).trim();
  if (!answer) {
    if (d.nonInteractive) throw new Error(`${label}: required in --env-file`);
    d.print(
      `${C.y}  ⚠ ${d.t("Required field — Iva won't run without it. Enter a value.", "Обязательное поле — без него Iva не заработает. Введите значение.")}${C.x}\n`,
    );
    return null;
  }
  return validated(d, answer, options.validate);
}

function printHelp(d: Core, help?: string): void {
  if (help) d.print(help);
}

async function validated(
  d: Core,
  answer: string,
  validate: AskRequiredOptions["validate"],
): Promise<string | null> {
  if (!validate) return answer;
  d.write(`  ${d.t("checking…", "проверяю…")} `);
  const err = await validate(answer);
  if (err) {
    if (d.nonInteractive) throw new Error(err);
    d.print(`${C.r}${d.t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`);
    return null;
  }
  d.print(`${C.g}${d.t("ok", "ок")}${C.x}`);
  return answer;
}

type ListItem = string | { id: string; label?: string };

const itemId = (item: ListItem): string =>
  typeof item === "string" ? item : item.id;

const itemLabel = (item: ListItem): string =>
  typeof item === "string" ? item : (item.label ?? item.id);

// Выбор из списка по номеру (с номером по умолчанию). На экране — подпись, в ответ — id.
async function pickFromList(
  d: Core,
  items: readonly ListItem[],
  current: string,
  recommended: string,
): Promise<string> {
  if (d.nonInteractive && current) return current;
  const ids = items.map(itemId);
  items.forEach((item, i) =>
    d.print(listLine(itemLabel(item), i, itemId(item) === recommended)),
  );
  const defNum = defaultNumber(ids, current, recommended);
  const choice = await ask(
    d,
    `\n  ${d.t("Model number", "Номер модели")}`,
    String(defNum),
  );
  return ids[listIndex(choice, ids.length, defNum)];
}

const listLine = (text: string, i: number, marked: boolean) =>
  `   ${String(i + 1).padStart(2)}. ${text}${marked ? `  ${C.g}★${C.x}` : ""}`;

/** Номер пункта по умолчанию: текущий, иначе рекомендованный, иначе первый. */
export function defaultNumber(
  items: readonly string[],
  current: string,
  recommended: string,
): number {
  const curIdx = items.indexOf(current);
  return (curIdx >= 0 ? curIdx : Math.max(0, items.indexOf(recommended))) + 1;
}

/** Индекс выбранного пункта; всё, что не номер пункта, уводит в пункт по умолчанию. */
export function listIndex(
  choice: string,
  length: number,
  defNum: number,
): number {
  const idx = parseInt(choice, 10) - 1;
  return idx >= 0 && idx < length ? idx : defNum - 1;
}

// Выбор свободного порта: спрашиваем желаемый, проверяем тем же чекером, что и
// `check-port` (scripts/lib/ports.ts); занят — предлагаем ближайший свободный. Закрывает
// корень бага на этапе настройки: сервер не стартует на занятом порту.
function pickPort(d: Core, def: string): Promise<string> {
  return untilAnswered(() => portRound(d, def));
}

/** Номер порта 1..65535 из ответа, иначе null. */
export function parsePort(text: string): number | null {
  const port = Number(text);
  return isPortNumber(port) ? port : null;
}

const isPortNumber = (port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65535;

async function portRound(d: Core, def: string): Promise<string | null> {
  const port = parsePort(
    await ask(
      d,
      `  ${d.t("Local eve-server port", "Порт локального eve-сервера")}`,
      String(def),
    ),
  );
  if (port === null) {
    if (d.nonInteractive) throw new Error("IVA_PORT must be a number 1..65535");
    d.print(
      `  ${C.r}${d.t("Invalid port", "Некорректный порт")}${C.x} — ${d.t("must be a number 1..65535.", "нужно число 1..65535.")}`,
    );
    return null;
  }
  return claimPort(d, port, def);
}

async function claimPort(
  d: Core,
  port: number,
  def: string,
): Promise<string | null> {
  const { occupied, holders } = await d.checker.check(port);
  if (!occupied) return String(port);
  const reuse = await confirmOccupiedCurrentPort({
    port,
    currentPort: def,
    holders,
    confirm: (details) => confirmKeepOccupied(d, details),
  });
  if (reuse) return String(port);
  return offerFreePort(d, port, holders);
}

const holdersNote = (holders: readonly string[]) =>
  holders.length ? ` (${holders.join("; ")})` : "";

function confirmKeepOccupied(
  d: Core,
  { port, holders }: OccupiedPortDetails,
): Promise<boolean> {
  d.print(
    `  ${C.y}${d.t(
      `Port ${port} is already occupied${holdersNote(holders)}. Ownership cannot be verified.`,
      `Порт ${port} уже занят${holdersNote(holders)}. Проверить владельца надёжно нельзя.`,
    )}${C.x}`,
  );
  return askYesNo(
    d,
    `  ${d.t(
      `Keep occupied port ${port}? Only confirm if it is the running Iva`,
      `Оставить занятый порт ${port}? Подтверди, только если это запущенная Iva`,
    )}`,
    false,
  );
}

// Не взял свободный — круг повторяется, и порт вводится вручную.
async function offerFreePort(
  d: Core,
  port: number,
  holders: readonly string[],
): Promise<string | null> {
  const free = await new PortSelector(d.checker).firstFree(port + 1);
  if (d.nonInteractive && !free) throw new Error("No free IVA_PORT found");
  d.print(
    `  ${C.y}${d.t(`Port ${port} is busy${holdersNote(holders)}.`, `Порт ${port} занят${holdersNote(holders)}.`)}${C.x}${freeNote(d, free)}`,
  );
  if (
    free &&
    (await askYesNo(d, `  ${d.t(`Take ${free}?`, `Взять ${free}?`)}`, true))
  )
    return String(free);
  return null;
}

const freeNote = (d: Core, free: number | null) =>
  free
    ? ` ${d.t("Nearest free", "Ближайший свободный")}: ${C.g}${free}${C.x}.`
    : "";
