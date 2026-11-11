// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../metyu-agent.js');

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test('Kelly fraction for binary shares', () => {
  close(M.kellyFraction(.6, .5), .2);           // (0.6 − 0.5) / 0.5
  close(M.kellyFraction(.5, .5), 0);
  close(M.kellyFraction(.3, .5), 0);            // negative edge → no bet
  close(M.expectedValue(.7, .55), .15, 1e-12);
});

test('leveraged position accounting and liquidation price', () => {
  const position = M.openPosition({ side: 'YES', yesPrice: .5, margin: 100, leverage: 4 });
  close(position.notional, 400);
  close(position.borrowed, 300);
  close(position.shares, 800);
  close(M.markPosition(position, .5).pnl, 0);
  close(M.markPosition(position, .55).pnl, 40);  // 800 × 0.05
  const liq = M.liquidationPrice(position, .25); // 300 / (800 × 0.75)
  close(liq, .5);
  const unlevered = M.openPosition({ side: 'NO', yesPrice: .3, margin: 70, leverage: 1 });
  close(unlevered.entry, .7);
  close(M.liquidationPrice(unlevered), 0);
  close(M.markPosition(unlevered, 0).pnl, 30);   // NO resolves to $1
});

test('no edge → no trade, positive edge → sized YES trade', () => {
  const base = { yesPrice: .5, spread: .02, equity: 1000, peakEquity: 1000, volatility: .05, timeLeft: 1 };
  assert.equal(M.decide(base).action, 'HOLD');
  const withResearch = M.decide({ ...base, research: .7, researchVariance: .02 });
  assert.equal(withResearch.action, 'OPEN');
  assert.equal(withResearch.side, 'YES');
  assert.ok(withResearch.margin > 0 && withResearch.margin <= 1000 * M.DEFAULT_CONFIG.maxPositionPct);
  assert.ok(withResearch.leverage >= 1 && withResearch.leverage <= M.DEFAULT_CONFIG.maxLeverage);
  const bearish = M.decide({ ...base, research: .3, researchVariance: .02 });
  assert.equal(bearish.side, 'NO');
});

test('uncertain research is ignored, kill-switch halts trading', () => {
  const base = { yesPrice: .5, spread: .02, equity: 1000, peakEquity: 1000, volatility: .05, timeLeft: 1 };
  assert.equal(M.decide({ ...base, research: .58, researchVariance: 2 }).action, 'HOLD');
  assert.equal(M.decide({ ...base, equity: 600, research: .9, researchVariance: .01 }).action, 'HALT');
});

test('never holds leverage into resolution', () => {
  const position = M.openPosition({ side: 'YES', yesPrice: .5, margin: 100, leverage: 3 });
  const decision = M.decide({ yesPrice: .52, spread: .02, equity: 1000, peakEquity: 1000, position, timeLeft: .05, research: .7, researchVariance: .02 });
  assert.equal(decision.action, 'CLOSE');
});

test('Kalman evidence tracks a moving truth', () => {
  const evidence = M.createEvidence({ processVar: .03, measurementVar: .04 });
  for (let i = 0; i < 20; i += 1) evidence.add(.3);
  let belief;
  for (let i = 0; i < 10; i += 1) belief = evidence.add(.7);
  assert.ok(belief.probability > .6, `belief ${belief.probability} should follow fresh evidence`);
});

test('backtest: no information means no trades, skill helps', () => {
  const noInfo = M.backtest({ markets: 60, skill: 0, seed: 1 });
  assert.equal(noInfo.trades, 0);
  const skilled = M.backtest({ markets: 80, skill: .8, seed: 1 });
  assert.ok(skilled.totalReturn > 0, `skilled return ${skilled.totalReturn}`);
});

test('backtest: Metyu rules survive where reckless leverage is ruined', () => {
  for (const seed of [2024, 7, 99]) {
    const disciplined = M.backtest({ markets: 150, skill: .3, seed });
    const reckless = M.backtest({ markets: 150, skill: .3, seed, config: { minEdge: 0, uncertaintyMultiple: 0, maxLeverage: 10, forceLeverage: true, maxDrawdownPct: 1 } });
    assert.ok(!disciplined.ruined && disciplined.maxDrawdown < .2, `disciplined dd ${disciplined.maxDrawdown}`);
    assert.ok(reckless.ruined, `reckless return ${reckless.totalReturn}`);
    assert.ok(reckless.liquidations > 0);
  }
});

test('true probability in the simulator is calibrated (a martingale that resolves to 0/1)', () => {
  const rng = M.createRng(5);
  let yes = 0; let sum = 0; let count = 0;
  for (let i = 0; i < 1500; i += 1) {
    const market = M.createMarket({ seed: Math.floor(rng() * 2 ** 31), startProb: .15 + rng() * .7 });
    const p = market.truth[60];
    if (p > .6 && p < .8) { count += 1; sum += p; if (market.outcome === 'YES') yes += 1; }
  }
  assert.ok(Math.abs(yes / count - sum / count) < .05, `observed ${yes / count} vs predicted ${sum / count}`);
});

test('simulation is reproducible with a seed', () => {
  assert.deepEqual(M.createMarket({ seed: 9 }).prices, M.createMarket({ seed: 9 }).prices);
});

test('parses Polymarket Gamma API market objects', () => {
  const parsed = M.parseGammaMarket({ id: 12, question: 'Will it rain?', outcomes: '["Yes","No"]', outcomePrices: '["0.37","0.63"]', bestBid: '0.36', bestAsk: '0.38', volumeNum: 1234, liquidityNum: 99 });
  assert.equal(parsed.question, 'Will it rain?');
  close(parsed.yesPrice, .37);
  close(parsed.spread, .02, 1e-12);
  assert.equal(M.parseGammaMarket({ outcomes: '["A","B","C"]', outcomePrices: '["0.2","0.3","0.5"]' }), null);
  assert.equal(M.parseGammaMarket({ outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }), null);
});

test('live advisor: sizes a confident edge, refuses a vague one, no leverage near resolution', () => {
  const strong = M.advise({ yesPrice: .40, spread: .02, belief: .60, confidence: 'high', bankroll: 1000, daysLeft: 45 });
  assert.equal(strong.action, 'OPEN');
  assert.equal(strong.side, 'YES');
  assert.ok(strong.expectedProfit > 0);
  assert.ok(strong.maxLoss <= 1000 * M.DEFAULT_CONFIG.maxPositionPct);
  close(strong.payoutIfRight, strong.shares - (strong.notional - strong.maxLoss), 1e-9);
  const vague = M.advise({ yesPrice: .40, spread: .02, belief: .46, confidence: 'low', bankroll: 1000, daysLeft: 45 });
  assert.equal(vague.action, 'HOLD');
  const lastDays = M.advise({ yesPrice: .40, spread: .02, belief: .60, confidence: 'high', bankroll: 1000, daysLeft: 3 });
  assert.equal(lastDays.leverage, 1);
  const bearish = M.advise({ yesPrice: .70, spread: .02, belief: .45, confidence: 'high', bankroll: 1000, daysLeft: 45 });
  assert.equal(bearish.side, 'NO');
});

test('reads Polymarket resolutions and settles positions', () => {
  assert.equal(M.parseGammaResolution({ closed: false, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }), null);
  assert.deepEqual(M.parseGammaResolution({ closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }), { outcome: 'YES' });
  assert.deepEqual(M.parseGammaResolution({ closed: 'true', outcomes: '["No","Yes"]', outcomePrices: '["1","0"]' }), { outcome: 'NO' });
  assert.deepEqual(M.parseGammaResolution({ closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]' }), { outcome: null });
  const levered = M.openPosition({ side: 'YES', yesPrice: .5, margin: 100, leverage: 3 });
  close(M.settlePosition(levered, 'YES').pnl, 600 - 200 - 100);   // 600 shares pay $1, repay 200
  close(M.settlePosition(levered, 'NO').pnl, -100);                // margin lost, never more
});

test('order book: walks levels, reports average price and depth', () => {
  const asks = [{ price: '0.43', size: '100' }, { price: '0.41', size: '50' }, { price: '0.45', size: '1000' }];
  const fill = M.fillFromBook(asks, 50);              // 50 shares @ .41 = $20.5, then $29.5 @ .43
  close(fill.bestAsk, .41);
  close(fill.spent, 50);
  close(fill.shares, 50 + 29.5 / .43, 1e-9);
  assert.equal(fill.levelsUsed, 2);
  assert.ok(fill.averagePrice > .41 && fill.averagePrice < .43);
  const tooBig = M.fillFromBook(asks, 10000);
  assert.ok(tooBig.unfilled > 0);
});

test('advisor uses the order book: deep book keeps the trade, thin book shrinks or refuses it', () => {
  const base = { yesPrice: .40, spread: .02, belief: .60, confidence: 'high', bankroll: 1000, daysLeft: 45 };
  const deep = M.advise({ ...base, book: { YES: [{ price: .41, size: 100000 }] } });
  assert.equal(deep.action, 'OPEN');
  close(deep.entry, .41);
  const thin = M.advise({ ...base, book: { YES: [{ price: .41, size: 20 }, { price: .58, size: 100000 }] } });
  assert.ok(thin.action === 'HOLD' || thin.margin < deep.margin, 'thin book must cut size or refuse');
  if (thin.action === 'OPEN') assert.ok(thin.entry < .5);
  const empty = M.advise({ ...base, book: { YES: [{ price: .55, size: 100000 }] } });
  assert.equal(empty.action, 'HOLD');
  assert.ok(empty.reasons.some(reason => reason.includes('order book too thin')));
  const tokens = M.parseGammaMarket({ outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', clobTokenIds: '["111","222"]' }).tokenIds;
  assert.deepEqual(tokens, { YES: '111', NO: '222' });
});

test('training: history lookup and sample building respect time', () => {
  const history = M.normaliseHistory({ history: [{ t: 300, p: .7 }, { t: 100, p: .4 }, { t: 200, p: 1.5 }] });
  assert.deepEqual(history.map(point => point.t), [100, 300]);
  assert.equal(M.priceAt(history, 250), .4);
  assert.equal(M.priceAt(history, 50), null);
  const samples = M.buildTrainingSamples([{ id: 'm', endTs: 10 * 86400, outcome: 'YES', history: [{ t: 0, p: .3 }, { t: 9 * 86400, p: .8 }] }], [1, 7, 30]);
  assert.deepEqual(samples.map(sample => [sample.horizon, sample.p]), [[1, .8], [7, .3]]);   // no 30-day sample: market too young
});

test('training: calibration fit finds no edge in a calibrated crowd and finds longshot bias', () => {
  const fair = M.trainAndEvaluate(M.simulatedResolvedMarkets(400, { seed: 3, longshotBias: 0 }));
  assert.ok(Math.abs(fair.model.b - 1) < .25, `calibrated slope ${fair.model.b}`);
  const biased = M.trainAndEvaluate(M.simulatedResolvedMarkets(400, { seed: 3, longshotBias: .35 }));
  assert.ok(biased.model.b > 1.25, `biased slope ${biased.model.b}`);
  assert.ok(biased.test.brierModel < biased.test.brierMarket, 'model beats the biased crowd out of sample');
  assert.ok(biased.paper.trades.length > fair.paper.trades.length, 'more trades when there is something to exploit');
});

test('training: parses resolved Gamma markets with YES token and end time', () => {
  const parsed = M.parseResolvedForTraining({ id: 5, question: 'Q', closed: true, outcomes: '["No","Yes"]', outcomePrices: '["0","1"]', clobTokenIds: '["11","22"]', closedTime: '2026-01-02T00:00:00Z' });
  assert.deepEqual(parsed, { id: '5', question: 'Q', endTs: Date.parse('2026-01-02T00:00:00Z') / 1000, outcome: 'YES', yesToken: '22' });
  assert.equal(M.parseResolvedForTraining({ closed: false, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', clobTokenIds: '["1","2"]', endDate: '2026-01-01' }), null);
  assert.equal(M.parseResolvedForTraining({ closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["1","2"]', endDate: '2026-01-01' }), null);
});

test('portfolio guard caps gross exposure and open positions', () => {
  assert.deepEqual(M.capToPortfolio({ equity: 1000, openNotional: 0, margin: 100, leverage: 3 }), { margin: 100, reason: null });
  const cut = M.capToPortfolio({ equity: 1000, openNotional: 1350, margin: 100, leverage: 3 });   // room 150 → margin 50
  close(cut.margin, 50);
  assert.match(cut.reason, /size cut/);
  assert.equal(M.capToPortfolio({ equity: 1000, openNotional: 1500, margin: 100, leverage: 2 }).margin, 0);
  assert.equal(M.capToPortfolio({ equity: 1000, openCount: 6, margin: 10 }).margin, 0);
});
