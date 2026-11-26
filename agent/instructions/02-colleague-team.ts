import { defineDynamic, defineInstructions } from "eve/instructions";
import { colleagueBotIdOfTurn } from "../lib/eve-auth.ts";
import {
  colleagueTeamMarkdown,
  isColleaguesEnabled,
} from "../lib/colleagues.ts";

// Динамическая инструкция командной работы в группе и поручений между ботами (ADR-0030, T911).
// Активна только при включённой опции коллег; при выключенной возвращает null (нулевой след в промпте).
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!isColleaguesEnabled()) return null;
      return defineInstructions({
        markdown: colleagueTeamMarkdown(colleagueBotIdOfTurn(ctx)),
      });
    },
  },
});
