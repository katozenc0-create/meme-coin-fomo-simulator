// Tests for the security-critical parts: the vault (end-to-end encryption), the view-only account
// sync (key refusal, request signing, no secret leaks) and the real-money lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Vault = require('../metyu-vault.js');
const A = require('../account-sync.js');
const X = require('../metyu-exchange.js');

const PASS = 'correct horse battery staple';

test('vault: seal/open round trip; wrong passphrase, tampering and weak passphrases fail', async () => {
  const value = { balances: [{ asset: 'BTC', total: .5 }], note: 'çğüşöı' };
  const box = await Vault.seal(value, PASS, { iterations: 100000 });
  assert.equal(box.v, 1);
  assert.equal(box.alg, 'PBKDF2-SHA256/AES-256-GCM');
  // Ciphertext only, checked with quoted keys that base64 can never contain (a random ciphertext
  // could spell 'BTC', which made the old check fail about once in a few thousand runs).
  assert.ok(!['"asset"', '"total"', '"note"'].some(text => JSON.stringify(box).includes(text)), 'ciphertext only');
  assert.ok(!['ct', 'salt', 'iv'].some(key => /[^A-Za-z0-9+/=]/.test(box[key])), 'base64 fields only');
  assert.deepEqual(await Vault.open(box, PASS), value);
  await assert.rejects(Vault.open(box, 'wrong passphrase!!'), /wrong passphrase or damaged data/);
  const flipped = Buffer.from(box.ct, 'base64');
  flipped[3] ^= 1;
  await assert.rejects(Vault.open({ ...box, ct: flipped.toString('base64') }, PASS), /wrong passphrase or damaged data/, 'tampering is detected');
  await assert.rejects(Vault.open({ ...box, label: 'other' }, PASS), /wrong passphrase or damaged data/, 'the label is authenticated');
  await assert.rejects(Vault.open({ ...box, iterations: 10 }, PASS), /key-derivation cost/, 'a box cannot downgrade the KDF');
  await assert.rejects(Vault.seal(value, 'short'), /at least 12/);
  const again = await Vault.seal(value, PASS, { iterations: 100000 });
  assert.notEqual(again.salt, box.salt);
  assert.notEqual(again.iv, box.iv);
  assert.equal((await Vault.seal(1, PASS)).iterations, 600000, 'default cost');
});

test('view-only rule: any key that can trade, withdraw or transfer is refused', () => {
  assert.equal(A.assertViewOnly({ canView: true, canTrade: false, canWithdraw: false, canTransfer: false }), true);
  assert.throws(() => A.assertViewOnly({ canView: true, canTrade: true }), /can TRADE/);
  assert.throws(() => A.assertViewOnly({ canView: true, canWithdraw: true, canTransfer: true }), /can WITHDRAW/);
  assert.throws(() => A.assertViewOnly({ canView: true, canTransfer: true }), /TRANSFER/);
  assert.throws(() => A.assertViewOnly({ canView: false }), /cannot read/);
  assert.throws(() => A.assertViewOnly({ canView: true, canTrade: true }), A.RefusedKeyError);
});

test('Coinbase JWT is signed correctly with an EC key and with an Ed25519 secret', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = ec.privateKey.export({ type: 'sec1', format: 'pem' });
  const jwt = A.coinbaseJwt({ keyName: 'organizations/o/apiKeys/k', privateKey: pem.replace(/\n/g, '\\n'), method: 'GET', host: 'api.coinbase.com', path: '/api/v3/brokerage/accounts', now: 1700000000000, nonce: 'n1' });
  const [h, p, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'organizations/o/apiKeys/k', nonce: 'n1', typ: 'JWT' });
  assert.deepEqual(payload, { sub: 'organizations/o/apiKeys/k', iss: 'cdp', nbf: 1700000000, exp: 1700000120, uri: 'GET api.coinbase.com/api/v3/brokerage/accounts' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

  const ed = crypto.generateKeyPairSync('ed25519');
  const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const cdpSecret = Buffer.concat([seed, pub]).toString('base64');          // how CDP shows Ed25519 keys
  const jwt2 = A.coinbaseJwt({ keyName: 'k2', privateKey: cdpSecret, method: 'GET', host: 'api.coinbase.com', path: '/x', now: 0 });
  const [h2, p2, s2] = jwt2.split('.');
  assert.equal(JSON.parse(Buffer.from(h2, 'base64url')).alg, 'EdDSA');
  assert.ok(crypto.verify(null, Buffer.from(`${h2}.${p2}`), ed.publicKey, Buffer.from(s2, 'base64url')));
  assert.throws(() => A.parseCoinbaseKey('not a key'), /neither a PEM key nor/);
});

test('Binance signature matches the documented example', () => {
  assert.equal(A.binanceSignature('NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
    'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559'),
  'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const body = routes[u.pathname];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(u) : body) };
  };
  return { calls, fetchImpl };
}

test('Coinbase provider: only GET read endpoints, signed per request; balances paged; refuses a trading key', async () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKey = ec.privateKey.export({ type: 'sec1', format: 'pem' });
  let page = 0;
  const { calls, fetchImpl } = fakeFetch({
    '/api/v3/brokerage/key_permissions': { can_view: true, can_trade: false, can_transfer: false, portfolio_type: 'DEFAULT' },
    '/api/v3/brokerage/accounts': () => {
      page += 1;
      return page === 1
        ? { accounts: [{ currency: 'BTC', available_balance: { value: '0.5' }, hold: { value: '0.1' } }, { currency: 'ETH', available_balance: { value: '0' }, hold: { value: '0' } }], has_next: true, cursor: 'c2' }
        : { accounts: [{ currency: 'USDC', available_balance: { value: '120.5' }, hold: { value: '0' } }], has_next: false };
    }
  });
  const provider = A.coinbaseProvider({ keyName: 'k', privateKey, fetchImpl });
  assert.deepEqual(await provider.permissions(), { canView: true, canTrade: false, canWithdraw: false, canTransfer: false, raw: { can_view: true, can_trade: false, can_transfer: false, portfolio_type: 'DEFAULT' } });
  assert.deepEqual(await provider.balances(), [{ asset: 'BTC', free: .5, locked: .1 }, { asset: 'USDC', free: 120.5, locked: 0 }]);
  assert.ok(calls.every(c => !c.init.method || c.init.method === 'GET'), 'read-only requests');
  assert.ok(calls.every(c => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(c.init.headers.Authorization)));
  assert.match(calls[2].url, /cursor=c2/);
  const uri = calls.map(c => JSON.parse(Buffer.from(c.init.headers.Authorization.split('.')[1], 'base64url')).uri);
  assert.deepEqual(uri, ['GET api.coinbase.com/api/v3/brokerage/key_permissions', 'GET api.coinbase.com/api/v3/brokerage/accounts', 'GET api.coinbase.com/api/v3/brokerage/accounts'], 'the JWT covers the path without the query');

  const trading = fakeFetch({ '/api/v3/brokerage/key_permissions': { can_view: true, can_trade: true, can_transfer: false }, '/api/v3/brokerage/accounts': () => assert.fail('balances must not be read with a trading key') });
  const refused = A.syncAccount({ provider: A.coinbaseProvider({ keyName: 'k', privateKey, fetchImpl: trading.fetchImpl }), passphrase: PASS, getJson: async () => ({}) });
  await assert.rejects(refused, /refusing this API key: it can TRADE/);
  assert.equal(trading.calls.length, 1, 'nothing else is called after the refusal');
});

test('Binance provider: signed read endpoints, the key header, and withdrawal-enabled keys refused', async () => {
  const { calls, fetchImpl } = fakeFetch({
    '/sapi/v1/account/apiRestrictions': { enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false, enableInternalTransfer: false, ipRestrict: true },
    '/api/v3/account': { balances: [{ asset: 'BTC', free: '0.2', locked: '0' }, { asset: 'BNB', free: '0', locked: '0' }] }
  });
  const provider = A.binanceProvider({ apiKey: 'pub-key', apiSecret: 'secret-xyz', fetchImpl, now: () => 1700000000000 });
  const permissions = await provider.permissions();
  assert.equal(A.assertViewOnly(permissions), true);
  assert.deepEqual(await provider.balances(), [{ asset: 'BTC', free: .2, locked: 0 }]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('timestamp'), '1700000000000');
  const unsigned = url.search.slice(1).replace(/&signature=[0-9a-f]+$/, '');
  assert.equal(url.searchParams.get('signature'), A.binanceSignature('secret-xyz', unsigned));
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], 'pub-key');
  assert.ok(!calls.some(c => c.url.includes('secret-xyz')), 'the secret is never sent');
  const risky = fakeFetch({ '/sapi/v1/account/apiRestrictions': { enableReading: true, enableWithdrawals: true } });
  await assert.rejects(A.syncAccount({ provider: A.binanceProvider({ apiKey: 'a', apiSecret: 'b', fetchImpl: risky.fetchImpl }), passphrase: PASS, getJson: async () => ({}) }), /WITHDRAW/);
  assert.throws(() => A.binanceProvider({ apiKey: 'a', apiSecret: 'b', baseUrl: 'http://evil.example' }), /https origin/);
});

test('syncAccount seals priced balances; only a balance-free link record is public', async () => {
  const provider = {
    name: 'coinbase',
    permissions: async () => ({ canView: true, canTrade: false, canWithdraw: false, canTransfer: false, raw: { can_view: true } }),
    balances: async () => [{ asset: 'BTC', free: .5, locked: 0 }, { asset: 'USDC', free: 100, locked: 0 }, { asset: 'ODD', free: 3, locked: 0 }]
  };
  const getJson = async url => { if (url.includes('BTC-USD')) return { price: '70000' }; throw new Error('HTTP 404'); };
  const { box, publicInfo, snapshot } = await A.syncAccount({ provider, passphrase: PASS, getJson, now: () => 0 });
  assert.equal(snapshot.totalUsd, 35100);
  assert.deepEqual(snapshot.unpriced, ['ODD']);
  assert.deepEqual(snapshot.balances.map(b => b.asset), ['BTC', 'USDC', 'ODD'], 'largest first');
  assert.deepEqual(publicInfo, { kind: 'account-public', linked: true, provider: 'coinbase', verifiedAt: '1970-01-01T00:00:00.000Z', viewOnly: true, security: { approvals: null, checkedAt: null } }, 'an exchange key has no token approvals to check');
  assert.ok(!JSON.stringify(box).includes('35100') && !JSON.stringify(publicInfo).includes('BTC'));
  const opened = await Vault.open(box, PASS);
  assert.equal(opened.totalUsd, 35100);
  assert.equal(opened.viewOnly, true);
});

test('main: no key is a no-op, no passphrase refuses, and secrets never reach the output', async () => {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-acct-'));
    const out = path.join(dir, 'account.enc.json');
    const pub = path.join(dir, 'account-public.json');
    fs.writeFileSync(out, '{"v":1}');
    fs.writeFileSync(pub, '{"linked":true}');
    assert.equal(await A.main({}, ['--out', out, '--public-out', pub]), 0);
    assert.ok(!fs.existsSync(out) && !fs.existsSync(pub), 'removing the key unpublishes the old snapshot');
    assert.equal(await A.main({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's', METYU_BOARD_PASSPHRASE: 'short' }, ['--out', out]), 2);
  } finally { Object.assign(console, original); }
  assert.match(lines.join('\n'), /no exchange API key configured/);
  assert.match(lines.join('\n'), /refusing to publish balances unencrypted/);
  const env = { BINANCE_API_SECRET: 'super-secret-value-123', METYU_BOARD_PASSPHRASE: PASS };
  const message = A.redact(`failed with super-secret-value-123 and ${PASS} and -----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY----- and ${'A'.repeat(60)}`, env);
  assert.ok(!message.includes('super-secret-value-123') && !message.includes(PASS) && !message.includes('abc') && !message.includes('AAAAAAAAAA'), message);
  assert.match(message, /\[BINANCE_API_SECRET\].*\[METYU_BOARD_PASSPHRASE\].*\[PEM\].*\[redacted\]/);
});

test('real-money lock: locked with a list of unmet conditions; never "ready" without every one', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const strong = { trades: 40, ci: [.05, .4], meanR: .2, wins: 25 };
  const base = { forward: strong, createdAt: '2026-11-10T00:00:00Z', account: { peak: 10000, equity: 10500, halted: false }, accountLink: { linked: true, viewOnly: true, verifiedAt: new Date(now - 3 * 3600000).toISOString() }, now };
  const almost = X.liveReadiness(base);
  assert.equal(almost.locked, true);
  assert.equal(almost.ready, false, "the owner's approval is missing");
  assert.equal(almost.met, 5);
  assert.deepEqual(almost.conditions.filter(c => !c.ok).map(c => c.id), ['approval']);
  assert.equal(X.liveReadiness({ ...base, approval: { by: 'owner' } }).ready, true);
  const fresh = X.liveReadiness({ forward: { trades: 3, ci: [-.5, .9] }, createdAt: '2026-11-29T12:00:00Z', account: { peak: 10000, equity: 9800 }, accountLink: null, now });
  assert.deepEqual(fresh.conditions.filter(c => !c.ok).map(c => c.id), ['days', 'trades', 'edge', 'account', 'approval']);
  assert.match(fresh.conditions[0].text, /forward test ran 3\+ days \(now 1\)/, 'the owner chose a 3-day training period');
  assert.equal(X.TRAINING_DAYS, 3);
  assert.equal(X.liveReadiness({ ...base, account: { peak: 10000, equity: 8900 } }).conditions.find(c => c.id === 'risk').ok, false, 'a 11% drawdown blocks');
  assert.equal(X.liveReadiness({ ...base, accountLink: { linked: true, viewOnly: false } }).conditions.find(c => c.id === 'account').ok, false);
  assert.deepEqual(X.LIVE_LIMITS, { maxOrderUsd: 25, maxDailyLossUsd: 50, maxOpenUsd: 100, maxLeverage: 1 });
  // A link counts only while re-verified: 25 h without a verification and it no longer does.
  const stale = X.liveReadiness({ ...base, accountLink: { linked: true, viewOnly: true, verifiedAt: new Date(now - 25 * 3600000).toISOString() } }).conditions.find(c => c.id === 'account');
  assert.equal(stale.ok, false);
  assert.match(stale.text, /verified within 24 h, no open token approvals \(last verified 25 h ago\)/);
  // An open token approval in the linked wallet blocks the account condition too.
  const drained = X.liveReadiness({ ...base, accountLink: { ...base.accountLink, security: { approvals: 2 } } }).conditions.find(c => c.id === 'account');
  assert.equal(drained.ok, false);
  assert.match(drained.text, /2 OPEN TOKEN APPROVAL\(S\): revoke them/);
  assert.equal(X.liveReadiness({ ...base, accountLink: { ...base.accountLink, security: { approvals: 0 } } }).conditions.find(c => c.id === 'account').ok, true);
  assert.equal(X.accountFresh({ linked: true, viewOnly: true }, now), false, 'no verification time: not fresh');
  // One week of trades: no degenerate interval in the text.
  const oneWeek = X.liveReadiness({ ...base, forward: { trades: 6, weeks: 1, ci: [.68, .68], meanR: .68 } }).conditions.find(c => c.id === 'edge');
  assert.match(oneWeek.text, /all 6 trades in 1 week: no interval yet/);
});

test('nothing in the repository holds a private key, an API secret or a .env file', () => {
  const root = path.resolve(__dirname, '..');
  const { execFileSync } = require('node:child_process');
  let files;
  try { files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (error) { return; }
  const offenders = [];
  for (const file of files) {
    if (/(^|\/)\.env(\.|$)|\.pem$|\.key$|\.p12$/.test(file)) { offenders.push(`${file}: secret-looking file name`); continue; }
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (error) { continue; }
    if (/-----BEGIN (EC |RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}/.test(text)) offenders.push(`${file}: PEM private key`);
    if (/(api[_-]?secret|private[_-]?key|passphrase)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/i.test(text) && !file.startsWith('tests/')) offenders.push(`${file}: hard-coded secret`);
    if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}/.test(text)) offenders.push(`${file}: token`);
  }
  assert.deepEqual(offenders, []);
});

// ---------- Solana wallet (e.g. the Fomo app): public address only ----------
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const JUPITER = new Set(['lite-api.jup.ag', 'api.jup.ag']);   // the retiring host and its successor
const MEME = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk';
function fakeSolana({ lamports = 2_500_000_000, prices = { [MEME]: { usdPrice: 0.002 } }, rpcError = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    const target = new URL(url);
    if (JUPITER.has(target.host) && target.pathname === '/price/v3') return reply(prices);
    // These tests exercise the RPC path: Jupiter's balances API is 'down' here.
    if (JUPITER.has(target.host)) return { ok: false, status: 404, json: async () => ({}) };
    const { method, params, id } = JSON.parse(init.body);
    if (rpcError) return reply({ jsonrpc: '2.0', id, error: { message: rpcError } });
    if (method === 'getBalance') return reply({ jsonrpc: '2.0', id, result: { value: lamports } });
    if (method === 'getTokenAccountsByOwner') {
      const legacy = params[1].programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const account = (mint, amount) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: String(amount) } } } } } });
      return reply({ jsonrpc: '2.0', id, result: { value: legacy ? [account('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 12.5), account(MEME, 1000), account(MEME, 500), account('Zero1111111111111111111111111111111111111111', 0)] : [] } });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { calls, fetchImpl };
}

test('Solana wallet: SOL and tokens read from the public address, priced, and view-only by construction', async () => {
  const fake = fakeSolana();
  const provider = A.solanaProvider({ address: WALLET, fetchImpl: fake.fetchImpl });
  assert.equal(A.assertViewOnly(await provider.permissions()), true);
  assert.deepEqual((await provider.permissions()).raw, { type: 'public address', network: 'solana', canSign: false });
  const balances = await provider.balances();
  assert.deepEqual(balances.map(b => [b.asset, b.free]), [['SOL', 2.5], ['USDC', 12.5], [`${MEME.slice(0, 4)}…${MEME.slice(-4)}`, 1500]], 'accounts of one mint add up; empty ones are skipped');
  assert.equal(balances[2].price, .002);
  const rpcCalls = fake.calls.filter(c => new URL(c.url).host === 'api.mainnet-beta.solana.com');
  assert.ok(rpcCalls.every(c => c.init.method === 'POST' && ['getBalance', 'getTokenAccountsByOwner'].includes(JSON.parse(c.init.body).method)), 'read-only RPC methods only');
  const priceCall = fake.calls.find(c => JUPITER.has(new URL(c.url).host) && new URL(c.url).pathname === '/price/v3');
  assert.equal(new URL(priceCall.url).searchParams.get('ids'), MEME, 'only unlisted tokens are priced on Jupiter');

  const getJson = async url => { if (url.includes('SOL-USD')) return { price: '150' }; throw new Error('HTTP 404'); };
  const { box, publicInfo, snapshot } = await A.syncAccount({ provider: A.solanaProvider({ address: WALLET, fetchImpl: fakeSolana().fetchImpl }), passphrase: PASS, getJson, now: () => 0 });
  assert.equal(snapshot.totalUsd, 2.5 * 150 + 12.5 + 1500 * .002);
  assert.deepEqual(publicInfo, { kind: 'account-public', linked: true, provider: 'solana', verifiedAt: '1970-01-01T00:00:00.000Z', viewOnly: true, security: { approvals: 0, checkedAt: '1970-01-01T00:00:00.000Z' } }, 'no open token approvals; only the count is public');
  assert.ok(!JSON.stringify(box).includes(WALLET) && !JSON.stringify(publicInfo).includes(WALLET), 'the address itself is never public');
  assert.equal((await Vault.open(box, PASS)).permissions.type, 'public address');
});

test('Solana wallet: bad addresses (or a seed phrase) are refused, RPC errors reported, the address redacted', async () => {
  for (const bad of ['', 'not-an-address', 'abandon ability able about above absent absorb abstract absurd abuse access accident', '0xAbC123']) {
    assert.throws(() => A.solanaProvider({ address: bad, fetchImpl: async () => { throw new Error('never called'); } }), /not a Solana address.*never a seed phrase/);
  }
  assert.throws(() => A.solanaProvider({ address: WALLET, rpcUrl: 'http://evil.example' }), /https URL/);
  await assert.rejects(A.solanaProvider({ address: WALLET, fetchImpl: fakeSolana({ rpcError: 'rate limited' }).fetchImpl }).balances(), /Jupiter: HTTP 404; api\.mainnet-beta\.solana\.com: getBalance rate limited/);
  const unpriced = await A.solanaProvider({ address: WALLET, fetchImpl: fakeSolana({ prices: {} }).fetchImpl }).balances();
  assert.equal(unpriced[2].price, undefined, 'no Jupiter price: shown without a USD value');
  assert.equal(A.providerFromEnv({ SOLANA_WALLET_ADDRESS: WALLET }).name, 'solana');
  assert.equal(A.redact(`fetch failed for ${WALLET}`, { SOLANA_WALLET_ADDRESS: WALLET }), 'fetch failed for [SOLANA_WALLET_ADDRESS]');
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = console.error = (...a) => lines.push(a.join(' '));
  try { assert.equal(await A.main({ SOLANA_WALLET_ADDRESS: 'my seed words here', METYU_BOARD_PASSPHRASE: PASS }, ['--out', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-sol-')), 'x.json')]), 0, 'a bad secret is a warning, not a failed step'); } finally { Object.assign(console, original); }
  assert.match(lines.join('\n'), /::warning title=account sync::.*not a Solana address/);
  assert.ok(!lines.join('\n').includes('my seed words here'), 'never echoed');
});

test('wallet address input: payment links and stray spaces are accepted, anything else is not', () => {
  const W = require('../metyu-wallet.js');
  assert.equal(W.normaliseAddress(`  ${WALLET}\n`), WALLET);
  assert.equal(W.normaliseAddress(`solana:${WALLET}?amount=1&label=x`), WALLET);
  assert.equal(W.normaliseAddress('abandon ability able about above absent absorb abstract absurd abuse access accident'), null, 'a seed phrase is not an address');
  assert.equal(W.normaliseAddress('0x52908400098527886E0F7030069857D2E4169EE7'), null, 'an Ethereum address is not a Solana one');
  assert.equal(W.normaliseAddress('METYU_BOARD_PASSPHRASE'), null);
  assert.equal(W.shortAddress(WALLET), '7xKX…gAsU');
  assert.equal(A.providerFromEnv({ SOLANA_WALLET_ADDRESS: ` solana:${WALLET} ` }).name, 'solana', 'the GitHub secret is forgiving too');
});

test('wallet reader: Jupiter balances first (one request), Solana RPC as the fallback, every failure named', async () => {
  const W = require('../metyu-wallet.js');
  const MEME2 = 'KMnDBXcPXoz6oMJW5XG4tXdwSWpmWEP2RQM1Uujpump';
  const make = ({ jupiter = 'ok', rpc = 'ok' } = {}) => {
    const urls = [];
    const fetchImpl = async (url, init = {}) => {
      urls.push(url);
      const target = new URL(url);
      const reply = body => ({ ok: true, status: 200, json: async () => body });
      if (JUPITER.has(target.host) && target.pathname === '/price/v3') return reply({ [MEME2]: { usdPrice: .5 } });
      if (JUPITER.has(target.host) && target.pathname === '/tokens/v2/search') return reply([{ id: MEME2, symbol: 'FIGHT<script>', name: 'Fight Coin', usdPrice: .4 }]);
      if (JUPITER.has(target.host)) {
        if (jupiter !== 'ok') return { ok: false, status: 503, json: async () => ({}) };
        assert.equal(target.pathname, `/ultra/v1/balances/${WALLET}`);
        return reply({ SOL: { amount: '2000000000', uiAmount: 2 }, [MEME2]: { uiAmount: 10 }, 'not a mint': { uiAmount: 5 }, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { uiAmount: 0 } });
      }
      if (rpc !== 'ok') return { ok: false, status: 403, json: async () => ({}) };
      const { method, id } = JSON.parse(init.body);
      return reply({ jsonrpc: '2.0', id, result: method === 'getBalance' ? { value: 1e9 } : { value: [] } });
    };
    return { urls, fetchImpl };
  };
  const first = make();
  assert.deepEqual(await W.solanaBalances({ address: WALLET, fetchImpl: first.fetchImpl }), [{ asset: 'SOL', free: 2, locked: 0 }, { asset: 'FIGHTscript', mint: MEME2, name: 'Fight Coin', free: 10, locked: 0, price: .5 }], 'malformed keys and empty tokens are skipped; the symbol comes from the token list, cleaned');
  assert.ok(!first.urls.some(url => new URL(url).host === 'api.mainnet-beta.solana.com'), 'no RPC call when Jupiter answers');
  const fallback = make({ jupiter: 'down' });
  assert.deepEqual(await W.solanaBalances({ address: WALLET, fetchImpl: fallback.fetchImpl }), [{ asset: 'SOL', free: 1, locked: 0 }]);
  await assert.rejects(W.solanaBalances({ address: WALLET, fetchImpl: make({ jupiter: 'down', rpc: 'down' }).fetchImpl }), /^Error: Jupiter: HTTP 503; api\.mainnet-beta\.solana\.com: getBalance HTTP 403$/);
  assert.throws(() => A.solanaProvider({ address: 'METYU_BOARD_PASSPHRASE' }), /link the wallet on the Live Board instead/);
});

test('Jupiter: when lite-api.jup.ag is switched off, balances, prices and names come from api.jup.ag', async () => {
  const W = require('../metyu-wallet.js');
  const MEME2 = 'KMnDBXcPXoz6oMJW5XG4tXdwSWpmWEP2RQM1Uujpump';
  const hosts = [];
  const fetchImpl = async url => {
    const target = new URL(url);
    hosts.push(`${target.host}${target.pathname.split('/').slice(0, 3).join('/')}`);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (target.host === 'lite-api.jup.ag') return { ok: false, status: 410, json: async () => ({}) };   // retired
    if (target.host !== 'api.jup.ag') throw new Error(`unexpected ${url}`);
    if (target.pathname.startsWith('/ultra/v1/balances/')) return reply({ SOL: { uiAmount: 1 }, [MEME2]: { uiAmount: 4 } });
    if (target.pathname === '/price/v3') return reply({ [MEME2]: { usdPrice: .25 } });
    if (target.pathname === '/tokens/v2/search') return reply([{ id: MEME2, symbol: 'MEME', name: 'Meme' }]);
    throw new Error(`unexpected ${url}`);
  };
  const balances = await W.solanaBalances({ address: WALLET, fetchImpl });
  assert.deepEqual(balances, [{ asset: 'SOL', free: 1, locked: 0 }, { asset: 'MEME', mint: MEME2, name: 'Meme', free: 4, locked: 0, price: .25 }]);
  assert.ok(hosts.includes('api.jup.ag/ultra/v1') && hosts.includes('api.jup.ag/price/v3') && hosts.includes('api.jup.ag/tokens/v2'), 'every Jupiter call fell back');
  assert.ok(!hosts.some(h => h.startsWith('api.mainnet-beta')), 'no RPC needed');
});

test('wallet: a token named like USDC or SOL without the real mint is an impostor, never priced or counted', async () => {
  const W = require('../metyu-wallet.js');
  const FAKE = 'ABcQ2wbqLSu7RZCe5ELhbCxW6wJvMh5EB6KpBGfhpcwt';
  const fetchImpl = async url => {
    const target = new URL(url);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (JUPITER.has(target.host) && target.pathname.startsWith('/ultra/v1/balances/')) return reply({ SOL: { uiAmount: 1 }, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { uiAmount: 5 }, [FAKE]: { uiAmount: 9389 } });
    if (JUPITER.has(target.host) && target.pathname === '/price/v3') return reply({ [FAKE]: { usdPrice: 1 } });
    if (JUPITER.has(target.host) && target.pathname === '/tokens/v2/search') return reply([{ id: FAKE, symbol: 'USDC', name: 'USDC (usdc-earn.xyz - claim)' }]);
    throw new Error(`unexpected ${url}`);
  };
  const balances = await W.solanaBalances({ address: WALLET, fetchImpl });
  const real = balances.find(b => b.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const fake = balances.find(b => b.mint === FAKE);
  assert.equal(real.asset, 'USDC');
  assert.equal(fake.asset, 'USDC?');
  assert.equal(fake.impostor, true);
  assert.equal(fake.price, undefined, 'never priced, even when a price API quotes it');
  assert.match(fake.name, /impostor of USDC: not the real mint/);
  // The account sync counts the real USDC at $1 and leaves the impostor unpriced.
  const getJson = async url => { if (url.includes('SOL-USD')) return { price: '100' }; throw new Error('HTTP 404'); };
  const provider = { name: 'solana', permissions: async () => ({ canView: true, canTrade: false, canWithdraw: false, raw: {} }), balances: async () => balances };
  const { snapshot } = await A.syncAccount({ provider, passphrase: PASS, getJson, now: () => 0 });
  assert.equal(snapshot.totalUsd, 100 + 5, 'SOL + real USDC; the 9,389 fake USDC count for nothing');
  assert.ok(snapshot.unpriced.includes('USDC?'));
});

test('wallet security: open token approvals (delegates) are found; only their count is public', async () => {
  const W = require('../metyu-wallet.js');
  const DRAINER = 'DrA1nerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, 'z');
  const account = (mint, delegate, amount) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: '100' }, ...(delegate ? { delegate, delegatedAmount: { uiAmountString: String(amount) } } : {}) } } } } });
  const fetchImpl = async (url, init) => {
    const { id, params } = JSON.parse(init.body);
    const legacy = params[1].programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result: { value: legacy ? [account(MEME, DRAINER, 50), account('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), account('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', DRAINER, 0)] : [] } }) };
  };
  assert.deepEqual(await W.solanaApprovals({ address: WALLET, fetchImpl }), [{ mint: MEME, delegate: DRAINER, amount: 50 }], 'a delegate with nothing left to spend is not a risk');
  await assert.rejects(W.solanaApprovals({ address: WALLET, fetchImpl: async () => ({ ok: false, status: 403 }) }), /api\.mainnet-beta\.solana\.com: HTTP 403/);
  // The account sync seals the details and publishes only the count.
  const provider = { name: 'solana', permissions: async () => ({ canView: true, raw: {} }), balances: async () => [{ asset: 'SOL', free: 1, locked: 0 }], approvals: () => W.solanaApprovals({ address: WALLET, fetchImpl }) };
  const getJson = async () => ({ price: '100' });
  const { box, publicInfo, snapshot } = await A.syncAccount({ provider, passphrase: PASS, getJson, now: () => 0 });
  assert.deepEqual(publicInfo.security, { approvals: 1, checkedAt: '1970-01-01T00:00:00.000Z' });
  assert.ok(!JSON.stringify(publicInfo).includes(DRAINER) && !JSON.stringify(box).includes(DRAINER), 'no address in public');
  assert.equal((await Vault.open(box, PASS)).approvals[0].delegate, DRAINER, 'the details are inside the sealed box');
  assert.equal(snapshot.security.approvals, 1);
  // A failing check is reported as unknown, never as "no approvals".
  const failing = { ...provider, approvals: async () => { throw new Error('down'); } };
  const failed = await A.syncAccount({ provider: failing, passphrase: PASS, getJson, now: () => 0 });
  assert.deepEqual(failed.publicInfo.security, { approvals: null, checkedAt: null, error: 'approval check unavailable' });
});

test('wallet security: a recovery phrase or a private key is recognised so it can be refused anywhere', () => {
  const W = require('../metyu-wallet.js');
  assert.equal(W.looksLikeSecret('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'seed');
  assert.equal(W.looksLikeSecret(Array(24).fill('word').join(' ')), 'seed');
  assert.equal(W.looksLikeSecret('4' + '5'.repeat(86)), 'private-key', 'base58 secret key');
  assert.equal(W.looksLikeSecret(`[${Array(64).fill(7).join(',')}]`), 'private-key', 'a JSON key file');
  assert.equal(W.looksLikeSecret(WALLET), null, 'a public address is not a secret');
  assert.equal(W.looksLikeSecret('hello world'), null);
  assert.equal(W.looksLikeSecret('my bankroll is ten thousand'), null);
});

test('Fomo perps (Hyperliquid): read by the public address through /info only; sealed in full, counts in public', async () => {
  const address = '0x' + 'ab'.repeat(20);
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const body = JSON.parse(request.body);
    const answers = {
      clearinghouseState: { marginSummary: { accountValue: '512.5', totalMarginUsed: '112.5' }, withdrawable: '400', assetPositions: [{ position: { coin: 'ETH', szi: '-0.05', entryPx: '1700', positionValue: '84.3', unrealizedPnl: '1.2', leverage: { type: 'isolated', value: 1 }, liquidationPx: '9000' } }, { position: { coin: 'BTC', szi: '0' } }] },
      spotClearinghouseState: { balances: [{ coin: 'USDC', total: '20' }, { coin: 'PURR', total: '5' }] },
      extraAgents: [{ name: 'fomo', address: '0x' + '11'.repeat(20), validUntil: 1 }]
    };
    return { ok: true, json: async () => answers[body.type] };
  };
  const account = await A.hyperliquidAccount({ address, fetchImpl });
  assert.ok(calls.every(c => c.url === 'https://api.hyperliquid.xyz/info' && c.request.method === 'POST'), 'only the read-only info endpoint');
  assert.ok(calls.every(c => JSON.parse(c.request.body).user === address));
  assert.deepEqual(account.positions, [{ coin: 'ETH', side: 'SHORT', size: .05, entry: 1700, value: 84.3, pnl: 1.2, leverage: 1, liquidation: 9000 }], 'empty positions are dropped');
  assert.equal(account.accountValue, 512.5);
  assert.equal(account.spotUsdc, 20);
  assert.equal(account.agents.length, 1);
  await assert.rejects(() => A.hyperliquidAccount({ address: 'not-an-address', fetchImpl }), /not usable: it is not a 0x address/);
  assert.throws(() => A.hyperliquidProvider({ address: '0x' + 'ab'.repeat(32) }), /PRIVATE KEY/, 'a 64-hex private key is refused');
  // With a Solana wallet: the perps ride along; publicly only counts.
  const env = { SOLANA_WALLET_ADDRESS: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', HYPERLIQUID_ADDRESS: address };
  const provider = A.providerFromEnv(env, { fetchImpl });
  assert.equal(provider.name, 'solana');
  assert.equal(typeof provider.perps, 'function');
  provider.balances = async () => [{ asset: 'SOL', free: 1, locked: 0, price: 150 }];
  provider.approvals = async () => [];
  const { box, snapshot, publicInfo } = await A.syncAccount({ provider, passphrase: 'a long board passphrase', getJson: async () => ({}) });
  assert.equal(snapshot.perps.positions.length, 1);
  assert.equal(snapshot.totalUsd, 150 + 512.5 + 20);
  assert.deepEqual(Object.keys(publicInfo.perps).sort(), ['agents', 'checkedAt', 'linked', 'positions']);
  assert.equal(publicInfo.perps.positions, 1);
  const open = JSON.stringify(publicInfo);
  assert.ok(!open.includes(address) && !open.includes('512') && !open.includes('ETH'), 'no address, amount or coin in public');
  assert.ok(!JSON.stringify(box).includes('512'), 'sealed');
  // Alone: a perps-only provider.
  assert.equal(A.providerFromEnv({ HYPERLIQUID_ADDRESS: address }, { fetchImpl }).name, 'hyperliquid');
  // A failing perps read never breaks the sync.
  provider.perps = async () => { throw new Error('down'); };
  const partial = await A.syncAccount({ provider, passphrase: 'a long board passphrase', getJson: async () => ({}) });
  assert.deepEqual(partial.publicInfo.perps, { linked: false, error: 'perps account unavailable' });
  assert.equal(A.redact(`x ${address} y`, env), 'x [HYPERLIQUID_ADDRESS] y', 'the address is redacted from logs');
});

test('HYPERLIQUID_ADDRESS: forgiving about spaces, quotes and 0x; loud about keys; never repeats the value', async () => {
  const good = '0x' + 'ab'.repeat(20);
  assert.equal(A.checkHyperliquidAddress(`  ${good}\n`).address, good, 'spaces and a newline are trimmed');
  assert.equal(A.checkHyperliquidAddress(`"${good}"`).address, good, 'quotes are removed');
  assert.equal(A.checkHyperliquidAddress('ab'.repeat(20)).address, good, 'a missing 0x is added');
  const kind = value => A.checkHyperliquidAddress(value).problem && A.checkHyperliquidAddress(value).problem.kind;
  assert.equal(kind(''), 'empty');
  const W = require('../metyu-wallet.js');
  assert.equal(W.looksLikeSecret('0x' + 'cd'.repeat(32)), 'private-key', 'an EVM private key is a secret');
  assert.equal(W.looksLikeSecret('0x' + 'ab'.repeat(20)), null, 'a public 0x address is not');
  assert.equal(kind('0x' + 'cd'.repeat(32)), 'private-key');
  assert.equal(kind('cd'.repeat(32)), 'private-key');
  assert.equal(kind('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'secret');
  assert.equal(kind('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'), 'solana');
  assert.equal(kind('0x' + 'ab'.repeat(19)), 'length');
  assert.equal(kind('hello'), 'format');
  for (const value of ['0x' + 'cd'.repeat(32), '0x' + 'ab'.repeat(19), '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM']) {
    assert.ok(!A.checkHyperliquidAddress(value).problem.hint.includes(value), 'the hint never repeats the value');
  }
  assert.match(A.checkHyperliquidAddress('0x' + 'cd'.repeat(32)).problem.hint, /PRIVATE KEY.*Delete it wherever you saved it and move your funds to a new wallet NOW/);
  // A bad perps secret never stops the Solana link; the public file says which kind of problem.
  const env = { SOLANA_WALLET_ADDRESS: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', HYPERLIQUID_ADDRESS: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' };
  const provider = A.providerFromEnv(env, { fetchImpl: async () => { throw new Error('no network in this test'); } });
  assert.equal(provider.name, 'solana');
  provider.balances = async () => [{ asset: 'SOL', free: 1, locked: 0, price: 150 }];
  provider.approvals = async () => [];
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const { publicInfo } = await A.syncAccount({ provider, passphrase: 'a long board passphrase', getJson: async () => ({}) });
    assert.equal(publicInfo.linked, true, 'the wallet is still linked');
    assert.deepEqual(publicInfo.perps, { linked: false, error: 'address solana' });
  } finally { console.warn = original; }
  assert.ok(warnings.some(w => /Solana address; the perps account needs the 0x/.test(w)));
  assert.ok(!warnings.some(w => w.includes('9WzDXw')), 'the value is never printed');
  // Alone, a bad value is an error naming the kind.
  assert.throws(() => A.providerFromEnv({ HYPERLIQUID_ADDRESS: '0x' + 'cd'.repeat(32) }), /PRIVATE KEY/);
  // The guard on the address passed to the reader itself.
  await assert.rejects(() => A.hyperliquidAccount({ address: 'cd'.repeat(32), fetchImpl: async () => ({}) }), /PRIVATE KEY/);
});
