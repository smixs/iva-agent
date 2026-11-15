#!/bin/sh
# UpdateRun.tla под TLC: ход обновления с журналом на диске чист, каждый мутант краснеет на
# своём инварианте первым, и откат кандидата юниты возвращает. Любой сбой TLC или другой
# вердикт — ненулевой код выхода.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "update-run-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2
  workers=${WORKERS:-2}; [ "$expect" = none ] || workers=1
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" UpdateRun.tla >"$META/$cfg.log" 2>&1
  code=$?
  if tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expect" ""; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$META/$cfg.log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
  else
    echo "FAIL $cfg: exit $code, got '${got:-error}', expected '$expect'"
    cat "$META/$cfg.log"
    failed=1
  fi
}
check UpdateRun none
# R1: journal settled before active.json lets UpdateJob announce an unpinned version.
check UpdateRun-journal-first FinalOnlyWhenPinned
# Откат кандидата: юниты возвращаются, юзербот остаётся выключен с названной причиной.
check UpdateRun-rollback none
# Снимок юнитов только в памяти (код до ремонта) — краснеет (2).
check UpdateRun-memory-units UnitsReturn
# Журнал есть, повтор его не читает — краснеет (2).
check UpdateRun-retry-forgets UnitsReturn
# Карантин без записанного пути — краснеет (3).
check UpdateRun-unrecorded-trash SessionsAccounted
# active.json до ответа кандидата — краснеет (4).
check UpdateRun-settle-first PinnedAnswered
exit "$failed"
