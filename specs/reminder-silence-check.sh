#!/bin/sh
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || exit 2
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" ReminderSilence.tla >"$META/$cfg.log" 2>&1
  code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" "" || { cat "$META/$cfg.log"; return 1; }
  echo "$cfg: TLC exit $code, expected $expected"
}
check ReminderSilence none && check ReminderSilence-ignore-tool ToolWait
