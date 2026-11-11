/*
 * Metyu — prediction-market paper-trading agent.
 *
 * Pure, dependency-free logic shared by the browser page (polymarket.html) and
 * the Node test suite (tests/metyu-agent.test.js). Nothing here touches a wallet,
 * an exchange, or real funds.
 *
 * Model of a binary market (Polymarket-style):
 *   - A YES share pays $1 if the event happens, $0 otherwise. NO pays the reverse.
 *   - YES price + NO price ≈ $1, so the YES price reads as an implied probability.
 *   - Expected value of buying YES at price c with true probability p:  EV = p - c per share.
 *
 * Leverage model (simulated margin account, not a Polymarket feature):
 *   margin M, leverage L → notional N = M·L, borrowed B = N − M, shares = N / entry.
 *   equity = shares·mark − B − interest.  Liquidated when equity ≤ maintenance · shares·mark.
 *   A binary that resolves against you marks to $0, so any leverage loses the whole margin.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Metyu = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-6;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const clampProb = p => clamp(p, .001, .999);
  const logit = p => Math.log(clampProb(p) / (1 - clampProb(p)));
  const sigmoid = x => 1 / (1 + Math.exp(-x));

  const DEFAULT_CONFIG = Object.freeze({
    kellyMultiplier: .25,     // fractional Kelly: full Kelly is too aggressive with estimation error
    maxLeverage: 3,
    minEdge: .03,             // required probability edge after costs (3 points)
    feeRate: .0,              // per-side fee as a fraction of notional
    maintenanceMargin: .05,   // equity / position value below this → liquidation (max leverage < 1/mm)
    stopLossPct: .35,         // close when the margin has lost this fraction
    maxDrawdownPct: .3,       // kill-switch on account drawdown from peak
    maxPositionPct: .2,       // never risk more than this share of equity as margin
    annualInterest: .12,      // borrow cost on leveraged notional
    researchWeight: .6,       // trust in research when only a 0–1 confidence is known
    marketVariance: .08,      // how far (log-odds²) the crowd price typically sits from the truth
    uncertaintyMultiple: 1.5, // extra edge demanded per 1σ of estimate uncertainty
    forceLeverage: false,     // demo mode: same margin, maxLeverage× notional (shows why that is a bad idea)
    momentumWeight: .15,      // log-odds tilt per unit of recent price momentum
    exitBuffer: .01,          // exit only once the edge is this far negative (avoids churning on noise)
    fadeWeight: .1            // pull-back applied when price is over-extended vs. its slow average
  });

  /** Seeded PRNG (mulberry32) so simulations and backtests are reproducible. */
  function createRng(seed) {
    let state = (seed >>> 0) || 1;
    const next = () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.normal = () => {
      const a = Math.max(EPS, next());
      const b = next();
      return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
    };
    return next;
  }

  /** Expected value per $1 share bought at `price` when the true probability of that side is `p`. */
  function expectedValue(p, price) { return p - price; }

  /**
   * Kelly fraction of bankroll for a binary share bought at `price` paying $1.
   * Net odds b = (1 − c)/c, so f* = (p·b − (1 − p)) / b = (p − c)/(1 − c).
   */
  function kellyFraction(p, price) {
    const c = clamp(price, EPS, 1 - EPS);
    return Math.max(0, (p - c) / (1 - c));
  }

  /** Exponential moving average of the last values. */
  function ema(values, span) {
    if (!values.length) return NaN;
    const alpha = 2 / (span + 1);
    return values.reduce((acc, value, index) => index === 0 ? value : acc + alpha * (value - acc), values[0]);
  }

  /**
   * Fair-probability estimate in log-odds space.
   *  - starts from the market's implied probability (the crowd is usually well calibrated),
   *  - blends in the agent's research reading when available,
   *  - adds a small momentum term (information diffuses slowly),
   *  - fades over-extension away from the slow average (overreaction).
   */
  function estimateFairProbability({ price, history = [], research = null, researchConfidence = 0, researchVariance = null }, config = DEFAULT_CONFIG) {
    let x = logit(price);
    let variance = config.marketVariance;
    const reasons = [`market implies ${(price * 100).toFixed(1)}%`];
    if (history.length >= 8) {
      const fast = ema(history.slice(-6), 5);
      const slow = ema(history.slice(-30), 20);
      const momentum = logit(fast) - logit(history[Math.max(0, history.length - 7)]);
      const extension = logit(fast) - logit(slow);
      const tilt = config.momentumWeight * momentum - config.fadeWeight * Math.max(0, Math.abs(extension) - .4) * Math.sign(extension);
      x += tilt;
      if (Math.abs(tilt) > .01) reasons.push(`${tilt > 0 ? 'momentum/flow up' : 'momentum fade / overextension'} (${tilt > 0 ? '+' : ''}${tilt.toFixed(2)} logit)`);
    }
    if (research !== null && researchVariance !== null && researchVariance > 0) {
      // Precision-weighted (Bayesian) combination of two noisy estimates of the same quantity.
      const weight = config.marketVariance / (config.marketVariance + researchVariance);
      x = (1 - weight) * x + weight * logit(research);
      variance = 1 / (1 / config.marketVariance + 1 / researchVariance);
      reasons.push(`research says ${(research * 100).toFixed(1)}% (precision weight ${(weight * 100).toFixed(0)}%)`);
    } else if (research !== null && researchConfidence > 0) {
      const weight = clamp(config.researchWeight * researchConfidence, 0, .95);
      x = (1 - weight) * x + weight * logit(research);
      variance = config.marketVariance * (1 - weight);
      reasons.push(`research says ${(research * 100).toFixed(1)}% (weight ${(weight * 100).toFixed(0)}%)`);
    }
    const probability = clampProb(sigmoid(x));
    // Delta method: σ_p ≈ p(1−p)·σ_x
    return { probability, uncertainty: probability * (1 - probability) * Math.sqrt(variance), reasons };
  }

  /** Opens a simulated leveraged position. side: 'YES' | 'NO'. yesPrice: current YES ask/mid. */
  function openPosition({ side, yesPrice, margin, leverage, spread = 0, feeRate = 0, time = 0 }) {
    const lev = Math.max(1, leverage);
    const sidePrice = side === 'YES' ? yesPrice : 1 - yesPrice;
    const entry = clamp(sidePrice + spread / 2, .001, .999);
    const notional = margin * lev;
    const fee = notional * feeRate;
    const shares = (notional - fee) / entry;
    return { side, entry, margin, leverage: lev, notional, borrowed: notional - margin, shares, interest: 0, openedAt: time, fees: fee };
  }

  function sidePriceOf(position, yesPrice) { return position.side === 'YES' ? yesPrice : 1 - yesPrice; }

  /** Mark-to-market. `exit` applies half the spread against you. */
  function markPosition(position, yesPrice, { spread = 0, feeRate = 0 } = {}) {
    const mark = clamp(sidePriceOf(position, yesPrice) - spread / 2, 0, 1);
    const value = position.shares * mark;
    const exitFee = value * feeRate;
    const equity = value - exitFee - position.borrowed - position.interest;
    const pnl = equity - position.margin;
    return { mark, value, equity, pnl, returnOnMargin: pnl / position.margin };
  }

  /** Side price at which equity / value hits the maintenance margin. */
  function liquidationPrice(position, maintenanceMargin = DEFAULT_CONFIG.maintenanceMargin) {
    if (position.borrowed + position.interest <= 0) return 0;
    return clamp((position.borrowed + position.interest) / (position.shares * (1 - maintenanceMargin)), 0, 1);
  }

  function accrueInterest(position, dtYears, annualRate) {
    position.interest += position.borrowed * annualRate * dtYears;
    return position;
  }

  /**
   * The decision function. Returns { action, side?, margin?, leverage?, reasons[], fair, edge }.
   * actions: 'HOLD' | 'OPEN' | 'CLOSE' | 'HALT'
   */
  function decide(state, userConfig = {}) {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const { yesPrice, spread = .01, history = [], research = null, researchConfidence = 0, researchVariance = null, equity, peakEquity, position = null, volatility = .05, timeLeft = 1 } = state;
    const estimate = estimateFairProbability({ price: yesPrice, history, research, researchConfidence, researchVariance }, config);
    const fair = estimate.probability;
    const reasons = [...estimate.reasons];
    const cost = spread / 2 + config.feeRate;
    const yesEdge = fair - (yesPrice + cost);
    const noEdge = (1 - fair) - (1 - yesPrice + cost);

    const drawdown = peakEquity > 0 ? 1 - equity / peakEquity : 0;
    if (drawdown >= config.maxDrawdownPct) {
      reasons.push(`KILL-SWITCH: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${(config.maxDrawdownPct * 100).toFixed(0)}% limit`);
      return { action: position ? 'CLOSE' : 'HALT', reasons, fair, edge: 0 };
    }

    if (position) {
      const marked = markPosition(position, yesPrice, { spread, feeRate: config.feeRate });
      const sideFair = position.side === 'YES' ? fair : 1 - fair;
      const remainingEdge = sideFair - marked.mark;
      const liq = liquidationPrice(position, config.maintenanceMargin);
      // On an unlevered binary a price-based stop sells a still-positive-EV share at a loss.
      // Stops are for leverage (avoid liquidation) or for a broken thesis (edge below threshold).
      if (marked.returnOnMargin <= -config.stopLossPct && (position.leverage > 1 || remainingEdge < config.minEdge)) {
        reasons.push(`stop-loss: margin down ${(-marked.returnOnMargin * 100).toFixed(1)}%${position.leverage > 1 ? ' on leverage' : ' and thesis weakened'}`);
        return { action: 'CLOSE', reasons, fair, edge: remainingEdge };
      }
      if (liq > 0 && marked.mark - liq < .03) {
        reasons.push(`liquidation risk: mark ${marked.mark.toFixed(3)} near liq ${liq.toFixed(3)} — cut before forced exit`);
        return { action: 'CLOSE', reasons, fair, edge: remainingEdge };
      }
      if (remainingEdge <= -config.exitBuffer) {
        reasons.push(`edge gone: fair ${(sideFair * 100).toFixed(1)}% vs mark ${(marked.mark * 100).toFixed(1)}% — take the result`);
        return { action: 'CLOSE', reasons, fair, edge: remainingEdge };
      }
      if (position.leverage > 1 && timeLeft < .08) {
        reasons.push('resolution close: binary jumps to $0/$1 — never hold leverage into resolution');
        return { action: 'CLOSE', reasons, fair, edge: remainingEdge };
      }
      reasons.push(`hold: remaining edge ${(remainingEdge * 100).toFixed(1)} pts, uP&L ${(marked.returnOnMargin * 100).toFixed(1)}%`);
      return { action: 'HOLD', reasons, fair, edge: remainingEdge };
    }

    const side = yesEdge >= noEdge ? 'YES' : 'NO';
    const edge = Math.max(yesEdge, noEdge);
    const threshold = Math.max(config.minEdge, config.uncertaintyMultiple * estimate.uncertainty);
    if (edge < threshold) {
      reasons.push(`no trade: best edge ${(edge * 100).toFixed(1)} pts < ${(threshold * 100).toFixed(1)} pt threshold (±${(estimate.uncertainty * 100).toFixed(1)} pts uncertainty)`);
      return { action: 'HOLD', reasons, fair, edge };
    }
    const price = side === 'YES' ? yesPrice + cost : 1 - yesPrice + cost;
    const sideProb = side === 'YES' ? fair : 1 - fair;
    const kelly = kellyFraction(sideProb, price);
    const exposure = kelly * config.kellyMultiplier;               // fraction of equity as notional
    // Leverage is earned, not assumed: scale it with edge/volatility and cut it near resolution.
    const signalToNoise = edge / Math.max(volatility, .01);
    let leverage = clamp(Math.floor(1 + signalToNoise), 1, config.maxLeverage);
    if (timeLeft < .25) leverage = 1;
    // Normal mode keeps the Kelly notional and uses leverage only to post less margin.
    // forceLeverage mimics what people actually do: same margin, L× the notional.
    if (config.forceLeverage) leverage = Math.max(1, config.maxLeverage);
    const margin = config.forceLeverage
      ? Math.min(equity * config.maxPositionPct, equity * exposure)
      : Math.min(equity * config.maxPositionPct, equity * exposure / leverage);
    if (margin < 1) {
      reasons.push('no trade: Kelly size below $1');
      return { action: 'HOLD', reasons, fair, edge };
    }
    reasons.push(`${side} edge ${(edge * 100).toFixed(1)} pts · Kelly ${(kelly * 100).toFixed(1)}% × ${config.kellyMultiplier} · ${leverage}x (edge/vol ${signalToNoise.toFixed(2)})`);
    return { action: 'OPEN', side, margin, leverage, reasons, fair, edge };
  }

  /**
   * Hidden-truth market generator. The true probability walks in log-odds space with
   * occasional news jumps; the market price chases it with lag and noise; the outcome is
   * drawn from the final true probability.
   */
  /** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
  function normalCdf(z) {
    const t = 1 / (1 + .3275911 * Math.abs(z) / Math.SQRT2);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? .5 * (1 + erf) : .5 * (1 - erf);
  }

  /** Inverse standard normal CDF (Acklam's rational approximation). */
  function normalInv(p) {
    const q = clamp(p, 1e-9, 1 - 1e-9);
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155211977];
    const c = [-.007784894002430293, -.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [.007784695709041462, .3224671290700398, 2.445134137142996, 3.754408661907416];
    const low = .02425;
    if (q < low) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
    if (q > 1 - low) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
    const r = (q - .5) * (q - .5);
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * (q - .5) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /**
   * Hidden-truth market generator.
   * A latent score X drifts as a random walk with occasional news jumps; the event happens iff
   * X ends above zero. The true probability at time t is therefore P(X_T > 0 | X_t) =
   * Φ(X_t / σ_remaining) — a proper martingale that converges to 0 or 1 as resolution nears,
   * exactly like a well-informed price should. The market price chases that truth with lag and
   * noise, and news jumps gap the price immediately (no chance to exit in between).
   */
  function createMarket({ seed = 1, steps = 160, startProb = .5, volatility = .06, efficiency = .18, jumpRate = .03, jumpSize = .9, jumpPassThrough = .6 } = {}) {
    const rng = createRng(seed);
    const stepVar = volatility * volatility + jumpRate * jumpSize * jumpSize;
    const truthAt = (x, step) => clampProb(normalCdf(x / Math.sqrt(Math.max(stepVar * (steps - step), 1e-9))));
    let latent = normalInv(clampProb(startProb)) * Math.sqrt(stepVar * steps);
    let truthNow = truthAt(latent, 0);
    let price = clamp(truthNow + rng.normal() * .04, .01, .99);
    const truth = [];
    const prices = [];
    for (let step = 1; step <= steps; step += 1) {
      const jump = rng() < jumpRate ? rng.normal() * jumpSize : 0;
      latent += rng.normal() * volatility + jump;
      const next = step === steps ? (latent > 0 ? .999 : .001) : truthAt(latent, step);
      if (jump) price += jumpPassThrough * (next - truthNow);
      price = clamp(price + efficiency * (next - price) + rng.normal() * volatility * .12, .01, .99);
      truthNow = next;
      truth.push(truthNow);
      prices.push(price);
    }
    // The final reading is the resolved outcome; trading stops one step earlier.
    const outcome = latent > 0 ? 'YES' : 'NO';
    truth.pop();
    prices.pop();
    return { truth, prices, outcome, seed };
  }

  /** Research reading: truth plus noise that shrinks with skill (0 = pure noise, 1 = sharp). */
  function researchSignal(truth, skill, rng) {
    return clampProb(sigmoid(logit(truth) + rng.normal() * researchNoise(skill)));
  }

  /**
   * Information arrives faster as resolution approaches: the log-odds of a well-informed
   * probability move roughly ∝ 1 / time-left. Calibrated on the simulator (≈ .022 / timeLeft).
   */
  function processVarianceAt(timeLeft, base = .022) { return base / Math.max(timeLeft, .02); }

  /** Log-odds noise of one research reading for a given skill (0 = pure noise, 1 = sharp). */
  function researchNoise(skill) { return (1 - clamp(skill, 0, 1)) * 1.6 + .05; }

  /**
   * Kalman filter over research readings in log-odds space. The hidden probability drifts
   * (processVar per step), each reading is noisy (measurementVar). The filter weighs fresh
   * evidence against stale belief optimally — a plain moving average lags the market and
   * ends up betting against news the crowd has already priced.
   */
  function createEvidence({ processVar = .03, measurementVar = .25 } = {}) {
    let mean = null;
    let variance = 1;
    return {
      add(reading, stepProcessVar = processVar) {
        const x = logit(reading);
        if (mean === null) { mean = x; variance = measurementVar; }
        else {
          variance += stepProcessVar;
          const gain = variance / (variance + measurementVar);
          mean += gain * (x - mean);
          variance *= 1 - gain;
        }
        return { probability: sigmoid(mean), confidence: clamp(1 - Math.sqrt(variance) / 1.2, 0, 1), variance };
      },
      reset() { mean = null; variance = 1; }
    };
  }

  /** Runs the agent over one market. Returns equity path, trades and Brier score. */
  function runAgentOnMarket(market, { bankroll = 1000, skill = .5, config = {}, seed = 7, spread = .02 } = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const rng = createRng(seed ^ market.seed);
    const evidence = createEvidence({ processVar: .03, measurementVar: Math.pow(researchNoise(skill), 2) });
    let cash = bankroll;
    let peak = bankroll;
    let position = null;
    let halted = false;
    const trades = [];
    const equityPath = [];
    let brier = 0;
    const steps = market.prices.length;
    const dtYears = 1 / 365;
    const closeAt = (step, yesPrice, reason) => {
      const marked = markPosition(position, yesPrice, { spread, feeRate: cfg.feeRate });
      const payout = reason === 'LIQUIDATED' ? 0 : Math.max(0, marked.equity);
      cash += payout;
      trades.push({ step, side: position.side, leverage: position.leverage, margin: position.margin, pnl: payout - position.margin, reason });
      position = null;
    };
    for (let step = 0; step < steps; step += 1) {
      const yesPrice = market.prices[step];
      if (position) {
        accrueInterest(position, dtYears, cfg.annualInterest);
        const liq = liquidationPrice(position, cfg.maintenanceMargin);
        if (liq > 0 && sidePriceOf(position, yesPrice) <= liq) closeAt(step, yesPrice, 'LIQUIDATED');
      }
      const equity = cash + (position ? Math.max(0, markPosition(position, yesPrice, { spread }).equity) : 0);
      peak = Math.max(peak, equity);
      equityPath.push(equity);
      const belief = skill > 0 ? evidence.add(researchSignal(market.truth[step], skill, rng), processVarianceAt(1 - step / steps)) : { probability: null, confidence: 0, variance: null };
      const decision = halted ? { action: 'HALT', fair: yesPrice } : decide({
        yesPrice, spread, history: market.prices.slice(Math.max(0, step - 40), step + 1), research: belief.probability, researchVariance: belief.variance,
        equity, peakEquity: peak, position, volatility: .05, timeLeft: 1 - step / steps
      }, cfg);
      brier += Math.pow(decision.fair - (market.outcome === 'YES' ? 1 : 0), 2);
      if (decision.action === 'HALT') halted = true;
      if (decision.action === 'CLOSE' && position) { closeAt(step, yesPrice, decision.reasons[decision.reasons.length - 1]); if (decision.reasons.some(r => r.startsWith('KILL'))) halted = true; }
      if (decision.action === 'OPEN' && !position && decision.margin <= cash) {
        position = openPosition({ side: decision.side, yesPrice, margin: decision.margin, leverage: decision.leverage, spread, feeRate: cfg.feeRate, time: step });
        cash -= decision.margin;
      }
    }
    if (position) {
      // Resolution: winning side pays $1 per share, losing side $0.
      const settle = position.side === market.outcome ? 1 : 0;
      const payout = Math.max(0, position.shares * settle - position.borrowed - position.interest);
      cash += payout;
      trades.push({ step: steps, side: position.side, leverage: position.leverage, margin: position.margin, pnl: payout - position.margin, reason: 'RESOLVED' });
      position = null;
    }
    equityPath.push(cash);
    return { finalEquity: cash, equityPath, trades, brier: brier / steps, halted };
  }

  /** Monte Carlo across many markets for one configuration. */
  function backtest({ markets = 200, bankroll = 1000, skill = .5, config = {}, seed = 42 } = {}) {
    let equity = bankroll;
    let peak = bankroll;
    let maxDrawdown = 0;
    let wins = 0;
    let tradeCount = 0;
    let liquidations = 0;
    let brier = 0;
    const rng = createRng(seed);
    for (let index = 0; index < markets; index += 1) {
      if (equity < 1) break;
      const market = createMarket({ seed: Math.floor(rng() * 2 ** 31), startProb: .15 + rng() * .7 });
      const result = runAgentOnMarket(market, { bankroll: equity, skill, config, seed: index + 1 });
      equity = result.finalEquity;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
      brier += result.brier;
      result.trades.forEach(trade => { tradeCount += 1; if (trade.pnl > 0) wins += 1; if (trade.reason === 'LIQUIDATED') liquidations += 1; });
    }
    return {
      finalEquity: equity,
      totalReturn: equity / bankroll - 1,
      maxDrawdown,
      ruined: equity < bankroll * .05,
      trades: tradeCount,
      winRate: tradeCount ? wins / tradeCount : 0,
      liquidations,
      brier: brier / markets
    };
  }

  /** Normalises a CLOB order book side ([{price, size}] strings or numbers) sorted best-first. */
  function normaliseLevels(levels, side = 'asks') {
    const clean = (Array.isArray(levels) ? levels : [])
      .map(level => ({ price: Number(level.price), size: Number(level.size) }))
      .filter(level => level.price > 0 && level.price < 1 && level.size > 0);
    return clean.sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price);
  }

  /**
   * Walks the ask side of an order book to spend `notional` dollars on shares.
   * Returns the volume-weighted average price, shares bought, dollars left unfilled,
   * the worst price touched and how many levels were consumed.
   */
  function fillFromBook(asks, notional) {
    const levels = normaliseLevels(asks, 'asks');
    let remaining = notional;
    let shares = 0;
    let worst = 0;
    let used = 0;
    for (const level of levels) {
      if (remaining <= 1e-9) break;
      const cost = Math.min(remaining, level.price * level.size);
      shares += cost / level.price;
      remaining -= cost;
      worst = level.price;
      used += 1;
    }
    const spent = notional - remaining;
    return {
      averagePrice: shares > 0 ? spent / shares : NaN,
      shares, spent, unfilled: Math.max(0, remaining), worstPrice: worst, levelsUsed: used,
      bestAsk: levels.length ? levels[0].price : NaN,
      depth: levels.reduce((sum, level) => sum + level.price * level.size, 0)
    };
  }

  /**
   * Portfolio guard for many simultaneous positions: caps a new position's margin so total
   * notional stays within maxGross × equity and the number of open positions within maxOpen.
   * Returns { margin, reason } — margin 0 means the trade must be skipped.
   */
  function capToPortfolio({ equity, openNotional = 0, openCount = 0, margin, leverage = 1, maxGross = 1.5, maxOpen = 6 }) {
    if (openCount >= maxOpen) return { margin: 0, reason: `max ${maxOpen} open positions reached` };
    const room = maxGross * equity - openNotional;
    const lev = Math.max(1, leverage);
    if (room < lev) return { margin: 0, reason: `gross exposure cap ${maxGross}x of equity reached` };
    if (margin * lev > room) return { margin: room / lev, reason: `size cut to stay within ${maxGross}x gross exposure` };
    return { margin, reason: null };
  }

  /** How sure the user is about their own estimate → log-odds variance of that estimate. */
  const CONFIDENCE_VARIANCE = Object.freeze({ low: .6, medium: .2, high: .06 });

  /**
   * Live-market advisor: given a real YES price and the user's own probability estimate,
   * returns Metyu's verdict plus the numbers a trader should see before clicking anything.
   * daysLeft maps to the decision's time-to-resolution (leverage is cut inside ~7 days).
   */
  function advise({ yesPrice, spread = .02, belief, confidence = 'medium', beliefVariance = null, bankroll = 1000, daysLeft = 30, peakEquity = null, book = null }, userConfig = {}) {
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    const researchVariance = Number.isFinite(beliefVariance) && beliefVariance > 0 ? beliefVariance : (CONFIDENCE_VARIANCE[confidence] ?? CONFIDENCE_VARIANCE.medium);
    const timeLeft = clamp(daysLeft / 30, 0, 1);
    const decision = decide({
      yesPrice, spread, research: clampProb(belief), researchVariance,
      equity: bankroll, peakEquity: peakEquity ?? bankroll, volatility: .05, timeLeft
    }, config);
    const result = { ...decision, yesPrice, belief: clampProb(belief), daysLeft };
    if (decision.action !== 'OPEN') return result;
    const sideFair = decision.side === 'YES' ? decision.fair : 1 - decision.fair;
    let margin = decision.margin;
    let bookFill = null;
    const asks = book && book[decision.side];
    if (asks) {
      // Real execution: walk the order book. Shrink the order until the average fill keeps the edge.
      let notional = margin * decision.leverage;
      bookFill = fillFromBook(asks, notional);
      for (let attempt = 0; attempt < 12 && (bookFill.unfilled > .01 || sideFair - bookFill.averagePrice < config.minEdge) && notional > 1; attempt += 1) {
        notional *= .6;
        bookFill = fillFromBook(asks, notional);
      }
      const edgeAfterFill = sideFair - bookFill.averagePrice;
      if (!(bookFill.shares > 0) || bookFill.unfilled > .01 || edgeAfterFill < config.minEdge || notional < 1) {
        const best = Number.isFinite(bookFill.bestAsk) ? `${(bookFill.bestAsk * 100).toFixed(1)}¢` : 'none';
        const after = Number.isFinite(edgeAfterFill) ? `${(edgeAfterFill * 100).toFixed(1)} pts` : 'n/a';
        return { ...result, action: 'HOLD', bookFill, reasons: [...decision.reasons, `order book too thin: best ask ${best}, edge after fill ${after} < ${(config.minEdge * 100).toFixed(1)}`] };
      }
      if (notional < margin * decision.leverage - .01) {
        margin = notional / decision.leverage;
        result.reasons = [...decision.reasons, `size cut to $${notional.toFixed(2)} notional so the book fill keeps the edge`];
      }
    }
    const position = openPosition({ side: decision.side, yesPrice, margin, leverage: decision.leverage, spread, feeRate: config.feeRate });
    if (bookFill) {
      // Replace the quote-based fill with the order-book fill.
      position.entry = bookFill.averagePrice;
      position.shares = bookFill.shares * (1 - config.feeRate);
    }
    return {
      ...result,
      margin,
      bookFill,
      entry: position.entry,
      shares: position.shares,
      notional: position.notional,
      liquidation: liquidationPrice(position, config.maintenanceMargin),
      payoutIfRight: position.shares - position.borrowed,
      maxLoss: position.margin,
      expectedProfit: position.shares * sideFair - position.notional,
      breakevenProbability: position.entry
    };
  }

  /** Normalises a Polymarket Gamma API market object into { id, question, yesPrice, ... }. */
  function parseGammaMarket(raw) {
    const parse = value => { if (Array.isArray(value)) return value; try { return JSON.parse(value); } catch (error) { return []; } };
    const outcomes = parse(raw.outcomes).map(String);
    const prices = parse(raw.outcomePrices).map(Number);
    const yesIndex = outcomes.findIndex(name => name.toLowerCase() === 'yes');
    if (outcomes.length !== 2 || prices.length !== 2 || prices.some(value => !Number.isFinite(value))) return null;
    const yesPrice = prices[yesIndex >= 0 ? yesIndex : 0];
    if (!(yesPrice > 0 && yesPrice < 1)) return null;
    const bid = Number(raw.bestBid);
    const ask = Number(raw.bestAsk);
    return {
      id: String(raw.id ?? raw.slug ?? raw.question),
      question: String(raw.question || 'Untitled market'),
      slug: raw.slug ? String(raw.slug) : '',
      outcomes: yesIndex >= 0 ? ['Yes', 'No'] : outcomes,
      yesPrice,
      spread: Number.isFinite(bid) && Number.isFinite(ask) && ask > bid ? ask - bid : .02,
      volume: Number(raw.volumeNum ?? raw.volume) || 0,
      liquidity: Number(raw.liquidityNum ?? raw.liquidity) || 0,
      endDate: raw.endDate ? String(raw.endDate) : '',
      tokenIds: (() => {
        const ids = parse(raw.clobTokenIds).map(String);
        if (ids.length !== 2 || !ids.every(id => /^[0-9]{1,100}$/.test(id))) return null;
        const y = yesIndex >= 0 ? yesIndex : 0;
        return { YES: ids[y], NO: ids[1 - y] };
      })()
    };
  }

  /**
   * Reads a Gamma API market that may have closed. Returns null while it is open,
   * { outcome: 'YES' | 'NO' } once settled, or { outcome: null } if closed but not cleanly
   * settled yet (e.g. a resolution still under dispute).
   */
  function parseGammaResolution(raw) {
    if (!raw || !(raw.closed === true || raw.closed === 'true')) return null;
    const parse = value => { if (Array.isArray(value)) return value; try { return JSON.parse(value); } catch (error) { return []; } };
    const outcomes = parse(raw.outcomes).map(String);
    const prices = parse(raw.outcomePrices).map(Number);
    if (outcomes.length !== 2 || prices.length !== 2) return { outcome: null };
    const yesIndex = outcomes.findIndex(name => name.toLowerCase() === 'yes');
    const yes = prices[yesIndex >= 0 ? yesIndex : 0];
    if (yes >= .99) return { outcome: 'YES' };
    if (yes <= .01) return { outcome: 'NO' };
    return { outcome: null };
  }

  /** Settles a (possibly leveraged) position at resolution: winners get $1/share, losers $0. */
  function settlePosition(position, outcome) {
    const perShare = position.side === outcome ? 1 : 0;
    const payout = Math.max(0, position.shares * perShare - (position.borrowed || 0) - (position.interest || 0));
    return { payout, pnl: payout - position.margin };
  }

  // ---------------------------------------------------------------------------
  // Training on resolved markets (virtual money only)
  // ---------------------------------------------------------------------------

  /** A closed Gamma market → { id, question, endTs, outcome, yesToken } for training, or null. */
  function parseResolvedForTraining(raw) {
    const resolution = parseGammaResolution(raw);
    if (!resolution || !resolution.outcome) return null;
    const parse = value => { if (Array.isArray(value)) return value; try { return JSON.parse(value); } catch (error) { return []; } };
    const outcomes = parse(raw.outcomes).map(String);
    const tokens = parse(raw.clobTokenIds).map(String);
    if (tokens.length !== 2 || !tokens.every(id => /^[0-9]{1,100}$/.test(id))) return null;
    const yesIndex = Math.max(0, outcomes.findIndex(name => name.toLowerCase() === 'yes'));
    const endMs = Date.parse(raw.closedTime || raw.endDate || '');
    if (!Number.isFinite(endMs)) return null;
    return { id: String(raw.id), question: String(raw.question || 'Resolved market'), endTs: Math.floor(endMs / 1000), outcome: resolution.outcome, yesToken: tokens[yesIndex] };
  }

  /** Last price at or before `ts` in a [{t, p}] history sorted by t; null if none. */
  function priceAt(history, ts) {
    let found = null;
    for (const point of history) {
      if (point.t > ts) break;
      found = point.p;
    }
    return found;
  }

  /** Cleans a CLOB prices-history payload into [{t (seconds), p}] sorted by time. */
  function normaliseHistory(raw) {
    const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.history) ? raw.history : []);
    return rows
      .map(point => ({ t: Number(point.t), p: Number(point.p) }))
      .filter(point => Number.isFinite(point.t) && point.p > 0 && point.p < 1)
      .sort((a, b) => a.t - b.t);
  }

  /**
   * One training sample per (market, horizon): the YES price `horizon` days before the
   * market ended, and whether YES won. markets: [{ id, endTs (s), outcome, history }].
   */
  function buildTrainingSamples(markets, horizons = [1, 7, 30]) {
    const samples = [];
    for (const market of markets) {
      if (market.outcome !== 'YES' && market.outcome !== 'NO') continue;
      const history = market.history || [];
      if (!history.length) continue;
      for (const horizon of horizons) {
        const ts = market.endTs - horizon * 86400;
        if (history[0].t > ts) continue;            // market did not exist yet
        const p = priceAt(history, ts);
        if (p === null) continue;
        samples.push({ marketId: market.id, endTs: market.endTs, horizon, p: clampProb(p), y: market.outcome === 'YES' ? 1 : 0 });
      }
    }
    return samples;
  }

  /**
   * Logistic recalibration of market prices:  P(YES) = σ(a + b · logit(price)).
   * a = 0, b = 1 means the crowd is calibrated. b > 1 means prices are too timid
   * (longshots overpriced, favourites underpriced). Fitted by Newton–Raphson with a
   * small ridge penalty pulling toward the calibrated (0, 1) prior; returns the
   * parameter covariance so predictions carry an honest uncertainty.
   */
  function fitCalibration(samples, { l2 = 1, iterations = 30 } = {}) {
    let a = 0;
    let b = 1;
    let cov = [[1, 0], [0, 1]];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let ga = -l2 * a;
      let gb = -l2 * (b - 1);
      let haa = l2;
      let hab = 0;
      let hbb = l2;
      for (const sample of samples) {
        const x = logit(sample.p);
        const q = sigmoid(a + b * x);
        const w = q * (1 - q);
        ga += sample.y - q;
        gb += (sample.y - q) * x;
        haa += w;
        hab += w * x;
        hbb += w * x * x;
      }
      const det = haa * hbb - hab * hab;
      if (!(det > 0)) break;
      cov = [[hbb / det, -hab / det], [-hab / det, haa / det]];
      const da = cov[0][0] * ga + cov[0][1] * gb;
      const db = cov[1][0] * ga + cov[1][1] * gb;
      a += da;
      b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return { a, b, cov, n: samples.length };
  }

  /** Model probability for a market price plus the log-odds variance of that estimate. */
  function predictCalibrated(model, price) {
    const x = logit(price);
    const variance = model.cov[0][0] + 2 * x * model.cov[0][1] + x * x * model.cov[1][1];
    return { probability: clampProb(sigmoid(model.a + model.b * x)), variance: Math.max(1e-6, variance) };
  }

  function brierScore(pairs) {
    return pairs.length ? pairs.reduce((sum, [forecast, outcome]) => sum + Math.pow(forecast - outcome, 2), 0) / pairs.length : NaN;
  }

  function logLoss(pairs) {
    return pairs.length ? -pairs.reduce((sum, [forecast, outcome]) => sum + (outcome ? Math.log(clampProb(forecast)) : Math.log(1 - clampProb(forecast))), 0) / pairs.length : NaN;
  }

  /** Reliability table: for each probability bin, mean forecast vs observed frequency. */
  function reliability(pairs, bins = 10) {
    const table = Array.from({ length: bins }, (_, index) => ({ from: index / bins, to: (index + 1) / bins, n: 0, forecast: 0, observed: 0 }));
    for (const [forecast, outcome] of pairs) {
      const row = table[Math.min(bins - 1, Math.floor(forecast * bins))];
      row.n += 1; row.forecast += forecast; row.observed += outcome;
    }
    return table.map(row => ({ ...row, forecast: row.n ? row.forecast / row.n : null, observed: row.n ? row.observed / row.n : null }));
  }

  /**
   * Time-ordered train/test split by market end date (no peeking at the future), fit on the
   * older markets, then paper-trade the newer ones with virtual money: at `tradeHorizon` days
   * before resolution Metyu asks advise() using the model as its belief, buys at the historical
   * price plus half the spread, and the position settles at the real outcome.
   */
  function trainAndEvaluate(markets, { horizons = [1, 7, 30], trainFraction = .7, tradeHorizon = 7, bankroll = 1000, spread = .02, config = {} } = {}) {
    const ordered = markets.filter(market => market.outcome === 'YES' || market.outcome === 'NO').slice().sort((x, y) => x.endTs - y.endTs);
    const cut = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * trainFraction)));
    const trainMarkets = ordered.slice(0, cut);
    const testMarkets = ordered.slice(cut);
    const trainSamples = buildTrainingSamples(trainMarkets, horizons);
    const testSamples = buildTrainingSamples(testMarkets, horizons);
    const model = fitCalibration(trainSamples);
    const marketPairs = testSamples.map(sample => [sample.p, sample.y]);
    const modelPairs = testSamples.map(sample => [predictCalibrated(model, sample.p).probability, sample.y]);

    let equity = bankroll;
    let peak = bankroll;
    let maxDrawdown = 0;
    const trades = [];
    for (const sample of testSamples.filter(item => item.horizon === tradeHorizon)) {
      if (equity < 1) break;
      const belief = predictCalibrated(model, sample.p);
      const advice = advise({ yesPrice: sample.p, spread, belief: belief.probability, beliefVariance: belief.variance, bankroll: equity, peakEquity: peak, daysLeft: tradeHorizon }, config);
      if (advice.action !== 'OPEN') continue;
      const position = openPosition({ side: advice.side, yesPrice: sample.p, margin: advice.margin, leverage: advice.leverage, spread });
      const { pnl } = settlePosition(position, sample.y ? 'YES' : 'NO');
      equity += pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
      trades.push({ marketId: sample.marketId, side: advice.side, price: sample.p, belief: belief.probability, leverage: advice.leverage, margin: advice.margin, pnl });
    }
    return {
      model,
      counts: { markets: ordered.length, trainMarkets: trainMarkets.length, testMarkets: testMarkets.length, trainSamples: trainSamples.length, testSamples: testSamples.length },
      test: {
        brierMarket: brierScore(marketPairs), brierModel: brierScore(modelPairs),
        logLossMarket: logLoss(marketPairs), logLossModel: logLoss(modelPairs),
        reliabilityMarket: reliability(marketPairs), reliabilityModel: reliability(modelPairs)
      },
      paper: { bankroll, finalEquity: equity, totalReturn: equity / bankroll - 1, maxDrawdown, trades, wins: trades.filter(trade => trade.pnl > 0).length }
    };
  }

  /**
   * Offline practice data: resolved markets from the simulator, with daily history.
   * `longshotBias` (0–1) compresses prices toward 50¢, the classic favourite–longshot
   * bias; 0 gives a calibrated crowd, where a trained model should find no edge.
   * (The lab's own lagging simulator prices are deliberately not used here: a trained
   * model does find that lag, which would hide the "no edge" control.)
   */
  function simulatedResolvedMarkets(count = 300, { seed = 11, longshotBias = 0, days = 60 } = {}) {
    const rng = createRng(seed);
    const startTs = 1.7e9;
    const markets = [];
    for (let index = 0; index < count; index += 1) {
      // No news jumps here: with pure Gaussian drift Φ(X/σ) is exactly the true probability.
      const sim = createMarket({ seed: Math.floor(rng() * 2 ** 31), steps: days + 1, startProb: .05 + rng() * .9, jumpRate: 0, volatility: .25 });
      const endTs = startTs + index * 86400 * 2 + days * 86400;
      // Base prices are the calibrated true probability (a perfectly efficient crowd);
      // the bias then distorts them the way real crowds overpay for longshots.
      const history = sim.truth.map((price, day) => {
        const biased = sigmoid(logit(price) * (1 - longshotBias));
        return { t: endTs - (days - day) * 86400, p: clamp(biased, .005, .995) };
      });
      markets.push({ id: `sim-${index}`, question: `Simulated market #${index + 1}`, endTs, outcome: sim.outcome, history });
    }
    return markets;
  }

  /**
   * RFC 4180 CSV with spreadsheet formula-injection protection: text cells that start with
   * = + - @ (or tab / carriage return) get a leading apostrophe, because market questions
   * come from outside and a spreadsheet would otherwise execute them as formulas.
   */
  function toCsv(rows, columns) {
    const cell = value => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(column => cell(column.label)).join(',')];
    for (const row of rows) lines.push(columns.map(column => cell(row[column.key])).join(','));
    return lines.join('\r\n');
  }

  return {
    DEFAULT_CONFIG, createRng, clamp, logit, sigmoid, normalCdf, normalInv, expectedValue, kellyFraction, ema,
    estimateFairProbability, createEvidence, researchNoise, processVarianceAt, openPosition, markPosition, liquidationPrice, accrueInterest,
    decide, advise, capToPortfolio, toCsv, parseGammaResolution, settlePosition, parseResolvedForTraining, priceAt, normaliseHistory, buildTrainingSamples, fitCalibration, predictCalibrated, brierScore, logLoss, reliability, trainAndEvaluate, simulatedResolvedMarkets, fillFromBook, normaliseLevels, CONFIDENCE_VARIANCE, createMarket, researchSignal, runAgentOnMarket, backtest, parseGammaMarket, sidePriceOf
  };
});
