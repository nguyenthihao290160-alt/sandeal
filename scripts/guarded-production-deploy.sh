#!/usr/bin/env bash
set -euo pipefail

EXPECTED_ROOT="/var/www/sandeal-git"
LOCAL_HEALTH_URL="${SANDEAL_LOCAL_HEALTH_URL:-http://127.0.0.1:3000/api/health/live}"
PUBLIC_HEALTH_URL="${SANDEAL_PUBLIC_HEALTH_URL:-https://sandeal.tech/api/health/live}"
RECENT_LOG_LINES="${SANDEAL_DEPLOY_LOG_LINES:-50}"
DEFER_PM2_SAVE="${SANDEAL_DEPLOY_DEFER_PM2_SAVE:-false}"

fail() {
  printf 'GUARDED_DEPLOYMENT_FAILED: %s\n' "$1" >&2
  exit 1
}

trap 'fail "The deployment stopped before verification completed. PM2 saved state was not changed."' ERR

[[ "$DEFER_PM2_SAVE" == "true" || "$DEFER_PM2_SAVE" == "false" ]] \
  || fail "SANDEAL_DEPLOY_DEFER_PM2_SAVE must be true or false."
# This controls only this guarded shell invocation. Do not copy it into the
# PM2 application environment via --update-env.
unset SANDEAL_DEPLOY_DEFER_PM2_SAVE

CURRENT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "The current directory is not a Git repository."
CURRENT_ROOT="$(cd "$CURRENT_ROOT" && pwd -P)"
CURRENT_DIRECTORY="$(pwd -P)"
[[ "$CURRENT_ROOT" == "$EXPECTED_ROOT" && "$CURRENT_DIRECTORY" == "$EXPECTED_ROOT" ]] || fail "Run only from /var/www/sandeal-git."

BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "master" ]] || fail "The checked-out branch is not master."

RELEASE="$(git rev-parse HEAD | tr '[:upper:]' '[:lower:]')"
[[ "$RELEASE" =~ ^[0-9a-f]{40}$ ]] || fail "Git HEAD is not a full commit SHA."

printf 'Repository: %s\nBranch: %s\nGit HEAD: %s\n' "$CURRENT_ROOT" "$BRANCH" "$RELEASE"
git status --short --branch
[[ -z "$(git status --porcelain)" ]] || fail "The production working tree is not clean."

printf 'Type the intended release SHA to continue: '
read -r CONFIRMED_RELEASE
[[ "${CONFIRMED_RELEASE,,}" == "$RELEASE" ]] || fail "The confirmed release does not match Git HEAD."

SANDEAL_DATA_DIR="$(pm2 jlist | node scripts/guarded-release-verify.cjs data-directory)"
export SANDEAL_DATA_DIR
export SANDEAL_BUILD_MANIFEST_COMMIT="$RELEASE"
export SANDEAL_BUILD_COMMIT="$RELEASE"
export SANDEAL_RELEASE_ID="$RELEASE"
export GIT_COMMIT_SHA="$RELEASE"
export NEXT_PUBLIC_SANDEAL_RELEASE_ID="$RELEASE"
export NEXT_DEPLOYMENT_ID="$RELEASE"

npm run build
node scripts/guarded-release-verify.cjs manifest "$RELEASE"

for application in sandeal sandeal-worker sandeal-scheduler; do
  pm2 restart "$application" --update-env
done

ONLINE=0
for ((attempt = 1; attempt <= 30; attempt += 1)); do
  if pm2 jlist | node scripts/guarded-release-verify.cjs processes "$RELEASE" >/dev/null 2>&1; then
    ONLINE=1
    break
  fi
  sleep 2
done
[[ "$ONLINE" -eq 1 ]] || fail "The three PM2 applications did not become online with the intended release."

pm2 jlist | node scripts/guarded-release-verify.cjs runtime "$RELEASE"
node scripts/guarded-release-verify.cjs health "$RELEASE" "$LOCAL_HEALTH_URL" "$PUBLIC_HEALTH_URL"

pm2 logs sandeal sandeal-worker sandeal-scheduler --nostream --raw --lines "$RECENT_LOG_LINES" 2>&1 \
  | node scripts/redact-operational-output.cjs

if [[ "$DEFER_PM2_SAVE" == "true" ]]; then
  trap - ERR
  printf 'GUARDED_DEPLOYMENT_VERIFIED_PENDING_PM2_SAVE: %s\n' "$RELEASE"
  printf 'Run pm2 save only after the separately documented browser and production verification is complete.\n'
else
  pm2 save
  trap - ERR
  printf 'GUARDED_DEPLOYMENT_VERIFIED: %s\n' "$RELEASE"
fi
