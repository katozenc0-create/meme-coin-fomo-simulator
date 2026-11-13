#!/usr/bin/env node
// Metyu on a real crypto exchange, with VIRTUAL money, around the clock. Live public prices from
// Coinbase (Kraken as a fallback); no account, no keys, no orders. Every tick:
//   1. retrain every --retrain hours: walk-forward on --train-bars hourly bars per coin; the evidence
//      gate opens per strategy only on out-of-sample proof after all costs (metyu-exchange.js);
//   2. manage open positions on 15-minute bars: liquidation, stop, take profit, trailing stop,
//      time stop, funding; drawdown kill-switch and the daily loss limit;
//   3. read the chart of every coin once per new hourly bar and act on the strategies' signals:
//      a gate-approved strategy trades the normal book (1% risk, up to 3x); with --learn, the
//      others trade a clearly tagged LEARNING book (0.25% risk, up to 2x) as a forward test.
// State is a JSON file; --status-out writes the public summary the Live Board shows.
//
//   node exchange-autopilot.js [--once] [--learn] [--state data/exchange.json]
//        [--status-out data/exchange-status.json] [--interval 900] [--bankroll 10000]
//        [--train-bars 3000] [--retrain 24] [--symbols BTC-USD,ETH-USD]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const X = require('./metyu-exchange.js');

const HOUR = X.HOUR;
const DEFAULTS = Object.freeze({
  bankroll: 10000, symbols: X.SYMBOLS, trainBars: 3000, retrainHours: 24, trainRetryMs: HOUR,
  learn: false, pause: false, resetHalt: '', liveBars: 900, historyLimit: 2000, logLimit: 400, chartBars: 120, maxSignalDriftAtr: 1
});
const MINUTE = 60000;
const QUARTER = 15 * MINUTE;

function freshState(options = {}) {
  const bankroll = options.bankroll || DEFAULTS.bankroll;
  return {
    version: 1, kind: 'exchange', createdAt: null, lastTick: null,
    account: { bankroll, cash: bankroll, peak: bankroll, halted: false, realized: 0, trades: 0, wins: 0, day: null, dayStartEquity: bankroll },
    positions: {}, history: [], log: [], model: null, trainings: [], lastTrainAttempt: 0,
    lastSignalBar: {}, lastLossAt: {}, marks: {}, nextId: 1
  };
}

/** Node transport: JSON over fetch with a timeout and one retry. */
function makeGetJson({ fetchImpl = fetch, timeoutMs = 15000, retries = 1 } = {}) {
  return async function getJson(url) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'metyu-paper-trader' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    throw lastError;
  };
}

/**
 * The learning book trades a strategy only while the evidence is undecided: not enough
 * out-of-sample trades yet, or a 95% interval that still includes zero. A strategy whose interval
 * lies entirely below zero is proven to lose after costs; trading it would teach nothing new.
 */
function learnable(trained) {
  if (!trained) return true;
  const gate = trained.gate;
  return gate.trades < X.RULES.minTrades || gate.ci[1] > 0;
}

/**
 * The owner's deliberate restart after the kill-switch: a NEW value of METYU_RESET_HALT (any text,
 * for example today's date) clears the halt ONCE and restarts the drawdown from the current equity.
 * Every value is remembered, so a variable left in place never clears a later halt by itself.
 */
function applyHaltReset(state, token, equityNow, say) {
  const value = typeof token === 'string' ? token.trim().slice(0, 64) : '';
  if (!value || state.lastHaltReset === value) return false;
  state.lastHaltReset = value;
  if (!state.account.halted) return false;
  state.account.halted = false;
  state.account.peak = equityNow;
  say('RESET', `kill-switch cleared by the owner (METYU_RESET_HALT=${value}); the drawdown counts again from ${equityNow.toFixed(2)}`);
  return true;
}

function createExchangeAutopilot({ getJson, now = () => Date.now(), state = freshState(), options = {} }) {
  const opts = { ...DEFAULTS, ...options };
  const rules = { ...X.RULES, ...(options.rules || {}) };
  const costs = { ...X.COSTS, ...(options.costs || {}) };
  const strategies = options.strategies || X.STRATEGIES;
  const say = (kind, text) => {
    state.log.unshift({ at: new Date(now()).toISOString(), kind, text });
    state.log.length = Math.min(state.log.length, opts.logLimit);
  };
  const fmt = value => (value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toPrecision(4));
  const money = value => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

  const priceOf = symbol => (state.marks[symbol] ? state.marks[symbol].price : NaN);
  const markOf = held => {
    const price = priceOf(held.symbol);
    return Number.isFinite(price) ? X.markPosition(held, price, now(), costs).equity : held.margin;
  };
  const equity = () => state.account.cash + Object.values(state.positions).reduce((sum, held) => sum + Math.max(0, markOf(held)), 0);

  function close(id, price, reason, at = now()) {
    const held = state.positions[id];
    if (!held) return null;
    const result = X.settle(held, price, at, costs);
    state.account.cash += held.margin + result.pnl;
    state.account.realized += result.pnl;
    state.account.trades += 1;
    if (result.pnl > 0) state.account.wins += 1;
    else state.lastLossAt[held.symbol] = now();
    delete state.positions[id];
    const trade = {
      id, symbol: held.symbol, strategy: held.strategy, side: held.side, book: held.book, learning: held.book === 'learning',
      leverage: held.leverage, entry: held.entry, exit: result.exitFill, qty: held.qty, notional: held.notional, margin: held.margin,
      risk: held.risk, pnl: result.pnl, r: result.r, fees: result.fees, funding: result.funding, reason,
      openedAt: new Date(held.openedAt).toISOString(), closedAt: new Date(at).toISOString()
    };
    state.history.unshift(trade);
    state.history.length = Math.min(state.history.length, opts.historyLimit);
    say(held.book === 'learning' ? 'LEARN-CLOSE' : 'CLOSE', `${held.symbol} ${held.side} ${held.leverage.toFixed(1)}x · ${reason} @ ${fmt(result.exitFill)} · ${money(result.pnl)} (${result.r >= 0 ? '+' : ''}${result.r.toFixed(2)}R)`);
    return trade;
  }

  async function retrainIfDue() {
    const model = state.model;
    // Also due when the strategies or coins changed since the last training (a new release).
    const stale = !!model && (Object.keys(strategies).some(name => !model.strategies[name]) || (Array.isArray(model.symbols) && opts.symbols.some(symbol => !model.symbols.includes(symbol))));
    const due = !model || stale || now() - model.trainedAt >= opts.retrainHours * HOUR;
    if (!due || now() - state.lastTrainAttempt < opts.trainRetryMs) return false;
    state.lastTrainAttempt = now();
    try {
      const bySymbol = {};
      for (const symbol of opts.symbols) {
        try {
          const { candles } = await X.fetchCandles(getJson, symbol, { granularity: 3600, bars: opts.trainBars, now: now() });
          bySymbol[symbol] = X.closedCandles(candles, HOUR, now());
        } catch (error) { say('ERROR', `training data for ${symbol}: ${error.message}`); }
      }
      if (Object.keys(bySymbol).length < 2) throw new Error('not enough coins with history');
      const trained = X.train(bySymbol, { costs, now: now() });
      state.model = trained;
      const summary = Object.entries(trained.strategies).map(([name, s]) => `${name} ${s.gate.open ? 'OPEN' : 'closed'} (${s.gate.trades} trades, mean ${s.gate.meanR >= 0 ? '+' : ''}${s.gate.meanR.toFixed(2)}R [${s.gate.ci[0].toFixed(2)}, ${s.gate.ci[1].toFixed(2)}])`).join(' · ');
      state.trainings.unshift({ at: new Date(now()).toISOString(), bars: trained.bars, symbols: trained.symbols.length, strategies: Object.fromEntries(Object.entries(trained.strategies).map(([name, s]) => [name, { open: s.gate.open, trades: s.gate.trades, meanR: s.gate.meanR, ci: s.gate.ci }])) });
      state.trainings.length = Math.min(state.trainings.length, 60);
      say('TRAIN', `walk-forward on ${trained.bars} hourly bars of ${trained.symbols.length} coins · ${summary}`);
      return true;
    } catch (error) {
      say('ERROR', `training failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Exits in real time. Finished 1-minute bars are walked once each (the position remembers how
   * far it got: checkedUntil, best, stop); if the autopilot was away longer than the 5 hours of
   * 1-minute history, 15-minute bars cover the gap first. The still-forming minute is checked
   * for stop / target / liquidation hits too, without trailing on its unfinished close.
   */
  async function manage(held) {
    const t = now();
    const apply = (result, intervalMs) => {
      if (result.stop !== held.stop) {
        say('TRAIL', `${held.symbol} ${held.side}: stop moved ${fmt(held.stop)} → ${fmt(result.stop)}`);
        held.stop = result.stop;
      }
      held.best = result.best;
      if (result.exit) { close(held.id, result.exit.price, result.exit.reason, Math.min(t, result.exit.at + intervalMs)); return true; }
      return false;
    };
    let minutes = null;
    try { minutes = (await X.fetchCandles(getJson, held.symbol, { granularity: 60, bars: 300, now: t })).candles; } catch (error) { say('ERROR', `1-minute bars for ${held.symbol}: ${error.message}`); }
    const resumeAt = Math.max(held.openedAt, held.checkedUntil || 0);
    const finished = (minutes || []).filter(bar => bar.t + MINUTE <= t);
    // A gap older than the 1-minute history (or no 1-minute data at all): 15-minute bars first.
    if (!finished.length || finished[0].t > resumeAt) {
      try {
        const quarters = (await X.fetchCandles(getJson, held.symbol, { granularity: 900, bars: 300, now: t })).candles
          .filter(bar => bar.t + QUARTER <= (finished.length ? finished[0].t : t));
        const result = X.replayPosition(held, quarters, { now: t, costs, timeStopHours: rules.timeStopHours });
        if (quarters.length) held.checkedUntil = Math.max(resumeAt, quarters[quarters.length - 1].t + QUARTER);
        if (apply(result, QUARTER)) return;
      } catch (error) {
        say('ERROR', `15-minute bars for ${held.symbol}: ${error.message}`);
        if (!finished.length) return;
      }
    }
    if (finished.length) {
      const result = X.replayPosition(held, finished, { now: t, costs, timeStopHours: rules.timeStopHours });
      held.checkedUntil = Math.max(held.checkedUntil || 0, finished[finished.length - 1].t + MINUTE);
      if (apply(result, MINUTE)) return;
    }
    const forming = (minutes || []).filter(bar => bar.t + MINUTE > t && bar.t >= (held.checkedUntil || 0));
    if (forming.length) apply(X.replayPosition(held, forming, { now: t, costs, trail: false }), MINUTE);
  }

  function admitAndOpen({ symbol, strategy, label, signal, bar, atrValue, price, book, reading }) {
    const eq = equity();
    const verdict = X.admit({ account: state.account, positions: state.positions, symbol, side: signal.side, book, now: now(), lastLossAt: state.lastLossAt, rules, equity: eq });
    if (!verdict.ok) { say('SKIP', `${symbol} ${signal.side} (${strategy}): ${verdict.reasons.join('; ')}`); return null; }
    // The signal was priced off the bar's close; the fill is the live price. Too far away: stale.
    if (Math.abs(price - bar.c) > opts.maxSignalDriftAtr * atrValue) { say('SKIP', `${symbol} ${signal.side} (${strategy}): price moved more than 1 ATR since the signal bar`); return null; }
    const shift = price - bar.c;
    const sized = X.sizePosition({ side: signal.side, price, stop: signal.stop + shift, target: signal.target + shift, riskAmount: verdict.riskAmount, maxMargin: verdict.maxMargin, maxLeverage: verdict.maxLeverage, costs });
    if (!sized) { say('SKIP', `${symbol} ${signal.side} (${strategy}): cannot size within the margin and liquidation limits`); return null; }
    const id = `x${state.nextId}`;
    state.nextId += 1;
    const held = { id, symbol, strategy, book, ...sized, stop: sized.initialStop, atr: atrValue, openedAt: now(), reason: signal.reason, chart: reading.notes.slice(0, 3) };
    state.positions[id] = held;
    state.account.cash -= held.margin;
    say(book === 'learning' ? 'LEARN' : 'OPEN', `${symbol} ${signal.side} ${held.leverage.toFixed(1)}x @ ${fmt(held.entry)} · ${label}: ${signal.reason} · stop ${fmt(held.stop)} · target ${fmt(held.target)} · liq ${fmt(held.liquidation)} · margin $${held.margin.toFixed(2)} · risk $${held.risk.toFixed(2)}`);
    return held;
  }

  let lastSeries = {};
  async function tick() {
    const t = now();
    if (!state.createdAt) state.createdAt = new Date(t).toISOString();
    await retrainIfDue();

    // 1. Fresh hourly bars and live prices for every coin.
    const series = {};
    for (const symbol of opts.symbols) {
      try {
        // 900 hourly bars: enough history for the 4-hour strategy's indicators (225 four-hour bars).
        const { source, candles } = await X.fetchCandles(getJson, symbol, { granularity: 3600, bars: opts.liveBars, now: t });
        const last = candles[candles.length - 1];
        state.marks[symbol] = { price: last.c, at: new Date(t).toISOString(), source };
        series[symbol] = X.closedCandles(candles, HOUR, t);
      } catch (error) { say('ERROR', `prices for ${symbol}: ${error.message}`); }
    }

    // 2. Open positions: exits on 15-minute bars.
    for (const held of Object.values(state.positions)) await manage(held);

    // 3. Account guards: the day's starting equity, the peak and the drawdown kill-switch.
    let eq = equity();
    if (applyHaltReset(state, opts.resetHalt, eq, say)) state.account.dayStartEquity = eq;
    const day = new Date(t).toISOString().slice(0, 10);
    if (state.account.day !== day) { state.account.day = day; state.account.dayStartEquity = eq; }
    if (!state.account.halted && eq <= state.account.peak * (1 - rules.killDrawdown)) {
      // No fresh price for a coin (data outage): close at its stop, the conservative assumption.
      for (const held of Object.values(state.positions)) close(held.id, Number.isFinite(priceOf(held.symbol)) ? priceOf(held.symbol) : held.stop, 'kill-switch');
      state.account.halted = true;
      say('HALT', `equity ${eq.toFixed(2)} is ${(rules.killDrawdown * 100).toFixed(0)}% below the peak ${state.account.peak.toFixed(2)}: everything closed, no new trades`);
      eq = equity();
    }
    state.account.peak = Math.max(state.account.peak, eq);

    // 4. New signals, once per closed hourly bar per coin.
    if (!!opts.pause !== !!state.paused) {
      state.paused = !!opts.pause;
      say(state.paused ? 'PAUSE' : 'RESUME', state.paused ? 'paused by the owner: no new positions; open ones are still managed to their exits' : 'resumed by the owner: new positions allowed again');
    }
    let signals = 0;
    // Strategies grouped by timeframe: each group acts once per closed bar of its own timeframe.
    const groups = {};
    for (const name of Object.keys(strategies)) (groups[X.timeframeOf(name, strategies)] = groups[X.timeframeOf(name, strategies)] || []).push(name);
    for (const [symbol, hourly] of Object.entries(series)) {
     for (const [tf, names] of Object.entries(groups).sort(([a], [b]) => a - b)) {
      if (state.account.halted || state.paused || Object.values(state.positions).some(held => held.symbol === symbol)) break;
      const candles = Number(tf) === 1 ? hourly : X.aggregateCandles(hourly, Number(tf), t);
      if (candles.length < X.WARMUP) continue;
      const bar = candles[candles.length - 1];
      const key = Number(tf) === 1 ? symbol : `${symbol}@${tf}h`;
      if (state.lastSignalBar[key] === bar.t) continue;
      state.lastSignalBar[key] = bar.t;
      const ind = X.computeIndicators(candles);
      const reading = X.readChart(candles, ind);
      for (const name of names) {
        const trained = state.model && state.model.strategies[name];
        const params = trained ? trained.params : strategies[name].grid[0];
        const signal = strategies[name].signal(candles, ind, candles.length - 1, params);
        if (!signal) continue;
        signals += 1;
        const review = X.liveReview(state.history, name, rules);
        const gateOpen = !!(trained && trained.gate.open) && !review.demoted;
        const book = gateOpen ? 'gated' : opts.learn && learnable(trained) ? 'learning' : null;
        if (review.demoted && trained && trained.gate.open) say('DEMOTE', `${name}: last ${review.trades} live trades average ${review.meanR >= 0 ? '+' : ''}${review.meanR.toFixed(2)}R (below ${rules.liveDemoteR}R) · ${book ? 'learning book only' : 'not traded'} until they recover`);
        if (!book) {
          say('WATCH', `${symbol} ${signal.side} (${name}): ${signal.reason} · ${!opts.learn ? 'evidence gate closed' : 'out-of-sample evidence says this strategy loses after costs'}, not traded`);
          continue;
        }
        const opened = admitAndOpen({ symbol, strategy: name, label: strategies[name].label, signal, bar, atrValue: ind.atr[candles.length - 1], price: priceOf(symbol), book, reading });
        if (opened) break;                                              // one position per coin
      }
     }
    }

    state.lastTick = new Date(t).toISOString();
    lastSeries = series;
    return { prices: Object.keys(series).length, open: Object.keys(state.positions).length, signals, equity: equity(), halted: state.account.halted };
  }

  return { tick, state, equity, series: () => lastSeries };
}

// ---------- forward evidence and public status ----------
/** Forward test of closed trades in R (P&L / risk at entry), with a seeded bootstrap 95% interval. */
function forwardEvidence(history, { learning, now = Date.now() } = {}) {
  const trades = (history || []).filter(trade => trade.risk > 0 && (learning === undefined || !!trade.learning === learning));
  const rs = trades.map(trade => trade.r);
  const ev = X.evidence(rs);
  const first = trades.length ? Math.min(...trades.map(trade => Date.parse(trade.openedAt))) : null;
  return {
    trades: ev.trades, wins: ev.wins, pnl: trades.reduce((sum, trade) => sum + trade.pnl, 0), meanR: ev.meanR, ci: ev.ci,
    days: first ? (now - first) / X.DAY : 0, convincing: ev.open
  };
}

/**
 * Self-check for the board and the watchdog: coins whose price has not refreshed for 30 minutes
 * (their feed failed; no signal is taken on them), errors in the last hour, and the model's age.
 */
function healthOf(state, now = Date.now()) {
  const staleMarks = Object.entries(state.marks || {}).filter(([, mark]) => !(now - Date.parse(mark.at) < 30 * 60000)).map(([symbol]) => symbol);
  const errorsLastHour = (state.log || []).filter(entry => entry.kind === 'ERROR' && now - Date.parse(entry.at) < X.HOUR).length;
  const modelAgeHours = state.model && Number.isFinite(state.model.trainedAt) ? (now - state.model.trainedAt) / X.HOUR : null;
  return { staleMarks, errorsLastHour, modelAgeHours, ok: !staleMarks.length && errorsLastHour < 30 && modelAgeHours !== null && modelAgeHours < 48 };
}

/** What the Live Board shows: account, model gates, positions, trades, log, forward test, charts. */
function statusOf(state, { now = Date.now(), series = {}, chartBars = DEFAULTS.chartBars, costs = X.COSTS, accountLink = null } = {}) {
  const positions = Object.values(state.positions).map(held => {
    const mark = state.marks[held.symbol] ? X.markPosition(held, state.marks[held.symbol].price, now, costs) : null;
    return { ...held, openedAt: new Date(held.openedAt).toISOString(), mark: mark ? mark.price : null, pnl: mark ? mark.pnl : 0 };
  });
  const charts = {};
  for (const [symbol, candles] of Object.entries(series)) {
    if (!candles.length) continue;
    const ind = X.computeIndicators(candles);
    const from = Math.max(0, candles.length - chartBars);
    const reading = X.readChart(candles, ind);
    charts[symbol] = {
      bars: candles.slice(from).map(c => [c.t, c.o, c.h, c.l, c.c]),
      ema20: ind.ema20.slice(from).map(v => (Number.isFinite(v) ? +v.toPrecision(7) : null)),
      ema50: ind.ema50.slice(from).map(v => (Number.isFinite(v) ? +v.toPrecision(7) : null)),
      trend: reading.trend || null, rsi: reading.rsi || null, support: reading.support || null, resistance: reading.resistance || null, notes: reading.notes
    };
  }
  const equity = state.account.cash + positions.reduce((sum, held) => sum + Math.max(0, held.margin + held.pnl), 0);
  return {
    available: true, virtualMoney: true, kind: 'exchange', generatedAt: new Date(now).toISOString(), createdAt: state.createdAt, lastTick: state.lastTick,
    account: { ...state.account, equity }, paused: !!state.paused, trainingDays: X.TRAINING_DAYS, costs, rules: X.RULES,
    model: state.model ? {
      trainedAt: state.model.trainedAt, bars: state.model.bars, symbols: state.model.symbols,
      strategies: Object.fromEntries(Object.entries(state.model.strategies).map(([name, s]) => {
        const live = X.liveReview(state.history, name);
        return [name, { ...s, live, demoted: s.gate.open && live.demoted, learnable: (!s.gate.open || live.demoted) && learnable(s) }];
      }))
    } : null,
    health: healthOf(state, now),
    marks: state.marks, positions, history: state.history.slice(0, 100), log: state.log.slice(0, 100), trainings: state.trainings.slice(0, 30),
    forward: { learning: forwardEvidence(state.history, { learning: true, now }), gated: forwardEvidence(state.history, { learning: false, now }) },
    // Real money stays locked; this is how far away the conditions are (all trades, both books).
    live: X.liveReadiness({ forward: forwardEvidence(state.history, { now }), createdAt: state.createdAt, account: { ...state.account, equity }, accountLink, now }),
    charts
  };
}

// ---------- persistence ----------
function loadState(file, options) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.version === 1 && saved.kind === 'exchange' && saved.account && Number.isFinite(saved.account.cash)) return saved;
  } catch (error) { /* missing or corrupt: start fresh */ }
  return freshState(options);
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, file);
}

// ---------- CLI ----------
function parseArgs(argv) {
  const args = { state: 'data/exchange.json', 'status-out': null, interval: 900, bankroll: undefined, once: false, learn: false, 'train-bars': 3000, retrain: 24, symbols: null, 'account-public': null, pause: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'once') args.once = true;
    else if (key === 'learn') args.learn = true;
    else if (key === 'pause') args.pause = true;
    else if (key in args) { args[key] = argv[i + 1]; i += 1; }
    else throw new Error(`unknown option ${argv[i]}`);
  }
  args.interval = Math.max(60, Number(args.interval) || 900);
  if (args.bankroll !== undefined) args.bankroll = Math.max(100, Number(args.bankroll) || DEFAULTS.bankroll);
  args['train-bars'] = Math.max(600, Math.min(6000, Math.round(Number(args['train-bars']) || 3000)));
  args.retrain = Math.max(1, Number(args.retrain) || 24);
  if (args.symbols) {
    args.symbols = String(args.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const unknown = args.symbols.filter(s => !/^[A-Z0-9]+-USD$/.test(s));
    if (unknown.length) throw new Error(`symbols must look like BTC-USD: ${unknown.join(', ')}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = loadState(args.state, { bankroll: args.bankroll });
  const getJson = makeGetJson();
  const pause = args.pause || /^(1|true|yes|on)$/i.test(process.env.METYU_PAUSE || '');
  const pilot = createExchangeAutopilot({ getJson, state, options: { bankroll: args.bankroll, learn: args.learn, pause, resetHalt: process.env.METYU_RESET_HALT || '', trainBars: args['train-bars'], retrainHours: args.retrain, ...(args.symbols ? { symbols: args.symbols } : {}) } });
  console.log(`Metyu exchange autopilot · virtual money only · ${Object.keys(state.positions).length} open · learning book ${args.learn ? 'on' : 'off'} · state ${args.state}`);
  for (;;) {
    try {
      const result = await pilot.tick();
      console.log(`${new Date().toISOString()} · ${result.prices} coins · ${result.signals} signals · ${result.open} open · equity ${result.equity.toFixed(2)}${result.halted ? ' · HALTED' : ''}`);
    } catch (error) { console.error(`tick failed: ${error.message}`); }
    saveState(args.state, state);
    if (args['status-out']) {
      let accountLink = null;
      try { if (args['account-public']) accountLink = JSON.parse(fs.readFileSync(args['account-public'], 'utf8')); } catch (error) { /* no account linked */ }
      saveState(args['status-out'], statusOf(state, { series: pilot.series(), accountLink }));
    }
    if (args.once) break;
    await new Promise(resolve => setTimeout(resolve, args.interval * 1000));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = { createExchangeAutopilot, learnable, healthOf, applyHaltReset, freshState, makeGetJson, forwardEvidence, statusOf, loadState, saveState, parseArgs, DEFAULTS };
