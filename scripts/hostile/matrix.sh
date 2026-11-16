#!/usr/bin/env bash
# Every stack through every hostile set, slow and rapid toggles, $RUNS times each
# (scripts/hostile/README.md). Each run restarts the relays with a new seed.
# Usage: RUNS=2 OUT=/tmp/hostile/matrix.jsonl scripts/hostile/matrix.sh [stack ...]
set -u
cd "$(dirname "$0")/../.."
RUNS=${RUNS:-2}
OUT=${OUT:-/tmp/hostile/matrix.jsonl}
STACKS=${*:-vector armada mixed-a-holder mixed-a-member}
mkdir -p /tmp/hostile
for run in $(seq 1 "$RUNS"); do
  for set in hostile brutal; do
    for gap in 30000 4000; do
      for stack in $STACKS; do
        seed=$((run * 1000 + ${#set} * 10 + gap / 1000))
        node scripts/hostile/relay.mjs --control 7100 --relays calm --tls scripts/hostile/tls --seed "$seed" > /tmp/hostile/relay.log 2>&1 &
        relay=$!
        sleep 1
        echo "== run $run $stack $set gap=$gap seed=$seed"
        timeout 1500 node scripts/hostile/compare.mjs --stack "$stack" --set "$set" --channels 4 --gap "$gap" \
          --deadline 300000 --heal 180000 --out "$OUT" 2>&1 | grep -E "keyed|converged|after healing|ERROR"
        kill "$relay" 2>/dev/null
        wait "$relay" 2>/dev/null
      done
    done
  done
done
