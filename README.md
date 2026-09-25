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
- **Tasks & reminders** — priorities, due dates and a morning digest.
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

Seven model providers. Pick one and fill its block in `.env`:

| Provider         | How you pay                            |
| ---------------- | -------------------------------------- |
| OpenCode Go      | API key, ~$10/mo ($5 first month)      |
| Ollama Cloud     | API key, ~$20/mo                       |
| OpenRouter       | API key, pay-as-you-go, 300+ models    |
| OpenAI (ChatGPT) | your Plus/Pro subscription, no API key |
| Claude (Pro/Max) | your Pro/Max subscription, no API key  |
| Custom           | your own OpenAI-compatible endpoint    |
| Requesty         | API key, pay-as-you-go, 700+ models    |

Default model is deepseek-v4-pro, 131k context. On Go it runs about $14–15/mo all-in ($10 model + $4–5 VPS; the model's first month is $5), no markup; voice rides Deepgram's free starter credit. Model lists, limits and the search matrix: [docs/providers.md](docs/providers.md).

## Documentation

[Use cases](docs/use-cases.md) · [Install](docs/install.md) · [Configuration](docs/configuration.md) · [Memory](docs/memory.md) · [Providers](docs/providers.md) · [Security](docs/security.md) · [Deploy](docs/deploy.md) · [Commands & CLI](docs/cli.md) · [Menu](docs/menu.md) · [Reminders](docs/reminders.md) · [Extending](docs/extending.md) · [Plugins](docs/plugins.md) · [FAQ](docs/faq.md) · [Troubleshooting](docs/troubleshooting.md)

Документация на русском → [docs/ru/](docs/ru/)

## What's New

<details>
<summary><b>v0.4.8 · 24.09.2026 — expand the latest releases</b></summary>

### 24.09.2026

#### v0.4.8

- 📎 **Iva sends files to the chat again**: since 0.4.1 the bash guard blocked `curl` to api.telegram.org, and when asked for a DOCX or a PDF, Iva answered that she could not send an attachment. The new `send_file` tool sends a file from the vault or the temp folder as a document to the chat and topic where it was asked for; `.env`, `data/` and anything outside those folders stay home, even through a symlink.
- 🔁 **Iva no longer repeats one broken call hundreds of times**: after three identical tool errors in a row, or eight errors of one tool with different arguments, the turn ends with a short explanation; a successful call resets the count. A busy background agent is not polled in circles either: `AGENT_BUSY` now names the next step (#241).
- 💾 **Fewer tokens paid twice**: Codex requests carry a cache key tied to the session, so each step of a dialogue reads the previous one from cache. Claude keeps the system prompt and its working folder the same between steps and reads the history from the prompt cache (#236). `glob` returns at most 1000 paths and names the rest, instead of 43584 paths in one call. Token accounting now also counts compaction and vision.
- 🧭 **Reminder and card refusals say what to fix**: `remind` used to answer "give exactly one of at or cron" without naming the field, and the model tried placeholders dozens of times in a row. Now a refusal names the fields that came, what was expected and ends with one ready call for the case; `write_card` refusals carry a sample call too.
- ⛔ **A background turn at the eve session limit no longer passes for done**: a reminder, a wake-up after a schedule or `iva remind` that hit the session token limit used to send a stale intermediate text as the result. Now the turn fails with the cause, and a reminder sends its own text with a note that it was not done.
- 🔑 **Google Workspace connects from the menu again**: gws 0.22.5 prints `redirect_uri` URL-encoded, so the menu found no port in it, waited for the timeout and blamed client_secret. Now the port is read from both the encoded and the raw form.
- 🌙 **A failed nightly summary continues the day instead of starting over**: a big day is processed in parts with a mark in the raw day, the next run resumes from the last mark, and `rollup.ts daily` catches up unprocessed days of the last week. The nightly run reaches its files again: `read_file`, `grep` and `glob` accept `vault/daily/…` from the project root (#242), and Claude no longer stays silent for 90 seconds while it thinks and calls a tool (#239).
- 📦 **A token usage package in one command**: `curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/diagnose-usage.sh | bash` collects three days of per-step tokens, the skeleton of each turn and failure lines, with the heaviest turns on top. Conversation text, tool inputs and outputs and `.env` values other than the model settings stay out; the package arrives as a file in the bot chat.

### 23.09.2026

#### v0.4.7

- 🧠 **Opus 5.5 replaces Opus 5 on the Claude model screen**: `/model` → Claude offers Fable 5.1, Opus 5.5 and Sonnet 5 and writes `claude-opus-5-5` to `.env`; the short name `opus` now means Opus 5.5, and an old `claude-opus-5` in `.env` keeps working.
- 🤖 **GPT-6 Sol and Luna on the OpenAI subscription**: Iva asks for the subscription's models as codex client 0.156.0, so the screen shows `gpt-6-sol` and `gpt-6-luna`, which the backend hides from older clients. The effort from `/think` reaches them too: the SDK used to drop it silently for a model id it did not know.
- 🔕 **The "Working" status and /update messages arrive without a sound**: technical lines no longer buzz the phone. The model can send a whole reply quietly too, with `<!-- iva:silent -->` on its first line, for low-urgency news or when the owner's rules ask for it (#232, thanks @yakovmakovets).
- ⏰ **A schedule that succeeded no longer wakes the model**: a successful run is recorded by code and ends there, without a model turn and without a technical message in the chat; a turn that explains what happened is left for failures only (#233, thanks @yakovmakovets).
- 🔗 **Links to nowhere are refused at write time**: `write_card` and `write_file` refuse a markdown file inside the vault whose `[[link]]` points at no file and name the broken targets; weekly, monthly and yearly Rollups link only summaries that exist (#224, thanks @AndyShaman).
- 📎 **An attachment of any format is not a broken link**: the nightly graph check accepts a link to `attachments/…` with any extension, DOCX included, as long as it is a regular file inside the vault (#229, thanks @yakovmakovets).
- 🔎 **Glob and grep see the vault through a symlink**: relative `cwd` and `path` start at the vault root, as `read_file` does, and the walk follows symlinked folders without visiting the same real folder twice.

### 22.09.2026

#### v0.4.6

- 🪪 **Claude on a Pro/Max subscription: no key, through the Claude Code CLI, default claude-fable-5-1**: the sixth vendor is `MODEL_PROVIDER=claude`. Iva calls the Claude Code CLI already installed and signed in on the same server and uses it as the model, so tools, memory, reminders, compaction and `/stop` stay hers. The model list comes live from the CLI and shows exactly what the subscription opens.
- ⏹ **Stop kills the work at once and always gets there**: a stop kills the whole process group immediately, not only the talk with the model, and the button and `/stop` no longer answer "nothing is running" to a turn that has gone quiet. "Stopped" is written only after the agent has confirmed it.
- ⏳ **The turn status is a loader and a ⏹ button on one line**: in the rich style the word "Working" is gone. The line is the loader, and the ⏹ button sits in that same line. The classic style still keeps the button on its own row under the line, because a plain message cannot hold the button inside the text.
- 🔘 **The root /menu has no captions, only buttons**: the line under each button that said what it does is gone. The root screen is the title and the button rows.
- 🔌 **A tool call with no arguments no longer drops the turn**: on Claude, a tool call streamed with an empty argument payload used to fail JSON parsing, so the answer looked unfinished and the turn was retried. Empty arguments are now an empty object, and the answer counts as whole.

</details>

Full history — [CHANGELOG.md](CHANGELOG.md).

## Built on

[eve](https://eve.dev/docs/introduction) 0.51.1, Vercel's agent framework, runs the agent; Node 24's built-in SQLite runs the search index — no separate database. Iva grew out of [agent-second-brain](https://github.com/smixs/agent-second-brain) and [autograph](https://github.com/smixs/autograph) — that story is in [docs/memory.md](docs/memory.md).

## Thanks

Iva gets better because people run it for real — contributors are welcome. [Open an issue](https://github.com/smixs/iva-agent/issues) with what breaks, or send a PR. Everyone who already helped: [docs/thanks.md](docs/thanks.md).

## License

[MIT](LICENSE) — take it, change it, run it on a hundred servers; just don't blame anyone if something breaks.
