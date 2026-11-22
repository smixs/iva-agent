# Security policy

Iva holds a Telegram bot token, your model-provider keys, optionally a Google OAuth
token and — if you enable the userbot — a session for your personal Telegram account.
Vulnerabilities here are worth reporting properly.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private channel: [Report a vulnerability](https://github.com/smixs/iva-agent/security/advisories/new).
It creates a draft advisory only the maintainer can see.

If that page is unavailable to you, email **mixshima@gmail.com** with `iva security` in
the subject.

What helps:

- Iva version (`iva version`) and how it was installed.
- What an attacker can reach — vault contents, keys, the Telegram account, the host.
- Reproduction steps, or the smallest input that triggers it.

Expect a first reply within a few days — if a week passes in silence, ping again. Once a
fix ships, the advisory is published and you are credited unless you ask otherwise.

## Supported versions

Only the latest release gets fixes. Iva updates itself in place (`iva update`, or the
Update button in Telegram) — running an old tag is not a supported configuration.

## What is in scope

- Prompt injection that survives the inbound sanitizer and makes the agent act. The
  sanitizer covers Telegram text, captions and transcripts, plus everything
  `web_fetch` and `web_search` bring back — on the web surface it warns rather than
  blocks: flagged content still reaches the model, wrapped in a "treat this as data"
  warning. Its detector is a pattern list, not a judge of meaning: it knows canonical
  phrasings and five families of intent, so a payload paraphrased outside them passes
  unflagged in every language it reads. Document bodies (PDF/DOCX), userbot-read chats and whatever the
  `agent-browser` skill prints through the shell still reach the model unscreened,
  and reports about those paths are welcome too.
- Secret leakage past the redaction gate — into chat, logs or vault files. Note the
  gate screens the Telegram reply: the agent's shell inherits the process environment,
  so a hijacked turn can read your keys directly. That is why the inbound gate and the
  allowlist carry the weight.
- The allowlist letting a non-listed Telegram user through.
- Privilege escalation on the host from anything the agent processes.
- A bypass of the userbot guardrail's wrapped calls (`send_message`, `send_file`,
  `forward_messages`). Raw-API writes — joins, invites, contact imports, reactions —
  are knowingly not wrapped; that gap is documented, not a vulnerability.
- The install and update path — anything that gets code onto a host through
  `install.sh` or `iva update`, including the restart guard.

## What is not in scope

- Attacks that require an attacker who already has shell or root on your server.
- Vulnerabilities in the model, transcription or search providers you choose.
- Telegram account limits or bans that follow from using the userbot: automating a
  personal account is against Telegram's ToS, that risk is documented and accepted by
  you when you opt in.
- Self-hosting mistakes — an exposed `.env`, a world-readable vault, a shared VPS.

## Plugins

Installing a plugin is a trust decision, and Iva says so out loud before the first one.
Plugin code runs inside the agent's process and `bash` inside a plugin's skill runs with the
agent's environment, so both see every key of the installation. That is an accepted risk
([ADR-0008](docs/adr/0008-plugin-is-the-unit-of-extension.md)), not a gap to report: what a
plugin you installed does with your keys is the plugin's behaviour, not a vulnerability in
Iva. An MCP server from a plugin gets less — its own environment, `PLUGIN_ROOT` and
`PLUGIN_DATA`, nothing else. A plugin with code or MCP is installed only by the owner's tap
or in the owner's terminal; the model can only propose it. A bypass of _that_ boundary is in
scope. A plugin of skills only the model installs itself with `iva plugin add` from `bash`, on
the owner's request or after a tap on «Поставить» / «Install» under an Insight: that path is held
by the skill, not by code ([ADR-0009](docs/adr/0009-plugin-rails.md)). Details:
[docs/plugins.md](docs/plugins.md).

Insight is a turn without the owner that brings together the network, writing scripts and
running them: once a day Iva builds and tries one plugin draft and asks before installing. It
is off by default and installs nothing itself; its draft scripts run as the service user and
the draft is not bound to the tap. This is an accepted risk
([ADR-0022](docs/adr/0022-insight-brings-one-capability-a-day.md)), not a gap to report.

## The honest boundary

Your vault is a private git repo on your own server — and once `gh` is authenticated on
that server, the nightly Brain pass mirrors it to a private `iva-vault` repo under your
GitHub account. The model and transcription are cloud APIs you pick and pay for: their
operators see the text you send them. Iva sends its authors one thing, and one line turns
it off: after you install a plugin from the default Marketplace, the name of that plugin
goes to iva-agent.com, with nothing that tells your installation from another
([Install count](docs/plugins.md#install-count); `IVA_PLUGIN_STATS=off` in `.env`). Nothing
else about you or your use of Iva is collected.
