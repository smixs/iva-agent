import { defineTool } from "eve/tools";
import {
  colleagueExecute,
  colleagueInputSchema,
} from "../lib/colleague-tool.ts";

export default defineTool({
  description:
    "Manage Iva's Colleague bots: list colleagues and option state, suggest a model for a role (critic, programmer, researcher, secretary), propose hiring a new colleague via a Telegram t.me/newbot/... confirmation link (hire), configure a colleague, or change a colleague's provider and model (any provider in MODEL_PROVIDER_NAMES).",
  inputSchema: colleagueInputSchema,
  execute: (input, ctx) => Promise.resolve(colleagueExecute(input, ctx)),
});
