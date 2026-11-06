import { restartFailure } from "../lib/systemd-control.ts";
import { resolveOpenCodeProtocol } from "@iva/opencode-protocol";
import {
  CATALOG,
  catalogModel,
  catalogProvider,
  checkKey,
  EFFORTS,
  fetchModelOptions,
  normalizeBaseUrl,
  providerBase,
  providerSupportsReasoning,
} from "../lib/model-catalog.ts";
import {
  ModelValidationError,
  validateModelSelection,
} from "../lib/model-validation.ts";
import { getAccessToken } from "#lib/codex-auth.ts";
import {
  claudeContextWindow,
  claudeModelLabel,
  claudeReasoningLevels,
  claudeStatus,
  CLAUDE_LOGIN_HINT,
  type ClaudeStatus,
} from "../lib/claude-cli-status.ts";
import { claudeInstallHint } from "../../packages/claude-command/index.ts";
import { runDeviceCodeLogin } from "../lib/codex-oauth.ts";
import { compactNumber, modelSummary } from "../lib/model-summary.ts";
import { getLang, tr } from "#lib/i18n.ts";
import { readEnvValues, upsertEnv } from "../lib/env-file.ts";
import { createFlows } from "../lib/tg-flow.ts";
import {
  button,
  buttonRow,
  escapeRichText,
  richRow,
  type RichButton,
  type RichButtonStyle,
} from "../lib/telegram-buttons.ts";
import type {
  ModelOption,
  ProviderCatalogEntry,
} from "../lib/model-catalog.ts";
import type { TelegramFlowState } from "../lib/tg-flow.ts";
import { ALLOWED, DATA_DIR_ABS, ENV_PATH, log } from "./config.ts";
import { reply, sc, tg } from "./transport.ts";

type FlowId = number | string;

type WizardState = TelegramFlowState & {
  chatId: FlowId;
  userId: FlowId;
  msgId: number | null;
  provider: string;
  modelOptions: ModelOption[];
  model: string;
  efforts: string[];
  effort: string | null;
  step: string;
  pendingKey?: string | null;
  // Владелец явно выбрал «без ключа»: строку ключа из .env надо убрать, а не оставить
  // старую от прошлого эндпоинта.
  dropKey?: boolean;
  // Адрес своего эндпоинта, введённый в этом же диалоге (custom).
  pendingBase?: string | null;
  // План подписки из чужого CLI (вендор claude): экран моделей называет его владельцу.
  plan?: string | null;
  reenterKey?: string | null;
  helperModel?: boolean;
};
type WizardRequestResult<T> =
  | { stale: true; ok?: false; value?: never; error?: never }
  | { stale?: false; ok: true; value: T; error?: never }
  | { stale?: false; ok: false; value?: never; error: unknown };
type TelegramResult = {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
};
type WizardTransport = (
  method: string,
  body: Record<string, unknown>,
) => Promise<TelegramResult>;
const wizardTg = tg as unknown as WizardTransport;
const errorMessage = (error: unknown) =>
  (error as { message?: unknown } | null | undefined)?.message;
// Отказ провайдера по ключу (401/403) — единственная причина, которую нельзя списать
// на «у эндпоинта нет каталога»: ключ неверен, и спрашивать модель бессмысленно.
const isAuthRejection = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "auth_rejected";

// Короткая причина для экрана: только сообщение ошибки, без стека и без объекта целиком.
const errorReason = (error: unknown) =>
  error instanceof Error ? error.message : "";
const messageCallSucceeded = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  (value as { ok?: unknown }).ok === true &&
  typeof (value as { result?: { message_id?: unknown } }).result?.message_id ===
    "number";
const replySucceeded = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { message_id?: unknown }).message_id === "number";
type WizardSnapshot = {
  msgId?: number | null;
  step?: string;
  modelOptions?: ModelOption[];
  efforts?: string[];
  effort?: string | null;
  model?: string;
};

// ── /model & /think wizard (out-of-band, inline keyboards) ─────────────────
// State lives in memory keyed by `${chatId}:${userId}`; each flow edits ONE message
// (like /update). A bridge restart loses state — stale button taps get "диалог устарел".
// Config is always read fresh from .env: this process's env goes stale after writes.
// Примитивы визарда вынесены в scripts/lib/tg-flow.ts (createFlows): тот же слот на
// пользователя делят /model, /think и /menu. Локальные алиасы сохраняют исходные call-sites —
// дифф визарда минимальный, а стейт-семантика (ключ chatId:userId, TTL 15 мин, identity-replace,
// edit-in-place) дословно та же.
const flows = createFlows({ tg: wizardTg, log });
const getWizard = (
  chatId: FlowId | undefined,
  userId: FlowId,
): WizardState | null =>
  flows.get(chatId as number, userId) as WizardState | null;
const newWizard = (
  chatId: FlowId,
  userId: FlowId,
  flow: string,
  extra: Record<string, unknown> = {},
): WizardState => flows.start(chatId, userId, flow, extra) as WizardState;
// Экран визарда — одна markdown-строка с кнопками прямо в тексте: ряды инлайн-клавиатуры
// больше не собираются, движок рисует rich-сообщение сам.
const wizScreen = (st: WizardState, text: string) =>
  flows.screenWithResult(st, text);
const endWizard = (st: WizardState, text: string) => {
  delete st.helperModel;
  return flows.endWithResult(st, text);
};
const wizardIsCurrent = (st: WizardState) =>
  flows.get(st.chatId, st.userId) === st;

// A network result belongs to the wizard object that started it. The slot can be
// replaced while the request is pending (Cancel, /menu, another /model), so both
// success and error must be discarded before either path mutates or renders state.
export async function runWizardRequest<T>(
  st: unknown,
  request: () => Promise<T>,
  isCurrent: (state: unknown) => boolean = (state) =>
    wizardIsCurrent(state as WizardState),
): Promise<WizardRequestResult<T>> {
  try {
    const value = await request();
    return isCurrent(st) ? { ok: true, value } : { stale: true };
  } catch (error) {
    return isCurrent(st) ? { ok: false, error } : { stale: true };
  }
}

const EFFORT_SET = new Set(EFFORTS);
// effortLabel — функция (tr на месте вызова): язык не замораживается в module-level const.
const effortLabel = (v: string | null) =>
  v && EFFORT_SET.has(v) ? v : tr("not set", "не задан");

export function isStaleWizard(
  st: WizardSnapshot | null,
  messageId: number | undefined,
) {
  return (
    !st || (st.msgId != null && messageId != null && st.msgId !== messageId)
  );
}

// Verb без аргумента живёт на своих шагах: таблица вместо цепочки if, потому что шагов
// становится больше, а правило остаётся одним — кнопка работает там, где её нарисовали.
const PLAIN_STEPS = new Map<string, readonly string[]>([
  ["keep", ["intro", "effort"]],
  ["chg", ["intro"]],
  ["helper", ["intro"]],
  ["helper-same", ["models", "model_error"]],
  // «Без ключа» — только там, где ключ на самом деле необязателен.
  ["nokey", ["awaiting_key"]],
  ["retry", ["model_error", "cli_status"]],
  ["back", ["model_error", "models"]],
]);

export function wizardActionAllowed(
  st: Pick<WizardSnapshot, "step"> | null,
  action: string,
) {
  if (!st) return false;
  if (action === "cancel") return true;
  if (action.startsWith("prov:")) return st.step === "provider";
  if (action.startsWith("m:")) return st.step === "models";
  if (action.startsWith("eff:")) return st.step === "effort";
  if (action.startsWith("rs:")) return st.step === "saved";
  return PLAIN_STEPS.get(action)?.includes(st.step ?? "") ?? false;
}

export function selectWizardModel(
  st: WizardSnapshot,
  rawIndex: unknown,
): ModelOption | null {
  if (!/^(0|[1-9]\d*)$/.test(String(rawIndex))) return null;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  const option = st.modelOptions?.[index];
  if (!option) return null;
  st.model = option.id;
  st.efforts = [...option.reasoningLevels];
  return option;
}

export function selectWizardEffort(st: WizardSnapshot, value: string): boolean {
  if (value === "unset") {
    st.effort = null;
    return true;
  }
  if (!EFFORT_SET.has(value) || !st.efforts?.includes(value)) return false;
  st.effort = value;
  return true;
}

/** Claude держит порядок Fable → Opus → Sonnet. Остальные каталоги поднимают текущую модель. */
function wizardModelOptions(
  provider: string,
  options: ModelOption[],
  current: string | undefined,
): ModelOption[] {
  if (provider === "claude") return options;
  return selectableWizardOptions(options, current ?? "");
}

function modelPrompt(): string {
  return tr("Choose a model:", "Выбери модель:");
}

function modelButtonLabel(option: ModelOption): string {
  return option.label ?? option.id;
}

export function selectableWizardOptions(
  options: unknown,
  current: string,
  limit = 30,
): ModelOption[] {
  const live = Array.isArray(options) ? (options as ModelOption[]) : [];
  const currentOption = live.find((option) => option.id === current);
  return [
    ...(currentOption ? [currentOption] : []),
    ...live.filter((option) => option !== currentOption),
  ].slice(0, limit);
}

function thinkingAvailable(provider: string, env: Record<string, string>) {
  return (
    providerSupportsReasoning(provider) &&
    (provider !== "opencode" ||
      resolveOpenCodeProtocol(env.OPENCODE_PROTOCOL) === "chat-completions")
  );
}
function helperModelLabel(provider: string, env: Record<string, string>) {
  const model = env.HELPER_MODEL?.trim();
  return model === undefined
    ? provider === "claude"
      ? "claude-sonnet-5-5"
      : tr("same as Iva", "как у Ивы")
    : model || tr("same as Iva", "как у Ивы");
}
export async function currentConfig({
  readEnv = () => readEnvValues(ENV_PATH),
} = {}) {
  const env = await readEnv();
  const configured = env.MODEL_PROVIDER ?? "ollama";
  const valid = Boolean(catalogProvider(configured));
  const provider = valid ? configured : "ollama";
  const adjustableThinking = thinkingAvailable(provider, env);
  return {
    provider,
    providerIsValid: valid,
    adjustableThinking,
    // Что реально стоит в .env. На неизвестном имени агент не стартует вовсе, и назвать
    // его «ollama» в строке «Сейчас…» значило бы спрятать причину, ради которой визард
    // и открыли. Экраны после сохранения показывают уже записанное имя, оно валидно.
    providerLabel: valid ? provider : `invalid (${configured})`,
    // Модель — тем же правилом, что у Статуса и рантайма. У невалидного провайдера модели
    // нет: показать OLLAMA_MODEL значило бы назвать модель, к которой никто не пойдёт.
    model: catalogModel(configured, env) ?? "?",
    helperModel: helperModelLabel(provider, env),
    effort: adjustableThinking ? (env.THINKING_EFFORT ?? "").toLowerCase() : "",
  };
}

// Кнопка — rich-строка: кнопка стоит в самом тексте сообщения, рядом со своим пояснением.
// RichButton — переходный тип: пока экраны визарда возвращают старые ряды «text + rows»,
// строка обязана проходить и в {text, callback_data}. D3 снимает ряды — уйдёт и тип.
const btn = (
  text: string,
  callback_data: string,
  style?: RichButtonStyle,
): RichButton => button(text, callback_data, style);
// cancelRow/menuRow — функции (tr на месте вызова), не module-level const с переведённой строкой.
// Каждая — абзац «кнопка — что она делает» (контракт rich), обёрнутый в старый ряд richRow.
const cancelRow = () =>
  richRow(
    `${btn(tr("Cancel", "Отмена"), "iva_model:cancel", "danger")} — ${tr("leave without changes", "выйти без изменений")}`,
  );
// Два равноправных варианта без пояснений — один ряд кнопок.
const retryBackRows = (): RichButton[][] => [
  [
    btn(tr("Retry", "Повторить"), "iva_model:retry"),
    btn(tr("‹ Back", "‹ Назад"), "iva_model:back"),
  ],
];
// Ряд «‹ Меню» на терминальных экранах визарда — возврат в /menu. r:o усыновляет
// это сообщение даже без живого стейта (движок меню само-чинится после рестарта моста).
const menuRow = (): RichButton[][] => [
  richRow(
    `${btn(tr("‹ Menu", "‹ Меню"), "iva_menu:r:o")} — ${tr("back to settings", "вернуться в настройки")}`,
  ),
];

// Rich-карта: кнопка — inline-элемент текста, поэтому у каждой есть пояснение рядом, а
// ряды (buttonRow) остаются только равноправным коротким вариантам: уровни, модели, да/нет.
//
// Блок :233-245 переводит на rich параллельный исполнитель (D1): после его правки те же
// помощники вернут готовые markdown-абзацы. До неё они ещё отдают ряды объектов — тогда
// строку собираем здесь сами, из тех же подписей и callback_data.
const wizardLine = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
// Заголовок терминального экрана: у /think он свой, у /model — свой.
const wizardHead = (flow: unknown) =>
  flow === "think"
    ? tr("🤔 Thinking", "🤔 Размышления")
    : tr("🧠 Model", "🧠 Модель");
const cancelLine = () =>
  wizardLine(cancelRow()) ??
  `${button(tr("Cancel", "Отмена"), "iva_model:cancel", "danger")} — ${tr(
    "exit without changes.",
    "выйти без изменений.",
  )}`;
const menuLine = () =>
  wizardLine(menuRow()) ??
  `${button(tr("‹ Menu", "‹ Меню"), "iva_menu:r:o")} — ${tr(
    "back to the settings.",
    "вернуться в настройки.",
  )}`;
const retryBackLines = () => {
  const ready = wizardLine(retryBackRows());
  return ready
    ? [ready]
    : [
        `${button(tr("Retry", "Повторить"), "iva_model:retry")} — ${tr(
          "ask the provider again.",
          "спросить провайдера ещё раз.",
        )}`,
        `${button(tr("‹ Back", "‹ Назад"), "iva_model:back")} — ${tr(
          "pick another provider.",
          "выбрать другого провайдера.",
        )}`,
      ];
};

// Секреты (API-ключи) принимаем ТОЛЬКО в личке: в группе бот может не иметь прав удалить
// сообщение с ключом (deleteMessage вернёт !ok), и его увидят все участники. Знак chatId
// надёжен — id личных чатов положительны, групп/супергрупп отрицательны (та же isPrivate,
// что в menu-экранах search.ts). Гейтим ОБА пути к ключу: и голый /model, и хендофф из /menu.
const isPrivateChat = (st: WizardState) => Number(st.chatId) > 0;
const refuseSecretInGroup = (st: WizardState) =>
  endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      tr(
        "API keys are secrets — open a private chat with me and set the key there.",
        "Ключи — это секрет. Открой личный чат со мной и введи ключ там.",
      ),
      menuLine(),
    ].join("\n\n"),
  );
// Ввод текстом мост перехватывает только в личке (scripts/poller/control.ts). В группе
// визард ждал бы сообщения, которое до него не дойдёт, — поэтому отказ до установки awaitText.
const refuseInputInGroup = (st: WizardState) =>
  endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      tr(
        "This one needs a private chat with me — open one and send /model there.",
        "Это настраивается только в личном чате — открой его и отправь /model там.",
      ),
      menuLine(),
    ].join("\n\n"),
  );

// Уровни размышлений — равноправные короткие варианты без пояснений: ряд кнопок на
// каждый экран плюс «не задавать» и сохранение/выход — кнопкой в ряду.
function effortLines(ns: string, withKeep: boolean, efforts: string[]) {
  const lines: string[] = [];
  for (let i = 0; i < efforts.length; i += 3) {
    lines.push(
      buttonRow(
        efforts
          .slice(i, i + 3)
          .map((effort: string) => button(effort, `${ns}:eff:${effort}`)),
      ),
    );
  }
  lines.push(
    buttonRow([
      button(tr("Don't set", "Не задавать"), `${ns}:eff:unset`),
      withKeep
        ? button(tr("Keep", "Оставить"), `${ns}:keep`)
        : button(tr("Cancel", "Отмена"), "iva_model:cancel", "danger"),
    ]),
  );
  return lines;
}

// {msgId} (опц.) — хендофф из /menu: визард заменяет flow-слот и рисует в ТО ЖЕ сообщение меню.
async function handleModelCmd(
  chatId: FlowId,
  from: FlowId,
  { msgId }: { msgId?: number } = {},
) {
  const { providerLabel, model, effort, helperModel } = await currentConfig();
  const st = newWizard(chatId, from, "model");
  st.msgId = msgId ?? null;
  st.step = "intro";
  const text = [
    `# ${tr("🧠 Model", "🧠 Модель")}`,
    [
      `| ${tr("Provider", "Провайдер")} | ${tr("Model", "Модель")} | ${tr("Thinking", "Размышления")} |`,
      "| --- | --- | --- |",
      `| ${escapeRichText(providerLabel)} | ${escapeRichText(model)} | ${escapeRichText(effortLabel(effort))} |`,
    ].join("\n"),
    button(
      `${tr("Helper and background model", "Модель помощника и фона")}: ${escapeRichText(helperModel)}`,
      "iva_model:helper",
    ),
    tr(
      "Used by helpers, Watch, Brief and Insight.",
      "Для помощников, Watch, Brief и Insight.",
    ),
    `${button(tr("Change", "Сменить"), "iva_model:chg")} — ${tr(
      "pick another provider or model.",
      "выбрать другого провайдера или модель.",
    )}`,
    `${button(tr("Keep", "Оставить"), "iva_model:keep")} — ${tr(
      "change nothing.",
      "ничего не менять.",
    )}`,
  ].join("\n\n");
  return wizScreen(st, text);
}

async function handleThinkCmd(
  chatId: FlowId,
  from: FlowId,
  {
    msgId,
    readEnv,
  }: {
    msgId?: number;
    readEnv?: () => Promise<Record<string, string>>;
  } = {},
) {
  const {
    provider,
    providerIsValid,
    providerLabel,
    model,
    effort,
    adjustableThinking,
  } = await currentConfig(readEnv ? { readEnv } : {});
  const st = newWizard(chatId, from, "think");
  st.provider = provider;
  st.model = model;
  st.msgId = msgId ?? null;
  const refused = thinkRefusal(
    provider,
    providerIsValid,
    providerLabel,
    adjustableThinking,
  );
  if (refused !== null)
    return endWizard(
      st,
      [`# ${tr("🤔 Thinking", "🤔 Размышления")}`, refused, menuLine()].join(
        "\n\n",
      ),
    );
  const cat = CATALOG[provider];
  const env = await readEnvValues(ENV_PATH);
  st.step = "loading";
  const loadingShown = await wizScreen(
    st,
    [
      `# ${tr("🤔 Thinking", "🤔 Размышления")}`,
      tr(
        `Loading thinking levels for ${escapeRichText(model)}…`,
        `Загружаю уровни размышлений для ${escapeRichText(model)}…`,
      ),
      cancelLine(),
    ].join("\n\n"),
  );
  if (!wizardIsCurrent(st)) return loadingShown;
  const loaded = await runWizardRequest(st, () =>
    fetchModelOptions(provider, cat.keyVar ? env[cat.keyVar] : undefined, {
      dataDir: DATA_DIR_ABS,
    }),
  );
  const options = await resolveThinkCatalogLoad(st, loaded);
  if (options === null) return loadingShown;
  const option = thinkOption(provider, options, model);
  if (!option)
    return showModelValidationError(
      st,
      new ModelValidationError(
        "model_unavailable",
        `${model} is not in the live catalog`,
      ),
    );
  st.modelOptions = [option];
  st.model = model;
  st.efforts = [...option.reasoningLevels];
  st.step = "effort";
  return wizScreen(
    st,
    [
      `# ${tr("🤔 Thinking", "🤔 Размышления")}`,
      tr(
        `Thinking level for ${escapeRichText(model)}: ${escapeRichText(effortLabel(effort))}.`,
        `Уровень размышлений для ${escapeRichText(model)}: ${escapeRichText(effortLabel(effort))}.`,
      ),
      ...effortLines("iva_think", true, st.efforts),
    ].join("\n\n"),
  );
}

/** Почему /think не рисует уровни ещё до каталога; null — провайдер годится.
 *  Уровни размышлений выбираются у провайдера, а на неизвестном имени агент не стартует
 *  вовсе: нарисовать кнопки ollama значило бы принять настройку, которая никуда не поедет.
 *  /model — тот же экран, что чинит причину, и метка провайдера там та же. */
function thinkRefusal(
  provider: string,
  providerIsValid: boolean,
  providerLabel: string,
  adjustableThinking = providerSupportsReasoning(provider),
): string | null {
  if (!providerIsValid)
    return tr(
      `Thinking levels need a working provider — MODEL_PROVIDER is ${escapeRichText(providerLabel)}. Set it via /model.`,
      `Уровни размышлений нужны рабочему провайдеру — MODEL_PROVIDER сейчас ${escapeRichText(providerLabel)}. Задай его через /model.`,
    );
  if (!adjustableThinking)
    return tr(
      `Adjustable thinking is unavailable for ${escapeRichText(CATALOG[provider].label)}. Choose a reasoning-capable provider via /model.`,
      `Настраиваемые размышления недоступны для ${escapeRichText(CATALOG[provider].label)}. Выбери провайдера с reasoning через /model.`,
    );
  return null;
}

/** Модель /think в живом списке. Прошлую модель Claude (Sonnet 5, Opus 5) новый CLI в кнопки
 *  не отдаёт — её место заняла новая, — но ход на ней идёт, и уровни у неё те же: их знает
 *  таблица экрана Claude. Незнакомый id остаётся ошибкой каталога. */
function thinkOption(
  provider: string,
  options: readonly ModelOption[],
  model: string,
): ModelOption | undefined {
  const listed = options.find((candidate) => candidate.id === model);
  if (listed || provider !== "claude") return listed;
  const reasoningLevels = claudeReasoningLevels(model);
  return reasoningLevels.length > 0
    ? { id: model, label: claudeModelLabel(model), reasoningLevels }
    : undefined;
}

export async function resolveThinkCatalogLoad(
  st: WizardState,
  loaded: WizardRequestResult<ModelOption[]>,
  showErrorImpl = showModelValidationError,
) {
  if (loaded.stale) return null;
  if (!loaded.ok) {
    await showErrorImpl(st, loaded.error);
    return null;
  }
  return loaded.value;
}

async function showProviderScreen(st: WizardState) {
  st.step = "provider";
  const authNote = (auth: string) => {
    if (auth === "oauth")
      return tr(
        "sign in with the OpenAI subscription.",
        "вход по подписке OpenAI.",
      );
    if (auth === "cli")
      return tr(
        "uses the claude CLI signed in on this server — no key.",
        "работает через CLI claude, залогиненный на этом сервере, — ключа нет.",
      );
    return auth === "key-optional"
      ? tr("the key is optional here.", "ключ тут не обязателен.")
      : tr("connect with an API key.", "подключение по API-ключу.");
  };
  const lines = [
    `# ${tr("🧠 Model", "🧠 Модель")}`,
    tr("Pick a provider:", "Выбери провайдера:"),
    ...Object.entries(CATALOG).map(
      ([id, c]) =>
        `${button(c.label, `iva_model:prov:${id}`)} — ${authNote(c.auth)}`,
    ),
    cancelLine(),
  ];
  return wizScreen(st, lines.join("\n\n"));
}

// Экран ввода адреса своего эндпоинта (custom). Не секрет, но приходит тем же текстовым
// швом, что и ключ: диспетчер моста отдаёт следующее сообщение визарду по awaitText.
function askBaseUrl(st: WizardState, current?: string) {
  if (!isPrivateChat(st)) return refuseInputInGroup(st);
  st.awaitText = { kind: "baseurl", secret: false, data: {} };
  st.step = "awaiting_base";
  const lines = [`# ${tr("🧠 Model", "🧠 Модель")}`];
  if (current)
    lines.push(
      tr(
        `Now: ${escapeRichText(current)}.`,
        `Сейчас: ${escapeRichText(current)}.`,
      ),
    );
  lines.push(
    tr(
      "Send the OpenAI-compatible endpoint of your provider — the full base, including the /v1-style suffix (e.g. https://api.example.com/v1).",
      "Пришли OpenAI-совместимый адрес своего провайдера — базу целиком, вместе с суффиксом вида /v1 (напр. https://api.example.com/v1).",
    ),
    cancelLine(),
  );
  return wizScreen(st, lines.join("\n\n"));
}

// Экран ввода имени модели: у чужого эндпоинта каталога моделей может не быть вовсе,
// и тогда единственный источник имени — владелец.
function askModelId(st: WizardState, reason?: string) {
  if (!isPrivateChat(st)) return refuseInputInGroup(st);
  st.awaitText = { kind: "modelid", secret: false, data: {} };
  st.step = "awaiting_model";
  const lines = [`# ${tr("🧠 Model", "🧠 Модель")}`];
  if (reason)
    lines.push(
      tr(
        `The endpoint has no model list I can read (${reason}).`,
        `Список моделей у эндпоинта прочитать не вышло (${reason}).`,
      ),
    );
  lines.push(
    tr(
      "Send the model id exactly as your provider names it.",
      "Пришли id модели ровно так, как называет её провайдер.",
    ),
    cancelLine(),
  );
  return wizScreen(st, lines.join("\n\n"));
}

async function pickProvider(st: WizardState, provider: string) {
  st.provider = provider;
  st.pendingKey = null;
  st.pendingBase = null;
  st.dropKey = false;
  st.plan = null;
  const cat = CATALOG[provider];
  if (cat.auth === "cli") return await pickCliProvider(st, cat);
  if (cat.auth === "oauth") {
    st.step = "loading";
    const loadingShown = await wizScreen(
      st,
      [
        `# ${tr("🧠 Model", "🧠 Модель")}`,
        tr("Checking the OpenAI subscription…", "Проверяю подписку OpenAI…"),
        cancelLine(),
      ].join("\n\n"),
    );
    if (!wizardIsCurrent(st)) return loadingShown;
    // File presence is not enough — a revoked/expired refresh token would let the wizard
    // finish into a config that 401s every turn. getAccessToken refreshes a stale token
    // and throws when there is no usable auth → device-link login.
    const auth = await runWizardRequest(st, () => getAccessToken(DATA_DIR_ABS));
    if (auth.stale) return loadingShown;
    if (!auth.ok) return startCodexLogin(st);
    return showModelScreen(st);
  }
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return false;
  // Адрес спрашиваем ПЕРВЫМ: без него ни ключ проверить, ни каталог моделей спросить.
  if (cat.baseVar) {
    st.pendingBase = providerBase(cat, env) ?? null;
    if (!st.pendingBase) return askBaseUrl(st, env[cat.baseVar]);
  }
  return askKeyOrShowModels(st, env);
}

/**
 * Вендор без ключа: единственный источник входа — CLI на том же сервере. Ни поставить
 * пакет, ни войти в подписку из Telegram нельзя, поэтому мастер показывает две команды
 * для сервера и кнопку «Проверить снова», а не спрашивает ключ, которого не существует.
 */
async function pickCliProvider(st: WizardState, cat: ProviderCatalogEntry) {
  st.step = "loading";
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return false;
  const loadingShown = await wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")} · ${escapeRichText(cat.label)}`,
      tr("Checking the claude CLI…", "Проверяю CLI claude…"),
      cancelLine(),
    ].join("\n\n"),
  );
  if (!wizardIsCurrent(st)) return loadingShown;
  // PATH берём у процесса, остальное — из свежего .env: CLAUDE_COMMAND могли вписать
  // только что, а сервис читает файл при старте.
  const checked = await runWizardRequest(st, () =>
    claudeStatus({ ...process.env, ...env }),
  );
  if (checked.stale) return loadingShown;
  if (!checked.ok || !checked.value.ready)
    return showCliStatusScreen(st, checked.ok ? checked.value : noClaude());
  st.plan = checked.value.plan;
  return showModelScreen(st);
}

/** Экран «CLI ещё не готов»: причина с командой для сервера и кнопка перечитать статус. */
async function showCliStatusScreen(st: WizardState, status: ClaudeStatus) {
  st.step = "cli_status";
  return wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")} · ${escapeRichText(CATALOG[st.provider].label)}`,
      tr(
        `Iva calls the claude CLI on this server, and it isn't ready: ${escapeRichText(status.hint)}`,
        `Ива зовёт CLI claude на этом же сервере, а он ещё не готов: ${escapeRichText(status.hint)}`,
      ),
      `${button(tr("Check again", "Проверить снова"), "iva_model:retry")} — ${tr(
        "read the status again.",
        "перечитать статус.",
      )}`,
      cancelLine(),
    ].join("\n\n"),
  );
}

/** Отказ проверки статуса: сказать владельцу то же, что сказал бы доктор. */
const noClaude = (): ClaudeStatus => ({
  installed: false,
  loggedIn: false,
  plan: "",
  conflict: null,
  ready: false,
  hint: `${claudeInstallHint()} и ${CLAUDE_LOGIN_HINT}`,
});

// Продолжение после введённого адреса: тот же порядок шагов, что и в pickProvider.
async function pickProviderAfterBase(st: WizardState) {
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return false;
  return askKeyOrShowModels(st, env);
}

async function askKeyOrShowModels(
  st: WizardState,
  env: Record<string, string>,
) {
  const cat = CATALOG[st.provider];
  if (!cat.keyVar || !env[cat.keyVar] || st.reenterKey === st.provider) {
    st.reenterKey = null;
    // В группе ключ вводить нельзя (его не удалить) — отказ до установки awaitText.
    if (!isPrivateChat(st)) return refuseSecretInGroup(st);
    // awaitText обобщает старый awaitKey (см. handleControl): диспатчер по pending.awaitText
    // отдаёт следующий текст этому визарду (handleWizardText), а не eve.
    st.awaitText = { kind: "apikey", secret: true, data: {} };
    st.step = "awaiting_key";
    // Свой эндпоинт может стоять без авторизации — тогда ключа нет и спрашивать нечего.
    const optional = cat.auth === "key-optional";
    const lines = [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        `Need a ${cat.label} API key. Send it in the next message — I'll delete it from the chat right away.\n` +
          "If I don't confirm within a couple of seconds — don't resend, start over with /model.",
        `Нужен API-ключ ${cat.label}. Пришли его следующим сообщением — я сразу удалю его из чата.\n` +
          "Если через пару секунд не подтвержу получение — не отправляй повторно, начни заново с /model.",
      ),
    ];
    if (optional)
      lines.push(
        `${button(tr("No key", "Без ключа"), "iva_model:nokey")} — ${tr(
          "if the provider is local.",
          "если провайдер локальный.",
        )}`,
      );
    lines.push(cancelLine());
    return wizScreen(st, lines.join("\n\n"));
  }
  return showModelScreen(st);
}

function loadWizardModels(st: WizardState, env: Record<string, string>) {
  const cat = CATALOG[st.provider];
  const base = cat.baseVar
    ? (st.pendingBase ?? providerBase(cat, env))
    : undefined;
  return runWizardRequest(st, () =>
    fetchModelOptions(
      st.provider,
      cat.keyVar ? (st.pendingKey ?? env[cat.keyVar]) : undefined,
      { dataDir: DATA_DIR_ABS, ...(base ? { base } : {}) },
    ),
  );
}
function turnModelOptions(
  st: WizardState,
  options: ModelOption[],
  env: Record<string, string>,
) {
  const responses =
    st.provider === "opencode" &&
    resolveOpenCodeProtocol(env.OPENCODE_PROTOCOL) === "responses";
  const candidates = responses
    ? options.map((option) => ({ ...option, reasoningLevels: [] }))
    : options;
  return wizardModelOptions(
    st.provider,
    candidates,
    env[CATALOG[st.provider].modelVar],
  );
}

async function showModelScreen(st: WizardState) {
  const cat = CATALOG[st.provider];
  const env = await readEnvValues(ENV_PATH);
  if (!wizardIsCurrent(st)) return false;
  st.step = "loading";
  const loadingShown = await wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        `Loading models for ${escapeRichText(cat.label)}…`,
        `Загружаю модели ${escapeRichText(cat.label)}…`,
      ),
      cancelLine(),
    ].join("\n\n"),
  );
  if (!wizardIsCurrent(st)) return loadingShown;
  const loaded = await loadWizardModels(st, env);
  if (loaded.stale) return loadingShown;
  if (!loaded.ok) {
    // У чужого эндпоинта GET /models не обязан существовать: отсутствие каталога — не
    // поломка, а повод спросить имя модели у владельца. Отказ по ключу остаётся отказом.
    if (!st.helperModel && cat.baseVar && !isAuthRejection(loaded.error))
      return askModelId(st, errorReason(loaded.error));
    return showModelValidationError(st, loaded.error);
  }
  const current = env[cat.modelVar];
  st.modelOptions = turnModelOptions(st, loaded.value, env);
  st.step = "models";
  const lines = [
    `# ${tr("🧠 Model", "🧠 Модель")} · ${escapeRichText(cat.label)}`,
    ...modelScreenNotes(st, current),
    ...(st.provider === "opencode"
      ? [
          tr(
            `Protocol: ${resolveOpenCodeProtocol(env.OPENCODE_PROTOCOL)}. Change it with iva config; Go /messages is unsupported.`,
            `Протокол: ${resolveOpenCodeProtocol(env.OPENCODE_PROTOCOL)}. Меняется через iva config; Go /messages не поддерживается.`,
          ),
        ]
      : []),
  ];
  if (st.helperModel)
    lines.push(
      button(tr("Same as Iva", "Как у Ивы"), "iva_model:helper-same"),
      button(tr("‹ Back", "‹ Назад"), "iva_model:back"),
    );
  lines.push(modelPrompt());
  // Модели — равноправные варианты без пояснений, но id бывают длинными: по одной в строке.
  lines.push(
    ...st.modelOptions.map((option, i) =>
      button(modelButtonLabel(option), `iva_model:m:${i}`),
    ),
  );
  lines.push(cancelLine());
  return wizScreen(st, lines.join("\n\n"));
}

/** Строки над списком моделей: план подписки из чужого CLI и текущая модель (для справки). */
function modelScreenNotes(
  st: WizardState,
  current: string | undefined,
): string[] {
  const notes: string[] = [];
  // План называет тот же `claude auth status`, что читает доктор.
  if (st.plan)
    notes.push(
      tr(
        `Plan: ${escapeRichText(st.plan)}.`,
        `План: ${escapeRichText(st.plan)}.`,
      ),
    );
  if (current)
    notes.push(
      tr(
        `Current (display only): **${escapeRichText(current)}**.`,
        `Текущая (только для справки): **${escapeRichText(current)}**.`,
      ),
    );
  return notes;
}

async function showModelValidationError(st: WizardState, error: unknown) {
  st.step = "model_error";
  if (isAuthRejection(error) && CATALOG[st.provider]?.keyVar) {
    st.reenterKey = st.provider;
  }
  const reason =
    error instanceof ModelValidationError
      ? error.message
      : tr("provider validation failed", "проверка провайдера не прошла");
  return wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        `Couldn't validate the live model catalog: ${reason}. Your current configuration was not changed.`,
        `Не удалось проверить живой каталог моделей: ${reason}. Текущая конфигурация не изменена.`,
      ),
      ...retryBackLines(),
    ].join("\n\n"),
  );
}

// Codex device-link login. runDeviceCodeLogin polls up to 15 min — deliberately NOT
// awaited, so the getUpdates loop keeps running; the continuation discards itself
// when this state object is no longer the current wizard (cancelled/replaced).
function startCodexLogin(st: WizardState) {
  st.step = "login";
  // Serialize device-code log lines (link, one-time code) into ordered chat messages.
  let q: Promise<void> = Promise.resolve();
  const tlog = (m: unknown) => {
    q = q.then(() => reply(st.chatId, String(m).trim()).then(() => {}));
  };
  runDeviceCodeLogin({ dataDir: DATA_DIR_ABS, lang: getLang(), log: tlog })
    .then(() => {
      // Identity-сверка: flows.get !== st истинно и когда слот заменён (другой /model,
      // /menu), и когда протух по TTL — осиротевшая континуация сама себя отбрасывает.
      if (flows.get(st.chatId, st.userId) !== st) return;
      return showModelScreen(st);
    })
    .catch((e: unknown) => {
      if (flows.get(st.chatId, st.userId) !== st) return;
      return endWizard(
        st,
        [
          `# ${wizardHead(st.flow)}`,
          tr(
            "Login failed: " +
              String(errorMessage(e)) +
              "\nSend /model to try again.",
            "Вход не удался: " +
              String(errorMessage(e)) +
              "\nОтправь /model, чтобы попробовать снова.",
          ),
          menuLine(),
        ].join("\n\n"),
      );
    });
  return wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        "Waiting for the OpenAI subscription login — link and code below. The code lives 15 minutes.",
        "Жду вход по подписке OpenAI — ссылка и код ниже. Код живёт 15 минут.",
      ),
      cancelLine(),
    ].join("\n\n"),
  );
}

/**
 * Plain-text message the wizard is waiting for. Which step it belongs to is decided by the
 * awaitText kind the screen set: an API key (secret — deleted from the chat first), the
 * endpoint address or the model id. A stale kind (bridge restarted mid-flow) falls back to
 * the key path, which deletes the message rather than letting an unread secret linger.
 */
async function handleWizardText(
  msg: { chat: { id: number }; message_id: number; text: string },
  st: WizardState,
) {
  const kind = (st.awaitText as { kind?: string } | null | undefined)?.kind;
  if (kind === "baseurl") return handleBaseUrlText(msg, st);
  if (kind === "modelid") return handleModelIdText(msg, st);
  const chatId = msg.chat.id;
  const del = await wizardTg("deleteMessage", {
    chat_id: chatId,
    message_id: msg.message_id,
  });
  if (!wizardIsCurrent(st)) return true;
  if (!del.ok) {
    await reply(
      chatId,
      tr(
        "Couldn't delete the message with the key — delete it manually.",
        "Не смог удалить сообщение с ключом — удали его вручную.",
      ),
    );
    if (!wizardIsCurrent(st)) return true;
  }
  const key = msg.text.trim();
  // Not key-shaped (whitespace / too short) — most likely an ordinary message typed
  // while the prompt was pending. Don't store it; end the wait so the chat works again.
  if (!/^\S{8,}$/.test(key)) {
    await endWizard(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "That doesn't look like an API key — the wait is cleared, I deleted the message just in case.\n" +
            "If it was a question — send it again; come back for a key via /model.",
          "Это не похоже на API-ключ — ожидание снято, сообщение удалил на всякий случай.\n" +
            "Если это был вопрос — отправь его ещё раз; за ключом приходи через /model.",
        ),
        menuLine(),
      ].join("\n\n"),
    );
    return true;
  }
  const checked = await runWizardRequest(st, () =>
    checkKey(st.provider, key, st.pendingBase ?? undefined),
  );
  if (checked.stale) return true;
  if (!checked.ok) {
    await endWizard(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "Couldn't validate the key. Start again with /model.",
          "Не удалось проверить ключ. Начни заново через /model.",
        ),
        menuLine(),
      ].join("\n\n"),
    );
    return true;
  }
  const err = checked.value;
  if (err) {
    await wizScreen(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          `Key rejected (${err}). Send another key or tap «Cancel».`,
          `Ключ не принят (${err}). Пришли другой ключ или нажми «Отмена».`,
        ),
        cancelLine(),
      ].join("\n\n"),
    );
    return true;
  }
  st.awaitText = null;
  st.pendingKey = key;
  st.dropKey = false;
  if (!wizardIsCurrent(st)) return true;
  await showModelScreen(st);
  return true;
}

// Адрес эндпоинта: не секрет, сообщение из чата не удаляем. Без схемы (`api.example.com/v1`)
// это не адрес — переспрашиваем на месте, а не падаем на первом запросе.
async function handleBaseUrlText(
  msg: { chat: { id: number }; message_id: number; text: string },
  st: WizardState,
) {
  const base = normalizeBaseUrl(msg.text);
  if (!base) {
    await wizScreen(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "That isn't an endpoint address. It needs the scheme and the /v1-style suffix — e.g. https://api.example.com/v1. Send it again or tap «Cancel».",
          "Это не адрес эндпоинта. Нужна схема и суффикс вида /v1 — напр. https://api.example.com/v1. Пришли ещё раз или нажми «Отмена».",
        ),
        cancelLine(),
      ].join("\n\n"),
    );
    return true;
  }
  st.awaitText = null;
  st.pendingBase = base;
  if (!wizardIsCurrent(st)) return true;
  // Дальше обычный порядок шагов: ключ (если его нет в .env), затем модели.
  await pickProviderAfterBase(st);
  return true;
}

// Имя модели текстом — путь для эндпоинта без GET /models. Проверять его не у кого,
// поэтому оно сразу уезжает в сохранение: там validateModelSelection ещё раз сходит к
// каталогу и примет ввод, только если каталога действительно нет.
async function handleModelIdText(
  msg: { chat: { id: number }; message_id: number; text: string },
  st: WizardState,
) {
  const model = msg.text.trim();
  if (!model || /[\r\n]/.test(model)) {
    await wizScreen(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "That isn't a model id — send one line, exactly as your provider names it.",
          "Это не id модели — пришли одной строкой, ровно как называет её провайдер.",
        ),
        cancelLine(),
      ].join("\n\n"),
    );
    return true;
  }
  st.awaitText = null;
  st.model = model;
  st.modelOptions = [{ id: model, reasoningLevels: [] }];
  st.efforts = [];
  st.effort = null;
  if (!wizardIsCurrent(st)) return true;
  try {
    await saveWizard(st);
  } catch (e) {
    if (!wizardIsCurrent(st)) return true;
    if (e instanceof ModelValidationError) {
      await showModelValidationError(st, e);
      return true;
    }
    await endWizard(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "Couldn't save .env: " + String(errorMessage(e)),
          "Не удалось сохранить .env: " + String(errorMessage(e)),
        ),
        menuLine(),
      ].join("\n\n"),
    );
    return true;
  }
  if (!wizardIsCurrent(st)) return true;
  await showSaved(st);
  return true;
}

function wizardSelection(st: WizardState, env: Record<string, string>) {
  const cat = CATALOG[st.provider];
  const key = cat.keyVar
    ? st.dropKey
      ? undefined
      : (st.pendingKey ?? env[cat.keyVar])
    : undefined;
  const base = cat.baseVar
    ? (st.pendingBase ?? providerBase(cat, env))
    : undefined;
  return {
    provider: st.provider,
    ...(st.provider === "opencode"
      ? { opencodeProtocol: env.OPENCODE_PROTOCOL }
      : {}),
    model: st.model,
    key,
    dataDir: DATA_DIR_ABS,
    ...(base ? { base } : {}),
  };
}
function wizardModelUpdates(st: WizardState): Record<string, string> {
  return {
    [CATALOG[st.provider].modelVar]: st.model,
    ...(st.provider === "claude"
      ? { CLAUDE_CONTEXT_WINDOW: claudeContextWindow(st.model) }
      : {}),
  };
}

function wizardUpdates(
  st: WizardState,
  env: Record<string, string>,
): Record<string, string | null> {
  const updates: Record<string, string | null> = { THINKING_EFFORT: st.effort };
  if (st.flow !== "model") return updates;
  const cat = CATALOG[st.provider];
  updates.MODEL_PROVIDER = st.provider;
  if (st.provider !== (env.MODEL_PROVIDER ?? "ollama"))
    updates.HELPER_MODEL = null;
  Object.assign(updates, wizardModelUpdates(st));
  if (cat.baseVar && st.pendingBase) updates[cat.baseVar] = st.pendingBase;
  if (cat.keyVar && st.pendingKey) updates[cat.keyVar] = st.pendingKey;
  else if (cat.keyVar && st.dropKey) updates[cat.keyVar] = null;
  return updates;
}

function assertHelperModelWindow(st: WizardState, env: Record<string, string>) {
  if (!st.helperModel) return;
  if (st.provider !== (env.MODEL_PROVIDER ?? "ollama"))
    throw new ModelValidationError(
      "invalid_selection",
      "helper provider changed",
    );
}

export async function validateAndSaveWizard(
  st: WizardState,
  {
    readEnv = () => readEnvValues(ENV_PATH),
    validate = validateModelSelection,
    write = (updates: Record<string, string | null>) =>
      upsertEnv(ENV_PATH, updates),
  } = {},
) {
  const env = await readEnv();
  const cat = CATALOG[st.provider];
  if (!cat || typeof st.model !== "string") {
    throw new ModelValidationError(
      "invalid_selection",
      "invalid wizard selection",
    );
  }
  assertHelperModelWindow(st, env);
  await validate(wizardSelection(st, env));
  await write(
    st.helperModel ? { HELPER_MODEL: st.model } : wizardUpdates(st, env),
  );
}

const saveWizard = (st: WizardState) => validateAndSaveWizard(st);

export async function showSaved(st: WizardState) {
  const {
    provider,
    model: chatModel,
    helperModel,
    effort,
  } = await currentConfig();
  const model = st.helperModel ? helperModel : chatModel;
  if (!wizardIsCurrent(st)) return;
  delete st.helperModel;
  st.step = "saved";
  await wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        `Saved: ${escapeRichText(provider)} · ${escapeRichText(model)} · thinking: ${escapeRichText(effortLabel(effort))}.`,
        `Сохранил: ${escapeRichText(provider)} · ${escapeRichText(model)} · размышления: ${escapeRichText(effortLabel(effort))}.`,
      ),
      tr(
        "Restart the agent to apply?",
        "Перезапустить агента, чтобы применить?",
      ),
      buttonRow([
        button(tr("Restart now", "Перезапустить сейчас"), "iva_model:rs:now"),
        button(tr("Later", "Позже"), "iva_model:rs:later"),
      ]),
    ].join("\n\n"),
  );
}

type WizardVerbHandler = (st: WizardState, action: string) => Promise<boolean>;

function onWizardKeep(st: WizardState): Promise<boolean> {
  return endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      st.flow === "think"
        ? tr(
            "Kept the current thinking level.",
            "Оставил текущий уровень размышлений.",
          )
        : tr(
            "Kept the current configuration.",
            "Оставил текущую конфигурацию.",
          ),
      menuLine(),
    ].join("\n\n"),
  );
}

function onWizardCancel(st: WizardState): Promise<boolean> {
  return endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      tr("Cancelled.", "Отменено."),
      menuLine(),
    ].join("\n\n"),
  );
}

function onWizardChg(st: WizardState): Promise<boolean> {
  return showProviderScreen(st);
}

async function onWizardNokey(st: WizardState): Promise<boolean> {
  if (CATALOG[st.provider]?.auth !== "key-optional") return false;
  st.awaitText = null;
  st.pendingKey = null;
  st.dropKey = true;
  return showModelScreen(st);
}

async function onWizardProv(st: WizardState, action: string): Promise<boolean> {
  const p = action.slice("prov:".length);
  return CATALOG[p] ? pickProvider(st, p) : false;
}

async function onWizardRetry(st: WizardState): Promise<boolean> {
  if (st.flow === "think") {
    return handleThinkCmd(st.chatId, st.userId, {
      msgId: st.msgId ?? undefined,
    });
  }
  // «Проверить снова» на экране чужого CLI начинает шаг вендора заново, а не просит
  // каталог у провайдера, вход в которого ещё не сделан.
  if (st.step === "cli_status") return pickProvider(st, st.provider);
  return showModelScreen(st);
}

function onWizardBack(st: WizardState): Promise<boolean> {
  if (st.helperModel) {
    delete st.helperModel;
    return handleModelCmd(st.chatId, st.userId, {
      msgId: st.msgId ?? undefined,
    });
  }
  if (st.flow === "think") {
    return endWizard(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr("Kept the current configuration.", "Оставил текущую конфигурацию."),
        menuLine(),
      ].join("\n\n"),
    );
  }
  return showProviderScreen(st);
}

async function onWizardModel(
  st: WizardState,
  action: string,
): Promise<boolean> {
  const option = selectWizardModel(st, action.slice("m:".length));
  if (!option) return false;
  if (st.helperModel || option.reasoningLevels.length === 0) {
    st.effort = null;
    try {
      await saveWizard(st);
    } catch (e) {
      if (!wizardIsCurrent(st)) return false;
      if (e instanceof ModelValidationError) {
        return showModelValidationError(st, e);
      }
      return endWizard(
        st,
        [
          `# ${wizardHead(st.flow)}`,
          tr(
            "Couldn't save .env: " + String(errorMessage(e)),
            "Не удалось сохранить .env: " + String(errorMessage(e)),
          ),
          menuLine(),
        ].join("\n\n"),
      );
    }
    // The validated configuration is durably written before any UI rendering.
    if (!wizardIsCurrent(st)) return true;
    await showSaved(st);
    return true;
  }
  st.step = "effort";
  return wizScreen(
    st,
    [
      `# ${tr("🧠 Model", "🧠 Модель")}`,
      tr(
        `Thinking level for ${escapeRichText(option.id)}:`,
        `Уровень размышлений для ${escapeRichText(option.id)}:`,
      ),
      ...effortLines("iva_model", false, st.efforts),
    ].join("\n\n"),
  );
}

async function onWizardEffort(
  st: WizardState,
  action: string,
): Promise<boolean> {
  const v = action.slice("eff:".length);
  if (!selectWizardEffort(st, v)) return false;
  try {
    await saveWizard(st);
  } catch (e) {
    if (!wizardIsCurrent(st)) return false;
    if (e instanceof ModelValidationError) {
      return showModelValidationError(st, e);
    }
    return endWizard(
      st,
      [
        `# ${wizardHead(st.flow)}`,
        tr(
          "Couldn't save .env: " + String(errorMessage(e)),
          "Не удалось сохранить .env: " + String(errorMessage(e)),
        ),
        menuLine(),
      ].join("\n\n"),
    );
  }
  // The validated configuration is durably written before any UI rendering.
  if (!wizardIsCurrent(st)) return true;
  await showSaved(st);
  return true;
}

function onWizardRestartLater(st: WizardState): Promise<boolean> {
  return endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      tr(
        "Saved. It'll apply after a restart (/restart).",
        "Сохранил. Применится после перезапуска (/restart).",
      ),
      menuLine(),
    ].join("\n\n"),
  );
}

async function onWizardRestartNow(st: WizardState): Promise<boolean> {
  await endWizard(
    st,
    [
      `# ${wizardHead(st.flow)}`,
      tr(
        "Restarting the agent… (~30s). The current conversation resumes after the restart.",
        "Перезапускаю агента… (~30 сек). Текущий диалог продолжится после перезапуска.",
      ),
      menuLine(),
    ].join("\n\n"),
  );
  // Plain restart: a config change is not a recovery — parked
  // conversations in .workflow-data survive and resume under the new model.
  const ok = await sc("restart", "iva.service");
  if (ok) {
    const { provider, model, effort } = await currentConfig();
    await reply(
      st.chatId,
      tr(
        `Done — the new configuration is active: ${provider} · ${model} · thinking: ${effortLabel(effort)}.`,
        `Готово — новая конфигурация активна: ${provider} · ${model} · размышления: ${effortLabel(effort)}.`,
      ),
    );
    return true;
  } else {
    const failed = await reply(
      st.chatId,
      tr(
        restartFailure(
          "Couldn't restart (systemctl). Check the service on the server.",
        ),
        restartFailure(
          "Не удалось перезапустить (systemctl). Проверь сервис на сервере.",
        ),
      ),
    );
    return replySucceeded(failed);
  }
}

// Таблица глагол → обработчик. Точные совпадения — по ключу, префиксные глаголы
// (prov:/m:/eff:) — по началу действия.
async function onWizardHelper(st: WizardState): Promise<boolean> {
  const config = await currentConfig();
  if (!wizardIsCurrent(st)) return false;
  st.provider = config.provider;
  st.helperModel = true;
  return showModelScreen(st);
}
async function onWizardHelperSame(st: WizardState): Promise<boolean> {
  if (!st.helperModel) return false;
  await upsertEnv(ENV_PATH, { HELPER_MODEL: "" });
  if (wizardIsCurrent(st)) await showSaved(st);
  return true;
}

const WIZARD_VERB_HANDLERS: Record<string, WizardVerbHandler> = {
  helper: onWizardHelper,
  "helper-same": onWizardHelperSame,
  keep: onWizardKeep,
  cancel: onWizardCancel,
  chg: onWizardChg,
  nokey: onWizardNokey,
  retry: onWizardRetry,
  back: onWizardBack,
  "rs:later": onWizardRestartLater,
  "rs:now": onWizardRestartNow,
};

function wizardHandlerFor(action: string): WizardVerbHandler | null {
  const exact = WIZARD_VERB_HANDLERS[action];
  if (exact) return exact;
  if (action.startsWith("prov:")) return onWizardProv;
  if (action.startsWith("m:")) return onWizardModel;
  if (action.startsWith("eff:")) return onWizardEffort;
  return null;
}

// Досмотр отправителя: доверенный — наружу именем, чужой тап уже проглочен
// со своим вердиктом. Проверки дословно из диспетчера: порядок и вердикты те же.
function wizardSender(cq: {
  from?: { id?: string | number };
}): { verdict: boolean } | { from: string } {
  const senderId = cq.from?.id;
  const from = senderId === undefined ? null : String(senderId);
  if (from === null) return { verdict: false };
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return { verdict: true }; // swallow untrusted taps
  return { from };
}

// Протухший или потерянный визард: отвечаем «устарело» здесь, дальше не идём.
// Живое состояние возвращается наружу — диспетчеру не нужен отдельный null-чек.
async function answeredStaleWizard(
  st: WizardState | null,
  chatId: number | undefined,
  messageId: number | undefined,
): Promise<{ answered: boolean } | { live: WizardState }> {
  if (st !== null && !isStaleWizard(st, messageId)) return { live: st };
  const expired = await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: tr(
      "This dialog has expired — send /model again.",
      "Диалог устарел — отправь /model заново.",
    ),
  });
  return { answered: messageCallSucceeded(expired) };
}

// Inline-button taps for /model and /think. Mirrors handleUpdateCallback: ack the
// spinner first, swallow untrusted taps, then dispatch on the wizard state.
async function handleWizardCallback(cq: {
  id: string;
  data: string;
  from?: { id?: string | number };
  message?: { chat?: { id?: number }; message_id?: number };
}) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  await tg("answerCallbackQuery", { callback_query_id: cq.id }); // spinner only; never primary proof
  const sender = wizardSender(cq);
  if (!("from" in sender)) return sender.verdict;
  const from = sender.from;
  const action = cq.data.replace(/^iva_(model|think):/, "");
  const st = getWizard(chatId, from);
  // No state (bridge restarted / TTL) or a tap on an older wizard message → stale.
  const target = await answeredStaleWizard(st, chatId, messageId);
  if (!("live" in target)) return target.answered;
  const live = target.live;
  if (!wizardActionAllowed(live, action)) return false;
  const handler = wizardHandlerFor(action);
  if (!handler) return false;
  return handler(live, action);
}

export function resetMessageCopy(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  locale = getLang(),
) {
  const pick = (en: string, ru: string) => (locale === "ru" ? ru : en);
  const model = modelSummary(env);
  const context = compactNumber(model.contextWindow);
  return cmd === "/restart"
    ? {
        pending: pick("◇ Restarting Iva", "◇ Перезапускаю Iva"),
        complete: pick(
          `♻️ Iva restarted\n\nModel: ${model.line}\nUnfinished turn cleared`,
          `♻️ Iva перезапущена\n\nМодель: ${model.line}\nНезавершённый ход очищен`,
        ),
      }
    : {
        pending: pick(
          "◇ Starting a new conversation",
          "◇ Начинаю новый диалог",
        ),
        complete: pick(
          `✨ New conversation ready\n\nModel: ${model.line}\nContext cleared · window ${context}`,
          `✨ Новый диалог готов\n\nМодель: ${model.line}\nКонтекст очищен · окно ${context}`,
        ),
      };
}

/** Шов для теста: тот же шаг, что зовёт тап по кнопке провайдера. */
export const wizardPickProvider = (
  st: WizardState,
  provider: string,
): Promise<boolean> => pickProvider(st, provider);

export {
  flows,
  getWizard,
  endWizard,
  handleModelCmd,
  handleThinkCmd,
  handleWizardText,
  handleWizardCallback,
};
