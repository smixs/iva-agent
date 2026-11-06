# Memory

Iva keeps memory in a plain Markdown vault. Raw conversations stay in `daily/`, stable knowledge lives in typed cards, and summaries fold upward from days to weeks, months and years. `CORE.md` is the small always-on layer included in every prompt.

## Night

At 04:00 local time by default one TypeScript schedule runs `scripts/memory/night.ts`. Code owns reads, validation, writes, commits, retries and limits. The configured model only returns proposals: each step instruction describes the answer in words with one short example, the model answers with a JSON object in plain text, and the night parses it leniently — the same way for every provider.

Choose another window with one `.env` setting, `MEMORY_NIGHT_TIME=HH:mm`, then rebuild with `iva update --force` (a development checkout uses `npm run build` and `iva restart`). Editing `.env` alone moves neither the Schedule nor catch-up: `/menu` → ⏰ shows the active time and a pending change. Night still excludes the current local day. Rollback restores the clock of that build; older builds without this setting keep 04:00.

The night consumes streamed text before validating the answer, including on ChatGPT subscriptions that require streaming. It records the final usage before the next call; an interrupted stream fails the step. Codex night calls request low reasoning effort without changing the chat setting.

The night has four steps:

1. Extract a day summary, card references and evidence-backed facts from the raw day.
2. Append dated facts to the Card and propose the whole new Compiled Truth.
3. Write bilateral Card links only when both targets exist.
4. Propose bounded edits to `CORE.md` from the owner's own quotations.

Large inputs are split at entry boundaries. The night starts with soft limits of 40 calls and 300,000 input tokens, counted from provider usage. Before a request, it conservatively estimates its input as UTF-8 bytes divided by three. Missing or invalid provider usage closes the gate before the next call. A day is ready after its summary and the one-release compatibility marker in the raw day are committed together for paths allowed by the owner's Git policy. New files excluded by `.gitignore`, `.git/info/exclude` or global Git rules stay on disk and do not stop the night; the log explicitly lists them as outside the Git backup. Already tracked files continue to be committed even if their parent directory is later ignored. If all paths are excluded, day readiness is recorded locally, without backing up those files.

The day cache in `data/memory/night/` makes restarts idempotent. A matching late tail sends only the new entries to the model. If an older processed entry changed, the night leaves the day untouched and asks the owner to remove that cache explicitly before reprocessing.

A provider connection failure, headers timeout or aborted stream ends the run with an error. It does not mark the unfinished day as ready or consume a schema-failure attempt. The next night resumes from the saved step: accepted facts remain in their Cards and the day stays pending until completed. There is no second transport request within that night call and no fallback to a different model. Restore the configured provider; inspect `iva jobs`, the job log, the raw day and its cache before claiming data loss. Keep those files: deleting the cache to fix a timeout discards resume progress, and `iva jobs ack memory-night` only acknowledges the failure. If raw or Card bytes are actually missing, preserve the Git history and diagnosis package for investigation.

For custom background work, existing Watch/Brief check user timer failures and installed plugin/MCP services. An arbitrary detached script or a live but hung process is outside those checks; a failed run is reported, not automatically restarted. Read the unit's status and journal, preserve its checkpoint and fix the script's cause before resuming. Colliding input basenames require separate job-owned temporary paths. A persistent capability belongs in a plugin; a recurring task belongs in a Routine, not an extra watchdog in Iva's core.

Weekly summaries require all seven day states, including explicit no-data days. Monthly summaries use full weeks inside the month plus only the in-month days of edge weeks. Yearly summaries use all twelve months.

## Что ночь чинит сама / What the night repairs itself

Two failures can recover within the same process: a model call/input limit and a Git timeout. When a model request would exceed a soft limit, the night raises that limit by 40 calls or 300,000 input tokens, saves it, and continues the same day. Each completed portion is saved immediately; a later night starts with the first unsaved portion. Large Russian days can need several nights when raising is disabled or a ceiling is reached. A cache with an open pass and no answers can mean that earlier work exhausted the budget before this day's first model call.

A timed-out Git command gets twice the wait and runs once more with the same arguments. A second timeout returns the actual new wait in the failure message. The shared Git writer applies this policy to the pre-night sweep and to ordinary memory writes too. Model-limit raises and Git-timeout raises each have their own per-process allowance of `raisesPerNight`. The night keeps the raised value in memory if the settings lock is busy or saving fails, and records that saving failed; the rest of `settings.json`, including the menu language, stays intact.

Limits live under `night` in `data/settings.json`:

| Key               | Default | Meaning                                                                               |
| ----------------- | ------: | ------------------------------------------------------------------------------------- |
| `calls`           |      40 | Current soft limit for model calls                                                    |
| `inputTokens`     |  300000 | Current soft limit for model input tokens                                             |
| `gitTimeoutMs`    |   12000 | Current wait for one Git command, in milliseconds                                     |
| `maxCalls`        |     160 | Ceiling for automatic call-limit raises                                               |
| `maxInputTokens`  | 1200000 | Ceiling for automatic input-limit raises                                              |
| `maxGitTimeoutMs` |  120000 | Ceiling for automatic Git wait raises                                                 |
| `raisesPerNight`  |       3 | Maximum raises per process for model limits and, separately, Git; `0` disables raises |

Run `iva night show` to see effective values. Run `iva night set inputTokens 600000` to set one value, or `iva night set maxInputTokens 1500000` to change a ceiling explicitly. Values are safe positive integers; `raisesPerNight` also accepts zero. A soft limit must fit its ceiling. Invalid commands leave the file intact. Missing or damaged settings use defaults for reading and leave a diagnostic in the night job log; invalid fields use defaults, with soft values constrained by a valid configured ceiling. Writing a damaged file is refused until it is repaired. Settings from newer versions remain readable by older versions, which ignore the extra `night` key.

The night job log and the existing optional night Report say what limit was reached, which value was raised, how many days completed and how many remain queued. At a ceiling or after the raise allowance is spent, one Alert explains the limit and the `iva night set …` command; the existing Alert throttle suppresses repeated delivery for the same problem, including across language changes. Missing provider usage still closes further calls and is named explicitly in the job log. Provider authentication errors, manual edits and damaged progress caches keep their existing recovery paths; preserve the cache and inspect `iva diagnose` and `iva jobs`.

## Cards and CORE

Every accepted fact is append-only:

```text
- YYYY-MM-DD: fact · [[daily/YYYY-MM-DD]] HH:MM
```

Evidence must come from an owner entry. The model returns the whole new Compiled Truth; the night replaces it only if the Card file still matches the hash read for the call. Replaced truth moves to the Card archive; a concurrent owner edit wins and leaves `truth_pending` for the next night. `write_card` exposes explicit `fact`, `truth` and owner-confirmed `merge` operations. General `write_file` cannot write memory (`daily/`, `summaries/`, period summaries, `cards/`); other vault paths such as `library/` are written and committed, and `CORE.md` goes through the same capped, committed writer.

`write_card` describes a minimal JSON call for each operation before execution and repeats the relevant example when required operation fields are missing or invalid. Schema validation errors also include the corrected-call shape, field/type details and a reminder to repair the arguments rather than repeat the failing call or inspect source code. Substitute the actual Card data, omit unused optional fields, and pass `tags` and `aliases` as arrays of strings. The `merge` example is a call shape, never evidence of the owner's confirmation. Validation and the existing repeated-failure limit remain enforced.

## Brain and search

At 05:00 `scripts/memory/brain.ts` performs deterministic TypeScript maintenance: it commits outstanding owner changes, rebuilds `.graph/vault-graph.json`, checks the CORE size and pushes the vault when a remote exists. It does not call a model or rewrite cards.

`memory_search` uses Node's SQLite FTS5 index and the companion graph file. Hybrid search can additionally fuse embeddings when configured.

## Git and cleanup

The vault is a separate git repository. Night writes, direct Card writes, CORE edits and cleanup all leave scoped commits. The streaming cleaner is `scripts/vault-cleanup.ts`; it collapses duplicated `description` growth and caps oversized legacy descriptions without loading a whole damaged vault into memory. The same TypeScript entrypoint is used by `/menu` and the updater.

Cleanup of an abandoned Git index lock starts after `night.maxGitTimeoutMs + 15000` milliseconds: 135000 ms with the default ceiling. The extra 15000 ms is the existing cleanup grace. Using the ceiling protects another writer throughout its permitted Git wait, including a timeout raise kept only in memory after settings could not be saved. A newer lock stays in place; the writer briefly waits for its owner and reports a failure if the index remains busy. A later write can recover an abandoned lock after that horizon.

All memory code and prompts live under `scripts/memory/`; the vault contains data only. Existing legacy `.claude/` or `MOC.md` files may stay, but the night no longer reads or regenerates them.

## Layout

```text
vault/
├── CORE.md
├── CORE.history.md
├── PERSONA.md
├── cards/{contacts,projects,decisions,ideas,notes}/
├── daily/YYYY-MM-DD.md
├── summaries/daily/YYYY-MM-DD.md
├── weekly/ monthly/ yearly/
├── attachments/
├── schema.json
└── .graph/vault-graph.json
```
