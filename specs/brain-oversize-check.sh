#!/bin/sh
# BrainOversize.tla under TLC: the model of the code is clean and every mutant breaks its
# own invariant first. Any TLC failure or another verdict is a non-zero exit.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "brain-oversize-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" BrainOversize.tla >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$cfg.cfg" "$expect" ""; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
  else
    echo "FAIL $cfg: exit $code, got '${got:-error}', expected '$expect'"
    cat "$log"
    failed=1
  fi
}
check BrainOversize none
check BrainOversize-no-threshold BigNeverCommitted
check BrainOversize-check-before-add BigNeverCommitted
check BrainOversize-silent SkippedIsTold
check BrainOversize-abort OthersGo
check BrainOversize-every-night OneAlertPerSet
check BrainOversize-unstage HistoryKept
exit "$failed"
