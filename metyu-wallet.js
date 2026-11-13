/*
 * Metyu wallet reader: the balances of a Solana wallet (for example the Fomo app's) from its PUBLIC
 * address, read-only. Balances are public on-chain data; an address cannot sign anything, so this can
 * never move funds. Never give anyone a seed phrase or a private key.
 *
 * Shared by the Live Board (in the owner's browser: the address stays on the device) and by
 * account-sync.js (on a GitHub runner, sealed before publishing). Solana JSON-RPC: getBalance and
 * getTokenAccountsByOwner (SPL Token and Token-2022); USD prices for tokens Coinbase does not list
 * come from Jupiter.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetyuWallet = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;                 // base58 public key
  const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
  const MINTS = Object.freeze({
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
    So11111111111111111111111111111111111111112: 'wSOL'
  });
  const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
  const DEFAULT_PRICES = 'https://lite-api.jup.ag/price/v3';

  /**
   * The address from whatever was pasted: trims spaces and line breaks, and accepts a payment link
   * ("solana:ADDRESS?amount=…") as wallets put in QR codes. Returns null if it is not an address.
   */
  function normaliseAddress(text) {
    const value = String(text || '').trim().replace(/^solana:/i, '').split(/[?&#\s]/)[0];
    return SOLANA_ADDRESS.test(value) ? value : null;
  }
  const shortAddress = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

  /**
   * Balances of `address`: [{ asset, mint?, free, locked: 0, price? }]. SOL first, then each token
   * (accounts of one mint added up; empty ones skipped). `price` (USD) is set for tokens priced on
   * Jupiter; SOL and stablecoins are priced by the caller (Coinbase, $1).
   */
  async function solanaBalances({ address, rpcUrl = DEFAULT_RPC, priceUrl = DEFAULT_PRICES, fetchImpl = fetch }) {
    const wallet = normaliseAddress(address);
    if (!wallet) throw new Error('not a Solana address (base58, 32-44 characters). Use the PUBLIC address, never a seed phrase or a private key.');
    if (!/^https:\/\/[a-z0-9.-]+(\/[\w./-]*)?$/i.test(rpcUrl)) throw new Error('the Solana RPC URL must be an https URL');
    let id = 0;
    async function rpc(method, params) {
      id += 1;
      const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Solana RPC ${method}: HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(`Solana RPC ${method}: ${data.error.message || 'error'}`);
      return data.result;
    }
    const lamports = Number((await rpc('getBalance', [wallet, { commitment: 'confirmed' }])).value) || 0;
    const byMint = new Map();
    for (const programId of TOKEN_PROGRAMS) {
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
    const unknown = [...byMint.keys()].filter(mint => !MINTS[mint] || MINTS[mint] === 'wSOL');
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
      const known = MINTS[mint];
      const price = prices[mint] && Number(prices[mint].usdPrice ?? prices[mint].price);
      out.push({ asset: known || shortAddress(mint), mint, free: amount, locked: 0, ...(Number.isFinite(price) && price > 0 ? { price } : {}) });
    }
    return out;
  }

  return { SOLANA_ADDRESS, TOKEN_PROGRAMS, MINTS, DEFAULT_RPC, DEFAULT_PRICES, normaliseAddress, shortAddress, solanaBalances };
}));
