export const CONTEXT_WINDOW_CONFIGURATION_ERROR =
  "CONTEXT_WINDOW_CONFIGURATION_ERROR";

export class ContextWindowConfigurationError extends Error {
  declare readonly code: typeof CONTEXT_WINDOW_CONFIGURATION_ERROR;
  declare readonly variable: string;
  declare readonly value: string;

  constructor(variable: string, value: string) {
    super(
      `Invalid ${variable} ${JSON.stringify(value)}; expected a positive safe integer — run: iva config`,
    );
    this.name = "ContextWindowConfigurationError";
    this.code = CONTEXT_WINDOW_CONFIGURATION_ERROR;
    this.variable = variable;
    this.value = value;
  }
}

export function resolveContextWindow(
  variable: string,
  raw: string,
  fallback?: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback: number,
): number;
export function resolveContextWindow(
  variable: string,
  raw: string | undefined,
  fallback?: number,
): number {
  if (raw !== undefined && !/^\d+$/.test(raw))
    throw new ContextWindowConfigurationError(variable, raw);
  const value = raw === undefined ? fallback : Number(raw);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ContextWindowConfigurationError(
      variable,
      raw ?? String(fallback),
    );
  return value;
}

/**
 * Пул моделей аккаунта. Рукопожатие CLI отдаёт route-ид (`resolvedModel`): `claude-fable-5-1`,
 * `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (у CLI постарше
 * `claude-haiku-4-5-20251001`) — и он же ложится в CLAUDE_MODEL. CLI же выбирает модель по
 * СВОЕМУ имени, и у миллионного окна оно с суффиксом `[1m]`: `claude -p --model
 * claude-fable-5-1` отвечает «It may not exist or you may not have access to it» (проверено
 * живьём 22.09.2026, CLI 2.1.278, план Max), а `claude-fable-5-1[1m]` — работает. Haiku 4.5
 * миллионного окна не умеет вовсе, поэтому едет без суффикса. Окно контекста считается здесь же: одно число на весь вендор было бы враньём
 * в одну из сторон, а меньшее окно безопаснее большего — оно лишь раньше сжимает историю,
 * тогда как завышенное валит ход на первом же переполнении.
 */
const CLAUDE_MODELS: Record<
  string,
  {
    readonly native: string;
    readonly window: number;
    readonly adaptive: boolean;
  }
> = {
  "claude-fable-5-1": {
    native: "claude-fable-5-1",
    window: 1_000_000,
    adaptive: true,
  },
  // Живьём 23.09.2026 (CLI 2.1.280): пикер отдаёт resolvedModel `claude-opus-5-5[1m]`,
  // `claude -p --model claude-opus-5-5[1m]` с adaptive thinking отвечает, окно 1000000.
  "claude-opus-5-5": {
    native: "claude-opus-5-5",
    window: 1_000_000,
    adaptive: true,
  },
  // Живьём 29.09.2026 (CLI 2.1.284, подписка): пикер отдаёт resolvedModel `claude-sonnet-5-5`
  // на псевдоним `sonnet`, `claude -p --model claude-sonnet-5-5[1m]` отвечает, окно 1000000.
  "claude-sonnet-5-5": {
    native: "claude-sonnet-5-5",
    window: 1_000_000,
    adaptive: true,
  },
  // Живьём 08.10.2026 (CLI 2.1.287 на c1, подписка): пикер этой модели ещё не знает
  // (`haiku` → Haiku 4.5), CLI печатает «isn't described by this version's model catalog… append
  // [1m] to the model name for 1M», но и `claude-haiku-5-5`, и `claude-haiku-5-5[1m]` отвечают
  // «ок»; с adaptive thinking приняты усилия low…max, мусорное — 400. Окно 1M по документации
  // Anthropic. Пикер CLI 2.1.293 отдаёт её на псевдоним `haiku`.
  "claude-haiku-5-5": {
    native: "claude-haiku-5-5",
    window: 1_000_000,
    adaptive: true,
  },
  // Прошлые Opus, Sonnet и Haiku остаются в таблице: у кого в .env старый id, без строки
  // здесь ход ушёл бы к CLI именем без суффикса, а на такое имя он отвечает «модели нет».
  "claude-sonnet-5": {
    native: "claude-sonnet-5",
    window: 1_000_000,
    adaptive: true,
  },
  "claude-opus-5": {
    native: "claude-opus-5",
    window: 1_000_000,
    adaptive: true,
  },
  "claude-opus-4-8": {
    native: "claude-opus-4-8",
    window: 1_000_000,
    adaptive: true,
  },
  // Haiku 4.5 adaptive thinking не умеет: с ним подписка отвечает
  // 400 «adaptive thinking is not supported on this model» (живьём 22.09.2026).
  "claude-haiku-4-5-20251001": {
    native: "claude-haiku-4-5-20251001",
    window: 200_000,
    adaptive: false,
  },
};
/** Короткие имена из списка аккаунта и старых .env — те же модели. */
const CLAUDE_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  // `haiku` — на 5.5, как у пикера CLI 2.1.293: окно у неё не меньше, чем у 4.5, а живая
  // проба на c1 прошла. Прошлая модель остаётся по полному имени.
  haiku: "claude-haiku-5-5",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};
/** Незнакомая модель: окно берём меньшее из известных — см. рассуждение выше. */
const CLAUDE_UNKNOWN_WINDOW = 200_000;

/**
 * Имя для `--model` и окно контекста одной моделью: `[1m]` снимается с route-ида (его может
 * дописать владелец руками), короткое имя разворачивается в полное, миллионному окну суффикс
 * возвращается. Незнакомый ид уезжает как есть: чужой аккаунт не угадывают, а отказ CLI
 * назовёт модель по имени.
 */
export function claudeModel(route: string): {
  readonly native: string;
  readonly window: number;
  readonly adaptive: boolean;
} {
  const asked = route.trim();
  const bare = asked.replace(/\[1m\]$/u, "");
  const entry = CLAUDE_MODELS[CLAUDE_ALIASES[bare] ?? bare];
  if (entry === undefined)
    return { native: asked, window: CLAUDE_UNKNOWN_WINDOW, adaptive: false };
  return entry.window === 200_000
    ? entry
    : { ...entry, native: `${entry.native}[1m]` };
}

/** Окно контекста выбранной модели: та же таблица, что и у имени для CLI. */
export function claudeContextWindow(route: string): number {
  return claudeModel(route).window;
}

// Defaults belong to the same resolver for runtime, setup and status displays.
const PROVIDER_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  ollama: 131_072,
  opencode: 131_072,
  openrouter: 131_072,
  codex: 272_000,
  custom: 131_072,
};

export function providerContextWindow(
  provider: string,
  model: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const variable = `${provider.toUpperCase()}_CONTEXT_WINDOW`;
  const fallback =
    provider === "claude"
      ? claudeContextWindow(model)
      : PROVIDER_CONTEXT_WINDOWS[provider];
  return resolveContextWindow(variable, env[variable] || undefined, fallback);
}
