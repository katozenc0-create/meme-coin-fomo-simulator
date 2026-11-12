# Changelog

## 2.0.0: real time, real data, virtual money

Metyu now runs on live Coinbase and Polymarket data. It can link your real exchange account read-only, and it trades in real time on an always-on machine. **All trading uses virtual money.** Real orders stay locked behind a 3-day training period and the evidence bar.

**Real time**
- **Exits on 1-minute bars.** `exchange-autopilot.js` checks open positions on 1-minute bars and walks each finished minute once. Positions remember their progress (`checkedUntil`, `best`, `stop`).
- **Forming minute.** A stop, target or liquidation hit inside the still-forming minute closes the position at once, without trailing on that minute's unfinished close.
- **Gaps.** If the autopilot was away longer than the 5 hours of 1-minute history, 15-minute bars cover the gap first.
- **Always-on machine.** `scripts/realtime.sh` runs Metyu on a home server, a Raspberry Pi or a VPS:
  - a crypto tick every minute;
  - Polymarket, the account sync and publishing to the board every 5 minutes.

  Install it with `deploy/metyu-realtime.service` (a hardened systemd unit). Each process gets only the secrets it needs.
- **Liveness on the board.** The board shows "Live · real time", "Running 24/7 · every 15 min" or "Last seen N min ago".

**Training period and real-money lock**
- **3 days.** The training period is 3 days (`TRAINING_DAYS`), as the owner chose. The board shows "Training · day N/3".
- **The evidence bar still applies:** 30+ closed trades and a 95% interval above zero, however long that takes. The real-money lock lists all six conditions.

**Owner controls**
- **Emergency pause from the phone.** Setting the repository variable `METYU_PAUSE=true` (or `--pause`) stops new positions in both autopilots. Open positions are still managed to their exits. The pause is logged once, and the board shows "PAUSED by the owner".
- **One writer.** `METYU_RUNNER=external` makes the GitHub workflow stand aside while an always-on machine publishes, so two writers never fight over the state.

**Security and supply chain**
- **Pinned actions.** Every GitHub Action is pinned to a commit SHA, and `persist-credentials: false` is set everywhere.
- **Updates and scanning.** Dependabot keeps the pinned actions and the test tooling up to date. CodeQL (`security-extended`) scans the JavaScript and Python code.
- **Shared state scripts.** Publishing and restoring now live in `scripts/publish-state.sh` and `scripts/restore-state.sh`, used by both the workflow and the always-on runner:
  - the token travels in a header, never in a URL;
  - publishing refuses unsealed balances and anything that looks like a secret;
  - restoring never overwrites a newer local state unless asked (`--all`).
- **Earlier in 2.0:**
  - view-only account linking (`account-sync.js`);
  - end-to-end encryption (`metyu-vault.js`);
  - a strict CSP on every page;
  - a repository secret scan;
  - `SECURITY.md`.

**Also in this line (1.x → 2.0)**
- **Crypto exchange paper trading** (`metyu-exchange.js`):
  - chart reading;
  - three strategies;
  - leverage with liquidation;
  - walk-forward training with an out-of-sample evidence gate.
- **24/7 GitHub Actions autopilot** with learning books and a forward test.
- **Metyu Terminal view**, and the iPhone home-screen app (PWA).
