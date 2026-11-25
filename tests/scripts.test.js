// Tests for the state scripts (publish to / restore from the autopilot-data branch), run against a
// local bare repository instead of GitHub (METYU_GIT_REMOTE).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const hasGit = spawnSync('git', ['--version']).status === 0 && spawnSync('bash', ['--version']).status === 0;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-scripts-'));
  const remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const env = { ...process.env, METYU_GIT_REMOTE: remote, GITHUB_REPOSITORY: 'someone/metyu', GIT_TERMINAL_PROMPT: '0' };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const run = (script, args = [], extra = {}) => spawnSync('bash', [path.join(ROOT, 'scripts', script), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const branchFile = file => execFileSync('git', ['--git-dir', remote, 'show', `autopilot-data:${file}`], { encoding: 'utf8' });
  return { dir, remote, data, run, branchFile };
}

test('publish writes the state files as one commit; restore fills only missing files unless --all', { skip: !hasGit }, () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.data, 'exchange.json'), '{"kind":"exchange","n":1}');
  fs.writeFileSync(path.join(s.data, 'exchange-status.json'), '{"kind":"exchange"}');
  fs.writeFileSync(path.join(s.data, 'status.json'), '');                          // empty: skipped
  const first = s.run('publish-state.sh', [s.data]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /exchange.json exchange-status.json -> autopilot-data/);
  assert.equal(s.branchFile('exchange.json'), '{"kind":"exchange","n":1}');
  assert.match(s.branchFile('README.md'), /end-to-end encrypted/);
  fs.writeFileSync(path.join(s.data, 'exchange.json'), '{"kind":"exchange","n":2}');
  assert.equal(s.run('publish-state.sh', [s.data]).status, 0);
  const log = execFileSync('git', ['--git-dir', s.remote, 'log', '--oneline', 'autopilot-data'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(log.length, 1, 'one commit, replaced each time');

  const local = path.join(s.dir, 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'exchange.json'), '{"kind":"exchange","n":99}');   // a newer local state
  const restored = s.run('restore-state.sh', [local]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /restore: exchange-status.json/);
  assert.equal(fs.readFileSync(path.join(local, 'exchange.json'), 'utf8'), '{"kind":"exchange","n":99}', 'local state is never overwritten by default');
  assert.equal(s.run('restore-state.sh', [local, '--all']).status, 0);
  assert.equal(fs.readFileSync(path.join(local, 'exchange.json'), 'utf8'), '{"kind":"exchange","n":2}');
  assert.ok(!fs.existsSync(path.join(local, 'account.enc.json')), 'files absent on the branch are not created');
});

test('publish refuses unsealed balances and secret-looking content; restore copes with no branch', { skip: !hasGit }, () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.data, 'account.enc.json'), '{"v":1,"balances":[{"asset":"BTC"}]}');
  const unsealed = s.run('publish-state.sh', [s.data]);
  assert.notEqual(unsealed.status, 0);
  assert.match(unsealed.stderr, /not sealed: refusing to publish/);
  fs.writeFileSync(path.join(s.data, 'account.enc.json'), '{"v":1,"ct":"abc"}');
  fs.writeFileSync(path.join(s.data, 'exchange-status.json'), '{"log":"-----BEGIN EC PRIVATE KEY-----"}');
  const secret = s.run('publish-state.sh', [s.data]);
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /secret-looking content/);
  assert.equal(spawnSync('git', ['--git-dir', s.remote, 'rev-parse', '--verify', '-q', 'autopilot-data']).status, 1, 'nothing was pushed');
  const empty = path.join(s.dir, 'empty');
  fs.mkdirSync(empty);
  assert.match(s.run('publish-state.sh', [empty]).stderr, /nothing to save/);
  const fresh = s.run('restore-state.sh', [path.join(s.dir, 'fresh')]);
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /no autopilot-data branch yet/);
});

test('publish without a token or repository explains what is missing (and never prints a token)', { skip: !hasGit }, () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.data, 'exchange.json'), '{}');
  const noRepo = spawnSync('bash', [path.join(ROOT, 'scripts/publish-state.sh'), s.data], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(noRepo.status, 0);
  assert.match(noRepo.stderr, /GITHUB_REPOSITORY/);
  const noToken = spawnSync('bash', [path.join(ROOT, 'scripts/publish-state.sh'), s.data], { env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'a/b' }, encoding: 'utf8' });
  assert.match(noToken.stderr, /set GH_TOKEN/);
  for (const script of ['publish-state.sh', 'restore-state.sh', 'realtime.sh']) {
    assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'scripts', script)]).status, 0, `${script} parses`);
    const text = fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8');
    assert.ok(!/x-access-token:\$\{?(GH_TOKEN|GITHUB_TOKEN|token)\}?@/.test(text), `${script}: the token never goes into a URL`);
  }
});

// ---------- the watchdog ----------
const watchdog = require('../scripts/watchdog.js');
test('watchdog: healthy agents pass; silence, a halt, a dead price feed and an old model are reported', () => {
  const now = Date.parse('2026-11-13T14:00:00Z');
  const ago = min => new Date(now - min * 60000).toISOString();
  const exchange = { lastTick: ago(10), account: { halted: false }, health: { staleMarks: ['SUI-USD'], errorsLastHour: 2 }, model: { trainedAt: now - 3 * 3600000 } };
  const polymarket = { lastTick: ago(12), account: { halted: false } };
  assert.deepEqual(watchdog.assess({ exchange, polymarket, now }), [], 'one stale coin is routine');
  const sick = watchdog.assess({
    exchange: { ...exchange, lastTick: ago(95), account: { halted: true }, health: { staleMarks: ['A', 'B', 'C'], errorsLastHour: 40 }, model: { trainedAt: now - 50 * 3600000 } },
    polymarket: null, now
  });
  assert.equal(sick.length, 6);
  assert.match(sick.join('\n'), /crypto agent: silent for 95 min .*cron-job\.org/);
  assert.match(sick.join('\n'), /HALTED/);
  assert.match(sick.join('\n'), /stale prices for A, B, C/);
  assert.match(sick.join('\n'), /40 errors/);
  assert.match(sick.join('\n'), /model is 50 h old/);
  assert.match(sick.join('\n'), /Polymarket agent: no published status/);
  assert.match(watchdog.report(sick, now), /found 6 problem/);
  const oldPm = watchdog.assess({ exchange, polymarket: { ...polymarket, model: { trainedAt: now - 60 * 3600000 } }, now });
  assert.deepEqual(oldPm, ['Polymarket agent: the model is 60 h old (daily training keeps failing)']);
  assert.deepEqual(watchdog.assess({ exchange, polymarket: { ...polymarket, model: { trainedAt: now - 20 * 3600000 } }, now }), [], 'a day-old model is fine');
  const stuck = watchdog.assess({ exchange, polymarket: { ...polymarket, positions: [{ id: '1', question: 'Louisiana-Lafayette vs. UNCW', endDate: new Date(now - 5 * 86400000).toISOString() }, { id: '2', question: 'Later', endDate: new Date(now + 86400000).toISOString() }] }, now });
  assert.deepEqual(stuck, ['Polymarket agent: 1 position(s) still open 3+ days after the market ended (Louisiana-Lafayette vs. UNCW)']);
  const fresh = { linked: true, provider: 'solana', viewOnly: true, verifiedAt: new Date(now - 2 * 3600000).toISOString() };
  assert.deepEqual(watchdog.assess({ exchange, polymarket, account: fresh, now }), [], 'a link verified 2 h ago is fine');
  assert.deepEqual(watchdog.assess({ exchange, polymarket, account: { ...fresh, verifiedAt: new Date(now - 30 * 3600000).toISOString() }, now }), ['account link: last verified 30 h ago (the account sync keeps failing; the real-money lock no longer counts it)']);
  assert.deepEqual(watchdog.assess({ exchange, polymarket, account: { linked: false, reason: 'API key is not view-only' }, now }), ['account link refused: API key is not view-only']);
  assert.deepEqual(watchdog.assess({ exchange, polymarket, account: { ...fresh, security: { approvals: 1 } }, now }), ['WALLET SECURITY: 1 open token approval(s): another address can move those tokens without asking. Revoke them in the wallet app now.']);
  assert.match(watchdog.report([], now), /healthy/);
  // The CLI: exit code 1 and a report file when something is wrong, 0 when healthy.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metyu-watchdog-'));
  fs.writeFileSync(path.join(dir, 'exchange-status.json'), JSON.stringify(exchange));
  const out = path.join(dir, 'report.md');
  const quiet = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.equal(watchdog.main([dir, '--report', out], now), 1);
    assert.match(fs.readFileSync(out, 'utf8'), /Polymarket agent: no published status/);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(polymarket));
    assert.equal(watchdog.main([dir, '--report', out], now), 0);
  } finally { process.stdout.write = quiet; }
});

// ---------- the daily report ----------
const daily = require('../scripts/daily-report.js');
test('daily report: health, crypto equity and last 24 h, gates, the real-money lock, prediction markets', () => {
  const now = Date.parse('2026-11-20T08:00:00Z');
  const ago = h => new Date(now - h * 3600000).toISOString();
  const gate = (open, ci, weeks = 40) => ({ open, trades: 400, weeks, meanR: (ci[0] + ci[1]) / 2, ci });
  const exchange = {
    lastTick: ago(.2), account: { bankroll: 10000, equity: 10500, peak: 10600, halted: false }, health: { staleMarks: [], errorsLastHour: 0 },
    positions: [{ book: 'learning' }, { book: 'gated' }],
    history: [{ closedAt: ago(2), pnl: 40, learning: false }, { closedAt: ago(5), pnl: -10, learning: true }, { closedAt: ago(30), pnl: 999, learning: true }],
    model: { trainedAt: now - 3600000, strategies: { trend4h: { gate: gate(true, [.05, .4]), learnable: false, leverage: { scale: 1.5 } }, trend: { gate: gate(false, [-.2, .05]), learnable: true } },
      satellite: { strategies: { trend: { gate: gate(false, [-.3, -.01]), learnable: false } } } },
    forward: { gated: { trades: 6, weeks: 1, meanR: .68 } },
    live: { met: 2, total: 6, conditions: [{ id: 'days', ok: true, text: 'days' }, { id: 'trades', ok: false, text: '30+ closed normal-book trades (now 6)' }] },
    shadow: { orders: 3, trades: 3, pnl: -.41, sent: 0 },
    execution: { floor: .0005, minSamples: 6, coins: { 'PEPE-USD': { samples: 8, charged: .0022 }, 'BTC-USD': { samples: 8, charged: .0005 }, 'ZRO-USD': { samples: 2, charged: .0005 } } },
    stress: { at: ago(72), episodes: new Array(13).fill({}), verdicts: { trend: { earnsIn: ['crash', 'bear'], losesIn: ['bull', 'range'] } } },
    log: [{ at: ago(1), kind: 'DEMOTE', text: 'trend4h: last 20 live trades average -0.30R' }]
  };
  const polymarket = { lastTick: ago(.2), account: { realized: -212.3, halted: false }, positions: [{}, {}], history: [], model: { gate: { open: false, trades: 58, meanReturn: .11 } } };
  const text = daily.report({ exchange, polymarket, now });
  assert.match(text, /^# Metyu daily report · 2026-11-20 08:00 UTC/);
  assert.match(text, /\*\*Health:\*\* OK/);
  assert.match(text, /Execution check: 2 coins measured, 1 charged above the 0\.05% floor \(worst PEPE-USD 0\.22%\)/);
  assert.match(text, /History test \(13 episodes 2018–2024, 3 d ago\): trend earns in crash\/bear, loses in bull\/range/);
  assert.match(text, /\*\*Real wallet\/account:\*\* not linked/);
  assert.match(daily.report({ exchange, polymarket, account: { linked: true, provider: 'solana', viewOnly: true, verifiedAt: new Date(now - 3600000).toISOString(), security: { approvals: 0 } }, now }), /verified 1 h ago, no open token approvals/);
  assert.match(daily.report({ exchange, polymarket, account: { linked: true, provider: 'solana', viewOnly: true, verifiedAt: new Date(now - 3600000).toISOString(), security: { approvals: 2 } }, now }), /⚠ 2 OPEN TOKEN APPROVAL\(S\)/);
  assert.match(daily.report({ exchange, polymarket, account: { linked: true, provider: 'solana', viewOnly: true, verifiedAt: new Date(now - 3600000).toISOString() }, now }), /\*\*Real wallet\/account:\*\* solana, read-only, verified 1 h ago/);
  assert.match(text, /Equity 10500\.00 \(\+\$500\.00 since start, peak 10600\.00\), 2 open \(1 normal book\)/);
  assert.match(text, /Last 24 h: 2 closed \(1 won\), \+\$30\.00; normal book 1 \(\+\$40\.00\)/, 'older trades are left out');
  assert.match(text, /Evidence gates: 1\/3 open \(core trend4h 1\.5x\); learning: core trend/);
  assert.match(text, /Closest to a gate: core trend4h/);
  assert.match(text, /Real money: LOCKED, 2\/6; next: 30\+ closed normal-book trades \(now 6\)/);
  assert.match(text, /Shadow orders: 3 mirrored, 3 closed, −\$0\.41, sent 0/);
  assert.match(text, /Alarms \(24 h\): 1; latest: DEMOTE/);
  assert.match(text, /Realized −\$212\.30, 2 open, 0 closed in 24 h/);
  const sick = daily.report({ exchange: { ...exchange, lastTick: ago(3) }, polymarket, now });
  assert.match(sick, /\*\*Health:\*\* 1 problem\(s\)\n- crypto agent: silent for 180 min/);
});

// ---------- the content security policy ----------
const csp = require('../scripts/csp.js');
test('CSP: only the repository\'s own inline scripts may run (hashes, no unsafe-inline), and every page is up to date', () => {
  const { stale, policy } = csp.sync({ write: false });
  assert.deepEqual(stale, [], 'run: node scripts/csp.js --write');
  const scriptSrc = policy.split('; ').find(part => part.startsWith('script-src'));
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), scriptSrc);
  assert.match(scriptSrc, /^script-src 'self'( 'sha256-[A-Za-z0-9+/]{43}=')+$/);
  for (const page of csp.PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const script of csp.inlineScripts(html)) assert.ok(scriptSrc.includes(csp.hashOf(script)), `${page}: an inline script without its hash`);
  }
  assert.ok(policy.includes("object-src 'none'") && policy.includes("base-uri 'none'") && policy.includes("form-action 'none'"));
  // Upper case and "</script >" are seen too; a script tag that cannot be paired is an error.
  assert.deepEqual(csp.inlineScripts('<SCRIPT>a()</SCRIPT ><script src="x.js"></script><Script type="module">b()</script>'), ['a()', 'b()']);
  assert.throws(() => csp.inlineScripts('<script>a()'), /could pair only 0/);
  assert.deepEqual(csp.inlineScripts('<script>c()</script\t\n bar>'), ['c()'], 'any end tag a browser accepts');
});
