'use strict';
// Metyu market history: the crypto market's big past episodes, as data, and a stress test that
// replays the agent's CURRENT strategies (the parameters its walk-forward training chose) through
// each one, on real Coinbase hourly bars.
//
// Why: the evidence gate judges about 2 years of data, which is mostly one or two market regimes.
// The episodes below (2018 to mid-2024) all lie BEFORE that window, so they are honest
// out-of-sample tests of how each strategy behaves in a crash, a long bear market, a bull run or a
// flat range. The result is information for the owner, the board and the daily report: it never
// opens a gate, sizes a trade or changes a rule.
//
// The notes are short and factual (what happened, roughly how far BTC moved); they are context for
// a person reading the results, not inputs to any strategy.
const X = require('./metyu-exchange.js');

const DAY = X.DAY;
const HOUR = X.HOUR;

// kind: crash (days, violent), bear (weeks of falling), bull (a long rise), range (flat, choppy).
const EPISODES = Object.freeze([
  { id: '2018-burst', name: '2018 bubble burst', from: '2018-01-08', to: '2018-02-07', kind: 'bear', note: 'After the Dec 2017 top (~$19.8k) BTC fell to ~$6k by 6 Feb 2018.' },
  { id: '2018-capitulation', name: '2018 capitulation', from: '2018-11-14', to: '2018-12-16', kind: 'bear', note: 'The Bitcoin Cash hash war; BTC broke $6k support and fell to ~$3.2k.' },
  { id: '2019-rally', name: '2019 spring rally', from: '2019-04-01', to: '2019-06-27', kind: 'bull', note: 'BTC rose from ~$4k to ~$13.8k in under three months.' },
  { id: '2020-covid', name: 'COVID crash', from: '2020-03-06', to: '2020-03-20', kind: 'crash', note: '12 Mar 2020 ("Black Thursday"): BTC fell ~40% in a day, to ~$3.8k at the low on 13 Mar.' },
  { id: '2020-bull', name: '2020 Q4 bull run', from: '2020-10-08', to: '2021-01-09', kind: 'bull', note: 'Institutional buying; BTC went from ~$10.6k to over $40k.' },
  { id: '2021-may', name: 'May 2021 crash', from: '2021-05-10', to: '2021-05-24', kind: 'crash', note: 'Tesla dropped BTC payments, China moved against mining; BTC from ~$58k to ~$30k.' },
  { id: '2022-luna', name: 'Terra/LUNA collapse', from: '2022-05-05', to: '2022-05-19', kind: 'crash', note: 'The UST stablecoin lost its peg and LUNA went to ~0; BTC fell below $27k.' },
  { id: '2022-celsius', name: 'Celsius / 3AC crisis', from: '2022-06-09', to: '2022-06-20', kind: 'crash', note: 'Celsius froze withdrawals and Three Arrows Capital failed; BTC fell to ~$17.6k.' },
  { id: '2022-ftx', name: 'FTX collapse', from: '2022-11-06', to: '2022-11-15', kind: 'crash', note: 'The FTX exchange halted withdrawals and went bankrupt; BTC fell to ~$15.5k.' },
  { id: '2023-usdc', name: 'USDC depeg (SVB)', from: '2023-03-08', to: '2023-03-16', kind: 'crash', note: 'Silicon Valley Bank failed and USDC briefly traded near $0.88; a fast drop, then a sharp rebound.' },
  { id: '2023-range', name: '2023 summer range', from: '2023-07-01', to: '2023-09-30', kind: 'range', note: 'BTC stayed mostly between ~$25k and ~$31k for three months.' },
  { id: '2024-etf', name: 'Spot ETF rally', from: '2024-01-10', to: '2024-03-14', kind: 'bull', note: 'US spot bitcoin ETFs began trading on 11 Jan 2024; BTC reached a new high near $73k.' },
  { id: '2024-yen', name: 'Yen carry unwind', from: '2024-08-01', to: '2024-08-09', kind: 'crash', note: 'A global sell-off on 5 Aug 2024 as yen carry trades unwound; BTC briefly near $49k.' }
]);
// Coins with Coinbase USD history back to 2018-2019, so every episode is tested on the same set.
const STRESS_COINS = Object.freeze(['BTC-USD', 'ETH-USD', 'LTC-USD', 'BCH-USD', 'LINK-USD']);
// Bars before an episode for the indicators (EMA200 on 4-hour bars needs ~35 days).
const WARMUP_DAYS = 40;
const KINDS = Object.freeze(['crash', 'bear', 'bull', 'range']);

/** Hourly Coinbase bars of one coin between two times (ms), paging 300 bars at a time. */
async function fetchRange(getJson, symbol, from, to) {
  const rows = [];
  for (let end = to; end > from;) {
    const start = Math.max(from, end - 300 * HOUR);
    const data = await getJson(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (!Array.isArray(data)) throw new Error((data && data.message) || 'unexpected Coinbase answer');
    rows.push(...data);
    end = start;
  }
  return X.parseCoinbaseCandles(rows).filter(candle => candle.t >= from && candle.t < to);
}

const summarise = trades => {
  const rs = trades.map(trade => trade.r);
  const sum = rs.reduce((total, r) => total + r, 0);
  return { trades: rs.length, wins: rs.filter(r => r > 0).length, meanR: rs.length ? sum / rs.length : 0, sumR: sum, shorts: trades.filter(trade => trade.side === 'SHORT').length };
};
const round = value => Math.round(value * 100) / 100;
const rounded = s => ({ ...s, meanR: round(s.meanR), sumR: round(s.sumR) });

/**
 * The stress test. Pure: `candles` is { episodeId: { symbol: hourly candles incl. warm-up } } and
 * `strategies` is { name: { params } } (a trained model's strategies). Only trades OPENED inside an
 * episode count; a trade still open at its end is not counted (as in the walk-forward backtest).
 */
function stressTest(candles, strategies, { episodes = EPISODES, costs = X.COSTS, now = Date.now() } = {}) {
  const results = [];
  const byKind = {};
  for (const episode of episodes) {
    const from = Date.parse(episode.from);
    const bySymbol = candles[episode.id] || {};
    const perStrategy = {};
    const coins = [];
    for (const [symbol, hourly] of Object.entries(bySymbol)) {
      let used = false;
      for (const [name, info] of Object.entries(strategies)) {
        if (!X.STRATEGIES[name] || !info || !info.params) continue;
        const bars = X.aggregateCandles(hourly, X.timeframeOf(name));
        const start = bars.findIndex(bar => bar.t >= from);
        if (start < X.WARMUP) continue;                          // not enough warm-up: skip, never guess
        used = true;
        const trades = X.backtest(bars, name, info.params, { from: start, costs, symbol });
        (perStrategy[name] = perStrategy[name] || []).push(...trades);
      }
      if (used) coins.push(symbol);
    }
    const strategyResults = Object.fromEntries(Object.entries(perStrategy).map(([name, trades]) => [name, rounded(summarise(trades))]));
    for (const [name, trades] of Object.entries(perStrategy)) {
      byKind[episode.kind] = byKind[episode.kind] || {};
      (byKind[episode.kind][name] = byKind[episode.kind][name] || []).push(...trades);
    }
    results.push({ id: episode.id, name: episode.name, kind: episode.kind, from: episode.from, to: episode.to, note: episode.note, coins, strategies: strategyResults });
  }
  const kinds = {};
  for (const kind of KINDS) {
    if (!byKind[kind]) continue;
    kinds[kind] = Object.fromEntries(Object.entries(byKind[kind]).map(([name, trades]) => [name, rounded(summarise(trades))]));
  }
  // Per strategy: where it earns and where it loses, in one line a person can read.
  const verdicts = {};
  for (const name of Object.keys(strategies)) {
    const good = KINDS.filter(kind => kinds[kind] && kinds[kind][name] && kinds[kind][name].trades >= 10 && kinds[kind][name].meanR > 0);
    const bad = KINDS.filter(kind => kinds[kind] && kinds[kind][name] && kinds[kind][name].trades >= 10 && kinds[kind][name].meanR < 0);
    verdicts[name] = { earnsIn: good, losesIn: bad };
  }
  return { at: new Date(now).toISOString(), coins: [...new Set(results.flatMap(r => r.coins))], episodes: results, kinds, verdicts };
}

/** Fetches every episode's bars and runs the stress test. Coins without history are skipped. */
async function runStressTest(getJson, strategies, { episodes = EPISODES, coins = STRESS_COINS, costs = X.COSTS, now = Date.now(), onError = () => {} } = {}) {
  const candles = {};
  for (const episode of episodes) {
    candles[episode.id] = {};
    const from = Date.parse(episode.from) - WARMUP_DAYS * DAY;
    const to = Date.parse(episode.to) + DAY;
    for (const symbol of coins) {
      try {
        const bars = await fetchRange(getJson, symbol, from, to);
        if (bars.length) candles[episode.id][symbol] = bars;
      } catch (error) { onError(`${episode.name} ${symbol}: ${error.message}`); }
    }
  }
  return stressTest(candles, strategies, { episodes, costs, now });
}

module.exports = { EPISODES, STRESS_COINS, WARMUP_DAYS, KINDS, fetchRange, stressTest, runStressTest };
