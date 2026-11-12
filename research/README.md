# Does Metyu have an edge on Polymarket?

This folder holds the research behind Metyu's **evidence gate**. It uses virtual money only and reads Polymarket's public APIs only.

```bash
python research/collect.py data/dataset.json 6000 [SHIFT_DAYS] [EVENTS_PER_WINDOW]   # ≈20–30 min
node research/evaluate.js data/dataset.json    # walk-forward, same code as the Prediction lab
```

`data/` is git-ignored.

## Answer

**No.** After fixing every leak found so far, two independent multi-month samples give **no evidence of an edge** after costs. They span about 19 and 29 months. On those samples Metyu makes almost no trades, and its evidence gate stays closed for every model, horizon and spread tried.

What is real is small. A recalibrated forecast is slightly better calibrated than the crowd: its Brier score improves by about 0.003–0.004, and not every test shows it. That is far too little to pay the spread and fees.

## Method

| Choice | Why |
|---|---|
| Whole **events** per window of scheduled end dates: 5 events per day, one day every six days, going back from yesterday | Taking "the first N markets" of a window can keep an event's losers and drop its winner, which biases the sample toward NO. Big events hold dozens of markets, so 5 events per window spreads 6,000 markets over many months (19–29 months in the samples below). |
| Samples: the YES price 1, 3, 7, 14 and 30 days before the **scheduled** end (`endDate`), dropped if the market had already closed | `closedTime` leaks the outcome: "by <date>" markets close early once the event happens. |
| Prices at ≤1¢ or ≥99¢ are skipped | These markets are effectively resolved. |
| Each event carries a total weight of 1 | Candidates of an event, and horizons of one market, share an outcome. |
| Walk-forward over 6 time blocks. Each block trains only on events that had **actually resolved** (`closedTime`) before the block's **earliest decision** (each sample's end minus its horizon) | A test trade is placed up to 30 days before its market ends. Training on events that resolved after it, including date ladders and late or disputed resolutions, uses outcomes unknown at trade time. |
| Trades go through Metyu's own `advise()`, at most one per event, and pay half the spread plus the taker fee | The fee is assumed to be `takerBaseFee / 10,000 × min(p, 1 − p)` per share. |
| Gate: the 95% bootstrap interval of the per-$1 return must be above 0, with at least 30 trades | |

## Results with the corrected method

| Sample | Markets / events (span) | Best 2¢ result | Gate |
|---|---|---|---|
| Sample A: `collect.py 6000 0 5` | 4,542 / 478 (Apr 2025 – Nov 2026) | no trades at any horizon or model | closed |
| Sample B: `collect.py 6000 3 5` | 4,617 / 716 (Jun 2024 – Nov 2026) | 4 trades at most | closed |
| Old discovery sample, re-evaluated | 5,998 / 1,265 | calibration, 7 d: 1 trade (was 330); at most 3 trades anywhere | closed |
| Old replication sample, re-evaluated | 5,999 / 1,309 | calibration, 7 d: 1 trade; at most 2 anywhere | closed |

Brier scores, crowd → model (calibration / rich): Sample A 0.1642 → 0.1614 / 0.1606, Sample B 0.1524 → 0.1498 / 0.1491. At a 4¢ spread there are no trades anywhere.

## How the earlier "edges" fell apart

Each of these looked significant at first, and each was an artifact:

1. **Final volume as a feature:** +10.7% per $1. A market's total volume is only known after it closes, so this was look-ahead.
2. **Horizons counted from `closedTime`:** markets that close early reveal their outcome. Fixed by counting from `endDate`.
3. **Over-confidence:** one market's horizons were counted as independent, making the model about 5× too sure of itself.
4. **Walk-forward without a purge:** +14.4% per $1 over 330 trades, with the gate open. The model learned from events that resolved after its test trades were placed, for example results from the same league in the following weeks. With the purge, the same data gives one trade. A first version of the purge still leaked through date ladders (it keyed on an event's last end) and late resolutions (scheduled instead of actual close); the current one keys on each sample's decision time and actual resolution.
   - Before this was found, a fixed-hypothesis replication had already failed (+6.2%, 95% [−1.5%, +13.4%]), and the lab's own sample gave −13.6%.
5. **Split events:** in the old market-based samples, 3% of grouped events were missing their winner. That is a small bias toward NO, now removed by sampling whole events.

The lesson: on prediction markets, apparent edges are easy to manufacture with subtle look-ahead. Metyu's gate, together with these checks, keeps it from trading on them.

No result here guarantees future profit. Polymarket access is restricted in some countries.
