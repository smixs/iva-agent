#!/bin/sh
# VaultCommit.tla under TLC: the model of the seam is clean and the mutant that writes HEAD
# from the snapshot without comparing it breaks its own invariant first. Any TLC failure or
# another verdict is a non-zero exit.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "vault-commit-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" VaultCommit.tla >"$log" 2>&1
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
check VaultCommit none
check VaultCommit-no-head-compare ForeignKept
exit "$failed"
