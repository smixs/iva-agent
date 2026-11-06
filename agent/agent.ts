import {
  claudeContextWindow,
  providerContextWindow,
} from "./lib/context-window.ts";
import { usesHelperModel } from "./lib/eve-auth.ts";
import { MODEL_PROVIDERS } from "./lib/model-provider.ts";
import { defineAgent, defineDynamic } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и the selected helper model).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  providerName,
  compatibleThinkingEffort,
  providerConfig as cfg,
  withReplayableReasoning,
  makeTextModel,
} from "./provider.js";
import { stepUsageLabel } from "./lib/usage-tap.js";
import { compactionThresholdPercent } from "./lib/compaction.js";
import { chatModelSeesImages } from "./vision.js";

export function stepModelChoice(
  ctx: Parameters<typeof usesHelperModel>[0] & { session: { id: string } },
) {
  const helperModel = usesHelperModel(ctx);
  const model = helperModel
    ? process.env.HELPER_MODEL === undefined
      ? MODEL_PROVIDERS[providerName].defaultHelperModel || cfg.textModel
      : process.env.HELPER_MODEL.trim() || cfg.textModel
    : cfg.textModel;
  const contextWindow =
    helperModel && providerName === "claude"
      ? Math.min(
          providerContextWindow(providerName, model),
          claudeContextWindow(model),
        )
      : cfg.contextWindow;
  return Object.freeze({
    provider: providerName,
    model,
    contextWindow,
    seesImages: () => chatModelSeesImages(model),
    sessionId: ctx.session.id,
  });
}

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
      "step.started": (event, ctx) => {
        const choice = stepModelChoice(ctx);
        return {
          model: withReplayableReasoning(
            makeTextModel({
              ...choice,
              chatModelSeesImages: choice.seesImages,
              usage: stepUsageLabel(event, choice.sessionId),
            }),
          ),
          modelContextWindowTokens: choice.contextWindow,
          modelCompactionThresholdPercent: compactionThresholdPercent(
            choice.contextWindow,
          ),
        };
      },
    },
  }),
  // eve maps this provider-agnostic setting to reasoning_effort for the
  // OpenAI-compatible Ollama Cloud and OpenCode Go endpoints.
  reasoning: compatibleThinkingEffort,
  // Окно контекста едет вместе с выбором модели выше (у динамической модели место ему
  // только там). ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос
  // переполнит окно до компактации.
  // Страховка от overflow внутри хода: eve сам пересказывает старые ходы перед шагом модели,
  // сохраняя todo и read-tracking. Обычный путь — свёртка между ходами на меньшем пороге
  // (agent/lib/compaction.ts, agent/lib/idle-compaction.ts).
  compaction: {
    thresholdPercent: compactionThresholdPercent(cfg.contextWindow),
  },
  // Сессия eve — durable workflow: каждый ход проигрывает весь журнал событий заново, и на
  // сутках активного чата реплей переваливает за потолок 240 с (vercel/workflow), ход
  // не стартует. Сутки от создания — штатный потолок eve: ход завершается, следующее
  // сообщение открывает свежую сессию. Память живёт в vault и это переживает; роллап
  // берёт на каждый день ночи свою сессию и снимает её после хода.
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1000 },
});
