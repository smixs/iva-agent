import { defineDynamic, defineInstructions } from "eve/instructions";
import { colleagueBotIdOfTurn } from "../lib/eve-auth.ts";
import { colleagueRoleMarkdown, readColleague } from "../lib/colleagues.ts";

// Динамическая инструкция роли коллеги: перечитывается на каждом ходе, чтобы смена роли
// или модели в data/settings.json применялась без перезапуска процесса.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const botId = colleagueBotIdOfTurn(ctx);
      if (botId === null) return null;
      const entry = readColleague(botId);
      if (entry === null) return null;
      return defineInstructions({ markdown: colleagueRoleMarkdown(entry) });
    },
  },
});
