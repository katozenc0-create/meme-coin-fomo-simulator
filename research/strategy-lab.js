#!/usr/bin/env node
'use strict';
// The strategy lab: many different strategy FAMILIES, run the same way on the 2018-2024 history
// episodes only (never the training window), against one promotion rule written down BEFORE the run:
//
//   a candidate goes to the evidence gate only if, on the episodes, it has 30+ trades, a mean above
//   +0.05R, and a positive mean in at least 3 of the 4 kinds of market (crash, bear, bull, range).
//
// Everything else stays in the lab. Families are deliberately different from today's strategies
// (hourly trend pullback, 20-bar breakout, Bollinger reversion) so the research is diversified.
//
//   node research/strategy-lab.js <episodes.json>      ({ episodeId: { symbol: hourly candles } })
const fs = require('fs');
const X = require('../metyu-exchange.js');
const H = require('../metyu-history.js');

const PROMOTION = Object.freeze({ minTrades: 30, minMeanR: .05, minKindsPositive: 3 });

/** The same mechanics as X.backtest: signal on a closed bar, entry at the next open, all costs. */
function run(candles, signal, params, from, { useTarget = true } = {}) {
  const ind = X.computeIndicators(candles);
  const trades = [];
  let i = Math.max(from, X.WARMUP);
  while (i < candles.length - 1) {
    const s = signal(candles, ind, i, params);
    if (!s) { i += 1; continue; }
    const next = candles[i + 1];
    const shift = next.o - candles[i].c;
    const sized = X.sizePosition({ side: s.side, price: next.o, stop: s.stop + shift, target: s.target + shift, riskAmount: 100, maxMargin: 1e9, maxLeverage: 1 });
    if (!sized) { i += 1; continue; }
    const position = { ...sized, openedAt: next.t, atr: ind.atr[i] };
    const result = X.replayPosition(position, candles.slice(i + 1), { useTarget, timeStopHours: params.timeStopHours || X.RULES.timeStopHours });
    if (!result.exit) break;
    trades.push({ side: s.side, r: X.settle(position, result.exit.price, result.exit.at).r });
    i = Math.max(i + 1, candles.findIndex(c => c.t === result.exit.at) + 1);
  }
  return trades;
}

const highest = (c, from, to) => Math.max(...c.slice(from, to).map(b => b.h));
const lowest = (c, from, to) => Math.min(...c.slice(from, to).map(b => b.l));

const FAMILIES = {
  // 1. Channel breakout on slow bars (the "turtle" idea): a new N-bar high/low, any volume.
  'channel breakout': {
    timeframes: [4, 24],
    grid: [{ n: 20, stopAtr: 2, targetAtr: 6 }, { n: 55, stopAtr: 2, targetAtr: 6 }],
    signal(c, ind, i, p) {
      if (i < p.n + 1) return null;
      const hi = highest(c, i - p.n, i); const lo = lowest(c, i - p.n, i); const a = ind.atr[i];
      if (c[i].c > hi) return { side: 'LONG', stop: c[i].c - p.stopAtr * a, target: c[i].c + p.targetAtr * a };
      if (c[i].c < lo) return { side: 'SHORT', stop: c[i].c + p.stopAtr * a, target: c[i].c - p.targetAtr * a };
      return null;
    }
  },
  // 2. Volatility squeeze: Bollinger bandwidth at its lowest of the last 120 bars, then a close outside.
  'volatility squeeze': {
    timeframes: [1, 4],
    grid: [{ look: 120, stopAtr: 1.5, targetAtr: 4 }, { look: 120, stopAtr: 2.5, targetAtr: 6 }],
    signal(c, ind, i, p) {
      if (i < p.look + 2) return null;
      const width = k => (ind.bb.upper[k] - ind.bb.lower[k]) / ind.bb.mid[k];
      let minPrev = Infinity;
      for (let k = i - p.look; k < i - 1; k += 1) minPrev = Math.min(minPrev, width(k));
      if (!(width(i - 1) <= minPrev)) return null;                 // the squeeze was on the previous bar
      const a = ind.atr[i];
      if (c[i].c > ind.bb.upper[i]) return { side: 'LONG', stop: c[i].c - p.stopAtr * a, target: c[i].c + p.targetAtr * a };
      if (c[i].c < ind.bb.lower[i]) return { side: 'SHORT', stop: c[i].c + p.stopAtr * a, target: c[i].c - p.targetAtr * a };
      return null;
    }
  },
  // 3. Short-term pullback in a long-term trend (RSI-2 style): buy a deep 2-bar dip above EMA200, sell
  //    a sharp pop below it; the target is the EMA20.
  'deep pullback in trend': {
    timeframes: [1, 4],
    grid: [{ rsi2: 10, stopAtr: 2 }, { rsi2: 5, stopAtr: 3 }],
    signal(c, ind, i, p) {
      if (i < 3) return null;
      const closes = c.slice(i - 2, i + 1).map(b => b.c);
      let up = 0; let down = 0;
      for (let k = 1; k < closes.length; k += 1) { const d = closes[k] - closes[k - 1]; if (d > 0) up += d; else down -= d; }
      const rsi2 = up + down > 0 ? 100 * up / (up + down) : 50;
      const a = ind.atr[i]; const price = c[i].c;
      if (price > ind.ema200[i] && rsi2 <= p.rsi2 && ind.ema20[i] - price > .5 * a) return { side: 'LONG', stop: price - p.stopAtr * a, target: ind.ema20[i] };
      if (price < ind.ema200[i] && rsi2 >= 100 - p.rsi2 && price - ind.ema20[i] > .5 * a) return { side: 'SHORT', stop: price + p.stopAtr * a, target: ind.ema20[i] };
      return null;
    }
  },
  // 4. Moving-average cross on slow bars: EMA20 crosses EMA50, in the direction of EMA200.
  'EMA cross': {
    timeframes: [4, 24],
    grid: [{ stopAtr: 2.5, targetAtr: 6 }, { stopAtr: 3.5, targetAtr: 9 }],
    signal(c, ind, i, p) {
      if (i < 2) return null;
      const a = ind.atr[i]; const price = c[i].c;
      const crossUp = ind.ema20[i - 1] <= ind.ema50[i - 1] && ind.ema20[i] > ind.ema50[i];
      const crossDown = ind.ema20[i - 1] >= ind.ema50[i - 1] && ind.ema20[i] < ind.ema50[i];
      if (crossUp && price > ind.ema200[i]) return { side: 'LONG', stop: price - p.stopAtr * a, target: price + p.targetAtr * a };
      if (crossDown && price < ind.ema200[i]) return { side: 'SHORT', stop: price + p.stopAtr * a, target: price - p.targetAtr * a };
      return null;
    }
  },
  // 5. Exhaustion fade: a bar of 3+ ATR range closing near its extreme after a long run, faded back
  //    toward the EMA20 (capitulation/blow-off).
  'exhaustion fade': {
    timeframes: [1, 4],
    grid: [{ rangeAtr: 3, stopAtr: 1.5 }, { rangeAtr: 4, stopAtr: 2 }],
    signal(c, ind, i, p) {
      const a = ind.atr[i - 1]; const b = c[i];
      if (!(a > 0) || b.h - b.l < p.rangeAtr * a) return null;
      const closePos = (b.c - b.l) / (b.h - b.l);
      if (closePos < .25 && b.c < ind.ema50[i] - 2 * a) return { side: 'LONG', stop: b.l - p.stopAtr * a, target: ind.ema20[i] };
      if (closePos > .75 && b.c > ind.ema50[i] + 2 * a) return { side: 'SHORT', stop: b.h + p.stopAtr * a, target: ind.ema20[i] };
      return null;
    }
  }
};

function evaluate(data, family, tf, params) {
  const byKind = {};
  for (const e of H.EPISODES) {
    for (const hourly of Object.values(data[e.id] || {})) {
      const bars = X.aggregateCandles(hourly, tf);
      const start = bars.findIndex(b => b.t >= Date.parse(e.from));
      if (start < X.WARMUP) continue;                                  // e.g. daily bars need 210 days of warm-up
      (byKind[e.kind] = byKind[e.kind] || []).push(...run(bars, family.signal, params, start));
    }
  }
  const mean = rs => rs.reduce((s, t) => s + t.r, 0) / (rs.length || 1);
  const all = Object.values(byKind).flat();
  const kinds = Object.fromEntries(H.KINDS.map(k => [k, byKind[k] ? { trades: byKind[k].length, meanR: mean(byKind[k]) } : { trades: 0, meanR: 0 }]));
  const positive = H.KINDS.filter(k => kinds[k].trades >= 5 && kinds[k].meanR > 0).length;
  const promoted = all.length >= PROMOTION.minTrades && mean(all) > PROMOTION.minMeanR && positive >= PROMOTION.minKindsPositive;
  return { trades: all.length, meanR: mean(all), kinds, positive, promoted };
}

function main(argv = process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  const rows = [];
  for (const [name, family] of Object.entries(FAMILIES)) {
    for (const tf of family.timeframes) {
      for (const params of family.grid) {
        const r = evaluate(data, family, tf, params);
        rows.push({ name, tf, params, ...r });
        console.log(`${(name + ` ${tf}h`).padEnd(28)} ${JSON.stringify(params).padEnd(42)} ${H.KINDS.map(k => `${k} ${r.kinds[k].meanR.toFixed(2)}R(${r.kinds[k].trades})`).join(' ')}  ALL ${r.meanR.toFixed(3)}R(${r.trades}) ${r.promoted ? '→ PROMOTE' : ''}`);
      }
    }
  }
  console.log(`\n${rows.length} variants of ${Object.keys(FAMILIES).length} families · promotion rule: ${PROMOTION.minTrades}+ trades, mean > +${PROMOTION.minMeanR}R, positive in ${PROMOTION.minKindsPositive}+ of 4 kinds · promoted: ${rows.filter(r => r.promoted).map(r => `${r.name} ${r.tf}h ${JSON.stringify(r.params)}`).join('; ') || 'none'}`);
  return rows;
}

if (require.main === module) main();
module.exports = { FAMILIES, PROMOTION, evaluate, run };
