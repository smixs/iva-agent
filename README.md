<p align="right"><b>EN</b> · <a href="./README.ru.md">RU</a></p>

<div align="center">

<img src="assets/iva-header.webp" alt="Iva — self-hosted Telegram AI assistant with layered memory" width="100%">

[![Release](https://img.shields.io/github/v/release/smixs/iva-agent?color=brightgreen)](https://github.com/smixs/iva-agent/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![built on eve](https://img.shields.io/badge/built%20on-eve-000000?logo=vercel&logoColor=white)](https://eve.dev/docs/introduction)
[![Node 24](https://img.shields.io/badge/node-24.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Last release](https://img.shields.io/github/release-date/smixs/iva-agent?label=last%20release&color=informational)](https://github.com/smixs/iva-agent/releases)

[Site](https://iva-agent.com) · [Use cases](#why-people-run-iva) · [Features](#features) · [Install](#install) · [Memory](#the-memory-tree) · [What's new](#whats-new) · [Docs](#documentation)

</div>

---

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. You talk, it files: voice notes, photos, forwarded posts and decisions become plain-markdown cards it actually remembers. Everything runs on your own server, with your keys and your data.

**One command installs it:**

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

## Why people run Iva

- "What did we agree with client X about the last shipment?" — found in seconds, months later.
- A five-minute voice note from the car → a task list, a draft email, a meeting card.
- "Make a quote from this price list, cut the discount by 2.5%, send it to the client" — a finished Google Doc, link in the chat.

The rest — for business owners, specialists, executives and everyday life: **[Use cases](docs/use-cases.md)**.

## How it works

<img src="assets/iva-flow.webp" alt="How Iva works: voice, text, photos and PDFs fly from Telegram into the willow-tree agent, wired to memory, nightly rollup, cron, reminders, search, web, workspace and docs" width="100%">

The bridge long-polls Telegram, so no public HTTPS, domain or webhook is needed. Iva runs as two systemd user services, two systemd watchdog timers and seven in-process eve schedules — operations live in [docs/deploy.md](docs/deploy.md).

**Wondering what you'd actually use an agent for?** → [25+ real scenarios — business, work, everyday life](docs/use-cases.md).

<img src="assets/iva-use-cases.webp" alt="What people ask Iva: eight everyday requests, from a voice note turned into tasks to research with sources and a bedtime story that continues tomorrow" width="100%">

## Features

<details>
<summary><b>Voice, vision, memory, personal CRM, Google Workspace, skills — expand the full list</b></summary>

- **Voice** — voice, audio and video notes transcribed with Deepgram nova-3; auto-detects ru/uz/en.
- **Vision** — photos described by your provider's own vision model; no extra key, no extra bill.
- **Rich replies** — tables, checklists, collapsible blocks and formulas render natively in Telegram via Bot API 10.1 rich messages; plain formatting keeps its proven path, with a graceful fallback.
- **Quiet update checks** — once a day Iva checks for a newer stable release without spending model tokens. If one exists, Telegram offers **Update** or **Later** once; otherwise it says nothing.
- **Layered memory** — remembers across months, long after the chat window has scrolled away.
- **Personal CRM** — who your people are, what you agreed, when to follow up.
- **Search by meaning** — BM25 plus link-graph rerank, any language; optional vector mode with one key.
- **Decision cards** — what you chose, when and why; old versions stay in a dated History.
- **[Tasks](docs/tasks.md) & reminders** — priorities, due dates and a daily brief.
- **Web search** — four pluggable providers: Tavily, Exa, Parallel or Brave.
- **Google Workspace** — Gmail, Calendar, Drive, Sheets, Docs and Tasks from chat via the `gws` CLI; installed for you, with a guided key setup right in the conversation.
- **Skills & MCP** — drop one file to add a procedure or connect an MCP server; keys stay in `.env`.
- **Personal Telegram — userbot (beta)** — read and send from your _own_ account, not just the bot; connect by chat (QR, no terminal). Rough and buggy — opt-in, **at your own risk**. A server-side anti-ban guardrail (FloodWait compliance + randomized pacing + circuit-breaker) is enforced, not just advised. [Details](docs/userbot.md).
- **Safe to forward** — forwarded text, captions and voice transcripts pass an injection screen before the model reads them. A flagged message or transcript reaches the model tagged as data rather than as an instruction; for media captions the screen runs but the tag does not travel with it yet.
- **Token accounting** — every model step is logged; `/usage` reports it for free.

</details>

## The Memory Tree

<img src="assets/iva-memory-tree.webp" alt="How Iva remembers: a leaf is a day, branches are weeks and months, tree rings are years around CORE.md" width="100%">

| Layer       | What lives there                                                                                    | Path                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🍃 Leaves   | the word-for-word transcript of each day, Iva's replies included                                    | `daily/YYYY-MM-DD.md`                                |
| 🌿 Branches | summaries folded upward: day → week → month → year                                                  | `summaries/daily/`, `weekly/`, `monthly/`, `yearly/` |
| 🪵 Trunk    | `CORE.md` (≤1200 chars, in every prompt) + typed cards: contacts, projects, decisions, ideas, notes | `CORE.md`, `cards/`                                  |

- Every message lands verbatim in a daily markdown log — nothing is paraphrased on arrival.
- A nightly rollup at 04:00 distills day → week → month → year into schema-validated cards; facts that change get rewritten, not piled up.
- One core file, `CORE.md` (≤1,200 chars), rides in every prompt — Iva knows you before it searches anything.

Full architecture and search internals: [docs/memory.md](docs/memory.md).

## A secretary inside Telegram

<img src="assets/iva-userbot.webp" alt="Your secretary inside Telegram: the userbot reads group chats from your own account, collects summaries and replies as you, guarded by a server-enforced anti-ban guardrail" width="100%">

The bot is half of Telegram. The other half is your personal account: connect the userbot (beta, opt-in) and Iva works from it like a secretary — reads the group chats you never keep up with, folds them into summaries, catches the messages that actually need you, and replies as you.

- **All of Telegram** — groups, channels, unreads, search and the full history of your personal account.
- **Onboarding in chat** — tell the bot to connect your Telegram, scan a QR. No terminal.
- **Anti-ban guardrail on the server** — FloodWait compliance, a randomized delay after every send, and a circuit-breaker that pauses sending after three FloodWaits in 24 hours. It is enforced in the proxy rather than asked for in a prompt, and it wraps the three outbound calls that actually get accounts flagged: messages, files, forwards. Joins, invites, contact imports and reactions are not wrapped — those limits live in the skill file, which is a prompt.
- **Read-only mode** — one `.env` switch and Iva can read and search but physically cannot send.

> [!WARNING]
> Automating a personal account is against Telegram's ToS and can get the account limited or banned. The userbot is opt-in, beta, and used at your own risk — reading is far safer than sending. Details: [docs/userbot.md](docs/userbot.md).

## Security & privacy

<img src="assets/iva-security-gate.webp" alt="Untrusted input from Telegram and the web passes the security gate: corrupted messages drop into the reject tray, only clean context reaches the vault" width="100%">

Web pages, search results, voice transcripts, captions and the vision model's description of a picture reach the model only through a prompt-injection sanitizer. On a forwarded text message the same gate annotates the turn with a warning instead of filtering the text, and document bodies, userbot-read chats and `agent-browser` output are not screened at all. Everything that leaves through the Outbox passes a secret-redaction gate, and the user allowlist fails closed — an empty list answers nobody. Your memory is a private git repo you own; the honest boundary is that the model and transcription are cloud APIs you choose and pay for. Gate internals and the full boundary: [docs/security.md](docs/security.md).

## Install

One command on any Ubuntu/Debian box — a fresh VPS or your own machine:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

1. Get a bot token from [@BotFather](https://t.me/BotFather).
2. Run the installer and answer its questions.
3. Message your bot. The wizard picks your Telegram ID out of that message, finishes setup, and Iva confirms right in the chat that it's live.

Brand-new VPS, still logged in as root? Run `bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)` first: it creates your sudo user (with lingering enabled), updates the box, and turns on a firewall, fail2ban and SSH hardening. It asks three things — a login, its password, and the timezone — and no SSH key. Then log in as that user with that password and run the installer above. Details: [docs/install.md](docs/install.md).

Install as a normal user, not as root — Iva's shell tool runs as whoever installed it. Headless installs take `--skip-setup` or `--non-interactive`. Prefer to read before you run? Fetch it with `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh -o install.sh`, read it, then `bash install.sh`. Wizard walkthrough and an SSH primer for first-time VPS owners: [docs/install.md](docs/install.md).

### Updates

- `iva update` installs releases only (`vX.Y.Z` tags) — the default.
- `main` holds releases only; every accepted change lands in the `beta` branch first.
- `iva beta` turns on beta updates: the tip of the `beta` branch; `iva stable` turns them off and goes back to `main` (nothing is rolled back — the next release catches up). Then run `iva update`.
- Any installation, 0.4.8 included, switches to beta with one command: `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/beta/beta.sh | bash`. A new installation on beta: `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/beta/install.sh | IVA_BETA=1 bash`.
- The same switch is in Telegram: `/menu` → 🛠 Maintenance → 🧪 Updates. `iva version` shows which one is on.

### The first minute

Three messages, and you can watch the memory work:

1. Send a voice note about your day — anything, out loud. Then look in `daily/` inside your vault on the server: your words are sitting there in plain markdown, dated, yours. No other assistant hands you the file.
2. Tell it something a colleague would remember: `Marina at Acme wants the revised quote by Friday — she never picks up the phone.`
3. Ask for it back the way a person would: `how should I follow up with Marina?` — the answer comes from the card Iva just wrote, not from the last few messages.

Then send a photo of a business card, or forward a long post and ask for the gist. `/menu` has the rest; the full list is in [25+ scenarios](docs/use-cases.md).

<details>
<summary><b>Install from a clone — build it yourself</b></summary>

```bash
git clone https://github.com/smixs/iva-agent.git ~/iva
cd ~/iva && bash install.sh
```

The installer reuses the existing checkout instead of re-cloning, keeps `.env` and the vault untouched, and installs the same dependencies. A fork or a branch works through variables read at startup: `REPO_URL=…`, `BRANCH=…`, `INSTALL_DIR=…` (defaults: this repo, `main`, `~/iva`). Details: [docs/install.md](docs/install.md).

</details>

## Providers & cost

Six model providers. Pick one and fill its block in `.env`:

| Provider         | How you pay                            |
| ---------------- | -------------------------------------- |
| OpenCode Go      | API key, ~$10/mo ($5 first month)      |
| Ollama Cloud     | API key, ~$20/mo                       |
| OpenRouter       | API key, pay-as-you-go, 300+ models    |
| OpenAI (ChatGPT) | your Plus/Pro subscription, no API key |
| Claude (Pro/Max) | your Pro/Max subscription, no API key  |
| Custom           | your own OpenAI-compatible endpoint    |

Default model is deepseek-v4-pro, 131k context. On Go it runs about $14–15/mo all-in ($10 model + $4–5 VPS; the model's first month is $5), no markup; voice rides Deepgram's free starter credit. Model lists, limits and the search matrix: [docs/providers.md](docs/providers.md).

## Documentation

[Use cases](docs/use-cases.md) · [Install](docs/install.md) · [Configuration](docs/configuration.md) · [Memory](docs/memory.md) · [Providers](docs/providers.md) · [Security](docs/security.md) · [Deploy](docs/deploy.md) · [Commands & CLI](docs/cli.md) · [Menu](docs/menu.md) · [Reminders](docs/reminders.md) · [Extending](docs/extending.md) · [Plugins](docs/plugins.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)

Документация на русском → [docs/ru/](docs/ru/)

## What's New

<details>
<summary><b>v0.4.12 · 05.10.2026 — expand the latest releases</b></summary>

### 05.10.2026

#### v0.4.12

- 👀 **Iva tells you what you missed**: once an hour code checks unread private chats, mentions in Telegram and Gmail without newsletters; the model wakes only for something new and sends one message per item with buttons «To tasks», «Remind later», «Mute this one». Quiet hours at night, at most 5 messages a day, one toggle «Writes on her own» in `/menu` → Notices.
- ☀️ **The Brief replaces the morning digest**: at 08:30 and 14:00 Iva sends an overview of tasks, calendar, mail, Telegram, connections and plugins. Change the time with a phrase («brief at 9»); `/digest` returns the same overview.
- 🚨 **Failed jobs reach you with the cause and a Fix button**: user timers and plugin services are checked hourly; Iva's own failed jobs are explained instead of silently self-fixed and come first in the morning Brief. `iva signal <source> <text>` lets any local script hand Iva a message.
- 🧩 **Iva writes her own plugins**: say «make a plugin that…». A plugin of skills and scripts she installs herself; one with code or MCP she only proposes, and it is installed after you tap Install in a private chat.
- 🗜 **A long conversation is compacted between turns, not in the middle of an answer**: after a turn that reached 60% of the model window or 275k tokens, Iva compacts the conversation while nobody waits. A message sent meanwhile gets «Compacting the conversation, I'll answer in a moment.» and its answer right after.
- 🧹 **Iva no longer asks you to press /new**: the «context window is N% full» line is gone; `/new` works as before.
- 🎬 **Video, audio and files are handled by Iva herself, and she sees an image on disk**: the model gets facts about an attachment instead of orders not to touch it, and `read_file` on an image returns its description from the vision model.

### 03.10.2026

#### v0.4.11

- 🌙 **Nightly memory works on a ChatGPT subscription again**: the night call now streams on every provider. Since 0.4.9 the subscription backend answered 400 on the first call of every night. The night's own low reasoning effort is no longer overridden by the chat default.
- 🗂️ **A vault `.gitignore` no longer stops the night**: files the owner excludes are skipped and named in the log, the rest is committed and the day closes. Ignored files stay on disk, outside the backup.
- 🔁 **A short provider failure no longer fails the turn**: before the answer starts, Iva makes up to three attempts with 5 and 15 second waits and honours `Retry-After`. An opened stream or an executed tool is never replayed.
- 🤖 **`gpt-6.1-sol` in the ChatGPT subscription list**: Iva identifies as Codex client 0.159.2, so `/model` and `iva config` show the new model.
- 📅 **Task deadlines are stored as dates**: "tomorrow" becomes `YYYY-MM-DD` in the owner's timezone before it is saved, and a deadline can be corrected with `update`. Old deadlines written as words stay as they are.
- 🔧 **Google CLI updates without root**: `iva update` installs and refreshes `gws` under the service user's `~/.local`. Google sign-in and settings stay as they are.
- ⏰ **The nightly memory time is configurable**: `MEMORY_NIGHT_TIME=HH:mm` in `.env`, 04:00 by default. It takes effect after `iva update --force`.
- 🔀 **OpenCode Go models over Responses**: `OPENCODE_PROTOCOL=responses` in `.env` switches the Go text wire, with the same key and model settings. chat/completions stays the default.
- 📝 **The nightly Report reads like a note**: 2–5 plain lines in the owner's language, built by code from the night's results. The Report is still off by default.
- 🃏 **A Card status on the owner's word**: "the project is closed" sets the Card status at once through `write_card`, and the night of that day keeps it.

### 29.09.2026

#### v0.4.10

- 🚑 **A tool name from Claude no longer fails the turn**: an Iva tool runs only under its exact or `mcp__iva__` name, with no guessing by case, dash or another prefix. Any other name, Claude's own `Bash` and `Read` included, returns a tool error listing the available tools, and the model goes on in the same turn.
- 🔌 **Unparsable tool arguments on Claude no longer fail the turn**: arguments that are not JSON reach eve as sent, the model gets an input error and corrects the call in the same turn. A stream cut before the end of the message still fails.
- ♻️ **A restart mid-reply no longer blocks the next messages**: on the next start Iva moves the interrupted workflow state to quarantine, Bridge closes the broken turn with one line and drains the saved queue, and `/new` answers without `iva reset`. A second start in a row leaves the workflow state alone, and a failed recovery is one journal line that does not keep Iva down.
- 🔎 **File search no longer hangs the turn**: one `grep` or `glob` call stops after 20 seconds, 20 000 files or when the turn is stopped, and returns what it found with a hint to narrow the path. `node_modules`, `.git` and `*.trash-*` quarantines are skipped.
- 🧠 **Sonnet 5.5 takes the place of Sonnet 5 on Claude**: the model screen and setup offer Fable 5.1, Opus 5.5 and Sonnet 5.5 and write `claude-sonnet-5-5` to `.env`. A Claude Code that does not know Sonnet 5.5 yet keeps Sonnet 5 on the same button, and `claude-sonnet-5` in `.env` still works. The OpenRouter list offers `anthropic/claude-sonnet-5.5`.

</details>

Full history — [CHANGELOG.md](CHANGELOG.md).

## Built on

[eve](https://eve.dev/docs/introduction) 0.51.1, Vercel's agent framework, runs the agent; Node 24's built-in SQLite runs the search index — no separate database. Iva grew out of [agent-second-brain](https://github.com/smixs/agent-second-brain) and [autograph](https://github.com/smixs/autograph) — that story is in [docs/memory.md](docs/memory.md).

## Thanks

Iva gets better because people run it for real — contributors are welcome. [Open an issue](https://github.com/smixs/iva-agent/issues) with what breaks, or send a PR. Everyone who already helped: [docs/thanks.md](docs/thanks.md).

## License

[MIT](LICENSE) — take it, change it, run it on a hundred servers; just don't blame anyone if something breaks.
