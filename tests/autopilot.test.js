// Tests for the headless autopilot (autopilot.js) against a fake, controllable Polymarket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutopilot, freshState, loadState, saveState, parseArgs, makeFetchJson, forwardEvidence, statusOf } = require('../autopilot.js');

const DAY = 86400000;
// A deliberately optimistic calibration model whose evidence gate is open (trades when allowed).
const OPEN_MODEL = { kind: 'calib', a: 1.2, b: 1, cov: [[.0005, 0], [0, .0005]], gate: { open: true, meanReturn: .1, ci: [.02, .2] } };

function fakePolymarket({ now }) {
  const markets = new Map();
  const add = (id, question, price, extra = {}) => markets.set(id, {
    id, question, outcomes: '["Yes","No"]', price, bestBid: String(price - .005), bestAsk: String(price + .005),
    endDate: new Date(now() + 40 * DAY).toISOString(), eventId: `e${id}`, clobTokenIds: JSON.stringify([`${id}1`, `${id}2`]), ...extra
  });
  const raw = market => ({ ...market, outcomePrices: JSON.stringify([String(market.price), String(1 - market.price)]) });
  const fetchJson = async urls => {
    const url = new URL(urls[0], 'http://local');
    if (url.pathname === '/api/polymarket/markets') return { markets: [...markets.values()].filter(m => !m.closed).map(raw) };
    if (url.pathname === '/api/polymarket/market') return { market: raw(markets.get(url.searchParams.get('id'))) };
    if (url.pathname === '/api/polymarket/book') {
      const id = url.searchParams.get('token_id').slice(0, -1);
      return { book: { asks: [{ price: markets.get(id).price + .005, size: 1e6 }], bids: [] } };
    }
    if (url.pathname === '/api/polymarket/history') {
      const id = url.searchParams.get('token_id').slice(0, -1);
      return { history: Array.from({ length: 40 }, (_, i) => ({ t: now() / 1000 - (39 - i) * 43200, p: markets.get(id).price })) };
    }
    throw new Error(`unexpected ${urls[0]}`);
  };
  return { markets, add, fetchJson };
}

function setup({ model = OPEN_MODEL, questions } = {}) {
  let clock = 1.9e12;
  const now = () => clock;
  const fake = fakePolymarket({ now });
  (questions || ['Will the Senate pass the bill?', 'Lakers vs Celtics', 'Will it snow in Paris?']).forEach((q, i) => fake.add(String(100 + i), q, .30));
  const state = freshState({ bankroll: 10000 });
  state.model = model;
  const pilot = createAutopilot({ fetchJson: fake.fetchJson, now, state });
  return { pilot, state, fake, advance: ms => { clock += ms; } };
}

test('without a model (or with a closed gate) the autopilot only watches', async () => {
  for (const model of [null, { ...OPEN_MODEL, gate: { open: false } }]) {
    const { pilot, state } = setup({ model });
    const result = await pilot.tick();
    assert.equal(result.mayOpen, false);
    assert.equal(result.refreshed, 3);
    assert.equal(Object.keys(state.positions).length, 0);
    assert.equal(state.account.cash, 10000);
  }
});

test('with an open gate it trades, within the per-category limit, and survives a restart', async () => {
  const crypto = ['Will Bitcoin be above 100k?', 'Will Bitcoin be above 110k?', 'Will Bitcoin be above 120k?', 'Will Bitcoin be above 130k?'];
  const { pilot, state, fake } = setup({ questions: crypto });
  await pilot.tick();
  const open = Object.values(state.positions);
  assert.equal(open.length, 2, 'four Bitcoin markets, at most two positions');
  assert.ok(open.every(held => held.cluster === 'crypto' && held.position.side === 'YES'));
  assert.ok(state.account.cash < 10000);
  assert.match(state.log.map(entry => entry.kind).join(' '), /OPEN/);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-')), 'state.json');
  saveState(file, state);
  const restored = loadState(file);
  assert.deepEqual(Object.keys(restored.positions), Object.keys(state.positions), 'positions survive a restart');
  const again = createAutopilot({ fetchJson: fake.fetchJson, state: restored });
  await again.tick();
  assert.equal(Object.keys(restored.positions).length, 2, 'no duplicate positions after the restart');
});

test('resolution settles at $1/$0; a price past the belief closes the position', async () => {
  const { pilot, state, fake } = setup();
  await pilot.tick();
  const ids = Object.keys(state.positions);
  assert.ok(ids.length >= 2, `opened ${ids.length}`);
  const [won, sold] = ids;
  const cashBefore = state.account.cash;
  Object.assign(fake.markets.get(won), { closed: true, price: 1 });
  fake.markets.get(sold).price = .80;                        // far above what Metyu believed at entry (~59%)
  state.model = { ...state.model, gate: { open: false } };   // the model lost its gate: manage with the entry belief
  await pilot.tick();
  assert.ok(!state.positions[won] && !state.positions[sold]);
  const settled = state.history.find(trade => trade.outcome === 'YES');
  assert.ok(settled && settled.pnl > 0, 'the YES position won at resolution');
  const closed = state.history.find(trade => trade.outcome === 'CLOSED');
  assert.ok(closed && /edge gone/.test(closed.reason), closed && closed.reason);
  assert.ok(state.account.cash > cashBefore);
  assert.ok(!state.watch.some(market => market.id === won), 'a resolved market leaves the watchlist');
});

test('a deep drawdown trips the kill-switch: everything is flattened and nothing new opens', async () => {
  const { pilot, state, fake } = setup();
  await pilot.tick();
  assert.ok(Object.keys(state.positions).length > 0);
  state.account.peak = state.account.bankroll * 2;           // as if equity had doubled before a crash
  await pilot.tick();
  assert.equal(state.account.halted, true);
  assert.equal(Object.keys(state.positions).length, 0, 'flattened');
  assert.match(state.log.map(entry => entry.text).join(' '), /kill-switch/);
  fake.add('200', 'Will the House pass the bill?', .30);
  const result = await pilot.tick();
  assert.equal(result.mayOpen, false, 'halted: no new trades');
});

test('command line and data access', () => {
  assert.deepEqual(parseArgs(['--state', 's.json', '--interval', '10', '--once']), { state: 's.json', interval: 30, api: null, model: null, bankroll: undefined, once: true, train: 0, retrain: 24, learn: false, 'status-out': null });
  const both = parseArgs(['--learn', '--status-out', 'public/status.json']);
  assert.equal(both.learn, true);
  assert.equal(both['status-out'], 'public/status.json');
  assert.equal(parseArgs(['--train', '99999', '--retrain', '0']).train, 6000, 'training size is capped');
  assert.equal(parseArgs(['--train', '1500', '--retrain', '0']).retrain, 24);
  assert.throws(() => parseArgs(['--wallet', 'x']), /unknown option/);
  const seen = [];
  const fetchJson = makeFetchJson({ api: 'http://127.0.0.1:8000/', fetchImpl: async url => { seen.push(url); return { ok: true, status: 200, json: async () => ({}) }; } });
  return fetchJson(['/api/polymarket/markets?limit=1', 'https://gamma-api.polymarket.com/markets']).then(() => {
    assert.equal(seen[0], 'http://127.0.0.1:8000/api/polymarket/markets?limit=1', 'proxy URLs go to the local server');
  });
});

// Resolved markets for self-training, served like the proxy's /resolved windows, from the simulator.
function withResolved(fake, { count, bias, seed = 7 }) {
  const M = require('../metyu-agent.js');
  const sim = M.simulatedResolvedMarkets(count, { seed, longshotBias: bias });
  const rows = sim.map((market, index) => ({
    raw: { id: String(5000 + index), eventId: `r${index}`, question: market.question, closed: true, outcomes: '["Yes","No"]',
      outcomePrices: market.outcome === 'YES' ? '["1","0"]' : '["0","1"]', clobTokenIds: JSON.stringify([String(700000 + index), String(800000 + index)]),
      closedTime: new Date(market.endTs * 1000).toISOString() },
    history: market.history
  }));
  const histories = Object.fromEntries(rows.map((row, index) => [String(700000 + index), row.history]));
  let windows = 0;
  const base = fake.fetchJson;
  return async urls => {
    const url = new URL(urls[0], 'http://local');
    if (url.pathname === '/api/polymarket/resolved') { const start = (100 * windows++) % rows.length; return { markets: rows.slice(start, start + 100).map(row => row.raw) }; }
    if (url.pathname === '/api/polymarket/history' && histories[url.searchParams.get('token_id')]) return { history: histories[url.searchParams.get('token_id')] };
    return base(urls);
  };
}

test('self-training: a calibrated crowd keeps the gate closed; retrains only when due', async () => {
  let clock = 1.9e12;
  const fake = fakePolymarket({ now: () => clock });
  fake.add('100', 'Will the Senate pass the bill?', .30);
  const state = freshState();
  const pilot = createAutopilot({ fetchJson: withResolved(fake, { count: 300, bias: 0 }), now: () => clock, state, options: { train: 300, retrainHours: 24 } });
  const first = await pilot.tick();
  assert.ok(state.model && /autopilot · \d+ resolved markets/.test(state.model.source), 'trained its own model');
  assert.equal(state.model.gate.open, false, 'no edge in a calibrated crowd');
  assert.equal(first.mayOpen, false);
  assert.equal(state.trainings.length, 1);
  assert.match(state.log.map(entry => entry.text).join(' '), /retrained on \d+ resolved markets · evidence gate closed/);
  clock += 3600000;
  await pilot.tick();
  assert.equal(state.trainings.length, 1, 'not retrained within 24 h');
  clock += 24 * 3600000;
  await pilot.tick();
  assert.equal(state.trainings.length, 2, 'retrained once the model is a day old');
});

test('self-training: when the gate opens on real evidence, the autopilot may trade', async () => {
  const clock = 1.9e12;
  const fake = fakePolymarket({ now: () => clock });
  fake.add('100', 'Will the Senate pass the bill?', .08);
  const state = freshState();
  const pilot = createAutopilot({ fetchJson: withResolved(fake, { count: 700, bias: .5, seed: 3 }), now: () => clock, state, options: { train: 700 } });
  const result = await pilot.tick();
  assert.equal(state.model.gate.open, true, `strong longshot bias: gate ${JSON.stringify(state.model.gate)}`);
  assert.equal(result.mayOpen, true);
});

test('self-training failures are logged and retried after an hour, not every tick', async () => {
  let clock = 1.9e12;
  const fake = fakePolymarket({ now: () => clock });
  fake.add('100', 'Will the Senate pass the bill?', .30);
  let calls = 0;
  const failing = async urls => { if (urls[0].startsWith('/api/polymarket/resolved')) { calls += 1; throw new Error('upstream down'); } return fake.fetchJson(urls); };
  const state = freshState();
  const pilot = createAutopilot({ fetchJson: failing, now: () => clock, state, options: { train: 300 } });
  await pilot.tick();
  assert.match(state.log.map(entry => entry.text).join(' '), /training failed: upstream down/);
  const after = calls;
  clock += 5 * 60000;
  await pilot.tick();
  assert.equal(calls, after, 'not retried 5 minutes later');
  clock += 3600000;
  await pilot.tick();
  assert.ok(calls > after, 'retried after an hour');
  assert.equal(state.model, null);
});

// A model whose evidence gate is CLOSED but which still sees an edge (it reads 30c as ~59%).
const CLOSED_MODEL = { ...OPEN_MODEL, gate: { open: false, meanReturn: 0, ci: [-.1, .1], trades: 0 } };

test('learning book: with the gate closed, --learn opens small unlevered tagged positions; without it nothing opens', async () => {
  const off = setup({ model: CLOSED_MODEL });
  const watchOnly = await off.pilot.tick();
  assert.equal(watchOnly.mayOpen, false);
  assert.equal(Object.keys(off.state.positions).length, 0, 'gate closed and no learning: watch only');

  let clock = 1.9e12;
  const fake = fakePolymarket({ now: () => clock });
  ['Will the Senate pass the bill?', 'Lakers vs Celtics', 'Will it snow in Paris?'].forEach((q, i) => fake.add(String(100 + i), q, .30));
  const state = freshState({ bankroll: 10000 });
  state.model = CLOSED_MODEL;
  const pilot = createAutopilot({ fetchJson: fake.fetchJson, now: () => clock, state, options: { learn: true } });
  const result = await pilot.tick();
  assert.equal(result.learning, true);
  const open = Object.values(state.positions);
  assert.ok(open.length >= 1, 'learning trades open');
  for (const held of open) {
    assert.equal(held.learning, true, 'tagged as learning');
    assert.equal(held.position.leverage, 1, 'never levered');
    assert.ok(held.position.margin <= 100.0001, `1% of equity at most (${held.position.margin})`);
  }
  assert.match(state.log.map(entry => entry.kind).join(' '), /LEARN/);
  // Resolution closes it; the history keeps the tag; forward evidence counts it.
  const id = Object.keys(state.positions)[0];
  Object.assign(fake.markets.get(id), { closed: true, price: 1 });
  await pilot.tick();
  const closed = state.history.find(trade => trade.outcome === 'YES');
  assert.equal(closed.learning, true);
  const evidence = forwardEvidence(state.history, { learning: true, now: clock });
  assert.equal(evidence.trades, state.history.filter(trade => trade.learning).length);
  assert.ok(evidence.pnl > 0);
  assert.equal(evidence.convincing, false, 'one trade proves nothing');
});

test('forward evidence and public status', () => {
  const now = Date.parse('2026-11-26T00:00:00Z');
  const history = Array.from({ length: 40 }, (_, i) => ({ openedAt: '2026-11-12T00:00:00Z', closedAt: '2026-11-13T00:00:00Z', margin: 100, pnl: i % 4 === 0 ? -50 : 40, learning: true }));
  const evidence = forwardEvidence(history, { learning: true, now });
  assert.equal(evidence.trades, 40);
  assert.equal(evidence.wins, 30);
  assert.ok(Math.abs(evidence.meanReturn - .175) < 1e-9);
  assert.ok(evidence.ci[0] > 0 && evidence.convincing, 'a consistent forward edge clears the bar');
  assert.ok(Math.abs(evidence.days - 14) < 1e-9, 'two weeks of record');
  assert.equal(forwardEvidence(history, { learning: false, now }).trades, 0, 'learning and gated books are separate');

  const state = freshState();
  state.model = { ...CLOSED_MODEL, source: 'autopilot · 400 resolved markets', trainedAt: now };
  state.history = history;
  const status = statusOf(state, { now });
  assert.equal(status.available, true);
  assert.deepEqual(Object.keys(status.model).sort(), ['gate', 'kind', 'source', 'trainedAt'], 'no model parameters in public');
  assert.equal(status.forward.learning.trades, 40);
  assert.equal(status.history.length, 40);
});
