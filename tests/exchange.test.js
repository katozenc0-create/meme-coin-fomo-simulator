// Tests for Metyu on a crypto exchange (virtual money): indicators, chart reading, sizing with
// leverage and liquidation, position replay, backtest/training, portfolio rules and the autopilot
// against a fake, controllable exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const X = require('../metyu-exchange.js');
const { createExchangeAutopilot, freshState, forwardEvidence, statusOf, loadState, saveState, parseArgs, learnable } = require('../exchange-autopilot.js');

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
    return { error: [], result: { XXBTZUSD: [[3600, 1, 2, .5, 1.5, 1, 3, 1]] } };
  };
  const fallback = await X.fetchCandles(failing, 'BTC-USD', { now });
  assert.equal(fallback.source, 'kraken');
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
  assert.deepEqual(Object.keys(model.strategies), ['trend', 'breakout', 'reversion']);
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
  assert.equal(ok.maxLeverage, 3);
  assert.equal(X.admit({ ...base, book: 'learning' }).riskAmount, 25);
  assert.equal(X.admit({ ...base, book: 'learning' }).maxLeverage, 2);
  const held = (symbol, side = 'LONG', risk = 100, margin = 1000) => ({ symbol, side, risk, margin });
  assert.match(X.admit({ ...base, account: { ...account, halted: true } }).reasons.join(), /kill-switch/);
  assert.match(X.admit({ ...base, positions: { a: held('BTC-USD') } }).reasons.join(), /already a position on this coin/);
  assert.match(X.admit({ ...base, positions: { a: held('A', 'SHORT', 1), b: held('B', 'SHORT', 1), c: held('C', 'SHORT', 1), d: held('D', 'SHORT', 1) } }).reasons.join(), /4 open positions/);
  // The learning book's tiny trades may fill all 8 coins; the normal book keeps its limit of 4.
  const four = { a: held('A', 'SHORT', 1, 100), b: held('B', 'SHORT', 1, 100), c: held('C', 'SHORT', 1, 100), d: held('D', 'SHORT', 1, 100) };
  assert.equal(X.admit({ ...base, book: 'learning', positions: four }).ok, true, 'a 5th learning position is allowed');
  const eight = { ...four, e: held('E', 'SHORT', 1, 100), f: held('F', 'SHORT', 1, 100), g: held('G', 'SHORT', 1, 100), h: held('H', 'SHORT', 1, 100) };
  assert.match(X.admit({ ...base, book: 'learning', positions: eight }).reasons.join(), /8 open positions \(max 8\)/);
  assert.equal(X.RULES.learnMaxOpen, 8);
  assert.match(X.admit({ ...base, positions: { a: held('ETH-USD', 'LONG', 150), b: held('SOL-USD', 'LONG', 100) } }).reasons.join(), /too much long risk/);
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
  assert.match(state.log.find(l => l.kind === 'TRAIN').text, /walk-forward on \d+ hourly bars of 2 coins/);
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
  assert.equal(forward.convincing, forward.ci[0] > 0);
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
    { state: 'x.json', 'status-out': null, interval: 900, bankroll: undefined, once: true, learn: true, 'train-bars': 6000, retrain: 24, symbols: ['BTC-USD', 'ETH-USD'], 'account-public': null, pause: false });
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
