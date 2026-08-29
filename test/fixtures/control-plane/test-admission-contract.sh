#!/bin/sh
# Test-only stand-in for a real control-plane.sh admission contract.
# Not wired into production; used only by control-plane admission gate
# activation-prep tests to exercise the real execFile/exit-code path
# end-to-end without depending on an external control-plane deployment.
#
# Contract (matches src/plugin-sdk/control-plane-admission-gate.ts):
#   invoked as: <script> spawn request --command-id <id> --worktree <path> --owner <owner>
#   exit 0            => admitted (go)
#   any non-zero exit => denied (no-go)
#
# Decision and an optional call-log path are supplied via env so the same
# script can be reused for both "go" and "no-go" fixtures without editing it:
#   CP_TEST_DECISION   "go" (default) or anything else => no-go (exit 3)
#   CP_TEST_CALL_LOG    if set, appends the invocation args to this file so
#                        a test can assert the script was actually invoked.

set -eu

if [ -n "${CP_TEST_CALL_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$CP_TEST_CALL_LOG"
fi

if [ "${CP_TEST_DECISION:-go}" = "go" ]; then
  exit 0
fi
exit 3
