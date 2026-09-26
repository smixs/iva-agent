import { defineAgent, defineDynamic } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и agent/subagents/planner/agent.ts).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  compatibleThinkingEffort,
  providerConfig as cfg,
  withReplayableReasoning,
  makeTextModel,
} from "./provider.js";
import { stepUsageLabel } from "./lib/usage-tap.js";
import { COMPACTION_THRESHOLD_PERCENT } from "./lib/compaction.js";
import { chatModelSeesImages } from "./vision.js";

export default defineAgent({
  // Модель строится на каждом шаге хода, а не при сборке: OpenCode Go требует ID диалога в
  // заголовке каждого запроса, а sessionId известен только здесь. Для остальных провайдеров
  // это та же модель, что раньше была статической (см. provider.ts, providerRequestHeaders).
  // step.started, не session.started: на self-host сессия — durable workflow, и выбор на
  // session.started eve сохраняет в журнал, а объект модели не сериализуется
  // (DynamicModelSelectionError). Шаговый резолвер живёт только в памяти. Модель та же на
  // каждом шаге, поэтому кэш промпта у провайдера не сбрасывается.
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => ({
        model: withReplayableReasoning(
          makeTextModel({
            sessionId: ctx.session.id,
            chatModelSeesImages,
            // Компактация eve зовёт эту же модель до шага; её расход пишется под этим ходом.
            usage: stepUsageLabel(event, ctx.session.id),
          }),
        ),
        // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную;
        // без явного значения eve пошёл бы за ним в Gateway, которого у self-host нет.
        modelContextWindowTokens: cfg.contextWindow,
      }),
    },
  }),
  // eve maps this provider-agnostic setting to reasoning_effort for the
  // OpenAI-compatible Ollama Cloud and OpenCode Go endpoints.
  reasoning: compatibleThinkingEffort,
  // Окно контекста едет вместе с выбором модели выше (у динамической модели место ему
  // только там). ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос
  // переполнит окно до компактации.
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: COMPACTION_THRESHOLD_PERCENT },
  // Сессия eve — durable workflow: каждый ход проигрывает весь журнал событий заново, и на
  // сутках активного чата реплей переваливает за потолок 240 с (vercel/workflow), ход
  // не стартует. Сутки от создания — штатный потолок eve: ход завершается, следующее
  // сообщение открывает свежую сессию. Память живёт в vault и это переживает; роллап
  // ротирует свою сессию сам (SESSION_TTL_MS) и обрабатывает session_not_active.
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1000 },
});
