# Tech debt

Known gaps and deferred decisions, tracked so they don't get lost between releases.

`agent/lib/repeat-guard.ts` temporarily stops repeated failed tool calls at the model boundary; remove it when eve itself stops a turn on a repeated invalid tool call.

## 1. Approval prompts (eve `tools.approval` + Telegram HITL)

eve ships a native tool-approval flow (human-in-the-loop confirmation before a tool
runs). Iva doesn't wire it up yet — every tool call executes unattended. Adopting it
means designing the Telegram side of the approval prompt (inline buttons, timeout,
what happens to the turn while waiting) before it's worth turning on. Deferred
deliberately, not an oversight.

## 2. Bridge UI wizards → native HITL

The `/model`, `/think` and related menu flows in the Bridge (`scripts/poller/`) are
hand-rolled multi-step wizards predating eve's native human-in-the-loop primitives.
They should eventually move onto the same mechanism as item 1 instead of maintaining
a parallel bespoke UI layer.

## 3. Cross-imports from `scripts/lib` into `agent/` — CLOSED

eve rebuilds `agent/` at service start, so a specifier there that resolves into
`scripts/` drags operational code into the bundle — the failure behind the 0.3.14 crash
loop (issue #176). RESOLVED: there are none left. `scripts/authored-tree-guard.test.ts`
asserts the exact list of edges out of `agent/`, and every one of them leads into the shared
`packages/` (`@iva/*` or a relative path there), so a new specifier out of `agent/` is red
on sight. The guard scans production files only: tests never reach the bundle eve
rebuilds, so a specifier in a `*.test.ts` cannot drag `scripts/` into it.

Moved to their canonical home in `agent/lib`: `telegram-acceptance`, `run-status`,
`settings`, `i18n`, `telegram-format`,
`security-gate`, `telegram-reply-context`, `telegram-reset-route`, `telegram-turn-start`,
`schedule-runner`, the write half of `usage`, then `core-cap`, `core-clamp`, `card-text`,
`schedule-migration` and the health poll now in `agent/lib/eve-health.ts`. `scripts/`
consumers reach them through the `#lib/` alias instead of the other way around.

What made the last ten closable is the seam, not a move. `iva` has to work on an install
whose `agent/` is missing or half-written — that is the state `repair.sh` exists for
(ADR-0003) — so every module those processes **load** stays in `scripts/`, every module the
authored tree needs lives in `agent/lib`, and neither side reaches the other while loading.
"Those processes" is wider than `scripts/cli/*`: the guard's load-time walk stops at a
child process, so every separate node run is walked as its own entrypoint. The systemd
units are read out of `deploy/` rather than listed by hand — a hand-written list forgot the
nightly Brain unit (`deploy/iva-brain.service`) once, which is exactly how a unit
gets silently coupled to the tree —
and the three runs no unit starts are named in the guard: the setup wizard (`install.sh` and
`iva config` → `scripts/setup.mjs`), the vault template copy `install.sh` runs before eve has
ever built the tree, and the updater's second half, which the previous version spawns inside
the version it just fetched. One unit is exempt on purpose: the Telegram bridge renders Iva's
own UI (`#lib/i18n.ts`, `#lib/run-status.ts`) and runs beside `iva.service`, which is what
builds the tree. Three shapes, in descending order of preference:

- **A plain move**, where every reader is either the authored tree itself or a process that
  runs beside it: `schedule-migration` — which, living beside the schedules it migrates onto,
  dropped the two lazy imports it needed to hold the old edge open — and `core-cap`, whose
  other reader, the nightly rollup, is spawned by `agent/lib/schedule-runner.ts` and so has
  the tree by construction.
- **A lazy import inside the one call that needs it**, where the process loads a module but
  only exercises that call on a tree that exists: `scripts/lib/config-transaction.ts`
  pulls the health poll at the health check itself (a tree that cannot start fails the
  apply and rolls back either way), `scripts/lib/codex-oauth.ts` pulls the token
  headers inside `listCodexModelCatalog`, which only the `/model` wizard and setup call, and
  `scripts/memory/brain.ts` pulls the whole card format — `core-cap`, `core-clamp` and, via
  `scripts/memory/card-fences.ts`, `card-text` — at the CORE clamp and the fence scan. That
  script is its own systemd oneshot, so a static edge there would kill the nightly vault
  backup on a broken tree; the lazy edge costs those two steps, reports itself, and lets §3
  commit and push the vault anyway.
- **Two self-contained halves pinned by a test**, where both sides genuinely need the same
  small thing while loading: the probe-flag name (`scripts/lib/health-probe.ts` writes it,
  `agent/lib/eve-health.ts` reads it), the retired systemd unit names
  (`scripts/lib/legacy-memory-units.ts`), the IANA-zone predicate
  (`scripts/lib/timezone.ts`, needed by the synchronous `writeUnits()`), the canonical
  reasoning vocabulary, and the Codex OAuth constants plus the token file (its path, its
  atomic 0600 write and the read the setup wizard needs) — `iva login` and the wizard must
  run without the authored tree, so `scripts/lib/codex-oauth.ts` keeps the sign-in flows
  while `agent/lib/codex-auth.ts` owns refreshing the token and signing requests with it.
  Each pair is pinned by a test that imports both halves
  (`scripts/lib/{timezone,reasoning-levels,health-probe,codex-auth-seam}.test.ts`,
  `agent/lib/schedule-paths.test.ts`), the way `usage` shares only its journal path and
  `scripts/lib/usage.test.ts` round-trips it. A pair without such a test is drift waiting
  to happen; add the test before adding the pair.

  The newest pair is the model provider: `agent/lib/model-provider.ts` holds the names the
  runtime accepts, each provider's model variable, its default model and the rule that turns
  a raw `.env` value into the model actually requested; `scripts/lib/model-catalog.ts` holds
  the same names in `CATALOG` — with the labels, endpoints and model lists only the
  wizard needs — plus `catalogModel`, the same rule again. The wizard, `iva doctor`, `iva
update` and the `/menu` screens load without the authored tree, so they cannot import the
  first half; the runtime must not carry the catalog's live-fetch code. `scripts/lib/model-catalog.test.ts`
  imports both and pins names, order, model variables and default models, and runs a matrix
  of blank and padded values through both halves. The matrix pins that the two halves _agree_,
  not that either is right: a change made to both at once walks through it, so the rule's own
  behaviour is held by anchors next to it (`agent/lib/model-provider.test.ts` — the
  `opencode-go/` strip, the blank-means-default case). One `.env` line answering three
  different ways on three screens is exactly the drift this shape invites (issue #161).

## 4. Evals

The `#evals/*` import alias is declared in `package.json` but unused. eve ships a native
`eve/evals` module — adopt it before adding product-level skill evals.

## 5. Discovery guardrails are not part of the release check

`npx eve info` prints what eve actually discovered in `agent/` — the instructions dir,
the skill, tool, subagent and schedule counts, and a `Diagnostics` line — so a skill or
tool that quietly stopped being discovered shows up as a smaller count. Nothing runs it:
`npm run build` spawns `npm run build:core` (`eve build`) from `scripts/build.ts` and
reads none of that back, and no other script in `package.json` calls `eve info` at all.
So the wiring can rot between releases and the first place it surfaces is a user's
install. There is no CI to hang the check on
([ADR-0004](adr/0004-philosophy-is-the-review-bar.md)); the fix is either a pre-release
habit of reading `npx eve info` or a script that asserts the expected counts.

## 6. `sessionTimeoutMs: false` — CLOSED

Closed 2026-09-02: `agent/agent.ts` sets a 24-hour session lifetime. A day of active chat
grew one durable session to ~6400 events and a 220–660 s replay per turn, past the 240 s
workflow ceiling; the upstream lifetime is the retirement story.

Original note:

Disabled in `agent/agent.ts` to preserve eve 0.27's behavior (no auto-expiry) after
the 0.28 default changed to a 30-day session lifetime. This was the safe choice for
existing self-hosted installs with long-lived Telegram/rollup sessions, but it opts
out of a framework-owned cleanup mechanism. Revisit deliberately once Iva has its own
session-retirement story, rather than leaving the override in place indefinitely.

## 7. Opt-in UI for the scheduled Notices — CLOSED

`/menu` → **🔔 Notices** (`scripts/lib/menu/notices.ts`) switches the nightly memory reports
(`memoryReports.enabled`) and **Writes on her own** — Watch and the Brief, which replaced the
morning Report (`proactive.enabled`, ADR-0020) — so neither needs a raw `settings.json` edit,
and **Insight** (`proactive.insightTimes`): a switch and three times.
All three keys are read at fire time, so a tap applies on the next tick with no restart. The rules
the screen enforces: ADR-0007, ADR-0020 and ADR-0022.

## 8. TypeScript-only Node source

The repository migration is complete. New Node.js source and tests must be TypeScript;
JavaScript modules must not be added. Five permanent, logic-free `.mjs` entry shims keep
externally installed paths stable: `bin/iva.mjs` and
`scripts/{telegram-poll,check-update,setup,init-vault}.mjs`. All implementation belongs
in the TypeScript modules behind those shims.

## 9. Upstream feature request: catch-up for missed schedule runs

If the box is down when an eve schedule would have fired, the run is simply skipped
— there's no catch-up on next start, unlike systemd's `Persistent=true` timers. Worth
filing as a feature request against `vercel/eve`.

**Workaround implemented here**: `agent/lib/schedule-migration.ts`, run fire-and-forget
from `agent/instrumentation.ts` on every server start, replaces `Persistent=true` for the
single `memory-night` schedule. It compares the last recorded success
(`data/rollup-status.json`) against the most recent timezone-aware scheduled point and
runs it once when stale and still inside the 20-hour grace window — home-grown and
specific to this app, not a general answer other eve apps could reuse. Superseded if/when eve
grows a native catch-up story.

## 10. Rollup-turn workarounds for vercel/eve#1450

Closed (T96). A parked session no longer resumes: every night turn creates its own
session, and the turn's deadline is the abort signal of its model request
(`scripts/memory/night-call.ts`), not a timer race. The `Promise.race` timeout is gone.

## 11. Cron/name metadata duplicated across schedules, migration, and the menu

The same 5 schedule names + cron expressions used to be hand-maintained in three places:
`agent/schedules/*.ts` (the actual cron strings), `agent/lib/schedule-migration.ts`'s
`PERIOD_SCHEDULE` (hour/minute per period, for catch-up math), and
`scripts/lib/menu/crons.ts`'s `EVE_SCHEDULES` (for the /menu → ⏰ display). Changing one
schedule's cadence meant remembering to update up to three files by hand; a missed one
would make the menu display (or the catch-up math) silently wrong.

RESOLVED: the table lives once, in `agent/lib/schedule-table.ts` (`SCHEDULE_CRON`), and
all three read it — the schedule files take their `cron` from it, the migration places its
catch-up point with `parseCron()`, time of day and day constraint alike (it keeps only
its own per-period grace window, which is catch-up policy, not schedule metadata), and the
menu renders the entries in table order. `agent/lib/schedule-table.test.ts` cross-checks
all three against the table — the migration through its behavior, by bisecting the point
where a recorded success stops counting as stale and checking that instant against the cron
— and fails if any cron expression reappears in another source file, so the copies cannot
silently grow back.

## 12. Bundled Autograph was removed

The non-night Autograph engine now lives in the standalone Autograph repository. Iva
keeps only the TypeScript seams its product uses: frontmatter, card sections, the nightly
graph and the streaming description cleanup. Fixes to the standalone engine do not ship
with Iva automatically.

## 13. Markdown parsing has one implementation

`agent/lib/frontmatter.ts` and `agent/lib/card-store.ts` are the canonical parsers. Their
edge corpus lives under `scripts/fixtures/` and the TypeScript property tests pin quoting,
folded blocks, fenced headings and round trips.

Pair (a) had two more implementations until then, one per half of memory search:
`agent/tools/memory_search.ts` (BM25 columns) and `scripts/memory/embed-index.ts` (the
dense sidecar) each carried a private mini parser for the few scalars they index, with
their own field lists. Duplicates inside one language — no golden fixtures held them, and
both silently dropped folded/literal scalars (indexing the literal `>-`), block lists and
every card written with CRLF. Worse, the copies were not identical, so in
`MEMORY_SEARCH_MODE=hybrid` the two halves could rank different text for the same card.
Both are gone: `agent/lib/card-index.ts` is now the single seam turning a card into
indexable text (canonical `parseFrontmatter`, one `META_FIELDS` list, lists flattened),
and both halves call it. `scripts/memory-search-index.test.ts` pins the FTS columns and
the dense text side by side per card shape, and checks the halves still agree.

## 14. The inbound gate cannot replace Telegram message text

On a text message the pipeline can add context to the turn and nothing else: eve's
`TelegramInboundResult` is `{ auth, context } | null`, so `message.text` is delivered to the
model by the channel regardless of what `sanitizeInbound` found. Checked against the pinned
eve 0.51.1. The only lever beside it is
`null`, which drops the entire update: too blunt to spend on a false positive, and from 0.31.0
it no longer applies to an authorized message at all. So for Telegram **text** the gate is an
annotation: the cleaned copy, the injection
warning and the truncation note ride beside the original, and whether the payload is obeyed is
up to the model. Everything the pipeline assembles itself — voice transcripts, captions, the
vision description of an image — is genuinely filtered, because there is no channel-delivered
original to compete with.

No workaround here, by the owner's decision: faking one (re-sending a scrubbed copy, dropping
the turn and replying by hand, editing session state behind the framework's back) buys a
partial guarantee at the cost of a second delivery path around the inbound pipeline — exactly
the shape ADR-0005 exists to avoid. `docs/security.md` states the limit instead, in the
section "Telegram text: an annotation, not a filter".

The fix is upstream; the feature request is filed as vercel/eve#4605 (10.10.2026) and is small: let the
inbound hook return the text the model will see, as one optional field beside `context` —

```ts
type TelegramInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly text?: string; // new: the body the model actually reads
} | null;
```

— where an omitted `text` keeps today's behaviour, so it can ship in a patch release, and the
replacement covers only the model-visible body, leaving logs and the raw update alone. Remove
this item when a released eve lets the pipeline hand back that text and the pipeline uses it:
that is what turns the sanitizer on Telegram text from a warning into a filter, and it retires
the security doc's section with it.

## 15. A rich message in a group is admitted only as a reply

The Bridge admits a group message carrying no `text`/`caption` only when it replies to the bot
([ADR-0011](adr/0011-bridge-judges-the-envelope.md)). So a `rich_message` that addresses Iva
with an `@mention` inside its blocks is dropped: the Bridge judges the envelope and never opens
content, and the `scripts/lib` → `agent/` import boundary (§3) is closed, so it cannot borrow
the reader that would find the mention. Private chats are unaffected — there is nothing to
address there.

Remove this item when Bot API exposes a plain-text projection of `rich_message` beside the
blocks, or when eve upstream resolves the addressing before the update reaches the Bridge.
Until then the workaround in a group is to reply to one of Iva's messages.

## 16. Rollup stale-cursor workaround for vercel/eve#2461

Closed (T96). The bug ([vercel/eve#2461](https://github.com/vercel/eve/issues/2461))
needs a resumed session: `result()` read from a lagging cursor. The night now
creates a fresh session per turn and reads its stream from index 0, so the drain,
the prompt nonce and the foreign-result check are removed.

The `ai` pin is gone: Iva used to override `ai` to 7.0.39 against eve 0.51.1's peer `ai ^7.0.82`, so eve's bundled `@ai-sdk/code-mode` (it imports `experimental_toolCaller`) did not link and any Workflow/code-mode tool would crash server start. `package.json` now asks for `ai ^7.0.82` with no override. ADR-0013 rejected the workflow-tool route for Reminders (variant C) partly on that pin; the pin no longer stands in its way, the rest of the ADR's reasoning does.

## 17. Insight follow-ups for the next wave

- **A code-free draft changed after the Insight message installs only from the owner's terminal**: `iva plugin propose` refuses a draft without `mcp.json` and `sh.iva/` (`scripts/cli/plugin-cli-proposal.ts`); allowing it there, checked against `expectDigest12`, gives that draft a button.
- **A transitional update builds the Version twice**: the old CLI names the Version from a fingerprint with skills (`scripts/lib/version-update.ts`), the new `warnUnbuiltCustom` (`scripts/cli/services.ts`) compares a fingerprint without them, so installs with skills in `data/custom` get one extra rebuild and a false "run: iva update" on `iva restart`, once.
- **A healthy `iva diagnose` prints 3–4 `! would …` lines**: `ensureBearer` and `ctx.repair()` in `scripts/cli/doctor.ts` print in read mode unconditionally; the fix needs the "repair needed" predicates of `scripts/cli/systemd.ts` and `scripts/lib/version-store.ts` exposed through `api()`.
