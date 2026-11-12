# Does Metyu have an edge on Polymarket?

This folder holds the research behind Metyu's **evidence gate**. It uses virtual money only and reads Polymarket's public APIs only.

```bash
python research/collect.py data/dataset.json 6000 [SHIFT_DAYS] [EVENTS_PER_WINDOW]   # ≈20–30 min
node research/evaluate.js data/dataset.json    # walk-forward, same code as the Prediction lab
```

`data/` is git-ignored.

## Answer

**No.** After fixing every leak found so far, and with Polymarket's real fee schedule, a pre-registered replication on four new samples failed (see below). Earlier, two independent multi-month samples gave **no evidence of an edge** after costs. They span about 19 and 29 months. On those samples Metyu makes almost no trades, and its evidence gate stays closed for every model, horizon and spread tried.

What is real is small. A recalibrated forecast is slightly better calibrated than the crowd: its Brier score improves by about 0.003–0.004, and not every test shows it. That is far too little to pay the spread and fees.

## Method

| Choice | Why |
|---|---|
| Whole **events** per window of scheduled end dates: 5 events per day, one day every six days, going back from yesterday | Taking "the first N markets" of a window can keep an event's losers and drop its winner, which biases the sample toward NO. Big events hold dozens of markets, so 5 events per window spreads 6,000 markets over many months (19–29 months in the samples below). |
| Samples: the YES price 1, 3, 7, 14 and 30 days before the **scheduled** end (`endDate`), dropped if the market had already closed | `closedTime` leaks the outcome: "by <date>" markets close early once the event happens. |
| Prices at ≤1¢ or ≥99¢ are skipped | These markets are effectively resolved. |
| Each event carries a total weight of 1 | Candidates of an event, and horizons of one market, share an outcome. |
| Walk-forward over 6 time blocks. Each block trains only on events that had **actually resolved** (`closedTime`) before the block's **earliest decision** (each sample's end minus its horizon) | A test trade is placed up to 30 days before its market ends. Training on events that resolved after it, including date ladders and late or disputed resolutions, uses outcomes unknown at trade time. |
| Trades go through Metyu's own `advise()`, at most one per event, and pay half the spread plus the taker fee | The fee per share is `rate × (p × (1 − p))^exponent` from the market's Gamma `feeSchedule` (rate 0.03–0.07, exponent 1). `takerBaseFee` is 1000 on every fee-enabled market and is not the rate. |
| Gate: the 95% bootstrap interval of the per-$1 return must be above 0, with at least 30 trades | |

## Results with the corrected method

| Sample | Markets / events (span) | Best 2¢ result | Gate |
|---|---|---|---|
| Sample A: `collect.py 6000 0 5` | 4,542 / 478 (Apr 2025 – Nov 2026) | no trades at any horizon or model | closed |
| Sample B: `collect.py 6000 3 5` | 4,617 / 716 (Jun 2024 – Nov 2026) | 4 trades at most | closed |
| Old discovery sample, re-evaluated | 5,998 / 1,265 | calibration, 7 d: 1 trade (was 330); at most 3 trades anywhere | closed |
| Old replication sample, re-evaluated | 5,999 / 1,309 | calibration, 7 d: 1 trade; at most 2 anywhere | closed |

### Re-run with the correct fee (November 2026)

Until November 2026 the fee was modelled as `takerBaseFee / 10,000 × min(p, 1 − p)`, i.e. 10%, which overstated costs 2–4×. Two fresh samples were collected with each market's `feeSchedule` and evaluated three ways on the same data (calibration model, 2¢ spread):

| Sample | Markets / events | Fee model | 1 d | 7 d | 30 d |
|---|---|---|---|---|---|
| A: `collect.py 6000 0 5` | 4,465 / 699 | old 10% × min(p, 1−p) | 56 trades, −7.9% | 69, +8.3% [−9.9%, +26.7%] | 30, +11.2% |
| | | **correct `feeSchedule`** | 62, −2.1% | **85, +14.1% [−2.1%, +29.8%]** | 45, +14.5% [−7.6%, +35.9%] |
| | | no fee (not real) | 92, +3.5% | 116, +18.2% [+5.6%, +30.8%] | 77, +20.8% |
| B: `collect.py 6000 3 5` | 4,333 / 524 | any, even no fee | 0 trades | 0 | 0 |

With the correct fee the gate is still **closed** everywhere. Sample A comes close at 7 days, but the interval still includes a loss, and the independent Sample B produces no trades at all, so the near-miss does not replicate. The rich model is closed on both samples (Sample A: 24 trades at 7 d, −17.5%).

### Pre-registered replication (November 2026)

Sample A's 7-day near-miss was tested on four new independent samples, with the hypothesis fixed **before** looking at them: calibration model, 7-day horizon, 2¢ spread, real `feeSchedule` fees; success = gate open (95% interval above 0, at least 30 trades).

| Sample | Markets / events (span) | Trades | Mean per $1 | 95% interval | Gate |
|---|---|---|---|---|---|
| `collect.py 6000 1 5` | 4,519 / 422 (Mar 2025 – Dec 2026) | 1 | — | — | closed |
| `collect.py 6000 2 5` | 4,394 / 480 (Dec 2024 – Nov 2026) | 0 | — | — | closed |
| `collect.py 6000 4 5` | 4,617 / 813 (Nov 2023 – Nov 2026) | 102 | +5.9% | [−4.8%, +15.3%] | closed |
| `collect.py 6000 5 5` | 4,470 / 424 (Apr 2025 – Dec 2026) | 0 | — | — | closed |
| The four pooled | 17,997 / 2,138 | 0 | — | — | closed |
| All six pooled, incl. A (biased upward: A is where the idea came from) | 26,795 / 3,361 | 588 | +4.4% | [−0.8%, +9.6%] | closed |

**The replication failed.** Even with the corrected fees there is no reliable edge, and Metyu correctly keeps the gate closed.

Brier scores of the earlier samples, crowd → model (calibration / rich): Sample A 0.1642 → 0.1614 / 0.1606, Sample B 0.1524 → 0.1498 / 0.1491. At a 4¢ spread there are no trades anywhere.

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
