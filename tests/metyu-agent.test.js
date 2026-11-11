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
  assert.equal(fair.paper.trades.length, 0, 'no edge, no trades');
  // With one effective observation per event, a mild bias in 400 markets is not enough evidence
  // to trade; a strong one is.
  const strong = M.trainAndEvaluate(M.simulatedResolvedMarkets(400, { seed: 3, longshotBias: .5 }));
  assert.ok(strong.paper.trades.length > 0, 'trades when the edge is large enough to be sure of');
});

test('training: parses resolved Gamma markets with YES token and end time', () => {
  const parsed = M.parseResolvedForTraining({ id: 5, question: 'Q', closed: true, outcomes: '["No","Yes"]', outcomePrices: '["0","1"]', clobTokenIds: '["11","22"]', closedTime: '2026-01-02T00:00:00Z' });
  assert.deepEqual(parsed, { id: '5', question: 'Q', slug: '', endTs: Date.parse('2026-01-02T00:00:00Z') / 1000, closedTs: Date.parse('2026-01-02T00:00:00Z') / 1000, outcome: 'YES', yesToken: '22', eventId: '5', negRisk: false, feeRate: 0 });
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

test('CSV export quotes properly and neutralises formula injection', () => {
  const csv = M.toCsv([
    { q: '=HYPERLINK("http://evil","x")', pnl: -12.5 },
    { q: 'Comma, "quotes"\nnewline', pnl: 3 },
    { q: '@SUM(A1)', pnl: NaN }
  ], [{ key: 'q', label: 'Market' }, { key: 'pnl', label: 'P&L' }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Market,P&L');
  assert.equal(lines[1], `"'=HYPERLINK(""http://evil"",""x"")",-12.5`);
  assert.ok(lines[2].startsWith('"Comma, ""quotes""'));
  assert.equal(csv.split('\r\n').pop(), "'@SUM(A1),");
});

test('event-aware training: grouped candidates count once and never straddle the split', () => {
  const weighted = M.weightByEvent([
    { eventId: 'e1', marketId: 'a', horizon: 7 }, { eventId: 'e1', marketId: 'b', horizon: 7 }, { eventId: 'e1', marketId: 'c', horizon: 7 },
    { eventId: 'e2', marketId: 'd', horizon: 7 }
  ]);
  assert.deepEqual(weighted.map(sample => +sample.weight.toFixed(3)), [.333, .333, .333, 1]);
  // 30 events; each "who wins" event has 5 candidates, exactly one resolves YES.
  const markets = [];
  for (let event = 0; event < 30; event += 1) {
    for (let candidate = 0; candidate < 5; candidate += 1) {
      const endTs = 1e9 + event * 86400 * 10 + candidate;
      markets.push({ id: `m${event}-${candidate}`, eventId: `e${event}`, endTs, outcome: candidate === event % 5 ? 'YES' : 'NO', history: [{ t: endTs - 40 * 86400, p: .2 }] });
    }
  }
  const result = M.trainAndEvaluate(markets, { horizons: [7] });
  assert.equal(result.counts.events, 30);
  assert.equal(result.counts.trainMarkets % 5, 0, 'whole events only on each side');
  assert.ok(Math.abs(result.counts.effectiveTrainSamples - result.counts.trainEvents) < 1e-9, 'one effective sample per event');
  const tradedEvents = result.paper.trades.map(trade => trade.marketId.split('-')[0]);
  assert.equal(new Set(tradedEvents).size, tradedEvents.length, 'at most one trade per event');
  const parsed = M.parseResolvedForTraining({ id: 1, eventId: '99', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', clobTokenIds: '["1","2"]', endDate: '2026-01-01' });
  assert.equal(parsed.eventId, '99');
});

test('data client skips a missing local proxy after the first miss, but not after a 5xx', async () => {
  const calls = [];
  const json = body => ({ ok: true, status: 200, json: async () => body });
  const staticHost = M.createDataClient(async url => {
    calls.push(url);
    if (url.startsWith('/api/')) return { ok: false, status: 404, json: async () => ({}) };
    return json({ direct: true });
  });
  assert.deepEqual(await staticHost.fetchJson(['/api/x', 'https://direct/x']), { direct: true });
  assert.deepEqual(await staticHost.fetchJson(['/api/y', 'https://direct/y']), { direct: true });
  assert.deepEqual(calls, ['/api/x', 'https://direct/x', 'https://direct/y'], 'second call goes straight to Polymarket');
  assert.equal(staticHost.proxyState(), false);

  const fileUrl = M.createDataClient(async url => { if (url.startsWith('/api/')) throw new TypeError('Failed to fetch'); return json(1); });
  assert.equal(await fileUrl.fetchJson(['/api/x', 'https://d/x']), 1);
  assert.equal(fileUrl.proxyState(), false);

  let upstreamDown = true;
  const withServer = M.createDataClient(async url => {
    if (url.startsWith('/api/')) return upstreamDown ? { ok: false, status: 502, json: async () => ({}) } : json({ proxied: true });
    return json({ direct: true });
  });
  assert.deepEqual(await withServer.fetchJson(['/api/x', 'https://d/x']), { direct: true });
  assert.equal(withServer.proxyState(), null, 'a 502 does not mean the proxy is missing');
  upstreamDown = false;
  assert.deepEqual(await withServer.fetchJson(['/api/x', 'https://d/x']), { proxied: true });
  assert.equal(withServer.proxyState(), true);
  await assert.rejects(M.createDataClient(async () => ({ ok: false, status: 500 })).fetchJson(['https://d/x']), /HTTP 500/);
});

test('fees, categories and rich features use only information known at decision time', () => {
  assert.equal(M.takerFeeRate({ feesEnabled: true, takerBaseFee: 1000 }), .1);
  assert.equal(M.takerFeeRate({ feesEnabled: false, takerBaseFee: 1000 }), 0);
  close(M.feePerShare(.1, .9), .01);
  assert.equal(M.marketCategory('Counter-Strike: MOUZ vs G2 (BO3)'), 'sports');
  assert.equal(M.marketCategory('Will Bitcoin be above $100k?'), 'crypto');
  assert.equal(M.marketCategory('Who will be the next Attorney General?'), 'politics');
  assert.equal(M.marketCategory('Will it snow in Paris?'), 'other');
  const features = M.richFeatures({ p: .5, horizon: 7, mom: .1, neg: 1, cat: 'sports' });
  assert.equal(features.length, 14);
  const samples = M.buildTrainingSamples([{ id: 'm', eventId: 'e', question: 'Lakers vs Celtics', negRisk: true, feeRate: .1, endTs: 20 * 86400, outcome: 'NO',
    history: [{ t: 0, p: .5 }, { t: 9 * 86400, p: .4 }, { t: 13 * 86400, p: .45 }] }], [7]);
  assert.equal(samples[0].cat, 'sports');
  assert.equal(samples[0].neg, 1);
  close(samples[0].mom, .45 - .4, 1e-12);
});

test('walk-forward evidence gate stays closed on a calibrated crowd and opens on a strong bias', () => {
  const fair = M.walkForward(M.simulatedResolvedMarkets(500, { seed: 3, longshotBias: 0 }), { kind: 'calib' });
  assert.equal(fair.evidence.gateOpen, false, `calibrated crowd: CI ${fair.evidence.ci}`);
  const biased = M.walkForward(M.simulatedResolvedMarkets(700, { seed: 3, longshotBias: .5 }), { kind: 'calib' });   // purged training needs a little more data
  assert.ok(biased.evidence.trades >= 30, `trades ${biased.evidence.trades}`);
  assert.equal(biased.evidence.gateOpen, true, `strong bias: CI ${biased.evidence.ci}`);
  assert.ok(biased.test.brierModel < biased.test.brierMarket);
  const rich = M.walkForward(M.simulatedResolvedMarkets(300, { seed: 4, longshotBias: .5 }), { kind: 'rich' });
  assert.equal(rich.model.kind, 'rich');
  assert.ok(Number.isFinite(M.predictModel(rich.model, { p: .3, horizon: 7 }).probability));
});

test('training counts horizons from the scheduled end and skips samples after an early close', () => {
  const parsed = M.parseResolvedForTraining({ id: 9, closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', clobTokenIds: '["1","2"]',
    endDate: '2026-12-31T00:00:00Z', closedTime: '2026-10-01 12:00:00+00' });
  assert.equal(parsed.endTs, Date.parse('2026-12-31T00:00:00Z') / 1000, 'scheduled end, not the early close');
  assert.equal(parsed.closedTs, Date.parse('2026-10-01T12:00:00Z') / 1000);
  const history = [{ t: parsed.closedTs - 200 * 86400, p: .3 }];
  const samples = M.buildTrainingSamples([{ ...parsed, history }], [1, 7, 30]);
  assert.equal(samples.length, 0, 'every horizon falls after the early close: nothing tradable');
});

test('live safety: fees cost edge, horizons are clamped, only an open gate may trade', () => {
  const base = { yesPrice: .40, spread: .02, belief: .62, confidence: 'high', bankroll: 1000, daysLeft: 45 };
  const free = M.advise(base);
  assert.equal(free.action, 'OPEN', 'edge without fees');
  const lowFee = M.advise({ ...base, feeRate: .1 });           // 0.1 x 0.4 = 4c per share
  close(lowFee.feePerShare, .04, 1e-12);
  close(free.edge - lowFee.edge, .04, 1e-9, 'the fee comes straight off the edge');
  assert.equal(M.advise({ ...base, feeRate: .2 }).action, 'HOLD', 'an 8c fee eats the edge');
  const filled = M.advise({ ...base, belief: .62, feeRate: .1, book: { YES: [{ price: .41, size: 1e6 }] } });
  close(filled.entry, .41 + .04, 1e-12);
  const far = M.richFeatures({ p: .5, horizon: 700 });
  const thirty = M.richFeatures({ p: .5, horizon: 30 });
  assert.deepEqual(far, thirty, 'horizons beyond 30 days are clamped');
  assert.equal(M.modelMayTrade(null), false);
  assert.equal(M.modelMayTrade({ a: 0, b: 1, cov: [[1, 0], [0, 1]] }), false, 'pre-gate models are closed');
  assert.equal(M.modelMayTrade({ gate: { open: false } }), false);
  assert.equal(M.modelMayTrade({ gate: { open: true } }), true);
  assert.equal(M.parseResolvedForTraining({ id: 1, slug: 'nba-lakers-celtics', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', clobTokenIds: '["1","2"]', endDate: '2026-01-01' }).slug, 'nba-lakers-celtics');
});

test('walk-forward purges training events that end within the horizon of a test block', () => {
  // 60 single-market events, one per day. With 30-day horizons, block 1 (events 10-19) would
  // otherwise train on events ending days before its own trades were placed.
  const markets = Array.from({ length: 60 }, (_, index) => {
    const endTs = 1e9 + index * 86400;
    return { id: `m${index}`, eventId: `e${index}`, endTs, outcome: index % 2 ? 'YES' : 'NO', history: [{ t: endTs - 60 * 86400, p: .4 }] };
  });
  const result = M.walkForward(markets, { kind: 'calib', folds: 5, horizons: [30], tradeHorizon: 30, stressSpreads: [.04] });
  assert.equal(result.stress.length, 1, 'stress evidence reuses the same fits');
  assert.equal(result.stress[0].spread, .04);
  // block 1 starts at event 10; nothing ended 30+ days earlier, so it cannot be traded.
  assert.ok(!result.evidence.folds.some(fold => fold.fold === 1), 'block 1 has no purged training data');
});
