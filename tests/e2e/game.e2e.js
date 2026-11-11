// Browser tests for the meme-coin FOMO game (index.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, setValues, text, noHorizontalScroll } = require('./harness');

const money = value => Number(String(value).replace(/[^0-9.-]/g, ''));
let env;
test.before(async () => { env = await start(); });
test.after(async () => { await env.stop(); });

const waitForPeak = page => page.waitForFunction(() => document.querySelector('#pairState').textContent.includes('PEAK'), null, { timeout: 15000 });

test('buy at market, partial and full sells, re-entry, peak exit and session stats', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/index.html`);
  const chart = page.locator('#chartWrap');
  const box = await chart.boundingBox();
  await page.fill('#amount', '500');
  await page.click('#start');
  await page.waitForTimeout(600);
  await page.click('#buy');
  assert.equal(await page.locator('#modal').isHidden(), false, 'FOMO warning shown before an early buy');
  await page.click('#closeModal');
  assert.match(await text(page, '#positionLine'), /^OPEN/);
  assert.equal(money(await text(page, '#availableBalance')), 1500);

  await page.click('#sellTab');
  await page.click('[data-sell="0.5"]');
  assert.match(await text(page, '#positionLine'), /^OPEN/, 'still open after selling half');
  await page.click('[data-sell="1"]');
  assert.match(await text(page, '#positionLine'), /^NO/, 'flat after selling the rest');

  await chart.click({ position: { x: box.width * 0.3, y: box.height / 2 } });
  assert.match(await text(page, '#positionLine'), /^OPEN/, 're-entered by tapping the chart');
  await waitForPeak(page);
  assert.equal(await text(page, '#panic'), 'Sell All At Peak');
  await page.click('#panic');
  await page.waitForFunction(() => !document.querySelector('#panic').disabled, null, { timeout: 5000 });
  assert.equal(await text(page, '#panic'), 'Record Result');
  await page.click('#panic');
  assert.match(await text(page, '#scoreResult'), /Round P&L/);
  assert.match(await text(page, '#railWinRate'), /^1 ·/);

  const equity = money(await text(page, '#walletBalance'));
  await page.click('#reset');
  assert.equal(money(await text(page, '#walletBalance')), equity, 'equity carries over to the next round');
  assert.deepEqual(page.errors, []);
});

test('stop-loss fires during a rug pull and take-profit fills while pumping', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/index.html`);
  await page.selectOption('#scenarioSelect', 'rug');
  await page.click('#loadMarket');
  await page.fill('#stopLoss', '20');
  await page.click('#start');
  await waitForPeak(page);
  await page.click('#buy');
  await page.waitForFunction(() => !document.querySelector('#panic').disabled, null, { timeout: 5000 });
  assert.match(await text(page, '#tradeFeed'), /stop-loss/);
  await page.click('#panic');

  await page.click('#reset');
  await page.selectOption('#scenarioSelect', 'doge');
  await page.click('#loadMarket');
  await page.fill('#stopLoss', '');
  await page.fill('#takeProfitPct', '30');
  await page.click('#start');
  await page.waitForTimeout(300);
  const box = await page.locator('#chartWrap').boundingBox();
  await page.locator('#chartWrap').click({ position: { x: 15, y: box.height / 2 } });
  await page.waitForFunction(() => /take-profit/.test(document.querySelector('#tradeFeed').textContent) || document.querySelector('#pairState').textContent.includes('PEAK'), null, { timeout: 15000 });
  assert.match(await text(page, '#tradeFeed'), /take-profit/);

  await setValues(page, { '#bankroll': 5000 });
  assert.equal(money(await text(page, '#walletBalance')), 5000);
  assert.equal(await text(page, '#railWinRate'), '0 · —', 'new bankroll starts a new session');
  assert.deepEqual(page.errors, []);
});

test('game layout fits a phone screen', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.goto(`${env.base}/index.html`);
  assert.ok(await noHorizontalScroll(page));
});
