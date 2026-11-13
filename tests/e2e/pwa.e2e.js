// The installable iPhone / iPad web app ("Add to Home Screen"): manifest, service worker, offline,
// and the pages as an iPhone shows them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, text } = require('./harness');

let env;
test.before(async () => { env = await start(); });
test.after(async () => { await env.stop(); });

test('every page is installable (manifest, iOS tags, icons) and has unique ids', async () => {
  const page = await env.page();
  for (const name of ['board.html', 'polymarket.html', 'index.html']) {
    await page.goto(`${env.base}/${name}`);
    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
      touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
      title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content
    }));
    assert.deepEqual(head, { manifest: 'manifest.webmanifest', touchIcon: 'icons/icon-180.png', capable: 'yes', title: 'Metyu' }, name);
    const duplicates = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicates, [], `${name}: every id is unique`);
  }
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, 'board.html');
  for (const icon of manifest.icons) {
    const status = await page.evaluate(async src => (await fetch(src)).status, icon.src);
    assert.equal(status, 200, icon.src);
  }
  assert.deepEqual(page.errors, []);
});

test('the service worker caches the app shell, so the board opens offline; live data is never cached', async () => {
  const page = await env.page();
  await page.goto(`${env.base}/board.html`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).includes('metyu-shell-v4'));
  const cached = await page.evaluate(async () => (await (await caches.open('metyu-shell-v4')).keys()).map(request => new URL(request.url).pathname));
  for (const file of ['/board.html', '/metyu-agent.js', '/manifest.webmanifest', '/icons/icon-180.png']) assert.ok(cached.includes(file), `${file} cached`);
  assert.ok(!cached.some(path => path.includes('/api/')), 'no live data in the cache');

  await page.context().setOffline(true);
  await page.reload();
  assert.equal(await page.title(), 'Metyu Live Board', 'the board opens without a network');
  assert.match(await text(page, '#startBtn'), /Start/);
  await page.context().setOffline(false);
});

test('as an iPhone shows them: every page fits, fields never trigger zoom, safe areas kept, no APK', async () => {
  const { devices } = require('playwright');
  const context = await env.browser.newContext({ ...devices['iPhone 13'] });
  for (const name of ['board.html', 'polymarket.html', 'index.html']) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/autopilot/status', route => route.abort());
    await page.goto(`${env.base}/${name}`);
    const report = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input:not([type=range]):not([type=checkbox]):not([type=file]), select, textarea')];
      const css = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText); } catch (error) { return []; } }).join(' ');
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        small: fields.filter(field => parseFloat(getComputedStyle(field).fontSize) < 16).map(field => field.id || field.name || field.tagName),
        safeArea: /safe-area-inset-top/.test(css),
        apk: [...document.querySelectorAll('a[href]')].filter(link => /\.apk($|\?)/i.test(link.getAttribute('href'))).length
      };
    });
    assert.ok(report.overflow <= 1, `${name}: no sideways scrolling (${report.overflow}px)`);
    assert.deepEqual(report.small, [], `${name}: every field is at least 16px (iOS zooms on smaller ones)`);
    assert.ok(report.safeArea, `${name}: keeps clear of the notch and home indicator`);
    assert.equal(report.apk, 0, `${name}: no Android APK links`);
    assert.deepEqual(errors, [], name);
    await page.close();
  }
  await context.close();
});
