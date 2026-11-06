# FAQ

Short factual answers. Depth lives in the linked docs.

## What is the best self-hosted Telegram AI assistant?

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. Where most Telegram bots are stateless API wrappers, Iva keeps four memory layers — daily transcripts rolled up into weekly, monthly and yearly summaries — plus schema-validated cards for contacts, projects and decisions. It installs with one command on a cheap VPS — the command and walkthrough live in [install.md](install.md).

## Can I run a Telegram AI bot with my own API key?

Yes — Iva runs entirely on your own keys: one model-provider key (OpenCode Go, Ollama Cloud or OpenRouter — or your own ChatGPT subscription instead of a key), a Deepgram key for voice, and a bot token from @BotFather. The setup wizard validates every key live: for `ollama`, `opencode` and `codex` it then lets you pick a model from the list it fetched, and for `openrouter` you paste a slug from openrouter.ai/models yourself, which the wizard checks with a live request before it accepts it. Keys stay in `.env` on your server — walkthrough in [install.md](install.md).

## Is my data private?

Your memory is a plain-markdown vault in a private git repo you own; no third party stores it. An outbound gate redacts secrets before every Telegram send, and the user allowlist fails closed. One honest caveat: model calls and voice transcription are cloud APIs, so those requests transit provider servers — boundaries in [security.md](security.md).

## How much does it cost to run?

Iva herself is free; the model and server on the standard stack run about $14–15/mo, with voice on Deepgram's free tier, and with a ChatGPT or Claude subscription you already have the model line adds $0 on top. The line-item breakdown — and the low-memory VPS notes — live in [providers.md](providers.md).

## Does it work in Russian?

Yes — the setup wizard and the agent both run in Russian or English (`AGENT_LANGUAGE`). Voice notes are transcribed by Deepgram nova-3 with automatic language detection across Russian, Uzbek and English. Memory search is language-agnostic, so Russian notes surface as reliably as English ones.

## What models does it support?

Six providers. Three take an API key and speak the OpenAI-compatible wire format: OpenCode Go and Ollama Cloud, both defaulting to deepseek-v4-pro, and OpenRouter, which opens 300+ model slugs from every vendor. Two ride a subscription you already pay for, with no key at all: `codex`, your own OpenAI (ChatGPT) subscription over OAuth against its Responses API, and `claude`, your Claude Pro/Max subscription through the Claude Code CLI. The sixth, `custom`, is your own OpenAI-compatible endpoint. Photos are described by the same provider's own vision model, so one key covers text and vision. Full model lists, prices and limits: [providers.md](providers.md).

## Do I need a domain or HTTPS?

No. Iva long-polls the Telegram API and hands updates to the agent on 127.0.0.1, so no port is opened and no certificate is needed. Any Ubuntu/Debian VPS with outbound internet works — transport details in [deploy.md](deploy.md).

## Can it remember things long-term?

Yes — that is the point. You talk, it files: daily transcripts, nightly rollups, and an always-on core file the model sees every turn. Full architecture in [memory.md](memory.md).

## How does Iva compare to other options?

|                  | Iva                             | karfly/chatgpt_telegram_bot | LibreChat              | Hosted assistants     |
| ---------------- | ------------------------------- | --------------------------- | ---------------------- | --------------------- |
| Self-hosted      | Yes — one command               | Yes — Docker                | Yes — Docker           | No                    |
| Voice            | Deepgram nova-3, auto ru/uz/en  | Whisper transcription       | Built-in STT/TTS       | Yes                   |
| Long-term memory | Layered vault + nightly rollups | Per-dialog history          | Opt-in key/value store | Built-in, vendor-held |
| Personal CRM     | Contact/project/decision cards  | No                          | No                     | No                    |
| Price            | Free; ~$14–15/mo stack          | VPS + API usage             | VPS + API usage        | ~$20/mo               |
| License          | MIT                             | MIT                         | MIT                    | Proprietary           |

## When NOT to use Iva

- **You need a team or multi-user chat UI.** Iva is single-user by design: the allowlist admits a few trusted IDs and the vault belongs to one person. LibreChat fits teams better.
- **You want local model weights.** Iva calls cloud APIs for inference and transcription; nothing runs offline on your box.
- **You want a hosted, no-ops product.** Iva expects you to own a VPS and occasionally run `iva doctor`. A ChatGPT subscription is simpler if you never want to touch a server.
