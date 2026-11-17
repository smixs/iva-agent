#!/bin/sh
# Exhaustive BFS; every mutant must fail its named invariant with TLC exit 12.
set -u
JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS:--Xmx2g}
export JAVA_TOOL_OPTIONS
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
ROOT=$(cd .. && pwd) || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TLC" ] || { echo 'draft-stop-check: tlc not found'; exit 2; }
[ -x "$TIMEOUT" ] || { echo 'draft-stop-check: GNU timeout required'; exit 2; }
WORKERS=${WORKERS:-2}
case "$WORKERS" in 1|2|3|4) ;; *) echo 'draft-stop-check: WORKERS must be 1..4'; exit 2;; esac
mkdir -p "$ROOT/.scratch/draft-stop-tla" || exit 2
META=$(mktemp -d "$ROOT/.scratch/draft-stop-tla/check.XXXXXX") || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ok=0; failed=0
check() {
  cfg=$1; expect=$2; log="$META/$cfg.log"
  workers=$WORKERS; [ "$expect" = none ] || workers=1
  mkdir -p "$META/$cfg.tmp" || return 2
  echo "RUN $cfg: expected=$expect; workers=$workers; timeout=${TLC_TIMEOUT:-600}s"
  # Isolate standard-module extraction from concurrent TLC JVMs on this machine.
  JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS -Djava.io.tmpdir=$META/$cfg.tmp" \
    "$TIMEOUT" --foreground --kill-after=5s "${TLC_TIMEOUT:-600}s" "$TLC" \
    -fp 1 -seed 20261014 -workers "$workers" -deadlock \
    -metadir "$META/$cfg.states" -config "$cfg.cfg" DraftStop.tla >"$log" 2>&1
  code=$?
  valid=false
  tlc_expect "$log" "$code" "$cfg.cfg" "$expect" && valid=true
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  elapsed=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$log" | tail -1)
  if [ -n "${LOG_DIR:-}" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cfg" "$expect" "${got:-error}" "$code" \
      "${states:-unknown}" "${elapsed:-unknown}" >> "$LOG_DIR/results.tsv" || return 2
  fi
  if [ "$valid" = true ]; then
    echo "OK $cfg: $got; exit=$code; distinct=${states:-unknown}; time=${elapsed:-unknown}"
    ok=$((ok+1))
  else
    echo "FAIL $cfg: expected=$expect; got=${got:-infrastructure/error}; exit=$code"
    sed -n '1,40p' "$log"
    failed=$((failed+1))
    [ -n "$got" ] || return 2
  fi
}
check DraftStop none || exit 2
check DraftStop-stop-without-draft StopOwnDraft || exit 2
check DraftStop-stop-with-null-turn StopHasTurn || exit 2
check DraftStop-frame-after-final NoFrameAfterFinal || exit 2
check DraftStop-no-self-check SelfCheckCloses || exit 2
check DraftStop-reset-on-non-success FailurePolicy || exit 2
check DraftStop-turn-clear-foreign ForeignRecordPreserved || exit 2
check DraftStop-restart-keep-pause RestartForgetsPause || exit 2
check DraftStop-older-frame-after-final NoOlderInFlightAfterFinal || exit 2
echo "draft-stop-check: ok=$ok failed=$failed"
[ "$failed" -eq 0 ]
