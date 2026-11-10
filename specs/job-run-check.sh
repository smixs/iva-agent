#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
mkdir -p ../.scratch/job-run
meta=$(mktemp -d ../.scratch/job-run/tlc.XXXXXX)
trap 'rm -rf "$meta"' EXIT
check() {
  config=$1; expected=$2
  code=0
  "${TLC:-$HOME/.local/bin/tlc}" -workers 1 -deadlock -metadir "$meta/$config" -config "$config.cfg" JobRun.tla >"$meta/$config.log" 2>&1 || code=$?
  tlc_expect "$meta/$config.log" "$code" "$config.cfg" "$expected" "" bfs || { cat "$meta/$config.log"; exit 1; }
  echo "$config: $expected (exit $code)"
}
check JobRun none
check JobRun-nodeadline none
check JobRun-selfreuse none
check JobRun-foreign-clear NoForeignClear
check JobRun-over-live OneLive
check JobRun-no-fact FactKept
check JobRun-ignore-death DeadFreed
check JobRun-selfreuse-nocheck DeadFreed
check JobRun-pidreuse DeadFreed
check JobRun-grace OneLive
check JobRun-orphan OneLive
