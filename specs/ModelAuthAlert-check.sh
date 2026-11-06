#!/bin/sh
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$HOME/.local/bin/tlc}
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
check() {
  config=$1; expect=$2
  "$TLC" -workers 1 -deadlock -metadir "$META/$config" -config "$config.cfg" ModelAuthAlert.tla >"$META/$config.log" 2>&1
  code=$?
  if ! tlc_expect "$META/$config.log" "$code" "$config.cfg" "$expect" ""; then
    cat "$META/$config.log"
    exit 1
  fi
  echo "OK $config: $expect"
}
check ModelAuthAlert none
check ModelAuthAlert-no-throttle DailyThrottle
