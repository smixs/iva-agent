// One classifier and one human text for calls, schedule stderr, doctor and Notices.
import { readClaudeAuthSnapshot } from "./claude-auth-rotation.ts";
export const MODEL_AUTH_REPEAT_MS = 24 * 60 * 60 * 1000;
export type AuthLanguage = "ru" | "en";
const PROVIDERS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "ChatGPT",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  ollama: "Ollama",
  custom: "API",
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** The runtime and all auth evidence use the same installation provider. */
export function modelAuthProvider(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const provider = env.MODEL_PROVIDER ?? "ollama";
  return Object.hasOwn(PROVIDERS, provider) ? provider : "custom";
}

function errorLines(text: string): string {
  const lines = text
    .split("\n")
    .filter((line) => !/отброшено:|discarded:|^\s*Card\b/iu.test(line));
  const errors = lines.filter((line) =>
    /\b\w*Error:|\bstatusCode\b|token refresh failed|CODEX_AUTH_EXPIRED|^\s*(?:OAuth session expired|Failed to authenticate|invalid_grant|not logged in)/iu.test(
      line,
    ),
  );
  // Schedule stderr includes content. Only the final exception and explicit status/auth lines count.
  if (text.includes("\n")) {
    const last = [...errors]
      .reverse()
      .find((line) => /\b\w*Error:/u.test(line));
    return errors
      .filter((line) => line === last || !/\b\w*Error:/u.test(line))
      .join("\n");
  }
  return lines.join("\n");
}
function errorEvidence(error: unknown): string {
  const obj = record(error);
  const details = record(obj.details);
  return [
    typeof error === "string" && Object.keys(obj).length === 0
      ? errorLines(error)
      : "",
    ...[obj, details].flatMap((value) => [
      ...["message", "code", "upstreamMessage", "apiErrorMessage", "tail"].map(
        (key) => (typeof value[key] === "string" ? errorLines(value[key]) : ""),
      ),
      ...["statusCode", "upstreamStatusCode"].map((key) =>
        typeof value[key] === "number" || typeof value[key] === "string"
          ? `statusCode: ${value[key]}`
          : "",
      ),
    ]),
  ].join("\n");
}
/** Read only error evidence, never stacks, tool results or request bodies. */
export function modelAuthFailure(
  error: unknown,
  provider?: string,
): string | null {
  const evidence = errorEvidence(error);
  const resolved = modelAuthProvider(
    provider === undefined ? process.env : { MODEL_PROVIDER: provider },
  );
  if (
    /oauth session expired|failed to authenticate|invalid_grant|CODEX_AUTH_EXPIRED|not logged in/iu.test(
      evidence,
    )
  )
    return resolved;
  const statuses = [
    ...evidence.matchAll(
      /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+|\bAPI Error:\s*|\bstatusCode["']?\s*[:=]\s*|^\s*(?:\w*Error:\s*)?)([45]\d\d)\b/gimu,
    ),
  ].map((match) => Number(match[1]));
  if (
    statuses.some(
      (status) =>
        status === 429 || status === 408 || status === 402 || status >= 500,
    )
  )
    return null;
  const auth =
    /not signed in|(?:run|please|use)\s+\/login\b|invalid[ _-]?(?:x[ _-]?)?api[ _-]?key|unauthorized|token refresh failed:\s*(?:400|401)/iu.test(
      evidence,
    );
  const forbiddenKey =
    statuses.includes(403) &&
    /\b(?:key|token|authorization|authentication)\b/iu.test(evidence);
  return auth || forbiddenKey || statuses.includes(401) ? resolved : null;
}

const JOB_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  "memory-night": ["ночная память", "nightly memory"],
  proactive: ["обзор дня", "daily overview"],
  "memory-digest": ["обзор дня", "daily overview"],
};
function authJobName(name: string, lang: AuthLanguage): string {
  return (
    JOB_NAMES[name]?.[lang === "ru" ? 0 : 1] ??
    (lang === "ru" ? "задание по расписанию" : "scheduled job")
  );
}

type AuthTextFacts = {
  since?: number;
  answers?: boolean;
  jobs?: readonly string[];
  timeZone?: string;
};
function authEffects(facts: AuthTextFacts, lang: AuthLanguage): string[] {
  const jobs = [
    ...new Set((facts.jobs ?? []).map((job) => authJobName(job, lang))),
  ];
  return [
    ...(facts.answers
      ? [lang === "ru" ? "ответы на сообщения" : "replies to messages"]
      : []),
    ...jobs,
  ];
}
function authSince(facts: AuthTextFacts, lang: AuthLanguage): string {
  if (facts.since === undefined) return "";
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", {
    timeZone: facts.timeZone ?? "UTC",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(facts.since);
}
function authRepair(provider: string): string | null {
  if (provider === "claude") return "claude auth login";
  return provider === "codex" ? "iva login" : null;
}
function authImpact(facts: AuthTextFacts, lang: AuthLanguage): string {
  const effects = authEffects(facts, lang);
  const when = authSince(facts, lang);
  const affected = effects.length
    ? lang === "ru"
      ? `, поэтому сейчас недоступны ${effects.join(", ")}`
      : `, so these are currently unavailable: ${effects.join(", ")}`
    : "";
  const since = when
    ? lang === "ru"
      ? ` (с ${when})`
      : ` (since ${when})`
    : "";
  return affected + since;
}
function externalClaudeAuthText(lang: AuthLanguage, impact: string): string {
  if (lang === "ru")
    return `Внешний пропуск Claude, который использует Ива, не принимается${impact}.\nПропуск приходит извне. Проверьте службу синхронизации внешнего пропуска на машине, где стоит Ива, затем напишите мне любое сообщение.`;
  return `The external Claude access token used by Iva is not accepted${impact}.\nThe token is supplied externally. Check the external access synchronization service on the machine running Iva, then send me any message.`;
}
function standardAuthText(
  provider: string,
  lang: AuthLanguage,
  impact: string,
): string {
  const name = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : "API";
  const repair = authRepair(provider);
  if (lang === "ru")
    return `${repair ? `Вход Ивы в ${name} истёк` : "Ключ API, который использует Ива, не принимается"}${impact}.\nКак починить: на машине, где стоит Ива, ${repair ? `выполните \`${repair}\`` : "замените ключ в /menu → Модель"}, затем напишите мне любое сообщение.`;
  return `${repair ? `Iva's login to ${name} has expired` : "The API key used by Iva is not accepted"}${impact}.\nHow to fix: on the machine running Iva, ${repair ? `run \`${repair}\`` : "replace the key in /menu → Model"}, then send me any message.`;
}
export function modelAuthText(
  provider: string,
  lang: AuthLanguage,
  facts: AuthTextFacts = {},
): string {
  const impact = authImpact(facts, lang);
  return provider === "claude" && readClaudeAuthSnapshot().source === "external"
    ? externalClaudeAuthText(lang, impact)
    : standardAuthText(provider, lang, impact);
}

export function modelAuthRecoveryText(
  provider: string,
  lang: AuthLanguage,
  jobs: readonly string[],
): string {
  const name = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : "API";
  const base =
    lang === "ru"
      ? `Вход в ${name} восстановлен, я снова на связи.`
      : `Login to ${name} is restored, I am available again.`;
  const night = jobs.includes("memory-night")
    ? lang === "ru"
      ? " Ночная память соберёт пропущенные дни при следующем запуске."
      : " Nightly memory will catch up on missed days at its next run."
    : "";
  const rest = jobs.filter((job) => job !== "memory-night");
  // Names come from jobs.json, but only safe schedule names become command arguments.
  const commands = rest
    .filter((job) => /^[a-zA-Z0-9_-]+$/u.test(job))
    .map((job) => `\`iva jobs ack ${job}\``)
    .join(", ");
  const ack = commands
    ? lang === "ru"
      ? ` Проверьте оставшиеся провалы и закройте их: ${commands}.`
      : ` Check the remaining failures and acknowledge them: ${commands}.`
    : "";
  return base + night + ack;
}

/** A direct SDK caller reports its successful call in the existing schedule stderr tail. */
export function modelAuthSuccessLine(provider: string, at: number): string {
  return `iva-model-auth-success ${provider} ${at}`;
}
export function modelAuthSuccess(
  tail: string,
): { provider: string; at: number } | null {
  const match =
    /^iva-model-auth-success (claude|codex|openrouter|opencode|ollama|custom) (\d+)$/mu.exec(
      tail,
    );
  if (!match) return null;
  const at = Number(match[2]);
  return Number.isSafeInteger(at) && at > 0 ? { provider: match[1], at } : null;
}
