#!/usr/bin/env bash
# Final AC-power matrix. after = current tree (:3013), before = 1669abb packages + same harness (:3014).
# Streamdown runs on :3013 (identical Streamdown package; docs prose CSS includes the selector fix).
set -u
RUN="$(cd "$(dirname "$0")" && pwd)"
OUT="$RUN/final"
mkdir -p "$OUT"
LOG="$OUT/matrix.log"
run() {
  local label=$1 renderer=$2 base=$3 worktree=$4 fixture=$5 scenario=$6
  echo "$(date -u +%FT%TZ) start $label $fixture $scenario $(pmset -g batt | sed -n 1p)" >>"$LOG"
  if npx tsx scripts/perf/run-perf-harness.ts --baseUrl "$base" --renderer "$renderer" --worktree "$worktree" \
    --fixture "$fixture" --scenario "$scenario" --runs 3 --warmup 1 --timeout 900000 --out "$OUT/$label" >>"$OUT/$label.log" 2>&1; then
    echo "$(date -u +%FT%TZ) ok $label $fixture $scenario" >>"$LOG"
  else
    echo "$(date -u +%FT%TZ) FAIL $label $fixture $scenario" >>"$LOG"
  fi
}
for fixture in code-huge stress-mega stress-mega-footnotes stress-xl; do
  for scenario in S9_firehose_20k S8_firehose_10k S7_firehose_5k; do
    run after streammdx http://127.0.0.1:3013 "$PWD" "$fixture" "$scenario"
    run streamdown streamdown http://127.0.0.1:3013 "$PWD" "$fixture" "$scenario"
    if [ "$scenario" = S9_firehose_20k ]; then
      run before streammdx http://127.0.0.1:3014 /tmp/ev2-head "$fixture" "$scenario"
    fi
  done
done
echo "$(date -u +%FT%TZ) done" >>"$LOG"
