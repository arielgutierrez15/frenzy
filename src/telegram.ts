/**
 * Telegram Mini App support (core.telegram.org/bots/webapps).
 * Telegram's script is loaded only when the page is opened from Telegram (see build.mjs), so normal visitors never load it.
 * Inside Telegram: tell Telegram the app is ready, expand to full height, match the BAGZ colours, use Telegram's back
 * button, open outside links through Telegram, and open a coin from a start parameter (t.me/<bot>?startapp=<mint>).
 * initDataUnsafe is never trusted for anything that matters; BAGZ only reads start_param from it to pick a coin to show.
 */
const BRAND_BG = '#090909';

export interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string };
  version: string;
  platform: string;
  isVersionAtLeast: (v: string) => boolean;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (c: string) => void;
  setBackgroundColor?: (c: string) => void;
  setBottomBarColor?: (c: string) => void;
  disableVerticalSwipes?: () => void;
  openLink: (url: string, o?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  BackButton: { show: () => void; hide: () => void; onClick: (f: () => void) => void; offClick: (f: () => void) => void };
  HapticFeedback?: { selectionChanged: () => void; impactOccurred: (s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void; notificationOccurred: (t: 'error' | 'success' | 'warning') => void };
}

/** the Telegram WebApp object, only when the page really was launched by Telegram (initData is non-empty) */
export function tg(): TgWebApp | null {
  const w = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined;
  return w && typeof w.initData === 'string' && w.initData.length > 0 ? (w as TgWebApp) : null;
}
export const inTelegram = () => !!tg();
const atLeast = (t: TgWebApp, v: string) => { try { return t.isVersionAtLeast(v); } catch { return false; } };

/** The address of this page without Telegram's launch data (which contains the user's signed session; never share it). */
export function cleanPageUrl(href = typeof location !== 'undefined' ? location.href : ''): string {
  try {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('tgWebApp')) u.searchParams.delete(k);
    if (/tgWebApp/.test(u.hash)) u.hash = '';
    return u.toString();
  } catch { return href; }
}

/** opens an outside link: through Telegram inside the Mini App (a plain link would be swallowed by the webview) */
export function openExternal(url: string) {
  const t = tg();
  if (!t) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
  if (/^https:\/\/t\.me\//.test(url)) t.openTelegramLink(url);
  else t.openLink(url);
}

export const haptic = {
  tap: () => { try { tg()?.HapticFeedback?.selectionChanged(); } catch { /* ignore */ } },
  ok: () => { try { tg()?.HapticFeedback?.notificationOccurred('success'); } catch { /* ignore */ } },
  fail: () => { try { tg()?.HapticFeedback?.notificationOccurred('error'); } catch { /* ignore */ } },
};

/** valid Solana mint in a start parameter (Telegram allows A-Z a-z 0-9 _ -, up to 512 characters) */
export function startMint(): string | null {
  const t = tg();
  let p = t?.initDataUnsafe?.start_param;
  if (!p && typeof location !== 'undefined') { try { p = new URLSearchParams(location.search).get('tgWebAppStartParam') || undefined; } catch { /* ignore */ } }
  if (!p) return null;
  const m = p.replace(/^(coin_|c_)/, '');
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m) ? m : null;
}

let started = false;
export function initTelegram() {
  const t = tg();
  if (!t || started) return;
  started = true;
  document.documentElement.classList.add('tg');
  try { t.ready(); } catch { /* ignore */ }
  try { t.expand(); } catch { /* ignore */ }
  if (atLeast(t, '6.1')) {
    // Telegram shows its own back button in the header, so the in-page one is hidden
    document.documentElement.classList.add('tg-back');
    try { t.setHeaderColor?.(BRAND_BG); t.setBackgroundColor?.(BRAND_BG); } catch { /* ignore */ }
  }
  if (atLeast(t, '7.10')) { try { t.setBottomBarColor?.(BRAND_BG); } catch { /* ignore */ } }
  // charts are dragged and lists scrolled; don't let a downward swipe close the app
  if (atLeast(t, '7.7')) { try { t.disableVerticalSwipes?.(); } catch { /* ignore */ } }
  // links that would open a new tab go through Telegram instead
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    if (!/^https?:/.test(href)) return;
    let external = a.target === '_blank';
    try { external ||= new URL(href).origin !== location.origin; } catch { /* ignore */ }
    if (!external) return;
    e.preventDefault();
    openExternal(href);
  }, true);
  const open = window.open.bind(window);
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const u = url ? String(url) : '';
    if (/^https?:/.test(u)) { openExternal(u); return null; }
    return open(url as any, target, features);
  }) as typeof window.open;
}

/** Telegram's own back button mirrors BAGZ's back navigation. Returns a cleanup. */
export function syncBackButton(visible: boolean, onBack: () => void): () => void {
  const t = tg();
  if (!t || !atLeast(t, '6.1')) return () => {};
  if (visible) { t.BackButton.show(); t.BackButton.onClick(onBack); }
  else t.BackButton.hide();
  return () => { try { t.BackButton.offClick(onBack); } catch { /* ignore */ } };
}
