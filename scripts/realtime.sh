#!/usr/bin/env bash
# Metyu in REAL TIME on an always-on machine (a home server, a Raspberry Pi, a small VPS), with
# VIRTUAL money. GitHub Actions runs a tick every 15 minutes; this runs one every minute:
#   every minute     crypto exchange tick: exits on 1-minute bars, signals on each new hourly bar
#   every 5 minutes  Polymarket tick, account sync (view-only, encrypted), publish to the board
#
#   GITHUB_REPOSITORY=owner/repo GH_TOKEN=... scripts/realtime.sh
#
# Set the repository variable METYU_RUNNER=external so the GitHub workflow stops writing the same
# state (one writer at a time). METYU_PAUSE=true pauses new positions. Each process only gets the
# secrets it needs: the ticks get none, the account sync gets the exchange key, only the publisher
# gets the GitHub token. Stop with Ctrl+C or `systemctl stop metyu-realtime`.
set -uo pipefail
cd "$(dirname "$0")/.."

# (Portable to the bash 3.2 that macOS ships: no mapfile, no empty-array expansion under set -u.)
NO_SECRETS=()
for name in COINBASE_API_KEY_NAME COINBASE_API_PRIVATE_KEY BINANCE_API_KEY BINANCE_API_SECRET METYU_BOARD_PASSPHRASE GH_TOKEN GITHUB_TOKEN; do NO_SECRETS+=(-u "$name"); done
NO_GITHUB=(-u GH_TOKEN -u GITHUB_TOKEN)
PAUSE=(--learn)
case "${METYU_PAUSE:-}" in 1|true|TRUE|yes|on) PAUSE=(--learn --pause) ;; esac

publish=1
[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] || { publish=0; echo "realtime: no GH_TOKEN/GITHUB_REPOSITORY: running without publishing to the board"; }
mkdir -p data
[ "$publish" = 1 ] && scripts/restore-state.sh data || true

stop=0
trap 'stop=1' INT TERM
i=0
echo "realtime: Metyu in real time (virtual money) · exchange every minute · Polymarket, account and board every 5 minutes"
while [ "$stop" = 0 ]; do
  started=$SECONDS
  env "${NO_SECRETS[@]}" node exchange-autopilot.js --once "${PAUSE[@]}" --state data/exchange.json \
    --status-out data/exchange-status.json --account-public data/account-public.json || echo "realtime: exchange tick failed"
  if [ $((i % 5)) -eq 0 ]; then
    env "${NO_SECRETS[@]}" node autopilot.js --once --train 1500 --retrain 24 "${PAUSE[@]}" --state data/autopilot.json \
      --status-out data/status.json || echo "realtime: Polymarket tick failed"
    env "${NO_GITHUB[@]}" node account-sync.js --out data/account.enc.json --public-out data/account-public.json || echo "realtime: account sync failed"
    [ "$publish" = 1 ] && { scripts/publish-state.sh data || echo "realtime: publish failed (will retry)"; }
  fi
  i=$((i + 1))
  wait_for=$((60 - (SECONDS - started)))
  [ "$wait_for" -lt 5 ] && wait_for=5
  for _ in $(seq "$wait_for"); do [ "$stop" = 0 ] || break; sleep 1; done
done
[ "$publish" = 1 ] && scripts/publish-state.sh data
echo "realtime: stopped; state saved in data/"
