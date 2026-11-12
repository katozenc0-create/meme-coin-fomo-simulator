// Browser tests for the Metyu Live Board (board.html). Polymarket is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { start, setValues, text, noHorizontalScroll } = require('./harness');

let env;
test.before(async () => { env = await start(); });
test.after(async () => { await env.stop(); });

test('demo mode trades, replaces resolved markets, persists, exports CSV', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/index.html`);
  await page.click('a.nav-link[href="board.html"]');
  await page.waitForSelector('#board', { state: 'attached' });
  await page.click('#exportBtn');
  assert.match(await text(page, '#feed'), /no closed trades to export/);

  await setValues(page, { '#speed': 10, '#skill': 90 });
  await page.click('#startBtn');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#board .card').count(), 8);
  await page.waitForFunction(() => document.querySelector('#sResolved').textContent !== '0', null, { timeout: 40000 });
  // Metyu is selective: the first market to resolve may have been one it stayed out of, so wait
  // for an actual round trip (an OPEN, then a closed or settled trade) rather than for any resolution.
  await page.waitForFunction(() => / OPEN /.test(document.querySelector('#feed').textContent) && !document.querySelector('#sTrades').textContent.startsWith('0 '), null, { timeout: 90000 });
  assert.match(await text(page, '#feed'), /OPEN/, 'Metyu opened trades');
  assert.equal(await page.locator('#board .card').count(), 8, 'resolved markets are replaced');

  await page.click('#pauseBtn');
  await page.click('#flattenBtn');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  const lines = fs.readFileSync(await download.path(), 'utf8').trim().split('\r\n');
  assert.ok(lines[0].startsWith('opened_at,closed_at,mode,market'));
  const trades = Number((await text(page, '#sTrades')).split(' ')[0]);
  assert.equal(lines.length - 1, trades, 'CSV rows match the trade count');

  await page.reload();
  assert.notEqual(await text(page, '#sTrades'), '0 · —', 'account persists across reloads');
  assert.deepEqual(page.errors, []);
});

test('portfolio limits, card Close and Flatten all', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/board.html`);
  await setValues(page, { '#speed': 10, '#skill': 95, '#maxOpen': 2, '#maxGross': '1' });
  await page.click('#startBtn');
  let maxOpen = 0;
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(200);
    maxOpen = Math.max(maxOpen, await page.locator('#board .badge.yes, #board .badge.no').count());
  }
  assert.ok(maxOpen <= 2, `never more than 2 open positions (saw ${maxOpen})`);
  await page.waitForSelector('#board .close-btn', { timeout: 20000 });
  await page.click('#pauseBtn');
  const before = await page.locator('#board .close-btn').count();
  await page.locator('#board .close-btn').first().click();
  assert.equal(await page.locator('#board .close-btn').count(), before - 1);
  assert.match(await text(page, '#feed'), /closed manually by you/);
  await page.click('#flattenBtn');
  assert.equal(await page.locator('#board .close-btn').count(), 0);
  assert.deepEqual(page.errors, []);
});

test('live mode: one market per event, settles resolutions, no trades without a trained model', async () => {
  const page = await env.page();
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const markets = Array.from({ length: 12 }, (_, index) => ({
    id: String(700 + index), eventId: index < 3 ? 'fed' : `ev${index}`, question: `Live market ${index + 1}?`,
    outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(0.1 + index * 0.06), String(0.9 - index * 0.06)]), bestBid: '0.1', bestAsk: '0.12', endDate: end, slug: `live-market-${index + 1}`
  }));
  let polls = 0;
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets } }));
  await page.route('**/api/polymarket/market?id=*', route => {
    polls += 1;
    const id = new URL(route.request().url()).searchParams.get('id');
    const market = markets.find(item => item.id === id);
    return route.fulfill({ json: { market: id === '703' ? { ...market, closed: true, outcomePrices: '["0","1"]' } : market } });
  });
  await page.goto(`${env.base}/board.html`);
  await page.click('#resetBtn');
  await page.selectOption('#mode', 'live');
  await page.click('#startBtn');
  await page.waitForFunction(() => /live prices refreshed/.test(document.querySelector('#statusNote').textContent), null, { timeout: 20000 });
  const questions = await page.$$eval('#board .card h3', headings => headings.map(heading => heading.textContent));
  assert.equal(questions.length, 8);
  assert.equal(questions.filter(question => ['Live market 1?', 'Live market 2?', 'Live market 3?'].includes(question)).length, 1, 'only one market of the shared event');
  assert.ok(polls >= 8);
  const links = await page.$$eval('#board .card a.pm-link', anchors => anchors.map(anchor => anchor.href));
  assert.equal(links.length, 8, 'every live card links to its market on polymarket.com');
  assert.ok(links.every(href => /^https:\/\/polymarket\.com\/market\/live-market-\d+$/.test(href)), links.join(' '));
  assert.match(await text(page, '#feed'), /resolved NO/);
  assert.doesNotMatch(await text(page, '#feed'), / OPEN /, 'no trained model, no trades');
  assert.deepEqual(page.errors, []);
});

test('live mode with an open-gate model: real 12-hourly history decides leverage', async () => {
  const page = await env.page();
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  // Even markets jumped 15c every 12 h; odd ones were flat.
  const markets = Array.from({ length: 8 }, (_, index) => ({
    id: String(800 + index), eventId: `e${index}`, question: `${index % 2 ? 'Calm' : 'Jumpy'} market ${index}?`, outcomes: '["Yes","No"]',
    outcomePrices: '["0.30","0.70"]', bestBid: '0.295', bestAsk: '0.305', endDate: end, clobTokenIds: JSON.stringify([String(9100 + index), String(9200 + index)])
  }));
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets } }));
  await page.route('**/api/polymarket/market?id=*', route => route.fulfill({ json: { market: markets.find(item => item.id === new URL(route.request().url()).searchParams.get('id')) } }));
  await page.route('**/api/polymarket/history?*', route => {
    const index = Number(new URL(route.request().url()).searchParams.get('token_id')) - 9100;
    return route.fulfill({ json: { history: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 43200, p: index % 2 ? .30 : (i % 2 ? .30 : .45) })) } });
  });
  await page.addInitScript(() => {
    // A (deliberately optimistic) calibration model whose evidence gate is open.
    localStorage.setItem('metyuModel.v1', JSON.stringify({ kind: 'calib', a: 1.2, b: 1, cov: [[.0005, 0], [0, .0005]], gate: { open: true, meanReturn: .1, ci: [.02, .2] }, source: 'test' }));
  });
  await page.goto(`${env.base}/board.html`);
  await page.click('#resetBtn');
  await page.selectOption('#mode', 'live');
  await page.click('#startBtn');
  await page.waitForFunction(() => /live prices refreshed/.test(document.querySelector('#statusNote').textContent), null, { timeout: 20000 });
  const opens = [...(await text(page, '#feed')).matchAll(/(Calm|Jumpy) market \d\? — YES (\d+)x/g)].map(match => [match[1], Number(match[2])]);
  assert.ok(opens.some(([kind]) => kind === 'Jumpy') && opens.some(([kind]) => kind === 'Calm'), `both kinds traded: ${JSON.stringify(opens)}`);
  assert.ok(opens.filter(([kind]) => kind === 'Jumpy').every(([, lev]) => lev === 1), 'after 15c jumps: never leveraged');
  assert.ok(opens.filter(([kind]) => kind === 'Calm').some(([, lev]) => lev > 1), 'a calm market may use leverage');
  assert.deepEqual(page.errors, []);
});

test('live mode: at most 2 open positions per category (correlated markets)', async () => {
  const page = await env.page();
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  const markets = Array.from({ length: 6 }, (_, index) => ({
    id: String(900 + index), eventId: `c${index}`, question: `Will Bitcoin be above ${100 + index * 5}k USD on Friday?`, outcomes: '["Yes","No"]',
    outcomePrices: '["0.30","0.70"]', bestBid: '0.295', bestAsk: '0.305', endDate: end, clobTokenIds: JSON.stringify([String(9300 + index), String(9400 + index)])
  }));
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets } }));
  await page.route('**/api/polymarket/market?id=*', route => route.fulfill({ json: { market: markets.find(item => item.id === new URL(route.request().url()).searchParams.get('id')) } }));
  await page.route('**/api/polymarket/history?*', route => route.fulfill({ json: { history: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 43200, p: .30 })) } }));
  await page.addInitScript(() => {
    localStorage.setItem('metyuModel.v1', JSON.stringify({ kind: 'calib', a: 1.2, b: 1, cov: [[.0005, 0], [0, .0005]], gate: { open: true, meanReturn: .1, ci: [.02, .2] }, source: 'test' }));
  });
  await page.goto(`${env.base}/board.html`);
  await page.click('#resetBtn');
  await page.selectOption('#mode', 'live');
  await page.click('#startBtn');
  await page.waitForFunction(() => /live prices refreshed/.test(document.querySelector('#statusNote').textContent), null, { timeout: 20000 });
  assert.equal(await page.locator('#board .card.long-yes, #board .card.long-no').count(), 2, 'six Bitcoin markets, two positions');
  assert.match(await text(page, '#feed'), /max 2 open positions in crypto/);
  assert.deepEqual(page.errors, []);
});

test('board layout fits a phone screen', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.goto(`${env.base}/board.html`);
  assert.ok(await noHorizontalScroll(page));
});
