#!/bin/bash
# Repeat the one caret-stability configuration that has flaked in the release gate.
# Usage: scripts/caret-stability-loop.sh [runs] [logdir]
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNS=${1:-30}
LOGDIR=${2:-"$ROOT/.caret-stability-loop/$(date -u +%Y%m%dT%H%M%SZ)"}

if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "runs must be a positive integer (got: $RUNS)" >&2
  exit 2
fi

mkdir -p "$LOGDIR"
failed_runs=0
failed_checks=0

echo "caret-playmaker-suggesting-1440: $RUNS runs"
echo "logs: $LOGDIR"

for ((run = 1; run <= RUNS; run += 1)); do
  log="$LOGDIR/run-$run.log"
  echo "[$run/$RUNS] starting"
  if node "$ROOT/scripts/caret-stability-check.mjs" \
      --style playmaker --mode suggesting --device desktop \
      --shots "$LOGDIR" >"$log" 2>&1; then
    echo "[$run/$RUNS] PASS"
  else
    status=$?
    failures=$(grep -c '^FAIL ' "$log" || true)
    failed_runs=$((failed_runs + 1))
    failed_checks=$((failed_checks + failures))
    echo "[$run/$RUNS] FAIL (exit $status, $failures failed checks; $log)"
  fi
done

echo "summary: $failed_runs/$RUNS runs failed; $failed_checks failed checks"
exit "$failed_runs"
