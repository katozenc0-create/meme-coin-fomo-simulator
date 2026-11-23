# Changelog

## 2.6.0: security: wallet protection and a strict CSP

- **Open token approvals detected.** `solanaApprovals` (read-only RPC) lists SPL token accounts with a delegate, another address allowed to move tokens. The account sync runs it on every tick. The details are sealed; only the count is published (`account-public.json` → `security.approvals`). An open approval:
  - raises a red alert on the board;
  - shows in the wallet panel ("✓ no open token approvals" when clean) and is listed in the unlocked account panel;
  - is reported by the watchdog and the daily report;
  - stops the real-money lock from counting the wallet.
- **Secrets wiped on sight.** `looksLikeSecret` recognises a recovery phrase (12–24 words) or a private key (base58 of 64 bytes, or a JSON key file). The board wipes it from any field at once and explains why. Password fields are left alone.
- **Strict CSP for scripts.** `script-src` allows only this repository's inline scripts by SHA-256 hash; `'unsafe-inline'` is gone for scripts. `scripts/csp.js --write` updates the pages and `server.py`, and `--check` (run by the tests) fails when a hash is stale. An end-to-end test injects a script and shows the browser refuses it.
- SECURITY.md: wallet protection, and what only the owner can do. Service worker cache `metyu-shell-v7`.

## 2.5.2: a wallet link must stay verified

- **Real-money lock:** the account condition counts only while the link is **re-verified within 24 hours**. The account sync re-verifies every tick. When it failed (a key revoked, a source down), the last `account-public.json` stayed published, and an old "linked" record kept counting.
- **Watchdog:** it reports a linked account not verified for 24+ hours, and a refused (not view-only) key.
- **Daily report:** a "Real wallet/account" line with the provider, read-only access and the last verification.
- **Display fix:** the lock's edge condition no longer shows a degenerate interval when all trades fall in one week. It says "all N trades in 1 week: no interval yet".

## 2.5.1: simpler still

- **Wallet:** no holdings list on the board, as the owner asked. The panel shows the verified total, the address, read-only access, "✓ verified on-chain" with its source, and the Solscan link for the details. Impostor tokens are still warned about.
- **Terminal:** a simple view with the balance, trades, wins and losses, the current trade, the **last 8 trades** (market, P&L, time, side and book) and the result. The agent cards, the flow strip, the stage boxes and the raw log are out of sight.
- **Forward test:** trades that all fall in one week no longer show a meaningless interval (`[+0.68R, +0.68R]`). The board says "all in 1 week: no interval yet".
- Service worker cache `metyu-shell-v6`.

## 2.5.0: a professional live board, and a wallet verified on-chain

- **Layout:**
  - a compact header with a one-line summary, then the live overview;
  - the live panels next: wallet, crypto agent, prediction-market agent, account, terminal;
  - the **demo simulator** in its own section at the bottom. Its controls used to sit above the live data.
- **Real vs virtual, everywhere.** Every panel carries a label: `REAL · READ-ONLY` (the wallet), `VIRTUAL · 24/7` (the agents) or `DEMO`. The overview opens with a separate **real wallet strip**: the balance, the short address and "✓ verified on-chain N s ago". Under it come the virtual paper-trading figures.
- **Wallet verified on-chain:**
  - a verification line: "✓ verified on-chain at HH:MM", the source (Solana blockchain via Jupiter or the Solana RPC), and a **Verify on Solscan ↗** link for an independent check;
  - the list shows the 5 largest holdings and anything worth $1+, at most 12 rows; airdrop dust is summed up in one line.
- **Security fix: impostor tokens.** Anyone can mint a token named "USDC". A scam airdrop ("USDC (usdc-earn.xyz - claim)") was priced at $1 a token and added thousands of dollars to a wallet's total. A token that takes a protected name (SOL, WSOL, USDC, USDT, USD, PYUSD, USDS, DAI) without the real mint is now an **impostor**: never priced, never counted, and flagged on the board ("⚠ … likely a scam airdrop, not counted. Never interact with it."). This covers the browser wallet and the account sync.
- Service worker cache `metyu-shell-v5`, so the new board replaces the old copy.

## 2.4.2: 50-50 resolutions settle

- **Fix: a Polymarket position could stay open forever.** A cancelled game or a tie resolves at 0.5/0.5 (`umaResolutionStatus: resolved`), and Polymarket pays $0.50 a share to both sides. `parseGammaResolution` only knew YES (≥0.99) and NO (≤0.01), so it treated such a market as "resolution pending" for ever. A learning position on Louisiana-Lafayette vs. UNCW (ended 15 Nov) kept its margin locked for a week. Such a market now resolves as `SPLIT`, and `settlePosition` pays $0.50 a share. A dry run on the live state settled it: −$6.04.
- 50-50 markets are left out of the training data: they teach no probability.
- **Watchdog:** a Polymarket position still open 3+ days after its market ended is reported. The published positions carry their market's `endDate`.

## 2.4.1

- **Watchdog:** the Polymarket agent's model age is checked too. 48+ hours old means its daily self-training keeps failing; until now only the crypto model was checked.

## 2.4.0: a daily steward routine

- **`CLAUDE.md`:** a guide that every Claude session reads.
  - The hard rules: virtual money only, the evidence gate never loosened, no secrets, no Actions server, no deletions or force-pushes.
  - The layout, the checks and the conventions.
- **`docs/STEWARD.md`:** the daily routine. Look at the published state, the scheduler and the health; fix real problems first (root cause, one PR each, green CI); then make at most one small improvement; report to the owner in Turkish. Anything about real money, the gate or the risk rules waits for the owner.
- **`scripts/daily-report.js`:** a short, reproducible Markdown report of the published state. It covers health, equity and the last 24 hours, the gates and the closest one, the forward test, the real-money lock, shadow orders, alarms and the prediction markets.

## 2.3.0: a live overview first on the board

- **Metyu · live overview** opens the board, right under the title:
  - crypto equity at live prices, today's P&L since 00:00 UTC, and open positions with their unrealized P&L (normal or learning);
  - the evidence gates and the current risk tier;
  - the real-money lock and the next condition to meet;
  - health, with data freshness ("agent 4 min ago · prices 5 s ago").
- **Live prices between the agent's runs.** Every 10 seconds the board reads Coinbase's public ticker for the coins with an open position. It moves each position's P&L from the agent's mark by the price change since. Before, P&L was up to ~20 minutes old: the 15-minute agent plus the 5-minute data cache.
- **The last 24 hours** in plain lines: trades closed and their P&L, best and worst, what was opened, skipped and watched, training and alarms, and the prediction markets.
- **Fresh on return.** When the iPhone app comes back from the background, everything is fetched at once. The exchange status is checked every 30 s (it was 60 s).
- **The agent retrains at once** when its model comes from the older evidence gate (no weekly blocks), instead of waiting up to 24 hours.
- **Fix:** the demo's stat tiles have their own id. The view switch hid "the first `.stats` on the page", which is now the overview.

## 2.2.0: an honest evidence gate, and ready for the API switch-offs

Research for this release covered the APIs Metyu depends on and the statistics of backtests.

**The evidence gate no longer fools itself.** This follows Bailey and López de Prado on backtest overfitting and the deflated Sharpe ratio:
- **Weekly block bootstrap.** Crypto moves together: one week's shorts across 16 coins are close to one observation, not 16. The gate's interval now resamples whole weeks (`blockBootstrapCI`, `evidenceOfTrades`).
- **Multiple testing.** 8 hypotheses (4 strategies × 2 tiers) are judged at once, so the interval that must clear zero is Bonferroni-corrected (99.4%).
- **12+ different weeks** are needed, besides 30+ trades.
- **About 2 years of training data** (`--train-bars 17520`, cap raised to 20000), so the test window spans ~40 weeks instead of ~14. The retrain takes about 4 minutes once a day.
- **The forward test and the real-money lock** use the same weekly bootstrap, over 4+ different weeks.
- **Result:** no gate is open. The 4-hour trend's +0.24R on 157 trades came from 12 weeks of one downtrend; over 2 years it is −0.02R. The normal book (and its leverage tier) stays idle until a strategy truly proves itself. The learning book keeps testing the 6 undecided strategy–tier pairs at 0.25% risk.

**Ready for the API switch-offs:**
- **Jupiter** is retiring `lite-api.jup.ag` for `api.jup.ag` (same paths). Every Jupiter call (balances, prices, token names) now tries `lite-api.jup.ag` first, then `api.jup.ag`. Checked live with lite-api blocked: 143 assets read through api.jup.ag.
- **Polymarket** is moving price history from the CLOB's `/prices-history` to the Data API's `/v2/prices-history` (`{ data: [{ timestamp, price }] }`). Training, the momentum tracker and the `server.py` proxy fall back to it. Checked live with the CLOB blocked: 82 markets loaded through the Data API.
- The CSP allows both successor hosts, in the header and in every page.

## 2.1.0: Metyu learns from its own live results

- **Separate budgets for the two books.** The learning book's small research trades no longer count toward the normal book's 4 positions or its 3% side-risk cap. They have their own limits: 8 positions and 2% side risk. A strategy that passed the evidence gate is never blocked by research trades. Margin stays shared.
- **Live watchdog.** `liveReview()` looks at each strategy's last 20 closed trades (both books, in R). If they average below −0.25R, an open-gate strategy is demoted to the learning book and the log shows `DEMOTE`. It is promoted again as soon as the window recovers.
- **Board.** Each strategy shows its live record next to its out-of-sample evidence, and is marked when it has been demoted.
- **Stale data guard.** `fetchCandles` refuses a feed whose newest bar is older than 3 intervals (at least 30 minutes). Coinbase falls back to Kraken; if both are stale, the coin is not traded.
- **No hung ticks.** Polymarket requests now time out after 15 seconds like every other request.
- **Health in the status.** `health` lists stale prices, errors in the last hour and the model's age. The board shows `⚠ stale prices` and `⚠ SILENT` when the agent stops reporting.
- **Live board review** (iPhone 13, live data):
  - On GitHub Pages the board no longer asks for the local-server addresses (`/api/...`). It fetches the sealed account file only when an account is linked. This removes all 4 failed requests on every load.
  - The crypto panel's forward test now shows the **normal book** first (what real money would copy), then the learning book. Before, only the learning book was shown.
  - The gates line counts the newer coins' own gates.
  - The terminal's Sizer shows the evidence-based risk tier (for example 1.50%, 1.5x).
  - Trades are marked NORMAL BOOK or learning, and new coin.
  - Chart price labels at the same price share one label ("in/stop"); close labels are spaced so they never overlap.
  - The top banner says what is true today: Coinbase and Polymarket prices, a read-only wallet, no orders.
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
