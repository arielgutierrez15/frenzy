import React, { useEffect, useRef, useState } from 'react';
import type { Coin } from '../types';
import { useStore } from '../store';
import { Seg } from '../views';
import { SOL_MINT, getQuote, toRaw, fromRaw, type SwapQuote } from './jupiter';
import { liveTradingEnabled, TradingDisabledError } from './flags';
import { useWallet } from './walletStore';
import { WalletBar } from './WalletBar';
import { prepareSwap, getServerConfig, getBalances, newKey, ApiErr, NO_SERVER, type Prepared, type ServerConfig, type Balances } from './api';
import { runSwap, type SwapFlowOutcome } from './bagzSwap';
import { ago, price as fmtPrice } from '../format';

/** pump.fun mints are always 6 decimals; everything else needs Jupiter's token record */
const decimalsOf = (c: Coin): number | undefined => c.decimals ?? (c.launchpad === 'pump.fun' ? 6 : undefined);
const SLIPPAGE = [100, 300, 500, 1000];
const fmtAmt = (n: number) => (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n > 0 ? String(Number(n.toPrecision(4))) : '0');

export function LiveSwap({ c }: { c: Coin }) {
  const st = useStore();
  const ws = useWallet();
  const conn = ws.conn;
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [cfgErr, setCfgErr] = useState('');
  const [bal, setBal] = useState<Balances | null>(null);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState(300);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [preview, setPreview] = useState<SwapQuote | null>(null);
  const [qErr, setQErr] = useState('');
  const [qBusy, setQBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [outcome, setOutcome] = useState<SwapFlowOutcome | null>(null);
  const [tick, setTick] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const busy = useRef(false);
  const dec = decimalsOf(c);
  const clientOn = liveTradingEnabled();

  useEffect(() => { getServerConfig().then(setCfg, (e) => setCfgErr(e instanceof ApiErr ? e.message : NO_SERVER)); }, []);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  // verified on-chain balances for the connected wallet
  useEffect(() => {
    setBal(null);
    if (!conn || !cfg) return;
    let live = true;
    getBalances(conn.account.address).then((b) => { if (live) setBal(b); }, () => {});
    return () => { live = false; };
  }, [conn?.account.address, cfg, outcome]);

  // quote: exact server quote (with the BAGZ fee) when a wallet is connected, otherwise a Jupiter preview
  useEffect(() => {
    setPrep(null); setPreview(null); setQErr('');
    if (c.chain !== 'solana') return;
    const a = Number(amount);
    if (!amount || !(a > 0)) return;
    if (dec === undefined) { setQErr('This token’s decimals aren’t known yet, so BAGZ can’t build a quote.'); return; }
    const raw = toRaw(amount, side === 'BUY' ? 9 : dec);
    if (!raw || raw === '0') { setQErr('Amount is too small'); return; }
    const inputMint = side === 'BUY' ? SOL_MINT : c.address, outputMint = side === 'BUY' ? c.address : SOL_MINT;
    let live = true;
    const t = setTimeout(async () => {
      setQBusy(true);
      if (conn && cfg) {
        try { const p = await prepareSwap({ taker: conn.account.address, inputMint, outputMint, amount: raw, slippageBps: slip, idempotencyKey: newKey() }); if (live) setPrep(p); }
        catch (e: any) { if (live) setQErr(e?.message || 'Quote failed'); }
      } else {
        const r = await getQuote({ inMint: inputMint, outMint: outputMint, amountRaw: raw, slippageBps: slip });
        if (live) { if (r.ok) setPreview(r.quote); else setQErr(r.error); }
      }
      if (live) setQBusy(false);
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [amount, side, slip, c.address, dec, conn?.account.address, cfg, refresh]);

  // a server quote lives 25 s; refresh it automatically while idle
  const expiresIn = prep?.expiresAt ? Math.max(0, Math.round((prep.expiresAt - Date.now()) / 1000)) : null;
  useEffect(() => { if (prep?.live && expiresIn === 0 && !busy.current) setRefresh((x) => x + 1); }, [expiresIn]);
  void tick;

  if (c.chain !== 'solana') return null;

  const inDec = side === 'BUY' ? 9 : dec ?? 6, outDec = side === 'BUY' ? dec ?? 6 : 9;
  const inSym = side === 'BUY' ? 'SOL' : c.symbol, outSym = side === 'BUY' ? c.symbol : 'SOL';
  const q = prep?.quote;
  const outAmt = q ? fromRaw(q.outAmount, outDec) : preview ? fromRaw(preview.outAmount, outDec) : 0;
  const minOut = q ? fromRaw(q.minOut, outDec) : outAmt * (1 - slip / 10_000);
  const feeBps = q?.feeBps ?? cfg?.feeBps ?? 50;
  const feeAmt = q ? fromRaw(q.feeEstimateRaw, q.feeMint === SOL_MINT ? 9 : 6) : (Number(amount) || 0) * feeBps / 10_000 * (side === 'BUY' ? 1 : (st.solPrice && c.price ? c.price / st.solPrice : 0));
  const netFee = q ? q.networkFeeLamports / 1e9 : undefined;
  const solBal = bal ? Number(bal.lamports) / 1e9 : undefined;
  const tokBal = bal ? (() => { const t = bal.tokens.find((x) => x.mint === c.address); return t ? fromRaw(t.amount, t.decimals) : 0; })() : undefined;
  const need = Number(amount) || 0;
  const short_ = side === 'BUY' ? (solBal !== undefined && need + (netFee ?? 0.00001) > solBal) : (tokBal !== undefined && need > tokBal) || (solBal !== undefined && solBal < (netFee ?? 0.00001));
  const serverOn = !!cfg?.liveSwaps;
  const canSwap = clientOn && serverOn && !!conn && !!prep?.live && !!prep.transaction && (expiresIn ?? 0) > 3 && !stage && !short_;
  const label = stage || (!serverOn || !clientOn ? 'Swap (switched off)' : !conn ? 'Connect a wallet first' : short_ ? `Not enough ${side === 'BUY' || (tokBal !== undefined && need <= tokBal) ? 'SOL' : c.symbol}` : !prep ? (qBusy ? 'Getting a quote…' : qErr ? 'No quote' : Number(amount) > 0 ? 'Getting a quote…' : 'Enter an amount') : `Swap with ${conn.wallet.name}`);

  const swap = async () => {
    if (!conn || !prep || busy.current) return;
    busy.current = true;
    setOutcome(null);
    try { setOutcome(await runSwap(prep, conn, { onStage: setStage })); }
    catch (e: any) { setOutcome({ ok: false, stage: 'prepare', error: e instanceof TradingDisabledError ? e.message : e?.message || 'Failed' }); }
    finally { busy.current = false; setStage(''); setPrep(null); setRefresh((x) => x + 1); }
  };

  return (
    <div className="panel live-swap">
      <div className="row gap-s wrap"><h2>Live swap</h2><span className={`pill ${serverOn && clientOn ? 'pill-warn' : 'pill-unofficial'}`}>{serverOn && clientOn ? 'Real funds' : 'Preview only'}</span></div>
      {cfgErr && <p className="muted small">{cfgErr} Paper trading is unaffected.</p>}
      {cfg && (!serverOn || !clientOn) && <p className="muted small">Real swaps are switched off until security and compliance reviews are complete. You can connect a wallet and see exact quotes, including the BAGZ fee; nothing can be signed or sent. Paper trades are unaffected.</p>}

      <WalletBar />
      {conn && bal && <p className="small num">Balance: {fmtAmt(solBal!)} SOL · {fmtAmt(tokBal!)} {c.symbol} <span className="muted">(on-chain, {ago(bal.at)} ago)</span></p>}

      <Seg label="Side" value={side} onChange={(v) => { setSide(v); setAmount(''); setOutcome(null); }} options={[{ v: 'BUY', l: 'Buy' }, { v: 'SELL', l: 'Sell' }]} />
      <label className="amount">
        <span className="muted small">{side === 'BUY' ? 'Pay (SOL)' : `Sell (${c.symbol})`}</span>
        <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} aria-label="Swap amount" disabled={!!stage} />
      </label>
      <Seg label="Max slippage" value={String(slip) as any} onChange={(v) => setSlip(Number(v))} options={SLIPPAGE.map((s) => ({ v: String(s) as any, l: `${s / 100}%` }))} />

      {qBusy && <p className="muted small">{conn && cfg ? 'Building your exact quote…' : 'Getting a live quote from Jupiter…'}</p>}
      {qErr && <p className="small warn">{qErr}</p>}
      {(q || preview) && (
        <dl className="stats stats-3">
          <div><dt>You pay</dt><dd className="num">{fmtAmt(fromRaw(q ? q.inAmount : (preview!.inAmount || toRaw(amount, inDec) || '0'), inDec))} {inSym}</dd></div>
          <div><dt>You receive (est.)</dt><dd className="num">{fmtAmt(outAmt)} {outSym}</dd></div>
          <div><dt>Minimum received</dt><dd className="num">{fmtAmt(minOut)} {outSym}</dd></div>
          <div><dt>Max slippage</dt><dd className="num">{((q?.slippageBps ?? slip) / 100).toFixed(2)}%</dd></div>
          <div><dt>Price impact</dt><dd className={`num ${(q?.priceImpactPct ?? preview?.priceImpactPct ?? 0) > 5 ? 'down' : ''}`}>{q?.priceImpactPct != null ? `${q.priceImpactPct.toFixed(2)}%` : preview?.priceImpactPct !== undefined ? `${preview.priceImpactPct.toFixed(2)}%` : 'not reported'}</dd></div>
          <div><dt>BAGZ fee ({(feeBps / 100).toFixed(2)}%)</dt><dd className="num">≈ {fmtAmt(feeAmt)} SOL</dd></div>
          <div><dt>Network fee</dt><dd className="num">{netFee !== undefined ? `${q!.networkFeeIsMax ? 'up to ' : '≈ '}${netFee.toFixed(6)} SOL` : 'shown after you connect'}</dd></div>
          <div><dt>Route</dt><dd>{q ? (q.routes.join(' → ') || 'Jupiter') : preview?.router || '—'}</dd></div>
          <div><dt>Quote</dt><dd className="num">{prep?.live && expiresIn !== null ? `refreshes in ${expiresIn}s` : q ? 'exact (not signable)' : 'preview'}</dd></div>
        </dl>
      )}
      {q && <p className="muted small">Built by BAGZ with Jupiter{q.simulated ? ' and checked in a simulation' : ' (not simulated while live swaps are off; the network fee shown is the maximum)'}. The 0.50% BAGZ fee is part of the swap instruction, so your wallet shows it in what you sign. A token account may also need rent if this is your first {outSym}. Market price {c.price > 0 ? fmtPrice(c.price) : '—'} per {c.symbol}.</p>}
      {!q && preview && <p className="muted small">Preview from Jupiter. Connect a wallet for the exact BAGZ quote with the 0.50% fee and network fee.</p>}

      <button className="btn btn-accent" disabled={!canSwap} onClick={swap}>{label}</button>
      {outcome && (outcome.ok
        ? <p className="small up">Confirmed on Solana. BAGZ fee collected: {outcome.feeCollected ? fmtAmt(fromRaw(outcome.feeCollected, outcome.feeMint === SOL_MINT ? 9 : 6)) : '—'} {outcome.feeMint === SOL_MINT ? 'SOL' : 'USDC'}. <a className="link" target="_blank" rel="noopener noreferrer" href={`https://solscan.io/tx/${outcome.signature}`}>View transaction</a>{outcome.warning ? <span className="warn"> {outcome.warning}</span> : null}</p>
        : <p className="small warn">{outcome.error}{outcome.signature ? <> <a className="link" target="_blank" rel="noopener noreferrer" href={`https://solscan.io/tx/${outcome.signature}`}>Check transaction</a></> : null}</p>)}
    </div>
  );
}
