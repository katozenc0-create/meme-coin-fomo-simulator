# Meme Coin FOMO Simulator

A browser-based crypto trading practice game for learning charts, volatility, liquidity, position sizing, slippage, and meme-coin risk without using real money.

## Features

- Dark trading-terminal interface inspired by professional market dashboards
- Responsive layout for phones, tablets, laptops, and desktop screens
- Simulated practice wallet with a configurable bankroll
- Distinct meme-coin market scenarios
- Stochastic market behavior with trend, chop, panic, mean reversion, and random shocks
- OHLC candlestick chart with close-price line graph
- Tap or click anywhere on the chart to simulate a market entry
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

The server also provides a health endpoint:

```text
http://127.0.0.1:8000/api/health
```

## How to Use the Simulator

1. Choose a market case and set a virtual practice bankroll (changing the bankroll starts a new session).
2. Choose a position size and, optionally, a **stop loss %** and **take profit %**.
3. Click **Start Trade** to start the market.
4. Enter by tapping the chart (fills at that candle's price) or with **Buy At Market**, or wait and **Buy The Top** at the peak.
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
- **Leverage**: a simulated margin account with interest, a liquidation price, and a liquidation penalty. Metyu scales leverage with edge/volatility and never holds leverage into resolution.
- **Exits**: when the edge is gone, near liquidation, on a broken thesis, or by the kill-switch. There are no blind price stops on unlevered binaries.
- **Decision log**: every action comes with its reasons. Brier scores compare Metyu with the crowd.
- **Backtest lab**: compares Metyu's rules with full Kelly, forced 3x/10x leverage, and "trade every signal" over many simulated markets.
- **Knowledge base**: Polymarket mechanics, EV, Kelly, leverage on binaries, costs, resolution, and calibration.

**Live advisor:** pick a live market, or type a price, then enter **your** probability and how sure you are. Metyu applies its rules and shows:

- whether to trade, and on which side
- entry price, margin (your maximum loss), leverage and notional
- liquidation price
- payout if right, expected profit, and break-even probability

For live markets, Metyu also reads the outcome's public CLOB order book and walks the asks to find the real average fill. If the fill would eat the edge, it cuts the size or refuses the trade, and the verdict shows the levels used and the book depth.

You can track a recommendation as a paper position. Paper positions are marked to the live price (optionally refreshed every 30s) and are kept in your browser, along with the lab account and settings. When a live market resolves, its paper positions settle automatically: winners pay $1 per share and losers $0, after any borrowed amount is repaid. The settled result moves into resolved P&L.

**Live data (read-only):** **Load live Polymarket** fetches active markets from the public Gamma API, through `python server.py` (`/api/polymarket/markets`, `/api/polymarket/market?id=<numeric id>` for one market, and `/api/polymarket/book?token_id=<numeric token id>` for an order book) or directly from the browser. Only the starting price is live; the path after that is simulated. No wallet, keys, or orders are involved. Polymarket itself has no leverage, and access is restricted in some countries.

The simulator's hidden probability is a calibrated martingale that resolves to 0 or 1, so results reflect real edge rather than model artifacts. No agent can guarantee profit: real-world edge is rare and small.

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

GitHub will provide a public address similar to:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

GitHub Pages runs the browser game but does not run `server.py`. Use the Python server locally or deploy it separately to a Python-capable service.

## Tests

```bash
python -m unittest discover -s tests -t .
node --test tests/*.test.js
```

Both suites run automatically on every pull request and on pushes to `main` (`.github/workflows/tests.yml`).

## Technology

- HTML
- CSS
- JavaScript (`metyu-agent.js` is shared by the browser and Node tests)
- SVG chart rendering
- Python standard-library HTTP server

No external packages are required.

## Important Disclaimer

This is a fictional, educational simulator. It does not connect to cryptocurrency exchanges, wallets, blockchains, or real funds. It does not provide financial advice or guarantee prediction accuracy. Real cryptocurrency markets involve substantial risk, including total loss.
