#!/usr/bin/env bash
# Publishes Metyu's state and public status files to the `autopilot-data` branch, which the Live
# Board on GitHub Pages reads. One commit, replaced each time (the state files carry the history).
# Used by the GitHub Actions workflow and by scripts/realtime.sh on an always-on machine.
#
#   scripts/publish-state.sh [data-dir]
#
# Needs GITHUB_REPOSITORY=owner/repo and a token: GITHUB_TOKEN (in Actions) or GH_TOKEN (on your
# own machine: a fine-grained token limited to this repository with "Contents: read and write").
# METYU_GIT_REMOTE overrides the remote URL (tests use a local bare repository).
# Guards: refuses to publish an unsealed account snapshot or anything that looks like a secret.
set -euo pipefail

dir="$(cd "${1:-data}" && pwd)"
repo="${GITHUB_REPOSITORY:-}"
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
remote="${METYU_GIT_REMOTE:-}"
if [ -z "$remote" ]; then
  [ -n "$repo" ] || { echo "publish: set GITHUB_REPOSITORY=owner/repo" >&2; exit 1; }
  [ -n "$token" ] || { echo "publish: set GH_TOKEN (or GITHUB_TOKEN)" >&2; exit 1; }
  remote="https://github.com/${repo}.git"
fi

FILES="autopilot.json status.json exchange.json exchange-status.json account.enc.json account-public.json"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

files=""
for f in $FILES; do
  if [ -s "$dir/$f" ]; then cp "$dir/$f" "$work/$f"; files="$files $f"; fi
done
[ -n "$files" ] || { echo "publish: nothing to save in $dir" >&2; exit 1; }

cd "$work"
# Defence in depth: balances only ever leave sealed; keys never leave at all.
if [ -s account.enc.json ] && grep -q '"balances"' account.enc.json; then
  echo "publish: account.enc.json is not sealed: refusing to publish" >&2; exit 1
fi
# shellcheck disable=SC2086
if grep -l -E 'PRIVATE KEY-----|"apiSecret"|"privateKey"|ghp_[A-Za-z0-9]{30}|github_pat_' $files >&2; then
  echo "publish: secret-looking content: refusing to publish" >&2; exit 1
fi

git init -q -b autopilot-data
git config user.name "metyu-autopilot"
git config user.email "metyu-autopilot@users.noreply.github.com"
printf '%s\n' "# Metyu autopilot state (virtual money)" "" \
  "Written by .github/workflows/autopilot.yml or scripts/realtime.sh (see README)." \
  "status.json / exchange-status.json are what the Live Board shows; autopilot.json / exchange.json are the full states." \
  "account.enc.json is the owner's account snapshot, end-to-end encrypted (metyu-vault.js)." > README.md
# shellcheck disable=SC2086
git add $files README.md
git commit -qm "autopilot state $(date -u +%Y-%m-%dT%H:%MZ)"

# The token goes in a header, never in the URL (so it cannot show up in an error message).
auth=()
if [ -n "$token" ] && [ -z "${METYU_GIT_REMOTE:-}" ]; then
  basic="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  auth=(-c "http.extraheader=AUTHORIZATION: basic ${basic}")
fi
git ${auth[@]+"${auth[@]}"} push -q --force "$remote" HEAD:refs/heads/autopilot-data
echo "publish: ${files# } -> autopilot-data"
