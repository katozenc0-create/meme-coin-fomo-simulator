const test = require('node:test');
const assert = require('node:assert/strict');
const { createResolver, cacheModeFor, isCommitUrl } = require('../metyu-fresh.js');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const reply = (status, body = '', headers = {}) => ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: name => headers[name] ?? null } });

function setup(answers) {
  let clock = 1000000;
  const calls = [];
  const resolver = createResolver({
    owner: 'someone', repo: 'metyu', now: () => clock,
    fetchImpl: async (url, options) => { calls.push({ url, options }); const next = answers.shift(); if (next instanceof Error) throw next; return next; }
  });
  return { resolver, calls, advance: ms => { clock += ms; }, at: () => clock };
}

test('fresh: reads the file at the branch head commit, then the branch URL', async () => {
  const { resolver, calls } = setup([reply(200, `${SHA1}\n`)]);
  assert.deepEqual(await resolver.urls('exchange-status.json'), [
    `https://raw.githubusercontent.com/someone/metyu/${SHA1}/exchange-status.json`,
    'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json'
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/someone/metyu/commits/autopilot-data');
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github.sha', 'the SHA only, a few bytes');
  assert.equal(calls[0].options.cache, 'no-cache', 'revalidated with the ETag, no preflight');
});

test('fresh: at most one API check per 90 s, and concurrent reads share it', async () => {
  const { resolver, calls, advance } = setup([reply(200, SHA1), reply(200, SHA2)]);
  await Promise.all([resolver.urls('status.json'), resolver.urls('exchange-status.json'), resolver.urls('account.enc.json')]);
  assert.equal(calls.length, 1, 'one check for the three files');
  advance(30000);
  await resolver.urls('status.json');
  assert.equal(calls.length, 1, 'no new check within 90 s (≤ 40 an hour, under the 60/hour limit)');
  advance(61000);
  assert.ok((await resolver.urls('status.json'))[0].includes(SHA2), 'a new publish is picked up');
  assert.equal(calls.length, 2);
});

test('fresh: failures fall back to the branch URL and keep the last known commit', async () => {
  const offline = setup([new Error('offline')]);
  assert.deepEqual(await offline.resolver.urls('status.json'), ['https://raw.githubusercontent.com/someone/metyu/autopilot-data/status.json']);
  const { resolver, advance } = setup([reply(200, SHA1), reply(500), reply(200, '<html>not a sha</html>')]);
  await resolver.urls('status.json');
  advance(91000);
  assert.ok((await resolver.urls('status.json'))[0].includes(SHA1), 'a server error keeps the last commit');
  advance(91000);
  assert.ok((await resolver.urls('status.json'))[0].includes(SHA1), 'an answer that is not a SHA is ignored');
});

test('fresh: a rate limit pauses the checks until GitHub resets it', async () => {
  const { resolver, calls, advance, at } = setup([reply(403, '{}', { 'X-RateLimit-Reset': String(Math.floor(1000000 / 1000) + 600) }), reply(200, SHA1)]);
  assert.equal((await resolver.urls('status.json')).length, 1, 'branch URL while limited');
  assert.equal(resolver.pausedUntil, (Math.floor(1000000 / 1000) + 600) * 1000);
  advance(300000);
  await resolver.urls('status.json');
  assert.equal(calls.length, 1, 'no request while paused');
  advance(301000);
  assert.ok((await resolver.urls('status.json'))[0].includes(SHA1));
  assert.ok(at() > resolver.pausedUntil);
  // No reset header: pause 15 minutes.
  const plain = setup([reply(429)]);
  await plain.resolver.urls('status.json');
  assert.equal(plain.resolver.pausedUntil, 1000000 + 15 * 60000);
});

test('fresh: only plain names reach the URLs; commit URLs may be cached', async () => {
  assert.throws(() => createResolver({ owner: 'a/b', repo: 'metyu', fetchImpl: async () => reply(200) }));
  assert.throws(() => createResolver({ owner: 'someone', repo: '..', fetchImpl: async () => reply(200) }));
  assert.throws(() => createResolver({ owner: 'someone', repo: 'a%2F..', fetchImpl: async () => reply(200) }));
  const { resolver } = setup([]);
  await assert.rejects(() => resolver.urls('../secrets'));
  assert.equal(cacheModeFor(`https://raw.githubusercontent.com/o/r/${SHA1}/status.json`), 'force-cache');
  assert.equal(cacheModeFor('https://raw.githubusercontent.com/o/r/autopilot-data/status.json'), 'no-store');
  assert.equal(cacheModeFor('/api/exchange/status'), 'no-store');
  assert.ok(isCommitUrl(`x/${SHA2}/y`));
});
