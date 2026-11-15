#!/bin/sh
# ProgressMessage.tla under TLC. The base configuration has no error; every mutant fails
# its named invariant (exit 12); the liveness configuration checks the two properties.
set -u
JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS:--Xmx2g}
export JAVA_TOOL_OPTIONS
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
[ -x "$TLC" ] || { echo 'progress-message-check: tlc not found (set TLC=/path/to/tlc)'; exit 2; }
WORKERS=${WORKERS:-2}
case "$WORKERS" in 1|2|3|4) ;; *) echo 'progress-message-check: WORKERS must be 1..4'; exit 2;; esac
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ok=0; failed=0
check() { # config expected: none | <invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  workers=$WORKERS; [ "$expect" = none ] || workers=1
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg.states" \
    -config "$cfg.cfg" ProgressMessage.tla >"$log" 2>&1
  code=$?
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  if tlc_expect "$log" "$code" "$cfg.cfg" "$expect"; then
    echo "OK $cfg: $got; exit=$code; distinct=${states:-unknown}"
    ok=$((ok+1))
  else
    echo "FAIL $cfg: expected=$expect; got=${got:-infrastructure/error}; exit=$code"
    sed -n '1,60p' "$log"
    failed=$((failed+1))
  fi
}
check ProgressMessage none
check ProgressMessage-live none
check ProgressMessage-live-fault none
check ProgressMessage-id-turn-field NoOrphanWithoutCrash
check ProgressMessage-delete-by-pair NoDeleteLive
check ProgressMessage-clear-null NoOrphanWithoutCrash
check ProgressMessage-claim-over-id NoPostOverId
check ProgressMessage-no-frame-delete NoOrphanWithoutCrash
check ProgressMessage-edit-after-close NoStatusAfterFinal
check ProgressMessage-resend-after-gone Once
check ProgressMessage-clear-on-error ClearOnlyByAnswer
check ProgressMessage-no-mark NoOrphanWithoutCrash
check ProgressMessage-edit-gone-clears NoOrphanWithoutCrash
echo "progress-message-check: ok=$ok failed=$failed"
[ "$failed" -eq 0 ]
