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

**Venue decision (26 Nov 2026): Hyperliquid (Part A) is the target; Polymarket (Part B) is parked.** The owner asked Claude to choose. The reasons:

| | Hyperliquid (Fomo's perps venue) | Polymarket |
|---|---|---|
| Key safety | a **trade-only, expiring agent** key that **cannot withdraw** | every order is signed by the wallet's private key: a leaked key can move the funds |
| Evidence today | gates closed, but the learning book's forward test is +0.16R over 74 trades | gate closed, paper −$276, past "edges" were look-ahead |
| Speed of evidence | 31 coins, hourly signals: 30 normal-book trades take weeks once a gate opens | markets resolve over weeks or months |
| Fit | the strategies are mostly short; perps allow it; costs and funding are already measured | — |

Fomo's role is a **read-only wallet and data view**: the owner's Solana wallet and perps account, plus Hyperliquid's public books and funding. Real orders would go straight to Hyperliquid from a separate small account, never through the Fomo app.

# Part A: the crypto agent on Hyperliquid (the target)

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
- **Host:** an always-on machine; **the owner chose a small cloud VPS**. The agent key lives only in an environment variable there. It is never in the repository, GitHub, chat, logs or the board.
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
| 3 | Choose the host: own computer or a small VPS | owner | **chosen: a small cloud VPS** (a few dollars a month), rented only at step 8 |
| 4 | `ticketOf(shadowOrder)` + tickets in the status (no sending) + tests | Claude | can be built now: it only computes |
| 5 | Board: an "Orders that would be sent" panel from the tickets | Claude | step 4 |
| 6 | A checkable approval record that expires: the repository variable `METYU_LIVE_APPROVED` = `2026-11-27..2026-12-27 25/100/50/1x hyperliquid` (at most 31 days, limits equal to `LIVE_LIMITS`; checked by `liveApproval`) | Claude (built) + owner (sets the variable) | step 4 |
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

# Part B: the Polymarket agent (parked alternative, 26 Nov 2026)

Status: **design only, parked**: kept in case Polymarket ever becomes the better choice, for example if its gate opens first. Same hard rules: no order code until the Polymarket agent's own six conditions are met **and** the owner approves separately; the first limits are `LIVE_LIMITS` ($25 per order, $100 open, $50 a day, no leverage).

## B1. What we know (26 Nov 2026, from Polymarket's developer docs)

| Fact | Consequence |
|---|---|
| Trading goes through the **CLOB API** with two auth levels. **L1** is an EIP-712 signature from the wallet's **private key**, used to create or derive API credentials. **L2** is an HMAC key (apiKey, secret, passphrase) for requests. **Every order also carries a wallet signature.** | The order process must hold a wallet's private key. |
| There is **no trade-only key**. Unlike a Hyperliquid agent, a key that can sign orders belongs to a wallet that can also move its funds. | The wallet must be **dedicated and small**: only the trading balance, never the owner's Fomo wallet or any other wallet. The key's worst case is that wallet's balance. |
| Signature types: EOA (0), POLY_PROXY (1), POLY_GNOSIS_SAFE (2), and deposit wallets (POLY_1271, 3) for accounts created on or after 4 May 2026. Each wallet has **one** active API key, and a new one revokes the old. An open client issue asks how to derive L2 keys for deposit wallets. | Use a plain **EOA** wallet created for Metyu. Funds are USDC on Polygon, plus a little gas if the chosen path needs it. Recheck the deposit-wallet question before building. |
| A **geoblock** check reports whether the requesting IP's country is blocked. Sanctioned regions are fully blocked. Other countries are **close-only**: no new orders. The lists change. | The adapter checks the geoblock **before every order** and stops if it is blocked or close-only. The host is never used to get around the owner's own country rules: a VPS in another country does not change where the owner lives. Turkish residents are excluded by local rules as well (CMB). |
| The Polymarket agent's evidence gate is **closed**: 56 out-of-sample trades, mean +8.5%, interval below zero. The paper account is at −$276 realized. | Nothing can start. Polymarket needs its **own** real-money conditions. The crypto lock does not count. |

## B2. Design

```
small VPS (the owner's, always on; never GitHub Actions)
  autopilot.js (as today: virtual trades, its own evidence gate)
     │ normal-book signal (gate open) ─► POLYMARKET TICKET (pure fn: token, side, $≤25, limit price, expiry)
     ▼
  POLYMARKET ORDER ADAPTER (separate process, separate review; the only file allowed to place CLOB orders)
     1. geoblock check from this host: blocked or close-only → stop
     2. re-reads the status: the Polymarket readiness 6/6 and the owner's approval record, both current
     3. enforces LIVE_LIMITS itself; GTC/FOK limit orders only, never a market order without a price cap
     4. deterministic client ids; reconciles open orders and positions every tick; stops on mismatch
     5. stops on METYU_PAUSE, the kill-switch, a stale feed
     6. append-only redacted audit log; only counts are published
            │ EOA private key + L2 creds: env vars on the VPS only
            ▼
  Polymarket CLOB ── dedicated EOA wallet on Polygon (≤ $100 USDC + gas)
            ▲ read-only: positions and balance by the PUBLIC address (as the board reads wallets today)
  Live Board: Polymarket tickets (NOT SENT until the adapter exists), positions, audit summary
```

**Fomo's role:** a read-only view only. The board shows the owner's Solana wallet and the Hyperliquid perps account, and the Hyperliquid books and funding stay a fresh price source for the crypto agent. Nothing trades through Fomo.

**Emergency:** move the USDC out of the dedicated wallet with the owner's own wallet app. Or set `METYU_PAUSE`, or revoke the L2 key by creating a new one. The adapter can never touch any other wallet.

## B3. Steps, in order

| # | Step | Who | Needs |
|---|---|---|---|
| B1 | This design | Claude | done |
| B2 | Check eligibility: Polymarket's geoblock check from the owner's own phone, where the owner lives | owner | — |
| B3 | `polymarketReadiness`: the six conditions for the Polymarket agent (days, 30+ normal-book trades, an interval above zero over 4+ weeks, drawdown, a read-only wallet link, approval) + tests | Claude | can be built now: it only computes |
| B4 | Polymarket tickets (computed, never sent) + the board's "orders that would be sent" for Polymarket | Claude | B3 |
| B5 | A strategy lab for the Polymarket agent (as for crypto), to look for an edge the gate can confirm | Claude | can be built now |
| B6 | **Wait** for the Polymarket gate to open and 6/6 | the data | time |
| B7 | A dedicated EOA wallet (≤ $100 USDC on Polygon), its public address linked read-only | owner | B6 |
| B8 | The order adapter + a preflight exception for that one file + tests against a mock CLOB | Claude | B6, B7 and the owner's approval |
| B9 | Deploy on the VPS; the first real order at $25 | owner + Claude | B8 |

## B4. Honest expectations

- Polymarket's own research here found no reliable edge yet (`research/README.md`): every apparent edge was a form of look-ahead. Until the gate opens on clean data, B6 is the long pole.
- A Polymarket key can move its wallet's funds, so the **small dedicated wallet is the safety limit**, together with the adapter's own limits.
