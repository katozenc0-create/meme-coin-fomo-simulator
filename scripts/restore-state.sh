#!/usr/bin/env bash
# Restores Metyu's state from the `autopilot-data` branch into data-dir. By default it only fills in
# files that are MISSING locally, so an always-on machine never overwrites its own newer state;
# --all replaces everything (a fresh GitHub Actions runner starts empty either way).
#
#   scripts/restore-state.sh [data-dir] [--all]
#
# Same variables as publish-state.sh (GITHUB_REPOSITORY, GITHUB_TOKEN / GH_TOKEN, METYU_GIT_REMOTE).
set -euo pipefail

dir="${1:-data}"
mode="${2:-missing}"
mkdir -p "$dir"
repo="${GITHUB_REPOSITORY:-}"
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
remote="${METYU_GIT_REMOTE:-}"
if [ -z "$remote" ]; then
  [ -n "$repo" ] || { echo "restore: set GITHUB_REPOSITORY=owner/repo" >&2; exit 1; }
  remote="https://github.com/${repo}.git"
fi

FILES="autopilot.json status.json exchange.json exchange-status.json account.enc.json account-public.json"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
git -C "$work" init -q
auth=()
if [ -n "$token" ] && [ -z "${METYU_GIT_REMOTE:-}" ]; then
  basic="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  auth=(-c "http.extraheader=AUTHORIZATION: basic ${basic}")
fi
if ! git -C "$work" ${auth[@]+"${auth[@]}"} fetch -q --depth=1 "$remote" autopilot-data 2>/dev/null; then
  echo "restore: no autopilot-data branch yet: starting fresh"
  exit 0
fi
restored=""
for f in $FILES; do
  if [ "$mode" != "--all" ] && [ -s "$dir/$f" ]; then continue; fi
  if git -C "$work" show "FETCH_HEAD:$f" > "$dir/$f.tmp" 2>/dev/null; then
    mv "$dir/$f.tmp" "$dir/$f"; restored="$restored $f"
  else
    rm -f "$dir/$f.tmp"
  fi
done
echo "restore:${restored:- nothing needed}"
