import React, { useEffect, useRef, useState } from 'react';
import { useNav } from '../nav';
import { Icon } from '../ui';
import { WalletBar } from '../trading/WalletBar';
import { useWallet } from '../trading/walletStore';
import { signTransactionB64 } from '../trading/wallet';
import {
  boostPreview, createOrder, orderTransaction, submitOrderPayment, verifyOrder, getOrder, getServerConfig, newKey, ApiErr, NO_SERVER,
  type ServerConfig, type TokenInfo, type Order, type Pkg,
} from '../trading/api';
import { ago } from '../format';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STORE = 'bagz.boost.orders';
let pendingMint = '';
/** open the Promote page pre-filled with a token */
export const setPromoteMint = (m: string) => { pendingMint = m; };

const loadMine = (): string[] => { try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : []; } catch { return []; } };
const saveMine = (ids: string[]) => { try { localStorage.setItem(STORE, JSON.stringify(ids.slice(0, 20))); } catch { /* storage blocked */ } };
const STATUS: Record<Order['status'], string> = {
  awaiting_payment: 'Waiting for payment', pending_review: 'Paid · waiting for BAGZ review', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', expired_unpaid: 'Expired (unpaid)',
};

export function PromoteView() {
  const nav = useNav();
  const ws = useWallet();
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [cfgErr, setCfgErr] = useState('');
  const [mint, setMint] = useState(pendingMint);
  const [pkg, setPkg] = useState<Pkg['id']>('boost');
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tErr, setTErr] = useState('');
  const [tBusy, setTBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [err, setErr] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [payLink, setPayLink] = useState<string | null>(null);
  const [mine, setMine] = useState<Order[]>([]);
  const busy = useRef(false);

  useEffect(() => { pendingMint = ''; getServerConfig().then(setCfg, (e) => setCfgErr(e instanceof ApiErr ? e.message : NO_SERVER)); }, []);
  useEffect(() => {
    if (!cfg) return;
    Promise.all(loadMine().map((id) => getOrder(id).then((r) => r.order, () => null))).then((xs) => setMine(xs.filter(Boolean) as Order[]));
  }, [cfg, order?.status]);

  useEffect(() => {
    setToken(null); setTErr('');
    const m = mint.trim();
    if (!m) return;
    if (!B58.test(m)) { setTErr('That isn’t a Solana token address.'); return; }
    if (!cfg) return;
    let live = true;
    const t = setTimeout(async () => {
      setTBusy(true);
      try { const r = await boostPreview(m, pkg); if (live) setToken(r.token); }
      catch (e: any) { if (live) setTErr(e?.message || 'Couldn’t check that token'); }
      if (live) setTBusy(false);
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [mint, cfg]);

  const packages = cfg?.packages || [];
  const chosen = packages.find((p) => p.id === pkg);
  const payOn = !!cfg?.liveBoostPayments;

  const remember = (id: string) => { const ids = [id, ...loadMine().filter((x) => x !== id)]; saveMine(ids); };
  const waitForVerification = async (o: Order, signature?: string) => {
    for (let i = 0; i < 30; i++) {
      try {
        const v = await verifyOrder(o.id, signature);
        setOrder(v.order);
        if (v.verified) return true;
      } catch (e: any) { setErr(e?.message || 'Verification failed'); return false; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    setErr('Payment not confirmed yet. Use “Check payment” in a minute; the order keeps waiting for it.');
    return false;
  };

  const pay = async () => {
    if (!ws.conn || !token || !chosen || busy.current) return;
    busy.current = true; setErr('');
    try {
      setStage('Creating order');
      const created = order && order.status === 'awaiting_payment' && order.mint === token.mint && order.package === pkg && order.advertiser === ws.conn.account.address
        ? { order, solanaPay: payLink }
        : await createOrder({ mint: token.mint, package: pkg, advertiser: ws.conn.account.address, idempotencyKey: newKey() });
      setOrder(created.order); setPayLink(created.solanaPay); remember(created.order.id);
      setStage('Building the USDC payment');
      const tx = await orderTransaction(created.order.id, ws.conn.account.address);
      setStage('Waiting for your wallet to sign');
      const signed = await signTransactionB64(ws.conn, tx.transaction);
      setStage('Sending payment');
      const sub = await submitOrderPayment(created.order.id, signed);
      setStage('Confirming payment on Solana');
      await waitForVerification(created.order, sub.signature);
    } catch (e: any) { setErr(e?.message || 'Payment failed'); }
    finally { busy.current = false; setStage(''); }
  };
  const recheck = async () => { if (!order || busy.current) return; busy.current = true; setStage('Checking for your payment'); await waitForVerification(order); busy.current = false; setStage(''); };

  return (
    <section className="view promote">
      <button className="back" onClick={() => nav.go('home')}><Icon.back /> Home</button>
      <header className="view-head">
        <div>
          <h1>Promote a token</h1>
          <p className="muted">Paid placement in the <b>Sponsored</b> row on Home. Sponsored slots are always labelled, sit apart from BAGZ rankings, and never change Gem Scores or risk checks. Every listing is reviewed by BAGZ before it appears.</p>
        </div>
      </header>
      {cfgErr && <div className="banner banner-warn"><Icon.warn /> {cfgErr}</div>}
      {cfg && !payOn && <div className="banner banner-warn"><Icon.warn /> Boost payments are switched off while the feature is reviewed. You can check a token and see prices; nothing can be paid yet.</div>}

      <div className="panel">
        <h2>1 · Token</h2>
        <label className="amount addr-input">
          <span className="muted small">Solana token address (mint)</span>
          <input value={mint} onChange={(e) => setMint(e.target.value.trim())} placeholder="e.g. DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" aria-label="Token address" spellCheck={false} autoCapitalize="off" />
        </label>
        {tBusy && <p className="muted small">Checking the token on-chain and its market data…</p>}
        {tErr && <p className="small warn">{tErr}</p>}
        {token && (
          <div className="row gap-s promo-token">
            {token.icon ? <img src={token.icon} alt="" width={40} height={40} referrerPolicy="no-referrer" className="promo-ico" /> : <span className="coin-badge" />}
            <span className="stack"><b>${token.symbol}</b><span className="muted small">{token.name} · verified mint · {token.decimals} decimals</span></span>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>2 · Package</h2>
        <div className="promo-pkgs" role="radiogroup" aria-label="Package">
          {packages.map((p) => (
            <button key={p.id} role="radio" aria-checked={pkg === p.id} className={`promo-pkg ${pkg === p.id ? 'on' : ''}`} onClick={() => setPkg(p.id)}>
              <b>{p.label}</b>
              <span className="num big">${p.usdc}</span>
              <span className="muted small">{p.hours < 48 ? `${p.hours} hours` : `${p.hours / 24} days`} · USDC</span>
            </button>
          ))}
          {!packages.length && <p className="muted small">{cfgErr ? 'Packages load from the BAGZ server.' : 'Loading packages…'}</p>}
        </div>
      </div>

      <div className="panel">
        <h2>3 · Pay with USDC on Solana</h2>
        <WalletBar compact />
        <button className="btn btn-accent" disabled={!payOn || !ws.conn || !token || !chosen || !!stage} onClick={pay}>
          {stage || (!payOn ? 'Payments switched off' : !ws.conn ? 'Connect a wallet first' : !token ? 'Check a token first' : `Pay ${chosen?.usdc ?? ''} USDC`)}
        </button>
        <p className="muted small">Your wallet shows the exact USDC transfer before you sign. BAGZ checks the payment on-chain (USDC, amount, recipient and this order’s reference) before the order goes to review. Network fees are a fraction of a cent in SOL.</p>
        {err && <p className="small warn">{err}</p>}
        {order && (
          <div className="promo-order">
            <div className="row gap-s wrap"><b>Order {order.id.slice(0, 8)}</b><span className="pill pill-unofficial">{STATUS[order.status]}</span></div>
            {order.status === 'awaiting_payment' && (
              <>
                {payLink && <p className="small">Paying from another wallet or your phone? <a className="link" href={payLink}>Open Solana Pay link</a>, then come back and check.</p>}
                <button className="btn btn-ghost btn-sm" onClick={recheck} disabled={!!stage}>Check payment</button>
              </>
            )}
            {order.status === 'pending_review' && <p className="small up">Payment verified. Your listing goes live once BAGZ approves it.</p>}
          </div>
        )}
      </div>

      {mine.length > 0 && (
        <div className="panel">
          <h2>Your orders</h2>
          <p className="muted small">Saved in this browser.</p>
          <ul className="coin-list">
            {mine.map((o) => (
              <li key={o.id} className="row gap-s">
                <b>${o.symbol}</b><span className="muted small">{o.package} · ${o.priceUsdc}</span><span className="grow" />
                <span className="small">{STATUS[o.status]}{o.status === 'approved' && o.endsAt ? ` · ${o.endsAt > Date.now() ? (o.startsAt && o.startsAt > Date.now() ? 'starts in ' + ago(Date.now(), o.startsAt) : 'ends in ' + ago(Date.now(), o.endsAt)) : 'ended'}` : ''}{o.reviewNote && o.status === 'rejected' ? ` · ${o.reviewNote}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
