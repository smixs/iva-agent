#!/bin/sh
# ResetEpoch.tla под TLC с проверкой ожиданий (замечание 3 арбитра T122, D53;
# парные контроли — D65; слот remote-сброса и эпоха на проводе — T341).
# Основной cfg — код dd50c6ad + T325 + T326 + T341: слот на чат сериализует
# выпуски remote и не выпускает вызов за уже упавшую эпоху, а журнал упавших
# эпох у роута отклоняет вызов с эпохой не новее упавшей — запоздалый remote
# после клиентского таймаута (дыра возврата S69) свежий разговор не трёт, cfg
# зелёный. Мутанты ResetEpoch-late-remote / ResetEpoch-late-remote-order
# выключают обе защиты (RemoteSlot = FALSE, WireFence = FALSE) и остаются
# красными: первый по LossOnlyByNewer (запоздалый remote стёр доставленное),
# второй по RemoteInOrder (remote старого намерения упал после remote нового
# /new). Мутант ResetEpoch-remote-timeout выключает только журнал
# (RemoteSlot = TRUE, WireFence = FALSE) и краснеет по LossOnlyByNewer: слот
# один дыру таймаута не закрывает — серверный вызов переживает клиентское
# ожидание.
# Каждый мутант идёт парой с контролем: cfg отличаются одной константой,
# контроль ждёт «No error», мутант — нарушение своего целевого инварианта, не
# задетого remote-дефектом (пара fence проверяется по DropOnlyByNewer — потери
# помеченных записей снятием границей, gone не считается; немаркированная
# ветка от FenceRule не зависит, её потерю показывает свидетель
# ResetEpoch-abandon-loss по DropAllByNewer). Свидетель пропажи намерения и
# свидетель запоздалого remote нарушают свой инвариант первым (поиск в ширину,
# негативные прогоны в один поток — самый короткий контрпример). Любой сбой
# tlc или несовпадение ожидания — ненулевой выход. Файлы состояний TLC пишет
# во временную папку.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "reset-epoch-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-2}
case "$WORKERS" in 1|2|3|4) ;; *) echo "WORKERS must be 1..4"; exit 2;; esac
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant>
  cfg=$1; expect=$2; run="$META/$cfg"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  w=$WORKERS; [ "$expect" = none ] || w=1
  "$TLC" -workers "$w" -deadlock -metadir "$run.states" -config "$run.cfg" ResetEpoch.tla >"$log" 2>&1
  code=$?
  valid=false
  tlc_expect "$log" "$code" "$run.cfg" "$expect" "" && valid=true
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  if [ "$valid" = true ]; then
    if [ "$got" = none ]; then echo "OK $cfg: no error ($states distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; failed=$((failed+1))
  fi
}
check ResetEpoch-fence-geq none
check ResetEpoch-fence-eq DropOnlyByNewer
check ResetEpoch-guards none
check ResetEpoch-no-guards NoStaleInConv
check ResetEpoch-clock-monotone none
check ResetEpoch-clock NoStaleInConv
check ResetEpoch-abandon NoStaleInConv
check ResetEpoch-abandon-loss DropAllByNewer
check ResetEpoch-late-remote-fence none
check ResetEpoch-late-remote LossOnlyByNewer
check ResetEpoch-late-remote-order-fence none
check ResetEpoch-late-remote-order RemoteInOrder
check ResetEpoch-remote-timeout-fence none
check ResetEpoch-remote-timeout LossOnlyByNewer
check ResetEpoch none
echo "reset-epoch-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
