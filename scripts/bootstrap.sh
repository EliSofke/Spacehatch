#!/usr/bin/env bash
# Bootstrap Spacehatch in a freshly created GitHub repo, in one step.
#
# Usage:  ./scripts/bootstrap.sh <owner>/<repo> [https]
#
# What it does:
#   1. Adds the repo as `origin` (SSH by default, HTTPS with the 2nd arg)
#   2. Pushes main + tags (v0.1.0)
#   3. Seeds backend/.env so the terminal button targets THIS repo
#      (convention: service repo = target repo; override GITHUB_OWNER/REPO
#      in backend/.env if the button should launch a different repository)
set -euo pipefail

SLUG="${1:?usage: bootstrap.sh <owner>/<repo> [https]}"
OWNER="${SLUG%%/*}"
REPO="${SLUG##*/}"

if [ "${2:-ssh}" = "https" ]; then
  URL="https://github.com/${SLUG}.git"
else
  URL="git@github.com:${SLUG}.git"
fi

git remote get-url origin >/dev/null 2>&1 || git remote add origin "$URL"
git push -u origin main --tags

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "Created backend/.env from template — fill in OAuth credentials and SESSION_SECRET."
fi
sed -i.bak -e "s|^GITHUB_OWNER=.*|GITHUB_OWNER=${OWNER}|" \
           -e "s|^GITHUB_REPO=.*|GITHUB_REPO=${REPO}|" backend/.env
rm -f backend/.env.bak

echo "Done: origin=${URL}, pushed main + tags, backend/.env targets ${SLUG}."
