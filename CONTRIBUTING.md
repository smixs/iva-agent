# Contributing to Iva

Iva gets better because people run it on real servers with real messages. A bug report
from an actual install is worth more than a drive-by PR, so start wherever you are.

## Reporting a bug

Open an [issue](https://github.com/smixs/iva-agent/issues/new/choose) and include the version
(`iva version`), how you installed, and what you expected instead. If it involves a
message the assistant handled, `iva logs poll` (the Telegram bridge) usually contains the
answer and logs no message text. The agent log, `iva logs`, can carry your memory and the
message itself when a provider call fails — read it locally, don't paste it into an issue.

Security problems do not go in issues. See [SECURITY.md](SECURITY.md).

## Before you write code

Read [docs/philosophy.md](docs/philosophy.md). The recurring answer in this codebase is
that a new behaviour should be a skill (a markdown file the agent reads), not a new
mechanism in TypeScript. A PR that adds a subsystem where a skill would do gets sent
back, and that is not a comment on the code.

[AGENTS.md](AGENTS.md) is the working contract: layout, the `#*` import alias, the
review rules that also apply to humans — secrets never land in tracked files, auth
checks only ever get narrower, user data stays out of the repo, and anything under
`agent/` needs a rebuild before it does anything.

## Local setup

Node 24 is required — the project uses the built-in SQLite and native TypeScript
loading.

```bash
git clone https://github.com/smixs/iva-agent.git ~/iva && cd ~/iva
npm install
cp .env.example .env && chmod 600 .env   # fill in a bot token and one model provider
npm run build                            # eve build — needed after every agent/ change
npm start                                # the agent
npm run poll                             # second terminal: the Telegram bridge
```

`npm run dev` runs the agent with reload. `npm start` does **not** rebuild, so if a
change under `agent/` seems to do nothing, you skipped `npm run build`.

## What you check before you push

There is no CI. The project is local-first by decision
([ADR-0004](docs/adr/0004-philosophy-is-the-review-bar.md)): no GitHub Actions, no
merge checks, no review bots — `.github/` holds issue templates and nothing else.
Whatever a build server would have caught, you catch on your own machine, and the review
reads the diff against [CONTEXT.md](CONTEXT.md) — the glossary, whose _Avoid_ lists bind
code and docs alike — plus [docs/philosophy.md](docs/philosophy.md) and `docs/adr/`.

These four catch most of it:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

Run the rest when your change reaches them: `npm run build`, the coverage floors
(`npm run test:coverage` — lines 75, branches 77, functions 71; they may rise, they do
not fall), `npm run replica` (installs Iva from scratch against a mock provider),
and the userbot's Python suites. They import their neighbouring modules, so
they run from `services/telegram-userbot/` — `test_health.py` and `test_session_path.py` need
nothing installed, `test_guardrails.py` imports `telethon` and needs a virtualenv built
from `requirements.lock`.

If you touch `services/telegram-userbot/requirements.in`, regenerate the hash-locked file
in the same change:

```bash
uv pip compile services/telegram-userbot/requirements.in \
  --output-file services/telegram-userbot/requirements.lock \
  --python-version 3.12 --python-platform x86_64-unknown-linux-gnu \
  --exclude-newer 2026-07-28T00:00:00Z --generate-hashes
```

New Node source and tests are TypeScript. The only `.mjs` files in the tree are five
logic-free entry shims; do not add a sixth.

## Pull requests

A PR is read and merged by a human who runs the checks above on their own machine —
nothing runs automatically when you open it, and no bot will tell you what broke. Say in
the PR which checks you ran and what they said.

- One change per PR. A rename, a refactor and a feature in one diff cannot be reviewed.
- When the documentation and existing code conflict, follow the code's conventions, and in your final reply, list all the inconsistencies you found.
- Commit messages describe the code change and nothing else — no AI or tool
  attribution, no "generated with" footers.
- Tests come with the change. Bug fixes get a test that fails without the fix.
- Parsers, validators, resolvers and state invariants are tested property-based
  (fast-check): generators explore the input space, a failure prints its seed, the
  seed replays the failure. Example tests stay as contract anchors.
- Touching the update path (`iva update`, `data/settings.json`, anything persisted)?
  Say in the PR how an older install upgrades. Self-hosters arrive from arbitrary old
  versions, and the update runs under the _previous_ CLI.
- Docs live in `docs/`. A user-visible change that is not documented is unfinished.

## Adding a skill or an MCP server

Most useful contributions are one file. `agent/skills/<name>.md` describes a procedure
in prose; the agent picks it up without any code change. MCP servers are wired through
config with keys in `.env`. See [docs/extending.md](docs/extending.md).

## Translations

The README ships in both languages; `docs/ru/` covers the core pages (install,
configuration, memory, security, use cases, FAQ) and the rest is English-only. If you
change a page that exists in both, change both — or say plainly in the PR that the other
one still needs doing. A stale translation is worse than an obvious gap.
