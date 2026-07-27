#!/usr/bin/env bash
set -euo pipefail

CURRENT_ROOT="/var/www/sandeal-git"
ROLLBACK_ROOT="${SANDEAL_ROLLBACK_RELEASE_DIR:-}"
LOCAL_HEALTH_URL="${SANDEAL_LOCAL_HEALTH_URL:-http://127.0.0.1:3000/api/health/live}"
PUBLIC_HEALTH_URL="${SANDEAL_PUBLIC_HEALTH_URL:-https://sandeal.tech/api/health/live}"
RECENT_LOG_LINES="${SANDEAL_DEPLOY_LOG_LINES:-50}"

fail() {
  printf 'GUARDED_ROLLBACK_FAILED: %s\n' "$1" >&2
  exit 1
}

trap 'fail "Rollback verification did not complete. PM2 saved state was not changed."' ERR

[[ "$(pwd -P)" == "$CURRENT_ROOT" ]] || fail "Run the rollback command from /var/www/sandeal-git."
[[ -n "$ROLLBACK_ROOT" && -d "$ROLLBACK_ROOT" ]] || fail "SANDEAL_ROLLBACK_RELEASE_DIR must name an existing immutable release directory."
ROLLBACK_ROOT="$(cd "$ROLLBACK_ROOT" && pwd -P)"
[[ "$ROLLBACK_ROOT" != "$CURRENT_ROOT" ]] || fail "The rollback release must be a separate previously verified directory."
[[ -f "$ROLLBACK_ROOT/ecosystem.config.cjs" && -f "$ROLLBACK_ROOT/.sandeal-build-manifest.json" ]] \
  || fail "The rollback release is missing its ecosystem file or immutable build manifest."

ROLLBACK_RELEASE="$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).commitSha; if(!/^[0-9a-f]{40}$/i.test(String(value||""))) process.exit(1); process.stdout.write(String(value).toLowerCase())' "$ROLLBACK_ROOT/.sandeal-build-manifest.json")"
[[ "$ROLLBACK_RELEASE" =~ ^[0-9a-f]{40}$ ]] || fail "The rollback build manifest has no valid commit SHA."

printf 'Rollback directory: %s\nRollback release: %s\n' "$ROLLBACK_ROOT" "$ROLLBACK_RELEASE"
printf 'Type the rollback release SHA to continue: '
read -r CONFIRMED_RELEASE
[[ "${CONFIRMED_RELEASE,,}" == "$ROLLBACK_RELEASE" ]] || fail "The confirmed release does not match the rollback artifact."

SANDEAL_DATA_DIR="$(pm2 jlist | node scripts/guarded-release-verify.cjs data-directory)"
export SANDEAL_DATA_DIR
export SANDEAL_BUILD_MANIFEST_COMMIT="$ROLLBACK_RELEASE"
export SANDEAL_BUILD_COMMIT="$ROLLBACK_RELEASE"
export SANDEAL_RELEASE_ID="$ROLLBACK_RELEASE"
export GIT_COMMIT_SHA="$ROLLBACK_RELEASE"
export NEXT_PUBLIC_SANDEAL_RELEASE_ID="$ROLLBACK_RELEASE"
export NEXT_DEPLOYMENT_ID="$ROLLBACK_RELEASE"
export SANDEAL_ENABLE_PROMPT10_RUNTIME=true

(
  cd "$ROLLBACK_ROOT"
  node scripts/guarded-release-verify.cjs manifest "$ROLLBACK_RELEASE"
  pm2 startOrReload ecosystem.config.cjs --only sandeal,sandeal-worker,sandeal-scheduler --update-env
)

ONLINE=0
for ((attempt = 1; attempt <= 30; attempt += 1)); do
  if pm2 jlist | node scripts/guarded-release-verify.cjs processes "$ROLLBACK_RELEASE" >/dev/null 2>&1; then
    ONLINE=1
    break
  fi
  sleep 2
done
[[ "$ONLINE" -eq 1 ]] || fail "The rollback applications did not become online with the intended release."

pm2 jlist | node "$ROLLBACK_ROOT/scripts/guarded-release-verify.cjs" runtime "$ROLLBACK_RELEASE"
node "$ROLLBACK_ROOT/scripts/guarded-release-verify.cjs" health "$ROLLBACK_RELEASE" "$LOCAL_HEALTH_URL" "$PUBLIC_HEALTH_URL"
pm2 logs sandeal sandeal-worker sandeal-scheduler --nostream --raw --lines "$RECENT_LOG_LINES" 2>&1 \
  | node "$ROLLBACK_ROOT/scripts/redact-operational-output.cjs"

pm2 save
trap - ERR
printf 'GUARDED_ROLLBACK_VERIFIED: %s\n' "$ROLLBACK_RELEASE"
