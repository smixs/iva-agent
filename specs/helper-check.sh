#!/bin/sh
# Helpers v7.3: tick-owned outcomes, bounded finish, adversarial durable kernel. BFS, <=4 workers.
# CHECK_MODE=simulate проверяет запуск и случайные трассы, без полного BFS.
set -u
JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS:--Xmx3g}
export JAVA_TOOL_OPTIONS
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
ROOT=$(cd .. && pwd) || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
[ -x "$TLC" ] || { echo 'helper-check: tlc not found (set TLC=/path/to/tlc)'; exit 2; }
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TIMEOUT" ] || { echo 'helper-check: GNU timeout required (set TIMEOUT=/path/to/timeout)'; exit 2; }
WORKERS=${WORKERS:-4}
case "$WORKERS" in 1|2|3|4) ;; *) echo "helper-check: WORKERS must be 1..4"; exit 2;; esac
CHECK_MODE=${CHECK_MODE:-bfs}
case "$CHECK_MODE" in bfs|simulate) ;; *) echo 'helper-check: CHECK_MODE must be bfs or simulate'; exit 2;; esac
mkdir -p "$ROOT/.scratch/helper-tla" || exit 2
META=$(mktemp -d "$ROOT/.scratch/helper-tla/check.XXXXXX") || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
selected=${HELPER_CONFIGS:-all}
ok=0; failed=0
wait_load() {
  command -v sysctl >/dev/null 2>&1 || return 0
  while :; do
    load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/, ""); print $1}')
    [ -n "$load" ] || return 0
    awk -v n="$load" 'BEGIN {exit !(n < 20)}' && return 0
    echo "WAIT load=$load; need <20"
    sleep 10
  done
}
check() {
  cfg=$1; expect=$2; module=${cfg%%-*}; log="$META/$cfg.log"
  case " $selected " in ' all '|*" $cfg "*) ;; *) return 0;; esac
  workers=$WORKERS; [ "$expect" = none ] || workers=1
  echo "RUN $cfg: expected=$expect; mode=$CHECK_MODE; workers=$workers; timeout=${TLC_TIMEOUT:-600}s"
  # В переднем плане. timeout ограничивает каждый Java-процесс, TERM -> KILL через 5s.
  # -deadlock отключает проверку тупика: конечные replay заканчиваются stutter.
  if [ "$CHECK_MODE" = simulate ]; then
    set -- -simulate "num=${SIM_TRACES:-1000}" -depth "${SIM_DEPTH:-100}" -seed "${SIM_SEED:-20261011}"
  else
    # Check temporal properties once after BFS, rather than repeatedly on partial graphs.
    set -- -fp 1 -seed "${BFS_SEED:-20261013}"
    [ "$expect" != none ] || set -- "$@" -lncheck final
  fi
  wait_load
  echo "LOAD $cfg: ${load:-unavailable}; required <20"
  "$TIMEOUT" --foreground --kill-after=5s "${TLC_TIMEOUT:-600}s" "$TLC" "$@" \
    -workers "$workers" -deadlock -metadir "$META/$cfg.states" \
    -config "$cfg.cfg" "$module.tla" >"$log" 2>&1
  code=$?
  valid=false
  tlc_expect "$log" "$code" "$cfg.cfg" "$expect" "" "${CHECK_MODE:-bfs}" && valid=true
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  checked=$(sed -n 's/^Progress: \([0-9,]*\) states checked.*/\1/p' "$log" | tail -1)
  elapsed=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$log" | tail -1)
  if [ -n "${LOG_DIR:-}" ]; then
    mkdir -p "$LOG_DIR" || return 2
    cp "$log" "$LOG_DIR/$cfg.log" || return 2
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cfg" "$expect" "${got:-error}" "$code" "${states:-unknown}" "${elapsed:-unknown}" "${load:-unavailable}" >> "$LOG_DIR/results.tsv"
  fi
  if [ "$valid" = true ]; then
    echo "OK $cfg: $got; mode=$CHECK_MODE; exit=$code; distinct=${states:-unknown}; checked=${checked:-unknown}; time=${elapsed:-unknown}"
    ok=$((ok+1))
  else
    echo "FAIL $cfg: expected=$expect; got=${got:-infrastructure/error}; mode=$CHECK_MODE; exit=$code"
    sed -n '1,30p' "$log"
    failed=$((failed+1))
    [ -n "$got" ] || return 2
  fi
}
check HelperRun-v73-stop-before-end StopOnlyWhileRunning || exit 2
check HelperRun-v73-stop-needs-snapshot StopCancelSent || exit 2
check HelperRun-v73-end-cutoff SnapshotFolded || exit 2
check HelperRun-v72-run none || exit 2
check HelperRun-v72-silent none || exit 2
check HelperRun-v72-restart none || exit 2
check HelperRun-v72-quarantine none || exit 2
check HelperRun-v72-cancel-failure none || exit 2
check HelperRun-v72-snapshot-failure none || exit 2
check HelperRun-v72-lost-id none || exit 2
check HelperRun-v72-record-failure none || exit 2
check HelperRun-v72-capacity none || exit 2
check HelperRun-capacity3 none || exit 2
check HelperRun-capacity3-reach CapacityNotFull || exit 2
check HelperRun-no-running-cap RunningBounded || exit 2
check HelperRun-v72-reminder-busy none || exit 2
check HelperRun-v72-cancel-finish OutcomeJustified || exit 2
check HelperRun-v72-no-ceiling BoundedEnd || exit 2
check HelperRun-v72-restart-undelivered RestartDelivered || exit 2
check HelperRun-v72-finalize-twice OutcomeOnce || exit 2
check HelperRun-v72-stop-overwrite StopOnce || exit 2
check HelperRun-v72-wrong-event OutcomeMatches || exit 2
check HelperRun-v72-drop-text PartialKept || exit 2
check HelperRun-v72-work-output WorkMeasured || exit 2
check HelperRun-v72-no-ceiling-live NoSilentEnd || exit 2
check HelperRun-v72-shared-schedule NoSilentEnd || exit 2
check HelperRun-v72-detached-work NoDetachedWork || exit 2
check HelperOutcome-slots none || exit 2
check HelperOutcome-goal-no-eviction GoalAdmissionAvailable || exit 2
check HelperOutcome-goal-evict-unread ProtectedKept || exit 2
check HelperOutcome-evict-closed-blocked ClosedAdmissionAvailable || exit 2
check HelperOutcome-evict-unread ProtectedKept || exit 2
check HelperOutcome-evict-goal ProtectedKept || exit 2
check HelperOutcome-evict-newest OldestEvicted || exit 2
check HelperOutcome-close-goal ProtectedKept || exit 2
check HelperOutcome-admission NoAdmission || exit 2
check HelperOutcome-delivered-close NoDeliveredClose || exit 2
check HelperOutcome-foreign-read AuthorizedReads || exit 2
check HelperOutcome-offline-event OfflineEvent || exit 2
check HelperOutcome-bridge-recovery none || exit 2
check HelperOutcome-bridge-stays-down BridgeRecovered || exit 2
check HelperOutcome-recovery-complete NoRecoveryComplete || exit 2
check HelperOutcome-safety none || exit 2
check HelperOutcome-finish-twice OutcomeOnce || exit 2
check HelperOutcome-before-reply DeliveredAfterReply || exit 2
check HelperOutcome-empty-reply DeliveredAfterReply || exit 2
check HelperOutcome-without-read DeliveredAfterReply || exit 2
check HelperOutcome-turn-only DeliveredAfterReply || exit 2
check HelperOutcome-lose-unread UndeliveredKept || exit 2
check HelperOutcome-hide-unread Visible || exit 2
check HelperOutcome-early-close ClosedKept || exit 2
check HelperOutcome-read-write ReadPure || exit 2
check HelperOutcome-multiple NoTwoReads || exit 2
check HelperOutcome-restart NoRepeatedRead || exit 2
[ "$ok" -gt 0 ] || { echo 'helper-check: no configuration selected'; exit 2; }
if [ "$selected" != all ]; then
  wanted=0
  for cfg in $selected; do wanted=$((wanted+1)); done
  [ "$ok" -eq "$wanted" ] || { echo 'helper-check: unknown or duplicate configuration'; exit 2; }
fi
echo "helper-check: ok=$ok failed=$failed"
[ "$failed" -eq 0 ]
