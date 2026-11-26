import { defineTool } from "eve/tools";
import {
  colleagueExecuteAsync,
  colleagueInputSchema,
} from "../lib/colleague-tool.ts";

export default defineTool({
  description:
    "Manage Iva's Colleague bots and delegate tasks between bots: list colleagues and option state, suggest a model for a role (critic, programmer, researcher, secretary), propose hiring a new colleague via a Telegram t.me/newbot/... confirmation link (hire), configure a colleague, change a colleague's provider and model (any provider in MODEL_PROVIDER_NAMES), or delegate a task to another bot via private message.",
  inputSchema: colleagueInputSchema,
  execute: (input, ctx) => colleagueExecuteAsync(input, ctx),
});
