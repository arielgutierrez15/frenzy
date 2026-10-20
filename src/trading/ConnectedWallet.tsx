import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../nav';
import { WalletBar } from './WalletBar';
import { useWallet } from './walletStore';
import { getBalances, type Balances } from './api';
import { proxyBase } from '../providers/config';
import { ago, usd } from '../format';
import { short } from '../engine';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Real wallet balances, read from the chain by the BAGZ server. Separate from the paper wallet above it. */
export function ConnectedWalletPanel() {
  const ws = useWallet();
  const st = useStore();
  const nav = useNav();
  const [bal, setBal] = useState<Balances | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  const addr = ws.conn?.account.address;
  useEffect(() => {
    setBal(null); setErr('');
    if (!addr) return;
    if (!proxyBase()) { setErr('Balances need the BAGZ server, which isn’t connected to this page.'); return; }
    let live = true;
    getBalances(addr).then((b) => { if (live) setBal(b); }, (e) => { if (live) setErr(e?.message || 'Couldn’t read balances'); });
    return () => { live = false; };
  }, [addr, n]);
  const sol = bal ? Number(bal.lamports) / 1e9 : 0;
  const rows = bal ? bal.tokens.map((t) => {
    const amt = Number(t.amount) / 10 ** t.decimals;
    const c = st.coins[`solana:${t.mint}`];
    const price = t.mint === USDC ? 1 : c?.price;
    return { ...t, amt, c, value: price ? amt * price : undefined };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)) : [];
  return (
    <div className="panel">
      <div className="row gap-s wrap"><h2>Your Solana wallet</h2><span className="pill pill-unofficial">Real funds</span><span className="grow" />{bal && <button className="link small" onClick={() => setN((x) => x + 1)}>Refresh</button>}</div>
      <p className="muted small">Separate from the paper wallet. Connect to see your verified on-chain balances; BAGZ only ever sees your public address.</p>
      <WalletBar compact />
      {err && <p className="small warn">{err}</p>}
      {bal && (
        <>
          <dl className="stats stats-3">
            <div><dt>SOL</dt><dd className="num">{sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</dd></div>
            <div><dt>SOL value</dt><dd className="num">{st.solPrice ? usd(sol * st.solPrice) : '—'}</dd></div>
            <div><dt>Tokens held</dt><dd className="num">{bal.tokens.length}</dd></div>
          </dl>
          <ul className="coin-list">
            {rows.slice(0, 25).map((r) => (
              <li key={r.mint} className="row gap-s">
                {r.c ? <button className="link" onClick={() => nav.openCoin(r.c!.id)}>${r.c.symbol}</button> : <span className="num small">{r.mint === USDC ? 'USDC' : short(r.mint)}</span>}
                <span className="grow" />
                <span className="num small">{r.amt.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                <span className="num small muted">{r.value !== undefined ? usd(r.value) : '—'}</span>
              </li>
            ))}
            {!rows.length && <li className="muted small">No SPL tokens in this wallet.</li>}
          </ul>
          <p className="muted small">Read from Solana {ago(bal.at)} ago. Values use BAGZ’s live prices where the token is tracked.</p>
        </>
      )}
    </div>
  );
}
