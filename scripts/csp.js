#!/usr/bin/env node
'use strict';
// Content-Security-Policy without 'unsafe-inline' for scripts: only the inline scripts that are in
// this repository may run, each allowed by its SHA-256 hash. An injected script (XSS) has another
// hash, so the browser refuses it: it could not, for example, draw a fake "connect your wallet"
// prompt on the Live Board. GitHub Pages cannot send headers, so every page carries the policy as a
// <meta> tag, and server.py sends the same policy as a header (one policy, the union of all hashes).
//
//   node scripts/csp.js --check    exit 1 if a page or server.py is out of date (CI runs this via the tests)
//   node scripts/csp.js --write    recompute the hashes and update the pages and server.py
//
// Run --write after editing any inline <script> in a page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'polymarket.html', 'board.html'];
const CONNECT = "'self' https://gamma-api.polymarket.com https://clob.polymarket.com https://raw.githubusercontent.com https://api.exchange.coinbase.com https://api.mainnet-beta.solana.com https://lite-api.jup.ag https://api.jup.ag https://data-api.polymarket.com https://api.github.com";

/** The text of every inline <script> (no src) in a page, exactly as the browser hashes it. */
function inlineScripts(html) {
  // Case-insensitive, and tolerant of "</script >": every script element must be seen, or an
  // unhashed one would slip past the policy check. A <script> we cannot pair is an error.
  const matches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];   // browsers end a script at any </script...>
  const opened = (html.match(/<script\b/gi) || []).length;
  if (opened !== matches.length) throw new Error(`found ${opened} <script> tags but could pair only ${matches.length}`);
  return matches.filter(match => !/\ssrc\s*=/i.test(match[1] || '')).map(match => match[2]);
}
const hashOf = text => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function policyFor(hashes) {
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    `connect-src ${CONNECT}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

function currentPolicy(root = ROOT) {
  const hashes = [...new Set(PAGES.flatMap(page => inlineScripts(fs.readFileSync(path.join(root, page), 'utf8')).map(hashOf)))].sort();
  return policyFor(hashes);
}

const META = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;
const SERVER = /^CONTENT_SECURITY_POLICY = ".*"$/m;

/** Files whose policy differs from the computed one. With write, they are updated. */
function sync({ root = ROOT, write = false } = {}) {
  const policy = currentPolicy(root);
  const stale = [];
  for (const page of PAGES) {
    const file = path.join(root, page);
    const html = fs.readFileSync(file, 'utf8');
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    if (!META.test(html)) throw new Error(`${page} has no Content-Security-Policy meta tag`);
    if (html.match(META)[0] !== meta) { stale.push(page); if (write) fs.writeFileSync(file, html.replace(META, meta)); }
  }
  const serverFile = path.join(root, 'server.py');
  const server = fs.readFileSync(serverFile, 'utf8');
  const line = `CONTENT_SECURITY_POLICY = "${policy}"`;
  if (!SERVER.test(server)) throw new Error('server.py has no CONTENT_SECURITY_POLICY line');
  if (server.match(SERVER)[0] !== line) { stale.push('server.py'); if (write) fs.writeFileSync(serverFile, server.replace(SERVER, line)); }
  return { policy, stale };
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const { stale } = sync({ write });
  if (!stale.length) console.log('csp: up to date');
  else if (write) console.log(`csp: updated ${stale.join(', ')}`);
  else { console.error(`csp: out of date: ${stale.join(', ')} (run: node scripts/csp.js --write)`); process.exitCode = 1; }
}
module.exports = { inlineScripts, hashOf, policyFor, currentPolicy, sync, PAGES };
