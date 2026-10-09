#!/usr/bin/env bash
# scripts/publish.sh — EXECUTION_PLAN §16 steps 5–8, idempotent.
# Requires GITHUB_TOKEN (or `gh auth`). Never force-pushes; never deletes
# remote branches. Safe to run twice: second run creates nothing duplicate.
set -euo pipefail

OWNER="${FORGEPM_GH_OWNER:-}"
REPO="${FORGEPM_GH_REPO:-forgepm}"
VISIBILITY="${FORGEPM_GH_VISIBILITY:-private}"

if ! command -v gh >/dev/null 2>&1; then
  echo "publish: gh is required" >&2; exit 1
fi
if [ -z "$OWNER" ]; then
  OWNER="$(gh api user --jq .login)"
fi

# step 5: ensure remote exists (idempotent) and is set as origin
if ! git remote get-url origin >/dev/null 2>&1; then
  if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
    git remote add origin "https://x-access-token@github.com/$OWNER/$REPO.git"
  else
    gh repo create "$OWNER/$REPO" "--$VISIBILITY" --source . --remote origin \
      --description "ForgePM: self-hosted, AI-native project planning with MCP"
  fi
fi

# step 6: push current branch + tags, no --force, --follow-tags
git push -u origin main --follow-tags
git push origin --tags

# step 7: branch protection (best-effort; missing access is reported, not fatal)
PROTECTION_JSON='{"required_status_checks":{"strict":true,"contexts":["ci/verify"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}'
if printf '%s' "$PROTECTION_JSON" | gh api -X PUT "repos/$OWNER/$REPO/branches/main/protection" \
    -H 'Accept: application/vnd.github+json' --input - >/dev/null 2>&1; then
  echo "publish: branch protection applied"
else
  echo "publish: branch protection NOT applied (insufficient permission?) — recorded in report, not fatal"
fi

# step 8: verify refs
git ls-remote origin refs/heads/main
echo "publish: done. Watch Remote CI: gh run watch"
