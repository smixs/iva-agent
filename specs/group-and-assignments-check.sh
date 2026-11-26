#!/bin/sh
# GroupAndAssignments.tla under TLC: verifies group turn serialization across bots,
# lossless/no-duplicate group and batched assignment handling across crash-replay,
# split claim/send owner notification in both delivery orders, every mutant catches
# its invariant, and the witness proves reply+silence in a group plus completed assignments.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "group-and-assignments-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" GroupAndAssignments.tla >"$log" 2>&1
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
check GroupAndAssignments none
check GroupAndAssignments-concurrent-group SingleActiveGroupBot
check GroupAndAssignments-drop-busy-group NoLostGroupMessage
check GroupAndAssignments-duplicate-group NoDuplicateGroupProcessing
check GroupAndAssignments-duplicate-assignment NoDuplicateAssignment
check GroupAndAssignments-lost-assignment NoLostAssignment
check GroupAndAssignments-duplicate-owner-notice AtMostOneOwnerNotice
check GroupAndAssignments-stuck-owner-notice DoneAssignmentNotifiedOwner
check GroupAndAssignments-batch-first-only NoLostAssignment
check GroupAndAssignments-witness NoSilenceAndAssignmentWitness
exit "$failed"
