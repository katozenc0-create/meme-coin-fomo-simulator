// Walk-forward evaluation of Metyu on a dataset from research/collect.py, using the exact
// same code the Prediction lab runs (metyu-agent.js walkForward).
//
// Usage:  node research/evaluate.js data/dataset.json
const fs = require('node:fs');
const M = require('../metyu-agent.js');

const toTs = value => {
  const time = Date.parse(String(value || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
};

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const markets = raw
  .filter(market => market.history && market.history.length)
  .map(market => ({
    id: market.id, eventId: market.eventId, question: market.question, slug: market.slug, negRisk: market.negRisk,
    outcome: market.outcome, history: market.history, feeRate: M.takerFeeRate(market), feeExponent: M.takerFeeExponent(market),
    endTs: toTs(market.endDate) ?? toTs(market.closedTime ?? market.end), closedTs: toTs(market.closedTime ?? market.end)
  }))
  .filter(market => Number.isFinite(market.endTs));

const early = markets.filter(market => market.closedTs && market.endTs - market.closedTs > 86400).length;
console.log(`${markets.length} markets · ${new Set(markets.map(market => market.eventId)).size} events · ${early} closed more than a day before their scheduled end`);
const pct = value => `${(value * 100).toFixed(1)}%`;
for (const spread of [0.02, 0.04]) {
  for (const kind of ['calib', 'rich']) {
    for (const tradeHorizon of [1, 7, 30]) {
      const result = M.walkForward(markets, { kind, tradeHorizon, spread });
      const evidence = result.evidence;
      const folds = evidence.folds.map(fold => `${fold.trades}:${fold.meanReturn === null ? '-' : pct(fold.meanReturn)}`).join(' ');
      console.log(`spread ${spread * 100}¢ ${kind.padEnd(5)} ${String(tradeHorizon).padStart(2)}d · Brier ${result.test.brierMarket.toFixed(4)} -> ${result.test.brierModel.toFixed(4)} · trades ${evidence.trades} · mean ${pct(evidence.meanReturn)} · 95% [${pct(evidence.ci[0])}, ${pct(evidence.ci[1])}] · gate ${evidence.gateOpen ? 'OPEN' : 'closed'} · blocks ${folds}`);
    }
  }
}
