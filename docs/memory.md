# Memory

Memory is the part that compounds. Most agents forget you the moment the context window fills — 131k tokens goes fast. Iva files everything into a plain-markdown vault, reorganizes it while you sleep, and pulls back only what each question needs. You talk, it files.

![How Iva remembers: a leaf is a day, branches are weeks and months, tree rings are years around CORE.md](../assets/iva-memory-tree.webp)

## The memory tree

_Iva_ means _willow_, and the memory is shaped like one:

| Layer       | What lives there                                                                                    | Path                                                 |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 🍃 Leaves   | the word-for-word transcript of each day, Iva's replies included                                    | `daily/YYYY-MM-DD.md`                                |
| 🌿 Branches | summaries folded upward: day → week → month → year                                                  | `summaries/daily/`, `weekly/`, `monthly/`, `yearly/` |
| 🪵 Trunk    | `CORE.md` (≤1200 chars, in every prompt) + typed cards: contacts, projects, decisions, ideas, notes | `CORE.md`, `cards/`                                  |

CORE.md rides in every system prompt; everything else comes in per question through ranked search. A weekly summary costs about 1/35th of its seven raw days, so recall stays cheap as the vault grows.

## Nightly rollup

One script, four in-process eve schedules, configured local time. `scripts/memory/rollup.ts` drives the running agent through `eve/client`:

| Schedule | When         | Reads                      | Writes                        |
| -------- | ------------ | -------------------------- | ----------------------------- |
| daily    | 04:00        | yesterday's raw transcript | cards, daily summary, CORE.md |
| weekly   | Mon 04:15    | 7 daily summaries          | weekly summary                |
| monthly  | 1st, 04:20   | the month's weeklies       | monthly summary               |
| yearly   | Jan 1, 04:25 | the year's monthlies       | yearly summary                |

Every run is silent by default: the vault is written, the chat stays quiet. Daily and weekly runs can post a report to Telegram — switch it on in `/menu` → **🔔 Notices** → _Memory reports_ (`memoryReports.enabled` in `data/settings.json`, read at the end of each nightly run, so a tap applies the same night with no restart). Monthly and yearly are always silent. When the report is on, it comes as one short human note in your interface language — what Iva remembered, in 3–5 lines, with no internal terms. Why off by default: [ADR-0007](adr/0007-notices-are-opt-in.md).

The daily pass extracts entities through `write_card` — a tool whose type and status enums come from the vault's `schema.json`, so the model cannot invent card types. Every fact gets one operation:

- ➕ **ADD** — a new card. If that card already exists, the call is refused: an existing subject is UPDATE or SUPERSEDE territory.
- ✏️ **UPDATE** — a new fact that does not contradict the card's Compiled Truth (its frontmatter plus the top of its description); it lands as a line in the card's `## Log`.
- 🔁 **SUPERSEDE** — the fact contradicts the Compiled Truth: the card is rewritten to the new fact and the displaced one moves to an append-only `## History` as a dated line (`- 2026-07-31: TDI Group (held 2026-03→06)`). The date is the fact's own, not the day of writing; an entry that arrives without one is stamped with the write date.
- ⏭️ **NOOP** — already known, nothing written.

Any of them is refused when a `[[wikilink]]` in the card points at a file the vault does not have: a link to a card nobody created reads as a topic Iva knows, and the nightly graph pass cannot repair it. The rollup prompts carry the same rule downwards — the weekly, monthly and yearly runs receive the list of summaries that actually exist, and a period without one is named in plain text instead of linked.

Facts carry a `confidence:` tag — `EXTRACTED` (you said it) or `INFERRED` (Iva deduced it) — so later answers assert the first and hedge the second. Decisions are the payoff: a decision card holds what you chose, when and why, and its History records every reversal with dates. You always see what is true now, plus the trail of how it got there.

The same pass resolves conflicts flagged in `.graph/supersede-candidates.json` and rewrites CORE.md: durable facts, standing preferences, at most 3 active goals — plus dated behavioral lessons from exchanges you corrected, so a mistake made twice doesn't become a habit.

## Search

`memory_search` runs on Node 24's built-in `node:sqlite`: BM25 over an FTS5 full-text index. Zero external dependencies — no vector database, no search server, nothing extra on a $5 VPS. Hits are reranked by link distance in `.graph/vault-graph.json` — cards that reference each other surface together — and weighted by IDF coverage, so ranking stays language-agnostic: Russian, Uzbek and English all work.

For fuzzy or cross-language semantics, switch on hybrid mode (`MEMORY_SEARCH_MODE=hybrid` plus one embedding key — every variable in [configuration.md](configuration.md)). Dense results are fused with BM25 via reciprocal rank fusion; the nightly Brain pass rebuilds the embedding sidecar.

## Brain

At 05:00 `scripts/memory/brain.ts` runs mechanical maintenance — no LLM, all deterministic — executing the [autograph](https://github.com/smixs/autograph) scripts from `scripts/autograph/` via `uv`:

1. `enforce` — schema backstop: coerces type aliases, fixes invalid statuses, backfills system fields on cards written outside `write_card`
2. `graph.health` — rebuilds the link graph, appends a 0–100 health score to history
3. `decay` — updates relevance tiers so stale cards sink
4. `moc.generate` — regenerates the MOC topic indexes
5. `supersede`, `dedup`, `link_cleanup` — dry-run scans; findings queue for the next rollup, never auto-applied

Then it commits and pushes the vault. No remote yet? It creates a private `iva-vault` GitHub repo through `gh`. It pings you on Telegram only when a human is needed: a failed maintenance step, a health-score drop, CORE.md past its 1200-char cap, or a failed push (including when there's no remote and `gh` isn't logged in). Those pings are Alerts — they cannot be switched off, so each one names what broke, what it costs and the command that fixes it, in your language, and repeats at most once a week for the same problem ([ADR-0007](adr/0007-notices-are-opt-in.md)).

## Vault layout

The vault is initialized from `vault-template/` as its own private git repo, separate from the Iva checkout:

```text
vault/
├── CORE.md          # always-on core
├── PERSONA.md       # ≤800-char speaking style, written by the /menu test, read every turn
├── MOC.md           # topic index, regenerated nightly
├── cards/           # contacts/ projects/ decisions/ ideas/ notes/
├── daily/           # raw transcripts, one per day
├── summaries/daily/ # day summaries
├── weekly/ monthly/ yearly/
├── attachments/     # originals, by date
├── schema.json      # the vault schema — types, domains, decay
└── .graph/          # machine-owned graph + scan results
```

The vault is pure data: the maintenance code and the processing prompts live in the Iva repo (`scripts/autograph/`, `scripts/memory/instructions/`), so an update ships them to every install at once. Vaults created before 0.3.3 also carry a legacy `.claude/` folder — dead weight, no longer read, safe to keep or delete.

Everything is plain markdown. Cards, summaries and CORE.md are safe to edit by hand — `enforce` re-canonicalizes the frontmatter the next night. Leave `MOC.md` and `.graph/` alone (both are regenerated) and treat `daily/` as an append-only log. To browse, open the vault folder in [Obsidian](https://obsidian.md): wikilinks, backlinks and the graph view work as-is.

## Background & prior art

Memory is the part I've worked on longest: first [agent-second-brain](https://github.com/smixs/agent-second-brain), a Telegram-to-Obsidian pipeline; then [autograph](https://github.com/smixs/autograph), the typed-graph schema engine Iva now ships and runs over the vault; Iva gathers both. The core idea — keep the verbatim record, compress upward, never lose the trail — follows the [LCM: Lossless Context Management](https://arxiv.org/abs/2605.04050) paper (Ehrlich & Blackman, 2026), with the card graph, SUPERSEDE semantics and the Brain pass on top.
