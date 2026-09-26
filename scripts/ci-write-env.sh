#!/usr/bin/env bash
# Writes an env file (e.g. .env.test or .env.local) from variables already in
# the environment. CI uses it because those files are git-ignored, and
# vitest.config.ts / drizzle.config.ts / the seed script read them.
# Usage: bash scripts/ci-write-env.sh <file>
set -euo pipefail

file="${1:?usage: ci-write-env.sh <file>}"
vars=(DATABASE_URL APP_URL SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
      STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET CRON_SECRET)

: > "$file"
for v in "${vars[@]}"; do
  # ${!v} = "the value of the variable whose NAME is in $v". Skip unset ones.
  if [ -n "${!v:-}" ]; then echo "$v=${!v}" >> "$file"; fi
done
echo "wrote $file (${#vars[@]} vars checked)"
