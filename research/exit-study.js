#!/usr/bin/env node
'use strict';
// Research: profit-taking and exits. The SAME entries (today's strategies and parameters), with
// different exit rules, replayed on the 2018-2024 history episodes only (never the training window).
// A better exit rule must win across the kinds of market, not in one; then, and only then, it may be
// judged by the evidence gate on the training window.
//
//   node research/exit-study.js <episodes.json> [<exchange-status.json for the trained parameters>]
const fs = require('fs');
const X = require('../metyu-exchange.js');
const H = require('../metyu-history.js');

const HOUR = X.HOUR;
// Exit rules. beAt: move the stop to break-even after this many ATR in profit; trail: trailing
// distance in ATR (0 = none); target: keep the strategy's take-profit; partialR: bank half at this R.
const RULES = {
  current: { beAt: 1.5, trail: 2.5, target: true, timeStop: 72, partialR: 0 },
  'no target (let it run)': { beAt: 1.5, trail: 2.5, target: false, timeStop: 72, partialR: 0 },
  'tight trail 1.5 ATR': { beAt: 1.5, trail: 1.5, target: true, timeStop: 72, partialR: 0 },
  'half at 1R': { beAt: 1.5, trail: 2.5, target: true, timeStop: 72, partialR: 1 },
  'time stop 24 h': { beAt: 1.5, trail: 2.5, target: true, timeStop: 24, partialR: 0 },
  'break-even at 1 ATR': { beAt: 1, trail: 2.5, target: true, timeStop: 72, partialR: 0 },
  'no trail': { beAt: Infinity, trail: 0, target: true, timeStop: 72, partialR: 0 }
};

/** One position under one exit rule; returns the exit price (or two halves). Mirrors replayPosition. */
function replay(position, bars, rule) {
  const long = position.side === 'LONG';
  const dir = long ? 1 : -1;
  const a = position.atr;
  const risk = Math.abs(position.entry - position.initialStop);
  let stop = position.initialStop;
  let best = position.entry;
  let banked = null;                                       // the half closed at partialR
  const partialPrice = rule.partialR ? position.entry + dir * rule.partialR * risk : null;
  for (const bar of bars) {
    const hitStop = long ? bar.l <= stop : bar.h >= stop;
    if (hitStop) {
      const price = (long ? bar.o < stop : bar.o > stop) ? bar.o : stop;
      return { price, at: bar.t, banked };
    }
    if (rule.partialR && banked === null && (long ? bar.h >= partialPrice : bar.l <= partialPrice)) banked = partialPrice;
    if (rule.target && Number.isFinite(position.target) && (long ? bar.h >= position.target : bar.l <= position.target)) {
      return { price: (long ? bar.o > position.target : bar.o < position.target) ? bar.o : position.target, at: bar.t, banked };
    }
    best = long ? Math.max(best, bar.c) : Math.min(best, bar.c);
    const moved = dir * (best - position.entry);
    if (Number.isFinite(a) && a > 0 && moved >= rule.beAt * a) {
      const level = rule.trail ? (long ? Math.max(position.entry, best - rule.trail * a) : Math.min(position.entry, best + rule.trail * a)) : position.entry;
      stop = long ? Math.max(stop, level) : Math.min(stop, level);
    }
    if ((bar.t - position.openedAt) / HOUR >= rule.timeStop) return { price: bar.c, at: bar.t, banked };
  }
  return null;
}

function run(candles, name, params, from, rule) {
  const ind = X.computeIndicators(candles);
  const trades = [];
  let i = Math.max(from, X.WARMUP);
  while (i < candles.length - 1) {
    const s = X.STRATEGIES[name].signal(candles, ind, i, params);
    if (!s) { i += 1; continue; }
    const next = candles[i + 1];
    const shift = next.o - candles[i].c;
    const sized = X.sizePosition({ side: s.side, price: next.o, stop: s.stop + shift, target: s.target + shift, riskAmount: 100, maxMargin: 1e9, maxLeverage: 1 });
    if (!sized) { i += 1; continue; }
    const position = { ...sized, openedAt: next.t, atr: ind.atr[i] };
    const exit = replay(position, candles.slice(i + 1), rule);
    if (!exit) break;
    // Costs exactly as settle() charges them: a banked half settles at its own price.
    const r = exit.banked === null
      ? X.settle(position, exit.price, exit.at).r
      : (X.settle(position, exit.banked, exit.at).r + X.settle(position, exit.price, exit.at).r) / 2;
    trades.push({ r });
    i = Math.max(i + 1, candles.findIndex(c => c.t === exit.at) + 1);
  }
  return trades;
}

function main(argv = process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  const status = argv[1] ? JSON.parse(fs.readFileSync(argv[1], 'utf8')) : null;
  const strategies = ['trend', 'breakout', 'trend4h'];
  const paramsOf = name => (status && status.model && status.model.strategies[name] ? status.model.strategies[name].params : X.STRATEGIES[name].grid[0]);
  const mean = rs => rs.reduce((s, t) => s + t.r, 0) / (rs.length || 1);
  for (const [label, rule] of Object.entries(RULES)) {
    const byKind = {};
    for (const name of strategies) {
      for (const e of H.EPISODES) {
        for (const hourly of Object.values(data[e.id] || {})) {
          const bars = X.aggregateCandles(hourly, X.timeframeOf(name));
          const start = bars.findIndex(b => b.t >= Date.parse(e.from));
          if (start < X.WARMUP) continue;
          (byKind[e.kind] = byKind[e.kind] || []).push(...run(bars, name, paramsOf(name), start, rule));
        }
      }
    }
    const all = Object.values(byKind).flat();
    console.log(`${label.padEnd(24)} ${H.KINDS.map(k => `${k} ${mean(byKind[k] || []).toFixed(2)}R`).join('  ')}  ALL ${mean(all).toFixed(3)}R (${all.length})`);
  }
}

if (require.main === module) main();
module.exports = { replay, run, RULES };
