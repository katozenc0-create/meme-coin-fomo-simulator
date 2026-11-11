# Does Metyu have an edge on Polymarket?

This folder holds the research behind Metyu's **evidence gate**. It uses virtual money only and reads Polymarket's public APIs only.

```bash
python research/collect.py data/dataset.json 6000   # ~6,000 resolved markets + price histories (≈15 min)
node research/evaluate.js data/dataset.json         # walk-forward, same code as the Prediction lab
```

`data/` is git-ignored.

## Method

| Choice | Why |
|---|---|
| ~6,000 resolved binary markets, sampled one day of scheduled end dates every six days for about a year | Over 300 markets resolve each day, so the most recent 6,000 would cover only about 3 weeks. |
| Samples: the YES price 1, 3, 7, 14 and 30 days before the **scheduled** end (`endDate`), dropped if the market had already closed | `closedTime` leaks the outcome: "by <date>" markets close early once the event happens. 1,885 of the 6,000 markets closed more than a day before their scheduled end. |
| Prices at ≤1¢ or ≥99¢ are skipped | These markets are effectively resolved, and their clamped log-odds would dominate the fit. |
| One effective observation per **event** | About 6,000 markets come from only about 1,260 events. The candidates of a "who wins" event and the horizons of one market share an outcome. Counting them separately made the model about 5× over-confident. |
| Walk-forward: 6 time blocks, each tested by a model fitted only on earlier events | This keeps the model from ever seeing the future. |
| Trades go through Metyu's own `advise()`, at most one per event, and pay half the spread plus the taker fee | Fee is assumed to be `takerBaseFee / 10,000 × min(p, 1 − p)` per share, when `feesEnabled`. |
| Gate: the 95% bootstrap interval of the per-$1 return must be above 0, with at least 30 trades | |
| Stress: the same test at double the spread | |

## Results (5,998 markets, 1,265 events, Sep 2025 – Nov 2026)

| Spread | Model | Horizon | Trades | Mean / $1 | 95% interval | Gate |
|---|---|---|---|---|---|---|
| 2¢ | calibration | 7 d | 330 | **+14.4%** | [+6.7%, +22.0%] | **open** |
| 2¢ | calibration | 30 d | 141 | +14.7% | [+2.5%, +26.5%] | **open** |
| 2¢ | calibration | 1 d | 206 | +4.1% | [−5.7%, +13.9%] | closed |
| 2¢ | rich | 7 d | 265 | +9.3% | [−0.0%, +18.5%] | closed |
| 4¢ | calibration | 7 d | 66 | +5.9% | [−12.0%, +22.5%] | closed |
| 4¢ | all others | – | – | positive means | intervals include 0 | closed |

The full output comes from `node research/evaluate.js`.

## Reproduction check: it did **not** reproduce

The Prediction lab ran the same walk-forward in the browser on a separately drawn sample of real markets. It used the calibration model, a 7-day horizon and a 2¢ spread. The sample was 5,979 markets in 1,061 events, with price histories at 12 h resolution only.

- The slope was 1.09 ± 0.09, similar to the research sample.
- Metyu made only **32** trades, averaging **−13.6%** per $1, with a 95% interval of [−34.9%, +7.0%]. **The gate stayed closed.**

The research sample's +14.4% therefore did not survive a different draw of markets and a coarser history. Treat the edge below as **not established**. The evidence gate exists to catch exactly this.

## What it means

- **Real:** Polymarket prices are slightly too timid. The calibration slope is about 1.07–1.14 at every horizon.
  - A recalibrated forecast beats the crowd's Brier score out of sample: 0.168 → 0.163.
  - Most profitable trades are buying **NO** on mid-priced YES (about 35–50¢), often sports markets that can end in a draw.
- **Fragile, and not reproduced:** in the research sample the edge clears its costs only if execution costs about 1¢ per share, and it did not survive the lab's independent sample (above). At 2¢ per share (4¢ spread) it is no longer statistically distinguishable from luck.
  - Many configurations were tried, which raises the chance of a lucky result.
  - Price histories are trade/mid prices, not guaranteed fills.
  - Metyu therefore still checks the **live order book** before trading, and the lab labels a gate that closes at double the spread as *fragile*.
- **Not real:** two earlier "edges" disappeared once their leaks were fixed.
  - Using the market's final total volume (only known after it closes) produced +10.7% per $1.
  - Counting horizons back from `closedTime` instead of `endDate` was the other leak.

No result here guarantees future profit. Edges like this shrink as others find them, and Polymarket access is restricted in some countries.
