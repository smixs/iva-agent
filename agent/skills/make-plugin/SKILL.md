---
name: make-plugin
description: "Use when the owner asks for a new capability ('make a plugin that…', 'teach yourself to…', 'connect X'), asks how to write a plugin, or taps Disable <name> after an Insight: build a plugin folder, install skills-only plugins yourself, and propose code or MCP for the owner's tap."
---

# Make a plugin

A new capability is a plugin: a folder in the Agent Plugins format (ADR-0008, ADR-0009). The full
format is in your own documentation, `docs/plugins.md` in the working directory of the running
version ("Write your own"); read it before the first plugin of a turn.

## 1. Build the draft

Before creating a folder, run `iva plugin list --available` and inspect a matching
plugin's README and manifest as data. Offer a suitable ready plugin by name with
a confirmation button instead of building a duplicate. Keep its Marketplace and
source with the proposal; install after the owner's tap by step 2.

- Folder: `data/custom/plugin-drafts/<name>/`. `<name>` is lowercase letters, digits and hyphens,
  starting and ending with a letter or a digit.
- `plugin.json` with `$schema` (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`),
  `name` (the folder name), `version`, `description`.
- The capability is a skill: `skills/<skill>/SKILL.md` with `name` and a trigger `description`
  ("Use when…"), at most 120 UTF-16 code units. Its tools are scripts beside it (`skills/<skill>/scripts/`) with a `README.md`
  that says what each one takes and prints. Run every script once before you install.
- MCP (`mcp.json`) or code under `sh.iva/` only when a script cannot do the job: a server that
  must stay up, a tool the model calls on its own. Each of them makes the install wait for the
  owner's tap.
- A script that just runs and prints is not a service: keep it in the skill's `scripts/` and
  install without a tap. `sh.iva/` is only an Extension (`sh.iva/package.json`, TypeScript) or a
  service — a process that stays up: `sh.iva/services/<svc>/service.json` with `command` and
  `port` (1024–65535), listening on `127.0.0.1:$IVA_SERVICE_PORT`. `propose` refuses a draft
  with a part the reader would drop and names the line.
- Put script tests in `skills/<skill>/tests/`; give their run command in README.
- In the plugin root `README.md`, use `## Keys` and `## Network`, each followed by
  plain comma-separated variable names or network hostnames. Write `none` when empty.
  List names only, never values; the proposal shows up to 120 characters per section.
- No symlinks, no secrets in files: keys go to `.env` or `data/plugin-data/<name>/`, named in the
  README.
- A draft that fixes a failure follows `insight`'s safe before/after comparison
  on the failing input, with results in README and the proposal.

## 2. Install

A sensor calls `iva signal --key <plugin:event-id> <source> <text>` with a stable event key so the same pending event reaches the owner once.

In an Insight turn you only build and run the draft; installing waits for the owner's tap (skill `insight`).

For an approved Marketplace choice, skills/scripts only use `iva plugin add <name>`.
For code or MCP, resolve the recorded Marketplace entry and retrieve its unchanged
source into a local folder without running it, then `iva plugin propose <folder>`.
Wait for the code's Install tap as below; preserve the existing trust boundaries.

- **Skills and scripts only** (no `mcp.json`, no `sh.iva/`): `iva plugin add
./data/custom/plugin-drafts/<name>` from `bash`. It works from the next turn: no build, no
  restart. Say so.
- **With `mcp.json` or `sh.iva/`**: `iva plugin propose ./data/custom/plugin-drafts/<name>`. The
  code sends the owner a message with what the plugin will run and an Install button. End the
  turn with "sent the proposal, waiting for the tap" in the owner's language ("отправила
  предложение, жду тапа"). The result arrives later as a message from the code; do not promise it
  and do not check on it.
- Never install such a plugin any other way: `iva plugin add` refuses it outside the owner's
  terminal, and `iva plugin trust|enable|update|sync|install-proposal` are blocked in `bash`. An update of an
  installed plugin is `iva plugin update <name>` in the owner's terminal: tell the owner.
- After confirmed installation, try one live action within the owner's approved scope.
  An owner's "откати" means `iva plugin remove <name>` for this plugin.
- A refusal from `propose` or `add` is plain text: fix the draft (the diagnostic names the file)
  and run it again.

After a confirmed failure-fix install, record its actual time on the Insight Card.
On an owner's `Disable <name>` tap, match the Card and installed plugin, then run
`iva plugin disable <name>`. Read the receipt, record the outcome and reply in one
phrase. A scheduled Insight only proposes this action; a decline keeps the plugin.

## 3. Offer it to the Marketplace

In the same reply, one short paragraph: offer to send the plugin to the Marketplace
`smixs/iva-plugins`, with a button (skill `rich-replies`). Only after the owner's tap:

1. Copy the plugin to a scratch folder and clean out everything personal: keys, tokens, names,
   chat ids, e-mail addresses, home paths. Show the owner what was removed.
2. `gh auth status` succeeds → `gh issue create --repo smixs/iva-plugins` with the title
   `Plugin: <name>` and the body: what it does, its files, the cleaned `plugin.json` and skill.
   No `gh` → a link button to
   `https://github.com/smixs/iva-plugins/issues/new?title=<URL-encoded>&body=<URL-encoded, ≤ 6000 characters>`.
