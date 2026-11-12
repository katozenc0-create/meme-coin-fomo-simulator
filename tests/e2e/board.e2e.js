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

test('autopilot panel shows the server-side autopilot (read-only)', async () => {
  const page = await env.page();
  const now = new Date().toISOString();
  await page.route('**/api/autopilot/status', route => route.fulfill({ json: {
    available: true, virtualMoney: true, lastTick: now, watching: 12,
    account: { bankroll: 10000, cash: 9600, peak: 10050, halted: false, realized: 50, trades: 2, wins: 1 },
    model: { source: 'autopilot · 407 resolved markets', trainedAt: Date.now(), kind: 'calib', gate: { open: false, trades: 0 } },
    positions: [{ id: '1', question: 'Q?', lastYes: .45, spread: 0, position: { side: 'YES', shares: 1000, borrowed: 0, interest: 0, margin: 400, leverage: 1, takerRate: 0 } }],
    history: [], trainings: [], log: [{ at: now, kind: 'TRAIN', text: 'retrained on 407 resolved markets · evidence gate closed' }]
  } }));
  await page.goto(`${env.base}/board.html`);
  await page.waitForFunction(() => /Live · real time/.test(document.querySelector('#apStatus').textContent));
  assert.match(await text(page, '#apStatus'), /watching 12 markets · watching only/);
  assert.equal(await text(page, '#apEquity'), '$10,050', 'cash 9,600 + 1,000 shares marked at 45c');
  assert.equal(await text(page, '#apTrades'), '2 · 50%');
  assert.match(await text(page, '#apGate'), /^closed/);
  assert.match(await text(page, '#apFeed'), /retrained on 407 resolved markets/);
  assert.deepEqual(page.errors, []);

  const idle = await env.page();
  await idle.route('**/api/autopilot/status', route => route.fulfill({ json: { available: false, reason: 'no autopilot state yet: run node autopilot.js' } }));
  await idle.goto(`${env.base}/board.html`);
  await idle.waitForFunction(() => /no autopilot state yet/.test(document.querySelector('#apStatus').textContent));
  assert.ok(await idle.locator('#apStats').isHidden());
});

test('phone layout: settings folded, the market cards close to the top; desktop keeps them open', async () => {
  const phone = await env.page({ width: 390, height: 844 });
  await phone.route('**/api/autopilot/status', route => route.abort());      // like GitHub Pages: no server
  await phone.goto(`${env.base}/board.html`);
  assert.equal(await phone.evaluate(() => document.querySelector('#settings').open), false, 'settings folded on a phone');
  assert.ok(await phone.locator('#autopilotPanel').isHidden(), 'no server: no autopilot panel');
  assert.ok(await phone.locator('#startBtn').isVisible(), 'Start stays visible');
  await phone.click('#startBtn');
  await phone.waitForSelector('#board .card');
  const top = await phone.evaluate(() => document.querySelector('#board .card').getBoundingClientRect().top + scrollY);
  assert.ok(top < 844, `the first market card starts within the first screen (${Math.round(top)}px)`);
  await phone.click('#settings > summary');
  assert.ok(await phone.locator('#maxLev').isVisible(), 'settings open on tap');
  assert.deepEqual(phone.errors, []);

  const desk = await env.page();
  await desk.goto(`${env.base}/board.html`);
  assert.equal(await desk.evaluate(() => document.querySelector('#settings').open), true, 'settings open on a computer');
});

test('board settings survive a reload', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/board.html`);
  await page.selectOption('#maxLev', '2');
  await page.fill('#maxCluster', '3'); await page.dispatchEvent('#maxCluster', 'change');
  await page.selectOption('#mode', 'live');
  await page.reload();
  assert.equal(await page.inputValue('#mode'), 'live');
  assert.equal(await page.inputValue('#maxLev'), '2');
  assert.equal(await page.inputValue('#maxCluster'), '3');
  assert.ok(await page.locator('#skillField').isHidden(), 'live mode hides the demo-only fields after a reload too');
  assert.match(await text(page, '#modeNote'), /^Live:/);
  assert.deepEqual(page.errors, []);
});

test('last 10 trades with P&L: newest first, total and win/loss count', async () => {
  const page = await env.page({ width: 390, height: 844 });
  // 12 closed trades, oldest first as the board stores them: trade i made (i - 5) dollars.
  const history = Array.from({ length: 12 }, (_, i) => ({
    openedAt: '', closedAt: new Date(Date.UTC(2026, 10, 1, i)).toISOString(), mode: 'live', market: `Market ${i + 1}?`, marketId: String(i),
    side: i % 2 ? 'NO' : 'YES', leverage: 1, entry: .4, exit: .45, margin: 100, notional: 100, pnl: i - 5, returnOnMargin: (i - 5) / 100, kind: 'CLOSE', note: 'edge gone'
  }));
  await page.addInitScript(([items]) => {
    localStorage.setItem('metyuBoard.v1', JSON.stringify({ account: { bankroll: 10000, cash: 10000, peak: 10000, realized: 0, trades: 12, wins: 6, history: items, curve: [10000] } }));
  }, [history]);
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.goto(`${env.base}/board.html`);
  const rows = await page.$$eval('#lastTrades li', items => items.map(item => [item.querySelector('.market').textContent, item.querySelector('.pnl').textContent, item.querySelector('.pnl').className]));
  assert.equal(rows.length, 10, 'only the last 10');
  assert.equal(rows[0][0], 'Market 12?', 'newest first');
  assert.equal(rows[9][0], 'Market 3?');
  assert.equal(rows[0][1], '+$6 (+6%)');
  assert.match(rows[0][2], /positive/);
  assert.match(rows.find(row => row[0] === 'Market 3?')[2], /negative/);
  // trades 3..12 made -3..+6 dollars: total +15, 6 won, 4 lost (0 counts as not won)
  assert.equal(await text(page, '#lastTradesSummary'), 'Last 10: +$15 · 6 won · 4 lost');
  assert.match(await text(page, '#lastTrades li'), /NO 1x · 40\.0¢ → 45\.0¢ · edge gone/);
  assert.ok(await noHorizontalScroll(page), 'fits a phone');
  assert.deepEqual(page.errors, []);
});

test('autopilot panel lists its last trades, settled ones at $1 / $0', async () => {
  const page = await env.page();
  await page.route('**/api/autopilot/status', route => route.fulfill({ json: {
    available: true, lastTick: new Date().toISOString(), watching: 3,
    account: { bankroll: 10000, cash: 10100, peak: 10100, halted: false, realized: 100, trades: 2, wins: 1 }, model: null, positions: [], trainings: [], log: [],
    history: [
      { closedAt: new Date().toISOString(), market: 'Won at resolution?', side: 'YES', leverage: 1, entry: .40, exitYes: 1, outcome: 'YES', margin: 100, pnl: 150, reason: 'market resolved' },
      { closedAt: new Date().toISOString(), market: 'Closed early?', side: 'NO', leverage: 2, entry: .60, exitYes: .55, outcome: 'CLOSED', margin: 100, pnl: -50, reason: 'edge gone' }
    ]
  } }));
  await page.goto(`${env.base}/board.html`);
  await page.waitForFunction(() => document.querySelectorAll('#apTradeList li').length === 2);
  assert.equal(await text(page, '#apTradeSummary'), 'Last 2: +$100 · 1 won · 1 lost');
  const details = await page.$$eval('#apTradeList .detail', items => items.map(item => item.textContent));
  assert.match(details[0], /YES 1x · 40\.0¢ → 100\.0¢ · resolved YES/);
  assert.match(details[1], /NO 2x · 60\.0¢ → 45\.0¢ · edge gone/, 'a NO position exits at 1 - YES price');
  assert.deepEqual(page.errors, []);
});

test('iPhone: an "Add to Home Screen" tip in Safari, gone once dismissed', async () => {
  const { devices } = require('playwright');
  const context = await env.browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.goto(`${env.base}/board.html`);
  assert.ok(await page.locator('#iosHint').isVisible(), 'Safari on iPhone shows how to add the app');
  assert.match(await text(page, '#iosHint'), /Add to Home Screen/);
  await page.click('#iosHintClose');
  await page.reload();
  assert.ok(await page.locator('#iosHint').isHidden(), 'a dismissed tip stays hidden');
  await context.close();

  const computer = await env.page();
  await computer.goto(`${env.base}/board.html`);
  assert.ok(await computer.locator('#iosHint').isHidden(), 'no iPhone tip on a computer');
  assert.deepEqual(errors, []);
});

test('like an app: a running board resumes when reopened, a paused one stays paused', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.goto(`${env.base}/board.html`);
  await page.click('#startBtn');
  await page.waitForSelector('#board .card');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#pauseBtn').disabled, null, { timeout: 10000 });
  assert.match(await text(page, '#statusNote'), /Demo running/, 'resumed without pressing Start');
  await page.click('#pauseBtn');
  await page.reload();
  await page.waitForTimeout(500);
  assert.equal(await page.isDisabled('#pauseBtn'), true, 'paused stays paused');
  assert.equal(await page.isDisabled('#startBtn'), false);
  assert.deepEqual(page.errors, []);
});

test('live mode refreshes the moment the app comes back to the foreground', async () => {
  const page = await env.page({ width: 390, height: 844 });
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const markets = [{ id: '950', eventId: 'v', question: 'Will the foreground test pass?', outcomes: '["Yes","No"]', outcomePrices: '["0.40","0.60"]', bestBid: '0.39', bestAsk: '0.41', endDate: end }];
  let polls = 0;
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets } }));
  await page.route('**/api/polymarket/market?id=*', route => { polls += 1; return route.fulfill({ json: { market: markets[0] } }); });
  await page.goto(`${env.base}/board.html`);
  await page.selectOption('#mode', 'live');
  await page.click('#startBtn');
  await page.waitForFunction(() => /live prices refreshed/.test(document.querySelector('#statusNote').textContent), null, { timeout: 20000 });
  const before = polls;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  assert.ok(polls > before, `refreshed at once (${before} -> ${polls}), not 30 s later`);
  assert.deepEqual(page.errors, []);
});

test('terminal view: every pipeline step is logged with its reason', async () => {
  const page = await env.page({ width: 390, height: 844 }, { view: null });   // the app's own default
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.goto(`${env.base}/board.html`);
  assert.ok(await page.locator('#terminal').isVisible(), 'the terminal is the default view');
  assert.ok(await page.locator('#board').isHidden(), 'cards hidden behind the toggle');
  await setValues(page, { '#speed': 10, '#skill': 90 });
  await page.click('#startBtn');
  await page.waitForFunction(() => /exit/.test(document.querySelector('#tLog').textContent) && /enter/.test(document.querySelector('#tLog').textContent), null, { timeout: 90000 });
  assert.match(await text(page, '#tRun'), /running/);
  assert.match(await text(page, '#tLog'), /reason: /, 'every logged step carries a reason');
  assert.match(await text(page, '#tTail'), /ENTER/);
  const trades = Number(await text(page, '#tTrades'));
  assert.equal(trades, Number(await text(page, '#tWins')) + Number(await text(page, '#tLosses')), 'trades = wins + losses');
  assert.match(await text(page, '#tSizer'), /% eq/);
  assert.equal((await page.$$('#tFlow .flow-chip')).length, 4);
  assert.ok(await noHorizontalScroll(page), 'fits a phone');
  await page.click('#viewBtn');
  assert.ok(await page.locator('#board').isVisible(), 'Cards view toggles back');
  await page.reload();
  assert.ok(await page.locator('#terminal').isHidden(), 'the chosen view is remembered');
  assert.deepEqual(page.errors, []);
});

test('terminal: a candidate the risk check blocks is logged as FILTERED with the rule', async () => {
  const page = await env.page({ width: 1366, height: 900 }, { view: 'terminal' });
  const end = new Date(Date.now() + 40 * 86400000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  const markets = Array.from({ length: 4 }, (_, index) => ({
    id: String(960 + index), eventId: `f${index}`, question: `Will Bitcoin be above ${100 + index}k USD?`, outcomes: '["Yes","No"]',
    outcomePrices: '["0.30","0.70"]', bestBid: '0.295', bestAsk: '0.305', endDate: end, clobTokenIds: JSON.stringify([String(9600 + index), String(9700 + index)])
  }));
  await page.route('**/api/autopilot/status', route => route.abort());
  await page.route('**/api/polymarket/markets?*', route => route.fulfill({ json: { markets } }));
  await page.route('**/api/polymarket/market?id=*', route => route.fulfill({ json: { market: markets.find(item => item.id === new URL(route.request().url()).searchParams.get('id')) } }));
  await page.route('**/api/polymarket/history?*', route => route.fulfill({ json: { history: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * 43200, p: .30 })) } }));
  await page.addInitScript(() => {
    localStorage.setItem('metyuModel.v1', JSON.stringify({ kind: 'calib', a: 1.2, b: 1, cov: [[.0005, 0], [0, .0005]], gate: { open: true, meanReturn: .1, ci: [.02, .2] }, source: 'test' }));
  });
  await page.goto(`${env.base}/board.html`);
  await page.selectOption('#mode', 'live');
  await page.click('#startBtn');
  await page.waitForFunction(() => /filtered/.test(document.querySelector('#tLog').textContent), null, { timeout: 20000 });
  assert.match(await text(page, '#tLog'), /reason: max 2 open positions in crypto/, 'the third Bitcoin market is filtered by the category rule');
  assert.equal(await text(page, '#tFiltered'), '2', 'four candidates, two filtered');
  assert.equal(await text(page, '#agRiskChip'), 'filter');
  assert.deepEqual(page.errors, []);
});

test('autopilot panel reads a published status (GitHub Pages path) and shows the forward test', async () => {
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/status.json';
  const now = new Date().toISOString();
  await page.route('**/api/autopilot/status', route => route.fulfill({ status: 404, json: { error: 'no server' } }));
  await page.route(published, route => route.fulfill({ json: {
    available: true, virtualMoney: true, createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), lastTick: now, watching: 12,
    account: { bankroll: 10000, cash: 9600, peak: 10010, halted: false, realized: 12, trades: 3, wins: 2 },
    model: { source: 'autopilot · 1500 resolved markets', trainedAt: Date.now(), kind: 'calib', gate: { open: false, trades: 0 } },
    positions: [{ id: '1', question: 'Learning position?', learning: true, lastYes: .4, spread: 0, position: { side: 'NO', shares: 160, borrowed: 0, interest: 0, margin: 96, leverage: 1, takerRate: 0 } }],
    history: [{ closedAt: now, market: 'Closed learning trade?', side: 'NO', leverage: 1, entry: .6, exitYes: 0, outcome: 'NO', margin: 100, pnl: 66, reason: 'market resolved', learning: true }],
    trainings: [], log: [{ at: now, kind: 'LEARN', text: 'Learning position? — NO 1x' }],
    forward: { learning: { trades: 3, wins: 2, pnl: 12, meanReturn: .04, ci: [-.2, .3], days: 3, convincing: false }, gated: { trades: 0, wins: 0, pnl: 0, meanReturn: 0, ci: [0, 0], days: 0, convincing: false } }
  } }));
  await page.goto(`${env.base}/board.html?autopilot=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => /Live · real time/.test(document.querySelector('#apStatus').textContent), 'a tick seconds ago is real time');
  assert.match(await text(page, '#apStatus'), /learning book: small unlevered test trades/);
  assert.match(await text(page, '#apForward'), /Training done \(3 days\) · day 4 · forward test: 3 closed learning trades · 2 won · mean 4\.0% per \$1 · 95% \[-20\.0%, 30\.0%\] · not convincing yet/);
  assert.match(await text(page, '#apTradeList'), /learning · resolved NO/);
  assert.deepEqual(page.errors, []);
});

test('exchange panel shows the crypto autopilot: chart with levels, positions, gates, forward test', async () => {
  // A real status object, made by the autopilot's own statusOf from a synthetic market.
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const H = X.HOUR;
  const now = Date.now();
  const bars = Array.from({ length: 300 }, (_, i) => { const t = Math.floor(now / H) * H - (300 - i) * H; const p = 60000 + 3000 * Math.sin(i / 25) + 20 * i; return { t, o: p - 40, h: p + 120, l: p - 150, c: p + 30, v: 100 }; });
  const state = freshState();
  state.createdAt = new Date(now - 2 * X.DAY).toISOString();
  state.lastTick = new Date(now - 5 * 60000).toISOString();
  state.marks = { 'BTC-USD': { price: bars[299].c, at: state.lastTick, source: 'coinbase' }, 'ETH-USD': { price: bars[299].c / 30, at: state.lastTick, source: 'coinbase' } };
  const entry = bars[299].c - 200;
  state.positions.x1 = { id: 'x1', symbol: 'BTC-USD', strategy: 'trend', book: 'learning', side: 'LONG', entry, qty: .05, notional: entry * .05, margin: entry * .05 / 1.5, leverage: 1.5, stop: entry - 900, initialStop: entry - 900, target: entry + 1400, liquidation: entry * .34, entryFee: 3, risk: 25, atr: 400, openedAt: now - 3 * H, reason: 'uptrend pullback: RSI 48' };
  state.account.cash -= state.positions.x1.margin;
  state.history = [{ id: 'x0', symbol: 'ETH-USD', strategy: 'breakout', side: 'SHORT', book: 'learning', learning: true, leverage: 2, entry: 2100, exit: 2050, margin: 300, risk: 25, pnl: 21.5, r: .86, reason: 'take profit', openedAt: new Date(now - 9 * H).toISOString(), closedAt: new Date(now - 4 * H).toISOString() }];
  state.model = { trainedAt: now - H, bars: 24000, symbols: ['BTC-USD'], strategies: {
    trend: { label: 'Trend pullback', params: {}, gate: { open: false, trades: 150, wins: 51, meanR: -.13, ci: [-.28, .03] } },
    breakout: { label: 'Range breakout', params: {}, gate: { open: false, trades: 158, wins: 46, meanR: -.27, ci: [-.42, -.13] } }
  } };
  state.log = [{ at: state.lastTick, kind: 'LEARN', text: 'BTC-USD LONG 1.5x @ 66000 · Trend pullback' }];
  const status = statusOf(state, { now, series: { 'BTC-USD': bars, 'ETH-USD': bars.map(b => ({ ...b, o: b.o / 30, h: b.h / 30, l: b.l / 30, c: b.c / 30 })) } });

  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exchangePanel').hidden && /Live · real time/.test(document.querySelector('#exStatus').textContent));
  assert.match(await text(page, '#exStatus'), /2 coins, live Coinbase prices · learning book: 0\.25% risk per trade, up to 2x/);
  assert.match(await text(page, '#exForward'), /Training · day 3\/3 · forward test: 1 closed learning trades · 1 won · mean \+0\.86R per trade/);
  assert.equal(await text(page, '#exGates'), '0/2 open');
  assert.equal(await page.inputValue('#exSymbol'), 'BTC-USD', 'the coin with a position is shown first');
  assert.ok(await page.locator('#exChart').isVisible(), 'the chart is visible');
  assert.ok(await page.locator('#exChart rect').count() >= 120, 'candles drawn');
  assert.equal(await page.locator('#exChart polyline').count(), 2, 'EMA20 and EMA50');
  for (const cls of ['entry', 'stop', 'target']) assert.equal(await page.locator(`#exChart line.${cls}`).count(), 1, `${cls} line`);
  assert.equal(await page.locator('#exChart line.liq').count(), 0, 'a far liquidation price is not drawn (it would squash the chart)');
  assert.match(await text(page, '#exNotes'), /RSI \d+/);
  assert.match(await text(page, '#exPositions'), /BTC-USD · LONG 1\.5x · learning.*stop \$.* target \$.* liq \$.* uptrend pullback/);
  assert.match(await text(page, '#exStrategies'), /Trend pullback: gate closed · learning book ?150 out-of-sample trades · 51 won · mean -0\.13R/);
  assert.match(await text(page, '#exStrategies'), /Range breakout: gate closed · not traded \(loses after costs\)/);
  assert.match(await text(page, '#exTradeList'), /ETH-USD · breakout.*SHORT 2\.0x · learning · \$2,100 → \$2,050 · \+0\.86R · take profit/);
  await page.selectOption('#exSymbol', 'ETH-USD');
  assert.equal(await page.locator('#exChart line.entry').count(), 0, 'no position on ETH');
  assert.ok(await noHorizontalScroll(page), 'fits the phone');
  assert.deepEqual(page.errors, []);
});

test('account panel: the sealed snapshot opens only with the right passphrase, then locks again', async () => {
  const Vault = require('../../metyu-vault.js');
  const pass = 'my long board passphrase';
  const box = await Vault.seal({ kind: 'account', provider: 'coinbase', verifiedAt: new Date(Date.now() - 4 * 60000).toISOString(), viewOnly: true, permissions: { can_view: true, can_trade: false, can_transfer: false },
    balances: [{ asset: 'BTC', free: .4, locked: .1, total: .5, usd: 35000 }, { asset: 'USDC', free: 120, locked: 0, total: 120, usd: 120 }, { asset: 'ODD', free: 3, locked: 0, total: 3, usd: null }], totalUsd: 35120, unpriced: ['ODD'] }, pass, { iterations: 100000, label: 'metyu-account' });
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/account.enc.json';
  await page.route(published, route => route.fulfill({ json: box }));
  await page.goto(`${env.base}/board.html?account=${encodeURIComponent(published)}`);
  await page.waitForSelector('#accountPanel:not([hidden])');
  assert.equal(await page.locator('#acBody').isHidden(), true, 'nothing is shown before unlocking');
  assert.ok(!(await page.content()).includes('35,120'), 'no balance in the page before unlocking');
  await page.fill('#acPass', 'a wrong passphrase!');
  await page.click('#acOpen');
  await page.waitForFunction(() => /Wrong passphrase/.test(document.querySelector('#acStatus').textContent));
  assert.equal(await page.locator('#acBody').isHidden(), true);
  assert.equal(await page.inputValue('#acPass'), '', 'the field is cleared');
  await page.fill('#acPass', pass);
  await page.click('#acOpen');
  await page.waitForSelector('#acBody:not([hidden])');
  assert.equal(await text(page, '#acTotal'), '$35,120');
  assert.equal(await text(page, '#acKey'), 'view-only ✓');
  assert.equal(await text(page, '#acVerified'), '4 min ago');
  assert.match(await text(page, '#acBalances'), /BTC\$35,000 ?0\.5 BTC · 0\.1 in orders.*USDC\$120.*ODDno USD price/);
  assert.match(await text(page, '#acStatus'), /cannot trade or withdraw/);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.ok(!stored.includes(pass) && !stored.includes('35120'), 'neither the passphrase nor the balances are stored');
  await page.click('#acLock');
  assert.equal(await page.locator('#acBody').isHidden(), true);
  assert.equal(await page.locator('#acBalances li').count(), 0, 'balances are removed from the page');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('real-money lock is shown with every unmet condition and the first-order limits', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - 3 * X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const status = statusOf(state, { accountLink: { linked: true, viewOnly: true } });
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => /Real money: LOCKED/.test(document.querySelector('#exLiveHead').textContent));
  assert.equal(await text(page, '#exLiveHead'), 'Real money: LOCKED · 3/6 conditions met');
  assert.equal(await page.locator('#exLive li.ok').count(), 3, 'training days, no kill-switch and a linked view-only account');
  assert.match(await text(page, '#exLive'), /forward test ran 3\+ days \(now 3\)/);
  assert.match(await text(page, '#exLiveLimits'), /\$25 per order, \$100 open in total, \$50 maximum loss per day, no leverage/);
  assert.deepEqual(page.errors, []);
});

test('v2 status line: real time vs every 15 minutes, and the owner pause', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const make = (minutesAgo, paused) => {
    const state = freshState();
    state.createdAt = new Date(Date.now() - X.DAY / 2).toISOString();
    state.lastTick = new Date(Date.now() - minutesAgo * 60000).toISOString();
    state.paused = paused;
    return statusOf(state);
  };
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  let status = make(2, false);
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => /Live · real time/.test(document.querySelector('#exStatus').textContent));
  assert.match(await text(page, '#exForward'), /^Training · day 1\/3 · forward test: no closed learning trades yet/);
  status = make(20, true);
  await page.reload();
  await page.waitForFunction(() => /Running 24\/7 · every 15 min · PAUSED by the owner/.test(document.querySelector('#exStatus').textContent));
  status = make(300, false);
  await page.reload();
  await page.waitForFunction(() => /Last seen 300 min ago/.test(document.querySelector('#exStatus').textContent));
  assert.match(await text(page, '.term-title'), /v2 · virtual/);
  assert.deepEqual(page.errors, []);
});

test('exchange panel stays hidden when no exchange autopilot publishes anything', async () => {
  const page = await env.page();
  await page.route('**/api/exchange/status', route => route.fulfill({ status: 404, json: {} }));
  await page.goto(`${env.base}/board.html`);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#exchangePanel').isHidden(), true);
  assert.deepEqual(page.errors, []);
});

test('board layout fits a phone screen', async () => {
  const page = await env.page({ width: 390, height: 844 });
  await page.goto(`${env.base}/board.html`);
  assert.ok(await noHorizontalScroll(page));
});
