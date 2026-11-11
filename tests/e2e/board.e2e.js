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
  await page.waitForFunction(() => /CLOSE|SETTLE|LIQ/.test([...document.querySelectorAll('#feed li b')].map(b => b.textContent).join(' ')), null, { timeout: 40000 });
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
    outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(0.1 + index * 0.06), String(0.9 - index * 0.06)]), bestBid: '0.1', bestAsk: '0.12', endDate: end
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
  assert.match(await text(page, '#feed'), /resolved NO/);
  assert.doesNotMatch(await text(page, '#feed'), / OPEN /, 'no trained model, no trades');
  assert.deepEqual(page.errors, []);
});

test('board layout fits a phone screen', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.goto(`${env.base}/board.html`);
  assert.ok(await noHorizontalScroll(page));
});
