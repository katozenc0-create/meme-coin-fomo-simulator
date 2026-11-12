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
