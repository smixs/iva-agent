#!/bin/sh
# One process at a time; model mutants must fail the named invariant.
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
TLC=${TLC:-"$HOME/.local/bin/tlc"}
CHECK_TMP=${TMPDIR:-../.scratch}
mkdir -p "$CHECK_TMP"
META=$(mktemp -d "$CHECK_TMP/telegram-progress.XXXXXX")
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS:--Xmx2g}
check() {
  cfg=$1; expected=$2; code=0
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" \
    -config "$cfg.cfg" TelegramProgress.tla >"$META/$cfg.log" 2>&1 || code=$?
  if ! tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected"; then
    cat "$META/$cfg.log"
    return 1
  fi
  echo "$cfg: $got; exit=$code"
}
check TelegramProgress none
check TelegramProgress-repeat Once
check TelegramProgress-no-owner LiveOwner
check TelegramProgress-draft-claim Once
check TelegramProgress-no-threshold Quiet
