#!/bin/sh
# MultiBotPoll.tla under TLC: the multi-bot polling model holds all safety invariants, each
# mutant (shared offset across bots, missing process lock, untagged inbox) violates its own
# invariant, and the independence witness proves a slow bot does not block another bot.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "multi-bot-poll-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" MultiBotPoll.tla >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$cfg.cfg" "$expect" ""; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
  else
    echo "FAIL $cfg: exit $code, got '${got:-error}', expected '$expect'"
    cat "$log"
    failed=1
  fi
}
check MultiBotPoll none
check MultiBotPoll-shared-offset NoSkippedUpdate
check MultiBotPoll-no-lock SinglePollerLock
check MultiBotPoll-no-bot-tag ExactBotAttribution
check MultiBotPoll-independent-witness NoIndependentProgress
exit "$failed"
