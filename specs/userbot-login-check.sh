#!/bin/sh
# UserbotLogin under TLC: the model holds, every mutant fails on its own invariant, and the
# witness shows that a login which got a wrong password can still end authorized.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "userbot-login-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
check() {
  config=$1; expect=$2
  "$TLC" -workers 1 -deadlock -metadir "$META/$config" -config "$config.cfg" UserbotLogin.tla >"$META/$config.log" 2>&1
  code=$?
  if ! tlc_expect "$META/$config.log" "$code" "$config.cfg" "$expect" ""; then
    cat "$META/$config.log"
    exit 1
  fi
  echo "OK $config: $expect"
}
check UserbotLogin none
check UserbotLogin-wrong-password-ends WrongPasswordKeepsAsking
check UserbotLogin-no-marker NoSilentIdle
check UserbotLogin-no-session-check AuthorizedHasSession
check UserbotLogin-raw-error NoSecretLeaves
check UserbotLogin-no-wait WaitRespected
check UserbotLogin-trace-args NoSecretLeaves
check UserbotLogin-read-keeps-marker ReadEndsLogin
check UserbotLogin-success-unread SuccessIsTheRead
check UserbotLogin-retry-witness NoLoginAfterWrongPassword
