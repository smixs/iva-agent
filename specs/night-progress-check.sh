#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2
  code=0
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" NightProgress.tla >"$META/$cfg.log" 2>&1 || code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" || { cat "$META/$cfg.log"; exit 1; }
  echo "OK $cfg: $expected (exit $code)"
}
check NightProgress none
check NightProgress-forget SavedNeverAsked
check NightProgress-unbounded AttemptsBounded
check NightProgress-transient TransientPreservesAttempts
