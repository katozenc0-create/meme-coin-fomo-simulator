# Real-money trading through Fomo: architecture

Status: **design only**. Metyu has no order code. Nothing in this document is built until all of these are true:
- the six real-money conditions are met on the board (`liveReadiness`);
- the owner gives a separate, explicit approval;
- each stage below is reviewed in its own pull request.

The hard rules in `CLAUDE.md` hold throughout:
- virtual money until then;
- `LIVE_LIMITS` ($25 per order, $100 open, $50 a day, 1x);
- the evidence gate is never loosened;
- no secrets in the repository, logs, chat or board;
- no always-on GitHub Actions.

## 1. What we know (25 Nov 2026)

| Fact | Consequence |
|---|---|
| Fomo has **no public trading API**. | Metyu cannot place a trade in the Fomo app. Automated orders need another route. |
| Fomo's perps run on **Hyperliquid**, from the owner's account (a public 0x address). | Metyu can already **read** that account: positions, margin and API agents. This works from the board (#69) or the agent (`HYPERLIQUID_ADDRESS`). |
| Hyperliquid supports **API wallets** ("agents"). An agent can place and cancel orders for an account but **cannot withdraw**. The owner approves it with the main wallet, and it can expire. | An agent is the only safe way to automate. Its key never gives access to the funds themselves. |
| Fomo's wallet is managed by Privy inside the app. | It is unknown whether an external agent can be approved on the Fomo account itself. Plan for a **separate, small Hyperliquid account** for automation. |
| ~82 of 84 recent paper trades were **shorts**. | A venue with shorts is needed, and Hyperliquid has them. Whether perps are legal where the owner lives is the owner's check. Turkish residents are excluded by CMB rules. |
| All 8 evidence gates are **closed**; the real-money lock is 3/6. | No stage below can start today. The order of work matters more than speed. |

## 2. Three stages, each safer than the next is risky

```
 Stage 1  SIGNAL → OWNER TAPS IN FOMO        no keys anywhere          ← start here
 Stage 2  SUPERVISED AUTO, dedicated account trade-only agent key,     ← only after stage 1 proves itself
          on the owner's own machine         owner's always-on machine
 Stage 3  SCALE                              same, larger limits       ← only on the owner's new approval
```

### Stage 1: order tickets, executed by hand in Fomo (no keys)

```
exchange-autopilot (GitHub Actions, 15 min)                      Live Board (phone)
  gated signal ─► shadowOpen ─► TICKET ─► exchange-status.json ─► "Order ticket" card
                  (LIVE_LIMITS)  pure fn     (public, no secrets)     coin · side · $25 · stop · target
                                                                    · max price · expires in 15 min
                                                                          │ owner opens Fomo, places it
                                                                          ▼
Hyperliquid (owner's Fomo account) ◄──── POST /info (read-only) ◄── board + account-sync
  real position ──────────────────────► RECONCILE: followed? fill vs ticket? slippage? stop placed?
```

- **Ticket** (a new pure function next to `shadowOpen`): `{ id, symbol, venueCoin, side, usd ≤ 25, maxPrice, stop, target, expiresAt, reason }`.
  - It is made only for **normal-book** signals: a gate open, 6/6 conditions, and the owner's approval recorded (see §4).
  - Learning-book signals never become tickets.
- **Board card:** the ticket in plain words, with a countdown. When it expires it says "expired, do not place". After the trade it shows "placed / not placed" from the reconciliation.
  - There is no button that trades. It copies nothing secret; it is text to follow.
- **Reconciliation** (read-only, already half built):
  - match the owner's real positions on the Hyperliquid account to tickets;
  - record fill price vs ticket price (real slippage), late fills and missing stops;
  - feed a **live track record**: real R per trade, next to the shadow and paper R.
- **What it proves:**
  - the signals survive real fills and the owner's reaction time;
  - real costs match the measured order books (`--venue hyperliquid`);
  - the owner can follow the discipline: stops, sizes and no extra trades.
- **Exit criteria to stage 2:** 30+ reconciled tickets over 4+ weeks, mean real R within the paper interval, and no limit breach.

### Stage 2: supervised automation on a dedicated account

```
owner's always-on machine (scripts/realtime.sh + deploy/metyu-realtime.service; never GitHub Actions)
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ exchange-autopilot (as today) ─► tickets ─► ORDER ADAPTER (new, separate)  │
  │                                              │ re-checks liveReadiness       │
  │                                              │ enforces LIVE_LIMITS itself   │
  │                                              │ METYU_PAUSE / kill-switch     │
  │                                              │ idempotent client order ids   │
  │                                              ▼                               │
  │                              agent key (env, this machine only) ──► POST /exchange
  └───────────────────────────────────────────────────────────────────────────┘
        Hyperliquid DEDICATED account (funded ≤ $100 + buffer), agent: trade-only, expiring
```

- **Account:** a new Hyperliquid account, not the Fomo account. It is funded with a small amount from the owner's wallet and approves **one agent** with an expiry (`validUntil`). The agent can trade, but it **cannot withdraw**.
- **Key handling:**
  - the agent's private key lives only in an environment variable on the owner's machine;
  - never in the repository, GitHub, chat, logs or the board;
  - the adapter's logs pass through `redact()`;
  - losing the key means revoking the agent, and the funds are never at risk.
- **Order adapter:** a separate file and process, reviewed in its own pull request. It is the only code allowed to call `/exchange`. The preflight's code check is amended to allow exactly that one file and nothing else. The adapter must:
  1. re-read the latest status and refuse unless 6/6 and the owner's approval are current;
  2. enforce `LIVE_LIMITS` locally ($25 per order, $100 open, $50 a day, 1x), independent of the agent;
  3. send **IOC limit orders** with a max price (no market orders), then place the stop as a reduce-only trigger order at once;
  4. use deterministic client order ids, so a retry never doubles an order;
  5. reconcile with the exchange's own positions on every tick and stop on any mismatch;
  6. stop on `METYU_PAUSE`, the kill-switch, a stale feed, or a failed health check;
  7. write an append-only audit log (redacted) and publish only counts to the board.
- **Board:** read-only, as today. It shows the adapter's state (on, paused, halted), the live positions, the audit summary and a red banner on any mismatch. There is **no trading button on the board**: a phone page must never hold a key.
- **Emergency:** `METYU_PAUSE` (a GitHub variable, as today) stops new orders. Revoking the agent in Hyperliquid stops everything, whatever the code does.

### Stage 3: scale

Larger limits only with the owner's new, explicit approval, after stage 2 meets the same exit criteria. Each change to `LIVE_LIMITS` is its own reviewed pull request. The evidence gate is never loosened to trade more.

## 3. What changes in the code, stage by stage

| Piece | Stage 1 | Stage 2 |
|---|---|---|
| `exchange-autopilot.js` | `ticketOf(shadowOrder)`, a pure function; tickets in the status | same |
| `account-sync.js` / board | reconcile tickets with real Hyperliquid positions (read-only) | same, plus the adapter's state |
| `scripts/preflight-live.js` | add a check: tickets only for normal-book signals, limits respected | allow `/exchange` in `order-adapter.js` only |
| `order-adapter.js` | none | new, separate process, separate review |
| Keys | none | one trade-only, expiring agent key on the owner's machine |
| Where it runs | GitHub Actions (as today) | the owner's always-on machine |

## 4. Decisions only the owner can make

1. **Legality** of perps where the owner lives (the owner's check; recorded in SECURITY.md).
2. **Approval record:** how the owner says "yes" in a way the code can check, for example a GitHub variable `METYU_LIVE_APPROVED=<date>` that expires. It is never inferred from a chat message.
3. **Stage 2 account:** a dedicated Hyperliquid account with its own small balance, and who funds it.
4. **The machine** that will run stage 2: always on, updated, and with the key only there.

## 5. Why this order

- Stage 1 needs no key and no order code, so a mistake costs at most a manual trade the owner chose to place.
- Stage 1 also produces what no backtest can: real fills, real reaction times and real discipline. Stage 2 only automates what stage 1 already proved.
- Throughout, the evidence gate decides **whether** to trade. This architecture only decides **how**.
