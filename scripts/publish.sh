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

# --- 安全闸门：绝不允许把密钥类文件推上去 -------------------------------------
# 这个仓库是公开的。.gitignore 已经排除了 keys/*（只留 *.pub），但 git add -A 的安全性
# 完全依赖 .gitignore 不出错，所以这里再加一道硬检查：只要暂存区或已跟踪文件里出现
# 私钥/凭据类文件，直接中止（宁可发布失败，也不能泄密）。
staged="$(git diff --cached --name-only)"
secret_re='(^|/)(id_rsa|id_ed25519|id_ecdsa)$|(^|/)[^/]*(_rsa|_ed25519|_ecdsa)$|\.(pem|key|p12|pfx|jks|keystore)$|(^|/)\.env($|\.)|(^|/)secrets?\.|credentials'
bad="$(printf '%s\n' "$staged" | grep -Ei "$secret_re" | grep -v '\.pub$' || true)"
if [ -n "$bad" ]; then
  echo "ERROR: 暂存区里有疑似密钥/凭据文件，已中止发布："
  printf '%s\n' "$bad"
  git reset -q
  exit 1
fi
tracked_bad="$(git ls-files | grep -Ei "$secret_re" | grep -v '\.pub$' || true)"
if [ -n "$tracked_bad" ]; then
  echo "ERROR: 仓库里已经跟踪了疑似密钥文件，请先移除："
  printf '%s\n' "$tracked_bad"
  exit 1
fi
# 私钥本体必须始终处于忽略状态
if ! git check-ignore -q keys/vercel_deploy_ed25519; then
  echo "ERROR: keys/vercel_deploy_ed25519 没有被 .gitignore 忽略，已中止发布"
  git reset -q
  exit 1
fi

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
