#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
check() {
  config=$1
  expected=$2
  code=0
  "$TLC" -workers 1 -deadlock -metadir "$META/$config" -config "$config.cfg" DeferredRestart.tla >"$META/$config.log" 2>&1 || code=$?
  tlc_expect "$META/$config.log" "$code" "$config.cfg" "$expected" || { cat "$META/$config.log"; exit 1; }
  echo "OK $config: $expected (exit $code)"
}
check DeferredRestart none
check DeferredRestart-unsafe OnlyIdle
check DeferredRestart-overwrite DurableAll
check DeferredRestart-input InputAvailable
check DeferredRestart-chat-only OnlyIdle
