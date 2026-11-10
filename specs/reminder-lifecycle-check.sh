#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
mkdir -p ../.scratch/reminder-lifecycle
meta=$(mktemp -d ../.scratch/reminder-lifecycle/tlc.XXXXXX)
trap 'rm -rf "$meta"' EXIT
check() {
  config=$1; expected=$2
  code=0
  "${TLC:-$HOME/.local/bin/tlc}" -workers 1 -deadlock -metadir "$meta/$config" -config "$config.cfg" ReminderLifecycle.tla >"$meta/$config.log" 2>&1 || code=$?
  tlc_expect "$meta/$config.log" "$code" "$config.cfg" "$expected" "" bfs || { cat "$meta/$config.log"; exit 1; }
  echo "$config: $expected (exit $code)"
}
check ReminderLifecycle none
check ReminderLifecycle-routine none
check ReminderLifecycle-nopickup BoundedOutcome
check ReminderLifecycle-nopickup-live EveryFiringConcludes
check ReminderLifecycle-resend OneAttemptPerCapture
check ReminderLifecycle-stale FactOfThisFiring
check ReminderLifecycle-recapture OncePerDue
check ReminderLifecycle-sweepopen DeliveredOrReason
check ReminderLifecycle-closelive NoFalseAlert
check ReminderLifecycle-alertblind NoFalseAlert
check ReminderLifecycle-nofact AlertOnce
check ReminderLifecycle-forget AbandonedAlerted
check ReminderLifecycle-sweepfirst AlertBeforeDrop
check ReminderLifecycle-takefirst AlertBeforeDrop
check ReminderLifecycle-retryblind NoFalseAlert
