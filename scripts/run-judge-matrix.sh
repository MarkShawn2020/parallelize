#!/usr/bin/env bash
# One executor row of the judge matrix: the same 96 hard tasks, the same 8-cell swarm, every judge in turn.
# Usage: scripts/run-judge-matrix.sh <executor model> [seed]   e.g. scripts/run-judge-matrix.sh anthropic/claude-sonnet-5
# The executor solves and writes genes; the judge decides review, adoption and disputes. A shell LLM_MODEL wins over .env.
# Then: pnpm matrix --seed <seed>
set -euo pipefail
cd "$(dirname "$0")/.."

EXECUTOR=${1:?usage: scripts/run-judge-matrix.sh <executor model> [seed]}
SEED=${2:-7}

bench() {
  LLM_MODEL="$EXECUTOR" node_modules/.bin/tsx --env-file-if-exists=.env src/cli/bench.ts \
    --n 96 --cells 8 --seed "$SEED" --difficulty hard --max-cost 1.5 "$@"
}

bench --mode swarm-rules
bench --mode swarm-jev --escalation 0
bench --mode swarm-llm --judge-model anthropic/claude-haiku-4.5
bench --mode swarm-llm --judge-model anthropic/claude-sonnet-5
bench --mode swarm-llm --judge-model anthropic/claude-opus-5
