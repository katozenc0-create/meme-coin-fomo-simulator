#!/usr/bin/env node
'use strict';
// The strategy lab from the command line (the agent runs the same weekly: metyu-lab.js).
//   node research/strategy-lab.js <episodes.json>      ({ episodeId: { symbol: hourly candles } })
const fs = require('fs');
const H = require('../metyu-history.js');
const Lab = require('../metyu-lab.js');

function main(argv = process.argv.slice(2)) {
  const lab = Lab.runLab(JSON.parse(fs.readFileSync(argv[0], 'utf8')));
  for (const v of lab.variants) {
    console.log(`${(v.family + ` ${v.timeframe}h`).padEnd(28)} ${JSON.stringify(v.params).padEnd(42)} ${H.KINDS.map(k => `${k} ${v.kinds[k].meanR.toFixed(2)}R(${v.kinds[k].trades})`).join(' ')}  ALL ${v.meanR.toFixed(3)}R(${v.trades}) ${v.promoted ? '→ PROMOTE' : ''}`);
  }
  console.log(`\n${lab.variants.length} variants of ${lab.families} families · promoted: ${lab.promoted.map(p => `${p.family} ${p.timeframe}h ${JSON.stringify(p.params)} [${p.status}]`).join('; ') || 'none'}`);
  return lab;
}

if (require.main === module) main();
module.exports = { main };
