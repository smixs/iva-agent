import { cutText, insightLine, readTrace, turnRef } from "./turn-failures.ts";
const HEAD = /^[a-z][a-z0-9-]*$/u;
const WORD = /(?:[^\s;&|"'\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+|&&|[;&|]/gu;
export const TRACE_REPEAT_BYTES_PER_FILE = 4 * 1024 * 1024;
const DAY = 86_400_000,
  WINDOW = 30 * 60_000;
const READING_HEADS = new Set(
  "cat,head,tail,less,more,rg,grep,ls,pwd,find,wc,sed,awk,cd,export,sleep,echo,iva trace,iva diagnose".split(
    ",",
  ),
);
type Data = Record<string, unknown>;
type Line = ReturnType<typeof readTrace>["lines"][number];
const record = (v: unknown): Data =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Data) : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const number = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const clean = (v: unknown) => cutText(text(v).replace(/\s+/gu, " ").trim(), 60);
const at = (line: Line) => Date.parse(text(line.ts));
const isEvent = (line: Line, event: string) =>
  `${text(line.kind)}.${text(line.name)}` === event;
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const dataFor = (events: Line[], kind: string) =>
  events.filter((line) => isEvent(line, kind)).map((line) => record(line.data));
function group<T>(values: T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(value);
  }
  return groups;
}
function actionHead(value: unknown, input: unknown): string {
  const action = record(value),
    args = record(input),
    name = text(action.toolName);
  if (action.kind === "load-skill" || name === "load_skill")
    return `skill:${clean(action.name || args.skill || args.name)}`;
  if (name === "bash") return bashHead(text(args.command));
  if (name === "web_fetch") {
    try {
      return `web_fetch:${clean(new URL(text(args.url)).hostname)}`;
    } catch {
      return "";
    }
  }
  return clean(name);
}
function bashHead(command: string): string {
  const words = command.match(WORD) ?? [];
  const program = bashProgram(words);
  if (!HEAD.test(program) || READING_HEADS.has(program)) return "";
  const second = words[0] ?? "";
  const sub =
    /^(gws|tg|iva|gh|git|npm|bun)$/u.test(program) &&
    /^[a-z][a-z0-9-]{0,19}$/u.test(second) &&
    !/^[0-9a-f]{12,}$/u.test(second);
  const head = program + (sub ? ` ${second}` : "");
  return !READING_HEADS.has(head) ? `bash:${clean(head)}` : "";
}
function bashOptions(words: string[]): void {
  const valueFlag =
    /^(-[a-zA-Z]*[ugnCsokpUhrtDRTP]|--(unset|chdir|user|group|signal|kill-after|adjustment))$/u;
  while (words[0]?.startsWith("-"))
    if (valueFlag.test(words.shift()!)) words.shift();
}
function bashProgram(words: string[]): string {
  while (words.length) {
    const raw = words.shift()!;
    if (/^[A-Za-z_]\w*=/u.test(raw)) continue;
    const word = raw.replace(/^.*\/|^['"]|['"]$/gu, "");
    if (word === "cd") {
      const end = words.findIndex((w) => w === "&&" || w === ";");
      if (end < 0) return "";
      words.splice(0, end + 1);
      continue;
    }
    if (!/^(env|timeout|sudo|nice|nohup)$/u.test(word)) return word;
    bashOptions(words);
    if (word === "timeout") words.shift();
  }
  return "";
}
function summarize(events: Line[], incoming: Map<string, Line>) {
  const first = events[0];
  const actions = dataFor(events, "eve.actions.requested").flatMap((data) =>
    array(data.actions).map((action, i) =>
      actionHead(action, array(data.args)[i]),
    ),
  );
  const inputs = dataFor(events, "turn.bound").flatMap<Line>(
    (data) => incoming.get(text(data.updateKey)) ?? [],
  );
  const steps = new Map(
    dataFor(events, "eve.step.completed")
      .filter(({ stepIndex: i }) => Number.isSafeInteger(i) && number(i) === i)
      .map((data) => [
        data.stepIndex,
        ["in", "out", "cacheRead", "cacheWrite"].reduce(
          (sum, k) => sum + number(record(data.usage)[k]),
          0,
        ),
      ]),
  );
  return {
    ref: turnRef(text(first.session), text(first.turn)),
    session: text(first.session),
    at: at(events.at(-1)!),
    day: text(first.ts).slice(0, 10),
    request: clean(record(inputs.at(-1)?.data).text),
    messages: new Map(inputs.map((line) => [text(line.turn), at(line)])),
    actions,
    steps: steps.size,
    tokens: [...steps.values()].reduce((a, b) => a + b, 0),
    skill:
      actions.some((head) => head.startsWith("skill:")) ||
      dataFor(events, "eve.action.result").some(
        (data) => text(data.name) !== "",
      ),
    stop: events.some(
      (line) =>
        isEvent(line, "stop.requested") || isEvent(line, "eve.turn.cancelled"),
    ),
  };
}
type Turn = ReturnType<typeof summarize>;
function collect(dataDir: string, now: number): Turn[] {
  const lines = readTrace(dataDir, 15, TRACE_REPEAT_BYTES_PER_FILE)
    .lines.filter(
      (line) =>
        /^(?:channel:)?telegram$/u.test(text(line.source)) &&
        at(line) >= now - 14 * DAY &&
        at(line) <= now,
    )
    .sort((a, b) => at(a) - at(b));
  const incoming = new Map(
    lines
      .filter(
        (line) =>
          isEvent(line, "inbound.received") &&
          record(line.data).allowlisted === true,
      )
      .map((line) => [text(line.turn), line]),
  );
  const bound = lines.filter((line) =>
    [line.session, line.turn].every((id) => /^[\w-]{1,200}$/u.test(text(id))),
  );
  return [
    ...group(bound, (line) =>
      turnRef(text(line.session), text(line.turn)),
    ).values(),
  ].map((events) => summarize(events, incoming));
}
type Group = { heads: string[]; turns: Set<Turn> };
function add(groups: Map<string, Group>, heads: string[], turn: Turn) {
  const key = JSON.stringify(heads),
    found = groups.get(key) ?? { heads, turns: new Set() };
  groups.set(key, found);
  found.turns.add(turn);
}
function render(kind: string, group: Group, count = group.turns.size) {
  const turns = [...group.turns];
  const latest = [...turns].sort(
    (a, b) => b.at - a.at || a.ref.localeCompare(b.ref),
  )[0];
  const steps = turns.map((t) => t.steps).sort((a, b) => a - b);
  const median =
    (steps[Math.floor((steps.length - 1) / 2)] +
      steps[Math.floor(steps.length / 2)]) /
    2;
  const tokens = turns.reduce((sum, t) => sum + t.tokens, 0),
    skill = turns.some((t) => t.skill) ? "yes" : "no";
  return {
    at: latest.at,
    line: insightLine(
      {
        count,
        where: `${kind} ${group.heads.join(" → ")}`.trim(),
        kind: `median steps ${median}, tokens ${tokens}, skill ${skill}`,
        reason: latest.request,
        ref: latest.ref,
        at: latest.at,
      },
      1000,
    ),
  };
}
function patterns(turns: Turn[]) {
  const chains = new Map<string, Group>(),
    long = new Map<string, Group>();
  for (const t of turns) {
    if (t.steps >= 15 && !t.skill)
      add(long, t.actions.filter(Boolean).slice(0, 2), t);
    for (let i = 0; i < t.actions.length; i++)
      for (let n = 3; n <= 6 && i + n <= t.actions.length; n++) {
        const heads = t.actions.slice(i, i + n);
        if (heads.every(Boolean)) add(chains, heads, t);
      }
  }
  return { chains, long };
}
function maximal(chains: Map<string, Group>) {
  const repeats = [...chains.values()].filter(
      (g) =>
        g.turns.size >= 3 && new Set([...g.turns].map((t) => t.day)).size >= 2,
    ),
    hidden = new Set<Group>();
  for (const parent of repeats)
    for (let i = 0; i < parent.heads.length; i++)
      for (let n = 3; n < parent.heads.length; n++) {
        const child = chains.get(JSON.stringify(parent.heads.slice(i, i + n)));
        if (
          child &&
          child.turns.size === parent.turns.size &&
          [...child.turns].every((t) => parent.turns.has(t))
        )
          hidden.add(child);
      }
  return repeats.filter((g) => !hidden.has(g));
}
export function listTurnRepeats(dataDir: string, nowMs: number): string[] {
  const turns = collect(dataDir, nowMs),
    { chains, long } = patterns(turns);
  const out = maximal(chains).map((g) => render("repeat", g));
  for (const g of long.values()) out.push(render("long without skill", g));
  for (const session of group(turns, (t) => t.session).values()) {
    const times = [
      ...new Map(session.flatMap((t) => [...t.messages])).values(),
    ].sort((a, b) => a - b);
    const inWindow = (time: number, start: number) =>
      time >= start && time <= start + WINDOW;
    const start = times
      .filter(
        (time, i) =>
          i + 3 < times.length &&
          times[i + 3] - time <= WINDOW &&
          session.some(
            (t) => inWindow(t.at, time) && (t.stop || t.steps >= 10),
          ),
      )
      .at(-1);
    if (start !== undefined) {
      const turns = new Set(session.filter((t) => inWindow(t.at, start)));
      const count = times.filter((t) => inWindow(t, start)).length;
      out.push(render("guided", { heads: [], turns }, count));
    }
  }
  return out
    .sort((a, b) => b.at - a.at || a.line.localeCompare(b.line))
    .slice(0, 10)
    .map((entry) => entry.line);
}
