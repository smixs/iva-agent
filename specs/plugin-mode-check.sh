#!/bin/sh
# PluginMode.tla under TLC: the model of the code is clean, every mutant and every witness of
# the code before the repair breaks its own invariant first, and the open finding of the
# updater still shows. Third argument: invariants left out of that run, for a mutant that
# breaks two rules at one depth. Any TLC failure or another verdict is a non-zero exit.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "plugin-mode-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected [dropped invariants]
  cfg=$1; expect=$2; drop=${3:-}
  run="$META/$cfg$(printf %s "$drop" | tr ' ' '-')"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  for inv in $drop; do
    sed "/^INVARIANTS/s/ $inv\$//; /^INVARIANTS/s/ $inv / /" "$run.cfg" >"$run.tmp" && mv "$run.tmp" "$run.cfg"
    if grep -Eq "^INVARIANTS.* $inv( |\$)" "$run.cfg"; then
      echo "FAIL $cfg: could not drop $inv"; failed=1; return
    fi
  done
  cp PluginMode.tla "$META/"
  (cd "$META" && "$TLC" -workers 1 -deadlock -metadir "$run.states" -config "$run.cfg" PluginMode.tla) >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$run.cfg" "$expect" ""; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg${drop:+ without $drop}: $got violated (expected)"; fi
  else
    echo "FAIL $cfg: exit $code, got '${got:-error}', expected '$expect'"
    cat "$log"
    failed=1
  fi
}
check PluginMode none
check PluginMode-enabled-only ProcessesNeedTrust
check PluginMode-disable-keeps-units DisabledIsStopped
check PluginMode-undo-keeps-units DisabledIsStopped
check PluginMode-turn-trusts TrustIsOwners
# One stale write, two rules: the undo of `trust` re-enables, the undo of `enable` re-trusts.
check PluginMode-stale-undo EnableIsOwners
check PluginMode-stale-undo TrustIsOwners EnableIsOwners
check PluginMode-update-reenables UpdateGrantsNothing
# The open finding: the updater as it is today (scripts/lib/version-update.ts, settlePlugins).
check PluginMode-update-off DisabledIsStopped
exit "$failed"
