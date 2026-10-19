import React, { useEffect, useMemo, useState } from 'react';
import type { Side } from './types';
import { useStore, act, emit, getState } from './store';
import { useNav, TradeIntent } from './nav';
import { CoinBadge, Icon, Change } from './ui';
import { Wordmark } from './brand';
import { quote, userTrade, placeOrder, change24, mcapOf, userStats, scoreCoin, refreshOne, FEE_RATE } from './engine';
import { ago, compact, pct, price as fmtPrice, qty as fmtQty, usd, signedUsd } from './format';

type Kind = 'market' | 'limit' | 'tp' | 'sl';

export function TradeSheet({ intent, onClose }: { intent: TradeIntent; onClose: () => void }) {
  const st = useStore();
  const nav = useNav();
  const c = st.coins[intent.coinId];
  const [side, setSide] = useState<Side>(intent.side);
  const [kind, setKind] = useState<Kind>('market');
  const [amt, setAmt] = useState<string>(String(intent.usd ?? 100));
  const [sellPct, setSellPct] = useState<number>(100);
  const [trigger, setTrigger] = useState<string>('');
  const [addTp, setAddTp] = useState(false);
  const [addSl, setAddSl] = useState(false);
  const [err, setErr] = useState<string>('');
  const pos = c ? st.user.positions[c.id] : undefined;
  const slip = st.settings.slippage;

  // Set defaults once per coin/side/kind — never on every price tick (bug in the original terminal).
  useEffect(() => {
    if (!c) return;
    const p = c.price;
    if (kind === 'limit') setTrigger(sig(p * 0.85));
    if (kind === 'tp') setTrigger(sig(p * 2));
    if (kind === 'sl') setTrigger(sig(p * 0.7));
    setErr('');
  }, [c?.id, side, kind]);

  // fills use the market as it is now: pull a fresh price when the sheet opens and every 10 seconds while it's open
  useEffect(() => {
    let alive = true;
    const run = () => refreshOne(getState(), intent.coinId).then(() => { if (alive) emit(); });
    run();
    const t = setInterval(run, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [intent.coinId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!c) return null;
  const usdIn = parseFloat(amt) || 0;
  const sellQty = pos ? pos.qty * (sellPct / 100) : 0;
  const q = side === 'BUY' ? quote(c, 'BUY', usdIn, slip) : quote(c, 'SELL', sellQty, slip);
  const isOrder = kind !== 'market';
  const trig = parseFloat(trigger);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (isOrder) {
      const r = act((s) => placeOrder(s, side === 'BUY'
        ? { coinId: c.id, side, kind: 'limit', trigger: trig, usd: usdIn }
        : { coinId: c.id, side, kind: kind as 'tp' | 'sl', trigger: trig, pct: sellPct }));
      if (!r.ok) return setErr(r.message);
      nav.toast('info', 'Order placed', r.message);
      return onClose();
    }
    const r = act((s) => userTrade(s, c.id, side, side === 'BUY' ? usdIn : sellQty, { via: intent.via }));
    if (!r.ok) return setErr(r.message);
    if (side === 'BUY' && r.trade) {
      const fill = r.trade.price;
      if (addTp) act((s) => placeOrder(s, { coinId: c.id, side: 'SELL', kind: 'tp', trigger: fill * 2, pct: 50 }));
      if (addSl) act((s) => placeOrder(s, { coinId: c.id, side: 'SELL', kind: 'sl', trigger: fill * 0.7, pct: 100 }));
    }
    nav.toast(side === 'BUY' ? 'up' : r.trade && (r.trade.pnl ?? 0) < 0 ? 'down' : 'up', side === 'BUY' ? 'Bought' : 'Sold', r.message);
    onClose();
  };

  const presetsUsd = [25, 100, 250, 1000];
  const kinds: { v: Kind; l: string }[] = side === 'BUY' ? [{ v: 'market', l: 'Market' }, { v: 'limit', l: 'Limit' }] : [{ v: 'market', l: 'Market' }, { v: 'tp', l: 'Take profit' }, { v: 'sl', l: 'Stop loss' }];
  const impactTone = q.impact > 10 ? 'down' : q.impact > 3 ? 'warn' : 'up';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} ${c.symbol}`} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet-grip" />
        <header className="sheet-head">
          <CoinBadge coin={c} size={40} />
          <div className="stack">
            <b>${c.symbol}</b>
            <span className="muted small num">{fmtPrice(c.price)} · {compact(mcapOf(c))} mcap · <Change v={change24(c)} /> 24h</span>
          </div>
          <span className="grow" />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </header>

        <div className="side-toggle" role="tablist" aria-label="Side">
          <button type="button" role="tab" aria-selected={side === 'BUY'} className={side === 'BUY' ? 'on-up' : ''} onClick={() => { setSide('BUY'); setKind('market'); }}>Buy</button>
          <button type="button" role="tab" aria-selected={side === 'SELL'} className={side === 'SELL' ? 'on-down' : ''} disabled={!pos} onClick={() => { setSide('SELL'); setKind('market'); }}>Sell</button>
        </div>
        <div className="seg seg-sm" role="tablist" aria-label="Order type">
          {kinds.map((k) => <button type="button" key={k.v} role="tab" aria-selected={kind === k.v} className={kind === k.v ? 'on' : ''} onClick={() => setKind(k.v)}>{k.l}</button>)}
        </div>

        {side === 'BUY' ? (
          <>
            <label className="field" htmlFor="trade-usd">
              <span>Spend</span>
              <div className="amount"><span className="amount-cur">$</span><input id="trade-usd" inputMode="decimal" autoComplete="off" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))} autoFocus /></div>
              <span className="muted small num">Cash {usd(st.user.cash)}</span>
            </label>
            <div className="presets">
              {presetsUsd.map((p) => <button type="button" key={p} className={`chip-btn ${usdIn === p ? 'on' : ''}`} onClick={() => setAmt(String(p))}>${p >= 1000 ? p / 1000 + 'K' : p}</button>)}
              <button type="button" className="chip-btn" onClick={() => setAmt(String(Math.floor(st.user.cash * 100) / 100))}>Max</button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <span>Sell</span>
              <div className="presets">
                {[25, 50, 75, 100].map((p) => <button type="button" key={p} className={`chip-btn ${sellPct === p ? 'on' : ''}`} onClick={() => setSellPct(p)}>{p}%</button>)}
              </div>
              <span className="muted small num">{fmtQty(sellQty)} of {fmtQty(pos?.qty || 0)} {c.symbol} · worth {usd(sellQty * c.price)}</span>
            </div>
          </>
        )}

        {isOrder && (
          <label className="field" htmlFor="trade-trigger">
            <span>{kind === 'limit' ? 'Buy when price drops to' : kind === 'tp' ? 'Sell when price reaches' : 'Sell if price falls to'}</span>
            <div className="amount"><span className="amount-cur">$</span><input id="trade-trigger" inputMode="decimal" autoComplete="off" value={trigger} onChange={(e) => setTrigger(e.target.value.replace(/[^0-9.e-]/g, ''))} /></div>
            <span className="muted small num">{trig > 0 ? `${pct((trig / c.price - 1) * 100)} from now · ${compact(c.price > 0 ? (trig * c.mcap) / c.price : 0)} mcap` : 'Enter a price'}</span>
          </label>
        )}

        {!isOrder && (
          <dl className="quote">
            <div><dt>{side === 'BUY' ? 'You get about' : 'You get about'}</dt><dd className="num">{side === 'BUY' ? `${fmtQty(q.qty)} ${c.symbol}` : usd(q.usd)}</dd></div>
            <div><dt>Average price</dt><dd className="num">{fmtPrice(q.execPrice)}</dd></div>
            <div><dt>Price impact</dt><dd className={`num ${impactTone}`}>{q.impact.toFixed(2)}%</dd></div>
            <div><dt>Fee ({(FEE_RATE * 100).toFixed(1)}%)</dt><dd className="num">{usd(q.fee)}</dd></div>
            {side === 'SELL' && pos && <div><dt>Realized PnL</dt><dd className={`num ${q.usd - pos.cost * (sellPct / 100) >= 0 ? 'up' : 'down'}`}>{signedUsd(q.usd - pos.cost * (sellPct / 100))}</dd></div>}
          </dl>
        )}

        <div className="slip">
          <span className="muted small">Max slippage</span>
          {[1, 5, 10, 25].map((v) => <button type="button" key={v} className={`chip-btn chip-xs ${slip === v ? 'on' : ''}`} onClick={() => act((s) => { s.settings.slippage = v; })}>{v}%</button>)}
        </div>

        {side === 'BUY' && kind === 'market' && (
          <div className="row gap wrap small">
            <label className="switch"><input id="auto-tp" type="checkbox" checked={addTp} onChange={(e) => setAddTp(e.target.checked)} /><span>Sell half at 2x</span></label>
            <label className="switch"><input id="auto-sl" type="checkbox" checked={addSl} onChange={(e) => setAddSl(e.target.checked)} /><span>Stop loss at −30%</span></label>
          </div>
        )}

        {side === 'BUY' && !c.rugged && scoreCoin(c).risk === 'high' && <p className="banner banner-warn small"><Icon.warn size={16} /> Gem Radar rates this coin high rug risk: {scoreCoin(c).reasons.slice(0, 2).join(', ')}.</p>}
        {(err || (!isOrder && !q.ok && (side === 'SELL' || usdIn > 0))) && <p className="error small" role="alert">{err || q.error}</p>}

        <button className={`btn btn-lg ${side === 'BUY' ? 'btn-accent' : 'btn-down-solid'}`} type="submit" disabled={!isOrder && !q.ok}>
          {isOrder
            ? kind === 'limit' ? `Place limit buy · ${usd(usdIn, 0)}` : kind === 'tp' ? `Set take profit · ${sellPct}%` : `Set stop loss · ${sellPct}%`
            : side === 'BUY' ? `Buy ${usd(usdIn, usdIn % 1 ? 2 : 0)} of $${c.symbol}` : `Sell ${sellPct}% of $${c.symbol}`}
        </button>
        <p className="muted small center">Paper trade at the live price{c.updatedAt ? ` (updated ${ago(c.updatedAt)} ago)` : ''}. No real money moves.</p>
      </form>
    </div>
  );
}

function sig(n: number) { return n >= 1 ? n.toFixed(4) : n.toPrecision(4); }

export function ShareCard({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const nav = useNav();
  const s = userStats(st);
  const best = useMemo(() => {
    const rows = Object.values(st.user.positions).map((p) => ({ c: st.coins[p.coinId], r: st.coins[p.coinId] ? (p.qty * st.coins[p.coinId].price) / p.cost - 1 : 0 })).filter((x) => x.c);
    const sells = st.user.trades.filter((t) => t.side === 'SELL' && t.pnl !== undefined).map((t) => ({ c: st.coins[t.coinId], sym: t.symbol, r: t.pnl! / (t.usd - t.pnl!) }));
    const all = [...rows.map((x) => ({ sym: x.c.symbol, r: x.r })), ...sells.map((x) => ({ sym: x.sym, r: x.r }))];
    return all.sort((a, b) => b.r - a.r)[0];
  }, [s.equity, st.user.trades.length]);
  const text = `My BAGZ paper wallet: ${usd(s.equity)} (${pct(s.pnlPct, 2)}). Win rate ${s.sells ? s.winRate.toFixed(0) + '%' : 'n/a'}.${best ? ` Best play: $${best.sym} ${pct(best.r * 100, 0)}.` : ''}`;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet share" role="dialog" aria-modal="true" aria-label="Share PnL" onClick={(e) => e.stopPropagation()}>
        <div className={`pnl-card ${s.pnl >= 0 ? 'is-up' : 'is-down'}`}>
          <div className="row"><Wordmark /><span className="grow" /><span className="small">paper wallet</span></div>
          <b className="pnl-big num">{pct(s.pnlPct, 2)}</b>
          <span className="num">{signedUsd(s.pnl)} on {usd(st.user.deposits, 0)} deposited</span>
          <div className="pnl-row">
            <div><span>Value</span><b className="num">{compact(s.equity)}</b></div>
            <div><span>Win rate</span><b className="num">{s.sells ? s.winRate.toFixed(0) + '%' : '—'}</b></div>
            <div><span>Best</span><b className="num">{best ? `$${best.sym} ${pct(best.r * 100, 0)}` : '—'}</b></div>
          </div>
        </div>
        <div className="row gap-s">
          <button className="btn btn-accent grow" onClick={() => navigator.clipboard?.writeText(text).then(() => nav.toast('info', 'Copied to clipboard'), () => nav.toast('info', 'Copy blocked', text))}><Icon.copy size={16} /> Copy summary</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
