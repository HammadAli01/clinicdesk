#!/usr/bin/env bash
# Promotes one pipeline stage to the next by FAST-FORWARD: the target branch
# ends up pointing at the exact same commits (same SHAs) as the source.
# No merge commits, so a promotion can never hit a merge conflict. Never force-pushes.
#
#   development ──▶ staging ──▶ main
#
# Usage: scripts/promote.sh dev-to-staging|staging-to-prod [--dry-run] [-y]
#   --dry-run  run every check, but do not push
#   -y         don't ask for confirmation
#
# Runs in the "Promote" GitHub workflows, or locally (needs bash, git, pnpm, and a
# DATABASE_URL pointing at a TEST database, because the Vitest suite truncates it).
#
# The checks here must stay in sync with the `quality` job in
# .github/workflows/_ci-checks.yml. Playwright is NOT re-run: a fast-forward
# promotes the exact SHAs whose E2E run already passed on the source branch.
set -euo pipefail

usage() { echo "usage: $0 dev-to-staging|staging-to-prod [--dry-run] [-y]" >&2; exit 2; }

case "${1:-}" in
  dev-to-staging)  SOURCE=development; TARGET=staging ;;
  staging-to-prod) SOURCE=staging;     TARGET=main ;;
  *) usage ;;
esac
shift
DRY_RUN=false; YES=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -y) YES=true ;;
    *) usage ;;
  esac
done

# 1. Repo root, tools, clean tree.
cd "$(git rev-parse --show-toplevel)"
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash first." >&2; exit 1
fi

# 2. Always return to where we started and delete the throwaway branch.
START_REF="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
TMP_BRANCH="promote/${SOURCE}-to-${TARGET}-$$"
cleanup() {
  git checkout --quiet "$START_REF" 2>/dev/null || true
  git branch --quiet -D "$TMP_BRANCH" 2>/dev/null || true
}
trap cleanup EXIT

# 3. Fresh view of the remote.
git fetch origin --prune --quiet
git rev-parse --verify --quiet "origin/$SOURCE" >/dev/null || { echo "origin/$SOURCE not found" >&2; exit 1; }
git rev-parse --verify --quiet "origin/$TARGET" >/dev/null || { echo "origin/$TARGET not found" >&2; exit 1; }
SRC_SHA="$(git rev-parse "origin/$SOURCE")"
TGT_SHA="$(git rev-parse "origin/$TARGET")"

# 4. Nothing to do?
if [ "$SRC_SHA" = "$TGT_SHA" ]; then
  echo "Nothing to promote: $TARGET is already at $SOURCE (${SRC_SHA:0:7})."; exit 0
fi

# 5. Fast-forward precondition: every commit on TARGET must already be on SOURCE.
if ! git merge-base --is-ancestor "origin/$TARGET" "origin/$SOURCE"; then
  echo "✖ $TARGET has commits that are not on $SOURCE, so a fast-forward is impossible:" >&2
  git log --oneline "origin/$SOURCE..origin/$TARGET" >&2
  cat >&2 <<EOF

Fix: land that work in $SOURCE (via a PR into development), then re-run.
If $TARGET must be realigned, an admin does it by hand, once:
  git push --force origin origin/$SOURCE:refs/heads/$TARGET
This script never force-pushes.
EOF
  exit 1
fi

# 6. The plan.
echo "Promote $SOURCE → $TARGET"
echo "  from ${TGT_SHA:0:7} to ${SRC_SHA:0:7} ($(git rev-list --count "origin/$TARGET..origin/$SOURCE") commits):"
git log --oneline "origin/$TARGET..origin/$SOURCE" | sed 's/^/    /'

# 7. Check out exactly what will be promoted.
git checkout --quiet -B "$TMP_BRANCH" "origin/$SOURCE"

# 8. The same checks as the `quality` job in _ci-checks.yml, plus a production build.
echo "── install";            pnpm install --frozen-lockfile
echo "── typecheck ∥ lint"
pids=()
pnpm typecheck & pids+=($!)
pnpm lint --max-warnings 0 & pids+=($!)
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
[ "$fail" -eq 0 ] || { echo "✖ typecheck or lint failed" >&2; exit 1; }
echo "── tests";              pnpm test
echo "── production build";   pnpm build

# 9. Dry run stops here.
if [ "$DRY_RUN" = true ]; then
  echo "✔ Dry run: all checks passed. Nothing pushed."; exit 0
fi

# 10. Confirm (skipped with -y or when there's no terminal, e.g. in CI).
if [ "$YES" = false ] && [ -t 0 ]; then
  read -r -p "Push ${SRC_SHA:0:7} to $TARGET? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Aborted."; exit 1; }
fi

# 11. Plain fast-forward push of the SHA we checked. If TARGET moved while we
#     were running, GitHub rejects it (not a fast-forward) and you simply re-run.
git push origin "${SRC_SHA}:refs/heads/${TARGET}"
echo "✔ Promoted $SOURCE → $TARGET at ${SRC_SHA:0:7}. Vercel deploys $TARGET from this push."
