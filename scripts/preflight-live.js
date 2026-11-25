#!/usr/bin/env node
'use strict';
// Metyu real-money preflight: the checklist a real-money release would have to pass, run against
// the code and the published state. It sends nothing and changes nothing.
//
//   node scripts/preflight-live.js [dir with exchange-status.json and account-public.json] [--now ISO]
//
// Two kinds of checks:
//  - CODE (must always pass, today and forever, until the owner separately approves real orders):
//    no order or signing code anywhere, the first-order limits and costs unchanged, the evidence
//    gate's bars unchanged, no secret in the repository. The unit tests run these, so CI fails the
//    moment anyone adds order code or a key.
//  - READINESS (the published state): the 6 real-money conditions, shadow orders never sent, the
//    linked account read-only and clean, costs measured, and whether the signals could even be
//    placed on a spot account (a SHORT needs futures or margin).
// Exit code 1 when a code check fails or a shadow order was ever sent; "not ready" is exit 0.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const X = require('../metyu-exchange.js');
const W = require('../metyu-wallet.js');

const ROOT = path.resolve(__dirname, '..');
const HOUR = 3600000;

// Calls that would place, cancel or sign something with real money. None may exist in Metyu.
const ORDER_PATTERNS = [
  /\/orders\b/, /\bplaceOrder\b/, /\bcreateOrder\b/, /\bsubmitOrder\b/, /\bAddOrder\b/, /\bCancelOrder\b/,
  /\/api\/v3\/order/, /\bsendTransaction\b/, /\bsignTransaction\b/, /\bsignAndSendTransaction\b/, /\bwithdraw\s*\(/i
];
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a PEM private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk_live_[A-Za-z0-9]{16,}/, 'a live API secret']
];
// Tests carry fake secrets on purpose (to prove the board wipes them); this file names the patterns.
const SKIP = file => /^(tests|research|docs)\//.test(file) || /\.(md|png|svg|ico|webmanifest)$/.test(file) || file === 'scripts/preflight-live.js';

function trackedFiles(root = ROOT) {
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
}

/** The code checks. `files` is { path: text } (default: every tracked file that is not skipped). */
function codeChecks({ root = ROOT, files = null } = {}) {
  const sources = files || Object.fromEntries(trackedFiles(root).filter(file => !SKIP(file)).map(file => {
    try { return [file, fs.readFileSync(path.join(root, file), 'utf8')]; } catch { return [file, '']; }
  }));
  const hits = (patterns, label) => Object.entries(sources).flatMap(([file, text]) => text.split('\n').flatMap((line, i) =>
    patterns.filter(([pattern]) => pattern.test(line)).map(([, what]) => `${file}:${i + 1}${what ? ` (${what})` : ''}`))).slice(0, 10);
  const orderHits = hits(ORDER_PATTERNS.map(pattern => [pattern, '']));
  const secretHits = hits(SECRET_PATTERNS);
  // A recovery phrase or private key written into a source file (the board's own detector).
  const phraseHits = Object.entries(sources).flatMap(([file, text]) => [...text.matchAll(/['"`]([^'"`\n]{40,400})['"`]/g)]
    .filter(match => W.looksLikeSecret(match[1])).map(() => `${file} (${'a recovery phrase or private key'})`)).slice(0, 10);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return [
    { id: 'no-order-code', ok: !orderHits.length, text: orderHits.length ? `order or signing code found: ${orderHits.join(', ')}` : `no order, cancel, withdraw or signing call in ${Object.keys(sources).length} source files` },
    { id: 'live-limits', ok: same(X.LIVE_LIMITS, { maxOrderUsd: 25, maxDailyLossUsd: 50, maxOpenUsd: 100, maxLeverage: 1 }), text: `first-order limits: $${X.LIVE_LIMITS.maxOrderUsd} per order, $${X.LIVE_LIMITS.maxOpenUsd} open, $${X.LIVE_LIMITS.maxDailyLossUsd} a day, ${X.LIVE_LIMITS.maxLeverage}x` },
    { id: 'costs', ok: X.COSTS.feeRate >= .001 && X.COSTS.slippage >= .0005 && X.COSTS.fundingPer8h >= .0001, text: `cost floors: fee ${(X.COSTS.feeRate * 100).toFixed(2)}%, slippage ${(X.COSTS.slippage * 100).toFixed(2)}% (raised per coin by its order book), funding ${(X.COSTS.fundingPer8h * 100).toFixed(2)}% per 8 h` },
    { id: 'gate', ok: X.RULES.minTrades >= 30 && X.RULES.minWeeks >= 12 && X.RULES.familySize >= Object.keys(X.STRATEGIES).length * 2, text: `evidence gate: ${X.RULES.minTrades}+ trades, ${X.RULES.minWeeks}+ weeks, corrected for ${X.RULES.familySize} tests` },
    { id: 'kill-switch', ok: X.RULES.killDrawdown <= .15 && X.RULES.dailyLossPct <= .04, text: `kill-switch at −${(X.RULES.killDrawdown * 100).toFixed(0)}%, daily stop at −${(X.RULES.dailyLossPct * 100).toFixed(0)}%` },
    { id: 'no-secrets', ok: !secretHits.length && !phraseHits.length, text: secretHits.length || phraseHits.length ? `possible secret: ${secretHits.concat(phraseHits).join(', ')}` : 'no key, token or recovery phrase in the repository' }
  ];
}

/** The readiness checks, from the published status files. */
function readinessChecks({ exchange, account = null, now = Date.now() }) {
  const checks = [];
  const live = exchange && exchange.live;
  checks.push({ id: 'conditions', ok: !!live && live.ready, hard: false, text: live ? `real-money conditions ${live.met}/${live.total}${live.ready ? '' : `; missing: ${live.conditions.filter(c => !c.ok).map(c => c.id).join(', ')}`}` : 'no published state' });
  const shadow = exchange && exchange.shadow;
  checks.push({ id: 'shadow-not-sent', ok: !shadow || shadow.sent === 0, hard: true, text: shadow ? `shadow orders: ${shadow.orders} mirrored, ${shadow.sent} sent` : 'no shadow orders yet' });
  const verifiedHours = account && account.verifiedAt ? (now - Date.parse(account.verifiedAt)) / HOUR : Infinity;
  const approvals = account && account.security ? account.security.approvals : null;
  checks.push({ id: 'account', ok: !!account && account.linked && account.viewOnly && verifiedHours <= X.ACCOUNT_FRESH_HOURS && !approvals, hard: false,
    text: !account || !account.linked ? 'no account linked' : `${account.provider}, ${account.viewOnly ? 'read-only' : 'NOT read-only'}, verified ${Number.isFinite(verifiedHours) ? `${Math.round(verifiedHours)} h ago` : 'never'}, ${approvals ? `${approvals} OPEN TOKEN APPROVAL(S)` : approvals === 0 ? 'no open token approvals' : 'approvals not checked'}` });
  const execution = exchange && exchange.execution && exchange.execution.coins ? exchange.execution : null;
  const measured = execution ? Object.values(execution.coins).filter(c => c.samples >= execution.minSamples).length : 0;
  const coins = exchange && exchange.model && exchange.model.symbols ? exchange.model.symbols.length : X.SYMBOLS.length;
  checks.push({ id: 'costs-measured', ok: measured >= coins, hard: false, text: `order-book costs measured for ${measured}/${coins} coins` });
  // Spot reality: a spot account can only buy and sell what it holds; a SHORT needs futures or margin.
  const trades = (exchange && exchange.history) || [];
  const shorts = trades.filter(t => t.side === 'SHORT');
  const longs = trades.filter(t => t.side === 'LONG');
  const sum = list => list.reduce((total, t) => total + t.pnl, 0);
  checks.push({ id: 'spot-executable', ok: trades.length > 0 && shorts.length / trades.length <= .5, hard: false,
    text: trades.length ? `${shorts.length} of the last ${trades.length} trades were SHORT (${money(sum(shorts))}); a spot account could have placed only the ${longs.length} LONG (${money(sum(longs))}). A real-money release needs a venue that allows shorts, or the strategies' long side alone must pass the gate.` : 'no trades yet' });
  return checks;
}
const money = value => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(2)}`;

function report({ code, readiness, now = Date.now() }) {
  const mark = c => (c.ok ? '✓' : c.hard === false ? '·' : '✗');
  const lines = [`# Metyu real-money preflight · ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', 'Nothing is sent: Metyu has no order code. This checks what a real-money release would need.', '', '## Code (must always pass)'];
  for (const c of code) lines.push(`- ${mark(c)} ${c.text}`);
  lines.push('', '## Readiness (published state)');
  for (const c of readiness) lines.push(`- ${mark(c)} ${c.text}`);
  const failed = code.filter(c => !c.ok).concat(readiness.filter(c => c.hard && !c.ok));
  lines.push('', failed.length ? `**FAILED:** ${failed.map(c => c.id).join(', ')}` : `**Code checks pass.** Real money stays locked: ${readiness.filter(c => !c.ok).length ? `${readiness.filter(c => !c.ok).length} readiness item(s) open` : 'every item met: the owner decides'}.`);
  return { text: lines.join('\n'), failed };
}

function main(argv = process.argv.slice(2)) {
  const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
  const at = argv.indexOf('--now');
  const now = at >= 0 ? Date.parse(argv[at + 1]) : Date.now();
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; } };
  const { text, failed } = report({ code: codeChecks(), readiness: readinessChecks({ exchange: read('exchange-status.json'), account: read('account-public.json'), now }), now });
  process.stdout.write(`${text}\n`);
  return failed.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { codeChecks, readinessChecks, report, ORDER_PATTERNS, SECRET_PATTERNS };
