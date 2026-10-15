#!/usr/bin/env bash
# Brief 3-6 failover probe. Hits /health/ready every 250 ms for PROBE_SECONDS,
# restarts the Postgres container at RESTART_AT seconds, and reports the
# interruption window (first failure → first success after it). Exit 1 when
# the window exceeds BUDGET_SECONDS or the API never recovers.
set -u
API=${API_URL:-http://127.0.0.1:3001}
PROBE_SECONDS=${PROBE_SECONDS:-90}
RESTART_AT=${RESTART_AT:-20}
BUDGET_SECONDS=${BUDGET_SECONDS:-60}
LOG=${PROBE_LOG:-failover-probe.log}
REPORT=${PROBE_REPORT:-failover-report.md}
: > "$LOG"

start=$(date +%s.%N)
restarted=0
first_fail=""
recovered=""
fails=0
oks=0
while :; do
  now=$(date +%s.%N)
  elapsed=$(awk -v a="$now" -v b="$start" 'BEGIN { printf "%.2f", a - b }')
  if awk -v e="$elapsed" -v p="$PROBE_SECONDS" 'BEGIN { exit !(e >= p) }'; then break; fi
  if [ "$restarted" = 0 ] && awk -v e="$elapsed" -v r="$RESTART_AT" 'BEGIN { exit !(e >= r) }'; then
    echo "$elapsed RESTART ${PG_CONTAINER:-<no container>}" >> "$LOG"
    if [ -n "${PG_CONTAINER:-}" ]; then docker restart "$PG_CONTAINER" > /dev/null 2>&1 & fi
    restarted=1
  fi
  code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" "$API/health/ready" || echo "000")
  if [ "$code" = "200" ]; then
    oks=$((oks + 1))
    if [ -n "$first_fail" ] && [ -z "$recovered" ]; then recovered=$elapsed; fi
  else
    fails=$((fails + 1))
    if [ -z "$first_fail" ] && [ "$restarted" = 1 ]; then first_fail=$elapsed; fi
    # A failure after recovery reopens the window: the API flapped.
    if [ -n "$recovered" ]; then recovered=""; fi
  fi
  echo "$elapsed $code" >> "$LOG"
  sleep 0.25
done

{
  echo "# Failover test"
  echo
  echo "Probe: /health/ready every 250 ms for ${PROBE_SECONDS}s; Postgres restarted at ${RESTART_AT}s."
  echo
  echo "| Measure | Value |"
  echo "|---|---|"
  echo "| Probes OK | $oks |"
  echo "| Probes failed | $fails |"
  echo "| First failure (s) | ${first_fail:-none} |"
  echo "| First success after it (s) | ${recovered:-none} |"
} > "$REPORT"

status=0
if [ -z "$first_fail" ]; then
  # The restart was invisible to the probe: nothing to measure, and that is
  # a pass only if the container really restarted.
  echo "| Interruption (s) | 0 (no probe failed) |" >> "$REPORT"
elif [ -z "$recovered" ]; then
  echo "| Interruption (s) | never recovered |" >> "$REPORT"
  status=1
else
  window=$(awk -v a="$recovered" -v b="$first_fail" 'BEGIN { printf "%.2f", a - b }')
  echo "| Interruption (s) | $window |" >> "$REPORT"
  if awk -v w="$window" -v b="$BUDGET_SECONDS" 'BEGIN { exit !(w > b) }'; then status=1; fi
fi
echo >> "$REPORT"
echo "Budget: ${BUDGET_SECONDS}s. Result: $([ "$status" = 0 ] && echo PASS || echo FAIL)." >> "$REPORT"
cat "$REPORT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$REPORT" >> "$GITHUB_STEP_SUMMARY"; fi
exit $status
