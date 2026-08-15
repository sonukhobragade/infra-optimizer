#!/usr/bin/env bash
# local_gate.sh — the pre-commit / pre-PR gate.
#
# Run from anywhere in the repo: `bash tools/local_gate.sh`
#
# This is the single gate that must be green before every commit and before
# every PR. If your CI runs the same checks, this mirrors them locally. If CI
# is disabled, this is the ONLY gate.
#
# A red gate is fixed by CORRECTING THE CODE, never by weakening a check.
#
# Each step is a COMMAND STRING run through `bash -c`, so compound commands
# work and their exit status is still captured:
#     step "Lint" 'npm run lint && npm run format:check'
#
# An UNSET or BLANK command is a HARD FAILURE, never a silent pass — a gate
# that reports success while running nothing is worse than no gate. If your
# stack genuinely has no such step, set it to the literal `true` so the intent
# is explicit and visible.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

# ---------------------------------------------------------------------------
# Placeholder env so config modules import without a live environment.
# Add every variable your code reads at import time.
# ---------------------------------------------------------------------------
# export API_BASE="${API_BASE:-http://placeholder}"
# export DB_DSN="${DB_DSN:-postgres://x@placeholder:5432/db}"

fail=0
step_no=0
STEPS=()

# step <name> <command-string>
step() {
  local name="$1"
  local cmd="${2-}"
  step_no=$((step_no + 1))
  printf '\n========== %s/%s %s ==========\n' "$step_no" "${#STEPS[@]}" "$name"

  # Blank / whitespace-only command => misconfiguration, not a pass.
  if [ -z "${cmd//[[:space:]]/}" ]; then
    fail=1
    printf '!! %s NOT CONFIGURED — no command set.\n' "$name"
    printf '   Edit tools/local_gate.sh. Use the literal `true` if this step\n'
    printf '   genuinely does not apply to this stack.\n'
    return
  fi

  printf '$ %s\n' "$cmd"
  if ! bash -c "$cmd"; then
    fail=1
    printf '!! %s FAILED\n' "$name"
  fi
}

# --- steps -----------------------------------------------------------------
# Keep STEPS in sync with the step calls below (used for the N/M counter).
STEPS=(lint build unit scripts collect)

step "Lint"                                 'npx eslint src --ext .js'
# No type checker: this is plain JavaScript with no tsconfig. A production
# build is the real compile-time check available here, and it fails on broken
# imports and syntax errors that eslint alone will not catch.
step "Build"                                'CI=true npm run build'
# CI=true stops react-scripts opening watch mode. No --passWithNoTests: this
# app ships tests now, so "no tests found" means the suite has gone missing
# and should fail rather than report success.
step "Unit tests (no external dependencies)" 'CI=true npm test -- --watchAll=false'
# The data loader lives outside src/, so jest does not see it. It runs on
# node:test and serves its own fixture over localhost, so this stays offline.
step "Loader tests"                         'node --test scripts/*.test.mjs'
# The build above already exercised the whole module graph.
step "Collection smoke"                     'true'

printf '\n========== RESULT ==========\n'
if [ "$fail" -eq 0 ]; then
  echo "✓ local gate PASSED — safe to commit / open PR"
else
  echo "✗ local gate FAILED — fix above before committing (do NOT weaken checks)"
fi
exit "$fail"
