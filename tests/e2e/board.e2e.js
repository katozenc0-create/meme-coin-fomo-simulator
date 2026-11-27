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
  // #board is parsed before the board's script runs: wait for the page to finish loading so the
  // Export button has its handler (on a slow CI runner the click could come first).
  await page.waitForLoadState('load');
  await page.click('#exportBtn');
  await page.waitForFunction(() => /no closed trades to export/.test(document.querySelector('#feed').textContent));

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
  // The live system comes first; the demo simulator is its own section after the live panels.
  const order = await phone.evaluate(() => ['walletPanel', 'exchangePanel', 'terminal', 'simulatorTitle', 'demoControls', 'board'].map(id => document.getElementById(id)).filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect().top + scrollY));
  assert.ok(order.length >= 4, 'the visible sections were measured');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'wallet, agents, terminal, then the simulator');
  await phone.click('#startBtn');
  await phone.waitForSelector('#board .card');
  assert.ok(await phone.locator('#board .card').first().isVisible(), 'the demo cards render');
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

test('terminal shows the 24/7 autopilots: crypto by default, Polymarket and this device on demand', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const H = X.HOUR;
  const now = Date.now();
  const bars = Array.from({ length: 300 }, (_, i) => { const t = Math.floor(now / H) * H - (300 - i) * H; const p = 60000 + 3000 * Math.sin(i / 25) + 20 * i; return { t, o: p - 40, h: p + 120, l: p - 150, c: p + 30, v: 100 }; });
  const state = freshState();
  state.createdAt = new Date(now - X.DAY / 2).toISOString();
  state.lastTick = new Date(now - 2 * 60000).toISOString();
  state.marks = { 'BTC-USD': { price: bars[299].c, at: state.lastTick, source: 'coinbase' } };
  const entry = bars[299].c - 300;
  state.positions.x1 = { id: 'x1', symbol: 'BTC-USD', strategy: 'trend', book: 'learning', side: 'LONG', entry, qty: .05, notional: entry * .05, margin: entry * .05 / 1.5, leverage: 1.5, stop: entry - 900, initialStop: entry - 900, target: entry + 1400, liquidation: entry * .34, entryFee: 3, risk: 25, atr: 400, openedAt: now - H, reason: 'uptrend pullback: RSI 48' };
  state.account.cash -= state.positions.x1.margin;
  state.history = [{ id: 'x0', symbol: 'ETH-USD', strategy: 'breakout', side: 'SHORT', book: 'learning', learning: true, leverage: 2, entry: 2100, exit: 2050, margin: 300, risk: 25, pnl: 21.5, r: .86, reason: 'take profit', openedAt: new Date(now - 9 * H).toISOString(), closedAt: new Date(now - 4 * H).toISOString() }];
  state.account.trades = 1; state.account.wins = 1; state.account.realized = 21.5; state.account.cash += 21.5;
  state.model = { trainedAt: now - H, bars: 24000, symbols: ['BTC-USD'], strategies: { trend: { label: 'Trend pullback', params: {}, gate: { open: false, trades: 150, wins: 51, meanR: -.13, ci: [-.28, .03] } } } };
  state.log = [
    { at: new Date(now - 60 * 60000).toISOString(), kind: 'LEARN', text: 'BTC-USD LONG 1.5x @ 64000 · Trend pullback: uptrend pullback · stop 63100 · margin $2,133.33 · risk $25.00' },
    { at: new Date(now - 4 * 60 * 60000).toISOString(), kind: 'LEARN-CLOSE', text: 'ETH-USD SHORT 2.0x · take profit @ 2050 · +$21.50 (+0.86R)' },
    { at: new Date(now - 5 * 60 * 60000).toISOString(), kind: 'SKIP', text: 'SOL-USD LONG (trend): cool-down after a loss (6 h)' }
  ];
  const exchange = statusOf(state, { now, series: { 'BTC-USD': bars } });
  const polymarket = {
    available: true, virtualMoney: true, createdAt: new Date(now - X.DAY).toISOString(), lastTick: new Date(now - 20 * 60000).toISOString(), watching: 12,
    account: { bankroll: 10000, cash: 9900, peak: 10000, halted: false, realized: 0, trades: 0, wins: 0 },
    model: { source: 'autopilot', trainedAt: now, kind: 'calib', gate: { open: false, trades: 0 } },
    positions: [{ id: '1', question: 'Will it snow in Paris?', learning: true, lastYes: .4, spread: 0, openedAt: new Date(now - H).toISOString(), position: { side: 'NO', shares: 160, borrowed: 0, interest: 0, margin: 100, leverage: 1, entry: .6, notional: 100, takerRate: 0 } }],
    history: [], trainings: [], log: [{ at: new Date(now - H).toISOString(), kind: 'LEARN', text: 'Will it snow in Paris? — NO 1x @ 60.0c · margin 100.00 · NO edge 2.0 pts' }, { at: new Date(now - 2 * H).toISOString(), kind: 'SETTLE', text: 'Commanders vs. Giants — NO resolved YES · -100.00 · market resolved' }],
    forward: { learning: { trades: 0, wins: 0, pnl: 0, meanReturn: 0, ci: [0, 0], days: 0, convincing: false } }
  };
  const page = await env.page({ width: 390, height: 844 }, { view: 'terminal' });
  const ex = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  const pm = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/status.json';
  await page.route(ex, route => route.fulfill({ json: exchange }));
  await page.route(pm, route => route.fulfill({ json: polymarket }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(ex)}&autopilot=${encodeURIComponent(pm)}`);
  await page.waitForFunction(() => document.querySelector('#terminal').dataset.source === 'exchange');
  assert.equal(await text(page, '#tMode'), 'paper · 24/7 crypto');
  assert.match(await text(page, '#tRun'), /live · real time/);
  assert.match(await text(page, '#tClock'), /last tick/);
  assert.match(await text(page, '#tTag'), /Training · day 1\/3 · real money locked \(\d\/6\)/);
  assert.equal(await text(page, '#tTrades'), '1');
  assert.equal(await text(page, '#tWins'), '1');
  assert.match(await text(page, '#tTradeMarket'), /BTC-USD · trend/);
  assert.match(await text(page, '#tTradeKv'), /entry\$[\d,]+.*stop\$[\d,]+.*target\$[\d,]+.*liq\.\$[\d,]+.*learning/);
  assert.match(await text(page, '#tTradeChip'), /LONG 1\.5x/);
  assert.match(await text(page, '#agScannerLast'), /1 coins · \d up · \d down · \d range/);
  assert.match(await text(page, '#agSizerLast'), /0\.25% risk per trade \(learning\)/);
  assert.match(await text(page, '#agEquityLast'), /drawdown .*kill at 15%/);
  assert.match(await text(page, '#tFlow'), /BTC-USD\$[\d,]+ · \w+ · RSI \d+ · LONG/);
  assert.equal(await text(page, '#tFiltered'), '1');
  assert.match(await text(page, '#tLog'), /enter.*BTC-USD.*margin \$2,133\.33.*exit.*ETH-USD.*\+\$21\.50.*filtered.*SOL-USD.*cool-down/);
  assert.match(await text(page, '#tWL'), /1 W \/ 0 L · realized \+\$21\.5/);
  assert.match(await text(page, '#tRecent'), /ETH-USD · breakout\s*\+\$21\.5/, 'the last trades, newest first');
  assert.match(await text(page, '#tRecentSum'), /\+\$21\.5\d? · 1\/1 won/);
  assert.ok(await page.locator('#tRecent').isVisible(), 'the last 8 trades are on screen');
  assert.ok(await page.locator('#agScanner').isHidden() && await page.locator('#tLog').isHidden(), 'the simple terminal: no agent cards, no raw log');
  assert.ok(await noHorizontalScroll(page), 'fits the phone');

  await page.selectOption('#tSource', 'polymarket');
  assert.equal(await text(page, '#tMode'), 'paper · 24/7 Polymarket');
  assert.match(await text(page, '#tRun'), /running 24\/7 · scheduled/);
  assert.match(await text(page, '#tTradeMarket'), /it snow in Paris/);
  assert.match(await text(page, '#tLog'), /enter.*it snow in Paris\?.*margin \$100\.00/);
  assert.match(await text(page, '#tLog'), /exit.*Commanders vs\. Giants.*resolved YES.*-\$100\.00/, 'a settled market shows its loss');
  assert.match(await text(page, '#agRiskLast'), /evidence gate closed: learning book only/);

  await page.selectOption('#tSource', 'device');
  assert.match(await text(page, '#tMode'), /paper · (demo|live)/);
  assert.match(await text(page, '#tTail'), /press Start/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#terminal').dataset.source === 'device');
  assert.equal(await page.inputValue('#tSource'), 'device', 'the choice is remembered');
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
  // Live Coinbase price, $1,000 above the agent's mark: the LONG's P&L moves by 0.05 x 1000 = +$50.
  const tickers = [];
  await page.route('https://api.exchange.coinbase.com/products/*/ticker', route => { tickers.push(route.request().url()); return route.fulfill({ json: { price: String(bars[299].c + 1000) } }); });
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exchangePanel').hidden && /Live · real time/.test(document.querySelector('#exStatus').textContent));
  // The live overview, first on the page: equity, today, open P&L at live prices, the last 24 hours.
  await page.waitForFunction(() => /prices \d+ s ago/.test(document.querySelector('#ovFresh').textContent));
  assert.ok(await page.locator('#overview').isVisible());
  assert.equal(await page.evaluate(() => document.querySelector('section').id), 'overview', 'the overview comes first');
  assert.deepEqual(tickers.map(url => new URL(url).pathname), ['/products/BTC-USD/ticker'], 'only the coins with a position are priced live');
  const livePnl = (status.positions[0].pnl + 50).toFixed(2);
  const positionsText = await text(page, '#ovPositions');
  assert.ok(positionsText.includes('BTC-USD LONG 1.5x · learning · trend'), positionsText);
  assert.ok(positionsText.includes(`+$${livePnl}`), `${positionsText} should show +$${livePnl}`);
  assert.match(await text(page, '#ovOpen'), /^1 · \+\$/);
  assert.match(await text(page, '#ovOpenSub'), /0 normal · 1 learning/);
  assert.match(await text(page, '#ovGates'), /0\/2 open/);
  assert.match(await text(page, '#ovGatesSub'), /learning book only/);
  assert.match(await text(page, '#ovLive'), /locked · \d\/6/);
  assert.match(await text(page, '#ovLiveSub'), /^next: /);
  assert.match(await text(page, '#ovDigest'), /crypto: 1 closed · 1 won\s*\+\$21\.5/);
  assert.match(await text(page, '#ovDigest'), /opened 0 normal · 1 learning/);
  assert.equal(await text(page, '#ovWallet'), 'not linked', 'the real wallet strip, kept apart from the virtual figures');
  assert.match(await text(page, '#exStatus'), /2 coins, live Coinbase prices · learning book: 0\.25% risk per trade, up to 2x/);
  assert.match(await text(page, '#ovPosHead'), /^Open positions · live Coinbase prices$/, 'without the Hyperliquid venue: Coinbase');
  assert.match(await text(page, '#exForward'), /Training · day 3\/3 · forward test · normal book: no closed trades yet \(needs 30\+\) · learning book: 1 closed · 1 won · \+\$\d+ · mean \+0\.86R/);
  assert.equal(await text(page, '#exGates'), '0/2 open');
  assert.equal(await page.inputValue('#exSymbol'), 'BTC-USD', 'the coin with a position is shown first');
  assert.ok(await page.locator('#exChart').isVisible(), 'the chart is visible');
  assert.ok(await page.locator('#exChart rect').count() >= 120, 'candles drawn');
  // Price labels on the right edge never overlap (a stop trailed to the entry shares one label).
  const labelYs = await page.$$eval('#exChart text', texts => texts.filter(t => Number(t.getAttribute('x')) > 200).map(t => Number(t.getAttribute('y'))).sort((a, b) => a - b));
  for (let i = 1; i < labelYs.length; i += 1) assert.ok(labelYs[i] - labelYs[i - 1] >= 8.9, `labels ${labelYs[i - 1]} and ${labelYs[i]} overlap`);
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

test('Solana wallet linked on this device: balances read from the network, address never uploaded', async () => {
  const wallet = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const meme = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk';
  const page = await env.page({ width: 390, height: 844 });
  const seen = [];
  page.on('request', request => seen.push({ url: request.url(), body: request.postData() || '' }));
  await page.route('https://api.mainnet-beta.solana.com/', async route => {
    const { method, params, id } = JSON.parse(route.request().postData());
    if (method === 'getBalance') return route.fulfill({ json: { jsonrpc: '2.0', id, result: { value: 1_500_000_000 } } });
    const legacy = params[1].programId.startsWith('Tokenkeg');
    const account = (mint, amount) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: String(amount) } } } } } });
    return route.fulfill({ json: { jsonrpc: '2.0', id, result: { value: legacy ? [account('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 20), account(meme, 1000)] : [] } } });
  });
  // Jupiter's successor host is the fallback; here it is down, so nothing reaches the real network.
  await page.route('https://api.jup.ag/**', route => route.fulfill({ status: 503, json: {} }));
  await page.route('https://lite-api.jup.ag/price/v3?**', route => route.fulfill({ json: { [meme]: { usdPrice: .01 } } }));
  // A scam airdrop named "USDC" (not the real mint): it must never be counted as $1 a token.
  await page.route('https://lite-api.jup.ag/tokens/v2/search?**', route => route.fulfill({ json: [{ id: meme, symbol: 'BONK', name: 'Bonk' }, { id: 'ABcQ2wbqLSu7RZCe5ELhbCxW6wJvMh5EB6KpBGfhpcwt', symbol: 'USDC', name: 'USDC (usdc-earn.xyz - claim)' }] }));
  // Jupiter's balances API is the primary source in the browser; fail it once to exercise the RPC fallback.
  let jupiterUp = false;
  await page.route(`https://lite-api.jup.ag/ultra/v1/balances/${wallet}`, route => (jupiterUp
    ? route.fulfill({ json: { SOL: { uiAmount: 1.5 }, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { uiAmount: 20 }, [meme]: { uiAmount: 1000 }, Ht3cqPuEUR6jiNiFsF1n93TPokuq1jqiMKujAjDdxXCB: { uiAmount: 1 }, '43mFcHg1TGjPXLXZymDWG1ttdcKXZTvP9zEPnpjGfhXM': { uiAmount: 1 }, ABcQ2wbqLSu7RZCe5ELhbCxW6wJvMh5EB6KpBGfhpcwt: { uiAmount: 9389 } } })
    : route.fulfill({ status: 503, json: {} })));
  await page.route('https://api.exchange.coinbase.com/products/SOL-USD/ticker', route => route.fulfill({ json: { price: '150' } }));
  await page.goto(`${env.base}/board.html`);
  assert.ok(await page.locator('#walletPanel').isVisible());
  // A recovery phrase pasted into the address field is wiped at once, with a loud warning.
  await page.fill('#wAddress', 'abandon ability able about above absent absorb abstract absurd abuse access accident');
  assert.equal(await page.inputValue('#wAddress'), '', 'the phrase is wiped from the field at once');
  assert.ok(await page.locator('#secAlert').isVisible());
  assert.match(await text(page, '#secAlert'), /RECOVERY \(SEED\) PHRASE.*wiped at once: never kept, stored or sent/);
  // A private key too, in any field.
  await page.fill('#wAddress', '4' + '5'.repeat(86));
  assert.equal(await page.inputValue('#wAddress'), '');
  assert.match(await text(page, '#secAlert'), /PRIVATE KEY/);
  // Anything else that is not an address is still refused by the form.
  await page.fill('#wAddress', 'not-an-address');
  await page.click('#wLink');
  assert.match(await text(page, '#wStatus'), /not a Solana address.*Never paste a seed phrase/);
  assert.equal(await page.evaluate(() => localStorage.getItem('metyuBoard.solanaWallet')), null, 'nothing stored');
  assert.ok(!seen.some(r => /abandon|5{40}/.test(r.url + r.body)), 'the secrets never left the page');
  await page.fill('#wAddress', `  solana:${wallet}?amount=1 `);
  await page.click('#wLink');
  await page.waitForFunction(() => /address: Metyu reads/.test(document.querySelector('#wStatus').textContent));
  assert.equal(await text(page, '#wTotal'), '$255', '1.5 SOL × $150 + 20 USDC + 1000 × $0.01');
  assert.equal(await text(page, '#wShort'), '7xKX…gAsU');
  // Verified on-chain, with an independent check on a block explorer.
  assert.match(await text(page, '#wVerified'), /^✓ verified on-chain at \d\d:\d\d$/);
  assert.equal(await page.getAttribute('#wExplorer', 'href'), `https://solscan.io/account/${wallet}`);
  assert.equal(await page.getAttribute('#wExplorer', 'rel'), 'noopener noreferrer');
  assert.equal(await page.locator('#wBalances').count(), 0, 'no holdings list on the board: the verified total only');
  assert.equal(await page.evaluate(() => localStorage.getItem('metyuBoard.solanaWallet')), wallet);
  const leaks = seen.filter(r => (r.url.includes(wallet) || r.body.includes(wallet)) && !['api.mainnet-beta.solana.com', 'lite-api.jup.ag', 'api.jup.ag'].includes(new URL(r.url).host));
  assert.deepEqual(leaks, [], 'the address only ever goes to the balance sources (Jupiter, Solana RPC)');
  jupiterUp = true;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#wTotal').textContent === '$255');
  // The scam "USDC" is not counted (the total stays $255) and is always warned about.
  assert.ok(await page.locator('#wWarn').isVisible());
  assert.match(await text(page, '#wWarn'), /⚠ 1 impostor token \(USDC without the real mint\): likely a scam airdrop, not counted/);
  await page.click('#wUnlink');
  assert.equal(await page.evaluate(() => localStorage.getItem('metyuBoard.solanaWallet')), null);
  assert.equal(await page.locator('#wForm').isVisible(), true);
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('real-money lock is shown with every unmet condition and the first-order limits', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - 3 * X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const status = statusOf(state, { accountLink: { linked: true, viewOnly: true, verifiedAt: new Date(Date.now() - 600000).toISOString() } });
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
  assert.match(await text(page, '#exForward'), /^Training · day 1\/3 · forward test · normal book: no closed trades yet \(needs 30\+\) · learning book: no closed trades yet/);
  status = make(20, true);
  await page.reload();
  await page.waitForFunction(() => /Running 24\/7 · scheduled · PAUSED by the owner/.test(document.querySelector('#exStatus').textContent));
  status = make(300, false);
  await page.reload();
  await page.waitForFunction(() => /⚠ SILENT · last seen 300 min ago/.test(document.querySelector('#exStatus').textContent));
  status = { ...make(2, false), health: { staleMarks: ['SUI-USD'], errorsLastHour: 1, modelAgeHours: 3, ok: false } };
  await page.reload();
  await page.waitForFunction(() => /Live · real time · ⚠ stale prices: SUI-USD \(not traded\)/.test(document.querySelector('#exStatus').textContent));
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

test('wallet security: an open token approval in the linked wallet raises a red alert on the board', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - 3 * X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const link = { linked: true, viewOnly: true, provider: 'solana', verifiedAt: new Date(Date.now() - 600000).toISOString() };
  let status = statusOf(state, { accountLink: { ...link, security: { approvals: 2, checkedAt: link.verifiedAt } } });
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#secAlert').hidden);
  assert.match(await text(page, '#secAlert'), /WALLET SECURITY: the linked wallet has 2 open token approvals.*Revoke them now/);
  assert.match(await text(page, '#exLive'), /2 OPEN TOKEN APPROVAL\(S\): revoke them/, 'the real-money lock does not count a drainable wallet');
  // Revoked: the alert goes away.
  status = statusOf(state, { accountLink: { ...link, security: { approvals: 0, checkedAt: link.verifiedAt } } });
  await page.reload();
  await page.waitForFunction(() => /no open token approvals/.test(document.querySelector('#exLive').textContent) || document.querySelector('#exLiveHead').textContent.includes('3/6'));
  assert.ok(await page.locator('#secAlert').isHidden());
  assert.deepEqual(page.errors, []);
});

test('CSP: an injected inline script is refused by the browser (no XSS on the board)', async () => {
  const page = await env.page({ width: 390, height: 844 });
  const violations = [];
  await page.exposeFunction('reportViolation', v => violations.push(v));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.reportViolation(e.violatedDirective)));
  await page.goto(`${env.base}/board.html`);
  await page.waitForSelector('#overview', { state: 'attached' });
  // What an attacker would try: insert a script element that fakes a wallet prompt.
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__pwned = true; document.body.insertAdjacentHTML("afterbegin", "<p id=fake>Connect your wallet</p>")';
    document.head.append(script);
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'the injected script did not run');
  assert.equal(await page.locator('#fake').count(), 0);
  assert.ok(violations.some(v => v.startsWith('script-src')), `a CSP violation was reported (${violations})`);
  // The board's own scripts still run.
  assert.ok(await page.evaluate(() => typeof MetyuWallet === 'object' && typeof MetyuWallet.looksLikeSecret === 'function'));
  // The only console errors are the browser's own reports of the blocked injection.
  assert.deepEqual(page.errors.filter(e => !/Executing inline script violates the following Content Security Policy/.test(e)), []);
});

test('the simple board: the live overview and the terminal only; "All panels" shows the rest, remembered', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - 3 * X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const status = statusOf(state);
  const page = await env.page({ width: 390, height: 844 }, { view: null, layout: null });   // the app's own defaults
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#overview').hidden);
  assert.ok(await page.locator('#overview').isVisible());
  assert.ok(await page.locator('#terminal').isVisible(), 'the terminal right under the overview');
  for (const id of ['#walletPanel', '#exchangePanel', '#demoControls', '#simulatorTitle', '#board']) assert.ok(await page.locator(id).isHidden(), `${id} hidden on the simple board`);
  const [overviewBottom, terminalTop] = await page.evaluate(() => [document.querySelector('#overview').getBoundingClientRect().bottom, document.querySelector('#terminal').getBoundingClientRect().top]);
  assert.ok(terminalTop >= overviewBottom && terminalTop - overviewBottom < 40, 'the two panels follow each other');
  assert.equal(await text(page, '#layoutBtn'), 'All panels ▾');
  await page.click('#layoutBtn');
  assert.ok(await page.locator('#walletPanel').isVisible() && await page.locator('#exchangePanel').isVisible(), 'every panel one tap away');
  assert.equal(await text(page, '#layoutBtn'), 'Simple view ▴');
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#overview').hidden);
  assert.ok(await page.locator('#walletPanel').isVisible(), 'the choice is remembered');
  await page.click('#layoutBtn');
  assert.ok(await page.locator('#walletPanel').isHidden());
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('GitHub Pages: reads the state at the branch head commit (no stale CDN copy), falls back to the branch URL', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const path = require('node:path');
  const make = minutesAgo => {
    const state = freshState();
    state.createdAt = new Date(Date.now() - X.DAY / 2).toISOString();
    state.lastTick = new Date(Date.now() - minutesAgo * 60000).toISOString();
    return statusOf(state);
  };
  const sha = 'c'.repeat(40);
  const run = async apiWorks => {
    const page = await env.page({ width: 390, height: 844 });
    const seen = [];
    page.on('request', request => seen.push(request.url()));
    // Serve this checkout as if it were https://someone.github.io/metyu/ (no service worker in this test:
    // its script fetch is not reliably routed, and the pwa tests cover it).
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => ({ register: () => Promise.resolve() }), configurable: true }));
    await page.route('https://someone.github.io/metyu/**', route => {
      const file = new URL(route.request().url()).pathname.replace(/^\/metyu\//, '') || 'board.html';
            return route.fulfill({ path: path.join(__dirname, '..', '..', file) });
    });
    await page.route('https://api.exchange.coinbase.com/**', route => route.abort());
    await page.route('https://api.github.com/repos/someone/metyu/commits/autopilot-data', route => (apiWorks ? route.fulfill({ status: 200, body: sha, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 403, body: '{}', headers: { 'access-control-allow-origin': '*' } })));
    await page.route(`https://raw.githubusercontent.com/someone/metyu/${sha}/exchange-status.json`, route => route.fulfill({ json: make(2), headers: { 'access-control-allow-origin': '*' } }));
    // The branch URL is the CDN's copy, 12 minutes behind.
    await page.route('https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json', route => route.fulfill({ json: make(12), headers: { 'access-control-allow-origin': '*' } }));
    await page.route(/^https:\/\/raw\.githubusercontent\.com\/someone\/metyu\/[^/]+\/status\.json$/, route => route.fulfill({ status: 404, body: '' }));
    await page.goto('https://someone.github.io/metyu/board.html');
    await page.waitForFunction(() => !document.querySelector('#exchangePanel').hidden);
    return { page, seen };
  };

  const fresh = await run(true);
  assert.match(await text(fresh.page, '#exStatus'), /Live · real time/, 'the fresh commit copy, not the CDN one');
  assert.ok(fresh.seen.includes(`https://raw.githubusercontent.com/someone/metyu/${sha}/exchange-status.json`));
  assert.ok(!fresh.seen.includes('https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json'), 'the stale branch copy is not needed');
  assert.equal(fresh.seen.filter(url => url.startsWith('https://api.github.com/')).length, 1, 'one tiny API check serves all the files');
  assert.deepEqual(fresh.page.errors, []);

  const limited = await run(false);   // rate-limited or offline API: the branch URL, as before
  assert.match(await text(limited.page, '#exStatus'), /Running 24\/7 · scheduled/);
  assert.ok(limited.seen.includes('https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json'));
  assert.deepEqual(limited.page.errors, []);
});

test('history test: how today\'s strategies did in the big past episodes, information only', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const r = (trades, meanR) => ({ trades, wins: Math.round(trades / 2), meanR, sumR: trades * meanR, shorts: 1 });
  state.stress = {
    at: new Date(Date.now() - 3 * X.DAY).toISOString(), coins: ['BTC-USD', 'ETH-USD'],
    episodes: [{ id: '2022-ftx', name: 'FTX collapse', kind: 'crash' }, { id: '2023-range', name: '2023 summer range', kind: 'range' }],
    kinds: { crash: { trend: r(128, .24), breakout: r(185, .41) }, range: { trend: r(130, -.2), breakout: r(182, -.23) } },
    verdicts: { trend: { earnsIn: ['crash'], losesIn: ['range'] } }, paramsKey: 'x'
  };
  const status = statusOf(state);
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exStress').hidden);
  assert.equal(await text(page, '#exStressHead'), 'History test · 2 past episodes (2018–2024)');
  assert.match(await text(page, '#exStress'), /Crashes: trend \+0\.24R \(128\) · breakout \+0\.41R \(185\) — FTX collapse/);
  assert.match(await text(page, '#exStress'), /Flat ranges: trend -0\.20R \(130\) · breakout -0\.23R \(182\) — 2023 summer range/);
  assert.equal(await page.locator('#exStress li.ok').count(), 1, 'the episodes where the strategies earned are marked');
  assert.match(await text(page, '#exStressNote'), /Information only: it opens no gate and sizes no trade\. Tested 3 days ago; repeated weekly\./);
  assert.ok(await page.locator('#exLab').isHidden(), 'no lab yet: nothing shown');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('overview shows the market at a glance: BTC 4h direction, how long, and breadth', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const status = { ...statusOf(state), market: { btc4h: 'down', since: new Date(Date.now() - 3 * X.DAY).toISOString(), breadth: { up: 0, down: 29, range: 2 }, coins: 31 } };
  const page = await env.page({ width: 390, height: 844 }, { view: 'terminal', layout: 'compact' });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#ovMarket').hidden);
  assert.equal(await text(page, '#ovMarket'), 'Market: BTC 4h downtrend for 3 days · coins 29 down · 2 range · 0 up');
  assert.ok(await page.locator('#ovMarket').isVisible(), 'on the simple board too');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('execution check: real order-book costs per coin, never below the floor', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const samples = (slippage, live) => ({ samples: Array.from({ length: 8 }, () => ({ at: state.lastTick, halfSpread: live, slippage, live })) });
  state.execution = { 'PEPE-USD': samples(.0022, .0014), 'ZRO-USD': samples(.0019, .0007), 'BTC-USD': samples(.00001, .00001) };
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: statusOf(state) }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exExec').hidden);
  assert.equal(await text(page, '#exExec'), 'Execution check (real Coinbase spot order books, $5,000 paper size, 3 coins measured): 2 cost more than the 0.05% floor and are charged their measured cost (worst PEPE-USD 0.22%, ZRO-USD 0.19%). A $100 order would pay a median 0.07%.');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('execution check on the perps venue: its books, funding above the floor, unlisted coins', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  state.executionVenue = 'hyperliquid';
  const samples = (slippage, live, rate) => ({ samples: Array.from({ length: 8 }, () => ({ at: state.lastTick, halfSpread: live, slippage, live })), funding: Array.from({ length: 8 }, () => rate) });
  state.execution = { 'RENDER-USD': samples(.00106, .0003, .0000125), 'ZRO-USD': samples(.0007, .0002, .0000267), 'BTC-USD': samples(.00001, .00001, .0000125) };
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: statusOf(state) }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exExec').hidden);
  assert.equal(await text(page, '#exExec'), 'Execution check (real Hyperliquid perps order books, $5,000 paper size, 3 coins measured): 2 cost more than the 0.05% floor and are charged their measured cost (worst RENDER-USD 0.11%, ZRO-USD 0.07%). A $100 order would pay a median 0.02%. Funding: 1 coin charged above the 0.01% per 8 h floor. Not listed there: QNT-USD.');
  assert.deepEqual(page.errors, []);
});

test('account panel: the Fomo perps account (Hyperliquid) shows margin, positions and approved API agents', async () => {
  const Vault = require('../../metyu-vault.js');
  const pass = 'my long board passphrase';
  const perps = {
    accountValue: 512.5, withdrawable: 400, marginUsed: 112.5, spotUsdc: 20,
    positions: [{ coin: 'ETH', side: 'SHORT', size: .05, entry: 1700, value: 84.3, pnl: 1.2, leverage: 1, liquidation: 9000 }],
    agents: [{ name: 'fomo', address: '0x1111111111111111111111111111111111111111', validUntil: null }]
  };
  const box = await Vault.seal({ kind: 'account', provider: 'solana', verifiedAt: new Date(Date.now() - 60000).toISOString(), viewOnly: true, permissions: { type: 'public address', network: 'solana', canSign: false },
    balances: [{ asset: 'SOL', free: 1, locked: 0, total: 1, usd: 150 }], totalUsd: 682.5, unpriced: [], perps }, pass, { iterations: 100000, label: 'metyu-account' });
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/account.enc.json';
  await page.route(published, route => route.fulfill({ json: box }));
  await page.goto(`${env.base}/board.html?account=${encodeURIComponent(published)}`);
  await page.waitForSelector('#accountPanel:not([hidden])');
  await page.fill('#acPass', pass);
  await page.click('#acOpen');
  await page.waitForSelector('#acBody:not([hidden])');
  assert.equal(await text(page, '#acProvider'), 'Solana wallet + Fomo perps');
  assert.match(await text(page, '#acPerpsSummary'), /^Account value \$513 · withdrawable \$400 · spot USDC \$20 · 1 open position · ⚠ 1 API agent may trade for this account: fomo \(0x11…1111\)/);
  assert.match(await text(page, '#acPerps'), /ETH SHORT 1x\+\$1\.2 ?0\.05 @ 1,700 · value \$84\.3 · liq\. 9,000/);
  await page.click('#acLock');
  assert.equal(await page.locator('#acPerps li').count(), 0, 'positions are removed from the page');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('Fomo perps account: linked on the board by its public 0x address, read from Hyperliquid only, never uploaded', async () => {
  const address = '0x' + 'ab'.repeat(20);
  const page = await env.page({ width: 390, height: 844 });
  const seen = [];
  page.on('request', request => seen.push({ url: request.url(), body: request.postData() || '' }));
  const answers = {
    clearinghouseState: { marginSummary: { accountValue: '512.5', totalMarginUsed: '84' }, withdrawable: '400', assetPositions: [{ position: { coin: 'ETH', szi: '-0.05', entryPx: '1700', positionValue: '84.3', unrealizedPnl: '1.2', leverage: { type: 'isolated', value: 1 }, liquidationPx: '9000' } }] },
    spotClearinghouseState: { balances: [{ coin: 'USDC', total: '20' }] },
    extraAgents: []
  };
  await page.route('https://api.hyperliquid.xyz/info', route => {
    const body = JSON.parse(route.request().postData());
    return route.fulfill({ json: answers[body.type], headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto(`${env.base}/board.html`);
  // A Solana address is refused with a clear reason, and a private key is wiped at once.
  await page.fill('#pAddress', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  await page.click('#pLink');
  assert.match(await text(page, '#pStatus'), /Not linked: it is a Solana address; the perps account needs the 0x \(EVM\) address/);
  await page.fill('#pAddress', '0x' + 'cd'.repeat(32));
  assert.equal(await page.inputValue('#pAddress'), '', 'an EVM private key is wiped from the field at once');
  assert.match(await text(page, '#secAlert'), /PRIVATE KEY/);
  // The real link: spaces around the address are forgiven.
  await page.fill('#pAddress', `  ${address} `);
  await page.click('#pLink');
  await page.waitForFunction(() => /✓ read at/.test(document.querySelector('#pVerified').textContent));
  assert.equal(await text(page, '#pValue'), '$513');
  assert.equal(await text(page, '#pCount'), '1');
  assert.equal(await text(page, '#pShort'), '0xabab…abab');
  assert.match(await text(page, '#pPositions'), /ETH SHORT 1x\+\$1\.2 ?0\.05 @ 1,700 · value \$84\.3 · liq\. 9,000/);
  assert.match(await text(page, '#pAgents'), /No API agents approved/);
  assert.equal(await page.$eval('#ovPerpsLine', el => el.hidden), false, 'the overview carries the perps line (the overview shows once the agent publishes)');
  assert.equal(await text(page, '#ovPerps'), '$513');
  assert.match(await text(page, '#ovPerpsSub'), /^1 open · \+\$1\.2 · ✓ read \d+ s ago$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('metyuBoard.perpsAddress')), address, 'kept on this device');
  const leaks = seen.filter(r => (r.url.includes(address) || r.body.includes(address)) && new URL(r.url).host !== 'api.hyperliquid.xyz');
  assert.deepEqual(leaks, [], 'the address only ever goes to Hyperliquid');
  assert.ok(!seen.some(r => r.url.includes('hyperliquid.xyz/exchange')), 'the order endpoint is never called');
  // Remembered after a reload; unlink removes it.
  await page.reload();
  await page.waitForFunction(() => /✓ read at/.test(document.querySelector('#pVerified').textContent));
  await page.click('#pUnlink');
  assert.equal(await page.evaluate(() => localStorage.getItem('metyuBoard.perpsAddress')), null);
  assert.equal(await page.$eval('#ovPerpsLine', el => el.hidden), true);
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('overview: the path to real money and the orders that would be sent (never sent)', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  const page = await env.page({ width: 390, height: 844 }, { view: 'terminal', layout: 'compact' });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  let status = statusOf(state);
  await page.route(published, route => route.fulfill({ json: status }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#ovRealMoney').hidden);
  assert.match(await text(page, '#ovTickets'), /None yet: an order ticket appears only when a strategy has passed the evidence gate/);
  assert.match(await text(page, '#ovPathHead'), /^Path to real money · step 6 of 10: A checkable approval record that expires \(owner: set the variable METYU_LIVE_APPROVED\)$/);
  await page.click('#ovPathHead');
  assert.match(await text(page, '#ovSteps'), /1\. Design.*2\. Legality of perps where you live: skipped by the owner \(the owner's responsibility\).*7\. A strategy passes the evidence gate, and 6\/6 conditions \(now \d\/6\).*10\. Deploy on the host; the first real order at \$25 \(later\)/);
  assert.equal(await page.locator('#ovSteps li.done').count(), 4);
  assert.match(await text(page, '#ovSteps'), /3\. Host: a small cloud VPS/);
  // A shadow order (a gated signal) becomes a ticket that is shown as NOT SENT, with the reasons.
  state.shadow.open.x1 = { id: 'x1', symbol: 'ETH-USD', side: 'SHORT', usd: 25, entry: 2000, stop: 2100, target: 1800, openedAt: new Date().toISOString() };
  status = statusOf(state);
  await page.reload();
  await page.waitForFunction(() => /NOT SENT/.test(document.querySelector('#ovTickets').textContent));
  assert.match(await text(page, '#ovTickets'), /ETH SHORT \$25 · limit 1994\.00 · stop 2100\.00 · target 1800\.00\s*NOT SENT\s*blocked: real-money lock \d\/6 · no order adapter \(step 9\)/);
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('strategy lab line: weekly families, what was promoted, and that only the gate adds a strategy', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const state = freshState();
  state.createdAt = new Date(Date.now() - X.DAY).toISOString();
  state.lastTick = new Date().toISOString();
  state.lab = { at: new Date().toISOString(), rule: { minTrades: 30, minMeanR: .05, minKindsPositive: 3 }, families: 5, variants: new Array(20).fill({}),
    promoted: [{ family: 'EMA cross', timeframe: 4, params: {}, status: 'in the engine (emaCross4h)' }, { family: 'channel breakout', timeframe: 4, params: {}, status: 'rejected on the training window (26 Nov 2026)' }] };
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: statusOf(state) }));
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => !document.querySelector('#exLab').hidden);
  assert.equal(await text(page, '#exLab'), 'Strategy lab (weekly): 20 variants of 5 families on the past episodes · 2 promoted · no new candidate (EMA cross 4h: in the engine; channel breakout 4h: rejected on the training window). A family joins only after the evidence gate on the last 2 years.');
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});

test('on the Hyperliquid venue the board prices positions at Hyperliquid (one read), Coinbase only for unlisted coins', async () => {
  const X = require('../../metyu-exchange.js');
  const { freshState, statusOf } = require('../../exchange-autopilot.js');
  const H = X.HOUR;
  const now = Date.now();
  const state = freshState();
  state.createdAt = new Date(now - 2 * X.DAY).toISOString();
  state.lastTick = new Date(now - 5 * 60000).toISOString();
  state.executionVenue = 'hyperliquid';
  state.execution = { 'BTC-USD': { samples: [], basis: Array.from({ length: 8 }, () => .0005) }, 'ETH-USD': { samples: [], basis: Array.from({ length: 8 }, () => -.0011) } };
  state.marks = { 'BTC-USD': { price: 60000, at: state.lastTick, source: 'hyperliquid' }, 'QNT-USD': { price: 70, at: state.lastTick, source: 'coinbase' } };
  const pos = (id, symbol, entry) => ({ id, symbol, strategy: 'trend', book: 'learning', side: 'LONG', entry, qty: .05, notional: entry * .05, margin: entry * .05, leverage: 1, stop: entry * .97, initialStop: entry * .97, target: entry * 1.05, liquidation: entry * .5, entryFee: 1, risk: 25, atr: entry * .01, openedAt: now - 3 * H, reason: 'test' });
  state.positions = { x1: pos('x1', 'BTC-USD', 59800), x2: pos('x2', 'QNT-USD', 69) };
  const status = statusOf(state, { now });
  const page = await env.page({ width: 390, height: 844 });
  const published = 'https://raw.githubusercontent.com/someone/metyu/autopilot-data/exchange-status.json';
  await page.route(published, route => route.fulfill({ json: status }));
  const venue = [];
  await page.route('https://api.hyperliquid.xyz/info', route => { venue.push(JSON.parse(route.request().postData())); return route.fulfill({ json: { BTC: '61000', ETH: '1700' }, headers: { 'access-control-allow-origin': '*' } }); });
  const tickers = [];
  await page.route('https://api.exchange.coinbase.com/products/*/ticker', route => { tickers.push(new URL(route.request().url()).pathname); return route.fulfill({ json: { price: '71' } }); });
  await page.goto(`${env.base}/board.html?exchange=${encodeURIComponent(published)}`);
  await page.waitForFunction(() => /prices \d+ s ago/.test(document.querySelector('#ovFresh').textContent));
  assert.deepEqual(venue.map(b => b.type), ['allMids'], 'one read for every coin');
  assert.deepEqual(tickers, ['/products/QNT-USD/ticker'], 'Coinbase only for the coin Hyperliquid does not list');
  assert.equal(await text(page, '#ovPosHead'), 'Open positions · live Hyperliquid + Coinbase prices');
  assert.match(await text(page, '#exStatus'), /2 coins, live Hyperliquid prices/);
  // BTC at 61,000 live vs the agent's mark of 60,000: +0.05 x 1,000 = +$50 on top of the published P&L.
  const btc = status.positions.find(p => p.symbol === 'BTC-USD');
  const shown = await text(page, '#ovPositions');
  assert.ok(Math.abs(btc.pnl + 50 - 54.5) < .01, 'the published P&L plus the live move');
  assert.match(shown, /BTC-USD LONG 1\.0x · learning · trend\+\$54\.5/, shown);
  assert.ok(await noHorizontalScroll(page));
  assert.deepEqual(page.errors, []);
});
