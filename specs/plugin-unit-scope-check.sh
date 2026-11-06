#!/bin/sh
# The accepted ownership model and the old global-cleanup witness.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "plugin-unit-scope-check: set TLC=/path/to/tlc"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() {
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 1 -metadir "$META/$cfg.states" -config "$cfg.cfg" PluginUnitScope.tla >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$cfg.cfg" "$expect" ""; then
    echo "OK $cfg: exit $code, $got"
  else
    echo "FAIL $cfg: exit $code, expected $expect"
    cat "$log"
    failed=1
  fi
}
check PluginUnitScope none
check PluginUnitScope-globalcleanup CrossInstallSafety
exit "$failed"
