import { defineHook } from "eve/hooks";
import { TURN_KINDS, isHelperTurn } from "../lib/eve-auth.js";
import { resolveModelProvider } from "../lib/model-provider.js";
import {
  appendUsage,
  parentFields,
  readUsageTokens,
  stepInputTokens,
  subagentTurnId,
  usageRecord,
  takeUsageRequest,
  type UsageRequest,
  type ParentLike,
} from "../lib/usage.js";
import {
  beginIdleCompaction,
  completeIdleCompaction,
  recordStepInput,
} from "../lib/idle-compaction.js";

// Учёт фактического расхода токенов. ОДИН хук ловит весь расход одного eve-агента без
// двойного счёта: основной Telegram Channel и фоновые джобы через eve/client —
// ход Watch, Brief и Insight, memory rollup (kind="http"). Ход Ивы через eve/client называет
// свой вид заголовком (agent/lib/eve-auth.ts), и `source` строки — этот вид, а не "http". Шаги субагента (planner) приходят завёрнутыми
// в "subagent.event" → слушаем оба события. Пишем по строке на шаг в data/usage.jsonl;
// читают мост (/usage) и CLI (`iva usage`).
//
// Вызовы модели мимо шага хода (компактация eve, зрение) пишет agent/lib/usage-tap.ts с
// source "compaction" и "vision". Шаг ребёнка встроенного `agent` несёт поля родителя.
//
// ВАЖНО: в отличие от transcript.ts НЕ фильтруем finishReason="tool-calls" — расход есть на
// КАЖДОМ шаге модели, включая tool-call раунды.

// Модель провайдера приходит в завершённом событии шага; провайдер общий для всех узлов графа.
const { name: PROVIDER, model: TEXT_MODEL } = resolveModelProvider();

interface StepData {
  request?: UsageRequest;
  providerModelId?: string;
  stepIndex: number;
  turnId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** Чей шаг: сессия, канал, имя инлайн-субагента и родитель сессии-ребёнка. */
interface StepOwner {
  readonly model: string;
  readonly sessionId: string;
  readonly source: string;
  readonly subagent?: string;
  readonly parent?: ParentLike;
}

/** Кто начал сессию; ребёнок встроенного `agent` получает того же, что родитель. */
interface Initiator {
  readonly authenticator: string;
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
}

/** Источник строки: вид хода Ивы из bearer-атрибута, иначе вид канала. */
function sourceOf(ctx: {
  readonly session: {
    readonly auth?: {
      readonly initiator: Initiator | null;
      readonly current?: Initiator | null;
    };
  };
  readonly channel: { readonly kind?: string };
}): string {
  if (isHelperTurn(ctx)) return "helper";
  const initiator = ctx.session.auth?.initiator;
  const turn =
    initiator?.authenticator === "iva-bearer"
      ? initiator.attributes.iva_turn
      : undefined;
  return typeof turn === "string" && TURN_KINDS.has(turn)
    ? turn
    : (ctx.channel.kind ?? "unknown");
}

function record(data: StepData, owner: StepOwner): void {
  const { sessionId, source, subagent, parent } = owner;
  const u = data.usage;
  if (!u) return;
  const tokens = readUsageTokens({
    in: u.inputTokens,
    out: u.outputTokens,
    cacheRead: u.cacheReadTokens,
    cacheWrite: u.cacheWriteTokens,
  });
  if (!tokens) {
    // Пропуск не молчаливый: журнал называет шаг и что именно пришло.
    console.error(
      `[usage] расход шага пропущен: turn=${data.turnId ?? "?"} step=${data.stepIndex ?? 0} in=${String(u.inputTokens)} out=${String(u.outputTokens)} cacheRead=${String(u.cacheReadTokens)} cacheWrite=${String(u.cacheWriteTokens)}`,
    );
    return;
  }
  const row = usageRecord(
    {
      source,
      provider: PROVIDER,
      model: owner.model,
      sessionId,
      turnId: data.turnId ?? "",
      step: data.stepIndex ?? 0,
      subagent, // undefined для top-level — JSON.stringify его опускает
      request: data.request,
      ...parentFields(parent),
    },
    tokens,
  );
  if (row) appendUsage(row); // нет usage — не пишем нулевую строку
}

export default defineHook({
  events: {
    "step.completed": (event, ctx) => {
      // Ребёнок встроенного `agent` пишет свои шаги сам (channel.kind = subagent) под своей
      // сессией; связь с ходом родителя eve отдаёт в ctx.session.parent.
      // Вход шага для свёртки между ходами — до записи расхода: сбой файла расхода не
      // отменяет решение о свёртке. Счёт ведётся только у сессии, открытой Telegram-каналом;
      // ребёнок встроенного agent идёт под своей сессией.
      recordStepInput(ctx.session.id, stepInputTokens(event.data.usage));
      record(event.data, {
        model: event.data.providerModelId ?? TEXT_MODEL,
        sessionId: ctx.session.id,
        source: sourceOf(ctx),
        parent: ctx.session.parent,
      });
    },
    // eve начал свёртку: между ходами чат на это время должен быть занят.
    "compaction.requested": (_event, ctx) =>
      beginIdleCompaction(ctx.session.id),
    // eve довёл свёртку до конца (канал Telegram этого события не получает).
    "compaction.completed": (_event, ctx) =>
      completeIdleCompaction(ctx.session.id),
    // Шаги инлайн-субагента (planner) — иначе его токены потерялись бы.
    //
    // turnId субагента брать НЕЛЬЗЯ: eve нумерует ходы как turn_<sequence> внутри каждой
    // сессии, у ребёнка счётчик начинается заново, а sessionId мы пишем родительский —
    // значит ключ sessionId:turnId столкнулся бы с каким-то ходом родителя (сразу после
    // /new — с его же текущим turn_0, позже — с давним одноимённым). Пишем ход РОДИТЕЛЯ
    // с суффиксом: ключ уникален по построению, а привязка к ходу сохраняется, поэтому
    // расход субагента продолжает попадать в «итого за ход» (отчёт: scripts/lib/usage.ts).
    "subagent.event": (event, ctx) => {
      const inner = event.data.event;
      if (inner.type === "step.completed") {
        record(
          {
            ...inner.data,
            request: takeUsageRequest({
              sessionId: ctx.session.id,
              turnId: inner.data.turnId ?? "",
              step: inner.data.stepIndex ?? 0,
            }),
            turnId: subagentTurnId(
              ctx.session.turn,
              event.data.subagentName,
              inner.data.turnId,
            ),
          },
          {
            model: inner.data.providerModelId ?? TEXT_MODEL,
            sessionId: ctx.session.id,
            source: sourceOf(ctx),
            subagent: event.data.subagentName,
          },
        );
      }
    },
  },
});
