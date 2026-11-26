const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../metyu-exchange.js');
const { createExchangeAutopilot, freshState, statusOf, executionOf } = require('../exchange-autopilot.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
// A book around 100: spread 0.2 (half 0.1%), 10 units a level, levels 0.1 apart.
const book = (half = .1, size = 10, levels = 40) => ({
  bids: Array.from({ length: levels }, (_, i) => [String(100 - half - i * .1), String(size), 1]),
  asks: Array.from({ length: levels }, (_, i) => [String(100 + half + i * .1), String(size), 1])
});

test('execution: a book is parsed best-first, and a broken one is refused', () => {
  const parsed = X.parseBook({ bids: [['99', '1'], ['99.5', '2'], ['bad', '1']], asks: [['101', '1'], ['100.5', '3'], ['102', '0']] });
  assert.deepEqual(parsed.bids, [[99.5, 2], [99, 1]]);
  assert.deepEqual(parsed.asks, [[100.5, 3], [101, 1]]);
  assert.throws(() => X.parseBook({ bids: [], asks: [['1', '1']] }), /empty or crossed/);
  assert.throws(() => X.parseBook({ bids: [['101', '1']], asks: [['100', '1']] }), /empty or crossed/);
  assert.throws(() => X.parseBook({ message: 'NotFound' }), /empty or crossed/);
});

test('execution: an order walks the book; its cost is half the spread plus the depth it eats', () => {
  const b = X.parseBook(book());
  const small = X.bookImpact(b, 'buy', 100);                 // fits in the best level
  close(small.mid, 100);
  close(small.halfSpread, .001);
  close(small.slippage, .001, 1e-12);
  assert.equal(small.filled, true);
  // $3,000 at ~$1,001 a level: about 3 levels, so the average is above the best ask.
  const big = X.bookImpact(b, 'buy', 3000);
  assert.ok(big.slippage > small.slippage && big.slippage < .0025, String(big.slippage));
  const sell = X.bookImpact(b, 'sell', 3000);
  close(sell.slippage, big.slippage, 1e-4);                   // a symmetric book (in units, so nearly equal in dollars)
  const thin = X.bookImpact(X.parseBook(book(.1, .1, 3)), 'buy', 5000);
  assert.equal(thin.filled, false, 'a book too thin for the order');
  const sample = X.bookSample(X.parseBook(book(.1, .1, 3)), 'now');
  assert.equal(sample.slippage, X.EXECUTION.maxSlippage, 'an unfillable paper trade counts at the cap');
});

test('execution: costs rise to the measured median after enough samples, and never fall below the floor', () => {
  const samples = slippage => ({ samples: Array.from({ length: X.EXECUTION.minSamples }, () => ({ slippage, halfSpread: slippage / 2, live: slippage / 2 })) });
  assert.equal(X.costsFor('AAA-USD', {}), X.COSTS, 'no samples: the fixed costs');
  assert.equal(X.costsFor('AAA-USD', { 'AAA-USD': { samples: samples(.003).samples.slice(0, X.EXECUTION.minSamples - 1) } }), X.COSTS, 'too few samples');
  assert.equal(X.costsFor('AAA-USD', { 'AAA-USD': samples(.003) }).slippage, .003, 'a thin book costs more');
  assert.equal(X.costsFor('AAA-USD', { 'AAA-USD': samples(.003) }).feeRate, X.COSTS.feeRate, 'only slippage changes');
  assert.equal(X.costsFor('BTC-USD', { 'BTC-USD': samples(.00001) }), X.COSTS, 'a deep book never makes trading cheaper than the floor');
  assert.equal(X.costsFor('AAA-USD', { 'AAA-USD': samples(.5) }).slippage, X.EXECUTION.maxSlippage, 'capped');
  assert.equal(X.median([3, 1, 2]), 2);
  assert.equal(X.median([4, 1, 2, 3]), 2.5);
});

test('execution: training judges each coin at its own costs, so a thin coin looks worse, never better', () => {
  const rng = X.createRng(7);
  let p = 100;
  const bars = Array.from({ length: 1500 }, (_, i) => {
    const o = p; p *= Math.exp(.0004 + .02 * (rng() - .5));
    return { t: i * X.HOUR, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * .996, c: p, v: 100 + 50 * rng() };
  });
  const coins = { 'AAA-USD': bars, 'BBB-USD': bars.map(b => ({ ...b })) };
  const plain = X.train(coins, { now: 0 });
  const thin = X.train(coins, { now: 0, costsBySymbol: { 'BBB-USD': { ...X.COSTS, slippage: .005 } } });
  for (const name of Object.keys(plain.strategies)) {
    const a = plain.strategies[name].gate;
    const b = thin.strategies[name].gate;
    if (!a.trades || !b.trades || plain.strategies[name].params !== thin.strategies[name].params) continue;
    assert.ok(b.meanR <= a.meanR + 1e-12, `${name}: ${b.meanR} <= ${a.meanR}`);
  }
});

test('execution: the agent samples a few books per tick, in turn, and reports them', async () => {
  let clock = Date.parse('2026-11-25T10:07:00Z');
  const urls = [];
  const getJson = async url => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/book')) {
      if (u.pathname.includes('CCC-USD')) throw new Error('HTTP 500');
      return book(u.pathname.includes('BBB-USD') ? .3 : .01, u.pathname.includes('BBB-USD') ? 5 : 1000);
    }
    const s = Date.parse(u.searchParams.get('start'));
    const e = Date.parse(u.searchParams.get('end'));
    const step = Number(u.searchParams.get('granularity')) * 1000;
    const rows = [];
    for (let t = Math.floor(s / step) * step; t < e && t + step <= clock; t += step) rows.push([t / 1000, 99, 101, 100, 100 + Math.sin(t / 3.6e6), 100]);
    return rows.reverse();
  };
  const state = freshState();
  const pilot = createExchangeAutopilot({ getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'BBB-USD', 'CCC-USD'], trainBars: 600, execProbes: 2 } });
  await pilot.tick();
  assert.deepEqual(urls.filter(u => u.includes('/book')).map(u => new URL(u).pathname.split('/')[2]), ['AAA-USD', 'BBB-USD']);
  for (let k = 0; k < 9; k += 1) { clock += 15 * 60000; await pilot.tick(); }
  const books = urls.filter(u => u.includes('/book')).map(u => new URL(u).pathname.split('/')[2]);
  assert.equal(books.length, 20, '2 per tick');
  assert.deepEqual(books.slice(0, 6), ['AAA-USD', 'BBB-USD', 'CCC-USD', 'AAA-USD', 'BBB-USD', 'CCC-USD'], 'in turn');
  assert.ok(state.log.some(e => e.kind === 'ERROR' && /order book for CCC-USD: HTTP 500/.test(e.text)), 'a failed book is logged, never fatal');
  assert.ok(state.execution['AAA-USD'].samples.length >= X.EXECUTION.minSamples);
  const report = executionOf(state);
  assert.equal(report.floor, X.COSTS.slippage);
  assert.equal(report.coins['AAA-USD'].charged, X.COSTS.slippage, 'a deep book: the floor');
  assert.ok(report.coins['BBB-USD'].charged > .003, 'a thin book costs more');
  assert.equal(report.coins['CCC-USD'], undefined);
  assert.deepEqual(statusOf(state, { now: clock }).execution, report);
  // Off by default: no book requests.
  const quiet = [];
  const off = createExchangeAutopilot({ getJson: async url => { quiet.push(url); return getJson(url); }, now: () => clock, state: freshState(), options: { symbols: ['AAA-USD', 'BBB-USD'], trainBars: 600 } });
  await off.tick();
  assert.ok(!quiet.some(u => u.includes('/book')));
});

test('venue: Hyperliquid perps books and funding are parsed; coins it does not list are known', () => {
  const hl = X.VENUES.hyperliquid;
  assert.equal(X.venueCoin(hl, 'BTC-USD'), 'BTC');
  assert.equal(X.venueCoin(hl, 'PEPE-USD'), 'kPEPE', 'thousand-unit contract');
  assert.equal(X.venueCoin(hl, 'QNT-USD'), null, 'not listed');
  assert.equal(X.venueCoin(X.VENUES.coinbase, 'QNT-USD'), 'QNT-USD');
  const book = X.parseHyperliquidBook({ coin: 'BTC', levels: [[{ px: '99.9', sz: '2', n: 1 }, { px: '99.8', sz: '1', n: 1 }], [{ px: '100.1', sz: '3', n: 2 }]] });
  assert.deepEqual(book, { bids: [[99.9, 2], [99.8, 1]], asks: [[100.1, 3]] });
  assert.throws(() => X.parseHyperliquidBook({ levels: [[], []] }), /empty or crossed/);
  const rates = X.parseHyperliquidFunding([{ universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }, { name: 'ETH' }] }, [{ funding: '0.0000125' }, { funding: '0.01' }, { funding: '-0.00002' }]]);
  assert.deepEqual(rates, { BTC: .0000125, ETH: -.00002 });
  assert.throws(() => X.parseHyperliquidFunding({ error: 'x' }), /unexpected Hyperliquid answer/);
});

test('venue: measured funding raises the funding cost (either sign), never lowers it', () => {
  const n = X.EXECUTION.minSamples;
  const with8h = rate => X.costsFor('AAA-USD', { 'AAA-USD': { funding: Array.from({ length: n }, () => rate) } });
  assert.equal(with8h(.0000125).fundingPer8h, X.COSTS.fundingPer8h, '0.01% per 8 h: the floor');
  close(with8h(.0000267).fundingPer8h, .0000267 * 8, 1e-15);
  close(with8h(-.00004).fundingPer8h, .00004 * 8, 1e-15, 'paid by shorts when negative: assumed ours either way');
  assert.equal(with8h(-.0000001).fundingPer8h, X.COSTS.fundingPer8h, 'received funding is never credited');
  assert.equal(with8h(.01).fundingPer8h, X.EXECUTION.maxFundingPer8h, 'capped');
  assert.equal(X.costsFor('AAA-USD', { 'AAA-USD': { funding: [.001] } }), X.COSTS, 'too few samples');
});

test('venue: on Hyperliquid the agent reads funding once per tick and books in turn, skipping unlisted coins', async () => {
  let clock = Date.parse('2026-11-25T10:07:00Z');
  const posts = [];
  const getJson = async (url, body) => {
    if (body !== undefined) {
      assert.equal(url, 'https://api.hyperliquid.xyz/info', 'only the read-only info endpoint');
      posts.push(body);
      if (body.type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, [{ funding: '0.00004' }, { funding: '0.0000125' }]];
      if (body.type === 'l2Book') return { levels: [[{ px: '99.99', sz: '1000' }], [{ px: '100.01', sz: '1000' }]] };
      if (body.type === 'allMids') return { BTC: '100.05', ETH: '99.9', QNT: '1' };
      throw new Error('unexpected body');
    }
    const u = new URL(url);
    if (u.pathname.endsWith('/book')) throw new Error('no Coinbase books on the perps venue');
    const s = Date.parse(u.searchParams.get('start'));
    const e = Date.parse(u.searchParams.get('end'));
    const step = Number(u.searchParams.get('granularity')) * 1000;
    const rows = [];
    for (let t = Math.floor(s / step) * step; t < e && t + step <= clock; t += step) rows.push([t / 1000, 99, 101, 100, 100 + Math.sin(t / 3.6e6), 100]);
    return rows.reverse();
  };
  const state = freshState();
  state.execution = { 'BTC-USD': { samples: [{ at: 'old', halfSpread: 0, slippage: .5, live: 0 }] } };   // from another venue
  const pilot = createExchangeAutopilot({ getJson, now: () => clock, state, options: { symbols: ['BTC-USD', 'QNT-USD', 'ETH-USD'], trainBars: 600, execProbes: 2, venue: 'hyperliquid' } });
  for (let k = 0; k < 7; k += 1) { await pilot.tick(); clock += 15 * 60000; }
  assert.equal(state.executionVenue, 'hyperliquid');
  assert.equal(posts.filter(b => b.type === 'metaAndAssetCtxs').length, 7, 'funding once per tick');
  const books = posts.filter(b => b.type === 'l2Book').map(b => b.coin);
  assert.equal(books.length, 14);
  assert.ok(!books.includes('QNT'), 'an unlisted coin is never asked for');
  assert.ok(!state.execution['BTC-USD'].samples.some(x => x.at === 'old'), 'samples from another venue are dropped');
  const report = executionOf(state);
  assert.equal(report.venue, 'hyperliquid');
  assert.deepEqual(report.unlisted.includes('QNT-USD'), true);
  assert.equal(report.coins['BTC-USD'].fundingSamples, 7);
  close(report.coins['BTC-USD'].fundingPer8h, .00004 * 8, 1e-15);
  // Entries and marks use the venue's own prices; the basis to the Coinbase bar is recorded.
  assert.equal(state.marks['BTC-USD'].source, 'hyperliquid');
  assert.equal(state.marks['BTC-USD'].price, 100.05);
  assert.ok(Number.isFinite(report.coins['BTC-USD'].basis));
  assert.notEqual(state.marks['QNT-USD'] && state.marks['QNT-USD'].source, 'hyperliquid', 'an unlisted coin keeps its Coinbase price');
  assert.ok(!state.log.some(e => e.kind === 'ERROR' && /Hyperliquid prices/.test(e.text)));
  assert.equal(report.coins['ETH-USD'].fundingPer8h, X.COSTS.fundingPer8h);
});

test('venue: the CLI takes --venue (unknown names fall back to Coinbase); the transport POSTs a body', async () => {
  const { parseArgs, makeGetJson } = require('../exchange-autopilot.js');
  assert.equal(parseArgs(['--venue', 'hyperliquid']).venue, 'hyperliquid');
  const seen = [];
  const getJson = makeGetJson({ fetchImpl: async (url, request) => { seen.push({ url, request }); return { ok: true, json: async () => ({ ok: 1 }) }; } });
  await getJson('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin: 'BTC' });
  await getJson('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
  assert.equal(seen[0].request.method, 'POST');
  assert.equal(seen[0].request.body, '{"type":"l2Book","coin":"BTC"}');
  assert.equal(seen[1].request.method, undefined, 'a plain read is a GET');
});

test('venue prices: Hyperliquid mids map to symbols; a k-contract is per 1,000 units; failures fall back', async () => {
  const mids = X.parseHyperliquidMids({ BTC: '60781.5', kPEPE: '0.003523', ALGO: '0.080103', QNT: '70', NOPE: 'x' });
  assert.equal(mids['BTC-USD'], 60781.5);
  close(mids['PEPE-USD'], .000003523, 1e-15);
  assert.equal(mids['ALGO-USD'], .080103);
  assert.equal(mids['QNT-USD'], undefined, 'QNT is not listed on Hyperliquid');
  assert.throws(() => X.parseHyperliquidMids([1, 2]), /unexpected Hyperliquid answer/);
  // The agent keeps the Coinbase prices when the venue's prices fail, and says so.
  let clock = Date.parse('2026-11-25T10:07:00Z');
  const getJson = async (url, body) => {
    if (body !== undefined) throw new Error('HTTP 503');
    const u = new URL(url);
    const s0 = Date.parse(u.searchParams.get('start'));
    const e = Date.parse(u.searchParams.get('end'));
    const step = Number(u.searchParams.get('granularity')) * 1000;
    const rows = [];
    for (let t0 = Math.floor(s0 / step) * step; t0 < e && t0 + step <= clock; t0 += step) rows.push([t0 / 1000, 99, 101, 100, 100, 100]);
    return rows.reverse();
  };
  const state = freshState();
  const pilot = createExchangeAutopilot({ getJson, now: () => clock, state, options: { symbols: ['BTC-USD', 'ETH-USD'], trainBars: 600, venue: 'hyperliquid' } });
  await pilot.tick();
  assert.equal(state.marks['BTC-USD'].source, 'coinbase');
  assert.ok(state.log.some(e => e.kind === 'ERROR' && /Hyperliquid prices: HTTP 503 \(Coinbase prices used this tick\)/.test(e.text)));
});
