----------------------------- MODULE ModelWindow -----------------------------
EXTENDS Integers
\* Verifies the implemented resolver and atomic wizard update, not a new protocol.
\* Default/RuntimeWindow: packages/context-window/index.ts:providerContextWindow.
\* Select: scripts/poller/wizards.ts:wizardModelUpdates / validateAndSaveWizard, upsertEnv writes atomically.
\* SummaryWindow: scripts/lib/model-summary.ts:modelSummary.
\* HelperWindow: agent/agent.ts:stepModelChoice (cap at the helper model window).
\* Parser validation, filesystem errors and Telegram rendering are tested in code.
CONSTANTS MissingDefault, MissingSave, UncappedHelper
VARIABLES provider, model, override, menuSaved, helper
vars == <<provider, model, override, menuSaved, helper>>
Providers == {"claude", "codex", "ollama", "opencode", "openrouter", "custom"}
Models == {"modern", "haiku4", "unknown"}
ClaudeWindow(m) == IF m = "modern" THEN 1000000 ELSE 200000
Default(p, m) == IF p = "claude" THEN ClaudeWindow(m)
                 ELSE IF p = "codex" THEN 272000 ELSE 131072
RuntimeWindow == IF override = 0 THEN Default(provider, model) ELSE override
SummaryWindow == IF override = 0 /\ menuSaved /\ MissingDefault THEN 0 ELSE RuntimeWindow
HelperWindow == IF UncappedHelper THEN RuntimeWindow
                ELSE IF RuntimeWindow < ClaudeWindow(helper) THEN RuntimeWindow ELSE ClaudeWindow(helper)
Init == /\ helper \in Models /\ provider \in Providers /\ model \in Models
        /\ override \in {0, 42} /\ menuSaved = FALSE
Select == \E p \in Providers, m \in Models:
    /\ UNCHANGED helper
    /\ provider' = p /\ model' = m /\ menuSaved' = TRUE
    /\ override' = IF p = "claude" /\ ~MissingSave THEN ClaudeWindow(m) ELSE override
Spec == Init /\ [][Select]_vars
DisplayMatchesRuntime == SummaryWindow = RuntimeWindow
MenuSavesClaudeWindow == menuSaved /\ provider = "claude" => override = ClaudeWindow(model)
HelperFitsModel == menuSaved /\ provider = "claude" => HelperWindow <= ClaudeWindow(helper)
=============================================================================
