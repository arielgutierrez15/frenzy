/**
 * Wallet connection through the Wallet Standard (Phantom, Solflare, Backpack and others register themselves).
 * No private key or seed phrase is ever requested, read or stored: the wallet signs inside its own extension/app and
 * BAGZ only sees the public address and the signed transaction bytes. Nothing here is persisted.
 */
export interface WalletAccount { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] }
export interface StdWallet {
  name: string; icon: string; version?: string;
  chains: readonly string[];
  features: Record<string, any>;
  accounts: readonly WalletAccount[];
}
export interface WalletApi { register: (...w: StdWallet[]) => () => void }

const wallets: StdWallet[] = [];
const subs = new Set<() => void>();
let started = false;
const notify = () => subs.forEach((f) => f());

const api: WalletApi = {
  register: (...w) => {
    wallets.push(...w.filter((x) => x && !wallets.includes(x)));
    notify();
    return () => { for (const x of w) { const i = wallets.indexOf(x); if (i >= 0) wallets.splice(i, 1); } notify(); };
  },
};

/** Start listening for wallets. Safe to call more than once. */
export function startWalletDiscovery(win: Window | undefined = typeof window !== 'undefined' ? window : undefined) {
  if (started || !win) return;
  started = true;
  win.addEventListener('wallet-standard:register-wallet', ((e: CustomEvent) => { try { e.detail(api); } catch { /* a faulty wallet must not break the app */ } }) as EventListener);
  try { win.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch { /* ignore */ }
}
export function __resetWallets() { wallets.length = 0; started = false; subs.clear(); }
export const subscribeWallets = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

const SOLANA_SIGN = 'solana:signTransaction';
/** only wallets that can connect and sign a Solana transaction are offered */
export const solanaWallets = (): StdWallet[] => wallets.filter((w) => w.features['standard:connect'] && w.features[SOLANA_SIGN] && w.chains.some((c) => c.startsWith('solana:')));

export interface Connected { wallet: StdWallet; account: WalletAccount }
export class WalletError extends Error { constructor(m: string, public code: 'rejected' | 'no-account' | 'unsupported' | 'failed') { super(m); this.name = 'WalletError'; } }

export async function connectWallet(w: StdWallet): Promise<Connected> {
  try {
    const { accounts } = await w.features['standard:connect'].connect();
    const account = (accounts && accounts[0]) || w.accounts[0];
    if (!account) throw new WalletError('The wallet did not share an account', 'no-account');
    return { wallet: w, account };
  } catch (e: any) {
    if (e instanceof WalletError) throw e;
    const msg = String(e?.message || e);
    throw new WalletError(/reject|denied|cancel/i.test(msg) ? 'Connection was cancelled in the wallet' : `Couldn’t connect: ${msg}`, /reject|denied|cancel/i.test(msg) ? 'rejected' : 'failed');
  }
}
export async function disconnectWallet(w: StdWallet) {
  try { await w.features['standard:disconnect']?.disconnect(); } catch { /* ignore */ }
}

export const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bytesToB64 = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };

/** Asks the wallet to sign a base64 transaction. The wallet shows the user exactly what is being signed. */
export async function signTransactionB64(c: Connected, txB64: string): Promise<string> {
  const f = c.wallet.features[SOLANA_SIGN];
  if (!f) throw new WalletError('This wallet cannot sign Solana transactions', 'unsupported');
  try {
    const out = await f.signTransaction({ account: c.account, transaction: b64ToBytes(txB64), chain: 'solana:mainnet' });
    const signed: Uint8Array | undefined = out?.[0]?.signedTransaction;
    if (!(signed instanceof Uint8Array) || !signed.length) throw new WalletError('The wallet returned no signed transaction', 'failed');
    return bytesToB64(signed);
  } catch (e: any) {
    if (e instanceof WalletError) throw e;
    const msg = String(e?.message || e);
    throw new WalletError(/reject|denied|cancel/i.test(msg) ? 'You declined the signature' : `Signing failed: ${msg}`, /reject|denied|cancel/i.test(msg) ? 'rejected' : 'failed');
  }
}

/** Asks the wallet to sign a plain-text message (used only for admin sign-in; it cannot move funds). Returns base64. */
export async function signMessageText(c: Connected, text: string): Promise<string> {
  const f = c.wallet.features['solana:signMessage'];
  if (!f) throw new WalletError('This wallet cannot sign messages', 'unsupported');
  try {
    const out = await f.signMessage({ account: c.account, message: new TextEncoder().encode(text) });
    const sig: Uint8Array | undefined = out?.[0]?.signature;
    if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new WalletError('The wallet returned no signature', 'failed');
    return bytesToB64(sig);
  } catch (e: any) {
    if (e instanceof WalletError) throw e;
    const msg = String(e?.message || e);
    throw new WalletError(/reject|denied|cancel/i.test(msg) ? 'You declined the signature' : `Signing failed: ${msg}`, /reject|denied|cancel/i.test(msg) ? 'rejected' : 'failed');
  }
}

/** Wallet Standard change events (account switched or disconnected inside the wallet). Returns an unsubscribe. */
export function onWalletChange(w: StdWallet, fn: (accounts: readonly WalletAccount[] | undefined) => void): () => void {
  const ev = w.features['standard:events'];
  if (!ev || typeof ev.on !== 'function') return () => {};
  try { return ev.on('change', (p: { accounts?: readonly WalletAccount[] }) => { if (p && 'accounts' in p) fn(p.accounts); }) || (() => {}); } catch { return () => {}; }
}
