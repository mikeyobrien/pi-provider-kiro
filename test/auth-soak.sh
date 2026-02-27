#!/usr/bin/env bash
# ABOUTME: Soak test for kiro auth refresh — sends a pi prompt every 15 minutes for 3+ hours.
# ABOUTME: Logs stdout, stderr, and timestamps to /tmp/pi-soak-*.log for post-mortem analysis.

set -euo pipefail

export PATH='/Users/mobrienv/.local/share/mise/installs/node/24.12.0/bin:'"$PATH"

LOG_DIR="/tmp/pi-soak"
mkdir -p "$LOG_DIR"
MAIN_LOG="$LOG_DIR/soak.log"
INTERVAL_SECONDS=900  # 15 minutes
TOTAL_ITERATIONS=13   # 13 × 15min = 3h15m

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$MAIN_LOG"
}

log "=== Auth soak test started ==="
log "Interval: ${INTERVAL_SECONDS}s, Iterations: ${TOTAL_ITERATIONS}"
log "Logs: $LOG_DIR"

for i in $(seq 1 "$TOTAL_ITERATIONS"); do
  log "--- Iteration $i/$TOTAL_ITERATIONS ---"

  STDOUT_LOG="$LOG_DIR/iter-${i}-stdout.log"
  STDERR_LOG="$LOG_DIR/iter-${i}-stderr.log"

  START_TS=$(date +%s)

  # Run pi with a trivial prompt using kiro model
  if pi -p "Reply with only the word 'pong' and nothing else." \
       -m kiro \
       >"$STDOUT_LOG" 2>"$STDERR_LOG"; then
    STATUS="OK"
  else
    STATUS="FAIL (exit $?)"
  fi

  END_TS=$(date +%s)
  ELAPSED=$((END_TS - START_TS))

  STDOUT_PREVIEW=$(head -c 200 "$STDOUT_LOG" 2>/dev/null || echo "(empty)")
  STDERR_PREVIEW=$(head -c 500 "$STDERR_LOG" 2>/dev/null || echo "(empty)")

  log "Status: $STATUS  Duration: ${ELAPSED}s"
  log "stdout: $STDOUT_PREVIEW"
  if [ -s "$STDERR_LOG" ]; then
    log "stderr: $STDERR_PREVIEW"
  fi

  # Check for auth-related errors in stderr
  if grep -qi "refresh\|auth\|token\|401\|403\|expired" "$STDERR_LOG" 2>/dev/null; then
    log ">>> AUTH-RELATED OUTPUT DETECTED IN STDERR <<<"
  fi

  if [ "$i" -lt "$TOTAL_ITERATIONS" ]; then
    log "Sleeping ${INTERVAL_SECONDS}s until next iteration..."
    sleep "$INTERVAL_SECONDS"
  fi
done

log "=== Auth soak test completed ==="
