# Devin CLI provider (experimental)

Iva can use an authenticated official Devin CLI as its text model. This provider is opt-in:
existing installations keep their current provider and data formats.

## Setup

Install the [official Devin CLI](https://docs.devin.ai/cli) on the same machine
and authenticate as the Linux/macOS user running Iva:

```sh
devin auth login
devin auth status
devin models list --format json
iva config
```

Select Devin CLI in the provider picker. The picker and model validation use your account's
live model catalog. No API key is required. You can also configure:

```dotenv
MODEL_PROVIDER=devin
DEVIN_MODEL=swe-2-high
DEVIN_CONTEXT_WINDOW=131072
```

Ensure `devin` is in the service PATH, or set `DEVIN_COMMAND` to its executable path.
Run `npm run build` after changing agent source, then `iva restart`. `iva doctor` checks
the CLI login. Account access and availability of individual models depend on your plan.
If the CLI requires a different network route, `DEVIN_PROXY_URL` applies a private
HTTP(S) proxy only to its child process. Never commit proxy credentials.

## Model and tool execution

Each Iva step starts an isolated ACP session with the ordered conversation encoded in
its prompt. Only CLI credentials are copied into private temporary XDG state. Config
imports, subagents and native file/shell operations are disabled; bot tokens are excluded
from the child environment. An inert MCP inventory captures the first requested function;
Iva validates and executes it and supplies its real result on the next step. The adapter
does not allow the CLI to execute the requested function. Only the first function request
is accepted per step; subsequent Iva steps handle remaining work.

Abort and the request deadline terminate the process group and remove temporary state.
`DEVIN_TIMEOUT_MS` overrides the default 180000 ms deadline.

## Token accounting

Before cleanup, the adapter reads only metadata from its own temporary CLI SQLite session.
Each internal model request is counted once by request ID. Fresh input, cache reads, cache
writes and output remain separate; the total input includes cached tokens exactly once.
Repeated ACP `usage_update` snapshots are not summed: they can repeat and describe only the
latest internal request. The current implementation reads the CLI `message_nodes` schema,
verified with official CLI 3000.12.57 and 3000.14.30821.

Missing, inconsistent or unsupported metrics remain unknown and never fail the answer.
Night memory uses its bounded input estimate when Devin usage is unknown; call, input and
time limits still apply. Token counts are not a statement of subscription credits/ACUs or
billing. Temporary state is removed, so past usage from older adapter versions cannot be
reconstructed. Node 24 supplies the built-in SQLite module; no additional database package
is installed.

## Limitations

This integration is experimental and text-only: images are rejected explicitly. Conversation
roles are encoded in an ACP prompt rather than native role replay. The CLI protocol and its
private database schema can change; accounting then falls back to unknown. Optional voice
and search services still need their own normal configuration.

The deterministic tests use subprocess ACP/MCP fixtures and do not require a Devin account.
Live validation covered text, function/result roundtrips, isolated state, cancellation and
positive token counters for both text and intercepted tools. These are compatibility checks,
not a guarantee that a model/account will never time out.
