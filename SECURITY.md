# Security

Metyu trades with **virtual money**. It reads real balances only through a **view-only** API key, and it cannot place an order or move a coin. This file covers what the ecosystem protects, how, and how to link an account safely.

## What is protected, and how

| Threat | Protection |
|---|---|
| **An API key gets stolen** | Metyu only accepts view-only keys. Before reading anything, `account-sync.js` asks the exchange what the key may do: Coinbase `key_permissions`, Binance `apiRestrictions`. It **refuses** any key that can trade, withdraw or transfer, so a stolen key cannot move money. |
| **Secrets in the repository** | Keys live only in GitHub Actions secrets, and only the account step receives them. `.gitignore` blocks `.env`, `*.pem` and `*.key`. A test (`tests/account.test.js`) fails if a tracked file contains a private key, a hard-coded secret or a GitHub/AWS token. |
| **Secrets in logs** | Every message is passed through `redact()`, which removes secret values, PEM blocks and long tokens. Binance errors never echo the signed URL. |
| **Balances visible to everyone** (the repository and the data branch are public) | Balances are sealed with **PBKDF2-SHA256 (600,000 iterations) → AES-256-GCM** (`metyu-vault.js`) before they are written, so the branch holds ciphertext only. The save step refuses to publish an unsealed snapshot or anything that looks like a key. The server serves `/api/account` only if the file really is a sealed box. |
| **Someone opens the board** | The account panel shows nothing until the passphrase is entered. It decrypts in memory on your device and never stores the passphrase or the balances (not in localStorage or sessionStorage). It locks on request, and after 5 minutes in the background. A wrong passphrase or tampered data fails cleanly, because GCM authenticates the data. |
| **Script injection (XSS) and clickjacking** | Every page has a strict Content-Security-Policy: no foreign scripts, no `eval`, no plugins, no form posts, and network access only to the read-only market APIs, the data branch and the GitHub API (to find the branch's latest commit; read-only, unauthenticated). Every value from the network is written with `textContent`. `server.py` also sends `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy` and a restrictive `Permissions-Policy`. |
| **A compromised workflow token** | The workflow has no permissions by default, and the job asks only for `contents: write`. The checkout does not keep the token (`persist-credentials: false`). |
| **Real money by accident** | There is **no order code**. The real-money lock (`liveReadiness` in `metyu-exchange.js`) is shown on the board, and only the owner can take the next step. |
| **Bad or hostile market data** | The data is validated: candles are checked and deduplicated, the server validates numeric ids, and nothing from the network is executed. Exits are conservative: gaps fill at the open, a bar touching both stop and target counts as a stop, and the kill-switch closes at the stop price when no price is available. |

## Linking your exchange account (view-only)

1. **Create a view-only API key.**
   - *Coinbase:* go to Settings → API → New API key (Coinbase Developer Platform / Advanced Trade). Under permissions, tick **View only**. Leave Trade and Transfer **off**. If you can, restrict the key to an IP allowlist.
   - *Binance:* go to API Management → Create API. Enable **Reading** only; leave Spot & Margin Trading, Futures, Withdrawals and Universal Transfer **disabled**. Binance blocks requests from US servers such as GitHub's runners (HTTP 451), so with Binance run `account-sync.js` from your own computer instead.
2. **Choose a board passphrase** of at least 12 characters (a few random words is best). It is the only key to your balances on the board. Do not reuse it anywhere else.
3. **Add GitHub secrets** under Settings → Secrets and variables → Actions → New repository secret:
   - `METYU_BOARD_PASSPHRASE`
   - Coinbase: `COINBASE_API_KEY_NAME` and `COINBASE_API_PRIVATE_KEY` (paste them exactly as Coinbase shows them)
   - Binance: `BINANCE_API_KEY` and `BINANCE_API_SECRET`
4. Within 15 minutes, the board's **My exchange account** panel appears. Enter the passphrase to see your verified balances.

**To unlink:** delete the secrets, or revoke the key at the exchange. On the next run the snapshot is removed from the data branch.

**If a key with trading or withdrawal rights is ever added by mistake:** the sync refuses it, publishes `linked: false`, and the run log says why. Delete that key at the exchange.

## Linking a Solana wallet (for example the Fomo app)

**The simplest way (no GitHub settings):** on the Live Board, open the **My Solana wallet** panel, paste the wallet's public address and tap **Link**.
- The address is kept on that device only (`localStorage`); it is never uploaded.
- The phone reads the balances straight from the Solana network (`metyu-wallet.js`).
- The page's CSP allows only the Solana RPC and Jupiter price hosts for this.
- **Unlink** removes the address from the device.

**For the 24/7 autopilot as well (optional):** use GitHub secrets, as described below.

A Solana wallet needs **no key at all**. Its balances are public on-chain data, and Metyu reads them from the wallet's **public address** over Solana's JSON-RPC (`getBalance`, `getTokenAccountsByOwner`). An address cannot sign a transaction, so the link is view-only by construction.

1. **Copy the public address.** In the Fomo app it is behind **Deposit** (or Receive), under the Solana address: a base58 text of 32–44 characters.
2. **Add GitHub secrets.** Go to Settings → Secrets and variables → Actions → **Secrets** → New repository secret, and add:
   - `SOLANA_WALLET_ADDRESS` (the address)
   - `METYU_BOARD_PASSPHRASE` (12+ characters)

   An address is not a secret, but it links this public repository to your funds, so it stays private and is never published. The balances are published sealed.
3. Optional: `SOLANA_RPC_URL`, if you have your own RPC provider (https only).

The board's **My account** panel then shows SOL and every token with a USD value. USD prices come from Coinbase for SOL and the stablecoins, and from Jupiter for other tokens. Positions inside the app itself, such as perps, are not on-chain wallet balances and are not shown.

**Never give anyone a seed phrase (recovery phrase) or a private key.** Not Metyu, not a website, not "support". `account-sync.js` refuses anything that is not a public address.

### Wallet protection

Metyu reads a wallet by its **public address**: it cannot sign anything or move funds. What follows guards against the ways wallets actually get drained.

- **Open token approvals (delegates).** One "approve" on a fake site lets another address move a token without asking again. This is the most common drain. The account sync checks the linked wallet on every tick (`solanaApprovals`, read-only RPC). The details stay inside the sealed box; only the **count** is published (no address). An open approval:
  - raises a red alert on the board;
  - is reported by the watchdog and in the daily report;
  - makes the real-money lock stop counting the wallet.

  Revoke approvals in your wallet app.
- **Secrets are wiped on sight.** A recovery (seed) phrase or a private key typed or pasted into any field of the board is cleared at once, never kept, stored or sent, and a warning explains why (`looksLikeSecret`).
- **No injected code (XSS).** The pages' Content-Security-Policy allows only this repository's own inline scripts, by their SHA-256 hash (`scripts/csp.js`); there is no `'unsafe-inline'` for scripts. An injected script, for example one that draws a fake "connect your wallet" prompt, is refused by the browser. An end-to-end test proves it.

**What only you can do:**
1. Never type your recovery phrase or private key into any website, chat or app other than the wallet itself. Metyu never asks for it, and nobody legitimate does.
2. Never "claim" airdropped tokens or sign transactions from links. Check the address you send to.
3. Keep larger amounts in a hardware wallet. Use the hot wallet (Fomo) only for small sums.
4. Open the board from your home-screen icon or a bookmark, never from a link someone sends.
5. Turn on two-factor authentication on GitHub and on any exchange. Enable GitHub secret scanning with push protection.

### Impostor tokens

A wallet can receive tokens nobody asked for. Scam airdrops are often named like real money ("USDC") to lure the owner to a phishing site. Metyu prices stablecoins by their **mint**, not by their name. A token named SOL, WSOL, USDC, USDT, USD, PYUSD, USDS or DAI without the real mint is flagged as an impostor and is never counted. Never interact with such a token, and never "claim" anything it advertises.

## The real-money lock

Real orders are locked. The board lists six conditions, and all of them must hold before the owner may even decide to unlock:
1. The forward test has run for 3+ days (the owner chose 3; the trade count and the interval still have to be met, however long that takes).
2. It has 30+ closed **normal-book** trades. Only strategies past their evidence gate would trade real money, so the learning book's research trades do not count.
3. The 95% interval of the mean R is above zero.
4. There has been no kill-switch, and drawdown is under 10%.
5. A real account is linked with a verified view-only key.
6. The owner gives explicit approval.

Even then, the first orders are capped at **$25 per order, $100 open, $50 maximum daily loss, and no leverage**. Writing the order adapter (a separate trading key, kept apart from the view-only key) is a deliberate, reviewed step at that point, not something that switches on by itself.

### The rehearsal: shadow orders

Every normal-book entry is mirrored as the order the first real-money release would send. It uses the limits above and is settled at the same exit, but **nothing is sent**: there is no order code in Metyu. The board shows the result (`Shadow orders`), including how many orders could be placed on a spot account. A spot account cannot short, and today the proven strategy trades mostly shorts in a downtrend.

### The venue: Hyperliquid perps (the owner's choice, 25 Nov 2026)

The owner chose a venue that allows shorts and lives outside Turkey. Turkish rules (CMB Communiqué III-35/B.2) ban crypto derivatives, leverage and short selling for residents. Whether perps are legal where the owner lives is the owner's own check; Metyu does not decide it.

The agent only **reads** Hyperliquid, through its public `POST /info` endpoint: order books (`l2Book`) and funding rates (`metaAndAssetCtxs`). Its order endpoint, `/exchange`, is never called. The preflight's code check fails the build if `hyperliquid.xyz/exchange` appears in any source file.

There is still no order code, no key and no signing. A real order needs the full go-live checklist below, and on Hyperliquid also an **API wallet** with trading rights only. It is never the owner's main wallet or its seed phrase.

### Linking the Fomo perps account (read-only)

The Fomo app trades perps on Hyperliquid, from an account with a **public 0x address**. Add that address as the GitHub secret `HYPERLIQUID_ADDRESS`. The secret keeps the address private; the address itself cannot sign anything.

The account sync then reads, through `POST /info` only:
- margin and account value;
- open positions;
- spot USDC;
- the **API agents approved to trade for the account**.

The full detail is sealed with the board passphrase. Publicly, only counts are published: linked, the number of positions and the number of agents. No address, amount or coin is published.

If an agent you did not approve appears, revoke it in the app. The Fomo app itself may use one.

Never paste a private key, the Fomo recovery phrase or a Privy export anywhere. Metyu needs only the public address.

### The preflight (`scripts/preflight-live.js`)

One command checks what a real-money release would need, against the code and the published state. It sends nothing.

The **code checks** must always pass, and the unit tests run them, so CI fails the moment one breaks:
- no order, cancel, withdraw or signing call anywhere in the source;
- `LIVE_LIMITS` and the cost floors unchanged;
- the evidence gate's bars unchanged;
- the kill-switch in place;
- no key, token or recovery phrase in the repository.

The **readiness checks** read the published state:
- the six conditions;
- shadow orders never sent;
- the linked account read-only, fresh and free of token approvals;
- order-book costs measured for every coin;
- how many signals a spot account could have placed at all.

The daily steward runs it every morning.

### Go-live checklist (all of it, in this order)

1. **6/6 conditions on the board.** Check the shadow orders: they should agree with the forward test.
2. **Choose the venue.** On spot, only LONG signals can be placed. Shorts need futures or margin, which bring leverage, funding costs and local rules on derivatives. Check what is allowed where you live.
3. **A separate trading key**, never the view-only key:
   - trading enabled, **withdrawals and transfers disabled**;
   - restricted to the IP address of the machine that will trade;
   - with the exchange's own limits switched on where it offers them.
4. **Run it on your own always-on machine** (`scripts/realtime.sh` with `deploy/metyu-realtime.service`), never on GitHub Actions. The trading key goes only to the order process, as the view-only key goes only to the account sync today.
5. **The order adapter** is then written and reviewed as a separate change. It must:
   - enforce `LIVE_LIMITS` itself;
   - re-check readiness before every order;
   - stop on `METYU_PAUSE` and the kill-switch;
   - reconcile with the exchange's own positions on every tick;
   - start with one coin.
6. **Fund the exchange account with an amount you can afford to lose.** The limits cap the loss at $50 a day.

## Operations and supply chain

- **Pinned actions:** every GitHub Action is pinned to a commit SHA, and Dependabot proposes updates. CodeQL scans the JavaScript and Python code on every pull request and weekly.
- **Shared publish/restore:** the workflow and the always-on runner use the same `scripts/publish-state.sh` and `scripts/restore-state.sh`. The token travels in an HTTP header, never in a URL. Publishing refuses unsealed balances and secret-looking content.
- **Least privilege on the always-on machine:** `scripts/realtime.sh` gives each process only what it needs:
  - the trading ticks get no secrets;
  - the account sync gets the view-only exchange key;
  - only the publisher gets the GitHub token.
- **Systemd hardening:** `deploy/metyu-realtime.service` runs as an unprivileged user with a read-only system, write access to `data/` only, no capabilities and a `0077` umask.
- **Watchdog:** an hourly workflow that only reads (`issues: write` is its only write permission) and opens an issue while an agent is silent, halted, on stale prices or on an old model. Stale market data is refused before it can drive a trade, and every request times out after 15 s.
- **Emergency pause:** the `METYU_PAUSE=true` repository variable stops new positions from the phone. `METYU_RUNNER=external` keeps a single writer of the state.
- **Repository settings you should turn on:**
  - branch protection on `main` (require the `test` and `e2e` checks);
  - GitHub secret scanning with push protection;
  - two-factor authentication on your GitHub and exchange accounts.

## Reporting a problem

Open a private security advisory on GitHub (Security → Advisories → Report a vulnerability). Do not paste a key into an issue. If a key was ever exposed, revoke it at the exchange first.
