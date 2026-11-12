#!/usr/bin/env node
// Metyu autopilot: trades live Polymarket markets with VIRTUAL money, around the clock, without a
// browser. Read-only market data; no wallet, no keys, no orders. It applies exactly the rules of the
// Live Board and the live advisor (metyu-agent.js): only an open evidence gate may open positions;
// fees, order-book fills, gap guard, portfolio / category limits, kill-switch, position management
// and settlement at resolution. State is a JSON file, so a restart continues where it left off.
//
//   node autopilot.js [--model model.json] [--train 1500 --retrain 24] [--state data/autopilot.json]
//                     [--interval 300] [--api http://127.0.0.1:8000] [--bankroll 10000] [--once]
// --train N retrains on N resolved markets every --retrain hours with the Prediction Lab's own
// pipeline (walk-forward + evidence gate); the gate alone decides whether the model may trade.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const M = require('./metyu-agent.js');

const DAY = 86400000;
// Real markets: no simulator-calibrated momentum/fade; a model estimate is never "stale".
const LIVE_RULES = Object.freeze({ momentumWeight: 0, fadeWeight: 0, stalenessWeight: 0 });
const DEFAULTS = Object.freeze({
  bankroll: 10000, slots: 12, maxGross: 1.5, maxOpen: 6, maxPerCluster: 2, maxLeverage: 3,
  maxPositionPct: .1, refreshMarketsMs: 3600000, historyLimit: 1000, logLimit: 300,
  train: 0, retrainHours: 24, trainKind: 'calib', trainSpread: .02, tradeHorizon: 7, trainRetryMs: 3600000
});

function freshState(options = {}) {
  const bankroll = options.bankroll || DEFAULTS.bankroll;
  return {
    version: 1, createdAt: null, lastTick: null, lastMarketsRefresh: 0,
    account: { bankroll, cash: bankroll, peak: bankroll, halted: false, realized: 0, trades: 0, wins: 0 },
    watch: [], positions: {}, history: [], log: [], model: null, trainings: [], lastTrainAttempt: 0
  };
}

/** Data access for Node: '/api/...' proxy URLs go to `api` (the local server) or are skipped. */
function makeFetchJson({ api = null, fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
  const client = M.createDataClient(fetchImpl);
  return urls => client.fetchJson(urls.map(url => (url.startsWith('/api/') ? (api ? `${api.replace(/\/$/, '')}${url}` : null) : url)).filter(Boolean));
}

function createAutopilot({ fetchJson, now = () => Date.now(), state = freshState(), options = {} }) {
  const opts = { ...DEFAULTS, ...options };
  const config = { maxLeverage: opts.maxLeverage, maxPositionPct: opts.maxPositionPct, ...LIVE_RULES, ...(options.config || {}) };
  const tracker = M.createMomentumTracker(fetchJson, { now });
  const say = (kind, text) => {
    state.log.unshift({ at: new Date(now()).toISOString(), kind, text });
    state.log.length = Math.min(state.log.length, opts.logLimit);
  };

  const getMarket = id => fetchJson([`/api/polymarket/market?id=${encodeURIComponent(id)}`, `https://gamma-api.polymarket.com/markets/${encodeURIComponent(id)}`]).then(data => data.market || data);
  const getBook = tokenId => fetchJson([`/api/polymarket/book?token_id=${encodeURIComponent(tokenId)}`, `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`]).then(data => data.book || data);

  async function refreshWatchlist() {
    const data = await fetchJson(['/api/polymarket/markets?limit=40', 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=40&order=volume24hr&ascending=false']);
    const rows = Array.isArray(data) ? data : data.markets || [];
    const seen = new Set();
    const fresh = rows.map(M.parseGammaMarket).filter(Boolean)
      .filter(market => market.yesPrice > .03 && market.yesPrice < .97)
      .filter(market => { if (seen.has(market.eventId)) return false; seen.add(market.eventId); return true; })   // one market per event
      .slice(0, opts.slots);
    // Markets with an open position always stay watched.
    const held = state.watch.filter(market => state.positions[market.id]);
    const ids = new Set(held.map(market => market.id));
    state.watch = [...held, ...fresh.filter(market => !ids.has(market.id))];
    state.lastMarketsRefresh = now();
    say('INFO', `watching ${state.watch.length} markets`);
  }

  const daysLeftOf = market => (Number.isFinite(Date.parse(market.endDate)) ? Math.max(0, (Date.parse(market.endDate) - now()) / DAY) : 30);
  const markOf = held => Math.max(0, M.markPosition(held.position, held.lastYes, { spread: held.spread }).equity);
  const equity = () => state.account.cash + Object.values(state.positions).reduce((sum, held) => sum + markOf(held), 0);

  function close(id, payout, reason, outcome = 'CLOSED') {
    const held = state.positions[id];
    if (!held) return;
    const pnl = payout - held.position.margin;
    state.account.cash += payout;
    state.account.realized += pnl;
    state.account.trades += 1;
    if (pnl > 0) state.account.wins += 1;
    state.history.unshift({ openedAt: held.openedAt, closedAt: new Date(now()).toISOString(), market: held.question, side: held.position.side, leverage: held.position.leverage, entry: held.position.entry, exitYes: held.lastYes, outcome, margin: held.position.margin, pnl, reason });
    state.history.length = Math.min(state.history.length, opts.historyLimit);
    delete state.positions[id];
    say(outcome === 'CLOSED' ? 'CLOSE' : 'SETTLE', `${held.question} — ${held.position.side} ${outcome === 'CLOSED' ? 'closed' : `resolved ${outcome}`} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} · ${reason}`);
  }

  function prediction(market, mom) {
    const model = state.model;
    return M.predictModel(model, { p: market.yesPrice, horizon: Math.max(1, daysLeftOf(market)), mom, neg: market.negRisk ? 1 : 0, cat: M.marketCategory(`${market.question} ${market.slug || ''}`) });
  }

  // Self-training: the Prediction Lab's pipeline on fresh resolved markets, every retrainHours.
  async function retrainIfDue(started) {
    if (!(opts.train > 0)) return;
    const model = state.model;
    const age = model && Number.isFinite(model.trainedAt) ? started - model.trainedAt : Infinity;
    if (age < opts.retrainHours * 3600000) return;
    if (started - (state.lastTrainAttempt || 0) < opts.trainRetryMs) return;   // a failed attempt waits
    state.lastTrainAttempt = started;
    try {
      const markets = await M.loadResolvedMarkets(fetchJson, { count: opts.train, now: started });
      if (markets.length < 20) throw new Error(`only ${markets.length} resolved markets with price history`);
      const { model: trained } = M.trainModel(markets, { kind: opts.trainKind, tradeHorizon: opts.tradeHorizon, spread: opts.trainSpread, config, source: `autopilot · ${markets.length} resolved markets`, now: started });
      state.model = trained;
      const gate = trained.gate;
      state.trainings.unshift({ at: new Date(started).toISOString(), markets: markets.length, open: gate.open, robust: gate.robust, meanReturn: gate.meanReturn, ci: gate.ci, trades: gate.trades });
      state.trainings.length = Math.min(state.trainings.length, 60);
      say('TRAIN', `retrained on ${markets.length} resolved markets · evidence gate ${gate.open ? 'OPEN' : 'closed'} · ${gate.trades} out-of-sample trades, mean ${(gate.meanReturn * 100).toFixed(1)}% [${(gate.ci[0] * 100).toFixed(1)}%, ${(gate.ci[1] * 100).toFixed(1)}%]`);
    } catch (error) {
      say('ERROR', `training failed: ${error.message} (retry in ${Math.round(opts.trainRetryMs / 60000)} min)`);
    }
  }

  async function tick() {
    const started = now();
    if (!state.createdAt) state.createdAt = new Date(started).toISOString();
    await retrainIfDue(started);
    if (!state.watch.length || started - state.lastMarketsRefresh > opts.refreshMarketsMs) {
      try { await refreshWatchlist(); } catch (error) { say('ERROR', `market list unavailable: ${error.message}`); }
    }
    const mayOpen = M.modelMayTrade(state.model) && M.isValidSavedModel(state.model) && !state.account.halted;
    let refreshed = 0;
    for (const market of state.watch.slice()) {
      let raw;
      try { raw = await getMarket(market.id); } catch (error) { say('ERROR', `${market.question}: ${error.message}`); continue; }
      const resolution = M.parseGammaResolution(raw);
      if (resolution) {
        if (!resolution.outcome) continue;                                  // closed, resolution pending
        const held = state.positions[market.id];
        if (held) close(market.id, M.settlePosition(held.position, resolution.outcome).payout, 'market resolved', resolution.outcome);
        state.watch = state.watch.filter(item => item.id !== market.id);
        continue;
      }
      const fresh = M.parseGammaMarket(raw);
      if (!fresh) continue;
      Object.assign(market, fresh);
      refreshed += 1;
      const held = state.positions[market.id];
      // Raw spread: the position carries its taker rate, which markPosition deducts itself.
      if (held) { held.lastYes = fresh.yesPrice; held.spread = fresh.spread; }
    }

    // Account: interest, liquidations, kill-switch (flatten everything).
    for (const [id, held] of Object.entries(state.positions)) {
      M.accrueInterest(held.position, Math.max(0, started - (held.lastAccrual || started)) / (365 * DAY), M.DEFAULT_CONFIG.annualInterest);
      held.lastAccrual = started;
      const liq = M.liquidationPrice(held.position, M.DEFAULT_CONFIG.maintenanceMargin);
      if (liq > 0 && M.sidePriceOf(held.position, held.lastYes) <= liq) close(id, 0, `liquidated at ${(M.sidePriceOf(held.position, held.lastYes) * 100).toFixed(1)}c`);
    }
    const eq = equity();
    state.account.peak = Math.max(state.account.peak, eq);
    const maxDd = (options.config && options.config.maxDrawdownPct) || M.DEFAULT_CONFIG.maxDrawdownPct;
    if (!state.account.halted && state.account.peak > 0 && 1 - eq / state.account.peak >= maxDd) {
      state.account.halted = true;
      Object.keys(state.positions).forEach(id => close(id, markOf(state.positions[id]), 'kill-switch'));
      say('HALT', `kill-switch: drawdown ${((1 - eq / state.account.peak) * 100).toFixed(1)}% — flattened; no new trades until reset`);
    }

    for (const market of state.watch) {
      const held = state.positions[market.id];
      if (!held && !mayOpen) continue;
      const history = market.tokenIds ? await tracker.recentPrices(market.tokenIds.YES, market.yesPrice) : [];
      if (held) {
        // Manage: the current model's view when it may trade, else the belief held at entry.
        const view = mayOpen ? prediction(market, market.tokenIds && state.model.kind === 'rich' ? await tracker(market.tokenIds.YES, market.yesPrice) : 0) : { probability: held.belief, variance: held.beliefVariance };
        const review = M.reviewPosition({ ...held.position, takerRate: market.feeRate || 0, takerExponent: market.feeExponent ?? 1, lastYes: market.yesPrice, spread: market.spread, belief: view.probability, beliefVariance: view.variance, endTs: Date.parse(market.endDate) }, { now: started, config });
        if (review && review.action === 'CLOSE') close(market.id, markOf(held), review.reason);
        continue;
      }
      const mom = market.tokenIds && state.model.kind === 'rich' ? await tracker(market.tokenIds.YES, market.yesPrice) : 0;
      const view = prediction(market, mom);
      const openList = Object.values(state.positions);
      const cluster = M.marketCluster(market);
      if (cluster && openList.filter(item => item.cluster === cluster).length >= opts.maxPerCluster) continue;
      const request = {
        yesPrice: market.yesPrice, spread: market.spread, feeRate: market.feeRate || 0, feeExponent: market.feeExponent ?? 1,
        belief: view.probability, beliefVariance: view.variance, bankroll: Math.max(1, eq), peakEquity: state.account.peak, daysLeft: daysLeftOf(market),
        history, staleBelief: false,
        portfolio: { openNotional: openList.reduce((sum, item) => sum + item.position.notional, 0), openCount: openList.length, maxGross: opts.maxGross, maxOpen: opts.maxOpen }
      };
      let advice = M.advise(request, config);
      if (advice.action !== 'OPEN') continue;
      if (market.tokenIds && market.tokenIds[advice.side]) {
        try { advice = M.advise({ ...request, book: { [advice.side]: (await getBook(market.tokenIds[advice.side])).asks || [] } }, config); }
        catch (error) { say('INFO', `${market.question}: order book unavailable (${error.message}), quote used`); }
        if (advice.action !== 'OPEN') continue;
      }
      const margin = Math.min(advice.maxLoss, state.account.cash);
      if (margin < 1) continue;
      const position = M.openPosition({ side: advice.side, yesPrice: market.yesPrice, margin, leverage: advice.leverage, spread: market.spread, takerRate: market.feeRate || 0, takerExponent: market.feeExponent ?? 1 });
      if (advice.bookFill && Number.isFinite(advice.entry)) { position.entry = advice.entry; position.shares = position.notional / position.entry; }
      state.account.cash -= margin;
      state.positions[market.id] = {
        question: market.question, cluster, url: M.polymarketUrl(market), openedAt: new Date(started).toISOString(), lastAccrual: started,
        position, belief: view.probability, beliefVariance: view.variance, lastYes: market.yesPrice, spread: market.spread
      };
      say('OPEN', `${market.question} — ${advice.side} ${advice.leverage}x @ ${(position.entry * 100).toFixed(1)}c · margin ${margin.toFixed(2)} · ${advice.reasons[advice.reasons.length - 1]}`);
    }
    state.lastTick = new Date(now()).toISOString();
    return { refreshed, open: Object.keys(state.positions).length, equity: equity(), halted: state.account.halted, mayOpen };
  }

  return { tick, state, equity };
}

// ---------- persistence ----------
function loadState(file, options) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.version === 1 && saved.account && Number.isFinite(saved.account.cash)) return saved;
  } catch (error) { /* missing or corrupt: start fresh */ }
  return freshState(options);
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 1));
  fs.renameSync(temp, file);                                               // atomic: never a half-written state
}

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { state: 'data/autopilot.json', interval: 300, api: null, model: null, bankroll: undefined, once: false, train: 0, retrain: 24 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'once') args.once = true;
    else if (key in args) { args[key] = argv[i + 1]; i += 1; }
    else throw new Error(`unknown option ${argv[i]}`);
  }
  args.interval = Math.max(30, Number(args.interval) || 300);
  if (args.bankroll !== undefined) args.bankroll = Math.max(100, Number(args.bankroll) || DEFAULTS.bankroll);
  args.train = Math.max(0, Math.min(6000, Math.round(Number(args.train) || 0)));
  args.retrain = Math.max(1, Number(args.retrain) || 24);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState(args.state, { bankroll: args.bankroll });
  if (args.model) {
    const model = JSON.parse(fs.readFileSync(args.model, 'utf8'));
    if (!M.isValidSavedModel(model)) throw new Error(`${args.model} is not a valid Metyu model`);
    state.model = model;
  }
  const pilot = createAutopilot({ fetchJson: makeFetchJson({ api: args.api }), state, options: { bankroll: args.bankroll, train: args.train, retrainHours: args.retrain } });
  const gate = (M.modelMayTrade(state.model) ? 'evidence gate OPEN: may trade' : state.model ? 'evidence gate CLOSED: watch only' : 'no model: watch only')
    + (args.train ? ` · self-training on ${args.train} resolved markets every ${args.retrain} h` : '');
  console.log(`Metyu autopilot · virtual money only · ${gate} · state ${args.state} · every ${args.interval}s`);
  let stopping = false;
  const stop = () => { stopping = true; saveState(args.state, state); console.log('state saved, stopping'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    try {
      const result = await pilot.tick();
      console.log(`${new Date().toISOString()} · ${result.refreshed} prices · ${result.open} open · equity ${result.equity.toFixed(2)}${result.halted ? ' · HALTED' : ''}`);
    } catch (error) { console.error(`tick failed: ${error.message}`); }
    saveState(args.state, state);
    if (args.once || stopping) break;
    await new Promise(resolve => setTimeout(resolve, args.interval * 1000));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = { createAutopilot, freshState, makeFetchJson, loadState, saveState, parseArgs, LIVE_RULES };
