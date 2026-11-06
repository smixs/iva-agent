#!/bin/sh
# IdleCompaction.tla под TLC с проверкой ожиданий. Основные модели кода (queue, steer, с
# перезапуском и без, с запоздалой просьбой) и предложенная починка R5 — без ошибок; находки
# (F2–F4, F6, F7) и свидетели-мутанты нарушают свой инвариант первым (поиск в ширину — самый короткий
# контрпример). Нарушение свойства живости называется по единственному свойству в строке
# PROPERTIES конфига. Любой сбой tlc или несовпадение ожидания — ненулевой выход. Файлы состояний TLC пишет во временную папку.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "idle-compaction-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-2}
case "$WORKERS" in 1|2|3|4) ;; *) echo "WORKERS must be 1..4"; exit 2;; esac
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant or property>
  cfg=$1; expect=$2; run="$META/$cfg"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  # Свидетель — в один поток: порядок инвариантов на одной глубине не плавает.
  w=$WORKERS; [ "$expect" = none ] || w=1
  "$TLC" -workers "$w" -deadlock -metadir "$run.states" -config "$run.cfg" IdleCompaction.tla >"$log" 2>&1
  code=$?
  valid=false
  tlc_expect "$log" "$code" "$run.cfg" "$expect" "" && valid=true
  if [ "$valid" = true ]; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; failed=$((failed+1))
  fi
}
check IdleCompaction none
check IdleCompaction-manual-open ManualOutsideTurn
check IdleCompaction-manual-postturn CompactionGuarded
check IdleCompaction-steer none
check IdleCompaction-cancelmark NoCancelMarkForCompaction
check IdleCompaction-cancelmark-steer NoCancelMarkForCompaction
check IdleCompaction-restart none
check IdleCompaction-restart-steer none
check IdleCompaction-restart-guarded CompactionGuarded
check IdleCompaction-r5 none
check IdleCompaction-r5-steer none
check IdleCompaction-window QueuedInRequestWindow
check IdleCompaction-window-restart NoHangInRequestWindow
check IdleCompaction-silentloss NoSilentLoss
check IdleCompaction-inbox InboxEmptyWhileCompacting
check IdleCompaction-turnhang NoTurnHangAfterRestart
check IdleCompaction-void none
check IdleCompaction-offfail OffOnlyAfterUselessCompaction
check IdleCompaction-nobeginclaim CompactionGuarded
check IdleCompaction-noaskguard NoStackedCompaction
check IdleCompaction-releasebysession TurnRecordKept
check IdleCompaction-noclaim QueuedWhileCompacting
check IdleCompaction-noopenguard OffOnlyAfterUselessCompaction
check IdleCompaction-noisyreap NoFalseInterruptNotice
check IdleCompaction-turnkeeps CompactingNeverInTurn
check IdleCompaction-dueagain AtMostOneAskPerTurn
check IdleCompaction-offnotchecked NoAskWhileOff
check IdleCompaction-repliesdirect QueuedWhileCompacting
check IdleCompaction-noparkrelease none
check IdleCompaction-noreap ChatFreed
echo "idle-compaction-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
