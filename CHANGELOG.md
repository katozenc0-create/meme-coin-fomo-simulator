# Changelog

## 2.13.1: the real-money plan without manual entry

- As the owner chose, `docs/LIVE-TRADING-ARCHITECTURE.md` drops the manual-entry stage. Stage 1 is now supervised automation on a dedicated Hyperliquid account: one trade-only, expiring agent key on the owner's computer or a small VPS, and a separate, reviewed order adapter that enforces `LIVE_LIMITS` itself. Stage 2 is scaling, on a new approval.
- §3 lists the 10 steps in order, saying who does each and what it needs. Steps 4–6 (tickets, the board panel, the approval record) only compute and can be built now; the adapter waits for 6/6 and the owner's separate approval.

## 2.13.0: research: the funding carry passes the gate, but it is small

- `research/funding-carry.js` reads 2 years of Hyperliquid's real hourly funding for 30 coins and tests a delta-neutral carry: hold the coin, short its perp, collect the funding. Costs are expensive on purpose (0.59% per round trip).
- **Always holding** earned 5.6%/yr on notional across all coins, and 6.7%/yr on BTC/ETH/SOL. The corrected weekly interval is above zero in both calendar years. It is the first return source here that passes the gate.
- **It is small:** about 3%/yr on capital at 1x, and year 2 was half of year 1. It is written up in `research/README.md` as a low-risk way to prove the real-money pipeline, not a way to high profits. Nothing trades it yet.

## 2.12.1: the real-money architecture (design only)

- `docs/LIVE-TRADING-ARCHITECTURE.md`: how real trading through Fomo would work, in three stages. Stage 1: order tickets on the board, placed by hand in Fomo and reconciled read-only, with no keys. Stage 2: supervised automation on a dedicated Hyperliquid account, with a trade-only, expiring agent key on the owner's own machine and a separate, reviewed order adapter. Stage 3: scale. It lists the exit criteria for each stage and the decisions only the owner can make. Nothing is built; no order code.

## 2.12.0: link the Fomo perps account on the board

- As the owner asked, the perps account can be linked **on the Live Board**, without a GitHub secret, just like the Solana wallet.
  - Paste the public 0x address in the wallet panel ("Fomo perps account").
  - It stays in that browser only (`localStorage`). The board reads Hyperliquid's public `POST /info` directly: account value, open positions, spot USDC, approved API agents.
  - The overview shows a "Fomo perps" line next to the wallet.
- **Shared code.** The address check and the reader moved to `metyu-wallet.js`, so the board and `account-sync.js` (the optional `HYPERLIQUID_ADDRESS` secret) use the same code.
- **Safety:**
  - a Solana address is refused with the reason;
  - `looksLikeSecret` now also catches an EVM private key (64 hex), which any board field wipes at once with a loud warning;
  - the address only ever goes to Hyperliquid;
  - the order endpoint `/exchange` is never called (the preflight also guards this).
- CSP `connect-src` adds `https://api.hyperliquid.xyz`. Service worker cache `metyu-shell-v10`.

## 2.11.1: a bad perps address never breaks the wallet link

- The first `HYPERLIQUID_ADDRESS` value was refused as "not a 0x address" (the value itself is never shown). Because the refusal happened while choosing the provider, it also stopped the Solana wallet sync, and the account link went stale.
- `checkHyperliquidAddress` now:
  - forgives surrounding spaces, newlines, quotes and a missing `0x`;
  - names what is wrong without ever repeating the value: empty, a Solana address, a wrong length, not hex, or loudly a **private key** or **recovery phrase**, with the advice to delete the secret and move the funds;
  - lets a bad perps value only mark the perps part as not linked (`account-public.json` → `perps: { linked: false, error: "address <kind>" }`); the wallet keeps syncing.
- The daily report shows the Fomo perps account line.

## 2.11.0: Fomo integration: the perps account, read-only

- Fomo has no public trading API. Its perps trade on Hyperliquid, from the owner's account with a public 0x address. Metyu now **reads** that account, as it reads the Solana wallet: by its public address, with no key and no signing.
- **`account-sync.js`:**
  - With the new secret `HYPERLIQUID_ADDRESS`, `hyperliquidAccount` reads `clearinghouseState` (account value, withdrawable, open positions with side, size, entry, P&L, leverage and liquidation), `spotClearinghouseState` (USDC) and `extraAgents` (API agents allowed to trade for the account).
  - It uses only `POST /info`.
  - The perps account rides along with the Solana provider, or stands alone.
- **Private by default:** the detail is sealed with the board passphrase. `account-public.json` gets only counts (`perps: { linked, positions, agents }`). The address is redacted from every log, and a 64-hex private key is refused as an address.
- **Board:** the unlocked account panel shows a "Fomo perps (Hyperliquid account)" block: account value, withdrawable, spot USDC, each position, and a warning when API agents may trade for the account.
- Still no order code. Metyu cannot place a trade in Fomo or on Hyperliquid.

## 2.10.0: the venue: Hyperliquid perps (read-only)

- The owner chose the short-selling path, on a venue reachable from where they live (not Turkey: Turkish rules ban crypto derivatives and shorts for residents). Hyperliquid perps are the venue the Fomo app's perps route to, and they publish their data openly.
- **`--venue hyperliquid`:**
  - **Order books.** The execution check reads Hyperliquid's own order books (`l2Book`) instead of Coinbase spot.
  - **Funding.** One `metaAndAssetCtxs` request per tick records every coin's funding rate. After 6 readings, the median absolute rate times 8 replaces the 0.01% per 8 h floor when higher. Received funding is never credited.
  - **Listing.** QNT is not listed on Hyperliquid. It is never asked for, and the board, `status.execution.unlisted` and the preflight name it.
  - **Venue switch.** Samples from another venue are dropped when the venue changes.
- **Transport:** `getJson(url, body)` POSTs a JSON body, used only for the read-only `/info` endpoint.
- **Preflight:**
  - fails the build if `hyperliquid.xyz/exchange` (the order endpoint) appears in the source;
  - on a perps venue, replaces the spot check with venue coverage: how many recent trades were on coins the venue lists.
- **Shadow orders** record whether the venue lists the coin (`venueOk`) next to the old spot flag.
- **First reading (25 Nov 2026):**
  - Hyperliquid's books are deeper than Coinbase spot for most coins; every coin fills a $5,000 order within 20 levels.
  - Only RENDER and ALGO (~0.10%), ZRO and TIA (0.06–0.07%) cost more than the 0.05% floor.
  - Funding is mostly 0.00125% an hour (0.01% per 8 h, which shorts receive); ZRO is at 0.021% per 8 h.

## 2.9.1: the real-money preflight

- **`scripts/preflight-live.js`**: one checklist for a real-money release, run against the code and the published state; it sends nothing.
- **Code checks (must always pass):**
  - no order, cancel, withdraw or signing call in any source file;
  - `LIVE_LIMITS` ($25 / $100 / $50 / 1x), the cost floors, the gate's bars (30 trades, 12 weeks, the multiple-testing correction) and the kill-switch unchanged;
  - no key, token or recovery phrase in the repository.
  - `tests/preflight.test.js` runs these on every CI run, so order code or a committed key fails the build.
- **Readiness checks:** the six conditions, shadow orders never sent (exit 1 if one ever was), the linked account read-only, fresh and without token approvals, and order-book costs measured for every coin.
- **Spot reality.** The first run found that 82 of the last 84 trades were SHORT (+$574.80). A spot account could have placed only the 2 LONG trades (−$27.85). A real-money release needs a venue that allows shorts, or the strategies' long side must pass the gate on its own. The owner has to decide this (SECURITY.md, go-live checklist step 2).
- The daily steward runs the preflight every morning (docs/STEWARD.md).

## 2.9.0: execution realism: costs from real order books

- Real-money preparation: the paper results must not be better than real trading could be. A first measurement of all 31 Coinbase order books, for a $5,000 paper-size order, found:
  - the core coins cost at most about 0.08% per side;
  - several newer coins cost 0.10–0.30% (PEPE 0.14–0.30%, ZRO 0.20%, RENDER 0.16–0.19%, ALGO 0.15%, FET 0.15%), against the 0.05% the agent assumed.
- **Measured costs.** Every tick the agent reads 4 order books in turn (`--exec-probes 4`; about every 2 hours per coin): half the spread, plus the depth a $5,000 order walks. After 6 samples, the median of the last 48 replaces the 0.05% slippage floor when it is higher. It is used for sizing, marks, exits and the walk-forward training, so the evidence gate judges each coin at its real cost. A book too thin to fill counts at the 1% cap.
- Costs never go below the floor, so the gate can only get stricter. Shown on the board (crypto panel, "Execution check") and in the daily report; `status.execution` lists every coin.

## 2.8.1: the market at a glance; a hypothesis tested and rejected

- **Market reader.** `marketTrendSeries`, `marketTrendAt` and `marketSummary` read Bitcoin's 4-hour trend, each known only at its bar's close, plus breadth (coins trending up, down or sideways). The overview shows one line, for example "Market: BTC 4h downtrend for 3 days · coins 29 down · 2 range · 0 up". Strategies can read the market through the backtest and live context.
- **Tested and rejected: the market-aligned breakout.** The range breakout taken only in BTC's 4h direction looked better on the 2018–2024 episodes (+0.19R vs +0.08R). On the training window it lost more than the plain breakout (core −0.17R over 773 trades, 95% interval below zero), so it was not added; the gate's family stays 4 × 2. Written up in `research/README.md`.
- Test fix: the vault test's "ciphertext only" check now looks for quoted keys that base64 cannot contain. The old check (the text "BTC") could match a random ciphertext.

## 2.8.0: market history: the strategies tested in 13 past episodes

- **`metyu-history.js`**: a catalogue of the crypto market's big past episodes (2018 to mid-2024), each dated and typed as a crash, bear market, bull run or flat range, with a short factual note. Examples: the 2018 bubble burst, the COVID crash, May 2021, Terra/LUNA, Celsius/3AC, FTX, the USDC depeg, the 2023 range, the spot ETF rally and the 2024 yen carry unwind.
- **Stress test**: every week, and whenever training picks new parameters, the agent replays its current strategies through each episode on real Coinbase hourly bars (BTC, ETH, LTC, BCH, LINK), all costs included. Only trades opened inside an episode count. All episodes lie before the 2-year training window, so this is out-of-sample.
- **First result** (current parameters): the trend and breakout strategies earn in crashes and bear markets (crash: breakout +0.41R over 185 trades, trend +0.24R over 128) and lose in flat ranges (trend −0.20R, breakout −0.23R); range reversion loses in most kinds. The edge Metyu shows today comes from falling markets, which explains why it is mostly short now.
- Shown on the board (crypto panel, "History test"), in the daily report and in the log (`STRESS`). Information only: no gate, size or rule changes.
- Training every 12 hours instead of 24 (`--retrain 12`).

## 2.7.0: fresh data on the board

- **No stale CDN copy.** raw.githubusercontent.com serves the branch files with `max-age=300` and ignores the query string, so the board could show the agent's state up to 5 minutes late. `metyu-fresh.js` asks the GitHub API which commit `autopilot-data` points at (the SHA only, revalidated by its ETag) and reads the files at that commit, an immutable URL that is never stale. The board now sees a publish within about 90 seconds.
- **Within GitHub's limits.** At most one API check every 90 s (≤ 40 an hour, under the 60/hour unauthenticated limit), shared by every file; a rate limit pauses the checks until GitHub resets it. Any failure falls back to the branch URL, as before.
- **Less mobile data.** A file at a commit never changes, so the browser may keep it; only a new publish downloads again.
- CSP `connect-src` adds `https://api.github.com` (read-only, nothing but the public repository name is sent). Service worker cache `metyu-shell-v9`.

## 2.6.1: the simple board

- As the owner asked, the board opens with **only two panels**: the live overview and the Metyu terminal, right under it.
- Every other panel moves behind one **"All panels ▾"** button: the wallet link, the crypto and prediction-market agents, the account and the demo simulator. They stay in the page, so the wallet check, the account and the agents keep running. The choice is remembered.
- Service worker cache `metyu-shell-v8`.

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
