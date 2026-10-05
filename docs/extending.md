# Extending

Everything Iva does is a file in an `agent/` tree. The shipped files in `agent/` are the authored tree,
refreshed by releases; your custom layer lives in `data/custom/agent/`. `npm run build` combines both in
a disposable tree, then `iva restart` activates the result ([cli.md](./cli.md)). The live source checkout
stays clean, so an update cannot be blocked by a customized skill or HTML file. Local edits you already
made to `agent/instructions.md`, `agent/connections/`, `agent/tools/` or `agent/subagents/` move into
the custom layer automatically on the first update - a `data/custom/agent/instructions.md`
that arrived that way is the deprecated replacement persona: `iva doctor` names it, and
"Your rules" below shows the way off it. Skills and the markdown owner rules are the exception:
they are read straight off disk at run time and never go through a build (see below). Edits anywhere else in
the tree are not carried over: an update installs the release as it is, so keep what is yours in
`data/custom/` - skills, tools, plugins - where a release never touches it. Working on Iva's own code
instead? Put an empty `.iva-dev` file in the root of the checkout: `iva update` then refuses it and the
tree is yours to `git pull` and `npm run build` by hand.

A capability can also arrive packaged: a plugin is a folder with skills, code and MCP servers
that installs with one command and leaves with another, into the same custom layer. This page is
what you write yourself; plugins are [plugins.md](plugins.md).

## Adding a skill

Skills are markdown procedures in `data/custom/agent/skills/` that the model loads on demand. The
frontmatter `description` is the only part the model sees before loading - write it as a trigger
condition ("Use when…"), not a summary. Two shapes work: a flat `<name>.md`, or a `<name>/` directory
with a `SKILL.md` plus supporting files. Iva loads both your custom skills and the bundled skills in
`agent/skills/`; bundled skills are read-only templates, simplest first:

- 📋 **brief/** — walks tasks, calendar, mail and every Connection, then writes one overview plus one message per action. Copy this for any "gather, judge, report" job.
- 🔎 **web-research.md** — a 4-step chain: `web_search` → pick 2–4 sources → `web_fetch` each → synthesize with links.
- 🌐 **agent-browser/** — directory skill wrapping a CLI the model drives through `bash`.
- 🛡 **security-defense/** — a procedure plus data: `SKILL.md`, a patterns file for reviewing a command by eye, and the secret-key inventory the runtime gate reads.
- 📮 **google-workspace.md** — one CLI surface covering Gmail, Calendar, Drive, Sheets, Docs and Tasks.
- 📄 **documents.md** — local PDF, DOCX and XLSX extraction, one-file answers and optional library import.
- 📡 **telegram-userbot/** — a guarded personal-account workflow with a separate safety reference.
- 🎨 **rich-post/** — rich Telegram posts to another allowlisted chat; the sending is the `iva post` command, not a bundled script.
- 🩹 **update-recovery/** — merges customizations an update left in `data/update-conflicts/`; triggered by "restore my update changes".

A new skill needs no build: Iva reads `data/custom/agent/skills/` at the start of every turn, so a file
written during a conversation is loadable on the next one. A skill that shares its name with a bundled
one replaces it. The skills of an installed plugin are read the same way, and yours here win over
theirs ([plugins.md](plugins.md)). Tools, connections, subagents and instructions are code that goes into the bundle -
those still need `iva update`.

⚠️ Your skills go in `data/custom/agent/skills/` and nowhere else - never in a `.claude/` directory
(`~/.claude/skills/`, `vault/.claude/skills/`). That is a different tool's layout; Iva does not read it.

If Iva should reach for your skill unprompted, name it in a file under
`data/custom/agent/instructions/`.

## MCP connections

Drop `data/custom/agent/connections/<name>.ts` - the filename becomes the connection name.
`agent/connections/example.ts.txt` is the inert bundled template (the `.txt` suffix keeps eve from
loading it half-configured):

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/sse", // Streamable HTTP or SSE endpoint
  description: "What this server does — the model reads this.",
  auth: {
    getToken: async () => ({ token: process.env.EXAMPLE_MCP_TOKEN ?? "" }),
  },
  // tools: { allow: ["search", "get_item"] },  // optional: restrict, add approval
});
```

The model discovers the server's tools through the built-in `connection_search` and calls them as `connection__<name>__<tool>`. The URL and token stay on the runtime side: keys live in `.env` and are never visible to the model.

## Custom tools

Put a tool in `data/custom/agent/tools/<name>.ts`. Use the bundled files in `agent/tools/` as
read-only examples. Every input must have a zod schema, enum-like values need explicit allowlists,
and file paths must be resolved and bounded to their permitted root. Keep credentials in `.env`.
The disposable build compiles custom tools together with the authored tree's tools without copying their
source into the live checkout.

## Subagents

A subagent is `data/custom/agent/subagents/<name>/` with an `agent.ts` and its own `instructions.md`.
The bundled `agent/subagents/planner` is the pattern: its `description` tells the main agent when to
delegate ("break a large goal into steps"), and a zod `outputSchema` forces a structured, validated
reply instead of prose:

```ts
outputSchema: z.object({
  goal: z.string(),
  steps: z.array(z.object({
    title: z.string(), detail: z.string(), priority: z.enum(["low", "med", "high"]),
  })),
}),
```

A subagent runs on the main provider: the planner takes its model straight from `agent/provider.ts`, so `MODEL_PROVIDER` picks the model for every node of the graph at once. Subagents deliberately keep no provider or env of their own — one selection, one identity, one usage line.

## Your rules

Your own rules live next to the bundled persona, in `data/custom/agent/instructions/`.

Every markdown file there is read straight off disk on every turn - no rebuild, no restart, the
same way skills work. Rules load in file-name order, so prefix a name when the order matters
(`10-tone.md`). The whole directory shares one cap of 4 000 characters: `iva doctor` prints the
current count and warns when the sum goes over.

In the chat, "remember a rule: answer with a one-line summary first" is enough. Iva confirms
what she heard and, after your yes, writes it into `rules.md` there through `write_file` -
she asks first because the rule loads on the very next turn, and she does not edit files
behind your back.

A rule of behaviour is not CORE: CORE holds standing facts and goals, the reply style comes
from the `/menu` quiz, and rules live here.

`.ts` files in the same directory are dynamic instruction sources, like the bundled
`agent/instructions/20-core.ts`: only `eve`, local packages, `agent/lib` and node
`fs`/`path` may be imported there, and they go through `npm run build` - unlike the markdown files beside them.
A name already taken by a bundled file in `agent/instructions/` is refused by the build with
the path - rename the file.

### The replaced persona

`data/custom/agent/instructions.md` is the old way: it **replaces** the bundled
`agent/instructions.md` whole. Your copy froze on the day you wrote it, and every rule shipped
since - delivery, reminders, the tool policy - never reaches the model. `iva doctor` warns when
the file exists. On a Version install the file is copied as is; on a checkout the updater
merges the three versions (base, yours, upstream) and a full rewrite conflicts.

Moving off it:

1. See what is actually yours. Iva keeps the base your file replaced; the manifest records
   which blob it was built from, and the blob sits next to it:

   ```bash
   cd ~/iva            # or your checkout
   base=$(node -e 'const m=require("./data/custom/manifest.json");console.log(m.entries["agent/instructions.md"].baseBlob)')
   diff -u "data/custom/bases/$base" data/custom/agent/instructions.md
   ```

2. Keep the red lines no release can know - tone, report shape, hosts and paths of your
   machine, personal integrations. Drop everything the bundled persona already says and every
   recipe that has since become wrong (a script that sends to Telegram itself, a shell timer,
   a removed command).

3. Write what is left into `data/custom/agent/instructions/rules.md` and remove the
   replacement: `rm data/custom/agent/instructions.md`. Then `iva update --force` on a Version
   install, or `npm run build` and `/restart` in the chat on a checkout. The bundled persona
   comes back and your rules ride next to it.

4. Check the result: `grep -c "Owner rules" ~/iva/current/agent/instructions.md` prints 1, and
   asking Iva "what are your rules for reports?" returns what you wrote.

5. `iva rollback` flips back to the version that ran before if something is off.

What Iva knows about _you_ is memory, not code - that's `CORE.md` in the vault ([memory.md](./memory.md)).

## Local development

```bash
npm ci        # postinstall applies patches/eve+0.51.1.patch
npm run dev   # eve dev TUI, server on http://127.0.0.1:2000
npm run build:core  # maintainer build of the current source tree
npm exec -- eve dev --no-ui --logs all   # headless
```

The TUI is a full chat — skills, tools and subagents all work without Telegram. To smoke-test the tool loop from a script, drive the dev server with `eve/client`:

```js
import { Client } from "eve/client";
const session = new Client({ host: "http://127.0.0.1:2000" }).session();
const res = await session.send("Add a task: buy coffee, high priority.");
console.log((await res.result()).message);
```

One gotcha — Iva runs eve **0.51.1**:

- 🩹 **patch-package** — `patches/eve+0.51.1.patch` makes deterministic model-call errors (invalid prompt, unknown tool) fail fast instead of parking a poisoned session. It also preserves the structured HTTP status from `web_fetch`, keeps the dynamic "Available skills" announcement in the system prompt instead of a user message, and falls back to `/workspace/skills` when the sandbox reports `HOME=/` (upstream vercel/eve#2839, PR #2841; contract test `scripts/eve-skill-announcement.test.ts`). A second hunk makes the `AGENT_BUSY` message name the next step: end the turn, since the task result arrives after it, or stop the task with `task_cancel` (upstream issue: pending; hunk test `scripts/eve-agent-busy.test.ts`; drop it on the Eve bump whose busy message names a next step in any wording). If you bump Eve, regenerate the patch or drop each edit only after its targeted contract test passes against upstream.

The patch also lets a manual session compaction (`compact()`) resolve a model that only a `step.started` resolver provides: upstream reads the model without dispatching that event and fails with "Dynamic model selection is required", so Iva's compaction between turns could never run (contract test `scripts/eve-manual-compaction.test.ts`; remove the hunk when eve dispatches the step resolver for `compactOnly` itself).

The same patch makes Eve the only transport retry owner: the SDK retry count is zero, and Eve makes at most three model-call attempts with default waits of 5s and 15s. Provider Retry-After minimums share that 20s total wait allowance; a longer required wait parks the turn instead of retrying early. Only failures before a stream opens are retried; transport retries never replay an opened stream or completed generation. Backoff is cancelled with the turn, and exhausted chat turns remain ready for the next user message. The boundary tests are `scripts/eve-model-retry.test.ts`; upstream tracking is [vercel/eve#3984](https://github.com/vercel/eve/issues/3984) and [#2320](https://github.com/vercel/eve/issues/2320). Remove these retry-owner and stream-observation changes when those contracts pass against unpatched upstream, preserving unrelated patch changes. This focused successor was inspired by [@qwin2k's PR #251](https://github.com/smixs/iva-agent/pull/251).

The Eve 0.11.4 schedule crash (`eve dev` dying when a schedule handler imported another authored module) is fixed since 0.27.8. Iva's in-process Eve schedules are `memory-night.ts`, `proactive.ts`, `reminders.ts` and `jobs-watchdog.ts` under `agent/schedules/`. On a VPS they run inside `iva.service` ([deploy.md](./deploy.md)).
