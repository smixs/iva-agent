#!/bin/sh
# Optional LOG_DIR retains evidence; the private working tree is always removed.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$HOME/.local/bin/tlc}
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TLC" ] && [ -x "$TIMEOUT" ] || exit 2
if [ -n "${LOG_DIR:-}" ]; then
  mkdir -p "$LOG_DIR" || exit 2
  META=$(mktemp -d "$LOG_DIR/model-window-tlc.XXXXXX") || exit 2
else
  META=$(mktemp -d) || exit 2
fi
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check() {
  cfg=$1; expect=$2
  log="$META/$cfg.log"
  mkdir -p "$META/$cfg.tmp" || return 2
  JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Xmx1g} -Djava.io.tmpdir=$META/$cfg.tmp" \
    "$TIMEOUT" --foreground --kill-after=5s "${TLC_TIMEOUT:-60}s" "$TLC" \
    -workers 1 -deadlock -metadir "$META/$cfg.states" \
    -config "$cfg.cfg" ModelWindow.tla >"$log" 2>&1
  code=$?
  tlc_expect "$log" "$code" "$cfg.cfg" "$expect"
  verdict=$?
  printf '%s\texpected=%s\tactual=%s\texit=%s\n' "$cfg" "$expect" "${got:-error}" "$code"
  if [ -n "${LOG_DIR:-}" ]; then
    printf '%s\t%s\t%s\t%s\n' "$cfg" "$expect" "${got:-error}" "$code" >> "$LOG_DIR/tlc-results.tsv" || return 2
  fi
  if [ "$verdict" -ne 0 ]; then cat "$log"; return 1; fi
}
check ModelWindow none || exit 1
check ModelWindow-default DisplayMatchesRuntime || exit 1
check ModelWindow-save MenuSavesClaudeWindow || exit 1
check ModelWindow-helper HelperFitsModel || exit 1
