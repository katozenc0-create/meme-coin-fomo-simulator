# Meme Coin FOMO Simulator

A browser-based practice ecosystem for trading with **virtual money only**. It has three parts: a meme-coin game, a prediction-market lab with the Metyu agent, and a live board.

## Ecosystem

| Page | What it is for |
|---|---|
| `index.html` · **FOMO simulator** | A meme-coin trading game. Covers charts, liquidity, slippage, position sizing, stop-loss / take-profit and rug pulls. |
| `polymarket.html` · **Metyu Prediction Lab** | Metyu, an agent for YES/NO prediction markets. Includes autopilot, leverage with liquidation, a backtest lab, a live advisor (order-book aware), training on resolved Polymarket markets, and a knowledge base. |
| `board.html` · **Metyu Live Board** | Metyu trades eight markets at once from one virtual account, in demo or live mode. Includes portfolio limits, manual control, an equity curve and CSV export. |

How the pieces fit:

```text
index.html ─┐
polymarket.html ─┼─> metyu-agent.js   (shared, dependency-free logic: pricing, Kelly, leverage,
board.html ─┘                          decisions, simulator, training, order book, CSV, data client)
       │
       └─ data: /api/polymarket/* on server.py (cache + rate limiting)
                └─ falls back to gamma-api / clob.polymarket.com directly (CORS), e.g. on GitHub Pages
```

All Polymarket access is **read-only**: no wallet, no keys, and no orders, ever. Polymarket itself has no leverage; leverage here is a simulated margin account. Access to Polymarket is restricted in some countries. Nothing here is financial advice.

**Metyu advises, you execute.** Every live market in the Prediction Lab (advisor verdict and open paper positions) and on the Live Board links to its page on polymarket.com (`Metyu.polymarketUrl`, built only from well-formed slugs). If you choose to act on a suggestion, you place the order yourself, in your own account; Metyu never sees a wallet or key. On Polymarket your margin buys shares without leverage. Note that with all leaks closed the evidence gate stays closed (see `research/README.md`), so Metyu does not currently find trades worth taking.

## Features (FOMO simulator)

- Dark trading-terminal interface inspired by professional market dashboards
- Responsive layout for phones, tablets, laptops, and desktop screens
- Simulated practice wallet with a configurable bankroll
- Distinct meme-coin market scenarios
- Stochastic market behavior with trend, chop, panic, mean reversion, and random shocks
- OHLC candlestick chart with close-price line graph
- Tap or click the chart to buy at the current price
- Simulated trade feed and wallet P&L
- Rug-pull and liquidity-risk practice scenarios
- Beginner crypto learning lab
- Real OHLC CSV import for replaying verified historical data
- No wallet connection and no real funds

## Run Locally

### Option 1: Open the page directly

Open `index.html` in a modern browser.

### Option 2: Use the Python server

Python 3.10 or newer is recommended.

```bash
python server.py
```

Open this address in your browser:

```text
http://127.0.0.1:8000
```

Use a different host or port if needed (the `HOST` and `PORT` environment variables also work):

```bash
python server.py --host 0.0.0.0 --port 8080
```

The server only serves the game's static assets; source files, dotfiles, and the `.git` folder are never exposed.

The Polymarket proxy endpoints are read-only and polite to the upstream API:

- At most 4 requests go to Polymarket at the same time.
- Successful responses are cached briefly: 5s for order books, 10s for single markets, 30s for market lists, 5 min for resolved lists, and 1 hour for price histories.
- Errors are never cached.

### API (read-only)

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /api/health` | `{"status": "ok", "realFunds": false}` | – |
| `GET /api/polymarket/markets?limit=N` | active markets, busiest first | 30 s |
| `GET /api/polymarket/market?id=<numeric>` | one market (price, or resolution once closed) | 10 s |
| `GET /api/polymarket/book?token_id=<numeric>` | CLOB order book, best levels first | 5 s |
| `GET /api/polymarket/resolved?limit=N&offset=M` | closed markets, most recent scheduled end first | 5 min |
| `GET /api/polymarket/resolved?limit=N&end_min=YYYY-MM-DD&end_max=YYYY-MM-DD` | whole closed **events** whose scheduled end falls in the window, flattened to markets (`limit` counts events, so expect many more markets) | 5 min |
| `GET /api/polymarket/history?token_id=<numeric>&fidelity=<min>` | price history `[{t, p}]` | 1 h |

Ids are validated as numeric (anything else gets a 400). Responses carry only the fields the pages use, plus a flat `eventId`. If Polymarket is unreachable, the endpoints return 502.

## How to Use the Simulator

1. Choose a market case and set a virtual practice bankroll (changing the bankroll starts a new session).
2. Choose a position size and, optionally, a **stop loss %** and **take profit %**.
3. Click **Start Trade** to start the market.
4. Enter by tapping the chart or with **Buy At Market** (both fill at the current price), or wait and **Buy The Top** at the peak.
5. Manage the position:
   - **Sell All Now** closes it at market while the price is still rising; you can re-enter before the peak.
   - The **Sell** tab sells 25%, 50% or 100% of the position.
   - Stop-loss and take-profit orders fill automatically. Gaps such as rug pulls can fill below the stop.
6. At the peak, choose **Hold To Resolution**, **Sell All At Peak**, or **Skip The Top**, then record the result.
7. Review the round and session P&L. The portfolio rail tracks session P&L, rounds played, win rate, and best/worst round.
8. Press **Next Practice Round**. Your practice equity carries over between rounds and across market cases.

Every fill includes estimated slippage (higher for volatile cases and larger sizes) plus a 0.3% fee per side. The open-position line shows size, average entry, unrealized P&L, and active SL/TP levels.

Use the **1m / 5m / 1h** chart tabs to change candle grouping. Settings (motion effects, price precision, risk reminders) are saved in your browser.

## Metyu Prediction Lab (Polymarket-style agent)

Open `polymarket.html` (or **Metyu Lab** in the top navigation). Metyu is a paper-trading agent for binary YES/NO prediction markets:

- **Fair value**: combines the market price and private research by precision (Bayesian, log-odds space), tracking evidence with a time-aware Kalman filter.
- **Trade filter**: trades only when the edge beats the spread, a minimum edge, and 1.5σ of its own uncertainty. With no information it does not trade.
- **Sizing**: fractional (¼) Kelly with a per-position cap and a drawdown kill-switch.
- **Leverage**: a simulated margin account with interest, a liquidation price, and a liquidation penalty. Metyu scales leverage with edge/volatility and never holds leverage into resolution. A **gap guard** keeps the liquidation price at least 8¢, and at least 3× the largest recent one-step move, away from the entry, because news gaps skip past any stop.
- **Stale information**: research may predate the market's latest moves, so the log-odds variance of recent moves is added (×0.1) to the research's uncertainty. Metyu then bets less against a crowd that has just learned something.
- **Exits**: when the edge is gone, near liquidation, on a broken thesis, or by the kill-switch. There are no blind price stops on unlevered binaries.
- **Decision log**: every action comes with its reasons. Brier scores compare Metyu with the crowd.
- **Backtest lab**: compares Metyu's rules with full Kelly, forced 3x/10x leverage, and "trade every signal" over many simulated markets.
- **Scenario stress test** (`Metyu.stressTest`): your current rules against 13 situations. These are an efficient crowd, noisy, biased and stale research, news shocks, pump-and-dump with and without research, an 8¢ spread, whipsaw, a sharp crowd, a slow crowd, late reversals, and disputed resolutions. Each scenario runs many markets with a fresh $1,000 and reports the average, worst 5%, worst market, share of markets lost, and liquidations. The test suite requires every scenario to average better than −3% with no market worse than −25%, and checks that reckless rules fail the same bar.
  - With the default rules, no scenario averages worse than about −0.5%, and the worst single market loses about 8%. Two choices were measured and are deliberate:
    1. A robust (Huber) down-weighting of far-off research was **not** adopted: it removed only 0.1 points of loss from biased research and cost about 30% of the profit from good research.
    2. The staleness rule gives up most of the profit from fading a pump-and-dump, because in the moment a manipulated move and an informed move look the same.
- **Knowledge base**: Polymarket mechanics, EV, Kelly, leverage on binaries, costs, resolution, and calibration.

**Live advisor:** pick a live market, or type a price, then enter **your** probability and how sure you are. Metyu applies its rules and shows:

- whether to trade, and on which side
- entry price, margin (your maximum loss), leverage and notional
- liquidation price
- payout if right, expected profit, and break-even probability

For live markets, Metyu reads the market's recent 12-hourly price history from the public CLOB. That history feeds the gap guard (no leverage after big jumps). It also feeds the staleness rule: a view typed in after the market has just moved counts for less, while a trained model's estimate, computed from today's price, does not. The simulator-calibrated momentum and fade terms are never applied to real markets. Metyu also reads the outcome's public CLOB order book and walks the asks to find the real average fill. If the fill would eat the edge, it cuts the size or refuses the trade, and the verdict shows the levels used and the book depth.

You can track a recommendation as a paper position. Paper positions follow the Live Board's portfolio rule: at most 2 open per category. A third crypto idea, for example, gets "No trade" with the reason, until one of the others is closed or settled. The advisor also sizes from **paper equity**, which is the bankroll plus all paper P&L, realized and open. After losses it recommends smaller positions. When paper equity falls further below its peak than the **Max drawdown** setting, the kill-switch halts new recommendations. Before this change the advisor always assumed you were at your peak, so the kill-switch could never fire. The peak starts over when you change the paper bankroll or clear all paper positions. The Live Board's other two limits also apply: total open notional is capped at 1.5× paper equity, with at most 6 open positions. A new idea is cut to fit the room that is left, or refused, and the reason is shown. Each open paper position also shows **Metyu's verdict** (`Metyu.reviewPosition`), for example "Metyu: close — edge gone". The verdict comes from the same exit rules the Live Board applies to its own positions: edge gone, near liquidation, stop on leverage, and no leverage held into resolution. They are applied to the probability Metyu held at entry, the latest price and the time left. Positions saved before this feature show no verdict, rather than a guessed one. Paper positions are marked to the live price (optionally refreshed every 30s) and are kept in your browser, along with the lab account and settings. When a live market resolves, its paper positions settle automatically: winners pay $1 per share and losers $0, after any borrowed amount is repaid. The settled result moves into resolved P&L.

**Training and the evidence gate (virtual money):** the Training panel learns from markets that have already resolved. It takes the YES price 1–30 days before each market's **scheduled** end and whether YES won. Two models are available:

- **Calibration:** σ(a + b·logit p).
- **Rich:** also uses the horizon, 3-day momentum, category and grouped-event flag. Final volume is deliberately left out, because it is only known after the market closes.

How the models are judged:

- **Walk-forward:** events are ordered in time, and each block is paper-traded by a model fitted only on earlier events. Trades go through Metyu's `advise()` and pay the spread and the taker fee.
- **Evidence gate:** opens only if the 95% interval of the out-of-sample return per $1 is above zero, over at least 30 trades. A stress run at double the spread labels an open gate *robust* or *fragile*.
- **Gate closed:** the advisor shows Metyu's view but never trades on the model, and the Live Board watches without trading.
- **Gate open:** the live order book still has to confirm the price.
- **Grouped events:** candidates of one event count once and get at most one trade. Samples after a market's actual close are dropped, because early closes leak the outcome.
- **Data:** live Polymarket data (up to 6,000 markets, sampled by scheduled end date over months) or simulated data (a calibrated control and longshot bias).

What the research found on real data is written up in [`research/README.md`](research/README.md). In short, there is **no edge** after costs. Every apparent edge, including one with a 95% interval above zero, turned out to be a form of look-ahead. With leak-free walk-forward on two independent year-long samples, Metyu makes almost no trades and its evidence gate stays closed.

**Live data (read-only):** **Load live Polymarket** fetches active markets from the public Gamma API, through `python server.py` (`/api/polymarket/markets`, `/api/polymarket/market?id=<numeric id>` for one market, and `/api/polymarket/book?token_id=<numeric token id>` for an order book) or directly from the browser. Only the starting price is live; the path after that is simulated. No wallet, keys, or orders are involved. Polymarket itself has no leverage, and access is restricted in some countries.

The simulator's hidden probability is a calibrated martingale that resolves to 0 or 1, so results reflect real edge rather than model artifacts. No agent can guarantee profit: real-world edge is rare and small.

## Metyu autopilot (virtual money, 24/7, no browser)

`autopilot.js` runs Metyu on live Polymarket markets around the clock with **virtual money**. It reads market data only: no wallet, no keys, no orders. It applies exactly the Live Board's and the live advisor's rules:

- **Entry:** only a model whose evidence gate is open may open positions. Without such a model, the autopilot watches and manages but opens nothing.
- **Costs:** taker fees from Polymarket's fee schedule, and real order-book fills.
- **Risk:** gap guard on the 12-hourly price history, at most 1.5× equity in total, at most 6 open positions and at most 2 per category, and a kill-switch that flattens everything.
- **Exits:** each position is managed with Metyu's exit rules and settled at $1 or $0 when its market resolves.

```bash
python3 server.py --port 8000 &                       # read-only proxy (or omit --api to call Polymarket directly)
node autopilot.js --api http://127.0.0.1:8000 --model model.json --interval 300
node autopilot.js --once                              # one tick, then exit (for cron)
node autopilot.js --api http://127.0.0.1:8000 --train 1500 --retrain 24   # trains itself
```

**Self-training:** with `--train N`, the autopilot retrains every `--retrain` hours (24 by default) on N freshly sampled resolved markets. It uses the Prediction Lab's exact pipeline: `Metyu.loadResolvedMarkets` and `Metyu.trainModel`, meaning walk-forward plus the evidence gate. The new model replaces the old one, and its gate alone decides whether it may trade. Each run is recorded in `trainings` and the log. A failed run is retried after an hour. On a real run with `--train 300`, it trained on 407 resolved markets in about 35 s; the gate stayed closed with 0 out-of-sample trades, so the autopilot kept watching.

Its state (account, positions, trade history and log) lives in `data/autopilot.json`, which is git-ignored. The file is written atomically after every tick and on Ctrl-C, so a restart continues where it left off. The `model.json` is a model trained in the Prediction Lab and saved with its **Download model (autopilot)** button. Currently every honest model's gate is closed (see `research/README.md`), so the autopilot will watch rather than trade, which is the correct behaviour.

**Watching it:** open the Live Board through `python3 server.py`. The **Autopilot · 24/7** panel at the top shows the running autopilot, read-only and refreshed every 30 s:
- equity, with open positions marked by Metyu's own accounting;
- realized P&L, trades and win rate;
- open positions;
- the evidence gate, the last training and the last tick;
- the autopilot's log.

It reads `GET /api/autopilot/status`, which summarises the state file (`--autopilot-state` or `AUTOPILOT_STATE`, default `data/autopilot.json`) without the model's parameters.

**Running it continuously:**
- **Linux (systemd):** `deploy/metyu-server.service` and `deploy/metyu-autopilot.service` restart on failure, start at boot, and may write only to `data/`. Run `mkdir -p data` first, because systemd needs the writable folder to exist. Then copy them to `/etc/systemd/system/`, set `User=` and `WorkingDirectory=`, and run `sudo systemctl enable --now metyu-server metyu-autopilot`. Watch the output with `journalctl -fu metyu-autopilot`.
- **Without a service manager:** run one tick every 5 minutes from cron, for example `*/5 * * * * cd /path/to/repo && node autopilot.js --once --api http://127.0.0.1:8000 --train 1500`. Each run loads the state file, ticks, saves and exits.
- **Windows:** use Task Scheduler with the same `--once` command.

Stopping it (Ctrl-C, `systemctl stop`, SIGTERM) saves the state first.

## Metyu on iPhone / iPad: install from Safari

Metyu is an **installable web app** for iPhone and iPad. iOS does not install apps from downloaded files: a native App Store or TestFlight app needs a paid Apple Developer account and signing on a Mac. Installed from Safari, Metyu still behaves like an app: its own icon on the home screen, full screen, and it opens without a network.

<img src="icons/iphone-qr.svg" alt="QR code: open the Metyu Live Board" width="160" align="right">

1. **One-time setup:** turn on GitHub Pages for this repository (see [GitHub Pages](#github-pages)). Until it is on, the address below and the QR code return "404".
2. On the iPhone, open `https://katozenc0-create.github.io/meme-coin-fomo-simulator/board.html` in **Safari**, or scan the QR code with the camera.
3. Tap **Share** (the square with the arrow) → **Add to Home Screen** → **Add**. While the board runs in Safari it shows this tip itself; the tip disappears once you dismiss it or open Metyu from the home screen.
4. Open **Metyu** from the home screen. If the board was running when you left, it resumes by itself, and it refreshes live prices the moment you come back to it (iOS pauses apps in the background). Live mode reads Polymarket prices directly; the board, the Lab and the game also open offline.

How it works:
- `manifest.webmanifest` describes the app; `icons/` holds its icons (iOS needs PNG touch icons).
- `sw.js` is a service worker. It keeps the pages available offline but never caches live market data (`/api/…`, Polymarket), so prices are never stale.
- Each page carries the iOS home-screen tags and respects the iPhone's safe areas (notch and home indicator).

To see a running autopilot on the iPhone, open the board from your own `server.py` (`--host 0.0.0.0`, over HTTPS for installing); the autopilot panel appears when the server is reachable.

## Metyu Live Board (virtual money)

Open `board.html`, or use **Live Board** in the navigation. Metyu trades eight markets at once from one virtual account.

- **Demo mode:** simulated markets stream continuously. When one resolves, a new one takes its place. A slider sets how accurate Metyu's research is.
- **Live mode:** follows the eight busiest open Polymarket binary markets, with read-only prices refreshed every 30s. Positions settle when a market resolves. Live decisions follow the same rules as the live advisor. The gap guard reads each market's 12-hourly CLOB history, because 30-second ticks hide real jumps. Simulator momentum/fade and the staleness discount, which is for a person's view and not a model's, are switched off.
  - Metyu's belief comes from the model trained in the Prediction lab.
  - Without a trained model, or when the model sees no edge, Metyu watches and does not trade.
- **Board view:** equity, P&L, cash and open positions, win rate, drawdown, an equity curve, and a decision feed.
- **Portfolio limits:** a cap on total notional (1x–3x of equity) and on the number of open positions. Trades that would break a limit are cut down or skipped, and the feed says why. A third limit, **max per category** (2 by default), caps open positions in one category. The category comes from Polymarket's own fee category (Gamma `feeType`: politics, sports, crypto, tech, finance, economics, culture, weather) and falls back to keywords, which leaves about 1 in 100 live markets uncategorised (it was 26 in 100 with keywords alone). This grouping (`Metyu.marketCluster`) is separate from the trained model's category feature, so saved models stay valid. Markets that share a driver move together, and a model that is wrong about one of them is usually wrong about all of them. `Metyu.portfolioStressTest` trades 8 correlated markets at once with the same research error in all of them. Without the cap, the worst 5% of outcomes lose about 19%; with it, about 10%. With independent markets the cap changes nothing.
- **Manual control:** every card has a **Close** button, and **Flatten all** closes every position. Metyu waits a few ticks before it re-enters a market you closed by hand.
- **Export trades (CSV):** downloads every closed virtual trade: open and close times, market, side, leverage, entry and exit prices, Metyu's fair value at entry, margin, notional, P&L and the reason it closed. Cells that start like a formula are neutralised so a spreadsheet will not run them.
- **Saved state:** the account and the last 1,000 trades are kept in the browser.

## Market Scenarios

The built-in scenarios are fictionalized practice replays inspired by common public meme-coin patterns. They are not exact historical records.

- Rocket Dog: long-run community-driven moonshot
- Shelter Dog: viral narrative and supply pressure
- Green Frog: explosive attention followed by a fade
- Solana Dog: volatile two-sided chop
- Hat Dog: fast breakout with uncertain continuation
- Melon: anonymous rug-pull risk

Each round includes randomized behavior so the same scenario does not always follow the same path.

## Import Real OHLC Data

The page can import a CSV containing verified historical candle data. The file must include `open`, `high`, `low`, and `close` columns. A timestamp column is optional.

Example:

```csv
timestamp,open,high,low,close
2024-01-01,0.0000010,0.0000012,0.0000009,0.0000011
2024-01-02,0.0000011,0.0000015,0.0000010,0.0000014
2024-01-03,0.0000014,0.0000016,0.0000012,0.0000013
```

Imported data is labeled as source data in the interface. The first ~80% of the candles are replayed live; the remaining candles are revealed when the round resolves, so the outcome comes from your data rather than a random scenario. The application does not download or verify market data automatically.

## Learning Topics

The learning lab introduces:

- Expected value and probability
- Log returns and volatility
- Momentum and acceleration
- Liquidity and market impact
- Bayesian updating
- Regime changes and reflexivity
- Position sizing and drawdown control
- Why market predictions are uncertain

These concepts are educational explanations, not trading signals or financial advice.

## GitHub Pages

The static browser version can be hosted with GitHub Pages:

1. Create a public GitHub repository.
2. Upload `index.html` and `README.md`.
3. Open the repository's **Settings**.
4. Select **Pages**.
5. Choose **Deploy from a branch**.
6. Select the `main` branch and the root folder.
7. Click **Save**.

Pages serves over HTTPS, which is what lets an iPhone install Metyu from Safari (see "Metyu on iPhone / iPad").

GitHub will provide a public address similar to:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

GitHub Pages does not run `server.py`, but every page still works there, live Polymarket features included. Polymarket's public APIs allow cross-origin browser requests, so without the local proxy the pages call `gamma-api.polymarket.com` and `clob.polymarket.com` directly. They try the proxy once and then stop trying. The Python server adds response caching and a limit on simultaneous requests.

## Tests

```bash
python -m unittest discover -s tests -t .   # server: static files, API proxies, cache
node --test tests/*.test.js                 # Metyu agent logic (npm test)
npm install && npx playwright install chromium
npm run test:e2e                            # browser end-to-end tests (Playwright)
```

The browser tests start `server.py` on a free port and drive all three pages in Chromium: the game, the Prediction lab and the Live Board. They mock every Polymarket response, so they need no network, and they fail fast if a page tries to reach the real Polymarket.

Every pull request and push to `main` runs all three suites (`.github/workflows/tests.yml`).

## Technology

- HTML
- CSS
- JavaScript (`metyu-agent.js` is shared by the browser and Node tests)
- SVG chart rendering
- Python standard-library HTTP server

No external packages are required.

## Important Disclaimer

This is a fictional, educational simulator. It does not connect to cryptocurrency exchanges, wallets, blockchains, or real funds. It does not provide financial advice or guarantee prediction accuracy. Real cryptocurrency markets involve substantial risk, including total loss.
