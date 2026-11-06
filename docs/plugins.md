# Plugins

A plugin is how Iva grows: a folder you bring from anywhere, install with one command and
remove with another. It carries skills, code and MCP servers, so a new capability costs no
edit to the shipped tree and no fork (ADR-0008). The format is
[Agent Plugins 1.0.0](https://agent-plugins.org) — the same folder Codex, Cursor and Kiro
read, so nothing here is Iva's own invention.

A plugin of skills alone Iva may write and install herself, the way she writes a skill. A
plugin with `mcp.json` or `sh.iva/` runs code inside the agent's process with this
installation's keys in its environment, so it is installed from your terminal or by your tap:
Iva runs `iva plugin propose <folder>`, you get a message built by code with what the plugin
will run and an **Install** button, and the Bridge installs it after the tap, outside her turn
(ADR-0009). The tap marks your intent on the regular path; it does not stop a model that has
already been talked into misusing `bash`. What that means for you is at the end, under
[What you risk](#what-you-risk).

## Install one

```bash
iva plugin add trace                         # a name from a Marketplace
iva plugin add smixs/iva-plugins/trace       # owner/repo[/subdir][@ref]
iva plugin add smixs/iva-plugins/trace@v1.2  # pin a tag, a branch or a full sha
iva plugin add https://github.com/you/my-plugin.git
iva plugin add ./my-plugin                   # a folder on this machine
```

`add` prints what the folder carries before anything moves into place:

```
  trace 0.1.0 — skills: trace; code: sh.iva; mcp: files
```

Before your first install it prints the accepted risk once. If the plugin brings stdio MCP
servers or its own services, it prints their commands and asks
`Start these processes on this machine? [y/N]` — `--trust` answers yes without asking. A
non-interactive shell (a script, Iva's own `bash`) does not install a plugin with `mcp.json`
or `sh.iva/` at all: `add` refuses and names `iva plugin propose`.

What happens next depends on what the plugin carries:

- 📋 **Skills only** — they work from the next turn. No build, no restart.
- ⚙️ **An eve Extension in `sh.iva/`, or MCP servers you trust** — their code and their
  connections live inside a version, so Iva builds a new one with the plugin in it and
  restarts the agent, on the same rails as `iva update`. A build that fails takes the install
  back and leaves the running version alone: installing a plugin cannot break the box
  (ADR-0003).
- 🔌 **Services only** — a `sh.iva/` with `services/` and no `package.json` never enters a
  version. Nothing is rebuilt and nothing restarts: `trust` writes the units and starts them,
  and that is the whole installation.

## The commands

| Command                                    | What it does                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `iva plugin add <name\|source> [--trust]`  | Install by name from a Marketplace, or from a folder, `owner/repo[/subdir][@ref]`, `https://…` or `git@…` |
| `iva plugin list`                          | What is installed: version, sha, `enabled`/`disabled`, `trusted`/`untrusted`, components, source          |
| `iva plugin list --available`              | What your marketplaces offer, and which of it you already have                                            |
| `iva plugin update [name] [--force]`       | Pull the tracked ref, printing `old → new`; without a name, every plugin                                  |
| `iva plugin enable <name>`                 | Turn a plugin back on — skills return on the next turn                                                    |
| `iva plugin disable <name>`                | Turn it off without removing it                                                                           |
| `iva plugin trust <name>`                  | Allow its MCP servers and services to run as processes on this machine                                    |
| `iva plugin untrust <name>`                | Stop those processes and remove their units; skills keep working                                          |
| `iva plugin remove <name>`                 | Remove the plugin; its data in `data/plugin-data/<name>/` is kept                                         |
| `iva plugin sync`                          | Repair: rebuild `plugins.json` from the folders and reinstall whatever is missing                         |
| `iva plugin marketplace add\|remove\|list` | Your lists of plugins that install by name                                                                |
| `iva plugin propose <folder>`              | Ask the owner in Telegram to install a plugin with code or MCP; the Bridge installs it after the tap      |

`iva plugin` with no arguments prints the same list. Every command that changes state takes
the same lock as `iva update`, so one run at a time: start a second while an update is in
flight and it says so instead of colliding with it.

## Where a plugin lives

Everything sits in the Custom layer or beside it, so `iva update` never touches it:

| Path                                     | What it is                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/custom/plugins/<name>/`            | the plugin itself — a git checkout pinned to one sha, or a copy of your folder                                                                 |
| `data/custom/plugins/<name>.config.json` | your settings for the plugin's code, read at start and never baked into a build                                                                |
| `data/custom/plugins/<name>.env`         | environment for the plugin's MCP servers, one `KEY=value` per line                                                                             |
| `data/plugin-data/<name>/`               | the plugin's own data (`PLUGIN_DATA`) — survives an update of the plugin and even its removal                                                  |
| `data/custom/plugins.json`               | one state file: `name`, `source`, `ref`, `sha`, `digest`, `enabled`, `trusted`, `installedAt`, plus your marketplaces and the ports handed out |
| `data/marketplace-cache/`                | the marketplace lists as last read                                                                                                             |

`plugins.json` is the source of truth. Delete the folders, move the installation, restore an
old backup — `iva plugin sync` puts every plugin back at its recorded sha. A folder that is
there without an entry is taken back into the file; an entry whose folder is gone is
refetched. A `sync` that restores a plugin with code says so: the code reaches the running
version with the next `iva update`.

The config and env files live _beside_ the plugin folder, not inside it, because an update
overwrites the folder and your values have to survive that.

## Enabled and trusted

Two independent flags, and `list` prints both:

- **enabled** — the plugin's skills and code are loaded. `iva plugin disable` switches them
  off and keeps everything on disk.
- **trusted** — the plugin's MCP servers and long-running services may run as processes on
  your machine. A fresh install is untrusted: text in a prompt and a process on the host are
  not one switch.

An untrusted plugin still works, just quieter: skills load, stdio MCP servers and services
stay down. `iva plugin trust <name>` starts them; `untrust`, `disable` and `remove` stop them
and remove their units. Trusting a plugin with MCP servers also rebuilds the version, because
its connections are generated into one; a plugin with only services just gets its units.

Skill names are global, so `add` refuses two plugins that offer the same skill name — one of
them would go dark without saying so. Your own skill in `data/custom/agent/skills/` wins over
a plugin's skill of the same name, and a plugin's skill wins over a bundled one.

## What `iva update` does to plugins

Every enabled plugin that carries code is rebuilt with the eve the new version runs. That is
why a plugin never ships `dist/` and never falls behind an eve bump: the folder, its config,
its data and its trust flag stay exactly as they were, and only the build is redone.

A plugin whose code does not build against the new eve does not stop the update. The version
is built without it, the plugin is switched off, and one Alert names it:

```bash
iva plugin update <name>
iva plugin enable <name>
```

`iva plugin update` follows the ref recorded at install — a branch, a tag or a sha — and
prints `old → new`. It refuses to touch a folder you edited in place (the `digest` in
`plugins.json` says it changed) until you pass `--force`; that way local edits are never
overwritten in silence. An entry a Marketplace pinned to a commit has nothing to follow: to
move it, `remove` and `add` it again.

When an update changes a plugin's content, its units — services and MCP proxies — are
restarted onto the new code right there, so a plugin that only carries services never needs
`iva update` to run its new version.

## Marketplace

A Marketplace is a list of plugins in a git repository — `name` to source, nothing more. No
central place, no moderation, nobody's approval to publish. Iva reads
`.agents/plugins/marketplace.json`, the convention of Codex, so the same list works for its
users too.

```bash
iva plugin list --available          # what is on offer
iva plugin marketplace add you/your-plugins
iva plugin marketplace list
iva plugin marketplace remove your-plugins
```

The default list is `smixs/iva-plugins`, and it stays in place when you add your own. Lists
are cached under `data/marketplace-cache/`; offline, the cache is used and marked as possibly
stale. A name offered by two lists is refused with an `add <name>@<list>` hint, and an entry
whose manifest calls the plugin something else is refused before anything is installed — the
list is a file nobody vetted.

## Write your own

The smallest plugin is a manifest and one skill:

```
my-plugin/
  plugin.json
  skills/
    weather/
      SKILL.md
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What it does, in one line."
}
```

`$schema` and `name` are the only required fields. A name is 1–64 lowercase letters, digits,
hyphens and periods, starts and ends alphanumeric, and contains no `--` or `..`. Iva
validates the manifest locally and never fetches the schema over the network.

Two limits worth knowing before you package anything: symlinks are refused outright, and a
plugin is capped at 2000 files, 50 MB and 16 levels of nesting. A broken component does not
take the others down — a plugin with an unusable `mcp.json` still gives you its skills, and
`iva plugin list` prints the diagnostic.

While you write, install the folder itself: `iva plugin add ./my-plugin`. It is copied into
the store rather than linked, and `iva plugin update my-plugin` copies it again from the same
path.

### Skills

`skills/<name>/SKILL.md`, exactly one level deep, in the
[Agent Skills](https://agentskills.io) format with `name` and `description` in the
frontmatter. Keep the description within 120 UTF-16 code units, as a trigger condition ("Use when…"): before the skill is
loaded, that line is all the model sees. Everything else about skills is in
[extending.md](extending.md) — a plugin's skill is an ordinary skill that happens to arrive in
a folder.

`iva plugin add` and `propose` warn about longer skill descriptions for all sources,
including local `data/custom/plugin-drafts/`. The build continues, and the prompt
index truncates the description to 120 UTF-16 code units.

### Code: an eve Extension under `sh.iva/`

`sh.iva` is Iva's namespace, and it holds two different things: an eve Extension, which is
`sh.iva/package.json`, and services, which are `sh.iva/services/<svc>/service.json`. Either
alone is fine. The manifest has to declare the namespace in both cases — a `sh.iva/` no
manifest claims is ignored, with a diagnostic in `iva plugin list`.

For code, declare the key and put a real eve Extension package in the folder:

```json
{ "extensions": { "sh.iva": {} } }
```

```
my-plugin/
  sh.iva/
    package.json          # eve.extension.{source,dist} — write it with: eve extension init
    tsconfig.json         # required: eve emits declarations with tsc and refuses without one
    extension/extension.ts
```

Ship no `dist/`. Iva builds it inside the version: a copy of the plugin, `npm ci` without dev
and peer dependencies, `eve extension build` with the very eve that will run it, a generated
mount at `agent/extensions/<ns>.ts`, then the normal build, the probe, the flip and a restart.
`<ns>` is your plugin's name with `.` and `-` folded to `_`, and it is also the prefix on
every tool your extension contributes — `my_plugin__forecast`.

Owner settings come from `data/custom/plugins/<name>.config.json`. Declare their shape and
read the bound values through the handle; the generated mount passes the file's contents to it
at start, so a changed setting costs a restart, not a rebuild:

```ts
// sh.iva/extension/extension.ts
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({ config: z.object({ city: z.string() }) });
```

An extension cannot declare `agent.ts`, `sandbox`, `schedules` or nested extensions — those
belong to the agent that mounts it. A plugin has no schedules of its own for the same reason:
eve refuses them.

### MCP servers: `mcp.json`

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "files": {
      "type": "stdio",
      "command": "node",
      "args": ["server.mjs", "--root", "${PLUGIN_DATA}"],
      "env": { "FILES_LOG": "${PLUGIN_DATA}/log" }
    },
    "search": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SEARCH_TOKEN}" }
    }
  }
}
```

Both transports work, and both need `trusted`:

- **`streamable-http` and `sse`** become a generated connection named
  `mcp-<name>--<server>` — the file `agent/connections/mcp-<name>--<server>.ts` inside the
  version. eve accepts lowercase letters, digits and dashes in a connection name, so both
  halves are folded into that alphabet: a server called `Trace.Viewer` becomes
  `trace-viewer`. The model finds its tools through `connection_search` like any other
  connection and calls them `connection__mcp-trace--viewer__<tool>`. `${VAR}` in a header is
  filled at run time from `data/custom/plugins/<name>.env`, so no token is baked into a
  build. The URL must be absolute `https://` (plain `http://` only for loopback), with no user
  information and no fragment.
- **`stdio`** runs as a systemd unit, `iva-mcp-<name>-<server>.service`, with the **MCP
  proxy** in front of it: Iva's own service holds your server on its stdio and exposes it to
  the agent over streamable HTTP on `127.0.0.1:<port>/mcp` behind a bearer. The token lives in
  `data/plugin-data/<name>/mcp-<server>.token` at mode `0600`; `GET /health` answers without
  it. `Restart=on-failure`, so a crashed server comes back.

`command` is a single token — a bare executable name or a `./`-relative path inside the plugin
— never a shell string. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded once in `args`,
`env` and `cwd`; the working directory defaults to `PLUGIN_ROOT`.

What a stdio server sees in its environment is the point of the proxy: `PATH`, `HOME`,
`PLUGIN_ROOT`, `PLUGIN_DATA`, whatever `mcp.json` declares, and whatever you wrote in
`<name>.env`. Nothing else from the agent's environment reaches it — no Telegram token, no
provider key.

Ports are handed out at `trust`, from 8730 up, recorded in `plugins.json` and stable until the
plugin is removed.

### A long-running service

A plugin that needs its own process — a viewer, a worker, anything that must outlive a restart
of the agent — declares it under `sh.iva/`, next to the same `extensions` key and with no
`package.json` needed:

```
my-plugin/
  sh.iva/
    services/
      viewer/
        service.json
        server.mjs
```

```json
{ "command": "node", "args": ["server.mjs"], "port": 8726 }
```

Iva writes the unit `iva-plugin-<name>-<svc>.service` and starts it only while the plugin is
enabled **and** trusted, with `Restart=on-failure`. The working directory is the service's own
folder, and the environment is exactly four variables:

| Variable           | What it holds                                                           |
| ------------------ | ----------------------------------------------------------------------- |
| `IVA_SERVICE_PORT` | the port to listen on — bind `127.0.0.1` and nothing else               |
| `IVA_DATA_DIR`     | absolute path of Iva's data directory, for reading things like `trace/` |
| `PLUGIN_ROOT`      | the plugin folder in the store                                          |
| `PLUGIN_DATA`      | `data/plugin-data/<name>/`, yours to write in                           |

The plugins Iva ships in `smixs/iva-plugins` are TypeScript run by Node directly —
`"command": "node", "args": ["server.ts"]`, with no build step — while a service of your own may
be any command at all: the contract is only `service.json` and those four variables.

`port` in `service.json` is a preference: Iva uses it when free and hands out the next free
port otherwise, which is why the number arrives through `IVA_SERVICE_PORT` rather than a
constant in your code. A plugin with services but no extension needs no version build — only
its units, and `iva plugin update` restarts them onto the code it just brought.

Units are Linux-only. On a machine without systemd the commands print `no systemd` and carry
on: state is still recorded, so the same installation on a server brings the processes up.

## Check it

```bash
iva plugin list      # per plugin: flags, components, source, diagnostics
iva doctor           # the Plugins section
iva plugin sync      # what doctor tells you to run when the two disagree
```

`iva doctor` reads the manifests, compares `plugins.json` with `data/custom/plugins/`, says
whether each code plugin is really built into the running version, and checks the expected
units — `is-active` for every one of them, plus `GET /health` for each MCP proxy.

## What you risk

Read this once, then decide per plugin.

A plugin's code runs inside the agent's process, and `bash` inside its skill runs with the
agent's environment. Both therefore see every key of this installation: the Telegram token,
the model provider, everything else in `.env`. Installing someone else's plugin means handing
it those keys. Checking the manifest does not help — `plugin.json` describes what is inside,
not what it does.

This is an accepted risk, not an oversight (ADR-0008): isolating secrets from the shell is a
separate, deferred piece of work, and plugins do not bring it closer. What the rails do
instead is keep the decision yours and make it visible:

- only the owner installs, only from the terminal, never the model and never from Telegram;
- `trusted` is a second, explicit yes before any plugin process runs on your machine;
- an MCP server gets less than the agent does: its own environment, `PLUGIN_ROOT` and
  `PLUGIN_DATA`, and nothing more;
- a plugin that fails to build never reaches the running version.

Your own plugin is a risk you can see. Someone else's is not — read the code before you
install it, or pin it to a sha you have read.

The rest of the security picture is in [security.md](security.md).
