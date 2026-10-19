import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { Coin } from '../types';
import { useStore } from '../store';
import { Seg } from '../views';
import { SOL_MINT, getQuote, toRaw, fromRaw, estimateCostVsMarket, executeSwap, type SwapQuote, type SwapOutcome } from './jupiter';
import { liveTradingEnabled, TradingDisabledError } from './flags';
import { startWalletDiscovery, subscribeWallets, solanaWallets, connectWallet, disconnectWallet, type Connected, type StdWallet } from './wallet';
import { short } from '../engine';
import { ago, price as fmtPrice } from '../format';

/** pump.fun mints are always 6 decimals; everything else needs Jupiter's token record */
const decimalsOf = (c: Coin): number | undefined => c.decimals ?? (c.launchpad === 'pump.fun' ? 6 : undefined);
const SLIPPAGE = [100, 300, 500, 1000];
let walletVersion = 0;
subscribeWallets(() => { walletVersion++; });

export function LiveSwap({ c }: { c: Coin }) {
  const st = useStore();
  useSyncExternalStore(subscribeWallets, () => walletVersion);
  const [conn, setConn] = useState<Connected | null>(null);
  const [walletErr, setWalletErr] = useState('');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState(300);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [qErr, setQErr] = useState('');
  const [qBusy, setQBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [outcome, setOutcome] = useState<SwapOutcome | null>(null);
  const on = liveTradingEnabled();
  const dec = decimalsOf(c);
  const solUsd = st.solPrice;

  useEffect(() => { startWalletDiscovery(); }, []);

  useEffect(() => {
    setQuote(null); setQErr('');
    if (c.chain !== 'solana') return;
    const a = Number(amount);
    if (!amount || !(a > 0)) return;
    if (dec === undefined) { setQErr('This token’s decimals aren’t known yet, so BAGZ can’t build a quote.'); return; }
    const raw = toRaw(amount, side === 'BUY' ? 9 : dec);
    if (!raw || raw === '0') { setQErr('Amount is too small'); return; }
    let live = true;
    const t = setTimeout(async () => {
      setQBusy(true);
      const r = await getQuote({ inMint: side === 'BUY' ? SOL_MINT : c.address, outMint: side === 'BUY' ? c.address : SOL_MINT, amountRaw: raw, slippageBps: slip });
      if (!live) return;
      setQBusy(false);
      if (r.ok) setQuote(r.quote); else setQErr(r.error);
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [amount, side, slip, c.address, dec]);

  if (c.chain !== 'solana') return null;

  const wallets = solanaWallets();
  const connect = async (w: StdWallet) => {
    setWalletErr('');
    try { setConn(await connectWallet(w)); } catch (e: any) { setWalletErr(e?.message || 'Couldn’t connect'); }
  };

  // display maths
  const inDec = side === 'BUY' ? 9 : dec ?? 6, outDec = side === 'BUY' ? dec ?? 6 : 9;
  const inAmt = quote?.inAmount ? fromRaw(quote.inAmount, inDec) : Number(amount) || 0;
  const outAmt = quote ? fromRaw(quote.outAmount, outDec) : 0;
  const marketInOut = c.price > 0 && solUsd ? (side === 'BUY' ? solUsd / c.price : c.price / solUsd) : 0;
  const cost = quote ? estimateCostVsMarket({ inAmount: inAmt, outAmount: outAmt, marketPriceInOut: marketInOut }) : undefined;
  const minOut = outAmt * (1 - slip / 10_000);
  const outSym = side === 'BUY' ? c.symbol : 'SOL', inSym = side === 'BUY' ? 'SOL' : c.symbol;

  const swap = async () => {
    if (!conn) return;
    setOutcome(null);
    try {
      const raw = toRaw(amount, side === 'BUY' ? 9 : dec!)!;
      const out = await executeSwap({ inMint: side === 'BUY' ? SOL_MINT : c.address, outMint: side === 'BUY' ? c.address : SOL_MINT, amountRaw: raw, slippageBps: slip }, conn, { onStage: setStage });
      setOutcome(out);
    } catch (e: any) {
      setOutcome({ ok: false, stage: 'execute', error: e instanceof TradingDisabledError ? e.message : e?.message || 'Failed' });
    } finally { setStage(''); }
  };

  return (
    <div className="panel live-swap">
      <div className="row gap-s wrap"><h2>Live swap</h2><span className={`pill ${on ? 'pill-warn' : 'pill-unofficial'}`}>{on ? 'Enabled in this build' : 'Preview only'}</span></div>
      {!on && <p className="muted small">Real trading is switched off until the complete flow has been tested on mainnet. You can connect a wallet and see live Jupiter quotes; no transaction can be sent from this page. Paper trades are unaffected.</p>}

      <div className="row gap-s wrap">
        {conn ? (
          <>
            <span className="tag tag-plain">{conn.wallet.name}</span><span className="num small">{short(conn.account.address)}</span>
            <button className="link small" onClick={() => { disconnectWallet(conn.wallet); setConn(null); }}>Disconnect</button>
          </>
        ) : wallets.length ? wallets.map((w) => (
          <button key={w.name} className="chip-btn" onClick={() => connect(w)}>{w.icon ? <img src={w.icon} alt="" width={16} height={16} style={{ borderRadius: 4, marginRight: 6, verticalAlign: '-3px' }} /> : null}Connect {w.name}</button>
        )) : <span className="muted small">No Solana wallet detected. Install Phantom, Solflare or Backpack, then reload.</span>}
      </div>
      {walletErr && <p className="small warn">{walletErr}</p>}
      <p className="muted small">BAGZ never asks for a seed phrase or private key. Your wallet signs inside its own app.</p>

      <Seg label="Side" value={side} onChange={(v) => { setSide(v); setAmount(''); }} options={[{ v: 'BUY', l: 'Buy' }, { v: 'SELL', l: 'Sell' }]} />
      <label className="amount">
        <span className="muted small">{side === 'BUY' ? 'Pay (SOL)' : `Sell (${c.symbol})`}</span>
        <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Swap amount" />
      </label>
      <Seg label="Max slippage" value={String(slip) as any} onChange={(v) => setSlip(Number(v))} options={SLIPPAGE.map((s) => ({ v: String(s) as any, l: `${s / 100}%` }))} />

      {qBusy && <p className="muted small">Getting a live quote from Jupiter…</p>}
      {qErr && <p className="small warn">{qErr}</p>}
      {quote && (
        <dl className="stats stats-3">
          <div><dt>You receive (est.)</dt><dd className="num">{outAmt >= 1 ? outAmt.toLocaleString(undefined, { maximumFractionDigits: 4 }) : outAmt.toPrecision(4)} {outSym}</dd></div>
          <div><dt>Minimum after slippage</dt><dd className="num">{minOut >= 1 ? minOut.toLocaleString(undefined, { maximumFractionDigits: 4 }) : minOut.toPrecision(4)} {outSym}</dd></div>
          <div><dt>Route</dt><dd>{quote.router || '—'}</dd></div>
          <div><dt>Jupiter fee</dt><dd className="num">{quote.feeBps !== undefined ? `${(quote.feeBps / 100).toFixed(2)}%` : '—'}</dd></div>
          <div><dt>Price impact</dt><dd className="num">{quote.priceImpactPct !== undefined ? `${quote.priceImpactPct.toFixed(2)}%` : 'not reported'}</dd></div>
          <div><dt>Est. cost vs market</dt><dd className={`num ${cost !== undefined && cost > 5 ? 'down' : ''}`}>{cost !== undefined ? `${cost.toFixed(2)}%` : '—'}</dd></div>
        </dl>
      )}
      {quote && <p className="muted small">{inAmt.toPrecision(4)} {inSym} at market {c.price > 0 ? fmtPrice(c.price) : '—'} per {c.symbol}. Quote fetched {ago(quote.fetchedAt)} ago and expires in about 20 seconds. Network fees are not included. “Est. cost vs market” is BAGZ’s own estimate including fees, spread and impact.</p>}

      <button className="btn btn-accent" disabled={!on || !conn || !quote || !!stage} onClick={swap}>{stage || (on ? (conn ? `Swap with ${conn.wallet.name}` : 'Connect a wallet first') : 'Swap (switched off)')}</button>
      {outcome && (outcome.ok
        ? <p className="small up">Confirmed on Solana. <a className="link" target="_blank" rel="noopener noreferrer" href={`https://solscan.io/tx/${outcome.signature}`}>View transaction</a></p>
        : <p className="small warn">{outcome.error}{outcome.signature ? <> <a className="link" target="_blank" rel="noopener noreferrer" href={`https://solscan.io/tx/${outcome.signature}`}>Check transaction</a></> : null}</p>)}
    </div>
  );
}
