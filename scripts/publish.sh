#!/usr/bin/env bash
# Commit the hub and push with the deploy key. Push triggers Vercel redeploy.
#   bash scripts/publish.sh "commit message" [--commit-only]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="$ROOT/keys/vercel_deploy_ed25519"
MSG="${1:-update apk hub}"
COMMIT_ONLY="${2:-}"

cd "$ROOT"
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
else
  git commit -m "$MSG"
fi
if [ "$COMMIT_ONLY" = "--commit-only" ]; then
  echo "committed only (no push)"
  exit 0
fi
[ -f "$KEY" ] || { echo "ERROR: deploy key missing at $KEY"; exit 1; }
export GIT_SSH_COMMAND="ssh -i \"$KEY\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
git push origin HEAD:main
echo "pushed -> Vercel will redeploy"
