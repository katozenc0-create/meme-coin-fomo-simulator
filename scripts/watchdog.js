#!/usr/bin/env node
'use strict';
// Metyu watchdog: reads the published state (the autopilot-data branch) and says whether the agents
// are alive. Run by .github/workflows/watchdog.yml, which opens a GitHub issue (a notification on the
// owner's phone) while something is wrong and closes it when everything is healthy again.
//
//   node scripts/watchdog.js <dir with exchange-status.json and status.json> [--report report.md]
//
// Exit code 0 = healthy, 1 = problems found (listed in the report). Reads only; trades nothing.
const fs = require('fs');
const path = require('path');

const MIN = 60000;
const HOUR = 60 * MIN;
// A coin or two with a stale feed is routine (the board shows it); 3+ means the price feed itself failed.
const LIMITS = Object.freeze({ silentMinutes: 60, modelHours: 48, errorsPerHour: 30, staleCoins: 3 });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The list of problems (empty = healthy). Pure: `now` and the parsed status files in, text out. */
function assess({ exchange, polymarket, now = Date.now(), limits = LIMITS }) {
  const problems = [];
  const ageMin = iso => (iso ? (now - Date.parse(iso)) / MIN : Infinity);
  const silent = (name, status) => {
    if (!status) { problems.push(`${name}: no published status (the agent never ran or publishing failed)`); return true; }
    const age = ageMin(status.lastTick);
    if (!(age < limits.silentMinutes)) problems.push(`${name}: silent for ${Number.isFinite(age) ? `${Math.round(age)} min` : 'ever'} (the scheduler may have stopped: check cron-job.org and its token)`);
    return false;
  };
  if (!silent('crypto agent', exchange)) {
    const account = exchange.account || {};
    if (account.halted) problems.push('crypto agent: HALTED by the kill-switch (-15% from the peak); it opens nothing until the owner sets a new value of the repository variable METYU_RESET_HALT (for example today\'s date)');
    const health = exchange.health || {};
    if (health.staleMarks && health.staleMarks.length >= limits.staleCoins) problems.push(`crypto agent: stale prices for ${health.staleMarks.join(', ')} (their feed failed; not traded)`);
    if (health.errorsLastHour >= limits.errorsPerHour) problems.push(`crypto agent: ${health.errorsLastHour} errors in the last hour`);
    const trainedAt = exchange.model && exchange.model.trainedAt;
    if (!trainedAt) problems.push('crypto agent: no trained model');
    else if ((now - trainedAt) / HOUR >= limits.modelHours) problems.push(`crypto agent: the model is ${Math.round((now - trainedAt) / HOUR)} h old (daily training keeps failing)`);
  }
  if (!silent('Polymarket agent', polymarket)) {
    if (polymarket.account && polymarket.account.halted) problems.push('Polymarket agent: HALTED by the kill-switch (restart: a new value of METYU_RESET_HALT)');
  }
  return problems;
}

function report(problems, now = Date.now()) {
  const when = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  if (!problems.length) return `Metyu is healthy (${when} UTC).\n`;
  return [
    `**Metyu watchdog found ${problems.length} problem(s)** (${when} UTC):`, '',
    ...problems.map(problem => `- ${problem}`), '',
    'Virtual money only: nothing real is at risk. This issue closes itself when everything is healthy again.',
    'Board: https://katozenc0-create.github.io/meme-coin-fomo-simulator/board.html', ''
  ].join('\n');
}

function main(argv = process.argv.slice(2), now = Date.now()) {
  const dir = argv[0] || 'data';
  const at = argv.indexOf('--report');
  const problems = assess({ exchange: readJson(path.join(dir, 'exchange-status.json')), polymarket: readJson(path.join(dir, 'status.json')), now });
  const text = report(problems, now);
  if (at >= 0 && argv[at + 1]) fs.writeFileSync(argv[at + 1], text);
  process.stdout.write(text);
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { assess, report, main, LIMITS };
