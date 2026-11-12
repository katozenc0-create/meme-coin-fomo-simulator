/*
 * Metyu vault: end-to-end encryption for private data that has to travel through public places
 * (the public autopilot-data branch, GitHub Pages). The account snapshot (real balances) is sealed
 * on the GitHub runner with the owner's passphrase and opened only in the owner's browser; the
 * passphrase never leaves those two places.
 *
 *   PBKDF2-SHA256 (600,000 iterations, 16-byte random salt) -> AES-256-GCM (12-byte random IV)
 *
 * GCM authenticates the data: a wrong passphrase or any tampering makes open() fail; it never
 * returns garbage. The same code runs in Node (>= 20, WebCrypto) and in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetyuVault = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_PASSPHRASE = 12;
  const DEFAULT_ITERATIONS = 600000;                     // OWASP 2023 recommendation for PBKDF2-SHA256
  const subtle = () => {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || !c.subtle) throw new Error('WebCrypto is not available (needs HTTPS or localhost)');
    return c;
  };
  const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

  async function deriveKey(passphrase, salt, iterations) {
    const c = subtle();
    const material = await c.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Encrypts any JSON value. Returns a JSON-safe box; `label` is public and authenticated. */
  async function seal(value, passphrase, { iterations = DEFAULT_ITERATIONS, label = 'metyu' } = {}) {
    if (typeof passphrase !== 'string' || passphrase.normalize('NFKC').length < MIN_PASSPHRASE) throw new Error(`the passphrase must have at least ${MIN_PASSPHRASE} characters`);
    const c = subtle();
    const salt = c.getRandomValues(new Uint8Array(16));
    const iv = c.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, iterations);
    const data = new TextEncoder().encode(JSON.stringify(value));
    const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) }, key, data));
    return { v: 1, alg: 'PBKDF2-SHA256/AES-256-GCM', label, iterations, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), sealedAt: new Date().toISOString() };
  }

  /** Decrypts a box from seal(); throws 'wrong passphrase or damaged data' on any failure. */
  async function open(box, passphrase) {
    if (!box || box.v !== 1 || typeof box.ct !== 'string') throw new Error('not a Metyu vault box');
    if (!(box.iterations >= 100000 && box.iterations <= 10000000)) throw new Error('unexpected key-derivation cost');
    const key = await deriveKey(String(passphrase || ''), fromB64(box.salt), box.iterations);
    let plain;
    try {
      plain = await subtle().subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: new TextEncoder().encode(box.label || 'metyu') }, key, fromB64(box.ct));
    } catch (error) {
      throw new Error('wrong passphrase or damaged data');
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  return { seal, open, MIN_PASSPHRASE, DEFAULT_ITERATIONS };
}));
