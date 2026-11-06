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
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" NightWriter.tla >"$META/$cfg.log" 2>&1 || code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" || { cat "$META/$cfg.log"; exit 1; }
  echo "OK $cfg: $expected (exit $code)"
}
check NightWriter none
check NightWriter-save-window HumanEditWins
check NightWriter-publish-window HumanEditWins
check NightWriter-summary-reread HumanEditWins
check NightWriter-summary-unwritten HumanEditWins
check NightWriter-summary-recomputed PublishedSummaryResumes
check NightWriter-summary-order PendingSummaryResumes
