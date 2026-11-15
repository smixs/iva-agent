import { TURN_KINDS, isHelperTurn } from "../lib/eve-auth.ts";
import { defineHook } from "eve/hooks";
// Двусторонний транскрипт: финальный ответ Iva дозаписывается в ТОТ ЖЕ дневной файл
// vault, что и реплики юзера (agent/lib/telegram-inbound.ts).
import { appendDaily } from "../lib/vault-daily.js";
import { withoutWidgetCode } from "../lib/telegram-widget.ts";

export default defineHook({
  events: {
    // message.completed несёт видимый текст одного завершённого шага ассистента.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы; пропускаем,
    // пишем только финальные реплики Iva.
    "message.completed": (event, ctx) => {
      // ctx.session.parent — типизированная связь eve с родительским ходом при любом адаптере.
      if (ctx.session.parent || isHelperTurn(ctx)) return;
      const initiator = ctx.session.auth?.initiator;
      // Видимые фоновые ответы названы bearer-атрибутом; остальные CLI/http — служебные.
      if (
        (ctx.channel.kind === "cli" || ctx.channel.kind === "http") &&
        !(
          initiator?.authenticator === "iva-bearer" &&
          typeof initiator.attributes.iva_turn === "string" &&
          TURN_KINDS.has(initiator.attributes.iva_turn)
        )
      )
        return;
      if (event.data.finishReason === "tool-calls") return;
      const text = (event.data.message ?? "").trim();
      // QUIET — ответ планового хода Watch или Brief «писать не о чем»: в чат он не уходит
      // и в дневной файл не пишется (ADR-0020).
      if (!text || text === "QUIET") return;
      // Код виджета памяти не нужен: в дневной файл идёт его подпись.
      appendDaily("[iva]", withoutWidgetCode(text));
    },
  },
});
