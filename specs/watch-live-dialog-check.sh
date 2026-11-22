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
  mkdir -p "$META/$cfg/tmp"
  JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.io.tmpdir=$META/$cfg/tmp" \
    "$TLC" -workers 1 -deadlock -metadir "$META/$cfg/states" -config "$cfg.cfg" "${3:-WatchLiveDialog}.tla" >"$META/$cfg.log" 2>&1
  code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" "" || { cat "$META/$cfg.log"; return 1; }
  echo "$cfg: TLC exit $code, expected $expected"
  sed -n '/states generated/p' "$META/$cfg.log"
}
check WatchLiveDialog none &&
check WatchLiveDialog-no-window LiveSilence &&
check WatchLiveDialog-peer-window WaitFromOwner &&
check WatchLiveDialog-false-close NoFalseClose &&
check WatchLiveDialog-double-edit NoDoubleEdit &&
check WatchLiveDialog-lost-id NoLostId &&
check WatchLiveRecovery none WatchLiveRecovery &&
check WatchLiveRecovery-retry LiveSilence WatchLiveRecovery &&
check WatchLiveRecovery-stuck RecoverableClose WatchLiveRecovery &&
check WatchLiveRecovery-reapply NoDoubleEdit WatchLiveRecovery &&
check WatchLiveRecovery-truncate HistoryCoversSignal WatchLiveRecovery &&
check WatchReceiptGap none WatchReceiptGap &&
check WatchReceiptGap-no-receipt NoLostId WatchReceiptGap &&
check WatchReceiptGap-unknown-retry NoUnknownRetry WatchReceiptGap
