import {
  claudeContextWindow,
  providerContextWindow,
} from "../packages/context-window/index.ts";
import { colleagueBotIdOfTurn, usesHelperModel } from "./lib/eve-auth.ts";
import { readColleague, type ColleagueEntry } from "./lib/colleagues.ts";
import { MODEL_PROVIDERS } from "./lib/model-provider.ts";
import { defineAgent, defineDynamic } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и the selected helper model).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  providerName,
  compatibleThinkingEffort,
  providerConfig as cfg,
  providerReplaysReasoning,
  withReplayableReasoning,
  makeTextModel,
} from "./provider.js";
import { stepUsageLabel } from "./lib/usage-tap.js";
import { compactionThresholdPercent } from "./lib/compaction.js";
import { chatModelSeesImages } from "./vision.js";

export function stepModelChoice(
  ctx: Parameters<typeof usesHelperModel>[0] & { session: { id: string } },
  deps: {
    readonly readColleague?: (botId: string) => ColleagueEntry | null;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) {
  const colleagueBotId = colleagueBotIdOfTurn(ctx, deps.env);
  if (colleagueBotId !== null) {
    const colleague = (deps.readColleague ?? readColleague)(colleagueBotId);
    if (colleague !== null) {
      const targetProvider = colleague.provider;
      const model = colleague.model;
      const contextWindow =
        targetProvider === "claude"
          ? Math.min(
              providerContextWindow(targetProvider, model),
              claudeContextWindow(model),
            )
          : providerContextWindow(targetProvider, model);
      return Object.freeze({
        provider: targetProvider,
        model,
        contextWindow,
        seesImages:
          targetProvider === providerName
            ? () => chatModelSeesImages(model)
            : () =>
                Promise.resolve(
                  targetProvider === "codex" || targetProvider === "claude",
                ),
        sessionId: ctx.session.id,
      });
    }
  }
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
            providerReplaysReasoning(choice.provider),
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
  // Единственная свёртка: eve пересказывает историю перед шагом модели по порогу из
  // agent/lib/compaction.ts — свёртки между ходами больше нет (решение 24.10.2026).
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
