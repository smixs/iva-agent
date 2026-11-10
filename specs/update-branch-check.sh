#!/bin/sh
# UpdateBranch.tla под TLC: одна запись решает, какую версию ставит обновление; чтение
# чинит расхождение с кэшем; назад обновление не ходит (ADR-0018). Мутанты краснеют на
# своих инвариантах. Третий аргумент — инварианты, снятые с прогона, когда один мутант
# ломает два правила сразу. Любой сбой TLC или другой вердикт — ненулевой код выхода.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "update-branch-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
failed=0
check() { # config expected [dropped invariants]
  cfg=$1; expect=$2; drop=${3:-}
  run="$META/$cfg$(printf %s "$drop" | tr ' ' '-')"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  for inv in $drop; do
    sed "/^INVARIANTS/s/ $inv\$//; /^INVARIANTS/s/ $inv / /" "$run.cfg" >"$run.tmp" && mv "$run.tmp" "$run.cfg"
    if grep -Eq "^INVARIANTS.* $inv( |\$)" "$run.cfg"; then
      echo "FAIL $cfg: could not drop $inv"; failed=1; return
    fi
  done
  cp UpdateBranch.tla "$META/"
  (cd "$META" && "$TLC" -workers 1 -deadlock -metadir "$run.states" -config "$run.cfg" UpdateBranch.tla) >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$run.cfg" "$expect" ""; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg${drop:+ without $drop}: $got violated (expected)"; fi
  else
    echo "FAIL $cfg: exit $code, got '${got:-error}', expected '$expect'"
    cat "$log"
    failed=1
  fi
}
check UpdateBranch none
# Откат не прошёл, но чтение чинит расхождение: ошибок нет.
check UpdateBranch-partial none
# Запись в установку без зеркала и без починки при чтении — краснеют (1) и (2).
check UpdateBranch-one-sided OneRecord
check UpdateBranch-one-sided AgreeAfterRead "OneRecord"
# Обе записи есть, откат не прошёл, чтение не чинит — те же два правила.
check UpdateBranch-no-repair OneRecord
check UpdateBranch-no-repair AgreeAfterRead "OneRecord"
# Обновление ниже установленного — краснеет (3).
check UpdateBranch-back NotBelow
exit "$failed"
