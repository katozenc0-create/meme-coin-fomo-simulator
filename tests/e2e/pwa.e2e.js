// The installable web app (iOS / Android "Add to Home Screen"): manifest, service worker, offline.
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
  await page.waitForFunction(async () => (await caches.keys()).includes('metyu-shell-v1'));
  const cached = await page.evaluate(async () => (await (await caches.open('metyu-shell-v1')).keys()).map(request => new URL(request.url).pathname));
  for (const file of ['/board.html', '/metyu-agent.js', '/manifest.webmanifest', '/icons/icon-180.png']) assert.ok(cached.includes(file), `${file} cached`);
  assert.ok(!cached.some(path => path.includes('/api/')), 'no live data in the cache');

  await page.context().setOffline(true);
  await page.reload();
  assert.equal(await page.title(), 'Metyu Live Board', 'the board opens without a network');
  assert.match(await text(page, '#startBtn'), /Start/);
  await page.context().setOffline(false);
});
