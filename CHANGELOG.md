# Changelog

## 2.1.0: Metyu learns from its own live results

- **Separate budgets for the two books.** The learning book's small research trades no longer count toward the normal book's 4 positions or its 3% side-risk cap. They have their own limits: 8 positions and 2% side risk. A strategy that passed the evidence gate is never blocked by research trades. Margin stays shared.
- **Live watchdog.** `liveReview()` looks at each strategy's last 20 closed trades (both books, in R). If they average below −0.25R, an open-gate strategy is demoted to the learning book and the log shows `DEMOTE`. It is promoted again as soon as the window recovers.
- **Board.** Each strategy shows its live record next to its out-of-sample evidence, and is marked when it has been demoted.
- **Stale data guard.** `fetchCandles` refuses a feed whose newest bar is older than 3 intervals (at least 30 minutes). Coinbase falls back to Kraken; if both are stale, the coin is not traded.
- **No hung ticks.** Polymarket requests now time out after 15 seconds like every other request.
- **Health in the status.** `health` lists stale prices, errors in the last hour and the model's age. The board shows `⚠ stale prices` and `⚠ SILENT` when the agent stops reporting.
- **Evidence-based leverage.** The normal book's risk per trade now grows only with proof, from 1% to 1.5% and then 2% (`leverageTier`). It needs both the out-of-sample lower bound and the strategy's live record in the same tier, and falls back to 1% by itself after a demotion, a losing live record or a 5% drawdown from the peak. The leverage ceiling is 5x (it was 3x); sizing still keeps the liquidation price well beyond the stop. The normal book's side-risk cap is 4% (it was 3%), so larger trades still fit. The learning book is never scaled. The shadow orders and real money stay at $25 per order and 1x. On the live data of 19 November the 4-hour trend qualifies for 1.5x: lower bound +0.09R, 6 live trades at +0.68R.
- **The real-money lock counts normal-book trades only.** Until now its trade count and interval included the learning book's research trades, which real money would never copy.
- **Shadow orders, the rehearsal for real money.** Every normal-book entry is mirrored as the order the first real-money release would send ($25 per order, $100 open, $50 daily loss, 1x). Each one is settled at the same exit and marked when a spot account could not place it (shorts). Nothing is sent.
- **A go-live checklist** in SECURITY.md covers the venue, a separate trading key (no withdrawals, IP-restricted), your own machine instead of GitHub Actions, and a reviewed order adapter.
- **31 coins in two tiers.** 15 Coinbase USD pairs join the pool: ZEC, TAO, QNT, INJ, PEPE, UNI, ENA, ONDO, ZRO, ICP, WLD, FET, TIA, RENDER and ALGO. Each has 300+ days of history, about $1M+ a day of volume and a Kraken fallback. They form a **satellite** tier with its own model and evidence gate, next to the 16 large **core** coins. The tiers were set by size and liquidity, not by results. The honest reason for the split: pooled over all 31 coins, the 4-hour trend's interval fell to [−0.02, +0.21] and its gate would close. On the core it is +0.17R [+0.04, +0.29]; on the new coins alone it is −0.02R [−0.18, +0.16]. Satellite strategies trade only the learning book (0.25% risk) until their own gate opens. The live watchdog also reviews each tier separately.
- **Up to 6 normal-book positions** (was 4). The 3% open-risk cap per side still binds first.
- **Immediate retrain after a release.** A model outdated by new coins or strategies no longer waits the one-hour retry interval meant for failed attempts.
- **Side-risk filter counts the risk still open.** A position whose stop has trailed to break-even can no longer lose its 1R, but it used to keep filling the 3% side-risk budget. On 14 November three such shorts blocked a proven 4-hour signal on AVAX. `openRisk()` now uses the current stop, never more than the risk at entry.
- **Polymarket training saw ~60 events, so its gate could never open.** Resolved markets are fetched as whole events, and one election with 329 candidates filled most of the 1500-market budget. That left 59 independent events, and every walk-forward produced 0 out-of-sample trades. Worse, the model learned "nearly everything ends NO" (it read 30% where the market said 57%), so every live learning trade was a NO. `sampleEventMarkets` now keeps at most 3 markets per event, drawn at random (an unbiased YES rate). That gives about 650 events for the same budget. The model then comes out close to the market (no systematic NO), and the honest result is no edge after costs, so no trades. Models from the old sampling are retrained at once.
- **Restart after a kill-switch halt.** Until now a halted agent stayed stopped for good. A new value of the repository variable `METYU_RESET_HALT` now clears the halt once, in both agents, and the drawdown is counted again from the current equity. Every value is remembered, so a variable left in place never clears a later halt.
- **Watchdog.** `.github/workflows/watchdog.yml` and `scripts/watchdog.js` check the published state hourly and keep one `metyu-watchdog` issue open while something is wrong. That issue is a phone notification, and it closes itself when everything is healthy again.

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
