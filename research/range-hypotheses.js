'use strict';
// Hypothesis formation for RANGE strategies on the 2018-2024 episodes ONLY (cached), never the
// training window. Mirrors X.backtest (next-bar entry, stop/target re-anchored, trailing replay).
const X = require('../metyu-exchange.js');
const H = require('../metyu-history.js');
// The episodes' hourly bars, cached by a run of metyu-history's fetchRange (path as the first argument).
//   node research/range-hypotheses.js <episodes.json>   ({ episodeId: { symbol: candles } })
const data = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));

function run(candles, signal, params, from) {
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
    const result = X.replayPosition(position, candles.slice(i + 1), { trail: params.trail !== false });
    if (!result.exit) break;
    const out = X.settle(position, result.exit.price, result.exit.at);
    trades.push({ side: s.side, r: out.r });
    i = Math.max(i + 1, candles.findIndex(c => c.t === result.exit.at) + 1);
  }
  return trades;
}

// H2: a failed breakout (bar i-1 closes outside the 20-bar range on weak volume, bar i closes back
// inside) in a market without a strong trend: fade it back to the middle of the range.
const falseBreakout = (c, ind, i, p) => {
  if (i < 30) return null;
  const hi = ind.donchian.high[i - 1], lo = ind.donchian.low[i - 1], a = ind.atr[i], adx = ind.adx.adx[i];
  if (!(adx < p.maxAdx) || !Number.isFinite(a)) return null;
  const mid = (hi + lo) / 2;
  if (c[i - 1].c > hi && ind.volumeZ[i - 1] < p.maxVolZ && c[i].c < hi && c[i].c > mid) {
    const stop = Math.max(c[i - 1].h, c[i].h) + p.stopAtr * a;
    return { side: 'SHORT', stop, target: mid };
  }
  if (c[i - 1].c < lo && ind.volumeZ[i - 1] < p.maxVolZ && c[i].c > lo && c[i].c < mid) {
    const stop = Math.min(c[i - 1].l, c[i].l) - p.stopAtr * a;
    return { side: 'LONG', stop, target: mid };
  }
  return null;
};
// H4: the existing range reversion, on 4-hour bars.
const reversion = (c, ind, i, p) => X.STRATEGIES.reversion.signal(c, ind, i, p);

const hypotheses = [
  ['falseBreakout 1h', 1, falseBreakout, [{ maxAdx: 25, maxVolZ: 1, stopAtr: .5, trail: false }, { maxAdx: 25, maxVolZ: 1, stopAtr: 1, trail: false }]],
  ['falseBreakout 4h', 4, falseBreakout, [{ maxAdx: 25, maxVolZ: 1, stopAtr: .5, trail: false }, { maxAdx: 25, maxVolZ: 1, stopAtr: 1, trail: false }]],
  ['reversion 1h', 1, reversion, [{ stopAtr: 1.5, rsiEdge: 30, trail: false }, { stopAtr: 2.5, rsiEdge: 30, trail: false }]],
  ['reversion 4h', 4, reversion, [{ stopAtr: 1.5, rsiEdge: 30, trail: false }, { stopAtr: 2.5, rsiEdge: 30, trail: false }]]
];
for (const [name, tf, fn, grid] of hypotheses) {
  for (const params of grid) {
    const byKind = {};
    for (const e of H.EPISODES) {
      for (const [sym, hourly] of Object.entries(data[e.id] || {})) {
        const bars = X.aggregateCandles(hourly, tf);
        const start = bars.findIndex(b => b.t >= Date.parse(e.from));
        if (start < X.WARMUP) continue;
        (byKind[e.kind] = byKind[e.kind] || []).push(...run(bars, fn, params, start));
      }
    }
    const all = Object.values(byKind).flat();
    const m = rs => (rs.reduce((s, t) => s + t.r, 0) / (rs.length || 1)).toFixed(2);
    console.log(name.padEnd(17), JSON.stringify(params).padEnd(44), Object.entries(byKind).map(([k, t]) => `${k} ${m(t)}R(${t.length})`).join('  '), ` ALL ${m(all)}R(${all.length})`);
  }
}
