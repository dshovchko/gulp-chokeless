#!/usr/bin/env bash
set -euo pipefail

# Switch to project root so paths like ./node_modules and ./dist resolve correctly
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# Ensure required tools are available
if ! command -v hyperfine >/dev/null 2>&1; then
  echo "Error: 'hyperfine' is required but not installed. See https://github.com/sharkdp/hyperfine" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' is required but not installed." >&2
  exit 1
fi

# Ensure dependencies and dist are built
echo "Checking dependencies and building project for benchmarks..."
if [ ! -d "node_modules" ]; then
  npm install > /dev/null
fi
if [ ! -d "benchmarks/node_modules" ]; then
  npm install --prefix benchmarks > /dev/null
fi
npm run build > /dev/null

# Detect default concurrency (75% of cores, at least 1)
CORES=$(node -e "const os = require('os'); console.log(Math.max(1, Math.floor(os.cpus().length * 0.75)))")
CONCURRENCY=$CORES
SCENARIO=""
PATTERN=""
EXPORT_FILE=""

# Parse arguments
require_value() {
  if [[ $# -lt 2 || -z "${2:-}" || "${2:0:1}" == "-" ]]; then
    echo "Error: option '$1' requires a value" >&2
    exit 1
  fi
}

while [[ "$#" -gt 0 ]]; do
  case $1 in
    -c|--concurrency) require_value "$@"; CONCURRENCY="$2"; shift ;;
    -c=*) CONCURRENCY="${1#*=}" ;;
    -s|--scenario) require_value "$@"; SCENARIO="$2"; shift ;;
    -s=*) SCENARIO="${1#*=}" ;;
    -p|--pattern) require_value "$@"; PATTERN="$2"; shift ;;
    -p=*) PATTERN="${1#*=}" ;;
    -e|--export) require_value "$@"; EXPORT_FILE="$2"; shift ;;
    -e=*) EXPORT_FILE="${1#*=}" ;;
    *) echo "Error: unknown argument '$1'" >&2; exit 1 ;;
  esac
  shift
done

if [[ -z "$SCENARIO" || -z "$PATTERN" ]]; then
   echo "Usage: ./benchmarks/run-bench.sh -s <scenario_dir> -p <glob_pattern> [-c concurrency] [-e export.md]"
   exit 1
fi

if ! [[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: concurrency must be a positive integer (got '$CONCURRENCY')" >&2
  exit 1
fi

echo "=========================================================="
echo "Benchmarking scenario: $SCENARIO"
echo "Target glob pattern:   $PATTERN"
echo "Concurrency:           $CONCURRENCY"
if [[ -n "$EXPORT_FILE" ]]; then
echo "Exporting results to:  $EXPORT_FILE"
fi
echo "=========================================================="

HYPERFINE_OPTS=(
  --prepare 'sleep 1'
  --warmup 1
  --runs 5
)

if [[ -n "$EXPORT_FILE" ]]; then
  EXPORT_DIR=$(dirname "$EXPORT_FILE")
  if [[ "$EXPORT_DIR" != "." ]]; then
    mkdir -p "$EXPORT_DIR"
  fi
  HYPERFINE_OPTS+=(--export-markdown "$EXPORT_FILE")
fi

# Common env exported into every benchmark command so the gulpfiles
# pick up the requested glob pattern and concurrency. Use printf %q to
# safely escape values that may contain shell metacharacters.
printf -v COMMON_ENV 'BENCH_PATTERN=%q CONCURRENCY=%q' "$PATTERN" "$CONCURRENCY"

GULP_BIN="./benchmarks/node_modules/.bin/gulp"

BENCH_CMDS=(
  -n 'gulp single-thread (inline transform)' \
    "$COMMON_ENV $GULP_BIN --gulpfile ./benchmarks/$SCENARIO/gulpfile-single.mjs --cwd . default"
  -n 'gulp + gulp-chokeless (multithreaded)' \
    "$COMMON_ENV $GULP_BIN --gulpfile ./benchmarks/$SCENARIO/gulpfile-multi.mjs --cwd . default"
)

hyperfine "${HYPERFINE_OPTS[@]}" "${BENCH_CMDS[@]}"

# On Windows (Git Bash / MSYS2) the npm script runner may open a separate
# console window that closes as soon as the process exits, swallowing all
# output. Only pause for interactive terminal sessions, and allow callers
# to disable the prompt explicitly with NO_PAUSE=1.
case "$OSTYPE" in
  msys*|cygwin*|mingw*)
    if [[ "${NO_PAUSE:-0}" != "1" && -t 0 && -t 1 ]]; then
      echo ""
      read -r -p "Press Enter to continue..."
    fi
    ;;
esac
