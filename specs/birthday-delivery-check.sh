#!/bin/sh
# PR382: основная модель и три свидетеля. BIRTHDAY_TLC_OUT сохраняет логи прогона.
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
TLC=${TLC:-$HOME/.local/bin/tlc}
owned_out=
active_meta=
cleanup() {
  [ -z "$active_meta" ] || rm -rf "$active_meta"
  [ -z "$owned_out" ] || rm -rf "$owned_out"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "${BIRTHDAY_TLC_OUT:-}" ]; then
  out=$BIRTHDAY_TLC_OUT
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
else
  owned_out=$(mktemp -d)
  out=$owned_out
fi
check() {
  cfg=$1
  expected=$2
  log="$out/$cfg.log"
  active_meta=$(mktemp -d "$out/states.XXXXXX")
  code=0
  "$TLC" -workers 1 -deadlock -metadir "$active_meta" -config "$cfg.cfg" BirthdayDelivery.tla >"$log" 2>&1 || code=$?
  rm -rf "$active_meta"
  active_meta=
  if tlc_expect "$log" "$code" "$cfg.cfg" "$expected"; then
    echo "PASS $cfg: $expected (TLC exit $code)"
  else
    cat "$log"
    echo "FAIL $cfg: expected $expected, TLC exit $code"
    return 1
  fi
}
check BirthdayDelivery none
check BirthdayDelivery-claim IntentIsNotAck
check BirthdayDelivery-partial PartialOnlyDelivered
check BirthdayDelivery-retain AckSurvivesRestart
