# Providers & cost

Iva runs on your server with your keys. Here is every external service it talks to, with real prices: one paid model subscription, one paid box — everything else fits a free tier. Total: about $9/mo. A subscription you already pay for (ChatGPT Plus/Pro, Claude Pro/Max) works too — then the model line costs nothing extra.

## Model providers

| Provider                          | Price                        | Text models                                                                                                                                      | Vision                                                             |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **OpenCode Go** (ex-Zen)          | ~$5/mo                       | ~23 models fetched live at setup — `deepseek-v4-pro` (default), `kimi-k3`, `kimi-k2.7-code`, `glm-5.2`, `minimax-m3`, `qwen3.7-max`, `grok-4.5`… | `qwen3.7-plus`, override with `OPENCODE_VISION_MODEL`              |
| **Ollama Cloud**                  | ~$20/mo                      | ~19 models fetched live — `deepseek-v4-pro` (default), `kimi-k3`, `glm-5.2`, `minimax-m3`, `gpt-oss:120b`…                                       | `gemma4:31b`, override with `OLLAMA_VISION_MODEL`                  |
| **OpenRouter**                    | pay-as-you-go                | 300+ models across vendors — pick any slug (`vendor/model`)                                                                                      | `google/gemini-2.5-flash`, override with `OPENROUTER_VISION_MODEL` |
| **OpenAI (ChatGPT subscription)** | your existing Plus/Pro/Team  | the models your plan exposes (`gpt-6-sol`, `gpt-6-luna`, `gpt-5.x`), fetched live                                                                | same subscription (multimodal), no variable                        |
| **Claude (Pro/Max subscription)** | your existing Pro/Max plan   | Fable 5.1, Opus 5.5, Sonnet 5 (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`), the ones the plan's picker has                         | same subscription (multimodal), no variable                        |
| **Custom (OpenAI-compatible)**    | whatever your endpoint costs | whatever your endpoint serves — the wizard reads `GET {base}/models` when there is one, otherwise you type the id                                | the chat model itself, or a slug in `CUSTOM_VISION_MODEL`          |

The first three are plain API keys, `codex` and `claude` ride subscriptions you already pay for, and `custom` is an address you supply:

- 🔌 **OpenAI-compatible** — Go, Ollama and OpenRouter share the same wire format, so switching is one line in `.env`
- 🌍 **Any IP** — all answer from any server location, no region blocks
- 💸 **No markup** — you pay the provider directly; Iva adds nothing on top

```bash
MODEL_PROVIDER=opencode   # or ollama / openrouter / codex / claude / custom, then `iva restart`
```

Those six names, spelled exactly. Anything else — `ollmaa`, `OLLAMA` — stops the agent at startup with the list of accepted names, instead of running Ollama under a name nobody configured ([troubleshooting.md](troubleshooting.md)).

OpenCode Go only serves clients that identify themselves: every request carries Iva's own `User-Agent` (`iva/<version>`) and a stable conversation id in `x-opencode-session` — the eve session id, or one id per process where there is no session (planner, vision). Without them Go answers `MissingSessionID` on every turn ([Go docs](https://opencode.ai/docs/go/#where-can-i-use-it)). Other providers get neither header.

Start with Go: a quarter of the price, ~23 models to switch between (the wizard pulls the live list, so new ones like `kimi-k3` appear on their own). Keys, model pick and context-window settings live in [configuration.md](configuration.md).

Two things about the live lists. Both catalogs churn — Ollama Cloud retired `gemma3:12b` on 2026-07-15 and Go dropped `gemini-3-flash`, so a hand-written model id in `.env` can start failing without you touching anything; if the bot goes quiet after weeks of silence on your side, re-run `iva config` and re-pick from the live list. And on Ollama Cloud the frontier tags (`kimi-k3` among them) bill as **extra usage** on top of the plan: with an empty extra-usage balance the API answers `402`, so top it up at [ollama.com/settings](https://ollama.com/settings) or stay on `deepseek-v4-pro`.

### OpenAI by ChatGPT subscription (`codex`)

Use the OpenAI subscription you already pay for — no separate API key, no per-token bill. Iva signs in the same way the official `codex` CLI does (OAuth against `auth.openai.com`), stores a refreshable token in `data/codex-auth.json` (chmod 600), and calls the subscription's Responses backend directly. The access token is refreshed automatically before it expires. If the backend rejects a still-fresh token after the subscription lapses, Iva forces one refresh and retries once; a second rejection tells you to run `iva login`.

```bash
iva login              # device code: opens a link + one-time code (works on a headless VPS)
iva login --browser    # PKCE flow: opens a browser on this machine
iva config             # pick the provider (option 3) and a model from your plan's live list
iva restart
```

Notes: the model list is pulled from your subscription at setup time, so you always see exactly what your plan allows. Set `CODEX_CONTEXT_WINDOW` to the real window of the model you picked (compaction derives its threshold from it). Routing a self-hosted assistant through the ChatGPT subscription backend is a grey area under OpenAI's terms — you are using your own subscription on your own server, but weigh that yourself.

### Claude by Pro/Max subscription (`claude`)

Use the Claude subscription you already pay for — no API key, no per-token bill, nothing to paste into `.env`. Iva calls the `claude` CLI (Claude Code) installed and signed in on the same server, so the CLI's own login is what pays for the requests.

```bash
npm install -g --prefix ~/.local @anthropic-ai/claude-code   # as the service user, no root: lands in ~/.local/bin
claude auth login      # one sign-in on the server (a link + code)
iva config             # pick the provider (option 4) and a model from the subscription's live list
iva restart
```

Notes: the screen offers three models — Fable 5.1, Opus 5.5 and Sonnet 5 — and only those the CLI picker actually has. `.env` stores the canonical id (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`), never a picker alias. `claude auth status` names the plan, and `iva doctor` prints it next to the model. Requests are billed by the CLI — they count as `claude -p` (Agent SDK) usage on your plan. `CLAUDE_CONTEXT_WINDOW` for these three is 1000000. The service's `PATH` is the node directory, then `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`; `iva doctor` looks for `claude` on that same `PATH`, not on your shell's. If the CLI lives elsewhere, point `CLAUDE_COMMAND` at the binary. `/model` → Claude checks the CLI and repeats the check after you sign in there.

### OpenRouter (`openrouter`)

One key for [300+ models](https://openrouter.ai/models) (Anthropic, OpenAI, Google, DeepSeek, Meta…), billed pay-as-you-go. Too many to list, so setup takes the model **slug** from you:

1. Key at [openrouter.ai/keys](https://openrouter.ai/keys) (`sk-or-…`).
2. Copy a slug from [openrouter.ai/models](https://openrouter.ai/models) — the `vendor/model` id under the name (e.g. `anthropic/claude-sonnet-4.5`). The model must support **tool/function calling**: Iva sends tools every turn, so chat-only or image models won't work.
3. `iva config` → provider `4` → paste the key, then the slug. Setup fires a live test **with a tool call** and continues only once the model answers — a mistyped slug or a no-tools model is rejected on the spot, not later as a silent bot.

Set `OPENROUTER_CONTEXT_WINDOW` to the model's real window. Vision runs through `google/gemini-2.5-flash` regardless of your text model (billed to your OpenRouter credit); `OPENROUTER_VISION_MODEL` takes any other image-capable slug.

### Your own OpenAI-compatible endpoint (`custom`)

Anything that speaks OpenAI `chat/completions` and you can reach: your own proxy, a vendor plan sold as an OpenAI-compatible key, vLLM, LiteLLM, a llama.cpp server on the same box. Before this existed the only way in was patching the provider table, and every `iva update` threw the patch away — now it is four lines of `.env` and nothing in the tree.

```bash
MODEL_PROVIDER=custom
CUSTOM_BASE_URL=https://api.example.com/v1   # the base IN FULL, /v1 suffix included
CUSTOM_API_KEY=sk-whatever-your-vendor-issues   # optional — leave empty for a keyless endpoint
CUSTOM_MODEL=vendor-model-name
CUSTOM_CONTEXT_WINDOW=131072                 # the real window of that model
iva restart
```

The address convention is Ollama's: `https://ollama.com/v1`, not `https://ollama.com`. Iva appends `/chat/completions` and `/models` to what you wrote, so the `/v1`-style suffix belongs in the variable. `iva config` and the `/model` wizard both take it as text and refuse anything that is not a full `http(s)` address — a scheme-less `api.example.com/v1` would otherwise fail later as a fake network error.

Nothing about this endpoint is guessed. `CUSTOM_BASE_URL` and `CUSTOM_MODEL` have no defaults, and a blank one stops the agent at startup naming the variable — Iva will not borrow another provider's model or invent a host. `CUSTOM_API_KEY` is the exception: leave it empty and no `Authorization` header is sent at all, which is what a self-hosted server usually wants; `iva doctor` does not count it as missing.

Model selection follows whatever the endpoint offers. The wizard asks `GET {base}/models` first and shows the live list as buttons; endpoints that don't implement it (the OpenAI-compatible contract doesn't require it) fall through to typing the model id yourself, and that id is accepted as-is. A `401`/`403` is still a refusal — a wrong key does not become a "typed id".

Two deliberate omissions. `THINKING_EFFORT` is not sent to `custom`: `reasoning_effort` is not part of what OpenAI compatibility guarantees, and a blind extra field risks an HTTP 400 on every turn — pick `ollama`, `opencode` or `codex` if you want adjustable thinking. And the outbound security gate has no pattern for `CUSTOM_API_KEY`'s shape, because an arbitrary vendor's key has none; it is redacted by its name like every other prefixless key ([security.md](security.md)).

A local example, keyless:

```bash
MODEL_PROVIDER=custom
CUSTOM_BASE_URL=http://127.0.0.1:8000/v1
CUSTOM_API_KEY=
CUSTOM_MODEL=Qwen/Qwen3-32B-Instruct
CUSTOM_CONTEXT_WINDOW=32768
```

A hosted example, [NeuralDeep](https://hub.neuraldeep.ru): an OpenAI-compatible endpoint billed in roubles and reachable from Russia without a VPN. `qwen3.6-35b-a3b` calls tools and reads images, so `CUSTOM_VISION_MODEL` stays empty:

```bash
MODEL_PROVIDER=custom
CUSTOM_BASE_URL=https://api.neuraldeep.ru/v1
CUSTOM_API_KEY=sk-...                        # from hub.neuraldeep.ru/app
CUSTOM_MODEL=qwen3.6-35b-a3b
CUSTOM_CONTEXT_WINDOW=262144
```

## Vision

Attachments are never inlined into the model request. A photo lands in the vault, the agent gets its file path, and the provider's own vision model writes the description — OCR plus visual detail — into the daily transcript. Same key as the text model, no extra subscription. Each provider's default is a `*_VISION_MODEL` line in `.env` and a step in `iva config`; `custom` has no default there, so an endpoint whose chat model reads images needs nothing, and one whose model doesn't needs a `CUSTOM_VISION_MODEL` and a `CUSTOM_API_KEY` to call it with. Being on a provider's model list is not the same as reading images: on Go the default is `qwen3.7-plus`, and several of the larger models there refuse a picture outright.

## VPS sizing

Any Ubuntu/Debian box for $4–5/mo. 512MB RAM works — the installer handles low-memory boxes ([install.md](install.md)). More than 1–2GB buys you little: the model runs in the cloud, not on your box.

## Voice — Deepgram

Transcription runs on Deepgram `nova-3` with `language=multi`: Russian, Uzbek and English are detected automatically, even mixed inside one voice note. A new account comes with a free starter credit — no card — that covers months of personal use. The one hard limit is Telegram's, not Deepgram's: the Bot API refuses downloads over 20MB, so a long video won't transcribe.

## Web search

| Provider                 | Free tier          | Card         |
| ------------------------ | ------------------ | ------------ |
| **tavily** (recommended) | ~1,000 searches/mo | not required |
| **exa**                  | ~20,000/mo         | not required |
| **parallel**             | starter credits    | not required |
| **brave**                | ~$5/mo credit      | required     |

Pick one, set `SEARCH_PROVIDER` and its key. No key means no web search — Iva says so instead of guessing. DuckDuckGo scraping was removed on purpose: server IPs get captchas, and a search tool that randomly hits a wall is worse than none.

Optional hybrid memory search adds one more key (Jina or DeepInfra embeddings) — covered in [memory.md](memory.md).

## Total cost

| Service             | Monthly             |
| ------------------- | ------------------- |
| VPS                 | $4–5                |
| OpenCode Go         | ~$5                 |
| Deepgram voice      | $0 — starter credit |
| Web search (tavily) | $0 — free tier      |
| **Total**           | **~$9/mo**          |

Prefer Ollama Cloud and the same stack lands around $25/mo. Either way the bill is flat, predictable, and paid straight to the providers.
