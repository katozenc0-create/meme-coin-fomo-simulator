const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../scripts/preflight-live.js');

test('preflight: the repository passes every code check (CI fails the moment order code or a key appears)', () => {
  const checks = P.codeChecks();
  for (const check of checks) assert.ok(check.ok, `${check.id}: ${check.text}`);
  assert.deepEqual(checks.map(c => c.id), ['no-order-code', 'live-limits', 'costs', 'gate', 'kill-switch', 'no-secrets']);
  assert.match(checks[0].text, /no order, cancel, withdraw or signing call in \d+ source files/);
});

test('preflight: order code, signing code and secrets in a source file are caught', () => {
  const run = text => Object.fromEntries(P.codeChecks({ files: { 'x.js': text } }).map(c => [c.id, c]));
  assert.equal(run("fetch('https://api.exchange.coinbase.com/orders', { method: 'POST' })")['no-order-code'].ok, false);
  assert.equal(run('await client.createOrder(symbol, "market", "buy", 1)')['no-order-code'].ok, false);
  assert.equal(run('const tx = await wallet.signTransaction(t)')['no-order-code'].ok, false);
  assert.equal(run("kraken('private/AddOrder', params)")['no-order-code'].ok, false);
  assert.equal(run("post('https://api.hyperliquid.xyz/exchange', action)")['no-order-code'].ok, false);
  assert.equal(run("post('https://api.hyperliquid.xyz/info', { type: 'l2Book' })")['no-order-code'].ok, true, 'the read-only info endpoint is fine');
  assert.match(run('x\nawait exchange.withdraw (asset)')['no-order-code'].text, /x\.js:2/);
  assert.equal(run('const orderBook = parseBook(data); // the public book is fine')['no-order-code'].ok, true);
  assert.equal(run('-----BEGIN EC PRIVATE KEY-----')['no-secrets'].ok, false);
  assert.equal(run(`const t = 'gh${'p'}_${'a'.repeat(36)}';`)['no-secrets'].ok, false);
  assert.equal(run(`const seed = '${'abandon ability able about above absent absorb abstract absurd abuse access accident'}';`)['no-secrets'].ok, false);
  assert.equal(run('const fine = "hello world, this is a long but harmless sentence for a test";')['no-secrets'].ok, true);
});

test('preflight: readiness from the published state, with the spot reality of the signals', () => {
  const now = Date.parse('2026-11-25T21:00:00Z');
  const exchange = {
    live: { met: 3, total: 6, ready: false, conditions: [{ id: 'days', ok: true }, { id: 'trades', ok: false }, { id: 'edge', ok: false }, { id: 'risk', ok: true }, { id: 'account', ok: true }, { id: 'approval', ok: false }] },
    shadow: { orders: 3, sent: 0 },
    model: { symbols: ['BTC-USD', 'ETH-USD'] },
    execution: { minSamples: 6, coins: { 'BTC-USD': { samples: 8 }, 'ETH-USD': { samples: 3 } } },
    history: [{ side: 'SHORT', pnl: 30 }, { side: 'SHORT', pnl: -10 }, { side: 'SHORT', pnl: 5 }, { side: 'LONG', pnl: -4 }]
  };
  const account = { linked: true, provider: 'solana', viewOnly: true, verifiedAt: new Date(now - 2 * 3600000).toISOString(), security: { approvals: 0 } };
  const checks = Object.fromEntries(P.readinessChecks({ exchange, account, now }).map(c => [c.id, c]));
  assert.equal(checks.conditions.ok, false);
  assert.match(checks.conditions.text, /3\/6; missing: trades, edge, approval/);
  assert.equal(checks['shadow-not-sent'].ok, true);
  assert.equal(checks.account.ok, true);
  assert.match(checks.account.text, /solana, read-only, verified 2 h ago, no open token approvals/);
  assert.match(checks['costs-measured'].text, /1\/2 coins/);
  assert.equal(checks['spot-executable'].ok, false);
  assert.match(checks['spot-executable'].text, /3 of the last 4 trades were SHORT \(\+\$25\.00\); a spot account could have placed only the 1 LONG \(−\$4\.00\)/);
  // On a perps venue (shorts allowed) the question is whether the venue lists the coins.
  const perps = { ...exchange, execution: { ...exchange.execution, venue: 'hyperliquid', venueName: 'Hyperliquid perps', unlisted: ['QNT-USD'] }, history: [...exchange.history.map(t => ({ ...t, symbol: 'BTC-USD' })), { side: 'SHORT', pnl: -2, symbol: 'QNT-USD' }] };
  const venue = Object.fromEntries(P.readinessChecks({ exchange: perps, account, now }).map(c => [c.id, c]));
  assert.equal(venue['spot-executable'], undefined);
  assert.match(venue['venue-executable'].text, /venue Hyperliquid perps \(shorts allowed\): 4 of the last 5 trades were on listed coins; not listed: QNT-USD \(1 trades, −\$2\.00\)/);
  assert.equal(venue['venue-executable'].ok, false, '20% of trades on an unlisted coin');
  // A shadow order that was ever sent is a hard failure.
  const sent = P.report({ code: P.codeChecks({ files: { 'a.js': 'ok' } }), readiness: P.readinessChecks({ exchange: { ...exchange, shadow: { orders: 1, sent: 1 } }, account, now }), now });
  assert.deepEqual(sent.failed.map(c => c.id), ['shadow-not-sent']);
  const fine = P.report({ code: P.codeChecks({ files: { 'a.js': 'ok' } }), readiness: P.readinessChecks({ exchange, account, now }), now });
  assert.deepEqual(fine.failed, []);
  assert.match(fine.text, /\*\*Code checks pass\.\*\* Real money stays locked: 3 readiness item\(s\) open\./);
  // Approvals or a stale link fail the account item.
  assert.equal(Object.fromEntries(P.readinessChecks({ exchange, account: { ...account, security: { approvals: 2 } }, now }).map(c => [c.id, c])).account.ok, false);
  assert.equal(Object.fromEntries(P.readinessChecks({ exchange, account: { ...account, verifiedAt: new Date(now - 30 * 3600000).toISOString() }, now }).map(c => [c.id, c])).account.ok, false);
});
