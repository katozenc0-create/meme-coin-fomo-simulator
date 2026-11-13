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
const SECRET_ENV = ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY', 'BINANCE_API_KEY', 'BINANCE_API_SECRET', 'METYU_BOARD_PASSPHRASE', 'SOLANA_WALLET_ADDRESS'];

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
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;                 // base58 public key
const SOLANA_TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const SOLANA_MINTS = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'wSOL'
});
function solanaProvider({ address, rpcUrl = 'https://api.mainnet-beta.solana.com', priceUrl = 'https://lite-api.jup.ag/price/v3', fetchImpl = fetch }) {
  const wallet = String(address || '').trim();
  if (!SOLANA_ADDRESS.test(wallet)) throw new Error('SOLANA_WALLET_ADDRESS is not a Solana address (base58, 32-44 characters). Use the PUBLIC address, never a seed phrase or a private key.');
  if (!/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(rpcUrl)) throw new Error('SOLANA_RPC_URL must be an https URL');
  let id = 0;
  async function rpc(method, params) {
    id += 1;
    const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Solana RPC ${method}: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`Solana RPC ${method}: ${data.error.message || 'error'}`);
    return data.result;
  }
  return {
    name: 'solana',
    // An address cannot sign anything: view-only by construction.
    async permissions() { return { canView: true, canTrade: false, canWithdraw: false, canTransfer: false, raw: { type: 'public address', network: 'solana', canSign: false } }; },
    async balances() {
      const lamports = Number((await rpc('getBalance', [wallet, { commitment: 'confirmed' }])).value) || 0;
      const byMint = new Map();
      for (const programId of SOLANA_TOKEN_PROGRAMS) {
        const result = await rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        for (const entry of (result && result.value) || []) {
          const info = entry && entry.account && entry.account.data && entry.account.data.parsed && entry.account.data.parsed.info;
          // Only well-formed mint addresses go on (they end up in a price request URL).
          if (!info || !SOLANA_ADDRESS.test(String(info.mint)) || !info.tokenAmount) continue;
          const amount = Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount) || 0;
          if (amount > 0) byMint.set(info.mint, (byMint.get(info.mint) || 0) + amount);
        }
      }
      // USD prices for tokens Coinbase does not list (meme coins and the like), from Jupiter.
      const unknown = [...byMint.keys()].filter(mint => !SOLANA_MINTS[mint] || SOLANA_MINTS[mint] === 'wSOL');
      const prices = {};
      for (let i = 0; i < unknown.length; i += 50) {
        try {
          const query = new URLSearchParams({ ids: unknown.slice(i, i + 50).join(',') });
          const response = await fetchImpl(`${priceUrl}?${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
          if (response.ok) Object.assign(prices, await response.json());
        } catch (error) { /* unpriced: shown without a USD value */ }
      }
      const out = lamports > 0 ? [{ asset: 'SOL', free: lamports / 1e9, locked: 0 }] : [];
      for (const [mint, amount] of byMint) {
        const known = SOLANA_MINTS[mint];
        const price = prices[mint] && Number(prices[mint].usdPrice ?? prices[mint].price);
        out.push({ asset: known || `${mint.slice(0, 4)}…${mint.slice(-4)}`, mint, free: amount, locked: 0, ...(Number.isFinite(price) && price > 0 ? { price } : {}) });
      }
      return out;
    }
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
  if (env.COINBASE_API_KEY_NAME && env.COINBASE_API_PRIVATE_KEY) return coinbaseProvider({ keyName: env.COINBASE_API_KEY_NAME, privateKey: env.COINBASE_API_PRIVATE_KEY, fetchImpl });
  if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) return binanceProvider({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, baseUrl: env.BINANCE_BASE_URL || undefined, fetchImpl });
  if (env.SOLANA_WALLET_ADDRESS) return solanaProvider({ address: env.SOLANA_WALLET_ADDRESS, rpcUrl: env.SOLANA_RPC_URL || undefined, fetchImpl });
  return null;
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
  const snapshot = {
    kind: 'account', provider: provider.name, verifiedAt, viewOnly: true, permissions: permissions.raw,
    balances, totalUsd: balances.reduce((sum, b) => sum + (b.usd || 0), 0), unpriced: balances.filter(b => b.usd === null).map(b => b.asset)
  };
  const box = await Vault.seal(snapshot, passphrase, { label: 'metyu-account' });
  return { box, snapshot, publicInfo: { kind: 'account-public', linked: true, provider: provider.name, verifiedAt, viewOnly: true } };
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
  try { provider = providerFromEnv(env); } catch (error) { console.error(`account sync: ${redact(error.message, env)}`); return 2; }
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

module.exports = { redact, parseCoinbaseKey, coinbaseJwt, coinbaseProvider, binanceSignature, binanceProvider, solanaProvider, SOLANA_MINTS, assertViewOnly, RefusedKeyError, priceBalances, providerFromEnv, syncAccount, parseArgs, main };
