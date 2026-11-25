// Tests for Metyu on a crypto exchange (virtual money): indicators, chart reading, sizing with
// leverage and liquidation, position replay, backtest/training, portfolio rules and the autopilot
// against a fake, controllable exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const X = require('../metyu-exchange.js');
const { createExchangeAutopilot, freshState, forwardEvidence, statusOf, loadState, saveState, parseArgs, learnable, healthOf, applyHaltReset, shadowOpen, shadowClose, shadowSummary } = require('../exchange-autopilot.js');

const H = X.HOUR;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const bar = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });
/** A deterministic synthetic market: price(t) for any time; bars built from it at any interval. */
function synthBars(price, { from, to, interval, now = Infinity }) {
  const bars = [];
  for (let t = Math.ceil(from / interval) * interval; t < to && t <= now; t += interval) {
    const steps = 4;
    // The bar that is still forming ends at `now`, like a live exchange's last candle.
    const path = Array.from({ length: steps + 1 }, (_, k) => price(Math.min(now, t + (k / steps) * interval)));
    bars.push({ t, o: path[0], h: Math.max(...path), l: Math.min(...path), c: path[steps], v: 100 + (t / interval) % 7 });
  }
  return bars;
}
/** A seeded random walk with drift: hourly bars that look like a real market (for the strategies). */
function walk(seed, drift, vol, n) {
  const rng = X.createRng(seed);
  let p = 100;
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    const path = [p];
    for (let k = 0; k < 4; k += 1) { p *= Math.exp(drift / 4 + vol / 2 * (rng() + rng() + rng() - 1.5)); path.push(p); }
    bars.push({ t: i * H, o: path[0], h: Math.max(...path), l: Math.min(...path), c: p, v: 100 + 50 * rng() });
  }
  return bars;
}

// ---------- data parsing ----------
test('Coinbase and Kraken candles are parsed oldest-first, with bad rows and duplicates dropped', () => {
  const coinbase = X.parseCoinbaseCandles([[7200, 9, 12, 10, 11, 5], [3600, 8, 11, 9, 10, 4], [3600, 8, 11, 9, 10, 4], [0, 0, 0, 0, 0, 0], 'junk']);
  assert.deepEqual(coinbase.map(c => c.t), [3600000, 7200000]);
  assert.deepEqual(coinbase[1], { t: 7200000, o: 10, h: 12, l: 9, c: 11, v: 5 });
  const kraken = X.parseKrakenCandles({ error: [], result: { XXBTZUSD: [[3600, '10', '12', '9', '11', '10.5', '7', 3]], last: 3600 } });
  assert.deepEqual(kraken, [{ t: 3600000, o: 10, h: 12, l: 9, c: 11, v: 7 }]);
  assert.equal(X.closedCandles(coinbase, H, 7200000 + H - 1).length, 1, 'the forming bar is not a signal bar');
});

test('fetchCandles pages Coinbase and falls back to Kraken when Coinbase fails', async () => {
  const now = 1000 * H;
  const urls = [];
  const coinbase = async url => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const start = Date.parse(q.get('start'));
    const end = Date.parse(q.get('end'));
    const rows = [];
    for (let t = end - H; t >= start; t -= H) rows.push([t / 1000, 99, 101, 100, 100, 1]);
    return rows;
  };
  const got = await X.fetchCandles(coinbase, 'BTC-USD', { bars: 450, now });
  assert.equal(got.source, 'coinbase');
  assert.equal(got.candles.length, 450);
  assert.equal(urls.length, 2, 'two pages of 300');
  const failing = async url => {
    if (url.includes('coinbase')) throw new Error('HTTP 503');
    assert.match(url, /api\.kraken\.com\/0\/public\/OHLC\?pair=XBTUSD&interval=60/);
    return { error: [], result: { XXBTZUSD: [[(now - H) / 1000, 1, 2, .5, 1.5, 1, 3, 1]] } };
  };
  const fallback = await X.fetchCandles(failing, 'BTC-USD', { now });
  assert.equal(fallback.source, 'kraken');
  // Stale data is refused: a stalled Coinbase feed falls back to Kraken; both stale is an error.
  const staleCoinbase = async url => (url.includes('coinbase') ? [[(now - 10 * H) / 1000, 99, 101, 100, 100, 1]] : { error: [], result: { XXBTZUSD: [[(now - H) / 1000, 1, 2, .5, 1.5, 1, 3, 1]] } });
  assert.equal((await X.fetchCandles(staleCoinbase, 'BTC-USD', { now })).source, 'kraken');
  const allStale = async url => (url.includes('coinbase') ? [[(now - 10 * H) / 1000, 99, 101, 100, 100, 1]] : { error: [], result: { XXBTZUSD: [[(now - 10 * H) / 1000, 1, 2, .5, 1.5, 1, 3, 1]] } });
  await assert.rejects(X.fetchCandles(allStale, 'BTC-USD', { now }), /stale Coinbase data .*stale Kraken data/);
  await assert.rejects(X.fetchCandles(async () => { throw new Error('down'); }, 'BTC-USD', { now }), /down/);
});

// ---------- indicators and chart reading ----------
test('indicators match their textbook values on simple series', () => {
  const flat = Array(30).fill(5);
  assert.equal(X.ema(flat, 10)[29], 5);
  assert.ok(Number.isNaN(X.ema(flat, 10)[8]));
  close(X.sma([1, 2, 3, 4], 2)[3], 3.5);
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(X.rsi(rising)[39], 100, 'only gains: RSI 100');
  const falling = rising.slice().reverse();
  close(X.rsi(falling)[39], 0);
  const candles = Array.from({ length: 40 }, (_, i) => bar(i * H, 100, 101, 99, 100));
  close(X.atr(candles)[39], 2);
  const bb = X.bollinger(flat, 20);
  assert.equal(bb.upper[29], 5);
  const range = Array.from({ length: 30 }, (_, i) => bar(i * H, 100, 100 + i, 100 - i, 100));
  const dc = X.donchian(range, 20);
  assert.equal(dc.high[25], 124, 'highest high of the 20 bars before');
  const trend = Array.from({ length: 80 }, (_, i) => bar(i * H, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
  const directional = X.adx(trend);
  assert.ok(directional.adx[79] > 40 && directional.plus[79] > directional.minus[79], 'a steady climb is a strong uptrend');
});

test('readChart sees an uptrend, a downtrend and a range, with notes a person can check', () => {
  const up = walk(1, .0015, .01, 1200);
  const readingUp = X.readChart(up);
  assert.equal(readingUp.trend, 'up');
  assert.match(readingUp.notes[0], /uptrend: EMA20 > EMA50 > EMA200/);
  assert.ok(readingUp.support < readingUp.price && readingUp.price < (readingUp.resistance || Infinity));
  assert.equal(X.readChart(walk(2, -.0012, .01, 1200)).trend, 'down');
  // A driftless walk is mostly read as a range (it still has stretches that look like trends).
  const flat = walk(3, 0, .01, 1200);
  const ind = X.computeIndicators(flat);
  const counts = { up: 0, down: 0, range: 0 };
  for (let i = 300; i < flat.length; i += 1) counts[X.readChart(flat, ind, i).trend] += 1;
  assert.ok(counts.range > counts.up + counts.down, JSON.stringify(counts));
  assert.equal(X.readChart(up.slice(0, 100)).ready, false, 'not enough history');
});

// ---------- sizing, leverage, liquidation, costs ----------
test('sizePosition risks the planned amount after costs, caps leverage, and keeps liquidation beyond the stop', () => {
  const sized = X.sizePosition({ side: 'LONG', price: 100, stop: 98, target: 104, riskAmount: 100, maxMargin: 2000, maxLeverage: 3 });
  close(sized.risk, 100, 1e-6);
  assert.ok(sized.leverage <= 3 && sized.leverage >= 1);
  assert.ok(sized.liquidation < sized.stop, 'a long is liquidated below its stop');
  const short = X.sizePosition({ side: 'SHORT', price: 100, stop: 102, target: 96, riskAmount: 100, maxMargin: 1000, maxLeverage: 3 });
  assert.ok(short.liquidation > short.stop);
  // Tiny margin: leverage is capped and the trade gets smaller (less risk), never riskier.
  const capped = X.sizePosition({ side: 'LONG', price: 100, stop: 98, target: 104, riskAmount: 100, maxMargin: 500, maxLeverage: 2 });
  assert.equal(capped.leverage, 2);
  close(capped.notional, 1000, 1e-6);
  assert.ok(capped.risk < 100);
  // A wide stop with high leverage would sit past the liquidation price: leverage comes down.
  const wide = X.sizePosition({ side: 'LONG', price: 100, stop: 70, target: 150, riskAmount: 1000, maxMargin: 1000, maxLeverage: 5 });
  assert.ok(wide.liquidation < 70 - 10, `liquidation ${wide.liquidation} well below the stop`);
  assert.equal(X.sizePosition({ side: 'LONG', price: 100, stop: 101, riskAmount: 100, maxMargin: 1000, maxLeverage: 3 }), null, 'stop on the wrong side');
});

test('settle charges fees, slippage and funding, and a loss never exceeds the margin', () => {
  const position = { ...X.sizePosition({ side: 'LONG', price: 100, stop: 95, target: 110, riskAmount: 100, maxMargin: 1e6, maxLeverage: 1 }), openedAt: 0 };
  const flat = X.settle(position, 100, 0);
  assert.ok(flat.pnl < 0, 'a round trip at the same price costs money');
  close(flat.pnl, -(position.entry - X.fillPrice(100, false)) * position.qty - flat.fees, 1e-9);
  const later = X.settle(position, 100, 24 * H);
  close(later.funding, position.notional * X.COSTS.fundingPer8h * 3, 1e-9);
  const atStop = X.settle(position, 95, 0);
  close(atStop.r, -1, 1e-9);
  const levered = { ...X.sizePosition({ side: 'LONG', price: 100, stop: 95, target: 110, riskAmount: 100, maxMargin: 100, maxLeverage: 3 }), openedAt: 0 };
  assert.equal(X.settle(levered, 1, 0).pnl, -levered.margin, 'isolated margin: at most the margin is lost');
});

// ---------- position replay ----------
function openLong({ stop = 98, target = 104, atr = 1 } = {}) {
  return { ...X.sizePosition({ side: 'LONG', price: 100, stop, target, riskAmount: 100, maxMargin: 1e6, maxLeverage: 1, costs: { ...X.COSTS, slippage: 0 } }), openedAt: 0, atr };
}
test('replayPosition: stop, take profit, gap fills, stop-first on a wide bar, and the time stop', () => {
  const costs = { ...X.COSTS, slippage: 0 };
  const position = openLong();
  assert.deepEqual(X.replayPosition(position, [bar(0, 100, 101, 97.5, 98)], { costs }).exit, { price: 98, at: 0, reason: 'stop loss' });
  assert.equal(X.replayPosition(position, [bar(0, 100, 104.5, 99, 104)], { costs }).exit.reason, 'take profit');
  const gap = X.replayPosition(position, [bar(0, 100, 100.5, 99, 100), bar(H, 96, 97, 95, 96)], { costs }).exit;
  assert.deepEqual(gap, { price: 96, at: H, reason: 'stop loss (gap)' }, 'a gap through the stop fills at the open');
  assert.equal(X.replayPosition(position, [bar(0, 100, 105, 97, 100)], { costs }).exit.reason, 'stop loss', 'both touched: count the stop');
  const quiet = Array.from({ length: 80 }, (_, i) => bar(i * H, 100, 100.5, 99.5, 100));
  const timed = X.replayPosition(position, quiet, { costs });
  assert.equal(timed.exit.reason, 'time stop');
  assert.equal(timed.exit.at, 72 * H);
  assert.equal(X.replayPosition(position, quiet.slice(0, 5), { costs }).exit, null, 'still open');
  // Bars from before the entry are ignored.
  assert.equal(X.replayPosition({ ...position, openedAt: 10 * H }, [bar(0, 100, 100, 90, 95)], { costs }).exit, null);
});

test('replayPosition moves the stop to break-even, then trails it; liquidation comes first if closer', () => {
  const costs = { ...X.COSTS, slippage: 0 };
  const position = openLong({ target: 200, atr: 1 });
  const run = [bar(0, 100, 101.7, 99.9, 101.6), bar(H, 101.6, 105, 101.5, 105)];
  const result = X.replayPosition(position, run, { costs });
  assert.equal(result.exit, null);
  close(result.stop, 105 - 2.5, 1e-9);
  const back = X.replayPosition(position, [...run, bar(2 * H, 105, 105, 102, 102.2)], { costs });
  assert.deepEqual(back.exit, { price: 102.5, at: 2 * H, reason: 'trailing stop' });
  const even = X.replayPosition(position, [bar(0, 100, 101.6, 99.9, 101.5)], { costs });
  close(even.stop, 100, 1e-9);
  const risky = { ...position, liquidation: 99, initialStop: 98 };
  assert.equal(X.replayPosition(risky, [bar(0, 100, 100, 97, 97.5)], { costs }).exit.reason, 'liquidated');
});

// ---------- backtest, evidence, training ----------
test('backtest walks the same rules over history and train judges the gate only out of sample', () => {
  const series = { 'AAA-USD': walk(1, .0015, .01, 1200), 'BBB-USD': walk(2, -.0012, .01, 1200), 'CCC-USD': walk(3, 0, .01, 1200) };
  const trades = X.backtest(series['AAA-USD'], 'trend', { stopAtr: 2, targetAtr: 3 }, { symbol: 'AAA-USD' });
  assert.ok(trades.length > 0, 'a trending market produces trend trades');
  for (const trade of trades) {
    assert.ok(trade.closedAt >= trade.openedAt && Number.isFinite(trade.r));
    assert.ok(trade.r >= -1.6, `a stop-out costs about 1R (gaps aside): ${trade.r}`);
  }
  const model = X.train(series, { now: 5 });
  assert.equal(model.trainedAt, 5);
  assert.deepEqual(Object.keys(model.strategies), ['trend', 'breakoutBtc', 'breakout', 'reversion', 'trend4h']);
  assert.equal(model.strategies.trend4h.timeframe, 4, 'the 4-hour trend is trained on 4-hour bars');
  assert.equal(model.strategies.trend.timeframe, 1);
  for (const s of Object.values(model.strategies)) {
    assert.ok(X.STRATEGIES.trend.grid.concat(X.STRATEGIES.breakout.grid, X.STRATEGIES.reversion.grid).includes(s.params));
    assert.equal(s.gate.open, s.gate.trades >= 30 && s.gate.ci[0] > 0);
  }
  const ev = X.evidence(Array(40).fill(.3).map((r, i) => r + (i % 2 ? .1 : -.1)));
  assert.equal(ev.open, true);
  assert.equal(X.evidence(Array(20).fill(.5)).open, false, 'too few trades');
  assert.equal(X.evidence(Array(40).fill(0).map((_, i) => (i % 2 ? 1 : -1))).open, false, 'no edge');
});

// ---------- portfolio rules ----------
test('admit enforces the kill-switch, position count, one per coin, cool-down, side risk, daily loss and margin', () => {
  const account = { cash: 10000, halted: false, day: '1970-01-01', dayStartEquity: 10000 };
  const base = { account, positions: {}, symbol: 'BTC-USD', side: 'LONG', book: 'gated', now: 0, equity: 10000 };
  const ok = X.admit(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.riskAmount, 100);
  assert.equal(ok.maxLeverage, 5);
  assert.equal(X.admit({ ...base, riskScale: 1.5 }).riskAmount, 150, 'the leverage tier scales the normal-book risk');
  assert.equal(X.admit({ ...base, riskScale: 9 }).riskAmount, 200, 'never more than 2x');
  assert.equal(X.admit({ ...base, book: 'learning', riskScale: 2 }).riskAmount, 25, 'the learning book is never scaled');
  assert.equal(X.admit({ ...base, book: 'learning' }).riskAmount, 25);
  assert.equal(X.admit({ ...base, book: 'learning' }).maxLeverage, 2);
  const held = (symbol, side = 'LONG', risk = 100, margin = 1000) => ({ symbol, side, risk, margin });
  assert.match(X.admit({ ...base, account: { ...account, halted: true } }).reasons.join(), /kill-switch/);
  assert.match(X.admit({ ...base, positions: { a: held('BTC-USD') } }).reasons.join(), /already a position on this coin/);
  assert.match(X.admit({ ...base, positions: { a: held('A', 'SHORT', 1), b: held('B', 'SHORT', 1), c: held('C', 'SHORT', 1), d: held('D', 'SHORT', 1), e: held('E', 'SHORT', 1), f: held('F', 'SHORT', 1) } }).reasons.join(), /6 open normal-book positions \(max 6\)/);
  assert.equal(X.admit({ ...base, positions: { a: held('A', 'SHORT', 1), b: held('B', 'SHORT', 1), c: held('C', 'SHORT', 1), d: held('D', 'SHORT', 1) } }).ok, true, 'a 5th normal-book position is allowed when its risk fits');
  // The learning book's tiny trades may fill all 8 coins; the normal book keeps its limit of 4.
  const learn = (symbol, side = 'SHORT', risk = 1, margin = 100) => ({ ...held(symbol, side, risk, margin), book: 'learning' });
  const four = { a: learn('A'), b: learn('B'), c: learn('C'), d: learn('D') };
  assert.equal(X.admit({ ...base, book: 'learning', positions: four }).ok, true, 'a 5th learning position is allowed');
  const eight = { ...four, e: learn('E'), f: learn('F'), g: learn('G'), h: learn('H') };
  assert.match(X.admit({ ...base, book: 'learning', positions: eight }).reasons.join(), /8 open learning positions \(max 8\)/);
  // Separate budgets: research trades never take a proven strategy's place (count or side risk).
  assert.equal(X.admit({ ...base, side: 'SHORT', positions: eight }).ok, true, 'learning positions do not fill the normal book');
  const normalShorts = { a: held('A', 'SHORT', 100), b: held('B', 'SHORT', 100) };
  const research = { c: learn('C', 'SHORT', 25), d: learn('D', 'SHORT', 25) };
  assert.equal(X.admit({ ...base, side: 'SHORT', positions: { ...normalShorts, ...research } }).ok, true, 'learning risk is not counted against the normal side cap');
  assert.match(X.admit({ ...base, side: 'SHORT', positions: { ...normalShorts, e: held('E', 'SHORT', 100), f: held('F', 'SHORT', 100) } }).reasons.join(), /too much short risk/);
  const researchFull = Object.fromEntries('CDEFGHIJ'.split('').map(c => [c, learn(c, 'SHORT', 25)]));
  assert.match(X.admit({ ...base, book: 'learning', side: 'SHORT', positions: researchFull }).reasons.join(), /too much short risk/, 'the learning book has its own 2% cap');
  assert.equal(X.admit({ ...base, side: 'SHORT', positions: { a: held('A', 'SHORT', 1), b: held('B', 'SHORT', 1), c: held('C', 'SHORT', 1), d: held('D', 'SHORT', 1), e: held('E', 'SHORT', 1), f: held('F', 'SHORT', 1) } }).reasons.some(r => /6 open normal-book positions/.test(r)), true);
  assert.equal(X.RULES.learnMaxOpen, 8);
  assert.match(X.admit({ ...base, positions: { a: held('ETH-USD', 'LONG', 200), b: held('SOL-USD', 'LONG', 150) } }).reasons.join(), /too much long risk/);
  assert.equal(X.admit({ ...base, positions: { a: held('ETH-USD', 'SHORT', 150), b: held('SOL-USD', 'SHORT', 100) } }).ok, true, 'opposite side: hedges');
  assert.match(X.admit({ ...base, lastLossAt: { 'BTC-USD': -H } }).reasons.join(), /cool-down/);
  assert.equal(X.admit({ ...base, now: 7 * H, lastLossAt: { 'BTC-USD': 0 } }).ok, true);
  assert.match(X.admit({ ...base, equity: 9550 }).reasons.join(), /daily loss limit/);
  assert.match(X.admit({ ...base, positions: { a: held('A', 'SHORT', 1, 3000), b: held('B', 'SHORT', 1, 3000) } }).reasons.join(), /no free margin/);
});

// ---------- the autopilot against a fake exchange ----------
function fakeExchange(priceOf) {
  const calls = [];
  const getJson = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.host !== 'api.exchange.coinbase.com') throw new Error(`unexpected ${url}`);
    const symbol = u.pathname.split('/')[2];
    const interval = Number(u.searchParams.get('granularity')) * 1000;
    const bars = synthBars(t => priceOf(symbol, t), { from: Date.parse(u.searchParams.get('start')), to: Date.parse(u.searchParams.get('end')), interval, now: fake.now() });
    return bars.reverse().map(b => [b.t / 1000, b.l, b.h, b.o, b.c, b.v]);
  };
  const fake = { calls, getJson, now: () => 0 };
  return fake;
}
// A test strategy: always long, 2-ATR stop, 3-ATR target.
const ALWAYS_LONG = {
  label: 'Always long (test)', grid: [{}],
  signal: (candles, ind, i) => ({ side: 'LONG', stop: candles[i].c - 2 * ind.atr[i], target: candles[i].c + 3 * ind.atr[i], reason: 'test signal' })
};

function setup({ priceOf, symbols = ['AAA-USD'], learn = true, model = null, start = 600 * H + 7 * 60000 }) {
  let clock = start;
  const fake = fakeExchange(priceOf);
  fake.now = () => clock;
  const state = freshState();
  state.model = model;
  const pilot = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols, learn, trainBars: 600, strategies: { test: ALWAYS_LONG } } });
  return { pilot, state, fake, advance: ms => { clock += ms; } };
}
const UNDECIDED = { trainedAt: 600 * H, strategies: { test: { params: {}, gate: { open: false, trades: 40, meanR: -.05, ci: [-.2, .1] } } } };

test('autopilot opens a learning position on a signal, once per hourly bar, and records it', async () => {
  const { pilot, state, advance } = setup({ priceOf: (s, t) => 100 + 2 * Math.sin(t / H / 4), model: UNDECIDED });
  const first = await pilot.tick();
  assert.equal(first.signals, 1);
  const held = Object.values(state.positions);
  assert.equal(held.length, 1);
  assert.equal(held[0].book, 'learning');
  assert.ok(held[0].leverage <= X.RULES.learnMaxLeverage);
  close(held[0].risk, X.RULES.learnRiskPct * 10000, 1e-6);
  assert.match(state.log.find(l => l.kind === 'LEARN').text, /AAA-USD LONG .*stop .*target .*liq/);
  close(state.account.cash, 10000 - held[0].margin, 1e-9);
  advance(15 * 60000);
  assert.equal((await pilot.tick()).signals, 0, 'same hourly bar: no new signal');
});

test('the learning book skips a strategy proven to lose; an open gate trades the normal book', async () => {
  const losing = { ...UNDECIDED, strategies: { test: { params: {}, gate: { open: false, trades: 60, meanR: -.3, ci: [-.5, -.1] } } } };
  const a = setup({ priceOf: () => 100, model: losing });
  await a.pilot.tick();
  assert.equal(Object.keys(a.state.positions).length, 0);
  assert.match(a.state.log.find(l => l.kind === 'WATCH').text, /loses after costs/);
  assert.equal(learnable(losing.strategies.test), false);
  assert.equal(learnable(UNDECIDED.strategies.test), true);
  const open = { ...UNDECIDED, strategies: { test: { params: {}, gate: { open: true, trades: 60, meanR: .3, ci: [.1, .5] } } } };
  const b = setup({ priceOf: (s, t) => 100 + Math.sin(t / H), model: open });
  await b.pilot.tick();
  const held = Object.values(b.state.positions)[0];
  assert.equal(held.book, 'gated');
  close(held.risk, X.RULES.riskPct * 10000, 1e-6);
  const c = setup({ priceOf: () => 100, model: UNDECIDED, learn: false });
  await c.pilot.tick();
  assert.equal(Object.keys(c.state.positions).length, 0, 'without --learn only an open gate trades');
});

test('autopilot closes at the stop on 15-minute bars, books the loss and starts the cool-down', async () => {
  let crash = Infinity;
  const { pilot, state, advance } = setup({ priceOf: (s, t) => (t < crash ? 100 + Math.sin(t / H) : 80), model: UNDECIDED });
  await pilot.tick();
  const held = Object.values(state.positions)[0];
  crash = 600 * H + 30 * 60000;
  advance(60 * 60000);
  await pilot.tick();
  assert.equal(Object.keys(state.positions).length, 0);
  const trade = state.history[0];
  assert.match(trade.reason, /stop loss/);
  assert.equal(trade.learning, true);
  close(trade.r, -1, 1e-6);                                              // the drop touched the stop inside a bar: filled at the stop
  assert.ok(trade.pnl >= -held.margin);
  assert.equal(state.account.trades, 1);
  assert.ok(state.lastLossAt['AAA-USD'] > 0);
  close(state.account.cash, 10000 + trade.pnl, 1e-6);
  advance(60 * 60000);
  await pilot.tick();
  assert.match(state.log.find(l => l.kind === 'SKIP').text, /cool-down/);
});

test('the kill-switch closes everything and halts at -15% from the peak', async () => {
  const { pilot, state } = setup({ priceOf: () => 100, model: UNDECIDED });
  state.account.cash = 8000;                                            // pretend earlier losses
  state.account.peak = 10000;
  await pilot.tick();
  assert.equal(state.account.halted, true);
  assert.equal(Object.keys(state.positions).length, 0);
  assert.match(state.log.find(l => l.kind === 'HALT').text, /15% below the peak/);
});

test('autopilot trains itself when it has no model, and survives a coin whose data fails', async () => {
  const fake = fakeExchange((s, t) => 100 * (1 + .02 * Math.sin(t / H / 6)));
  const clock = 700 * H;
  fake.now = () => clock;
  const failing = async url => { if (url.includes('BBB-USD')) throw new Error('HTTP 500'); return fake.getJson(url); };
  const state = freshState();
  const pilot = createExchangeAutopilot({ getJson: failing, now: () => clock, state, options: { symbols: ['AAA-USD', 'CCC-USD', 'BBB-USD'], learn: true, trainBars: 600 } });
  const result = await pilot.tick();
  assert.ok(state.model, 'trained');
  assert.deepEqual(state.model.symbols, ['AAA-USD', 'CCC-USD']);
  assert.match(state.log.find(l => l.kind === 'TRAIN').text, /walk-forward on \d+ hourly bars of 2 core coins/);
  assert.ok(state.log.some(l => l.kind === 'ERROR' && /BBB-USD/.test(l.text)));
  assert.equal(result.prices, 2);
  assert.equal(state.trainings.length, 1);
});

test('forward evidence, public status with charts, persistence and CLI options', async () => {
  const history = Array.from({ length: 32 }, (_, i) => ({ learning: true, risk: 25, r: i % 4 ? .6 : -1, pnl: i % 4 ? 15 : -25, openedAt: new Date(i * H).toISOString() }));
  const forward = forwardEvidence(history, { learning: true, now: 4 * X.DAY });
  assert.equal(forward.trades, 32);
  assert.equal(forward.wins, 24);
  close(forward.meanR, (24 * .6 - 8) / 32, 1e-12);
  assert.equal(forward.weeks, 1, 'all 32 trades fall in one week');
  assert.equal(forward.convincing, false, 'one week is not 32 independent observations');
  const spread = Array.from({ length: 40 }, (_, i) => ({ learning: false, risk: 100, r: i % 5 ? .8 : -1, pnl: 0, openedAt: new Date(i * 1.5 * X.DAY).toISOString() }));
  const forwardSpread = forwardEvidence(spread, { learning: false, now: 70 * X.DAY });
  assert.ok(forwardSpread.weeks >= 8);
  assert.equal(forwardSpread.convincing, forwardSpread.ci[0] > 0);
  assert.equal(forwardSpread.convincing, true, '40 winning-on-average trades over 9 weeks');
  assert.equal(forwardEvidence(history, { learning: false }).trades, 0);

  const { pilot, state } = setup({ priceOf: (s, t) => 100 + 2 * Math.sin(t / H / 4), model: UNDECIDED });
  await pilot.tick();
  const status = statusOf(state, { now: 600 * H + 10 * 60000, series: pilot.series() });
  assert.equal(status.virtualMoney, true);
  assert.equal(status.kind, 'exchange');
  assert.equal(status.positions.length, 1);
  assert.ok(Number.isFinite(status.positions[0].pnl));
  assert.equal(status.charts['AAA-USD'].bars.length, 120);
  assert.equal(status.charts['AAA-USD'].ema20.length, 120);
  assert.equal(status.model.strategies.test.learnable, true);
  assert.ok(status.account.equity > 9900 && status.account.equity <= 10000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-ex-'));
  const file = path.join(dir, 'nested', 'exchange.json');
  saveState(file, state);
  assert.deepEqual(loadState(file), JSON.parse(JSON.stringify(state)));
  fs.writeFileSync(file, '{broken');
  assert.equal(loadState(file).account.cash, 10000, 'a corrupt state starts fresh');
  assert.equal(loadState(path.join(dir, 'missing.json'), { bankroll: 500 }).account.bankroll, 500);

  assert.deepEqual(parseArgs(['--once', '--learn', '--state', 'x.json', '--symbols', 'btc-usd,ETH-USD', '--train-bars', '99999']),
    { state: 'x.json', 'status-out': null, interval: 900, bankroll: undefined, once: true, learn: true, 'train-bars': 20000, retrain: 24, 'stress-days': 0, symbols: ['BTC-USD', 'ETH-USD'], 'account-public': null, pause: false });
  assert.throws(() => parseArgs(['--symbols', 'BTCUSDT']), /look like BTC-USD/);
  assert.throws(() => parseArgs(['--wallet', 'x']), /unknown option/);
});

// ---------- v2: real-time exits, resume, gap fill, pause ----------
test('replayPosition resumes from saved progress and never trails on a forming bar', () => {
  const costs = { ...X.COSTS, slippage: 0 };
  const position = openLong({ target: 200, atr: 1 });
  const first = X.replayPosition(position, [bar(0, 100, 101.7, 99.9, 101.6)], { costs });
  close(first.stop, 100, 1e-9);
  assert.equal(first.best, 101.6);
  // Resume: the saved stop/best carry over; bars before checkedUntil are skipped.
  const resumed = { ...position, stop: first.stop, best: first.best, checkedUntil: H };
  assert.equal(X.replayPosition(resumed, [bar(0, 100, 100, 90, 95), bar(H, 101.6, 101.7, 100.5, 101)], { costs }).exit, null, 'the old bar is not replayed');
  assert.equal(X.replayPosition(resumed, [bar(H, 101.6, 101.7, 99.8, 100.2)], { costs }).exit.reason, 'trailing stop', 'the break-even stop holds after resuming');
  const forming = X.replayPosition(position, [bar(0, 100, 106, 99.9, 105.9)], { costs, trail: false });
  assert.equal(forming.stop, position.initialStop, 'an unfinished bar does not move the stop');
  assert.equal(X.replayPosition(position, [bar(0, 100, 100.2, 97.9, 98)], { costs, trail: false }).exit.reason, 'stop loss', 'but a stop hit in it counts');
});

test('real-time manage: 1-minute exits, a forming-minute stop hit, and a 15-minute gap fill', async () => {
  let crashAt = Infinity;
  const { pilot, state, fake, advance } = setup({ priceOf: (s, t) => (t < crashAt ? 100 + Math.sin(t / H) : 80), model: UNDECIDED });
  await pilot.tick();
  const held = Object.values(state.positions)[0];
  advance(3 * 60000);
  await pilot.tick();
  assert.ok(held.checkedUntil > held.openedAt, 'finished minutes were walked');
  assert.ok(fake.calls.some(url => /granularity=60&/.test(url)), '1-minute bars are used');
  assert.equal(Object.keys(state.positions).length, 1);
  // The price collapses inside the current, unfinished minute: closed right away.
  crashAt = 600 * H + 7 * 60000 + 3 * 60000 + 20000;
  advance(30000);
  await pilot.tick();
  assert.equal(Object.keys(state.positions).length, 0);
  assert.match(state.history[0].reason, /stop loss/);

  // Away for 8 hours: the gap older than the 1-minute history is covered with 15-minute bars.
  const b = setup({ priceOf: (s, t) => 100 + 2 * Math.sin(t / H / 4), model: UNDECIDED });
  await b.pilot.tick();
  const heldB = Object.values(b.state.positions)[0];
  b.fake.calls.length = 0;
  b.advance(8 * H);
  await b.pilot.tick();
  assert.ok(b.fake.calls.some(url => /granularity=900&/.test(url)), '15-minute bars fill the gap');
  if (b.state.positions[heldB.id]) assert.ok(heldB.checkedUntil > heldB.openedAt + 7 * H, 'progress covers the whole gap');
});

test('pause: no new positions while paused, exits still managed; logged once each way', async () => {
  const fakeA = setup({ priceOf: (s, t) => 100 + Math.sin(t / H), model: UNDECIDED });
  const paused = createExchangeAutopilot({ getJson: fakeA.fake.getJson, now: () => 600 * H + 7 * 60000, state: fakeA.state, options: { symbols: ['AAA-USD'], learn: true, pause: true, strategies: { test: ALWAYS_LONG } } });
  await paused.tick();
  await paused.tick();
  assert.equal(Object.keys(fakeA.state.positions).length, 0);
  assert.equal(fakeA.state.log.filter(l => l.kind === 'PAUSE').length, 1, 'logged once');
  assert.equal(fakeA.state.paused, true);
  await fakeA.pilot.tick();                                         // the same state, not paused
  assert.equal(fakeA.state.log.filter(l => l.kind === 'RESUME').length, 1);
  assert.equal(parseArgs(['--pause']).pause, true);
});

test('aggregateCandles builds complete UTC-aligned N-hour bars and drops unfinished ones', () => {
  const hourly = Array.from({ length: 10 }, (_, i) => bar((i + 2) * H, 100 + i, 101 + i, 99 + i, 100.5 + i, 1));
  const four = X.aggregateCandles(hourly, 4);
  // hours 2..11: bucket 0-4 has only hours 2,3 (incomplete), 4-8 complete, 8-12 complete
  assert.deepEqual(four.map(b => b.t), [4 * H, 8 * H]);
  assert.deepEqual(four[0], { t: 4 * H, o: 102, h: 106, l: 101, c: 105.5, v: 4 });
  assert.deepEqual(X.aggregateCandles(hourly, 4, 11 * H).map(b => b.t), [4 * H], 'a bucket still forming at `now` is left out');
  assert.equal(X.aggregateCandles(hourly, 1), hourly);
  assert.equal(X.timeframeOf('trend4h'), 4);
  assert.equal(X.timeframeOf('trend'), 1);
});

test('a release that adds strategies or coins retrains at once instead of waiting a day', async () => {
  // A model trained yesterday, before the 4-hour strategy existed (and on fewer coins).
  const old = { trainedAt: 600 * H - 3 * H, symbols: ['AAA-USD'], strategies: { trend: UNDECIDED.strategies.test } };
  const { pilot, state, fake } = setup({ priceOf: (s, t) => 100 + 2 * Math.sin(t / H / 3), model: old });
  pilot.state.model = old;
  const fresh = createExchangeAutopilot({ getJson: fake.getJson, now: () => 600 * H + 7 * 60000, state, options: { symbols: ['AAA-USD', 'BBB-USD'], learn: true, trainBars: 1200 } });
  await fresh.tick();
  assert.ok(state.model.trainedAt > old.trainedAt, 'retrained at once, not 21 hours later');
  assert.ok(state.model.strategies.trend4h, 'the new strategy is in the model');
  assert.match(state.log.find(l => l.kind === 'TRAIN').text, /walk-forward/);
  assert.ok(fake.calls.some(url => /granularity=3600/.test(url)));
});

test('liveReview demotes a strategy whose last 20 live trades average below -0.25R and promotes it when they recover', () => {
  const trades = (strategy, rs) => rs.map(r => ({ strategy, r }));
  assert.deepEqual(X.liveReview([], 'trend4h'), { trades: 0, window: 20, meanR: 0, wins: 0, demoted: false });
  const losing = trades('trend4h', Array(20).fill(-.5));
  assert.equal(X.liveReview(losing, 'trend4h').demoted, true);
  assert.equal(X.liveReview(losing.slice(0, 19), 'trend4h').demoted, false, 'a full window is required');
  assert.equal(X.liveReview(losing, 'breakout').trades, 0, 'per strategy');
  const recovered = trades('trend4h', Array(12).fill(1)).concat(losing);  // newest first
  const review = X.liveReview(recovered, 'trend4h');
  assert.equal(review.trades, 20);
  assert.equal(review.wins, 12);
  assert.equal(review.demoted, false);
  assert.ok(Math.abs(review.meanR - (12 - 4) / 20) < 1e-9);
});

test('the live watchdog demotes an open-gate strategy that keeps losing live: learning book, not the normal one', async () => {
  const open = { ...UNDECIDED, strategies: { test: { params: {}, gate: { open: true, trades: 60, meanR: .3, ci: [.1, .5] } } } };
  const d = setup({ priceOf: (s, t) => 100 + Math.sin(t / H), model: open });
  d.state.history = Array.from({ length: 20 }, () => ({ strategy: 'test', r: -1, risk: 25, pnl: -25, learning: false, openedAt: new Date(0).toISOString() }));
  await d.pilot.tick();
  const held = Object.values(d.state.positions)[0];
  assert.equal(held.book, 'learning');
  assert.match(d.state.log.find(l => l.kind === 'DEMOTE').text, /last 20 live trades average -1\.00R/);
  const status = statusOf(d.state, { now: 600 * H });
  assert.equal(status.model.strategies.test.demoted, true);
  assert.equal(status.model.strategies.test.learnable, true);
  assert.equal(status.model.strategies.test.live.trades, 20);
});

test('healthOf flags stale prices, a burst of errors and an old model', () => {
  const now = 100 * H;
  const at = ms => new Date(ms).toISOString();
  const healthy = { marks: { 'BTC-USD': { at: at(now - 60000) } }, log: [{ kind: 'ERROR', at: at(now - 2 * H) }], model: { trainedAt: now - 3 * H } };
  assert.deepEqual(healthOf(healthy, now), { staleMarks: [], errorsLastHour: 0, modelAgeHours: 3, ok: true });
  const sick = { marks: { 'BTC-USD': { at: at(now - 60000) }, 'SUI-USD': { at: at(now - 2 * H) } }, log: Array(30).fill({ kind: 'ERROR', at: at(now - 60000) }), model: { trainedAt: now - 50 * H } };
  const health = healthOf(sick, now);
  assert.deepEqual(health.staleMarks, ['SUI-USD']);
  assert.equal(health.errorsLastHour, 30);
  assert.equal(health.ok, false);
  assert.equal(healthOf({ marks: {}, log: [] }, now).ok, false, 'no model yet');
});

test('applyHaltReset: a NEW METYU_RESET_HALT value clears a kill-switch halt once; a value left in place never clears a later halt', () => {
  const logs = [];
  const say = (kind, text) => logs.push([kind, text]);
  const state = freshState();
  state.account.halted = true;
  state.account.peak = 10000;
  assert.equal(applyHaltReset(state, '', 8400, say), false, 'no value: stays halted');
  assert.equal(state.account.halted, true);
  assert.equal(applyHaltReset(state, '2026-11-13', 8400, say), true);
  assert.equal(state.account.halted, false);
  assert.equal(state.account.peak, 8400, 'the drawdown counts again from the current equity');
  assert.match(logs[0][1], /kill-switch cleared by the owner/);
  state.account.halted = true;                                         // a later halt
  assert.equal(applyHaltReset(state, '2026-11-13', 7000, say), false, 'the same value never clears it again');
  assert.equal(state.account.halted, true);
  const fresh = freshState();
  assert.equal(applyHaltReset(fresh, 'early', 10000, say), false, 'not halted: the value is only remembered');
  fresh.account.halted = true;
  assert.equal(applyHaltReset(fresh, 'early', 9000, say), false, 'a value set before the halt does not clear it');
});

test('the exchange autopilot restarts after a halt when the owner sets a new reset value', async () => {
  const fake = fakeExchange((s, t) => 100 + Math.sin(t / H));
  let clock = 600 * H + 7 * 60000;
  fake.now = () => clock;
  const state = freshState();
  state.model = UNDECIDED;
  state.account.halted = true;
  const halted = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols: ['AAA-USD'], learn: true, trainBars: 600, strategies: { test: ALWAYS_LONG } } });
  await halted.tick();
  assert.equal(Object.keys(state.positions).length, 0, 'halted: nothing opens');
  clock += H;
  const reset = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols: ['AAA-USD'], learn: true, trainBars: 600, strategies: { test: ALWAYS_LONG }, resetHalt: 'restart-1' } });
  await reset.tick();
  assert.equal(state.account.halted, false);
  assert.equal(state.log.some(l => l.kind === 'RESET'), true);
  assert.equal(Object.keys(state.positions).length, 1, 'trading again');
});

test('side risk counts the risk still open: a stop trailed to break-even no longer blocks new trades', () => {
  const account = { cash: 10000, halted: false, day: '1970-01-01', dayStartEquity: 10000 };
  const base = { account, symbol: 'AVAX-USD', side: 'SHORT', book: 'gated', now: 0, equity: 10000 };
  const short = (symbol, stop) => ({ symbol, side: 'SHORT', book: 'gated', entry: 50, stop, qty: 100 / 3.2, risk: 100, margin: 500 });
  const atEntry = { a: short('LTC-USD', 53.2), b: short('NEAR-USD', 53.2), c: short('SUI-USD', 53.2), d: short('DOT-USD', 53.2) };
  assert.match(X.admit({ ...base, positions: atEntry }).reasons.join(), /too much short risk/, '4 x 1R open: the 4% cap is full');
  const trailed = { a: short('LTC-USD', 50), b: short('NEAR-USD', 50), c: short('SUI-USD', 49) };
  assert.equal(X.admit({ ...base, positions: trailed }).ok, true, 'stops at or past entry: nothing left to lose, the 4th is allowed');
  assert.equal(X.openRisk(short('X', 50)), 0);
  close(X.openRisk(short('X', 51.6)), 50, 1e-9);
  assert.equal(X.openRisk(short('X', 60)), 100, 'never more than the risk at entry');
  assert.equal(X.openRisk({ risk: 42 }), 42, 'missing fields: the risk at entry');
});

test('two tiers: the satellite coins have their own model and gate, and trade the learning book until it opens', async () => {
  assert.equal(X.SYMBOLS.length, 31);
  assert.equal(X.SATELLITE.length, 15);
  assert.equal(X.tierOf('BTC-USD'), 'core');
  assert.equal(X.tierOf('PEPE-USD'), 'satellite');
  assert.equal(X.tierOf('AAA-USD'), 'core', 'unknown coins are core');
  assert.ok(X.SYMBOLS.every(symbol => X.KRAKEN_PAIRS[symbol]), 'every coin has a Kraken fallback');
  // The live review is per tier: satellite losses never demote the core strategy.
  const losses = Array.from({ length: 20 }, () => ({ strategy: 'test', tier: 'satellite', r: -1 }));
  assert.equal(X.liveReview(losses, 'test', X.RULES, 'satellite').demoted, true);
  assert.equal(X.liveReview(losses, 'test', X.RULES, 'core').trades, 0);
  // Core gate open, satellite gate undecided: a satellite signal goes to the learning book.
  const fake = fakeExchange((s, t) => 100 + Math.sin(t / H));
  const clock = 600 * H + 7 * 60000;
  fake.now = () => clock;
  const state = freshState();
  state.model = { trainedAt: 600 * H, symbols: ['AAA-USD', 'PEPE-USD'], strategies: { test: { params: {}, gate: { open: true, trades: 60, meanR: .3, ci: [.1, .5] } } },
    satellite: { symbols: ['PEPE-USD'], strategies: { test: { params: {}, gate: { open: false, trades: 40, meanR: .02, ci: [-.1, .15] } } } } };
  const pilot = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'PEPE-USD'], learn: true, trainBars: 600, strategies: { test: ALWAYS_LONG } } });
  await pilot.tick();
  const held = Object.values(state.positions);
  assert.equal(held.find(p => p.symbol === 'AAA-USD').book, 'gated');
  const sat = held.find(p => p.symbol === 'PEPE-USD');
  assert.equal(sat.book, 'learning');
  assert.equal(sat.tier, 'satellite');
  const status = statusOf(state, { now: clock });
  assert.equal(status.model.satellite.strategies.test.learnable, true);
  assert.equal(status.model.strategies.test.gate.open, true);
});

test('a model outdated by a release (new coins) retrains at once, even right after a successful training', async () => {
  const fake = fakeExchange((s, t) => 100 * (1 + .02 * Math.sin(t / H / 6)));
  const clock = 700 * H;
  fake.now = () => clock;
  const state = freshState();
  state.model = { trainedAt: clock - 10 * 60000, symbols: ['AAA-USD'], strategies: Object.fromEntries(Object.keys(X.STRATEGIES).map(name => [name, { params: X.STRATEGIES[name].grid[0], gate: { open: false, trades: 0, meanR: 0, ci: [0, 0] } }])) };
  state.lastTrainAttempt = state.model.trainedAt;                       // that training succeeded
  const pilot = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'CCC-USD'], learn: true, trainBars: 600 } });
  await pilot.tick();
  assert.equal(state.model.trainedAt, clock, 'retrained for the new coin');
  assert.deepEqual(state.model.symbols, ['AAA-USD', 'CCC-USD']);
  // A failed attempt since the last training still waits the retry interval.
  state.model.symbols = ['AAA-USD'];
  state.lastTrainAttempt = clock + 1;
  const before = state.trainings.length;
  await pilot.tick();
  assert.equal(state.trainings.length, before, 'no retry storm after a failure');
});

test('shadow orders: each normal-book entry is mirrored under the real-money limits and NEVER sent', () => {
  const state = freshState();
  const logs = [];
  const say = (kind, text) => logs.push([kind, text]);
  const fmt = v => v.toFixed(2);
  const at = Date.parse('2026-11-14T10:00:00Z');
  const pos = (id, side, entry = 100, stop = side === 'LONG' ? 95 : 105) => ({ id, symbol: `${id}-USD`, side, entry, initialStop: stop });
  const first = shadowOpen(state, pos('A', 'LONG'), at, say, fmt);
  assert.equal(first.usd, 25, '$25 per order');
  assert.equal(first.spotOk, true);
  assert.equal(shadowOpen(state, pos('B', 'SHORT'), at, say, fmt).spotOk, false, 'a short cannot be placed on spot');
  assert.match(logs[1][1], /spot: NOT executable/);
  shadowOpen(state, pos('C', 'LONG'), at, say, fmt);
  shadowOpen(state, pos('D', 'LONG'), at, say, fmt);
  assert.equal(shadowOpen(state, pos('E', 'LONG'), at, say, fmt), null, '$100 open in total');
  assert.match(logs.at(-1)[1], /open limit \(\$100\) full/);
  // Settled at the same exit: long A stopped at 95 loses ~5% of $25 plus fees, about -1R.
  const trade = shadowClose(state, 'A', 95, at + 3600000, 'stop loss', .001);
  close(trade.pnl, .25 * (95 - 100) - .001 * .25 * 195, 1e-9);
  assert.ok(trade.r < -1 && trade.r > -1.1);
  // The daily loss limit ($50) stops new mirrors for the rest of the UTC day.
  state.shadow.dayPnl = -50;
  assert.equal(shadowOpen(state, pos('F', 'LONG'), at + 7200000, say, fmt), null);
  assert.match(logs.at(-1)[1], /daily loss limit/);
  assert.notEqual(shadowOpen(state, pos('G', 'LONG'), Date.parse('2026-11-15T01:00:00Z'), say, fmt), null, 'a new day starts fresh');
  const summary = shadowSummary(state.shadow);
  assert.equal(summary.sent, 0, 'nothing is ever sent');
  assert.equal(summary.trades, 1);
  assert.equal(summary.orders, 5);
  assert.equal(summary.spotExecutable, 4);
});

test('the real-money lock counts normal-book trades only, and the autopilot mirrors gated entries as shadow orders', async () => {
  const learning = Array.from({ length: 40 }, (_, i) => ({ learning: true, strategy: 'x', risk: 25, r: .5, pnl: 12, openedAt: new Date(i * H).toISOString() }));
  const state = freshState();
  state.history = learning;
  state.createdAt = new Date(0).toISOString();
  const status = statusOf(state, { now: 10 * X.DAY });
  assert.equal(status.live.conditions.find(c => c.id === 'trades').ok, false, '40 learning trades do not count');
  assert.match(status.live.conditions.find(c => c.id === 'trades').text, /now 0; learning trades do not count/);
  assert.equal(status.shadow.sent, 0);
  const open = { ...UNDECIDED, strategies: { test: { params: {}, gate: { open: true, trades: 60, meanR: .3, ci: [.1, .5] } } } };
  const b = setup({ priceOf: (s, t) => 100 + Math.sin(t / H), model: open });
  await b.pilot.tick();
  const held = Object.values(b.state.positions)[0];
  assert.equal(held.book, 'gated');
  assert.equal(b.state.shadow.open[held.id].usd, 25);
  assert.ok(b.state.log.some(l => l.kind === 'SHADOW' && /\(not sent\) · spot: executable/.test(l.text)));
});

test('evidence-based leverage: the risk tier grows only with proof and falls back on its own', () => {
  const gate = (lower, open = true) => ({ open, trades: 150, meanR: lower + .15, ci: [lower, lower + .3] });
  const live = (trades, meanR, demoted = false) => ({ trades, meanR, demoted, wins: 0, window: 20 });
  assert.equal(X.leverageTier({ gate: gate(.2, false), live: live(30, 1) }).scale, 1, 'gate closed: base');
  assert.equal(X.leverageTier({ gate: gate(.02), live: live(30, 1) }).scale, 1, 'a weak lower bound: base');
  assert.equal(X.leverageTier({ gate: gate(.09), live: live(6, .68) }).scale, 1.5, 'today trend4h: +0.09R lower bound, 6 live trades at +0.68R');
  assert.equal(X.leverageTier({ gate: gate(.09), live: live(4, .68) }).scale, 1, 'too few live trades');
  assert.equal(X.leverageTier({ gate: gate(.09), live: live(6, -.1) }).scale, 1, 'losing live: back to base');
  const top = X.leverageTier({ gate: gate(.12), live: live(12, .3) });
  assert.equal(top.scale, 2);
  assert.match(top.reason, /lower bound \+0\.12R, live \+0\.30R over 12 trades/);
  assert.equal(X.leverageTier({ gate: gate(.12), live: live(12, .3), drawdown: .06 }).scale, 1, '5%+ below the peak: base');
  assert.equal(X.leverageTier({ gate: gate(.12), live: live(20, .3, true) }).scale, 1, 'demoted: base');
});

test('the autopilot opens a proven strategy at the higher risk tier and logs why', async () => {
  const open = { ...UNDECIDED, strategies: { test: { params: {}, gate: { open: true, trades: 150, meanR: .3, ci: [.12, .5] } } } };
  const b = setup({ priceOf: (s, t) => 100 + Math.sin(t / H), model: open });
  b.state.history = Array.from({ length: 12 }, () => ({ strategy: 'test', tier: 'core', r: .4, risk: 100, pnl: 40, learning: false, openedAt: new Date(0).toISOString() }));
  await b.pilot.tick();
  const held = Object.values(b.state.positions)[0];
  assert.equal(held.book, 'gated');
  assert.equal(held.riskScale, 2);
  assert.ok(held.risk > 150 && held.risk <= 2 * X.RULES.riskPct * 10000 + 1e-6, `risk ${held.risk}: up to 2%, less if the liquidation guard caps the size`);
  assert.equal(held.side, 'LONG');
  assert.ok(held.liquidation < held.stop, 'a long is liquidated only well below its stop');
  assert.match(b.state.log.find(l => l.kind === 'OPEN').text, /\(2x risk tier · proven: out-of-sample lower bound \+0\.12R/);
  assert.equal(b.state.shadow.open[held.id].usd, 25, 'real-money rehearsal stays at $25, no leverage');
  const status = statusOf(b.state, { now: 600 * H });
  assert.equal(status.model.strategies.test.leverage.scale, 2);
});

test('the evidence gate: weekly block bootstrap and a multiple-testing correction', () => {
  const W = 7 * X.DAY;
  // 120 trades, +0.15R on average, but all crowded into 3 weeks: never enough for the gate.
  const crowded = Array.from({ length: 120 }, (_, i) => ({ r: i % 2 ? 1.3 : -1, openedAt: (i % 3) * W + i * H }));
  const ev = X.evidenceOfTrades(crowded);
  assert.equal(ev.weeks, 3);
  assert.equal(ev.open, false, 'fewer than 12 weeks');
  // The same edge spread over 40 weeks, each week mixed: the gate can open.
  const spread = Array.from({ length: 400 }, (_, i) => ({ r: (i % 2 ? 1.3 : -1) + ((i * 37) % 11 - 5) / 20, openedAt: Math.floor(i / 10) * W + (i % 10) * H }));   // weeks differ a little
  const good = X.evidenceOfTrades(spread);
  assert.equal(good.weeks, 40);
  assert.ok(good.ci[0] > 0 && good.open);
  assert.ok(good.ci[0] < good.ci95[0] && good.ci[1] > good.ci95[1], 'the 8-test interval is wider than the plain 95% one');
  // Weekly blocks: when the weeks themselves disagree, the interval is wider than an i.i.d. one.
  const regime = Array.from({ length: 400 }, (_, i) => ({ r: Math.floor(i / 10) % 2 ? 1 : -.8, openedAt: Math.floor(i / 10) * W + (i % 10) * H }));
  const blocks = X.evidenceOfTrades(regime, { tests: 1 });
  const iid = X.evidence(regime.map(t => t.r));
  assert.ok(blocks.ci95[1] - blocks.ci95[0] > 2 * (iid.ci[1] - iid.ci[0]), 'one good or bad week counts once, not ten times');
  assert.equal(blocks.open, false, 'a regime coin-flip is not an edge');
  // learnable uses the plain weekly 95% interval: proven losers stay out of the learning book.
  assert.equal(learnable({ gate: { trades: 400, weeks: 40, ci: [-.3, .05], ci95: [-.25, -.02] } }), false);
  assert.equal(learnable({ gate: { trades: 400, weeks: 40, ci: [-.3, .2], ci95: [-.2, .1] } }), true);
  assert.equal(learnable({ gate: { trades: 400, weeks: 5, ci: [-.3, -.1], ci95: [-.25, -.1] } }), true, 'too few weeks: still undecided');
});

test('a model from the old evidence gate (no weekly blocks) is retrained at once', async () => {
  const fake = fakeExchange((s, t) => 100 * (1 + .02 * Math.sin(t / H / 6)));
  const clock = 700 * H;
  fake.now = () => clock;
  const state = freshState();
  const oldGate = { open: true, trades: 157, meanR: .24, ci: [.09, .41] };          // no `weeks`: the old gate
  state.model = { trainedAt: clock - 10 * 60000, symbols: ['AAA-USD', 'CCC-USD'], strategies: Object.fromEntries(Object.keys(X.STRATEGIES).map(name => [name, { params: X.STRATEGIES[name].grid[0], gate: oldGate }])) };
  state.lastTrainAttempt = state.model.trainedAt;
  const pilot = createExchangeAutopilot({ getJson: fake.getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'CCC-USD'], learn: true, trainBars: 600 } });
  await pilot.tick();
  assert.equal(state.model.trainedAt, clock, 'retrained');
  assert.ok(Object.values(state.model.strategies).every(s => Number.isInteger(s.gate.weeks)), 'the new gate counts weeks');
});

test('market direction: BTC 4h trend known only at bar close; the breakout trades only with it', () => {
  const up = walk(11, .003, .01, 1400);        // a rising Bitcoin
  const series = X.marketTrendSeries(up);
  assert.ok(series.length > X.WARMUP);
  // Before any 4-hour bar has closed there is no reading; after warm-up the reading is known at closeAt.
  assert.equal(X.marketTrendAt(series, up[0].t), null);
  const late = series[series.length - 1];
  assert.equal(X.marketTrendAt(series, late.closeAt), late.trend);
  assert.equal(X.marketTrendAt(series, late.closeAt - 1), series[series.length - 2].trend, 'a bar still forming is never used');
  assert.equal(late.trend, 'up');
  // The plain breakout and the market-aligned one on the same coin.
  const coin = walk(12, .001, .02, 1400);
  const plain = X.backtest(coin, 'breakout', { stopAtr: 2, targetAtr: 4 }, { symbol: 'AAA-USD' });
  const aligned = X.backtest(coin, 'breakoutBtc', { stopAtr: 2, targetAtr: 4 }, { symbol: 'AAA-USD', market: series });
  const none = X.backtest(coin, 'breakoutBtc', { stopAtr: 2, targetAtr: 4 }, { symbol: 'AAA-USD' });
  assert.equal(none.length, 0, 'no market data: the aligned strategy never trades');
  assert.ok(plain.length > 0);
  assert.ok(aligned.length <= plain.length);
  for (const trade of aligned) {
    assert.equal(X.marketTrendAt(series, trade.openedAt), trade.side === 'LONG' ? 'up' : 'down', 'only with the market');
  }
  assert.equal(X.RULES.familySize, Object.keys(X.STRATEGIES).length * 2, 'the gate corrects for every strategy in both tiers');
  assert.ok(Object.keys(X.STRATEGIES).indexOf('breakoutBtc') < Object.keys(X.STRATEGIES).indexOf('breakout'), 'tried before the plain breakout');
});
