# Real-money trading: architecture

Status: **design only**. Metyu has no order code. Nothing in this document is built until all of these are true:
- the six real-money conditions are met on the board (`liveReadiness`);
- the owner gives a separate, explicit approval;
- each step below is reviewed in its own pull request.

The hard rules in `CLAUDE.md` hold throughout:
- virtual money until then;
- `LIVE_LIMITS` ($25 per order, $100 open, $50 a day, 1x);
- the evidence gate is never loosened;
- no secrets in the repository, logs, chat or board;
- no always-on GitHub Actions.

**Owner's choice (25 Nov 2026):** no manual order entry. The first real-money stage is **supervised automation on a dedicated Hyperliquid account**. The owner's Fomo account stays read-only.

## 1. What we know (25 Nov 2026)

| Fact | Consequence |
|---|---|
| Fomo has **no public trading API**. | Metyu cannot trade inside the Fomo app; it keeps reading it (positions, margin, agents). |
| Fomo's perps run on **Hyperliquid**, which has a public API. | Automation goes straight to Hyperliquid, on a separate account. |
| Hyperliquid supports **API wallets** ("agents"). An agent can place and cancel orders for an account but **cannot withdraw**. The owner approves it with the account's own wallet, and it can expire (`validUntil`). | The agent key is the only key Metyu would ever hold. Losing it can cost trades, never the funds. |
| ~82 of 84 recent paper trades were **shorts**. | Perps are needed for shorts, and Hyperliquid has them. Whether perps are legal where the owner lives is the owner's check. Turkish residents are excluded by CMB rules. |
| All 8 evidence gates are **closed**; the real-money lock is 3/6. | Nothing below can start today. The order of work matters more than speed. |

## 2. Stages

```
 Stage 1  SUPERVISED AUTO, dedicated account   trade-only, expiring agent key      ← first real money
          ($100 + buffer)                       on the owner's machine or a small VPS
 Stage 2  SCALE                                 same design, larger limits          ← only on a new approval
```

### Stage 1: supervised automation on a dedicated account

```
always-on host (the owner's machine, or a small VPS the owner rents; never GitHub Actions)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ exchange-autopilot (as today, 1-minute ticks via scripts/realtime.sh)      │
  │   gated signal ─► shadowOpen ─► TICKET (pure fn: coin, side, $≤25, max      │
  │                                  price, stop, target, expiry)               │
  │                                      ▼                                       │
  │ ORDER ADAPTER (new, separate process, separate review)                       │
  │   1. re-reads status: 6/6 + the owner's approval record, both current        │
  │   2. enforces LIVE_LIMITS itself ($25 / $100 open / $50 a day / 1x)          │
  │   3. IOC limit order with a max price, then a reduce-only stop at once       │
  │   4. deterministic client order ids (a retry never doubles an order)         │
  │   5. reconciles with the exchange's positions every tick; stops on mismatch  │
  │   6. stops on METYU_PAUSE, the kill-switch, a stale feed, a failed check     │
  │   7. append-only audit log (redacted); only counts are published             │
  │            │ agent key: env var on this host only                            │
  └────────────┼──────────────────────────────────────────────────────────────┘
               ▼ POST /exchange (only from order-adapter.js; the preflight allows that one file)
        Hyperliquid DEDICATED account (≤ $100 + buffer) ── agent: trade-only, expiring
               ▲ POST /info (read-only)
        Live Board + account-sync: positions, fills, audit summary, a red banner on any mismatch
```

- **Account:** a new Hyperliquid account, separate from the Fomo account. The owner funds it with a small amount and approves **one agent** with an expiry. The agent trades but **cannot withdraw**.
- **Host:** an always-on machine. The agent key lives only in an environment variable there. It is never in the repository, GitHub, chat, logs or the board.
  - **Owner's own computer:** no extra cost; it must stay on and updated.
  - **Small VPS** (a few dollars a month): always on, independent of the owner's devices. The owner rents it, and only the owner holds its login.
- **Tickets** are internal: the adapter's input, made only from **normal-book** signals (an open gate). Learning-book signals never reach real money.
- **Preflight:** the code check is amended to allow `/exchange` in exactly one file, `order-adapter.js`. Any other appearance still fails the build.
- **Board:** read-only, as today. It shows the adapter's state (on, paused, halted), the live positions, real fills vs ticket prices, and the audit summary. There is **no trading button**: a phone page must never hold a key.
- **Emergency:** `METYU_PAUSE` (a GitHub variable, as today) stops new orders. **Revoking the agent in Hyperliquid stops everything**, whatever the code does.
- **Track record:** real R per trade next to the shadow and paper R. Real slippage feeds the execution check.
- **Exit criteria to stage 2:** 30+ real trades over 4+ weeks, mean real R within the paper interval, no limit breach, no reconciliation mismatch.

### Stage 2: scale

Larger limits, and any leverage, only with the owner's new, explicit approval after stage 1 meets its exit criteria. Each change to `LIVE_LIMITS` is its own reviewed pull request. The evidence gate is never loosened to trade more.

## 3. Steps, in order (each its own pull request or owner action)

| # | Step | Who | Needs |
|---|---|---|---|
| 1 | This design | Claude | nothing (done) |
| 2 | Check that perps are legal where the owner lives | owner | **skipped by the owner (25 Nov 2026)**: legality stays the owner's own responsibility |
| 3 | Choose the host: own computer or a small VPS | owner | — |
| 4 | `ticketOf(shadowOrder)` + tickets in the status (no sending) + tests | Claude | can be built now: it only computes |
| 5 | Board: an "Orders that would be sent" panel from the tickets | Claude | step 4 |
| 6 | A checkable approval record, e.g. `METYU_LIVE_APPROVED=<date>` that expires | Claude + owner | step 4 |
| 7 | **Wait** for a gate to open and 6/6 | the data | time |
| 8 | Dedicated Hyperliquid account, funded ≤ $100, one trade-only agent | owner | step 7 |
| 9 | `order-adapter.js` + the preflight exception + tests against a mock exchange | Claude | steps 7, 8 and the owner's approval |
| 10 | Deploy on the host; the first real order at $25 | owner + Claude | step 9 |

Steps 4–6 move nothing and send nothing. Step 9 is the first code that could place an order, and it waits for 6/6 and the owner's separate approval.

## 4. Decisions only the owner can make

1. **Legality** of perps where the owner lives (recorded in SECURITY.md).
2. **The host:** own computer or a VPS.
3. **The approval record:** a GitHub variable that expires; a chat message never counts.
4. **The dedicated account** and its funding.

## 5. Why this order

- Everything that can be built without risk (tickets, the board panel, the approval record) comes first, so the day a gate opens only the adapter remains.
- The adapter is the only piece that can lose money. It is the most guarded: its own file, its own review, limits enforced twice (in the adapter and by the small balance), and a kill switch the owner holds outside the code (revoking the agent).
- Throughout, the evidence gate decides **whether** to trade. This architecture only decides **how**.
