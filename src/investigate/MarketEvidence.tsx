import React, { useEffect, useState } from 'react';
import type { Coin } from '../types';
import { getJSON } from '../engine';
import { getState } from '../store';
import { parseGtPools } from '../providers/adapters';
import { poolActivity, type PoolActivity } from './market';
import { shortAddr } from './units';
import { ago, compact } from '../format';
import { Icon } from '../ui';

const n = (x: number | undefined) => (x === undefined ? 'unavailable' : x.toLocaleString());

/**
 * Pool-specific market context, next to the holder evidence. The candlesticks, volume bars and timeframe controls are
 * the page's existing chart (same pool), reused in place rather than drawn twice. Here: the chart pool's identity and
 * GeckoTerminal's buy/sell transaction counts per window, only when GeckoTerminal supplies them.
 */
export function MarketEvidence({ c, onShowChart }: { c: Coin; onShowChart?: () => void }) {
  const [s, setS] = useState<{ pool?: string; data?: PoolActivity | null; at?: number; stale?: boolean; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    const pool = c.pairAddress;
    if (!pool) { setS({ loading: false }); return; }
    setS({ pool, loading: true });
    // same request (and cache) BAGZ uses to find the chart pool, so this usually costs no extra call
    getJSON(getState(), 'gt-pools', `/networks/solana/tokens/${c.address}/pools?page=1`, { validate: parseGtPools, prio: 1 }).then((list) => {
      if (!alive) return;
      const src = getState().sources['gt-pools'];
      if (!list) { setS({ pool, loading: false, error: src?.error || 'GeckoTerminal did not answer' }); return; }
      setS({ pool, loading: false, data: poolActivity(list, pool, c.address), at: src?.at, stale: !!src?.stale });
    });
    return () => { alive = false; };
  }, [c.address, c.pairAddress]);

  if (!c.pairAddress) return <p className="muted small">No trading pool is known for this coin yet, so there are no pool candles or transaction counts.</p>;
  const d = s.pool === c.pairAddress ? s.data : undefined;
  return (
    <div className="inv-market">
      <div className="row gap-s wrap">
        <span className="small">Chart pool <a className="link num" href={`https://www.geckoterminal.com/solana/pools/${c.pairAddress}`} target="_blank" rel="noopener noreferrer" title={c.pairAddress}>{shortAddr(c.pairAddress)}</a>{d?.name ? <span className="muted"> · {d.name}</span> : null}{d?.dex || c.dexId ? <span className="muted"> · {d?.dex || c.dexId}</span> : null}</span>
        <span className="grow" />
        {onShowChart && <button className="chip-btn" onClick={onShowChart}>Candles &amp; volume ↑</button>}
      </div>
      <p className="muted small">Candlesticks, volume and timeframe controls for this pool are the chart at the top of the page.</p>
      {s.loading && <p className="muted small"><span className="spin" /> Loading the pool record from GeckoTerminal…</p>}
      {s.error && <p className="banner banner-warn small" role="alert"><Icon.warn size={16} />Pool activity unavailable: {s.error}</p>}
      {!s.loading && !s.error && d === null && <p className="muted small">GeckoTerminal’s pool list for this token doesn’t include the chart pool, so transaction counts are unavailable. Counts from other pools are not substituted.</p>}
      {d && (
        <>
          {!d.baseMatches && <p className="banner banner-warn small"><Icon.warn size={16} />GeckoTerminal does not list ${c.symbol} as this pool’s base token, so its buy/sell counts may describe the other side of the pool.</p>}
          {d.hasCounts ? (
            <figure className="inv-txbars" aria-label="Buy and sell transaction counts by time window">
              <figcaption className="small"><b>Swap transactions in this pool</b> <span className="muted">(buy/sell split per window; counts, not volume; GeckoTerminal’s classification)</span></figcaption>
              <div className="inv-txkey small muted"><span><i className="dot-b" />Buys</span><span><i className="dot-s" />Sells</span></div>
              {d.windows.map((w) => {
                const b = w.buys, sl = w.sells;
                const both = b !== undefined && sl !== undefined;
                const tot = (b ?? 0) + (sl ?? 0);
                return (
                  <div key={w.id} className="inv-txrow">
                    <span className="inv-txw num">{w.label}</span>
                    {!both ? <span className="muted small">{b === undefined && sl === undefined ? 'unavailable' : 'partly unavailable'}</span> : (
                      // each row shows that window's buy/sell split; the counts themselves are printed beside it
                      <span className="inv-txbar" role="img" aria-label={`${w.label}: ${n(b)} buys, ${n(sl)} sells${w.buyers !== undefined ? `, ${w.buyers} buyers, ${w.sellers ?? 'unknown'} sellers` : ''}`}>
                        <span className="inv-txb" style={{ width: `${tot ? (b! / tot) * 100 : 0}%` }} />
                        <span className="inv-txs" style={{ width: `${tot ? (sl! / tot) * 100 : 0}%` }} />
                      </span>
                    )}
                    <span className="num small inv-txn">{b === undefined && sl === undefined ? '—' : `${n(b)} / ${n(sl)}`}</span>
                    <span className="num small muted inv-txv">{w.volumeUsd === undefined ? 'vol n/a' : `${compact(w.volumeUsd)} vol`}</span>
                  </div>
                );
              })}
            </figure>
          ) : <p className="muted small">GeckoTerminal did not supply buy/sell transaction counts for this pool. They are shown as unavailable, not as zero.</p>}
          <p className="muted small">
            Reported pool reserve: {d.reserveUsd === undefined ? 'unavailable' : compact(d.reserveUsd)} (GeckoTerminal’s USD valuation of the pool’s tokens; not executable depth).
            {d.quoteMint ? <> Quote token <span className="num">{shortAddr(d.quoteMint)}</span>.</> : null}
            {d.otherPools > 0 ? ` ${d.otherPools} other pool${d.otherPools > 1 ? 's' : ''} for this token are not added in.` : ''}
            {' '}Volume and counts are provider-reported activity, not verified organic flow.
          </p>
          <p className="muted small">GeckoTerminal · {s.stale ? 'STALE · last good fetch ' : 'fetched '}{s.at ? `${ago(s.at)} ago` : 'time unknown'}</p>
        </>
      )}
    </div>
  );
}
