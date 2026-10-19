// Shared test fixtures: provider responses in the shapes recorded in src/snapshot.ts. Used by tests/browser.mjs and tests/proxy-e2e.mjs.
// Test code only; nothing here ships in the app.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures
const src = readFileSync(resolve(root, 'src/snapshot.ts'), 'utf8');
const grab = (name) => { const m = src.match(new RegExp(`export const ${name}[^=]*= (\\[[\\s\\S]*?\\n\\]);`)); return eval(m[1].replace(/^\s*\/\/.*$/gm, '')); };
const JUP = grab('JUPITER'), PUMP = grab('PUMP_LIVE'), DS = grab('DEXSCREENER');
const jup = (r) => ({ id: r[0], name: r[1], symbol: r[2], icon: r[3], decimals: 6, usdPrice: r[4], mcap: r[5], liquidity: r[6], holderCount: r[7], organicScore: r[8], organicScoreLabel: r[8] >= 70 ? 'high' : 'medium', stats1h: { priceChange: r[9] }, stats24h: { priceChange: r[10], buyVolume: r[11], sellVolume: 0, numBuys: r[12], numSells: r[13] }, audit: { mintAuthorityDisabled: r[14], freezeAuthorityDisabled: r[15], topHoldersPercentage: r[16], devBalancePercentage: r[17] }, launchpad: r[18], createdAt: r[19], tags: r[20] ? r[20].split(';') : [], firstPool: { createdAt: r[19] } });
const STABLE = { id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin', symbol: 'USDC', usdPrice: 0.9998, mcap: 7.8e9, liquidity: 4e8, holderCount: 5e6, organicScore: 100, organicScoreLabel: 'high', tags: ['verified', 'stable'], stats24h: {}, audit: {} };
const priceOf = {};
for (const r of JUP) priceOf[r[0]] = { p: r[4], liq: r[6] || 5000, mcap: r[5], name: r[1], sym: r[2] };
for (const r of PUMP) priceOf[r[0]] = { p: r[4] / 1e9, liq: r[7], mcap: r[4], name: r[1], sym: r[2] };
for (const r of DS) priceOf[r[1].toLowerCase()] = { p: r[6], liq: r[12], mcap: r[13], name: r[2], sym: r[3], pair: r[4] };
const poolFor = (addr) => priceOf[addr]?.pair || 'POOL' + addr.slice(0, 20);
const coinForPool = (pool) => Object.entries(priceOf).find(([k, x]) => (x.pair || 'POOL' + k.slice(0, 20)) === pool)?.[1];
const wallets = ['7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz'];

export const makeMock = (opts = {}) => {
  const m = { requests: [], boost: 1, fail: { ...(opts.fail || {}) } };
  m.route = async (r) => {
    const u = new URL(r.request().url());
    const log = u.hostname + u.pathname + u.search;
    if (!/fonts\./.test(u.hostname)) m.requests.push(log);
    const json = (b, status = 200, h = {}) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...h }, body: JSON.stringify(b) });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (/fonts\./.test(u.hostname)) return r.fulfill({ status: 200, body: '' });
    if (u.hostname === 'cdn.jsdelivr.net') return r.abort();
    if (u.hostname === 'api.jup.ag') {
      if (u.pathname.startsWith('/swap/v2/order')) {
        const out = String(Math.round(Number(u.searchParams.get('amount')) * 8000));
        return json({ requestId: 'req-test', transaction: u.searchParams.get('taker') ? 'AQID' : null, inAmount: u.searchParams.get('amount'), outAmount: out, router: 'metis', feeBps: 10, feeMint: 'So11111111111111111111111111111111111111112', mode: 'manual' });
      }
      if (m.fail.jup) return json({ error: 'no key' }, 401);
      if (u.pathname.includes('/price/')) return json({ So11111111111111111111111111111111111111112: { usdPrice: 151.25 } });
      if (u.pathname.includes('/search')) { const q = u.searchParams.get('query'); const row = JUP.find((x) => x[0] === q); return json(row ? [jup(row)] : []); }
      if (u.pathname.includes('recent')) return json(JUP.filter((x) => x[21] === 'recent').map(jup));
      if (u.pathname.includes('toptrending')) return json(JUP.filter((x) => x[21] === 'trending').map(jup));
      if (u.pathname.includes('toporganicscore')) return json([STABLE, ...JUP.filter((x) => x[21] === 'organic' || x[21] === 'major').map(jup)]);
      if (u.pathname.includes('toptraded')) return json([STABLE, ...JUP.filter((x) => x[21] === 'organic').slice(0, 4).map(jup)]);
    }
    if (u.hostname === 'api.dexscreener.com') {
      if (u.pathname.includes('token-profiles')) return json(JUP.filter((x) => x[21] === 'trending').slice(0, 5).map((x) => ({ chainId: 'solana', tokenAddress: x[0], description: 'Profile text from DexScreener' })));
      if (u.pathname.includes('token-boosts')) return json([]);
      const mm = u.pathname.match(/tokens\/v1\/([a-z]+)\/(.+)$/);
      if (mm) {
        const rows = mm[2].split(',').map((a) => { const k = mm[1] === 'solana' ? a : a.toLowerCase(); const x = priceOf[k]; if (!x) return null; const p = x.p * m.boost;
          return { chainId: mm[1], dexId: a.endsWith('pump') ? 'pumpswap' : 'raydium', pairAddress: poolFor(k), baseToken: { address: a, name: x.name, symbol: x.sym }, priceUsd: String(p), priceChange: { m5: 0.4, h1: 2.1, h6: -3, h24: 5.5 }, txns: { h24: { buys: 1200, sells: 900 } }, volume: { h24: 250000, h1: 12000 }, liquidity: { usd: x.liq }, marketCap: x.mcap * (p / x.p), pairCreatedAt: Date.now() - 3 * 864e5, info: { websites: [{ url: 'https://example.org' }] } }; }).filter(Boolean);
        return json(rows);
      }
    }
    if (u.hostname === 'frontend-api-v3.pump.fun') {
      if (m.fail.pump) return json({ message: 'Forbidden' }, m.fail.pump);
      const live = u.pathname.includes('currently-live');
      const rows = live ? PUMP : PUMP.slice(2, 8);
      return json(rows.map((x) => ({ mint: x[0], name: x[1], symbol: x[2], image_uri: x[3], usd_market_cap: x[4], created_timestamp: x[5], complete: x[6], canonical_pool_liquidity_usd: x[7], is_currently_live: live })));
    }
    if (u.hostname === 'api.geckoterminal.com') {
      if (u.pathname.includes('/ohlcv/')) {
        const lim = Number(u.searchParams.get('limit') || 100), agg = Number(u.searchParams.get('aggregate') || 1);
        const unit = u.pathname.endsWith('minute') ? 60 : u.pathname.endsWith('hour') ? 3600 : 86400;
        const step = unit * agg;
        const now = Math.floor(Date.now() / 1000 / step) * step;
        const pool = u.pathname.split('/pools/')[1].split('/')[0];
        const s = (coinForPool(pool)?.p || 1) * m.boost;
        let p = 1;
        const raw = Array.from({ length: lim }, (_, i) => { const o = p; p = p * (1 + Math.sin((lim - i) / 7) * 0.01); return [now - i * step, o, Math.max(o, p) * 1.004, Math.min(o, p) * 0.996, p, 1000 + i * 10]; });
        const k = s / raw[0][4]; // newest close == the pool's current price
        const list = raw.map(([t, o, h, l, c, v]) => [t, o * k, h * k, l * k, c * k, v]);
        const base = Object.keys(priceOf).find((k) => poolFor(k) === pool);
        return json({ data: { attributes: { ohlcv_list: list } }, meta: base ? { base: { address: base }, quote: { address: 'So11111111111111111111111111111111111111112' } } : {} });
      }
      if (u.pathname.includes('/trades')) {
        if (m.fail.gtTrades) return json({ error: 'rate' }, m.fail.gtTrades, { 'retry-after': '30' });
        const pool = u.pathname.split('/pools/')[1].split('/')[0];
        const p = coinForPool(pool)?.p || 1;
        return json({ data: Array.from({ length: 8 }, (_, i) => ({ id: 'tx' + i + pool, attributes: { tx_hash: 'h' + i + pool.slice(0, 6), kind: i % 3 ? 'buy' : 'sell', volume_in_usd: String(50 + i * 333), tx_from_address: wallets[i % 4], block_timestamp: new Date(Date.now() - i * 40000).toISOString(), price_to_in_usd: String(p), price_from_in_usd: String(p) } })) });
      }
      if (u.pathname.endsWith('/pools') && u.pathname.includes('/tokens/')) { const a = u.pathname.split('/tokens/')[1].split('/')[0]; return json({ data: [{ id: 'solana_' + poolFor(a), attributes: { address: poolFor(a) }, relationships: { base_token: { data: { id: 'solana_' + a } }, dex: { data: { id: 'pump-fun' } } } }] }); }
      if (u.pathname.includes('new_pools') || u.pathname.includes('trending_pools')) return json({ data: [], included: [] });
    }
    if (u.hostname === 'api.rugcheck.xyz') return json({ score_normalised: 12, risks: [{ name: 'Low amount of LP Providers', level: 'warn', description: 'Only a few users provide liquidity' }] });
    if (u.hostname === 'api.mainnet-beta.solana.com') {
      const body = JSON.parse(r.request().postData() || '{}');
      if (body.method === 'getTokenSupply') return json({ result: { value: { uiAmount: 1e9 } } });
      return json({ result: { value: wallets.map((a, i) => ({ address: a, uiAmount: 1e9 * (0.2 - i * 0.04) })) } });
    }
    return r.abort();
  };
  return m;
};

