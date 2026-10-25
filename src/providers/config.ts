/**
 * Where API calls go.
 *
 * - With a BAGZ proxy (the Cloudflare Worker in /worker) every provider is reached at `${proxy}/p/<provider>/…`.
 *   The proxy holds the API keys, adds CORS headers, caches at the edge and rate limits. No secret ever reaches the browser.
 * - Without one the browser calls each provider directly. That works for DexScreener, GeckoTerminal (slowly), Jupiter
 *   (keyless) and RugCheck, but pump.fun and most RPCs refuse browser requests.
 *
 * Set the proxy at build time (BAGZ_PROXY_URL=https://… node build.mjs). For local development and tests a runtime
 * override `?proxy=…` is accepted (remembered in localStorage; `?proxy=off` clears it), but ONLY when it points at this
 * computer (localhost / 127.0.0.1) or the page itself is opened from this computer.
 *
 * Security: on the real site a shared link like bagz.pages.dev/?proxy=https://someone-else would otherwise send every
 * request — passwords at sign-in, session tokens, swap transactions to sign — to that server and remember it. So any
 * other override is ignored, and a stored one is deleted.
 */
declare const __BAGZ_PROXY__: string | undefined;

const KEY = 'bagz.proxy';

function clean(u: string | null | undefined): string | null {
  if (!u) return null;
  const t = u.trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(t) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/.test(t) ? t : null;
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
/** a runtime override is only honoured for this computer, or when the page itself is opened from this computer */
function overrideAllowed(u: string): boolean {
  if (LOCAL.test(u)) return true;
  try { return typeof location !== 'undefined' && (location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)); } catch { return false; }
}

let override: string | null | undefined;

export function proxyBase(): string | null {
  if (override !== undefined) return override;
  let v: string | null = null;
  try {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search).get('proxy');
      const cq = clean(q);
      if (q === 'off') localStorage.removeItem(KEY);
      else if (cq && overrideAllowed(cq)) localStorage.setItem(KEY, cq);
    }
    v = clean(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null);
    // a remembered override that isn't allowed (e.g. saved by an older version from a shared link) is dropped
    if (v && !overrideAllowed(v)) { v = null; try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  } catch { /* storage blocked: ignore */ }
  if (!v) v = clean(typeof __BAGZ_PROXY__ !== 'undefined' ? __BAGZ_PROXY__ : null);
  override = v;
  return v;
}

/** Test hook. */
export function __setProxy(u: string | null) { override = u; }
