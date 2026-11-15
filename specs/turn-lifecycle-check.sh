#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
mkdir -p ../.scratch/turn-lifecycle
meta=$(mktemp -d ../.scratch/turn-lifecycle/tlc.XXXXXX)
trap 'rm -rf "$meta"' EXIT
check() {
  config=$1; expected=$2
  code=0
  "${TLC:-$HOME/.local/bin/tlc}" -workers 1 -deadlock -metadir "$meta/$config" -config "$config.cfg" TurnLifecycle.tla >"$meta/$config.log" 2>&1 || code=$?
  tlc_expect "$meta/$config.log" "$code" "$config.cfg" "$expected" "" bfs || { cat "$meta/$config.log"; exit 1; }
  echo "$config: $expected (exit $code)"
}
check TurnLifecycle none
check TurnLifecycle-failure FailurePreserved
check TurnLifecycle-silence CancelBeforeStart
check TurnLifecycle-identity OldTurnStopped
