// Downloads the pinned TradingView Lightweight Charts build into docs/vendor/ so the site doesn't depend on a CDN.
// Usage: node scripts/vendor-lwc.mjs      (needs internet; prints the SHA-384 to pin)
import { mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
const V = '4.2.0';
const url = `https://cdn.jsdelivr.net/npm/lightweight-charts@${V}/dist/lightweight-charts.standalone.production.js`;
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
mkdirSync('docs/vendor', { recursive: true });
writeFileSync('docs/vendor/lightweight-charts.standalone.production.js', buf);
console.log(`saved ${(buf.length / 1024).toFixed(0)} KB  sha384-${createHash('sha384').update(buf).digest('base64')}`);
