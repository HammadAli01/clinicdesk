#!/usr/bin/env bash
# Vercel "Ignored Build Step" (wired via `ignoreCommand` in vercel.json).
# Vercel's contract is inverted: exit 1 => BUILD, exit 0 => SKIP.
#
# Each of the 3 Vercel projects (dev / staging / production) has one Production
# Branch. We build only that; preview deployments of other branches are skipped
# to save build minutes (CI already checks every PR).
set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "✅ production deployment (${VERCEL_GIT_COMMIT_REF:-unknown}): building."
  exit 1
fi
echo "⏭️  preview deployment (${VERCEL_GIT_COMMIT_REF:-unknown}): skipping to save build minutes."
exit 0
