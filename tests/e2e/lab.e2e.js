// Browser tests for the Metyu Prediction Lab (polymarket.html). Polymarket is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, setValues, text, noHorizontalScroll } = require('./harness');

let env;
test.before(async () => { env = await start(); });
test.after(async () => { await env.stop(); });

const END = () => new Date(Date.now() + 60 * 86400000).toISOString();

test('autopilot runs a market, manual leveraged trade, backtest table', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/polymarket.html`);
  await setValues(page, { '#skill': 85, '#speed': 8 });
  await page.click('#startBtn');
  await page.waitForSelector('#resultBanner:not([hidden])', { timeout: 30000 });
  assert.match(await text(page, '#resultBanner'), /^RESOLVED (YES|NO)/);
  assert.equal(await page.locator('#truthLine:not([hidden])').count(), 1, 'hidden truth revealed at resolution');

  await page.uncheck('#autopilot');
  await page.click('#startBtn');
  await page.waitForTimeout(400);
  await page.fill('#margin', '200');
  await setValues(page, { '#leverage': 5 });
  await page.click('#buyYes');
  assert.match(await text(page, '#posSize'), /5x/);
  assert.match(await text(page, '#posLiq'), /¢/, 'leveraged position shows a liquidation price');
  await page.click('#closeBtn');
  assert.equal(await text(page, '#posSide'), 'FLAT');

  await setValues(page, { '#skill': 30, '#btMarkets': 60 });
  await page.click('#runBacktest');
  await page.waitForFunction(() => document.querySelectorAll('#btBody tr').length === 6 && !document.querySelector('#runBacktest').disabled, null, { timeout: 90000 });
  const rows = await page.$$eval('#btBody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent)));
  const reckless = rows.find(row => row[0].startsWith('Reckless'));
  assert.ok(Number(reckless[6]) > 0, 'reckless leverage gets liquidated');
  assert.deepEqual(page.errors, []);
});

test('advisor: no-trade vs buy, live market, paper position, refresh, settlement, persistence', async () => {
  const page = await env.page();
  let livePrice = '0.40';
  let closed = false;
  const end = END();
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets: [
    { id: '501', question: 'Will the test event happen?', outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]', bestBid: '0.39', bestAsk: '0.41', endDate: end, slug: 'test-market', eventSlug: 'test-event' },
    { id: '502', question: 'Multi-outcome market', outcomes: '["A","B","C"]', outcomePrices: '["0.2","0.3","0.5"]' }
  ] } }));
  await page.route('**/api/polymarket/market?id=*', route => route.fulfill({ json: { market: {
    id: '501', question: 'Will the test event happen?', closed, outcomes: '["Yes","No"]',
    outcomePrices: JSON.stringify([livePrice, String(1 - Number(livePrice))]), bestBid: '0.49', bestAsk: '0.51', endDate: end } } }));
  await page.goto(`${env.base}/polymarket.html`);

  await page.fill('#advPrice', '40'); await page.fill('#advBelief', '46'); await page.selectOption('#advConfidence', 'low');
  await page.click('#advAsk');
  assert.equal(await text(page, '#advVerdict h3'), 'No trade', 'a vague view does not trade');
  await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  assert.equal(await text(page, '#advVerdict h3'), 'Buy YES');

  await page.click('#loadLive');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#liveNote').textContent));
  assert.equal(await page.locator('#advMarket option').count(), 2, 'only binary markets offered');
  await page.selectOption('#advMarket', '0');
  assert.equal(await page.inputValue('#advPrice'), '40.0');
  await page.fill('#advBelief', '62'); await page.dispatchEvent('#advBelief', 'change');
  await page.waitForTimeout(200);
  await page.click('#advAsk');
  const link = page.locator('#advVerdict a.pm-link');
  assert.equal(await link.getAttribute('href'), 'https://polymarket.com/event/test-event/test-market', 'verdict links to the market on polymarket.com');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(await link.textContent(), /yourself on Polymarket/);
  await page.click('#advTrack');
  assert.match(await text(page, '#paperList'), /Will the test event happen\?/);
  assert.equal(await page.locator('#paperList a.pm-link').count(), 1, 'open paper position links to Polymarket');

  livePrice = '0.50';
  await page.click('#advRefresh');
  await page.waitForFunction(() => /refreshed/.test(document.querySelector('#advStatus').textContent));
  assert.match(await text(page, '#paperTotal'), /^\+/, 'paper P&L positive after the price rose');

  closed = true; livePrice = '1';
  await page.click('#advRefresh');
  await page.waitForFunction(() => /settled at resolution/.test(document.querySelector('#advStatus').textContent));
  assert.match(await text(page, '#paperList'), /RESOLVED YES · won/);
  assert.match(await text(page, '#paperRealized'), /^\+/);
  assert.equal(await text(page, '#paperTotal'), '$0');

  await page.reload();
  assert.match(await text(page, '#paperList'), /RESOLVED YES/, 'settled paper position survives a reload');
  assert.deepEqual(page.errors, []);
});

test('advisor sizes against the order book and falls back when it is unavailable', async () => {
  const page = await env.page();
  let asks = [{ price: 0.41, size: 100000 }];
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets: [
    { id: '601', question: 'Book test market?', outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]', bestBid: '0.39', bestAsk: '0.41', endDate: END(), clobTokenIds: '["9001","9002"]' }] } }));
  await page.route('**/api/polymarket/book?*', route => route.fulfill({ json: { book: { tokenId: '9001', asks, bids: [] } } }));
  await page.goto(`${env.base}/polymarket.html`);
  await page.click('#loadLive');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#liveNote').textContent));
  await page.selectOption('#advMarket', '0');
  await page.fill('#advBelief', '60'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  await page.waitForFunction(() => /order book: avg/.test(document.querySelector('#advVerdict').textContent));
  assert.equal(await text(page, '#advVerdict h3'), 'Buy YES');

  asks = [{ price: 0.55, size: 100000 }];
  await page.click('#advAsk');
  await page.waitForFunction(() => /No trade/.test(document.querySelector('#advVerdict h3').textContent));
  assert.match(await text(page, '#advVerdict'), /order book too thin/);
  assert.ok(await page.isDisabled('#advTrack'));

  await page.unroute('**/api/polymarket/book?*');
  await page.route('**/api/polymarket/book?*', route => route.fulfill({ status: 502, json: { error: 'down' } }));
  await page.click('#advAsk');
  await page.waitForFunction(() => /order book unavailable/.test(document.querySelector('#advVerdict').textContent));
  assert.deepEqual(page.errors, []);
});

test('training: control finds no edge, bias is detected, live pipeline, model feeds the advisor', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/polymarket.html`);
  const fake = await page.evaluate(() => Metyu.simulatedResolvedMarkets(120, { seed: 5, longshotBias: 0.35 }).map((market, index) => ({
    raw: { id: String(1000 + index), eventId: `ev${index}`, question: market.question, closed: true, outcomes: '["Yes","No"]',
      outcomePrices: market.outcome === 'YES' ? '["1","0"]' : '["0","1"]', clobTokenIds: JSON.stringify([String(5000 + index), String(9000 + index)]),
      closedTime: new Date(market.endTs * 1000).toISOString() },
    history: market.history })));
  const histories = Object.fromEntries(fake.map(item => [JSON.parse(item.raw.clobTokenIds)[0], item.history]));
  let windowCalls = 0;
  await page.route('**/api/polymarket/resolved?*', route => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.get('end_min') || !params.get('end_max')) return route.fulfill({ status: 400, json: { error: 'window expected' } });
    const start = 100 * windowCalls++;     // each scheduled-end window returns the next batch
    return route.fulfill({ json: { markets: fake.slice(start, start + 100).map(item => item.raw) } });
  });
  await page.route('**/api/polymarket/history?*', route => route.fulfill({ json: { history: histories[new URL(route.request().url()).searchParams.get('token_id')] || [] } }));

  await page.selectOption('#trainSource', 'sim0');
  await page.click('#trainBtn');
  await page.waitForSelector('#trainResults:not([hidden])');
  assert.match(await text(page, '#trainMeaning'), /calibrated/);
  assert.match(await text(page, '#trainGate'), /^closed/, 'no edge in a calibrated crowd: evidence gate stays closed');

  await page.selectOption('#trainSource', 'sim35');
  await page.fill('#trainCount', '600');   // one effective observation per event: enough to see the bias
  await page.click('#trainBtn');
  await page.waitForFunction(() => /35% longshot/.test(document.querySelector('#trainStatus').textContent));
  assert.match(await text(page, '#trainMeaning'), /timid/);
  assert.match(await text(page, '#trainFolds'), /#\d/, 'per-block walk-forward results shown');
  assert.match(await text(page, '#trainStress'), /./);

  await page.selectOption('#trainSource', 'live');
  await page.fill('#trainCount', '120');
  await page.click('#trainBtn');
  await page.waitForFunction(() => /walk-forward on \d+ resolved Polymarket markets|failed/.test(document.querySelector('#trainStatus').textContent), null, { timeout: 60000 });
  assert.match(await text(page, '#trainStatus'), /120 resolved Polymarket markets/);
  assert.equal(await page.locator('#trainReliability tr').count(), 10);

  const gateOpen = /^OPEN/.test(await text(page, '#trainGate'));
  await page.click('#trainUse');
  assert.ok(await page.isChecked('#advUseModel'));
  assert.match(await text(page, '#trainStatus'), gateOpen ? /gate OPEN/ : /gate is CLOSED/);
  await page.fill('#advPrice', '12'); await page.dispatchEvent('#advPrice', 'change');
  await page.waitForTimeout(200);
  assert.match(await text(page, '#advVerdict'), /trained model/);
  if (!gateOpen) assert.equal(await text(page, '#advVerdict h3'), 'No trade', 'a closed evidence gate never trades');
  await page.reload();
  assert.equal(await page.isDisabled('#advUseModel'), false, 'trained model persists');
  assert.deepEqual(page.errors, []);
});

test('switching markets closes an open position; closing a paper position realizes it', async () => {
  const page = await env.page();
  const money = value => Number(String(value).replace(/[^0-9.-]/g, ''));
  await page.goto(`${env.base}/polymarket.html`);
  await page.uncheck('#autopilot');
  await page.click('#startBtn');
  await page.waitForTimeout(300);
  await page.fill('#margin', '200');
  await page.click('#buyYes');
  assert.ok(money(await text(page, '#cash')) < 850, 'margin left the cash');
  await page.selectOption('#marketSelect', '1');
  const cash = money(await text(page, '#cash'));
  assert.ok(cash > 900, `the position was closed back into cash, not discarded (cash ${cash})`);
  assert.match(await text(page, '#log'), /market switched/);

  await page.click('#startBtn');
  await page.waitForTimeout(300);
  await page.fill('#margin', '200');
  await page.click('#buyYes');
  await page.click('#resetAccount');
  assert.equal(money(await text(page, '#cash')), 1000, 'a reset starts clean: the old position is not credited to the new account');

  await page.fill('#advPrice', '40'); await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  await page.click('#advTrack');
  await page.locator('#paperList button').first().click();
  assert.match(await text(page, '#paperList'), /CLOSED at/);
  assert.notEqual(await text(page, '#paperRealized'), '$0', 'the closed position counts in realized P&L');
  assert.deepEqual(page.errors, []);
});

test('live advisor reads the market history: a view after big moves counts for less', async () => {
  const page = await env.page();
  const now = Math.floor(Date.now() / 1000);
  const swings = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 43200, p: i % 2 ? .40 : .55 }));
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets: [
    { id: '701', question: 'Volatile market?', outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]', bestBid: '0.39', bestAsk: '0.41', endDate: END(), clobTokenIds: '["7001","7002"]' }] } }));
  await page.route('**/api/polymarket/history?*', route => route.fulfill({ json: { history: swings } }));
  await page.route('**/api/polymarket/book?*', route => route.fulfill({ json: { book: { tokenId: '7001', asks: [{ price: .41, size: 1e6 }], bids: [] } } }));
  await page.goto(`${env.base}/polymarket.html`);
  await page.click('#loadLive');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#liveNote').textContent));
  await page.selectOption('#advMarket', '0');
  await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  await page.waitForFunction(() => /market moved recently/.test(document.querySelector('#advVerdict').textContent));
  assert.equal(await text(page, '#advVerdict h3'), 'No trade');
  assert.deepEqual(page.errors, []);
});

test('paper portfolio: at most 2 open positions per category', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/polymarket.html`);
  const ask = async question => {
    await page.fill('#advQuestion', question);
    await page.fill('#advPrice', '40'); await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
    await page.click('#advAsk');
    await page.waitForTimeout(150);
    return text(page, '#advVerdict h3');
  };
  assert.equal(await ask('Will Bitcoin be above 120k on Friday?'), 'Buy YES');
  await page.click('#advTrack');
  assert.equal(await ask('Will Ethereum be above 5k on Friday?'), 'Buy YES');
  await page.click('#advTrack');
  assert.equal(await ask('Will Solana be above 300 on Friday?'), 'No trade', 'a third crypto position is refused');
  assert.match(await text(page, '#advVerdict'), /2 open paper positions in crypto/);
  assert.ok(await page.isDisabled('#advTrack'));
  assert.equal(await ask('Will the Senate pass the budget bill?'), 'Buy YES', 'another category is still open');
  await page.locator('#paperList button').first().click();             // close one crypto position
  assert.equal(await ask('Will Solana be above 300 on Friday?'), 'Buy YES', 'a closed position frees the slot');
  assert.deepEqual(page.errors, []);
});

test('paper account: losses shrink the size and a deep drawdown trips the kill-switch', async () => {
  const lost = pnl => ({ question: 'Old lost bet?', side: 'YES', leverage: 1, entry: .5, shares: 100, margin: 100, borrowed: 0, spread: .02, lastYes: .5, openedAt: 1, settled: { outcome: 'NO', pnl, at: 2 } });
  const margins = {};
  for (const [label, pnl] of [['fresh', 0], ['down10', -100], ['down35', -350]]) {
    const page = await env.page();
    await page.addInitScript(([items]) => {
      localStorage.setItem('metyuLab.v1', JSON.stringify({ paper: items, paperPeak: { bankroll: 1000, equity: 1000 }, settings: { advBankroll: '1000' } }));
    }, [pnl ? [lost(pnl)] : []]);
    await page.goto(`${env.base}/polymarket.html`);
    await page.fill('#advQuestion', 'Will the Senate pass the budget bill?');
    await page.fill('#advPrice', '40'); await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
    await page.click('#advAsk');
    await page.waitForTimeout(150);
    margins[label] = { verdict: await text(page, '#advVerdict'), title: await text(page, '#advVerdict h3'), equity: await text(page, '#paperEquity') };
    assert.deepEqual(page.errors, []);
  }
  const marginOf = verdict => Number((verdict.match(/Margin \(max loss\)\$([\d,.]+)/) || [])[1]?.replace(/,/g, ''));
  assert.equal(margins.fresh.title, 'Buy YES');
  assert.equal(margins.down10.title, 'Buy YES');
  assert.ok(marginOf(margins.down10.verdict) < marginOf(margins.fresh.verdict), `smaller after losses: ${marginOf(margins.down10.verdict)} < ${marginOf(margins.fresh.verdict)}`);
  assert.equal(margins.down35.title, 'No trade', 'a 35% drawdown halts Metyu');
  assert.match(margins.down35.verdict, /KILL-SWITCH/);
  assert.match(margins.down35.equity, /\$650 · 35\.0% · KILL-SWITCH/);
});

test('paper account: total exposure is capped at 1.5x equity across categories', async () => {
  const page = await env.page();
  // Four open, flat positions in four categories: $1,480 of notional on a $1,000 account.
  const open = (question, notional) => ({ question, side: 'YES', leverage: 1, entry: .5, shares: notional / .5, margin: notional, borrowed: 0, spread: 0, lastYes: .5, openedAt: 1 });
  await page.addInitScript(([items]) => {
    localStorage.setItem('metyuLab.v1', JSON.stringify({ paper: items, paperPeak: { bankroll: 1000, equity: 1000 }, settings: { advBankroll: '1000' } }));
  }, [[open('Will Bitcoin be above 120k?', 400), open('Lakers vs Celtics', 400), open('Will Nvidia be the largest company?', 350), open('Will the Fed cut rates?', 330)]]);
  await page.goto(`${env.base}/polymarket.html`);
  await page.fill('#advQuestion', 'Will it snow in Paris on Christmas?');
  await page.fill('#advPrice', '40'); await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  await page.waitForTimeout(150);
  const verdict = await text(page, '#advVerdict');
  assert.match(verdict, /portfolio: (size cut to stay within 1.5x gross exposure|gross exposure cap 1.5x of equity reached)/, verdict);
  const notional = Number((verdict.match(/Leverage · notional\d+x · \$([\d,.]+)/) || [])[1]?.replace(/,/g, ''));
  if (await text(page, '#advVerdict h3') !== 'No trade') assert.ok(notional <= 20.01, `at most the $20 left: ${notional}`);
  assert.deepEqual(page.errors, []);
});

test('open paper positions show Metyu\'s hold / close verdict', async () => {
  const page = await env.page();
  let livePrice = '0.40';
  const end = END();
  const market = () => ({ id: '751', question: 'Will the review test pass?', outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([livePrice, String(1 - Number(livePrice))]), bestBid: '0.39', bestAsk: '0.41', endDate: end });
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets: [market()] } }));
  await page.route('**/api/polymarket/market?id=*', route => route.fulfill({ json: { market: market() } }));
  await page.goto(`${env.base}/polymarket.html`);
  await page.click('#loadLive');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#liveNote').textContent));
  await page.selectOption('#advMarket', '0');
  await page.fill('#advBelief', '62'); await page.selectOption('#advConfidence', 'high');
  await page.click('#advAsk');
  await page.waitForFunction(() => /Buy YES/.test(document.querySelector('#advVerdict h3').textContent));
  await page.click('#advTrack');
  assert.match(await text(page, '#paperList'), /Metyu: hold/);
  livePrice = '0.70';
  await page.click('#advRefresh');
  await page.waitForFunction(() => /refreshed/.test(document.querySelector('#advStatus').textContent));
  assert.match(await text(page, '#paperList'), /Metyu: close — edge gone/);
  assert.deepEqual(page.errors, []);
});

test('scenario stress test runs every scenario', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/polymarket.html`);
  await page.fill('#stMarkets', '20');
  await page.click('#runStress');
  const scenarios = await page.evaluate(() => Metyu.STRESS_SCENARIOS.length);
  await page.waitForFunction(count => document.querySelectorAll('#stBody tr').length === count && !document.querySelector('#runStress').disabled, scenarios, { timeout: 90000 });
  const rows = await page.$$eval('#stBody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent)));
  assert.match(rows.find(row => row[0].startsWith('Pump and dump')).join(' '), /%/);
  assert.match(await text(page, '#stStatus'), /done/);
  assert.deepEqual(page.errors, []);
});

test('lab layout fits a phone screen', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.goto(`${env.base}/polymarket.html`);
  assert.ok(await noHorizontalScroll(page));
});
