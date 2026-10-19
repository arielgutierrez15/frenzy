/**
 * Where API calls go.
 *
 * - With a BAGZ proxy (the Cloudflare Worker in /worker) every provider is reached at `${proxy}/p/<provider>/…`.
 *   The proxy holds the API keys, adds CORS headers, caches at the edge and rate limits. No secret ever reaches the browser.
 * - Without one the browser calls each provider directly. That works for DexScreener, GeckoTerminal (slowly), Jupiter
 *   (keyless) and RugCheck, but pump.fun and most RPCs refuse browser requests.
 *
 * Set the proxy at build time (BAGZ_PROXY_URL=https://… node build.mjs), or at runtime with `?proxy=https://…`
 * (remembered in localStorage; `?proxy=off` clears it).
 */
declare const __BAGZ_PROXY__: string | undefined;

const KEY = 'bagz.proxy';

function clean(u: string | null | undefined): string | null {
  if (!u) return null;
  const t = u.trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(t) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/.test(t) ? t : null;
}

let override: string | null | undefined;

export function proxyBase(): string | null {
  if (override !== undefined) return override;
  let v: string | null = null;
  try {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search).get('proxy');
      if (q === 'off') localStorage.removeItem(KEY);
      else if (clean(q)) localStorage.setItem(KEY, clean(q)!);
    }
    v = clean(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null);
  } catch { /* storage blocked: ignore */ }
  if (!v) v = clean(typeof __BAGZ_PROXY__ !== 'undefined' ? __BAGZ_PROXY__ : null);
  override = v;
  return v;
}

/** Test hook. */
export function __setProxy(u: string | null) { override = u; }
