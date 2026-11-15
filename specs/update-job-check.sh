#!/bin/sh
# UpdateJob.tla под TLC: исход задания обновления читается из журнала хода, у хода без
# журнала остаются четыре источника, каждый мутант краснеет на своём инварианте первым.
# Любой сбой TLC или другой вердикт — ненулевой код выхода.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "update-job-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected
  cfg=$1; expect=$2
  workers=${WORKERS:-2}; [ "$expect" = none ] || workers=1
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" UpdateJob.tla >"$META/$cfg.log" 2>&1
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
check UpdateJob none
# Ход, начатый версией без журнала (обновление с 0.5.0-0.5.11): четыре источника.
check UpdateJob-no-journal none
# Итог по одному симлинку `current` — краснеет (1).
check UpdateJob-symlink-only FinalOnlyWhenPinned
# Файл задания пережил отправленный итог — краснеет (3).
check UpdateJob-shown-twice ShownOnce
exit "$failed"
