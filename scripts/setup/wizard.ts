// Мастер установки как список шагов: каждый шаг получает состояние и контекст, шаги идут по
// порядку, шаг может закончить мастер (настройка оставлена как есть). Живой ввод, сеть и
// пути к .env подключает scripts/setup/main.ts; тесты подают сценарий ответов и подмены.
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "../lib/assistant-auth.ts";
import {
  catalogProvider,
  providerBase,
  providerEnvKeys,
  type ProviderCatalogEntry,
} from "../lib/model-catalog.ts";
import { keptSetupWritePlan } from "../lib/setup-keep.ts";
import { menuChoice } from "./answers.ts";
import {
  askKeysSettings,
  askProviderSettings,
  askTelegramSettings,
  askVaultAndPort,
  C,
  writeSetupEnv,
  type Env,
  type SetupContext,
  type SetupState,
} from "./steps.ts";

export type WizardDeps = {
  readonly ctx: SetupContext;
  readonly setLang: (lang: string) => void;
  /** Текущий .env (пустой, если файла нет). */
  readonly readExisting: () => Promise<Env>;
  /** Есть ли вход в подписку OpenAI (data/codex-auth.json) для этой настройки. */
  readonly codexLoggedIn: (existing: Env) => boolean;
  /** Запись идёт в файл-кандидат `iva config`, а не в живой .env. */
  readonly staging: boolean;
  readonly closeInput: () => void;
};

export type ExistingConfiguration = {
  readonly prov0: string;
  readonly cat0: ProviderCatalogEntry | undefined;
  readonly provModel: string;
  readonly provKey: string | null;
  readonly isComplete: boolean;
};

/** Состояние одного прохода мастера: провайдер появляется на шаге выбора. */
type Progress = {
  readonly deps: WizardDeps;
  readonly ctx: SetupContext;
  readonly existing: Env;
  readonly out: Env;
  readonly config: ExistingConfiguration;
  provider: string;
};

/** Шаг мастера: false — мастер закончен, следующие шаги не идут. */
type Step = (p: Progress) => Promise<boolean>;

// Порядок тот же, что у имён рантайма (agent/lib/model-provider.ts): claude идёт сразу за
// codex, потому что оба — подписка без ключа, и номера пунктов читаются вместе с ним.
const PROVIDER_MENU = [
  "ollama",
  "opencode",
  "codex",
  "claude",
  "openrouter",
  "custom",
  "requesty",
];
const LANGUAGES = new Set(["en", "ru"]);

const STEPS: readonly Step[] = [
  chooseLanguage,
  reportInvalidProvider,
  confirmSetup,
  chooseProvider,
  settingsStep(askProviderSettings),
  settingsStep(askKeysSettings),
  settingsStep(askTelegramSettings),
  settingsStep(askVaultAndPort),
  writeStep,
];

export async function runWizard(deps: WizardDeps): Promise<void> {
  const progress = await start(deps);
  for (const step of STEPS) if (!(await step(progress))) break;
  deps.closeInput();
}

async function start(deps: WizardDeps): Promise<Progress> {
  const existing = await deps.readExisting();
  return {
    deps,
    ctx: deps.ctx,
    existing,
    out: { ...existing, ASSISTANT_BEARER: bearerOf(existing) },
    config: existingConfiguration(existing, deps.codexLoggedIn),
    provider: "",
  };
}

/** Годный ключ сервера из .env остаётся, иначе выпускается новый. */
export function bearerOf(existing: Env): string {
  const current = existing.ASSISTANT_BEARER;
  return isAssistantBearer(current)
    ? current.trim()
    : generateAssistantBearer();
}

function settingsStep(
  step: (state: SetupState, ctx: SetupContext) => Promise<unknown>,
): Step {
  return async (p) => {
    await step(stateOf(p), p.ctx);
    return true;
  };
}

async function writeStep(p: Progress): Promise<boolean> {
  await writeSetupEnv(stateOf(p), p.ctx, p.deps.staging);
  return true;
}

const stateOf = (p: Progress): SetupState => ({
  existing: p.existing,
  out: p.out,
  provider: p.provider,
});

// ── Язык: интерфейса и ответов агента по умолчанию ─────────────────
// install.sh спрашивает язык ПЕРВЫМ и передаёт его через окружение (AGENT_LANGUAGE) — тогда
// второй раз не спрашиваем. Отдельный `npm run setup` окружения не имеет → спрашиваем.
async function chooseLanguage(p: Progress): Promise<boolean> {
  const lang =
    presetLanguage(p.ctx.envValue("AGENT_LANGUAGE")) ?? (await askLanguage(p));
  p.deps.setLang(lang);
  p.out.AGENT_LANGUAGE = lang;
  p.ctx.print(
    `  → ${p.ctx.t("Iva will reply in English by default.", "Iva будет отвечать по-русски по умолчанию.")}`,
  );
  return true;
}

/** Язык из окружения установщика, если он из поддержанных. */
export function presetLanguage(value: string | undefined): string | null {
  const lang = (value || "").toLowerCase();
  return LANGUAGES.has(lang) ? lang : null;
}

async function askLanguage(p: Progress): Promise<string> {
  p.ctx.print(`\n${C.b}${C.c}  🌐 Language / Язык${C.x}`);
  p.ctx.print("    1) English");
  p.ctx.print("    2) Русский");
  const langChoice = await p.ctx.ask(
    "  Choose / Выбор (1/2)",
    p.existing.AGENT_LANGUAGE === "ru" ? "2" : "1",
  );
  return menuChoice(langChoice) === 2 ? "ru" : "en";
}

// Провайдер берётся ТОЧНЫМ именем из общего каталога — того же, на который смотрят рантайм
// и доктор. Неизвестное имя (опечатка `ollmaa`) не сходится ни с одним ключом: раньше карты
// промахивались, API-ключ выпадал из обязательных, мастер объявлял сломанный .env настроенным
// и выходил — а это тот самый мастер, к которому отказ агента и отправляет (issue #161).
// `??`, не `||`: `MODEL_PROVIDER=` в .env — это заданное пустое значение, и рантайм,
// доктор, статус и апдейт его отвергают. Схлопни его здесь в ollama — и единственный
// экран, который умеет починить, снова объявил бы сломанный .env настроенным.
export function existingConfiguration(
  existing: Env,
  codexLoggedIn: (existing: Env) => boolean,
): ExistingConfiguration {
  const prov0 = existing.MODEL_PROVIDER ?? "ollama";
  const cat0 = catalogProvider(prov0);
  return {
    prov0,
    cat0,
    provModel: modelVarOf(cat0),
    // codex — доступ по OAuth-токену (data/codex-auth.json), у остальных — API-ключ в .env.
    provKey: keyVarOf(cat0),
    isComplete: isCompleteConfiguration(
      existing,
      cat0,
      prov0 !== "codex" || codexLoggedIn(existing),
    ),
  };
}

const modelVarOf = (cat: ProviderCatalogEntry | undefined) =>
  cat?.modelVar ?? "OLLAMA_MODEL";

const keyVarOf = (cat: ProviderCatalogEntry | undefined) => cat?.keyVar ?? null;

// Список ключей общий с `iva doctor`: иначе один объявил бы .env полным, а второй — нет.
function isCompleteConfiguration(
  existing: Env,
  cat: ProviderCatalogEntry | undefined,
  loggedIn: boolean,
): boolean {
  if (!cat || !loggedIn) return false;
  return requiredKeys(cat).every((k) => hasValue(existing[k]));
}

const requiredKeys = (cat: ProviderCatalogEntry) => [
  ...providerEnvKeys(cat),
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
];

const hasValue = (value: string | undefined) => Boolean((value || "").trim());

function reportInvalidProvider(p: Progress): Promise<boolean> {
  if (!p.config.cat0)
    p.ctx.print(
      `\n${C.y}  ⚠ ${p.ctx.t(
        `MODEL_PROVIDER is invalid (${p.config.prov0}) — Iva won't start until you pick one below.`,
        `MODEL_PROVIDER невалиден (${p.config.prov0}) — Iva не стартует, пока не выберешь провайдера ниже.`,
      )}${C.x}`,
    );
  return Promise.resolve(true);
}

// Уже настроено? По шагам не идём — спрашиваем один раз.
function confirmSetup(p: Progress): Promise<boolean> {
  if (p.config.isComplete) return keepOrReconfigure(p);
  printFreshSetupIntro(p.ctx);
  return Promise.resolve(true);
}

/**
 * Полная настройка: один вопрос вместо шагов. True — владелец перенастраивается, мастер
 * идёт дальше; false — настройки оставлены как есть (с проверкой и записью, если план
 * это требует), и мастер завершён.
 */
async function keepOrReconfigure(p: Progress): Promise<boolean> {
  const { ctx } = p;
  ctx.print(
    `\n${C.b}${C.g}  ${ctx.t("Iva is already configured:", "Iva уже настроена:")}${C.x}`,
  );
  printCurrentModel(p);
  printCurrentAccess(p);
  if (
    await ctx.askYesNo(
      `\n  ${ctx.t("Reconfigure from scratch?", "Перенастроить заново?")}`,
      false,
    )
  ) {
    ctx.print(
      `\n  ${ctx.t("Going step by step.", "Идём по шагам.")} ${C.y}${ctx.t("Enter at each step keeps the current value.", "Enter на каждом шаге оставит текущее значение.")}${C.x}`,
    );
    return true;
  }
  await keepCurrent(p);
  ctx.print(
    `${C.g}  ${ctx.t("Keeping current settings — nothing to enter.", "Оставляю текущие настройки как есть — ничего вводить не нужно.")}${C.x}`,
  );
  return false;
}

function printCurrentModel({ ctx, existing, config }: Progress): void {
  ctx.print(`  • ${ctx.t("Provider", "Провайдер")}: ${config.prov0}`);
  ctx.print(
    `  • ${ctx.t("Model", "Модель")}:    ${existing[config.provModel]}`,
  );
  ctx.print(
    `  • ${ctx.t("Bot", "Бот")}:       @${existing.TELEGRAM_BOT_USERNAME || "?"}`,
  );
}

function printCurrentAccess({ ctx, existing }: Progress): void {
  ctx.print(
    `  • ${ctx.t("Access", "Доступ")}:    ${existing.TELEGRAM_ALLOWED_USER_IDS}`,
  );
  ctx.print(
    `  • Deepgram:  ${existing.DEEPGRAM_LANGUAGE || "multi"}   ·   TZ: ${existing.ASSISTANT_TIMEZONE || "?"}`,
  );
}

/** Оставить как есть: проверка модели и запись, только если ответы разошлись с файлом. */
async function keepCurrent(p: Progress): Promise<void> {
  if (keptSetupWritePlan(p.existing, p.out) !== "validate-and-write") return;
  await p.ctx.validateModelSelection(currentSelection(p));
  await p.ctx.writeEnv(p.out);
}

function currentSelection({ ctx, existing, config }: Progress) {
  return {
    provider: config.prov0,
    model: existing[config.provModel],
    key: currentKey(existing, config.provKey),
    dataDir: ctx.dataDirAbs(existing),
    ...baseOf(config.cat0, existing),
  };
}

const currentKey = (existing: Env, keyVar: string | null) =>
  keyVar ? existing[keyVar] || undefined : undefined;

const baseOf = (cat: ProviderCatalogEntry | undefined, env: Env) =>
  cat ? { base: providerBase(cat, env) } : {};

/** Свежая настройка: что сейчас будет. */
function printFreshSetupIntro(ctx: SetupContext): void {
  ctx.print(
    `\n${C.b}${C.g}  ${ctx.t("Iva setup — entering secrets step by step", "Настройка Iva — вводим секреты по шагам")}${C.x}`,
  );
  ctx.print(
    `  ${ctx.t("Takes a couple of minutes. For each key I'll tell you where to get it and check it on the spot.", "Займёт пару минут. Для каждого ключа подскажу, где его взять, и проверю на месте.")}`,
  );
  ctx.print(
    `  ${C.y}${ctx.t("The script won't exit until you've entered every required secret.", "Скрипт не завершится, пока вы не введёте все обязательные секреты.")}${C.x}`,
  );
}

// ── Шаг 1: провайдер модели ────────────────────────────────────────
async function chooseProvider(p: Progress): Promise<boolean> {
  const { ctx } = p;
  ctx.head(
    1,
    ctx.t("Provider and model — Iva's brain", "Провайдер и модель — мозг Iva"),
  );
  printProviderMenu(ctx);
  const choice = await ctx.ask(
    `  ${ctx.t("Provider", "Провайдер")} (1/2/3/4/5/6/7)`,
    providerDefault(p.config.prov0),
  );
  p.provider = providerFor(menuChoice(choice));
  p.out.MODEL_PROVIDER = p.provider;
  return true;
}

/** Номер пункта меню для текущего провайдера; неизвестный — Ollama. */
export function providerDefault(prov0: string): string {
  return String(Math.max(0, PROVIDER_MENU.indexOf(prov0)) + 1);
}

/** Провайдер по номеру пункта меню; не пункт меню — Ollama. */
export function providerFor(choice: number | null): string {
  return PROVIDER_MENU[(choice ?? 0) - 1] ?? "ollama";
}

function printProviderMenu(ctx: SetupContext): void {
  ctx.print(
    `  ${ctx.t("Who to reach the model through:", "Через кого ходить к модели:")}`,
  );
  ctx.print(
    `    1) Ollama Cloud — ${C.c}https://ollama.com${C.x} ${ctx.t("(~$20/mo, higher limits)", "(~$20/мес, лимиты побольше)")}`,
  );
  ctx.print(
    `    2) OpenCode Go — ${C.c}https://opencode.ai/go${C.x} ${ctx.t("(~$5/mo, cheaper)", "(~$5/мес, дешевле)")}`,
  );
  ctx.print(
    `    3) OpenAI ${ctx.t("(ChatGPT subscription)", "(подписка ChatGPT)")} — ${C.c}chatgpt.com${C.x} ${ctx.t("(sign in, no API key)", "(вход по подписке, без API-ключа)")}`,
  );
  ctx.print(
    `    4) Claude ${ctx.t("(Pro/Max subscription)", "(подписка Pro/Max)")} — ${C.c}claude.ai${C.x} ${ctx.t("(the claude CLI signed in on this server, no API key)", "(CLI claude, залогиненный на этом сервере, без API-ключа)")}`,
  );
  ctx.print(
    `    5) OpenRouter — ${C.c}https://openrouter.ai${C.x} ${ctx.t("(one key → 300+ models, pay-as-you-go)", "(один ключ → 300+ моделей, оплата по факту)")}`,
  );
  ctx.print(
    `    6) ${ctx.t("Custom — your own OpenAI-compatible endpoint", "Custom — свой OpenAI-совместимый эндпоинт")} ${ctx.t("(proxy, vLLM, LiteLLM, a vendor plan)", "(прокси, vLLM, LiteLLM, вендорская подписка)")}`,
  );
  ctx.print(
    `    7) Requesty: ${C.c}https://requesty.ai${C.x} ${ctx.t("(one key → 700+ models, pay-as-you-go)", "(один ключ → 700+ моделей, оплата по факту)")}`,
  );
}

/** Причина отказа мастера для строки «Настройка прервана»: сообщение ошибки или она сама. */
export function abortReason(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message || error;
}
