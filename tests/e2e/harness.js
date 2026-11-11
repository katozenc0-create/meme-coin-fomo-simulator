// Shared fixture for the browser end-to-end tests: starts server.py on a free port,
// launches Chromium, and offers helpers to mock Polymarket responses (CI has no network).
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch (error) { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server.py did not start');
}

async function start() {
  const port = await freePort();
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const server = spawn(python, ['server.py', '--port', String(port)], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  const browser = await chromium.launch();
  return {
    base,
    browser,
    async page(viewport = { width: 1366, height: 900 }) {
      const context = await browser.newContext({ viewport, acceptDownloads: true });
      const page = await context.newPage();
      page.errors = [];
      page.on('pageerror', error => page.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) page.errors.push(message.text()); });
      // Never reach the real Polymarket from tests: anything not mocked fails fast.
      await page.route(/https:\/\/(gamma-api|clob)\.polymarket\.com\//, route => route.abort());
      return page;
    },
    async stop() {
      await browser.close();
      server.kill();
    }
  };
}

/** Sets range/number/select values and fires the events the pages listen to. */
async function setValues(page, values) {
  await page.evaluate(entries => {
    for (const [selector, value] of entries) {
      const element = document.querySelector(selector);
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, Object.entries(values));
}

const text = async (page, selector) => (await page.textContent(selector)).replace(/\s+/g, ' ').trim();
const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

module.exports = { start, setValues, text, noHorizontalScroll };
