import { defineTool } from "eve/tools";
import {
  colleagueExecuteAsync,
  colleagueInputSchema,
} from "../lib/colleague-tool.ts";

export default defineTool({
  description:
    "Manage Iva's Colleague bots and delegate tasks between bots: list colleagues and option state, suggest a model for a role (critic, programmer, researcher, secretary), configure a colleague, change a colleague's provider and model, or delegate a task to another bot via private message.",
  inputSchema: colleagueInputSchema,
  execute: (input, ctx) => colleagueExecuteAsync(input, ctx),
});
