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
| **Script injection (XSS) and clickjacking** | Every page has a strict Content-Security-Policy: no foreign scripts, no `eval`, no plugins, no form posts, and network access only to the read-only market APIs and the data branch. Every value from the network is written with `textContent`. `server.py` also sends `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Opener-Policy` and a restrictive `Permissions-Policy`. |
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

## The real-money lock

Real orders are locked. The board lists six conditions, and all of them must hold before the owner may even decide to unlock:
1. The forward test has run for 14+ days.
2. It has 30+ closed trades.
3. The 95% interval of the mean R is above zero.
4. There has been no kill-switch, and drawdown is under 10%.
5. A real account is linked with a verified view-only key.
6. The owner gives explicit approval.

Even then, the first orders are capped at **$25 per order, $100 open, $50 maximum daily loss, and no leverage**. Writing the order adapter (a separate trading key, kept apart from the view-only key) is a deliberate, reviewed step at that point, not something that switches on by itself.

## Operations and supply chain

- **Pinned actions:** every GitHub Action is pinned to a commit SHA, and Dependabot proposes updates. CodeQL scans the JavaScript and Python code on every pull request and weekly.
- **Shared publish/restore:** the workflow and the always-on runner use the same `scripts/publish-state.sh` and `scripts/restore-state.sh`. The token travels in an HTTP header, never in a URL. Publishing refuses unsealed balances and secret-looking content.
- **Least privilege on the always-on machine:** `scripts/realtime.sh` gives each process only what it needs:
  - the trading ticks get no secrets;
  - the account sync gets the view-only exchange key;
  - only the publisher gets the GitHub token.
- **Systemd hardening:** `deploy/metyu-realtime.service` runs as an unprivileged user with a read-only system, write access to `data/` only, no capabilities and a `0077` umask.
- **Emergency pause:** the `METYU_PAUSE=true` repository variable stops new positions from the phone. `METYU_RUNNER=external` keeps a single writer of the state.
- **Repository settings you should turn on:**
  - branch protection on `main` (require the `test` and `e2e` checks);
  - GitHub secret scanning with push protection;
  - two-factor authentication on your GitHub and exchange accounts.

## Reporting a problem

Open a private security advisory on GitHub (Security → Advisories → Report a vulnerability). Do not paste a key into an issue. If a key was ever exposed, revoke it at the exchange first.
