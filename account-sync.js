#!/usr/bin/env node
// Metyu account sync: reads the owner's REAL exchange balances with a VIEW-ONLY API key and
// publishes them END-TO-END ENCRYPTED for the Live Board. It never trades and never withdraws:
//   - it first asks the exchange what the key may do and REFUSES any key that can trade,
//     withdraw or transfer (create a read-only key instead);
//   - it only calls read endpoints (permissions, balances) and public prices;
//   - secrets come from environment variables (GitHub Actions secrets), are never written to
//     disk and are scrubbed from every message it prints;
//   - the snapshot is sealed with METYU_BOARD_PASSPHRASE (metyu-vault.js) before it is written,
//     so the public autopilot-data branch only ever holds ciphertext.
//
// Coinbase (Advanced Trade / CDP key):  COINBASE_API_KEY_NAME, COINBASE_API_PRIVATE_KEY
// Binance (read-only key):              BINANCE_API_KEY, BINANCE_API_SECRET [, BINANCE_BASE_URL]
// Solana wallet (e.g. the Fomo app):    SOLANA_WALLET_ADDRESS [, SOLANA_RPC_URL]
//   Only the PUBLIC address: balances are public on-chain data; an address cannot sign, so it can
//   never move funds. Never give Metyu (or anyone) a seed phrase or a private key.
// Fomo perps (Hyperliquid account):      HYPERLIQUID_ADDRESS (the PUBLIC 0x address)
//   Read through Hyperliquid's public POST /info only: margin, positions, approved API agents.
// Always:                               METYU_BOARD_PASSPHRASE (12+ characters)
//
//   node account-sync.js --out data/account.enc.json --public-out data/account-public.json
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Vault = require('./metyu-vault.js');

const STABLE = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'FDUSD', 'TUSD', 'USDP']);
// The wallet address is not a secret, but it links this repository to the owner's funds: kept private.
const SECRET_ENV = ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY', 'BINANCE_API_KEY', 'BINANCE_API_SECRET', 'METYU_BOARD_PASSPHRASE', 'SOLANA_WALLET_ADDRESS', 'HYPERLIQUID_ADDRESS'];

class RefusedKeyError extends Error {}

/** Removes every secret value (and long base64/hex runs) from a message before it is printed. */
function redact(message, env = process.env) {
  let text = String(message);
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (value && value.length >= 6) text = text.split(value).join(`[${name}]`);
  }
  return text.replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[PEM]').replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]');
}

// ---------- Coinbase: CDP API keys sign a short-lived JWT per request ----------
const b64url = input => Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
/** Accepts an EC (ES256) PEM, a PKCS8 PEM, or the base64 Ed25519 secret that CDP shows. */
function parseCoinbaseKey(secret) {
  const text = String(secret || '').replace(/\\n/g, '\n').trim();
  if (text.includes('-----BEGIN')) return crypto.createPrivateKey(text);
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 64 && raw.length !== 32) throw new Error('COINBASE_API_PRIVATE_KEY is neither a PEM key nor a base64 Ed25519 secret');
  const seed = raw.subarray(0, 32);
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
function coinbaseJwt({ keyName, privateKey, method, host, path: requestPath, now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }) {
  const key = typeof privateKey === 'string' ? parseCoinbaseKey(privateKey) : privateKey;
  const type = key.asymmetricKeyType;
  if (type !== 'ec' && type !== 'ed25519') throw new Error(`unsupported Coinbase key type ${type}`);
  const header = { alg: type === 'ec' ? 'ES256' : 'EdDSA', kid: keyName, nonce, typ: 'JWT' };
  const nbf = Math.floor(now / 1000);
  const payload = { sub: keyName, iss: 'cdp', nbf, exp: nbf + 120, uri: `${method} ${host}${requestPath}` };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = type === 'ec'
    ? crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}
function coinbaseProvider({ keyName, privateKey, fetchImpl = fetch, now = () => Date.now() }) {
  const host = 'api.coinbase.com';
  const key = parseCoinbaseKey(privateKey);
  async function get(requestPath) {
    const pathOnly = requestPath.split('?')[0];
    const token = coinbaseJwt({ keyName, privateKey: key, method: 'GET', host, path: pathOnly, now: now() });
    const response = await fetchImpl(`https://${host}${requestPath}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Coinbase ${pathOnly}: HTTP ${response.status}`);
    return response.json();
  }
  return {
    name: 'coinbase',
    async permissions() {
      const p = await get('/api/v3/brokerage/key_permissions');
      return { canView: !!p.can_view, canTrade: !!p.can_trade, canWithdraw: !!p.can_transfer, canTransfer: !!p.can_transfer, raw: { can_view: !!p.can_view, can_trade: !!p.can_trade, can_transfer: !!p.can_transfer, portfolio_type: p.portfolio_type || null } };
    },
    async balances() {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 10; page += 1) {
        const data = await get(`/api/v3/brokerage/accounts?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const account of data.accounts || []) {
          const free = Number(account.available_balance && account.available_balance.value) || 0;
          const locked = Number(account.hold && account.hold.value) || 0;
          if (free + locked > 0) out.push({ asset: String(account.currency).toUpperCase(), free, locked });
        }
        if (!data.has_next || !data.cursor) break;
        cursor = data.cursor;
      }
      return out;
    }
  };
}

// ---------- Binance: HMAC-SHA256 signed query ----------
function binanceSignature(secret, query) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}
function binanceProvider({ apiKey, apiSecret, baseUrl = 'https://api.binance.com', fetchImpl = fetch, now = () => Date.now() }) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(baseUrl)) throw new Error('BINANCE_BASE_URL must be an https origin');
  async function get(requestPath, params = {}) {
    const query = new URLSearchParams({ ...params, recvWindow: '10000', timestamp: String(now()) }).toString();
    const signature = binanceSignature(apiSecret, query);
    const response = await fetchImpl(`${baseUrl}${requestPath}?${query}&signature=${signature}`, { headers: { 'X-MBX-APIKEY': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    // Never echo the URL: it carries the signature.
    if (!response.ok) throw new Error(`Binance ${requestPath}: HTTP ${response.status}${response.status === 451 ? ' (not available from this location)' : ''}`);
    return response.json();
  }
  return {
    name: 'binance',
    async permissions() {
      const p = await get('/sapi/v1/account/apiRestrictions');
      const canTrade = !!(p.enableSpotAndMarginTrading || p.enableMargin || p.enableFutures || p.enableVanillaOptions || p.enablePortfolioMarginTrading);
      const canWithdraw = !!p.enableWithdrawals;
      const canTransfer = !!(p.enableInternalTransfer || p.permitsUniversalTransfer);
      return { canView: !!p.enableReading, canTrade, canWithdraw, canTransfer, raw: { enableReading: !!p.enableReading, enableSpotAndMarginTrading: !!p.enableSpotAndMarginTrading, enableFutures: !!p.enableFutures, enableMargin: !!p.enableMargin, enableWithdrawals: canWithdraw, enableInternalTransfer: !!p.enableInternalTransfer, ipRestrict: !!p.ipRestrict } };
    },
    async balances() {
      const data = await get('/api/v3/account', { omitZeroBalances: 'true' });
      return (data.balances || []).map(b => ({ asset: String(b.asset).toUpperCase(), free: Number(b.free) || 0, locked: Number(b.locked) || 0 })).filter(b => b.free + b.locked > 0);
    }
  };
}

// ---------- Solana: a public wallet address read over JSON-RPC (no key at all) ----------
const Wallet = require('./metyu-wallet.js');
const SOLANA_MINTS = Wallet.MINTS;
function solanaProvider({ address, rpcUrl, balancesUrl, priceUrl = Wallet.DEFAULT_PRICES, fetchImpl = fetch }) {
  const wallet = Wallet.normaliseAddress(address);
  if (!wallet) throw new Error('SOLANA_WALLET_ADDRESS is not a Solana address (base58, 32-44 characters). Use the PUBLIC address, never a seed phrase or a private key. Fix or delete the secret, or simply link the wallet on the Live Board instead (no secret needed).');
  if (rpcUrl && !/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(rpcUrl)) throw new Error('SOLANA_RPC_URL must be an https URL');
  return {
    name: 'solana',
    // An address cannot sign anything: view-only by construction.
    async permissions() { return { canView: true, canTrade: false, canWithdraw: false, canTransfer: false, raw: { type: 'public address', network: 'solana', canSign: false } }; },
    balances: () => Wallet.solanaBalances({ address: wallet, rpcUrl, priceUrl, fetchImpl, ...(balancesUrl === undefined ? {} : { balancesUrl }) }),
    // Open token approvals (delegates): the main way wallets get drained.
    approvals: () => Wallet.solanaApprovals({ address: wallet, rpcUrl, fetchImpl })
  };
}

// ---------- Hyperliquid: the Fomo app's perps account, read by its public address ----------
const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const HL_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * What a HYPERLIQUID_ADDRESS value is, WITHOUT ever repeating it: { address } when usable (spaces,
 * quotes and a missing 0x are forgiven), else { problem } with a kind and an owner-facing hint.
 * A private key or a recovery phrase is called out loudly: it must be deleted and the funds moved.
 */
function checkHyperliquidAddress(value) {
  const text = String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (HL_ADDRESS.test(text)) return { address: text };
  if (/^[0-9a-fA-F]{40}$/.test(text)) return { address: `0x${text}` };
  const say = (kind, hint) => ({ problem: { kind, hint } });
  if (!text) return say('empty', 'the secret is empty');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) return say('private-key', 'it looks like a PRIVATE KEY (64 hex characters). Delete the secret NOW and move your funds to a new wallet: anyone who saw it can take them. Metyu needs only the public 0x address (40 hex characters).');
  if (Wallet.looksLikeSecret(text)) return say('secret', 'it looks like a recovery phrase or a private key. Delete the secret NOW and move your funds to a new wallet. Metyu needs only the public 0x address.');
  if (Wallet.normaliseAddress(text)) return say('solana', 'it is a Solana address; the perps account needs the 0x (EVM) address shown in the app\'s perps deposit screen');
  if (/^0x[0-9a-fA-F]*$/.test(text)) return say('length', `it starts with 0x but has ${text.length - 2} hex characters instead of 40 (copied only part of it?)`);
  return say('format', 'it is not a 0x address (0x followed by 40 characters 0-9 and a-f)');
}
/**
 * The perps account behind the Fomo app: margin, open positions and the API agents approved to
 * trade for it, read through the public POST /info endpoint with the public address. An address
 * cannot sign; nothing here can move funds. The order endpoint (/exchange) is never called.
 */
async function hyperliquidAccount({ address, fetchImpl = fetch, timeoutMs = 15000 }) {
  const checked = checkHyperliquidAddress(address);
  if (!checked.address) throw new Error(`HYPERLIQUID_ADDRESS is not usable: ${checked.problem.hint}`);
  address = checked.address;
  const info = async body => {
    const response = await fetchImpl(HYPERLIQUID_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...body, user: address }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    return response.json();
  };
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const state = await info({ type: 'clearinghouseState' });
  if (!state || !state.marginSummary) throw new Error('unexpected Hyperliquid answer');
  let spot = null;
  try { spot = await info({ type: 'spotClearinghouseState' }); } catch (error) { spot = null; }
  let agents = null;
  try { agents = await info({ type: 'extraAgents' }); } catch (error) { agents = null; }
  const positions = (state.assetPositions || []).map(entry => entry && entry.position).filter(Boolean).map(position => ({
    coin: String(position.coin), side: num(position.szi) < 0 ? 'SHORT' : 'LONG', size: Math.abs(num(position.szi)), entry: num(position.entryPx),
    value: num(position.positionValue), pnl: num(position.unrealizedPnl), leverage: position.leverage ? num(position.leverage.value) : null,
    liquidation: position.liquidationPx === null || position.liquidationPx === undefined ? null : num(position.liquidationPx)
  })).filter(position => position.size > 0);
  const spotUsdc = spot && Array.isArray(spot.balances) ? spot.balances.filter(b => b.coin === 'USDC').reduce((sum, b) => sum + num(b.total), 0) : 0;
  return {
    accountValue: num(state.marginSummary.accountValue), withdrawable: num(state.withdrawable), marginUsed: num(state.marginSummary.totalMarginUsed),
    spotUsdc, positions,
    agents: Array.isArray(agents) ? agents.map(agent => ({ name: String(agent.name || ''), address: String(agent.address || ''), validUntil: agent.validUntil || null })) : null
  };
}
function hyperliquidProvider({ address, fetchImpl = fetch }) {
  const checked = checkHyperliquidAddress(address);
  if (!checked.address) throw new Error(`HYPERLIQUID_ADDRESS is not usable: ${checked.problem.hint}`);
  address = checked.address;
  return {
    name: 'hyperliquid',
    async permissions() { return { canView: true, canTrade: false, canWithdraw: false, canTransfer: false, raw: { type: 'public address', network: 'hyperliquid', canSign: false } }; },
    async balances() { return []; },
    perps: () => hyperliquidAccount({ address, fetchImpl })
  };
}

/** The one rule that matters: a key that can move money is refused before anything else happens. */
function assertViewOnly(permissions) {
  const problems = [];
  if (!permissions.canView) problems.push('it cannot read balances');
  if (permissions.canTrade) problems.push('it can TRADE');
  if (permissions.canWithdraw) problems.push('it can WITHDRAW');
  if (permissions.canTransfer && !permissions.canWithdraw) problems.push('it can TRANSFER funds');
  if (problems.length) throw new RefusedKeyError(`refusing this API key: ${problems.join(', ')}. Create a view-only (read-only) key with trading, withdrawal and transfer disabled.`);
  return true;
}

/** USD value of each balance from public Coinbase prices (stablecoins at $1). */
async function priceBalances(balances, getJson) {
  const priced = [];
  for (const b of balances) {
    const total = b.free + b.locked;
    let usd = null;
    if (STABLE.has(b.asset)) usd = total;
    else if (Number.isFinite(b.price)) usd = total * b.price;           // priced by the provider (Jupiter)
    else {
      try {
        const ticker = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(b.asset)}-USD/ticker`);
        const price = Number(ticker && ticker.price);
        if (price > 0) usd = total * price;
      } catch (error) { /* unpriced: shown without a USD value */ }
    }
    priced.push({ asset: b.asset, ...(b.mint ? { mint: b.mint } : {}), free: b.free, locked: b.locked, total, usd });
  }
  priced.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  return priced;
}

function providerFromEnv(env = process.env, { fetchImpl = fetch } = {}) {
  let provider = null;
  if (env.COINBASE_API_KEY_NAME && env.COINBASE_API_PRIVATE_KEY) provider = coinbaseProvider({ keyName: env.COINBASE_API_KEY_NAME, privateKey: env.COINBASE_API_PRIVATE_KEY, fetchImpl });
  else if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) provider = binanceProvider({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, baseUrl: env.BINANCE_BASE_URL || undefined, fetchImpl });
  else if (env.SOLANA_WALLET_ADDRESS) provider = solanaProvider({ address: env.SOLANA_WALLET_ADDRESS, rpcUrl: env.SOLANA_RPC_URL || undefined, fetchImpl });
  // The Fomo app's perps account rides along with any provider, or stands alone. A bad value never
  // stops the other link: the perps part reports what is wrong (its kind, never the value).
  if (env.HYPERLIQUID_ADDRESS) {
    const checked = checkHyperliquidAddress(env.HYPERLIQUID_ADDRESS);
    if (!checked.address) {
      if (!provider) throw new Error(`HYPERLIQUID_ADDRESS is not usable: ${checked.problem.hint}`);
      const problem = checked.problem;
      provider.perps = async () => { const error = new Error(`HYPERLIQUID_ADDRESS is not usable: ${problem.hint}`); error.kind = problem.kind; throw error; };
    } else {
      const perps = hyperliquidProvider({ address: checked.address, fetchImpl });
      if (!provider) return perps;
      provider.perps = perps.perps;
    }
  }
  return provider;
}

/**
 * One sync: verify view-only, read balances, price them, seal. Returns { box, publicInfo }.
 * publicInfo carries no balances: only that an account is linked, which exchange, when it was
 * verified and that the key is view-only (the Live Board's real-money lock needs that).
 */
async function syncAccount({ provider, passphrase, getJson, now = () => Date.now() }) {
  const permissions = await provider.permissions();
  assertViewOnly(permissions);
  const balances = await priceBalances(await provider.balances(), getJson);
  const verifiedAt = new Date(now()).toISOString();
  // The security check: open token approvals. Details stay inside the sealed box; only the COUNT is
  // public (no address, no tokens), so the board and the watchdog can raise the alarm.
  let approvals = null;
  let approvalsError = null;
  if (typeof provider.approvals === 'function') {
    try { approvals = await provider.approvals(); } catch (error) { approvalsError = error.message; }
  }
  const security = { approvals: approvals ? approvals.length : null, checkedAt: approvals ? verifiedAt : null, ...(approvalsError ? { error: 'approval check unavailable' } : {}) };
  // The Fomo perps account (Hyperliquid): sealed in full; publicly only counts, never an address or an amount.
  let perps = null;
  let perpsPublic = null;
  if (typeof provider.perps === 'function') {
    try {
      perps = await provider.perps();
      perpsPublic = { linked: true, positions: perps.positions.length, agents: perps.agents ? perps.agents.length : null, checkedAt: verifiedAt };
    } catch (error) {
      // The kind of a bad secret (never its value) is published so the owner can fix it; anything else stays generic.
      perpsPublic = { linked: false, error: error.kind ? `address ${error.kind}` : 'perps account unavailable' };
      console.warn(redact(`perps account: ${error.message}`));
    }
  }
  const perpsUsd = perps ? perps.accountValue + perps.spotUsdc : 0;
  const snapshot = {
    kind: 'account', provider: provider.name, verifiedAt, viewOnly: true, permissions: permissions.raw,
    balances, totalUsd: balances.reduce((sum, b) => sum + (b.usd || 0), 0) + perpsUsd, unpriced: balances.filter(b => b.usd === null).map(b => b.asset),
    ...(approvals ? { approvals } : {}), ...(perps ? { perps } : {}), security
  };
  const box = await Vault.seal(snapshot, passphrase, { label: 'metyu-account' });
  return { box, snapshot, publicInfo: { kind: 'account-public', linked: true, provider: provider.name, verifiedAt, viewOnly: true, security, ...(perpsPublic ? { perps: perpsPublic } : {}) } };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  // Owner-only, and a fresh temporary file each time (never an existing one): atomic and private.
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function parseArgs(argv) {
  const args = { out: 'data/account.enc.json', 'public-out': null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key in args) { args[key] = argv[i + 1]; i += 1; } else throw new Error(`unknown option ${argv[i]}`);
  }
  return args;
}

async function main(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let provider;
  try { provider = providerFromEnv(env); } catch (error) {
    // A misconfigured secret (e.g. not a wallet address) is a warning: the board-side link works
    // without it, and the autopilot must not look broken because of it.
    console.log(`::warning title=account sync::${redact(error.message, env)}`);
    return 0;
  }
  if (!provider) {
    // The owner removed the key (or never set one): unpublish any earlier snapshot too.
    for (const file of [args.out, args['public-out']].filter(Boolean)) fs.rmSync(file, { force: true });
    console.log('account sync: no exchange API key configured (set the GitHub secrets to link an account); nothing to do');
    return 0;
  }
  if (!env.METYU_BOARD_PASSPHRASE || env.METYU_BOARD_PASSPHRASE.length < Vault.MIN_PASSPHRASE) { console.error(`account sync: METYU_BOARD_PASSPHRASE must be set (${Vault.MIN_PASSPHRASE}+ characters); refusing to publish balances unencrypted`); return 2; }
  const getJson = async url => { const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  try {
    const { box, publicInfo, snapshot } = await syncAccount({ provider, passphrase: env.METYU_BOARD_PASSPHRASE, getJson });
    writeJson(args.out, box);
    if (args['public-out']) writeJson(args['public-out'], publicInfo);
    console.log(`account sync: ${provider.name} key verified view-only; ${snapshot.balances.length} balances sealed to ${args.out}`);
    return 0;
  } catch (error) {
    if (error instanceof RefusedKeyError) {
      // A dangerous key: also withdraw any earlier "linked" claim so the real-money lock sees it.
      if (args['public-out']) writeJson(args['public-out'], { kind: 'account-public', linked: false, provider: provider.name, refusedAt: new Date().toISOString(), reason: 'API key is not view-only' });
      console.error(`account sync: ${redact(error.message, env)}`);
      return 3;
    }
    console.error(`account sync failed: ${redact(error.message, env)}`);
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { checkHyperliquidAddress, hyperliquidAccount, hyperliquidProvider, HYPERLIQUID_INFO, redact, parseCoinbaseKey, coinbaseJwt, coinbaseProvider, binanceSignature, binanceProvider, solanaProvider, SOLANA_MINTS, assertViewOnly, RefusedKeyError, priceBalances, providerFromEnv, syncAccount, parseArgs, main };
