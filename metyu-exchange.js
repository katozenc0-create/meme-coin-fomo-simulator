/*
 * Metyu on a real exchange, with VIRTUAL money only.
 *
 * Live, read-only public market data (Coinbase Exchange candles, Kraken as a fallback); no account,
 * no API keys, no orders. Everything here is pure and deterministic so the browser, the Node
 * autopilot and the tests run the very same rules:
 *
 *   indicators   ema, sma, rsi, atr, bollinger, macd, donchian, adx (Wilder)
 *   readChart    "chart reading": trend regime, momentum, volatility, breakout, support/resistance,
 *                volume, as numbers plus plain-language notes
 *   strategies   trend (pullback in a trend), breakout (Donchian + volume), reversion (range only)
 *   positions    long/short, isolated margin, leverage, liquidation, fees, slippage, funding,
 *                ATR stop, target, break-even and chandelier trailing stop, time stop, gaps
 *   backtest     the same position code walked over history (next-bar entries, stop-first when a
 *                bar touches both stop and target)
 *   train        walk-forward: parameters chosen on the first 60% of the history, judged only on
 *                the last 40%; the evidence gate opens per strategy with 30+ out-of-sample trades
 *                and a 95% bootstrap interval of the mean R above zero, after all costs
 *   portfolio    risk-based size, leverage cap, one position per coin, correlated-crypto risk cap,
 *                margin cap, daily loss stop, cool-down after a loss, drawdown kill-switch
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetyuExchange = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOUR = 3600000;
  const DAY = 24 * HOUR;

  // Coins with deep USD markets on both Coinbase and Kraken.
  const SYMBOLS = Object.freeze(['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'AVAX-USD', 'LINK-USD']);
  const KRAKEN_PAIRS = Object.freeze({ 'BTC-USD': 'XBTUSD', 'ETH-USD': 'ETHUSD', 'SOL-USD': 'SOLUSD', 'XRP-USD': 'XRPUSD', 'DOGE-USD': 'XDGUSD', 'ADA-USD': 'ADAUSD', 'AVAX-USD': 'AVAXUSD', 'LINK-USD': 'LINKUSD' });

  // Costs are deliberately on the expensive side of a retail perpetual-futures account.
  const COSTS = Object.freeze({
    feeRate: .001,            // 0.10% taker fee per side, on notional
    slippage: .0005,          // 0.05% worse than the quote, per side
    fundingPer8h: .0001,      // 0.01% of notional every 8 hours, always paid (conservative)
    maintenance: .005         // 0.5% maintenance margin: liquidation when equity falls below it
  });

  const RULES = Object.freeze({
    riskPct: .01,             // a stop-out loses ~1% of equity (gated book)
    learnRiskPct: .0025,      // ~0.25% in the learning book
    maxLeverage: 3,
    learnMaxLeverage: 2,
    maxPositionPct: .25,      // margin of one position <= 25% of equity
    maxMarginPct: .6,         // all margins together <= 60% of equity
    maxOpen: 4,
    maxSideRiskPct: .03,      // crypto moves together: open risk in one direction <= 3% of equity
    dailyLossPct: .04,        // after -4% in a UTC day, no new positions that day
    killDrawdown: .15,        // -15% from the peak: close everything and halt
    cooldownHours: 6,         // no re-entry on a coin for 6 h after a losing trade on it
    timeStopHours: 72,
    minTrades: 30             // the evidence gate's bar, the same as the Prediction Lab's
  });

  // ---------- small helpers ----------
  const finite = value => Number.isFinite(value);
  const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  function createRng(seed) {                                         // mulberry32
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function bootstrapCI(values, { seed = 20261112, reps = 2000 } = {}) {
    if (!values.length) return [0, 0];
    const rng = createRng(seed);
    const boots = [];
    for (let rep = 0; rep < reps; rep += 1) {
      let total = 0;
      for (let i = 0; i < values.length; i += 1) total += values[Math.floor(rng() * values.length)];
      boots.push(total / values.length);
    }
    boots.sort((a, b) => a - b);
    return [boots[Math.floor(.025 * reps)], boots[Math.ceil(.975 * reps) - 1]];
  }

  // ---------- market data ----------
  /** Candles, oldest first: { t (open time, ms), o, h, l, c, v }. Drops bad rows and duplicates. */
  function normaliseCandles(rows) {
    const byTime = new Map();
    for (const row of rows || []) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const c = { t: +row.t, o: +row.o, h: +row.h, l: +row.l, c: +row.c, v: +row.v || 0 };
      if (!finite(c.t) || ![c.o, c.h, c.l, c.c].every(x => finite(x) && x > 0)) continue;
      c.h = Math.max(c.h, c.o, c.c);
      c.l = Math.min(c.l, c.o, c.c);
      byTime.set(c.t, c);
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }
  /** Coinbase Exchange: [time(s), low, high, open, close, volume], newest first. */
  function parseCoinbaseCandles(rows) {
    return normaliseCandles((Array.isArray(rows) ? rows : []).map(row => (Array.isArray(row) ? { t: row[0] * 1000, l: row[1], h: row[2], o: row[3], c: row[4], v: row[5] } : null)));
  }
  /** Kraken: { result: { PAIR: [[time(s), open, high, low, close, vwap, volume, count], ...] } }. */
  function parseKrakenCandles(data) {
    const result = data && data.result ? data.result : {};
    const key = Object.keys(result).find(name => name !== 'last');
    return normaliseCandles((key ? result[key] : []).map(row => ({ t: row[0] * 1000, o: row[1], h: row[2], l: row[3], c: row[4], v: row[6] })));
  }
  /** Only candles that have finished by `now` (signals never use a half-formed bar). */
  function closedCandles(candles, intervalMs, now) {
    return candles.filter(candle => candle.t + intervalMs <= now);
  }

  /**
   * Fetches candles for one coin. `getJson(url)` is the transport (fetch in the browser, Node's
   * fetch in the autopilot). Coinbase serves 300 bars per request; `bars` above that pages back.
   * Kraken (720 most recent bars) is the fallback when Coinbase fails.
   */
  async function fetchCandles(getJson, symbol, { granularity = 3600, bars = 300, now = Date.now() } = {}) {
    const intervalMs = granularity * 1000;
    try {
      const pages = Math.max(1, Math.ceil(bars / 300));
      const rows = [];
      let end = Math.floor(now / intervalMs) * intervalMs + intervalMs;
      for (let page = 0; page < pages; page += 1) {
        const start = end - 300 * intervalMs;
        const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
        const data = await getJson(url);
        if (!Array.isArray(data)) throw new Error((data && data.message) || 'unexpected Coinbase answer');
        rows.push(...data);
        if (data.length === 0) break;
        end = start;
      }
      const candles = parseCoinbaseCandles(rows);
      if (!candles.length) throw new Error('no Coinbase candles');
      return { source: 'coinbase', candles: candles.slice(-bars) };
    } catch (error) {
      const pair = KRAKEN_PAIRS[symbol];
      if (!pair) throw error;
      const data = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${granularity / 60}`);
      if (data && Array.isArray(data.error) && data.error.length) throw new Error(`Coinbase: ${error.message}; Kraken: ${data.error.join(', ')}`);
      const candles = parseKrakenCandles(data);
      if (!candles.length) throw new Error(`Coinbase: ${error.message}; Kraken: no candles`);
      return { source: 'kraken', candles: candles.slice(-bars) };
    }
  }

  // ---------- indicators (arrays aligned with the candles; NaN until warmed up) ----------
  function sma(values, period) {
    const out = new Array(values.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function ema(values, period) {
    const out = new Array(values.length).fill(NaN);
    const k = 2 / (period + 1);
    let prev = NaN;
    for (let i = 0; i < values.length; i += 1) {
      if (i === period - 1) prev = mean(values.slice(0, period));
      else if (i >= period) prev = values[i] * k + prev * (1 - k);
      if (i >= period - 1) out[i] = prev;
    }
    return out;
  }
  /** Wilder smoothing (RSI, ATR, ADX). */
  function wilder(values, period, start = 0) {
    const out = new Array(values.length).fill(NaN);
    if (values.length - start < period) return out;
    let prev = mean(values.slice(start, start + period));
    out[start + period - 1] = prev;
    for (let i = start + period; i < values.length; i += 1) {
      prev = (prev * (period - 1) + values[i]) / period;
      out[i] = prev;
    }
    return out;
  }
  function rsi(closes, period = 14) {
    const gains = [0];
    const losses = [0];
    for (let i = 1; i < closes.length; i += 1) {
      const change = closes[i] - closes[i - 1];
      gains.push(Math.max(change, 0));
      losses.push(Math.max(-change, 0));
    }
    const up = wilder(gains, period, 1);
    const down = wilder(losses, period, 1);
    return up.map((u, i) => (finite(u) ? (down[i] === 0 ? 100 : 100 - 100 / (1 + u / down[i])) : NaN));
  }
  function trueRanges(candles) {
    return candles.map((candle, i) => (i === 0 ? candle.h - candle.l
      : Math.max(candle.h - candle.l, Math.abs(candle.h - candles[i - 1].c), Math.abs(candle.l - candles[i - 1].c))));
  }
  function atr(candles, period = 14) { return wilder(trueRanges(candles), period); }
  function bollinger(closes, period = 20, width = 2) {
    const mid = sma(closes, period);
    const upper = [];
    const lower = [];
    for (let i = 0; i < closes.length; i += 1) {
      if (!finite(mid[i])) { upper.push(NaN); lower.push(NaN); continue; }
      const window = closes.slice(i - period + 1, i + 1);
      const sd = Math.sqrt(mean(window.map(value => (value - mid[i]) ** 2)));
      upper.push(mid[i] + width * sd);
      lower.push(mid[i] - width * sd);
    }
    return { mid, upper, lower };
  }
  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const fastLine = ema(closes, fast);
    const slowLine = ema(closes, slow);
    const line = closes.map((_, i) => fastLine[i] - slowLine[i]);
    const firstValid = line.findIndex(finite);
    const signalLine = new Array(closes.length).fill(NaN);
    if (firstValid >= 0) ema(line.slice(firstValid), signal).forEach((value, i) => { signalLine[firstValid + i] = value; });
    return { line, signal: signalLine, hist: line.map((value, i) => value - signalLine[i]) };
  }
  /** Highest high / lowest low of the `period` bars BEFORE bar i (a breakout compares against it). */
  function donchian(candles, period = 20) {
    const high = new Array(candles.length).fill(NaN);
    const low = new Array(candles.length).fill(NaN);
    for (let i = period; i < candles.length; i += 1) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - period; j < i; j += 1) { hi = Math.max(hi, candles[j].h); lo = Math.min(lo, candles[j].l); }
      high[i] = hi;
      low[i] = lo;
    }
    return { high, low };
  }
  function adx(candles, period = 14) {
    const plusDM = [0];
    const minusDM = [0];
    for (let i = 1; i < candles.length; i += 1) {
      const up = candles[i].h - candles[i - 1].h;
      const down = candles[i - 1].l - candles[i].l;
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }
    const tr = wilder(trueRanges(candles), period, 1);
    const plus = wilder(plusDM, period, 1).map((value, i) => 100 * value / tr[i]);
    const minus = wilder(minusDM, period, 1).map((value, i) => 100 * value / tr[i]);
    const dx = plus.map((p, i) => (finite(p) && p + minus[i] > 0 ? 100 * Math.abs(p - minus[i]) / (p + minus[i]) : NaN));
    const firstValid = dx.findIndex(finite);
    const out = new Array(candles.length).fill(NaN);
    if (firstValid >= 0) wilder(dx.slice(firstValid), period).forEach((value, i) => { out[firstValid + i] = value; });
    return { adx: out, plus, minus };
  }

  /** All indicators for a candle series, computed once and shared by readChart and the strategies. */
  function computeIndicators(candles) {
    const closes = candles.map(candle => candle.c);
    const volumes = candles.map(candle => candle.v);
    const volumeMean = sma(volumes, 20);
    const volumeSd = volumes.map((_, i) => (i < 19 ? NaN : Math.sqrt(mean(volumes.slice(i - 19, i + 1).map(v => (v - volumeMean[i]) ** 2)))));
    return {
      closes,
      ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
      rsi: rsi(closes, 14), atr: atr(candles, 14), bb: bollinger(closes, 20, 2), macd: macd(closes),
      donchian: donchian(candles, 20), adx: adx(candles, 14),
      volumeZ: volumes.map((v, i) => (volumeSd[i] > 0 ? (v - volumeMean[i]) / volumeSd[i] : 0))
    };
  }
  const WARMUP = 210;                                                  // EMA200 + a few bars

  /** Recent swing pivots (a bar higher/lower than `span` bars on each side) as support/resistance. */
  function swingLevels(candles, { span = 3, lookback = 120 } = {}) {
    const from = Math.max(span, candles.length - lookback);
    const highs = [];
    const lows = [];
    for (let i = from; i < candles.length - span; i += 1) {
      const around = candles.slice(i - span, i + span + 1);
      if (around.every(candle => candle.h <= candles[i].h)) highs.push(candles[i].h);
      if (around.every(candle => candle.l >= candles[i].l)) lows.push(candles[i].l);
    }
    const price = candles.length ? candles[candles.length - 1].c : NaN;
    const resistance = highs.filter(level => level > price).sort((a, b) => a - b)[0];
    const support = lows.filter(level => level < price).sort((a, b) => b - a)[0];
    return { support: finite(support) ? support : null, resistance: finite(resistance) ? resistance : null };
  }

  /**
   * Chart reading for bar `i` (default: the last closed bar): the regime and the evidence behind it,
   * as numbers and as short notes a person can check against the chart.
   */
  function readChart(candles, ind = computeIndicators(candles), i = candles.length - 1) {
    if (i < WARMUP - 1) return { ready: false, notes: [`needs ${WARMUP} bars of history, has ${i + 1}`] };
    const price = candles[i].c;
    const e20 = ind.ema20[i]; const e50 = ind.ema50[i]; const e200 = ind.ema200[i];
    const slope50 = (e50 - ind.ema50[i - 10]) / ind.ema50[i - 10];
    const strength = ind.adx.adx[i];
    let trend = 'range';
    if (strength >= 20 && e20 > e50 && e50 > e200 && slope50 > 0) trend = 'up';
    else if (strength >= 20 && e20 < e50 && e50 < e200 && slope50 < 0) trend = 'down';
    const breakout = candles[i].c > ind.donchian.high[i] ? 'up' : candles[i].c < ind.donchian.low[i] ? 'down' : null;
    const band = ind.bb.upper[i] - ind.bb.lower[i];
    const bbPos = band > 0 ? (price - ind.bb.lower[i]) / band : .5;
    const levels = swingLevels(candles.slice(0, i + 1));
    const reading = {
      ready: true, at: candles[i].t, price, trend, adx: strength, rsi: ind.rsi[i], atr: ind.atr[i], atrPct: ind.atr[i] / price,
      ema20: e20, ema50: e50, ema200: e200, slope50, macdHist: ind.macd.hist[i], bbPos, breakout, volumeZ: ind.volumeZ[i], ...levels, notes: []
    };
    const pct = value => `${(value * 100).toFixed(1)}%`;
    reading.notes.push(trend === 'up' ? `uptrend: EMA20 > EMA50 > EMA200, ADX ${strength.toFixed(0)}`
      : trend === 'down' ? `downtrend: EMA20 < EMA50 < EMA200, ADX ${strength.toFixed(0)}`
        : `no clear trend (ADX ${strength.toFixed(0)}${strength >= 20 ? ', EMAs not aligned' : ' < 20'})`);
    reading.notes.push(`RSI ${reading.rsi.toFixed(0)}${reading.rsi >= 70 ? ' overbought' : reading.rsi <= 30 ? ' oversold' : ''} · MACD ${reading.macdHist >= 0 ? 'positive' : 'negative'}`);
    reading.notes.push(`volatility ${pct(reading.atrPct)} per hour (ATR) · Bollinger position ${(bbPos * 100).toFixed(0)}%`);
    if (breakout) reading.notes.push(`${breakout === 'up' ? 'broke above' : 'broke below'} the 20-bar range${reading.volumeZ > 1 ? ' on high volume' : ''}`);
    if (levels.support) reading.notes.push(`support ~${levels.support.toPrecision(5)} (${pct((price - levels.support) / price)} below)`);
    if (levels.resistance) reading.notes.push(`resistance ~${levels.resistance.toPrecision(5)} (${pct((levels.resistance - price) / price)} above)`);
    return reading;
  }

  // ---------- strategies ----------
  // Each looks only at bars up to i and returns null or { side, stop, target, reason } priced off the
  // close of bar i. Parameters are a small grid; train() picks them on the first part of the history.
  const STRATEGIES = Object.freeze({
    trend: {
      label: 'Trend pullback',
      grid: [{ stopAtr: 2, targetAtr: 3 }, { stopAtr: 2, targetAtr: 4 }, { stopAtr: 3, targetAtr: 4.5 }],
      signal(candles, ind, i, params) {
        const r = readChart(candles, ind, i);
        if (!r.ready) return null;
        const a = r.atr;
        // Long: an uptrend, momentum still positive, but the last bars pulled back (RSI 40-60).
        if (r.trend === 'up' && r.macdHist > 0 && r.rsi >= 40 && r.rsi <= 60 && r.price > r.ema50)
          return { side: 'LONG', stop: r.price - params.stopAtr * a, target: r.price + params.targetAtr * a, reason: `uptrend pullback: RSI ${r.rsi.toFixed(0)}, ADX ${r.adx.toFixed(0)}, above EMA50` };
        if (r.trend === 'down' && r.macdHist < 0 && r.rsi >= 40 && r.rsi <= 60 && r.price < r.ema50)
          return { side: 'SHORT', stop: r.price + params.stopAtr * a, target: r.price - params.targetAtr * a, reason: `downtrend pullback: RSI ${r.rsi.toFixed(0)}, ADX ${r.adx.toFixed(0)}, below EMA50` };
        return null;
      }
    },
    breakout: {
      label: 'Range breakout',
      grid: [{ stopAtr: 1.5, targetAtr: 3 }, { stopAtr: 2, targetAtr: 4 }, { stopAtr: 2.5, targetAtr: 5 }],
      signal(candles, ind, i, params) {
        const r = readChart(candles, ind, i);
        if (!r.ready || !r.breakout || r.volumeZ < 1 || !(ind.adx.adx[i] > ind.adx.adx[i - 3])) return null;
        const a = r.atr;
        if (r.breakout === 'up' && r.price > r.ema200)
          return { side: 'LONG', stop: r.price - params.stopAtr * a, target: r.price + params.targetAtr * a, reason: `20-bar breakout up on volume (z ${r.volumeZ.toFixed(1)}), ADX rising` };
        if (r.breakout === 'down' && r.price < r.ema200)
          return { side: 'SHORT', stop: r.price + params.stopAtr * a, target: r.price - params.targetAtr * a, reason: `20-bar breakout down on volume (z ${r.volumeZ.toFixed(1)}), ADX rising` };
        return null;
      }
    },
    reversion: {
      label: 'Range reversion',
      grid: [{ stopAtr: 1.5, rsiEdge: 30 }, { stopAtr: 2, rsiEdge: 25 }, { stopAtr: 2.5, rsiEdge: 30 }],
      signal(candles, ind, i, params) {
        const r = readChart(candles, ind, i);
        if (!r.ready || r.trend !== 'range' || r.adx >= 20) return null;
        const a = r.atr;
        const mid = ind.bb.mid[i];
        // Only in a range: buy below the lower band when oversold, aim for the middle band.
        if (r.bbPos < 0 && r.rsi <= params.rsiEdge && mid - r.price > a)
          return { side: 'LONG', stop: r.price - params.stopAtr * a, target: mid, reason: `range: below the lower Bollinger band, RSI ${r.rsi.toFixed(0)}` };
        if (r.bbPos > 1 && r.rsi >= 100 - params.rsiEdge && r.price - mid > a)
          return { side: 'SHORT', stop: r.price + params.stopAtr * a, target: mid, reason: `range: above the upper Bollinger band, RSI ${r.rsi.toFixed(0)}` };
        return null;
      }
    }
  });

  // ---------- positions ----------
  /** Fill price after slippage: buying costs more, selling gets less. */
  const fillPrice = (price, buying, costs = COSTS) => price * (buying ? 1 + costs.slippage : 1 - costs.slippage);
  /** Liquidation price of an isolated-margin position (before fees and funding). */
  function liquidationPrice(side, entry, leverage, costs = COSTS) {
    return side === 'LONG' ? entry * (1 - 1 / leverage + costs.maintenance) : entry * (1 + 1 / leverage - costs.maintenance);
  }

  /**
   * Sizes a trade so that a stop-out costs `riskAmount` including fees and slippage, then picks the
   * smallest leverage that keeps the margin within `maxMargin`, never above `maxLeverage`, and
   * always with the liquidation price safely beyond the stop. Returns null if it cannot be done.
   */
  function sizePosition({ side, price, stop, target, riskAmount, maxMargin, maxLeverage, costs = COSTS }) {
    if (!(price > 0 && stop > 0 && riskAmount > 0 && maxMargin > 0)) return null;
    if ((side === 'LONG' && stop >= price) || (side === 'SHORT' && stop <= price)) return null;
    const entry = fillPrice(price, side === 'LONG', costs);
    const exitAtStop = fillPrice(stop, side !== 'LONG', costs);
    const lossPerUnit = Math.abs(entry - exitAtStop) + costs.feeRate * (entry + exitAtStop);
    let qty = riskAmount / lossPerUnit;
    let notional = qty * entry;
    let leverage = Math.max(1, notional / maxMargin);
    if (leverage > maxLeverage) { leverage = maxLeverage; notional = maxMargin * maxLeverage; qty = notional / entry; }
    // The stop must sit well inside the liquidation price (gaps): at least half the distance again.
    const stopDistance = Math.abs(entry - stop) / entry;
    const maxSafeLeverage = 1 / (1.5 * stopDistance + costs.maintenance + 2 * costs.feeRate);
    if (leverage > maxSafeLeverage) {
      if (maxSafeLeverage < 1) return null;
      leverage = maxSafeLeverage;
      notional = Math.min(notional, maxMargin * leverage);
      qty = notional / entry;
    }
    const margin = notional / leverage;
    if (!(qty > 0 && margin > 0)) return null;
    return {
      side, entry, qty, notional, margin, leverage, stop, initialStop: stop, target,
      liquidation: liquidationPrice(side, entry, leverage, costs), entryFee: costs.feeRate * notional,
      risk: qty * lossPerUnit
    };
  }

  /** Profit of a position closed at `exitPrice` (before slippage), after fees and funding. */
  function settle(position, exitPrice, exitTime, costs = COSTS) {
    const exitFill = fillPrice(exitPrice, position.side !== 'LONG', costs);
    const gross = (position.side === 'LONG' ? exitFill - position.entry : position.entry - exitFill) * position.qty;
    const hours = Math.max(0, (exitTime - position.openedAt) / HOUR);
    const funding = position.notional * costs.fundingPer8h * Math.floor(hours / 8);
    const exitFee = costs.feeRate * exitFill * position.qty;
    // Isolated margin: the loss can never exceed the margin put up.
    const pnl = Math.max(-position.margin, gross - position.entryFee - exitFee - funding);
    return { exitFill, pnl, fees: position.entryFee + exitFee, funding, r: position.risk > 0 ? pnl / position.risk : 0 };
  }

  /**
   * Replays a position over the bars that came after its entry (any interval) and decides its fate:
   * liquidation, stop, target, time stop, or still open with a (possibly trailed) stop. A bar that
   * opens beyond the stop fills at its open (a gap); a bar that touches both stop and target is
   * counted as a stop (conservative). After +1.5 ATR the stop moves to break-even, and after that it
   * trails 2.5 ATR behind the best close (chandelier). Deterministic.
   * It resumes from the position's saved progress (`stop`, `best`, `checkedUntil`), so the live
   * autopilot can walk 1-minute bars incrementally. `trail: false` checks a still-forming bar for
   * stop / target / liquidation hits without trailing on its unfinished close.
   */
  function replayPosition(position, bars, { now = Infinity, costs = COSTS, timeStopHours = RULES.timeStopHours, trail = true } = {}) {
    const long = position.side === 'LONG';
    const atrValue = position.atr;
    let stop = finite(position.stop) ? position.stop : position.initialStop;
    let best = finite(position.best) ? position.best : position.entry;
    let lastPrice = position.entry;
    const from = Math.max(position.openedAt, finite(position.checkedUntil) ? position.checkedUntil : -Infinity);
    for (const bar of bars) {
      if (bar.t < from) continue;
      lastPrice = bar.c;
      const liq = position.liquidation;
      const hitStop = long ? bar.l <= stop : bar.h >= stop;
      const hitLiq = long ? bar.l <= liq : bar.h >= liq;
      const hitTarget = finite(position.target) && (long ? bar.h >= position.target : bar.l <= position.target);
      if (hitLiq && (long ? liq >= stop : liq <= stop)) return { exit: { price: liq, at: bar.t, reason: 'liquidated' }, stop, best, lastPrice };
      if (hitStop) {
        const gap = long ? bar.o < stop : bar.o > stop;
        const price = gap ? bar.o : stop;
        const reason = stop === position.initialStop ? 'stop loss' : 'trailing stop';
        return { exit: { price, at: bar.t, reason: gap ? `${reason} (gap)` : reason }, stop, best, lastPrice };
      }
      if (hitTarget) {
        const gap = long ? bar.o > position.target : bar.o < position.target;
        return { exit: { price: gap ? bar.o : position.target, at: bar.t, reason: 'take profit' }, stop, best, lastPrice };
      }
      if (!trail) continue;
      // Trail only on closes, after the bar is done.
      best = long ? Math.max(best, bar.c) : Math.min(best, bar.c);
      if (finite(atrValue) && atrValue > 0) {
        const moved = long ? best - position.entry : position.entry - best;
        if (moved >= 1.5 * atrValue) {
          const trail = long ? Math.max(position.entry, best - 2.5 * atrValue) : Math.min(position.entry, best + 2.5 * atrValue);
          stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
        }
      }
      if ((bar.t - position.openedAt) / HOUR >= timeStopHours && bar.t <= now) return { exit: { price: bar.c, at: bar.t, reason: 'time stop' }, stop, best, lastPrice };
    }
    return { exit: null, stop, best, lastPrice };
  }
  /** Unrealised result at `price`, after costs as if closed now. */
  function markPosition(position, price, now, costs = COSTS) {
    const result = settle(position, price, now, costs);
    return { price, pnl: result.pnl, equity: position.margin + result.pnl, returnOnMargin: result.pnl / position.margin };
  }

  // ---------- backtest and training ----------
  /**
   * Walks one strategy over one coin's bars with fixed risk per trade: a signal on bar i's close
   * enters at bar i+1's open; then replayPosition decides the exit on the bars after that. One
   * position at a time. Returns the trades with their R multiple (P&L / risk) after costs.
   */
  function backtest(candles, strategyName, params, { from = WARMUP, to = candles.length, costs = COSTS, ind = computeIndicators(candles), symbol = '' } = {}) {
    const strategy = STRATEGIES[strategyName];
    const trades = [];
    let i = Math.max(from, WARMUP);
    while (i < to - 1) {
      const signal = strategy.signal(candles, ind, i, params);
      if (!signal) { i += 1; continue; }
      const next = candles[i + 1];
      // Re-anchor the stop and target to the next bar's open (the real entry), keeping the distances.
      const shift = next.o - candles[i].c;
      const sized = sizePosition({ side: signal.side, price: next.o, stop: signal.stop + shift, target: signal.target + shift, riskAmount: 100, maxMargin: 1e9, maxLeverage: 1, costs });
      if (!sized) { i += 1; continue; }
      const position = { ...sized, openedAt: next.t, atr: ind.atr[i] };
      // The entry bar itself can stop out or hit the target after the open.
      const result = replayPosition(position, candles.slice(i + 1, to), { costs });
      if (!result.exit) break;                                          // still open at the end: not counted
      const outcome = settle(position, result.exit.price, result.exit.at, costs);
      trades.push({ symbol, strategy: strategyName, side: signal.side, openedAt: next.t, closedAt: result.exit.at, entry: position.entry, exit: outcome.exitFill, reason: result.exit.reason, r: outcome.r });
      const exitIndex = candles.findIndex(candle => candle.t === result.exit.at);
      i = Math.max(i + 1, exitIndex + 1);
    }
    return trades;
  }

  function evidence(rs, minTrades = RULES.minTrades) {
    const ci = bootstrapCI(rs);
    return { trades: rs.length, wins: rs.filter(r => r > 0).length, meanR: mean(rs), ci, open: rs.length >= minTrades && ci[0] > 0 };
  }

  /**
   * Walk-forward training over several coins. For each strategy: the parameter set with the best
   * mean R on the first `split` of every coin's history (needs 10+ trades), then the evidence gate
   * judged ONLY on the trades in the remaining, unseen part.
   */
  function train(candlesBySymbol, { split = .6, costs = COSTS, now = Date.now() } = {}) {
    const series = Object.entries(candlesBySymbol).filter(([, candles]) => candles.length > WARMUP + 50)
      .map(([symbol, candles]) => ({ symbol, candles, ind: computeIndicators(candles), cut: Math.floor(WARMUP + (candles.length - WARMUP) * split) }));
    const strategies = {};
    for (const name of Object.keys(STRATEGIES)) {
      let chosen = null;
      for (const params of STRATEGIES[name].grid) {
        const rs = series.flatMap(s => backtest(s.candles, name, params, { from: WARMUP, to: s.cut, costs, ind: s.ind, symbol: s.symbol })).map(trade => trade.r);
        const score = rs.length >= 10 ? mean(rs) : -Infinity;
        if (!chosen || score > chosen.score) chosen = { params, score, inSample: rs.length };
      }
      const outTrades = series.flatMap(s => backtest(s.candles, name, chosen.params, { from: s.cut, to: s.candles.length, costs, ind: s.ind, symbol: s.symbol }));
      const gate = evidence(outTrades.map(trade => trade.r));
      strategies[name] = { label: STRATEGIES[name].label, params: chosen.params, inSampleTrades: chosen.inSample, inSampleMeanR: finite(chosen.score) ? chosen.score : null, gate };
    }
    const bars = series.reduce((sum, s) => sum + s.candles.length, 0);
    return { trainedAt: now, symbols: series.map(s => s.symbol), bars, split, strategies };
  }

  // ---------- portfolio decisions ----------
  /**
   * Whether a new trade may open, and with what limits. `book` is 'gated' (the strategy's evidence
   * gate is open) or 'learning'. Returns { ok, reasons, riskAmount, maxMargin, maxLeverage }.
   */
  function admit({ account, positions, symbol, side, book, now, lastLossAt = {}, rules = RULES, equity }) {
    const reasons = [];
    const open = Object.values(positions);
    if (account.halted) reasons.push('kill-switch: account halted');
    if (open.length >= rules.maxOpen) reasons.push(`already ${open.length} open positions (max ${rules.maxOpen})`);
    if (open.some(held => held.symbol === symbol)) reasons.push('already a position on this coin');
    const lastLoss = lastLossAt[symbol];
    if (lastLoss && now - lastLoss < rules.cooldownHours * HOUR) reasons.push(`cool-down after a loss (${rules.cooldownHours} h)`);
    const day = new Date(now).toISOString().slice(0, 10);
    if (account.day === day && account.dayStartEquity > 0 && (equity - account.dayStartEquity) / account.dayStartEquity <= -rules.dailyLossPct) reasons.push(`daily loss limit (-${rules.dailyLossPct * 100}%) reached`);
    const riskPct = book === 'gated' ? rules.riskPct : rules.learnRiskPct;
    const riskAmount = riskPct * equity;
    const sideRisk = open.filter(held => held.side === side).reduce((sum, held) => sum + (held.risk || 0), 0);
    if (sideRisk + riskAmount > rules.maxSideRiskPct * equity) reasons.push(`too much ${side.toLowerCase()} risk at once (crypto moves together)`);
    const usedMargin = open.reduce((sum, held) => sum + held.margin, 0);
    const maxMargin = Math.min(rules.maxPositionPct * equity, rules.maxMarginPct * equity - usedMargin, account.cash);
    if (!(maxMargin > 0)) reasons.push('no free margin');
    return { ok: reasons.length === 0, reasons, riskAmount, maxMargin, maxLeverage: book === 'gated' ? rules.maxLeverage : rules.learnMaxLeverage };
  }

  // ---------- the real-money lock ----------
  /**
   * Real orders are locked. This lists what must ALL be true before the owner may even decide to
   * unlock them, so the board can show the honest distance. There is no order code in Metyu: when
   * every condition holds, the next step is still a deliberate, reviewed change by the owner,
   * starting at LIVE_LIMITS. `forward` is forwardEvidence() over the closed trades (in R).
   */
  const LIVE_LIMITS = Object.freeze({ maxOrderUsd: 25, maxDailyLossUsd: 50, maxOpenUsd: 100, maxLeverage: 1 });
  // The training period before real money may even be considered (the owner chose 3 days); the
  // trade count and the confidence interval still have to be met, however long it takes.
  const TRAINING_DAYS = 3;
  function liveReadiness({ forward, createdAt, account, accountLink, now = Date.now(), approval = null, minDays = TRAINING_DAYS }) {
    const days = createdAt ? (now - Date.parse(createdAt)) / DAY : 0;
    const drawdown = account && account.peak > 0 ? 1 - (account.equity ?? account.cash) / account.peak : 0;
    const conditions = [
      { id: 'days', ok: days >= minDays, text: `forward test ran ${minDays}+ days (now ${Math.floor(days)})` },
      { id: 'trades', ok: !!forward && forward.trades >= RULES.minTrades, text: `${RULES.minTrades}+ closed forward-test trades (now ${forward ? forward.trades : 0})` },
      { id: 'edge', ok: !!forward && forward.trades >= RULES.minTrades && forward.ci[0] > 0, text: `95% interval of the mean R above zero (now ${forward && forward.trades ? `[${forward.ci[0].toFixed(2)}, ${forward.ci[1].toFixed(2)}]` : 'no trades'})` },
      { id: 'risk', ok: !!account && !account.halted && drawdown < .1, text: `no kill-switch and drawdown under 10% (now ${(drawdown * 100).toFixed(1)}%)` },
      { id: 'account', ok: !!(accountLink && accountLink.linked && accountLink.viewOnly), text: 'a real exchange account linked with a verified view-only key' },
      { id: 'approval', ok: !!approval, text: "the owner's explicit approval, with the limits below" }
    ];
    const met = conditions.filter(c => c.ok).length;
    return { locked: true, met, total: conditions.length, ready: met === conditions.length, conditions, limits: LIVE_LIMITS };
  }

  return {
    LIVE_LIMITS, liveReadiness, TRAINING_DAYS,
    HOUR, DAY, SYMBOLS, KRAKEN_PAIRS, COSTS, RULES, WARMUP, STRATEGIES,
    createRng, bootstrapCI, mean,
    normaliseCandles, parseCoinbaseCandles, parseKrakenCandles, closedCandles, fetchCandles,
    sma, ema, rsi, atr, bollinger, macd, donchian, adx, computeIndicators, swingLevels, readChart,
    fillPrice, liquidationPrice, sizePosition, settle, replayPosition, markPosition,
    backtest, evidence, train, admit
  };
}));
