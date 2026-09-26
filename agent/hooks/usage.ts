import { defineHook } from "eve/hooks";
import { resolveModelProvider } from "../lib/model-provider.js";
import {
  appendUsage,
  parentFields,
  readUsageTokens,
  subagentTurnId,
  usageRecord,
  type ParentLike,
} from "../lib/usage.js";
import { recordStepContext } from "../lib/context-fill.js";

// Учёт фактического расхода токенов. ОДИН хук ловит весь расход одного eve-агента без
// двойного счёта: основной Telegram Channel и фоновые джобы через eve/client —
// daily-digest, memory rollup (kind="http"). Шаги субагента (planner) приходят завёрнутыми
// в "subagent.event" → слушаем оба события. Пишем по строке на шаг в data/usage.jsonl;
// читают мост (/usage) и CLI (`iva usage`).
//
// Вызовы модели мимо шага хода (компактация eve, зрение) пишет agent/lib/usage-tap.ts с
// source "compaction" и "vision". Шаг ребёнка встроенного `agent` несёт поля родителя.
//
// ВАЖНО: в отличие от transcript.ts НЕ фильтруем finishReason="tool-calls" — расход есть на
// КАЖДОМ шаге модели, включая tool-call раунды.

// Модель/провайдер не приходят в событие — используем тот же строгий выбор, что и runtime.
const { name: PROVIDER, model: MODEL } = resolveModelProvider();

interface StepData {
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
  readonly sessionId: string;
  readonly source: string;
  readonly subagent?: string;
  readonly parent?: ParentLike;
}

/** Пишет строку расхода; отдаёт проверенный вход шага или null, если расхода нет. */
function record(data: StepData, owner: StepOwner): number | null {
  const { sessionId, source, subagent, parent } = owner;
  const u = data.usage;
  if (!u) return null;
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
    return null;
  }
  const row = usageRecord(
    {
      source,
      provider: PROVIDER,
      model: MODEL,
      sessionId,
      turnId: data.turnId ?? "",
      step: data.stepIndex ?? 0,
      subagent, // undefined для top-level — JSON.stringify его опускает
      ...parentFields(parent),
    },
    tokens,
  );
  if (row) appendUsage(row); // нет usage — не пишем нулевую строку
  // Провайдер не назвал вход числом (нет поля, null): контекст неизвестен, а не ноль.
  return typeof u.inputTokens === "number" ? tokens.in : null;
}

export default defineHook({
  events: {
    "step.completed": (event, ctx) => {
      // Ребёнок встроенного `agent` пишет свои шаги сам (channel.kind = subagent) под своей
      // сессией; связь с ходом родителя eve отдаёт в ctx.session.parent.
      const inputTokens = record(event.data, {
        sessionId: ctx.session.id,
        source: ctx.channel.kind ?? "unknown",
        parent: ctx.session.parent,
      });
      // Размер контекста для подсказки «нажмите /new»: хранилище обновляет только сессию,
      // открытую Telegram-каналом; ребёнок встроенного agent идёт под своей сессией.
      recordStepContext(ctx.session.id, inputTokens);
    },
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
            turnId: subagentTurnId(
              ctx.session.turn,
              event.data.subagentName,
              inner.data.turnId,
            ),
          },
          {
            sessionId: ctx.session.id,
            source: ctx.channel.kind ?? "unknown",
            subagent: event.data.subagentName,
          },
        );
      }
    },
  },
});
