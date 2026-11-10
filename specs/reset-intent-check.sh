#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
mkdir -p ../.scratch/reset-intent
meta=$(mktemp -d ../.scratch/reset-intent/tlc.XXXXXX)
trap 'rm -rf "$meta"' EXIT
check() {
  config=$1; expected=$2
  code=0
  "${TLC:-$HOME/.local/bin/tlc}" -workers 1 -deadlock -metadir "$meta/$config" -config "$config.cfg" ResetIntent.tla >"$meta/$config.log" 2>&1 || code=$?
  tlc_expect "$meta/$config.log" "$code" "$config.cfg" "$expected" "" bfs || { cat "$meta/$config.log"; exit 1; }
  echo "$config: $expected (exit $code)"
}
check ResetIntent none
check ResetIntent-clear-first IntentUntilClean
check ResetIntent-clear-all ExactCut
check ResetIntent-confirm-recovery ConfirmOnce
check ResetIntent-confirm-window ConfirmOnce
check ResetIntent-interleave ExactCut
