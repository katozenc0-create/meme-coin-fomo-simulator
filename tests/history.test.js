const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../metyu-exchange.js');
const History = require('../metyu-history.js');
const { createExchangeAutopilot, freshState, statusOf } = require('../exchange-autopilot.js');

const H = X.HOUR;
/** A seeded random walk with drift, hourly bars starting at `start` (ms). */
function walk(seed, drift, vol, n, start) {
  const rng = X.createRng(seed);
  let p = 100;
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    const path = [p];
    for (let k = 0; k < 4; k += 1) { p *= Math.exp(drift / 4 + vol / 2 * (rng() + rng() + rng() - 1.5)); path.push(p); }
    bars.push({ t: start + i * H, o: path[0], h: Math.max(...path), l: Math.min(...path), c: p, v: 100 + 50 * rng() });
  }
  return bars;
}
const PARAMS = { trend: { params: { stopAtr: 2, targetAtr: 3 } }, breakout: { params: { stopAtr: 2, targetAtr: 4 } }, reversion: { params: { stopAtr: 2, rsiEdge: 25 } }, trend4h: { params: { stopAtr: 2, targetAtr: 4 } } };

test('history: the episode catalogue is dated, typed and before the 2-year training window', () => {
  const ids = new Set();
  for (const episode of History.EPISODES) {
    assert.ok(!ids.has(episode.id), `unique id ${episode.id}`); ids.add(episode.id);
    assert.ok(History.KINDS.includes(episode.kind), episode.kind);
    assert.ok(Date.parse(episode.from) < Date.parse(episode.to), episode.id);
    assert.ok(Date.parse(episode.to) < Date.parse('2024-11-01'), 'every episode is out of sample for a model trained on the last ~2 years');
    assert.ok(episode.note.length > 20 && episode.name.length > 3);
  }
  for (const kind of History.KINDS) assert.ok(History.EPISODES.some(e => e.kind === kind), `at least one ${kind} episode`);
  assert.ok(History.EPISODES.length >= 12);
});

test('history: stress test counts only trades opened inside each episode, by kind', () => {
  const crash = { id: 'c', name: 'Test crash', from: '2021-01-20', to: '2021-02-05', kind: 'crash', note: 'a synthetic falling market for the test' };
  const bull = { id: 'b', name: 'Test bull', from: '2021-01-20', to: '2021-02-05', kind: 'bull', note: 'a synthetic rising market for the test' };
  const short = { id: 's', name: 'Too short', from: '2020-12-15', to: '2020-12-25', kind: 'range', note: 'not enough warm-up bars: skipped' };
  const start = Date.parse('2020-12-11');
  const n = 60 * 24;
  const candles = {
    c: { 'AAA-USD': walk(1, -.004, .02, n, start), 'BBB-USD': walk(2, -.004, .02, n, start) },
    b: { 'AAA-USD': walk(3, .0008, .02, n, start) },
    s: { 'AAA-USD': walk(4, 0, .02, 23 * 24 + 100, start).slice(0, 23 * 24 + 100) }
  };
  const result = History.stressTest(candles, PARAMS, { episodes: [crash, bull, short], now: Date.parse('2026-11-25') });
  assert.equal(result.episodes.length, 3);
  const [c, b, s] = result.episodes;
  assert.deepEqual(c.coins, ['AAA-USD', 'BBB-USD']);
  assert.deepEqual(s.coins, [], 'an episode without enough warm-up is skipped, never guessed');
  assert.deepEqual(s.strategies, {});
  // Recompute one strategy by hand: only trades opened on or after the episode start.
  const bars = candles.c['AAA-USD'];
  const from = bars.findIndex(bar => bar.t >= Date.parse(crash.from));
  const all = X.backtest(bars, 'trend', PARAMS.trend.params, { symbol: 'AAA-USD' });
  const inside = all.filter(trade => trade.openedAt >= Date.parse(crash.from));
  const mine = X.backtest(bars, 'trend', PARAMS.trend.params, { from, symbol: 'AAA-USD' });
  assert.ok(mine.every(trade => trade.openedAt >= Date.parse(crash.from)));
  assert.ok(inside.length >= mine.length - 1);
  assert.ok(c.strategies.trend.trades > 0, 'the trend strategy traded the falling market');
  assert.ok(c.strategies.trend.shorts / c.strategies.trend.trades > .5, 'mostly short in a falling market');
  assert.ok(b.strategies.trend.trades > 0);
  // By kind: the crash bucket is the crash episode's trades.
  assert.equal(result.kinds.crash.trend.trades, c.strategies.trend.trades);
  assert.equal(result.kinds.bull.trend.trades, b.strategies.trend.trades);
  assert.equal(result.kinds.range, undefined, 'no trades: no bucket');
  for (const v of Object.values(result.verdicts)) for (const kind of [...v.earnsIn, ...v.losesIn]) assert.ok(History.KINDS.includes(kind));
  assert.equal(result.at, '2026-11-25T00:00:00.000Z');
});

test('history: fetchRange pages Coinbase 300 bars at a time inside the range', async () => {
  const urls = [];
  const getJson = async url => {
    urls.push(url);
    const u = new URL(url);
    const s = Date.parse(u.searchParams.get('start'));
    const e = Date.parse(u.searchParams.get('end'));
    const rows = [];
    for (let t = s; t < e; t += H) rows.push([t / 1000, 1, 2, 1.5, 1.5, 10]);
    return rows.reverse();
  };
  const from = Date.parse('2020-03-01');
  const to = from + 700 * H;
  const bars = await History.fetchRange(getJson, 'BTC-USD', from, to);
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => url.startsWith('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=')));
  assert.equal(bars.length, 700);
  assert.equal(bars[0].t, from);
  await assert.rejects(() => History.fetchRange(async () => ({ message: 'NotFound' }), 'BTC-USD', from, to), /NotFound/);
});

test('history: the agent runs the stress test only when asked, weekly, never in a training tick', async () => {
  const now0 = Date.parse('2026-11-25T10:07:00Z');
  let clock = now0;
  const historyCalls = [];
  const getJson = async url => {
    const u = new URL(url);
    const s = Date.parse(u.searchParams.get('start'));
    const e = Date.parse(u.searchParams.get('end'));
    if (s < Date.parse('2025-01-01')) historyCalls.push(url);
    const rows = [];
    const rng = X.createRng(Math.floor(s / H) % 9973);
    let p = 100 + (s / H) % 50;
    for (let t = Math.floor(s / H) * H; t < e && t + H <= clock; t += H) { const o = p; p *= Math.exp(.02 * (rng() - .5)); rows.push([t / 1000, Math.min(o, p) * .995, Math.max(o, p) * 1.005, o, p, 100]); }
    return rows.reverse();
  };
  const state = freshState();
  const off = createExchangeAutopilot({ getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'BBB-USD'], trainBars: 1200 } });
  await off.tick();
  assert.ok(state.model, 'trained');
  assert.equal(historyCalls.length, 0, 'off by default (stressDays 0)');
  const on = createExchangeAutopilot({ getJson, now: () => clock, state, options: { symbols: ['AAA-USD', 'BBB-USD'], trainBars: 1200, stressDays: 7 } });
  clock += 15 * 60000;
  await on.tick();
  assert.ok(historyCalls.length > 0, 'history fetched');
  assert.ok(state.stress && state.stress.episodes.length === History.EPISODES.length);
  assert.match(state.log.find(e => e.kind === 'STRESS').text, /history test: 13 past episodes \(2018-2024\) on 5 coins/);
  const status = statusOf(state, { now: clock });
  assert.ok(status.stress.kinds && status.stress.verdicts && !('paramsKey' in status.stress));
  // Not again within the week.
  const before = historyCalls.length;
  clock += 15 * 60000;
  await on.tick();
  assert.equal(historyCalls.length, before);
  // A week later it runs again (unless that tick trains: one heavy job per tick).
  clock += 7 * X.DAY;
  state.model.trainedAt = clock;               // pretend a fresh model with the same parameters
  await on.tick();
  assert.ok(historyCalls.length > before);
});
