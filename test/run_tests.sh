#!/bin/bash
# pish test runner
#
# Usage:
#   bash test/run_tests.sh              # all tests (fast + slow)
#   bash test/run_tests.sh fast         # fast only (~6s, no pi needed)
#   bash test/run_tests.sh slow         # slow only (needs real pi)
#   bash test/run_tests.sh bash         # all bash tests
#   bash test/run_tests.sh zsh          # all zsh tests
#   bash test/run_tests.sh bash fast    # bash fast only
#   bash test/run_tests.sh <name>       # single test by name (both shells)
#   bash test/run_tests.sh bash <name>  # single test, one shell

set -euo pipefail
cd "$(dirname "$0")/.."

LOGDIR=$(mktemp -d)
TOTAL_PASS=0
TOTAL_FAIL=0

# ═══════════════════════════════════════
# Test registry
# ═══════════════════════════════════════
# Pipe-delimited: name|tier|expect_file|assertion1§assertion2§...
# Tier: fast (no pi) or slow (needs real pi, auto-retry on failure)
# Use § as assertion delimiter (assertions can contain spaces)

TESTS=(
  # ── Shell suite (run for each shell) ──

  'start_exit|fast|test/scenarios/start_exit.exp|event=start,shell=__SHELL__§event=shell_ready§event=exit§order:start,shell_ready§order:shell_ready,exit§absent:error'
  'normal_cmd|fast|test/scenarios/normal_cmd.exp|event=context,output=~hello_pish,rc=0§event=context,rc=1§count:context=2'
  'empty_enter|fast|test/scenarios/empty_enter.exp|event=context_skip,reason=no_c§count:context=1§event=context,output=~after_empty'
  'exit_codes|fast|test/scenarios/exit_codes.exp|event=context,rc=1§event=context,rc=42§event=context,rc=0'
  'alt_screen|fast|test/scenarios/alt_screen.exp|event=context,output=[full-screen app]'
  'context_clear|fast|test/scenarios/context_clear.exp|event=context§event=context_clear'
  'context_limit|fast|test/scenarios/context_limit.exp|count:context=5§event=exit,context_count=3'
  'nesting|fast|test/scenarios/nesting.exp|event=context,output=~already running'
  'output_truncation|fast|test/scenarios/output_truncation.exp|event=context,output=~truncated'
  'control_cmd|fast|test/scenarios/control_cmd.exp|event=control,cmd=/compact§event=control,cmd=/model sonnet§event=control,cmd=/think high'
  'agent_cnf|slow|test/scenarios/agent_cnf.exp|event=agent,cmd=pish_test_agent hello§event=agent_done,cmd=pish_test_agent hello§count:agent=1'
  'agent_abort|slow|test/scenarios/agent_abort.exp|event=agent§event=agent_abort§absent:agent_done'
  'agent_then_normal|slow|test/scenarios/agent_then_normal.exp|event=agent§event=agent_done§event=context,output=~after_agent'
  'control_cmd_feedback|slow|test/scenarios/control_cmd_feedback.exp|event=control,cmd=/model sonnet§event=control,cmd=/think high'
  'reverse|slow|test/scenarios/reverse.exp|event=reverse'
  'reverse_done|slow|test/scenarios/reverse_done.exp|event=agent§event=agent_done§event=reverse§event=reverse_done'
)

# Edge tests (no shell variant, run once)
EDGE_TESTS=(
  'bad_shell|fast|test/scenarios/bad_shell.exp|'
  'pi_crash|fast|test/scenarios/pi_crash.exp|event=agent,cmd=pish_test_agent hello§event=agent_error§absent:agent_done'
  'pi_not_found|fast|test/scenarios/pi_not_found.exp|event=agent,cmd=pish_test_agent hello§event=agent_error§absent:agent_done'
)

# ═══════════════════════════════════════
# Core runner
# ═══════════════════════════════════════

run_test_once() {
  local shell="$1"
  local expect_file="$2"
  local checks_str="$3"  # §-delimited assertions

  local logfile="$LOGDIR/${shell}_$$.jsonl"
  rm -f "$logfile"

  # Run expect
  if ! PISH_LOG="$logfile" PISH_SHELL="$shell" PISH_NORC=1 expect "$expect_file" >/dev/null 2>&1; then
    return 1
  fi

  # No assertions = expect-only
  if [[ -z "$checks_str" ]]; then
    return 0
  fi

  # Substitute __SHELL__
  checks_str="${checks_str//__SHELL__/$shell}"

  # Split by §
  local -a checks=()
  IFS='§' read -ra checks <<< "$checks_str"

  # Verify
  if ! node dist/test/verify.js "$logfile" "${checks[@]}" >/dev/null 2>&1; then
    node dist/test/verify.js "$logfile" "${checks[@]}" 2>&1 | sed 's/^/    /'
    return 1
  fi

  return 0
}

run_test() {
  local shell="$1"
  local name="$2"
  local tier="$3"
  local expect_file="$4"
  local checks_str="$5"

  echo -n "  $name ... "

  if run_test_once "$shell" "$expect_file" "$checks_str"; then
    echo "PASS"
    TOTAL_PASS=$((TOTAL_PASS + 1))
    return
  fi

  # Auto-retry slow tests once (flaky due to LLM/network)
  if [[ "$tier" == "slow" ]]; then
    echo -n "RETRY ... "
    if run_test_once "$shell" "$expect_file" "$checks_str"; then
      echo "PASS"
      TOTAL_PASS=$((TOTAL_PASS + 1))
      return
    fi
  fi

  echo "FAIL"
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
}

# ═══════════════════════════════════════
# Parse arguments
# ═══════════════════════════════════════

FILTER_SHELL=""
FILTER_TIER=""
FILTER_NAME=""

for arg in "$@"; do
  case "$arg" in
    bash|zsh)  FILTER_SHELL="$arg" ;;
    fast|slow) FILTER_TIER="$arg" ;;
    *)         FILTER_NAME="$arg" ;;
  esac
done

# Detect available shells (macOS ships bash 3.2 which is too old)
AVAIL_SHELLS=()
for s in bash zsh; do
  if [[ -n "$FILTER_SHELL" && "$s" != "$FILTER_SHELL" ]]; then continue; fi
  if $s -c 'true' 2>/dev/null; then
    if [[ "$s" == "bash" ]]; then
      local_ver=$($s -c 'echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}')
      major=${local_ver%%.*}
      minor=${local_ver#*.}
      if [[ $major -lt 4 || ( $major -eq 4 && $minor -lt 4 ) ]]; then
        echo "# Skipping bash ($local_ver < 4.4)"
        continue
      fi
    fi
    AVAIL_SHELLS+=("$s")
  fi
done
SHELLS=("${AVAIL_SHELLS[@]}")

# Edge tests use the first available shell
EDGE_SHELL="${SHELLS[0]:-bash}"

# ═══════════════════════════════════════
# Build
# ═══════════════════════════════════════

echo "Building..."
npm run build --silent 2>&1

# ═══════════════════════════════════════
# Unit tests (always run unless filtering by name/shell)
# ═══════════════════════════════════════

if [[ -z "$FILTER_NAME" && -z "$FILTER_SHELL" && "$FILTER_TIER" != "slow" ]]; then
  echo ""
  echo "── unit tests ──"
  unit_output=$(npx tsx --test test/unit/*.test.ts 2>&1)
  unit_pass=$(echo "$unit_output" | grep '^ℹ pass' | awk '{print $3}')
  unit_fail=$(echo "$unit_output" | grep '^ℹ fail' | awk '{print $3}')
  if [[ "$unit_fail" == "0" ]]; then
    echo "  ${unit_pass} tests ... PASS"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  unit tests ... FAIL"
    echo "$unit_output" | sed 's/^/    /'
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
fi

# ═══════════════════════════════════════
# Run shell suite
# ═══════════════════════════════════════

for shell in "${SHELLS[@]}"; do
  first=true
  for entry in "${TESTS[@]}"; do
    IFS='|' read -r name tier expect_file checks <<< "$entry"

    # Filters
    [[ -n "$FILTER_NAME" && "$name" != "$FILTER_NAME" ]] && continue
    [[ -n "$FILTER_TIER" && "$tier" != "$FILTER_TIER" ]] && continue

    if $first; then
      echo ""
      echo "── $shell ──"
      first=false
    fi

    run_test "$shell" "$name" "$tier" "$expect_file" "$checks"
  done
done

# ═══════════════════════════════════════
# Run edge tests
# ═══════════════════════════════════════

run_edge=true
if [[ "$FILTER_TIER" == "slow" ]]; then
  run_edge=false
fi
if [[ -n "$FILTER_NAME" ]]; then
  run_edge=false
  for entry in "${EDGE_TESTS[@]}"; do
    IFS='|' read -r name _ _ _ <<< "$entry"
    [[ "$FILTER_NAME" == "$name" ]] && run_edge=true
  done
fi

if $run_edge; then
  first=true
  for entry in "${EDGE_TESTS[@]}"; do
    IFS='|' read -r name tier expect_file checks <<< "$entry"

    [[ -n "$FILTER_NAME" && "$name" != "$FILTER_NAME" ]] && continue

    if $first; then
      echo ""
      echo "── edge cases ──"
      first=false
    fi

    run_test "$EDGE_SHELL" "$name" "$tier" "$expect_file" "$checks"
  done
fi

# ═══════════════════════════════════════
# Summary
# ═══════════════════════════════════════

echo ""
echo "Results: $TOTAL_PASS passed, $TOTAL_FAIL failed"
rm -rf "$LOGDIR"

[[ $TOTAL_FAIL -eq 0 ]] && exit 0 || exit 1
