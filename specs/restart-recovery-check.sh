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
  workers=${WORKERS:-2}; [ "$expected" = none ] || workers=1
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" RestartRecovery.tla >"$META/$cfg.log" 2>&1 || code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" || { cat "$META/$cfg.log"; exit 1; }
  echo "OK $cfg: $expected (exit $code)"
}
check RestartRecovery none
check RestartRecovery-candidate NeverBlocked
check RestartRecovery-window none
check RestartRecovery-window-unsafe ClosedStaysClosed
check RestartRecovery-button none
check RestartRecovery-button-auto OnlyOwnerTap
check RestartRecovery-button-duplicate OneNewTurn
check RestartRecovery-button-notices OneNoticePerTurn
check RestartRecovery-button-lost NoticeEventually
