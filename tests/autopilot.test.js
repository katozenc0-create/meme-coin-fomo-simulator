// Tests for the headless autopilot (autopilot.js) against a fake, controllable Polymarket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutopilot, freshState, loadState, saveState, parseArgs, makeFetchJson } = require('../autopilot.js');

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
  assert.deepEqual(parseArgs(['--state', 's.json', '--interval', '10', '--once']), { state: 's.json', interval: 30, api: null, model: null, bankroll: undefined, once: true });
  assert.throws(() => parseArgs(['--wallet', 'x']), /unknown option/);
  const seen = [];
  const fetchJson = makeFetchJson({ api: 'http://127.0.0.1:8000/', fetchImpl: async url => { seen.push(url); return { ok: true, status: 200, json: async () => ({}) }; } });
  return fetchJson(['/api/polymarket/markets?limit=1', 'https://gamma-api.polymarket.com/markets']).then(() => {
    assert.equal(seen[0], 'http://127.0.0.1:8000/api/polymarket/markets?limit=1', 'proxy URLs go to the local server');
  });
});
