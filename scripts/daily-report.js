#!/usr/bin/env node
'use strict';
// Metyu daily report: one short, reproducible summary of the published state (the autopilot-data
// branch), for the daily steward routine (docs/STEWARD.md) and for the owner.
//
//   git fetch origin autopilot-data && git worktree add /tmp/state origin/autopilot-data   (or any copy)
//   node scripts/daily-report.js <dir with exchange-status.json and status.json> [--now ISO]
//
// Prints Markdown. Reads only; trades nothing. Exit code 0 always (problems are in the text; the
// watchdog is the alarm).
const fs = require('fs');
const path = require('path');
const { assess } = require('./watchdog.js');

const HOUR = 3600000;
const money = value => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(2)}`;
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function gatesOf(model) {
  if (!model || !model.strategies) return [];
  const row = (tier, name, s) => ({ tier, name, open: !!s.gate.open, weeks: s.gate.weeks, meanR: s.gate.meanR, ci: s.gate.ci, learnable: s.learnable, demoted: !!s.demoted, leverage: s.leverage ? s.leverage.scale : 1 });
  return Object.entries(model.strategies).map(([name, s]) => row('core', name, s))
    .concat(model.satellite ? Object.entries(model.satellite.strategies).map(([name, s]) => row('satellite', name, s)) : []);
}

/** The report as Markdown lines. Pure: parsed status files and `now` in. */
function report({ exchange, polymarket, account = null, now = Date.now() }) {
  const lines = [];
  const since = now - 24 * HOUR;
  lines.push(`# Metyu daily report · ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`, '');
  const problems = assess({ exchange, polymarket, account, now });
  lines.push(`**Health:** ${problems.length ? `${problems.length} problem(s)` : 'OK'}`);
  for (const problem of problems) lines.push(`- ${problem}`);
  const security = account && account.security;
  const approvalsText = !security || security.approvals === null || security.approvals === undefined ? 'approvals not checked' : security.approvals ? `⚠ ${security.approvals} OPEN TOKEN APPROVAL(S)` : 'no open token approvals';
  lines.push(`**Real wallet/account:** ${!account ? 'not linked' : account.linked ? `${account.provider}, read-only, verified ${Math.round((now - Date.parse(account.verifiedAt)) / HOUR)} h ago, ${approvalsText}` : `refused (${account.reason || 'not view-only'})`}`);
  const perps = account && account.perps;
  if (perps) lines.push(`**Fomo perps account:** ${perps.linked ? `linked, ${perps.positions} open position(s)${perps.agents ? `, ⚠ ${perps.agents} API agent(s) may trade for it` : ''}` : `NOT linked (${perps.error})`}`);
  lines.push('');
  if (exchange && exchange.account) {
    const a = exchange.account;
    const closed = (exchange.history || []).filter(t => Date.parse(t.closedAt) >= since);
    const pnl = closed.reduce((sum, t) => sum + t.pnl, 0);
    const normal = closed.filter(t => !t.learning);
    lines.push('## Crypto (virtual money)');
    lines.push(`- Equity ${a.equity.toFixed(2)} (${money(a.equity - a.bankroll)} since start, peak ${a.peak.toFixed(2)}), ${exchange.positions.length} open (${exchange.positions.filter(p => p.book !== 'learning').length} normal book)`);
    lines.push(`- Last 24 h: ${closed.length} closed (${closed.filter(t => t.pnl > 0).length} won), ${money(pnl)}; normal book ${normal.length} (${money(normal.reduce((s, t) => s + t.pnl, 0))})`);
    const gates = gatesOf(exchange.model);
    const open = gates.filter(g => g.open && !g.demoted);
    lines.push(`- Evidence gates: ${open.length}/${gates.length} open${open.length ? ` (${open.map(g => `${g.tier} ${g.name} ${g.leverage}x`).join(', ')})` : ''}; learning: ${gates.filter(g => g.learnable).map(g => `${g.tier} ${g.name}`).join(', ') || 'none'}`);
    const best = gates.slice().sort((x, y) => y.ci[0] - x.ci[0])[0];
    if (best) lines.push(`- Closest to a gate: ${best.tier} ${best.name}, mean ${best.meanR.toFixed(2)}R, gate interval [${best.ci[0].toFixed(2)}, ${best.ci[1].toFixed(2)}], ${best.weeks ?? '?'} weeks`);
    const f = exchange.forward && exchange.forward.gated;
    if (f) lines.push(`- Forward test (normal book): ${f.trades} trades over ${f.weeks ?? '?'} weeks, mean ${f.meanR.toFixed(2)}R`);
    if (exchange.live) lines.push(`- Real money: LOCKED, ${exchange.live.met}/${exchange.live.total}; next: ${(exchange.live.conditions.find(c => !c.ok) || { text: 'all met: owner decides' }).text}`);
    const execution = exchange.execution && exchange.execution.coins ? exchange.execution : null;
    if (execution) {
      const measured = Object.entries(execution.coins).filter(([, c]) => c.samples >= execution.minSamples);
      const dearer = measured.filter(([, c]) => c.charged > execution.floor).sort((x, y) => y[1].charged - x[1].charged);
      lines.push(`- Execution check: ${measured.length} coins measured, ${dearer.length} charged above the ${(execution.floor * 100).toFixed(2)}% floor${dearer.length ? ` (worst ${dearer.slice(0, 3).map(([symbol, c]) => `${symbol} ${(c.charged * 100).toFixed(2)}%`).join(', ')})` : ''}`);
    }
    if (exchange.lab) {
      const fresh = exchange.lab.promoted.filter(p => p.status.startsWith('NEW CANDIDATE'));
      lines.push(`- Strategy lab (weekly, ${exchange.lab.variants} variants of ${exchange.lab.families} families): ${exchange.lab.promoted.length} promoted; ${fresh.length ? `**NEW CANDIDATE(S) for the gate check: ${fresh.map(p => `${p.family} ${p.timeframe}h ${JSON.stringify(p.params)}`).join('; ')}**` : 'no new candidate'}`);
    }
    if (exchange.stress && exchange.stress.verdicts) {
      const v = Object.entries(exchange.stress.verdicts).map(([name, x]) => `${name} earns in ${x.earnsIn.join('/') || '—'}, loses in ${x.losesIn.join('/') || '—'}`).join('; ');
      lines.push(`- History test (${exchange.stress.episodes.length} episodes 2018–2024, ${Math.round((now - Date.parse(exchange.stress.at)) / (24 * HOUR))} d ago): ${v}`);
    }
    if (exchange.shadow) lines.push(`- Shadow orders: ${exchange.shadow.orders} mirrored, ${exchange.shadow.trades} closed, ${money(exchange.shadow.pnl)}, sent ${exchange.shadow.sent}`);
    const alarms = (exchange.log || []).filter(e => Date.parse(e.at) >= since && ['ERROR', 'HALT', 'DEMOTE', 'RESET'].includes(e.kind));
    if (alarms.length) lines.push(`- Alarms (24 h): ${alarms.length}; latest: ${alarms[0].kind} ${alarms[0].text.slice(0, 120)}`);
    lines.push('');
  }
  if (polymarket && polymarket.account) {
    const closed = (polymarket.history || []).filter(t => Date.parse(t.closedAt) >= since);
    const gate = polymarket.model && polymarket.model.gate;
    lines.push('## Prediction markets (virtual money)');
    lines.push(`- Realized ${money(polymarket.account.realized)}, ${polymarket.positions.length} open, ${closed.length} closed in 24 h`);
    if (gate) lines.push(`- Evidence gate ${gate.open ? 'OPEN' : 'closed'}: ${gate.trades} out-of-sample trades, mean ${(gate.meanReturn * 100).toFixed(1)}%`);
    lines.push('');
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const dir = argv[0] || 'data';
  const at = argv.indexOf('--now');
  const now = at >= 0 ? Date.parse(argv[at + 1]) : Date.now();
  process.stdout.write(`${report({ exchange: readJson(path.join(dir, 'exchange-status.json')), polymarket: readJson(path.join(dir, 'status.json')), account: readJson(path.join(dir, 'account-public.json')), now })}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { report, gatesOf };
