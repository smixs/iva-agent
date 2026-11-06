import { defineHook } from "eve/hooks";
import { modelAuthFailure, modelAuthProvider } from "../lib/model-auth.js";
import { dispatchModelAuth } from "../lib/model-auth-dispatch.js";

export default defineHook({
  events: {
    "turn.failed": (event, ctx) => {
      // Telegram queues the originating-chat reply together with its evidence.
      if (ctx.channel.kind === "channel:telegram") return;
      const provider = modelAuthFailure(event.data);
      if (provider)
        void dispatchModelAuth({
          provider,
          at: Date.now(),
          failed: true,
          answers: ctx.channel.kind === "channel:telegram",
        });
    },
    // A completed model step proves the login actually works, including background turns.
    "step.completed": () => {
      void dispatchModelAuth({
        provider: modelAuthProvider(),
        at: Date.now(),
        failed: false,
      });
    },
  },
});
