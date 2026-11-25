#!/usr/bin/env node
'use strict';
// Research: the funding carry on Hyperliquid perps. Hold the coin (spot, long) and short the same
// amount of its perpetual: price moves cancel, and the position collects the funding that longs pay
// shorts. No price prediction. This script measures whether that carry survives ALL costs on real
// history, judged by the same kind of evidence gate as the strategies (weekly blocks, a corrected
// interval). It reads public data only and trades nothing.
//
//   NODE_USE_ENV_PROXY=1 node research/funding-carry.js [--days 730] [--cache dir] [--coins BTC,ETH]
//
// Model (deliberately expensive):
//  - funding: Hyperliquid's real hourly rates; a short RECEIVES a positive rate and PAYS a negative one;
//  - entry and exit: both legs cross the spread and pay taker fees: perp 0.045% + the Fomo builder fee
//    0.05% per side; spot 0.10% (a Solana swap or an exchange taker) per side; plus 0.05% basis/slippage
//    per leg per side. A full round trip costs about 0.59% of notional;
//  - a rule decides when to hold: enter when the trailing 7-day mean funding is above `enter`, exit
//    when it falls below `exit`. A few rule variants are tested; the interval is corrected for them.
const fs = require('fs');
const path = require('path');
const X = require('../metyu-exchange.js');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const INFO = 'https://api.hyperliquid.xyz/info';
const COSTS = Object.freeze({ perpPerSide: .00045 + .0005, spotPerSide: .001, basisPerLegSide: .0005 });
const ROUND_TRIP = 2 * (COSTS.perpPerSide + COSTS.spotPerSide + 2 * COSTS.basisPerLegSide);
// Hourly-rate thresholds (0.00125%/h is Hyperliquid's baseline, about 11% a year).
const RULES = Object.freeze([
  { id: 'always', enter: -Infinity, exit: -Infinity },
  { id: 'baseline+', enter: .0000100, exit: .0000050 },
  { id: 'rich', enter: .0000150, exit: .0000075 },
  { id: 'very-rich', enter: .0000250, exit: .0000100 }
]);

async function post(body, tries = 5) {
  for (let k = 0; k < tries; k += 1) {
    const response = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) return response.json();
    await new Promise(resolve => setTimeout(resolve, 1500 * (k + 1)));
  }
  throw new Error(`Hyperliquid info failed for ${JSON.stringify(body)}`);
}

/** Hourly funding of one coin from `from` to now, paging 500 at a time. [{ t, rate }] */
async function fundingHistory(coin, from, to = Date.now()) {
  const out = [];
  let start = from;
  while (start < to) {
    const rows = await post({ type: 'fundingHistory', coin, startTime: start, endTime: to });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) out.push({ t: Number(row.time), rate: Number(row.fundingRate) });
    const last = Number(rows[rows.length - 1].time);
    if (last <= start) break;
    start = last + 1;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const seen = new Set();
  return out.filter(r => Number.isFinite(r.rate) && !seen.has(r.t) && seen.add(r.t)).sort((a, b) => a.t - b.t);
}

/**
 * Simulates one rule on one coin's hourly funding. Returns weekly P&L as a fraction of notional
 * (funding received minus entry/exit costs, charged in the week they happen) and the holding stats.
 */
function simulate(series, rule, { lookbackHours = 168, costs = ROUND_TRIP } = {}) {
  const weekly = new Map();
  const add = (t, value) => { const week = Math.floor(t / (7 * DAY)); weekly.set(week, (weekly.get(week) || 0) + value); };
  let holding = false;
  let sum = 0;
  let entries = 0;
  let hoursHeld = 0;
  for (let i = 0; i < series.length; i += 1) {
    const { t, rate } = series[i];
    add(t, holding ? rate : 0);                            // every week counts, idle ones as 0
    if (holding) hoursHeld += 1;                           // the short receives +rate (pays when negative)
    sum += rate;
    if (i >= lookbackHours) sum -= series[i - lookbackHours].rate;
    if (i < lookbackHours - 1) continue;
    const mean = sum / Math.min(i + 1, lookbackHours);
    if (!holding && mean > rule.enter) { holding = true; entries += 1; add(t, -costs / 2); }
    else if (holding && mean < rule.exit) { holding = false; add(t, -costs / 2); }
  }
  if (holding) add(series[series.length - 1].t, -costs / 2);   // close at the end
  return { weekly, entries, hoursHeld };
}

function summarise(weeklyByCoin, tests) {
  // One observation per week: the mean across coins of that week's return (coins move together).
  const weeks = new Map();
  for (const weekly of weeklyByCoin) for (const [week, value] of weekly) (weeks.get(week) || weeks.set(week, []).get(week)).push(value);
  const groups = [...weeks.keys()].sort((a, b) => a - b).map(week => [weeks.get(week).reduce((a, b) => a + b, 0) / weeks.get(week).length]);
  const values = groups.map(g => g[0]);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const ci95 = X.blockBootstrapCI(groups, { alpha: .05 });
  const ci = X.blockBootstrapCI(groups, { alpha: .05 / tests });
  return { weeks: values.length, meanWeekly: mean, annual: mean * 52, ci95, ci, positiveWeeks: values.filter(v => v > 0).length, worstWeek: Math.min(...values) };
}

async function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
  const days = Number(arg('days', 730));
  const cache = arg('cache', null);
  const venue = X.VENUES.hyperliquid;
  const coins = arg('coins', null) ? arg('coins').split(',') : Object.values(venue.coins);
  const from = Date.now() - days * DAY;
  const data = {};
  for (const coin of coins) {
    const file = cache && path.join(cache, `${coin}.json`);
    if (file && fs.existsSync(file)) { data[coin] = JSON.parse(fs.readFileSync(file, 'utf8')); continue; }
    data[coin] = await fundingHistory(coin, from);
    if (file) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data[coin])); }
    process.stderr.write(`${coin}: ${data[coin].length} hours\n`);
  }
  const usable = Object.entries(data).filter(([, series]) => series.length > 24 * 120);
  console.log(`Funding carry on Hyperliquid · ${usable.length} coins with 120+ days · round-trip cost ${(ROUND_TRIP * 100).toFixed(2)}% of notional`);
  const halves = [['first half', s => s.slice(0, Math.floor(s.length / 2))], ['second half', s => s.slice(Math.floor(s.length / 2))], ['all', s => s]];
  for (const rule of RULES) {
    for (const [label, cut] of halves) {
      const runs = usable.map(([, series]) => simulate(cut(series), rule));
      const s = summarise(runs.map(r => r.weekly), RULES.length);
      const held = runs.reduce((a, r) => a + r.hoursHeld, 0) / runs.reduce((a, r) => a + cut(usable[0][1]).length, 0);
      console.log(`${rule.id.padEnd(10)} ${label.padEnd(11)} weeks ${String(s.weeks).padStart(3)} · mean ${(s.meanWeekly * 100).toFixed(3)}%/wk (${(s.annual * 100).toFixed(1)}%/yr) · 95% [${(s.ci95[0] * 100).toFixed(3)}, ${(s.ci95[1] * 100).toFixed(3)}] · corrected [${(s.ci[0] * 100).toFixed(3)}, ${(s.ci[1] * 100).toFixed(3)}] · ${s.positiveWeeks}/${s.weeks} weeks up · worst ${(s.worstWeek * 100).toFixed(2)}% · entries/coin ${(runs.reduce((a, r) => a + r.entries, 0) / runs.length).toFixed(1)} · held ${(held * 100).toFixed(0)}%`);
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { simulate, summarise, fundingHistory, ROUND_TRIP, RULES, COSTS };
