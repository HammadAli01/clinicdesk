#!/usr/bin/env bash
# Vercel build command (wired via `buildCommand` in vercel.json).
#
# 1. Apply pending migrations to THIS project's database (its own DATABASE_URL,
#    set in that Vercel project's Environment Variables).
# 2. Build the app.
#
# Migrations run BEFORE the new code goes live, so they must be backward
# compatible with the code that's still serving traffic (expand/contract,
# see docs/03-migrations.md). If the build fails after migrating, the old code
# keeps running on the migrated schema, which is exactly what expand/contract allows.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✖ DATABASE_URL is not set for this Vercel project/environment." >&2
  exit 1
fi

echo "── migrating (${VERCEL_GIT_COMMIT_REF:-local})"
pnpm db:migrate

echo "── building"
pnpm build
