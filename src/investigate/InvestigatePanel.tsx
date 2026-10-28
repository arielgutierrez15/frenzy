import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './investigate.css';
import type { Coin } from '../types';
import type { Holder, HoldersResponse, TokenEvent } from './types';
import { explain, InvestigateError, loadHolders, unavailableReason, type Loaded } from './api';
import { B58 } from './validate';
import { buildGraph } from './graph';
import { HolderMap } from './HolderMap';
import { HolderTable } from './HolderTable';
import { TransferFeed } from './TransferList';
import { MarketEvidence } from './MarketEvidence';
import { ixLabel, pctText, readableUnits, shortAddr } from './units';
import { Icon } from '../ui';
import { ago } from '../format';

/** once the user starts an investigation, later token pages load their holder snapshot by themselves (this session only) */
let sessionOn = false;
/** an answer older than this is labelled stale in the UI and a refresh is offered */
const STALE_AFTER_MS = 5 * 60_000;

function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg seg-sm" role="group" aria-label={label}>
      {options.map((o) => <button key={o.v} aria-pressed={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>)}
    </div>
  );
}

function StatusLine({ r, lastOkAt, loading, refreshError, onRefresh }: { r: Loaded<HoldersResponse>; lastOkAt?: number; loading: boolean; refreshError?: unknown; onRefresh: () => void }) {
  const d = r.data;
  const age = Date.now() - d.observedAt;
  const old = age > STALE_AFTER_MS;
  const err = refreshError ? explain(refreshError) : null;
  return (
    <div className="inv-status" role="status" aria-live="polite">
      <div className="row gap-s wrap small">
        <span className={`pill ${d.cache.stale || old ? 'pill-warn' : 'inv-pill'}`}>{d.cache.stale ? 'Stale snapshot' : old ? 'Old snapshot' : 'Snapshot'}</span>
        <span className="muted">{d.provider} · finalized</span>
        <span className="grow" />
        <button className="chip-btn" onClick={onRefresh} disabled={loading} aria-label="Refresh holder snapshot">{loading ? <><span className="spin" /> Refreshing</> : <><Icon.reset size={14} /> Refresh</>}</button>
      </div>
      <dl className="inv-facts small">
        <div><dt>Retrieved</dt><dd><time dateTime={d.retrievedAt}>{new Date(d.retrievedAt).toLocaleTimeString()}</time> ({ago(d.observedAt)} ago){d.cache.hit ? ` · from server cache` : ''}{r.fromClientCache ? ' · reused in this tab' : ''}</dd></div>
        <div><dt>Slots</dt><dd className="num">ranking {d.slots.ranking.toLocaleString()} · balances {d.slots.accounts.toLocaleString()}</dd></div>
        <div><dt>Coverage</dt><dd>{d.coverage.tokenAccountsReturned} largest token accounts → {d.coverage.ownerCount} owner{d.coverage.ownerCount === 1 ? '' : 's'}{d.coverage.includedPercent !== null ? ` · ${pctText(d.coverage.includedPercent)} of supply` : ''}</dd></div>
        <div><dt>Last successful refresh</dt><dd>{lastOkAt ? new Date(lastOkAt).toLocaleTimeString() : '—'}</dd></div>
      </dl>
      {d.cache.stale && <p className="banner banner-warn small"><Icon.warn size={16} />The Solana RPC failed on the latest try ({d.cache.staleReason}). This is the server’s earlier answer, {Math.round(d.cache.ageMs / 1000)} s old.</p>}
      {err && <p className="banner banner-warn small" role="alert"><Icon.warn size={16} /><span><b>Refresh failed: {err.title}.</b> {err.body} Showing the snapshot retrieved {new Date(d.retrievedAt).toLocaleTimeString()}.</span></p>}
      {(d.consistency.changedAccounts > 0 || d.excluded.length > 0 || d.coverage.ownersNote || d.token.decodingGaps.length > 0) && (
        <p className="banner banner-warn small"><Icon.warn size={16} /><span>Partial: {[
          d.consistency.changedAccounts > 0 ? d.consistency.note : '',
          d.excluded.length ? `${d.excluded.length} token account${d.excluded.length > 1 ? 's were' : ' was'} excluded (${[...new Set(d.excluded.map((x) => x.reason.replace(/_/g, ' ')))].join(', ')}).` : '',
          d.coverage.ownersNote || '',
          ...d.token.decodingGaps.map((g) => g.note),
        ].filter(Boolean).join(' ')}</span></p>
      )}
    </div>
  );
}

function WalletDetail({ mint, h, decimals, denomNote, rankOf, onEvents, onClose }: { mint: string; h: Holder; decimals: number; denomNote: string; rankOf: (o: string | null) => number | undefined; onEvents: (e: TokenEvent[]) => void; onClose: () => void }) {
  // the parent keys this component by owner, so a new holder always starts on its largest account
  const [acct, setAcct] = useState(h.accounts[0].address);
  const bal = readableUnits(h.amount, decimals, 4);
  const copy = () => { try { navigator.clipboard?.writeText(h.owner); } catch { /* blocked */ } };
  return (
    <div className="inv-wallet panel" aria-label={`Holder ${h.rank} details`}>
      <div className="row gap-s"><b>Holder #{h.rank}</b><span className={`tag ${h.ownerKind.kind === 'pda' || h.ownerKind.kind === 'program' ? 'tag-plain' : 'inv-tag'}`}>{h.ownerKind.label}</span><span className="grow" /><button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close holder details"><Icon.close size={16} /></button></div>
      <div className="inv-addr num" aria-label="Full owner address">{h.owner}</div>
      <div className="row gap-s wrap small">
        <button className="link" onClick={copy}><Icon.copy size={13} /> Copy</button>
        <a className="link" href={`https://solscan.io/account/${h.owner}`} target="_blank" rel="noopener noreferrer">Solscan <Icon.external size={12} /></a>
      </div>
      <p className="small muted">{h.ownerKind.detail}{h.ownerKind.programOwner && h.ownerKind.kind !== 'wallet' ? ` Account owner program: ${h.ownerKind.programOwnerLabel ? `${h.ownerKind.programOwnerLabel} (${shortAddr(h.ownerKind.programOwner)})` : shortAddr(h.ownerKind.programOwner)}.` : ''}</p>
      <dl className="inv-facts small">
        <div><dt>Included balance</dt><dd><b className="num inv-nowrap">{bal.text}{bal.truncated ? '…' : ''}</b><span className="muted num small inv-raw">raw {h.amount}</span></dd></div>
        <div><dt>Share</dt><dd className="num">{pctText(h.percent, h.percentBelowDisplay)} <span className="muted">(exact value {h.percent ?? 'n/a'}%, truncated)</span></dd></div>
      </dl>
      <p className="small muted">Counts only the token account{h.accounts.length > 1 ? 's' : ''} below, which were among the largest for this token. This owner can hold more in other token accounts. {denomNote}</p>
      <fieldset className="inv-accts">
        <legend className="small">Token account{h.accounts.length > 1 ? 's' : ''} in this snapshot</legend>
        {h.accounts.map((a) => {
          const v = readableUnits(a.amount, decimals, 4);
          return (
            <label key={a.address} className="inv-acct small">
              <input type="radio" name={`inv-acct-${h.owner}`} checked={acct === a.address} onChange={() => setAcct(a.address)} />
              <span className="num" title={a.address}>{shortAddr(a.address, 5)}</span>
              <span className="num">{v.text}{v.truncated ? '…' : ''}</span>
              {a.program === 'spl-token-2022' && <span className="tag tag-plain">Token-2022</span>}
              {a.state && a.state !== 'initialized' && <span className="tag tag-plain">{a.state}</span>}
              {a.changedSinceRanking && <span className="warn" title={`Ranked with raw ${a.rankingAmount}`}>changed since ranking</span>}
            </label>
          );
        })}
      </fieldset>
      <TransferFeed key={`${mint}|${acct}`} mint={mint} account={acct} rankOf={rankOf} onEvents={onEvents} />
    </div>
  );
}

/**
 * Investigate section of a token page. Solana only. Read-only evidence from the BAGZ Worker; never demo data.
 */
export function InvestigatePanel({ c, onShowChart }: { c: Coin; onShowChart?: () => void }) {
  const mint = c.address;
  const [on, setOn] = useState(sessionOn);
  const [tab, setTab] = useState<'holders' | 'market'>('holders');
  const [view, setView] = useState<'map' | 'table'>('map');
  const [h, setH] = useState<{ mint: string; r?: Loaded<HoldersResponse>; error?: unknown; loading: boolean; lastOkAt?: number }>({ mint, loading: false });
  const [sel, setSel] = useState<string | null>(null);
  const [edgeSel, setEdgeSel] = useState<string | null>(null);
  const [evs, setEvs] = useState<{ mint: string; map: Map<string, TokenEvent> }>({ mint, map: new Map() });
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const gate = c.chain !== 'solana' ? null : unavailableReason();
  const validMint = B58.test(mint);

  const fetchHolders = useCallback((force: boolean) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const my = ++seq.current;
    setH((p) => (p.mint === mint ? { ...p, loading: true, error: undefined } : { mint, loading: true }));
    loadHolders(mint, { signal: ac.signal, force }).then((r) => {
      // a late answer for a previous token never replaces the current one
      if (my !== seq.current || r.data.mint !== mint) return;
      setH({ mint, r, loading: false, lastOkAt: r.receivedAt });
    }, (e) => {
      if (my !== seq.current || (e instanceof InvestigateError && e.code === 'aborted')) return;
      setH((p) => (p.mint === mint ? { ...p, loading: false, error: e } : { mint, loading: false, error: e }));
    });
  }, [mint]);

  useEffect(() => {
    setSel(null); setEdgeSel(null); setEvs({ mint, map: new Map() }); setH({ mint, loading: false });
    if (on && c.chain === 'solana' && !gate && validMint) fetchHolders(false);
    return () => { seq.current++; ctrl.current?.abort(); };
  }, [mint, on]);

  const cur = h.mint === mint ? h : { mint, loading: false } as typeof h;
  const data = cur.r?.data;
  const holders = data?.holders || [];
  const rank = useMemo(() => new Map(holders.map((x) => [x.owner, x.rank])), [data]);
  const rankOf = useCallback((o: string | null) => (o ? rank.get(o) : undefined), [rank]);
  const addEvents = useCallback((list: TokenEvent[]) => {
    setEvs((p) => {
      if (p.mint !== mint) return p;
      const map = new Map(p.map);
      for (const e of list) map.set(`${e.signature}#${e.path}`, e);
      return { mint, map };
    });
  }, [mint]);
  const graph = useMemo(() => buildGraph(holders, evs.mint === mint ? [...evs.map.values()] : []), [data, evs, mint]);
  const selected = holders.find((x) => x.owner === sel) || null;
  const edge = graph.edges.find((e) => e.id === edgeSel) || null;
  const decimals = data?.token.decimals ?? 0;

  const intro = <p className="muted small">On-chain evidence for this token, read from Solana through the BAGZ server: who holds the largest token accounts, and the transfers you choose to load. Facts only: no safety score, no guesses about who owns what.</p>;
  let body: React.ReactNode;
  if (c.chain !== 'solana') {
    body = <p className="banner banner-warn small" role="status"><Icon.warn size={16} />Investigate supports Solana tokens only. This coin is on {c.chain}, so no holder or transfer evidence is shown.</p>;
  } else if (gate) {
    const x = explain(gate);
    body = <p className="banner banner-warn small" role="status"><Icon.warn size={16} /><span><b>{x.title}.</b> {x.body}</span></p>;
  } else if (!validMint) {
    body = <p className="banner banner-warn small" role="alert"><Icon.warn size={16} />This coin’s address ({c.address}) is not a valid Solana mint address, so it can’t be investigated.</p>;
  } else if (!on) {
    body = (
      <div className="inv-start">
        <button className="btn btn-soft" onClick={() => { sessionOn = true; setOn(true); }}>Load holder map</button>
        <p className="muted small">Reads the {20} largest token accounts of <span className="num">{shortAddr(mint)}</span> and their owners (three read-only RPC calls through the BAGZ server). Transfer history loads only for a holder you select.</p>
      </div>
    );
  } else {
    const err = cur.error && !data ? explain(cur.error) : null;
    body = (
      <>
        <Tabs label="Investigate view" value={tab} onChange={setTab} options={[{ v: 'holders', l: 'Holders' }, { v: 'market', l: 'Market' }]} />
        {tab === 'market' ? <MarketEvidence c={c} onShowChart={onShowChart} /> : (
          <>
            {!data && cur.loading && <p className="muted small" role="status"><span className="spin" /> Reading the largest token accounts for this mint…</p>}
            {err && <div className="banner banner-warn small" role="alert"><Icon.warn size={16} /><span><b>{err.title}.</b> {err.body}</span>{err.retry && <button className="chip-btn" onClick={() => fetchHolders(true)}>Retry</button>}</div>}
            {data && cur.r && (
              <>
                <StatusLine r={cur.r} lastOkAt={cur.lastOkAt} loading={cur.loading} refreshError={cur.error} onRefresh={() => fetchHolders(true)} />
                <p className="inv-scope small"><b>Scope:</b> {data.coverage.description}</p>
                {data.denominator.kind !== 'token_supply' && <p className="banner banner-warn small"><Icon.warn size={16} />{data.denominator.note}</p>}
                {holders.length === 0 ? <p className="muted small">The RPC returned no token accounts with this mint, so there is nothing to map.</p> : (
                  <>
                    <div className="row gap-s wrap">
                      <Tabs label="Holder view" value={view} onChange={setView} options={[{ v: 'map', l: 'Bubble map' }, { v: 'table', l: 'Table' }]} />
                      <span className="grow" />
                      <span className="small muted">{graph.walletEdges} wallet link{graph.walletEdges === 1 ? '' : 's'} · {graph.accountLinks} unresolved link{graph.accountLinks === 1 ? '' : 's'} from loaded transfers</span>
                    </div>
                    {view === 'map'
                      ? <HolderMap holders={holders} decimals={decimals} graph={graph} selected={sel} onSelect={(o) => { setSel(o); setEdgeSel(null); }} selectedEdge={edgeSel} onSelectEdge={setEdgeSel} />
                      : <HolderTable holders={holders} decimals={decimals} selected={sel} onSelect={(o) => { setSel(o); setEdgeSel(null); }} />}
                    <p className="small muted">{data.connectionStatus} Lines are evidence of token movement only — not of common ownership, insiders, developers or wrongdoing. Shared-funder analysis is not part of this version.</p>
                    {edge && (
                      <div className="inv-edgebox panel" aria-label="Transfers on the selected line">
                        <div className="row gap-s"><b>{edge.events.length} transfer{edge.events.length > 1 ? 's' : ''} on this line</b><span className="grow" /><button className="icon-btn icon-btn-sm" onClick={() => setEdgeSel(null)} aria-label="Close line details"><Icon.close size={16} /></button></div>
                        <p className="small muted">{edge.evidence === 'account' ? 'One side is a token account whose owner was not resolved; this is not a wallet connection.' : 'Both owners were resolved from each transaction’s token balances.'} {edge.context !== 'top_level' ? 'Some transfers ran inside another program (for example a swap), so they are not necessarily direct payments.' : ''}</p>
                        <ul className="inv-edgelist small">
                          {edge.events.map((e) => {
                            const v = readableUnits(e.amount, decimals, 4);
                            return (
                              <li key={`${e.signature}#${e.path}`}>
                                <span className="num">{v.text}{v.truncated ? '…' : ''}</span> <span className="muted num">raw {e.amount}</span>
                                {' · '}{e.blockTime !== null ? new Date(e.blockTime * 1000).toLocaleString() : 'time not reported'}
                                {' · '}<a className="link num" href={`https://solscan.io/tx/${e.signature}`} target="_blank" rel="noopener noreferrer">{shortAddr(e.signature, 5)} {ixLabel(e.outerIndex, e.innerIndex)}</a>
                                {' · '}{e.context === 'top_level' ? 'top-level' : `inside ${e.outerProgramLabel || shortAddr(e.outerProgramId || '')}`}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                    {selected ? (
                      <WalletDetail key={`${mint}|${selected.owner}`} mint={mint} h={selected} decimals={decimals} denomNote={data.denominator.note} rankOf={rankOf} onEvents={addEvents} onClose={() => setSel(null)} />
                    ) : <p className="muted small">Select a holder to see its full address, its token accounts and a sample of recent transfers.</p>}
                  </>
                )}
              </>
            )}
          </>
        )}
      </>
    );
  }
  return (
    <section className="cv-sec inv" aria-labelledby="inv-h" data-testid="investigate">
      <div className="row gap-s"><h2 id="inv-h" className="cv-h">Investigate</h2><span className="tag tag-plain">Read-only</span></div>
      {intro}
      {body}
      {c.chain === 'solana' && (
        <details className="inv-method small muted">
          <summary>Method, coverage and what isn’t included yet</summary>
          <ul>
            <li>Holders: the RPC’s largest token accounts for this mint (at most 20, finalized), grouped by owner with exact integer sums. Balances and supply are read together at one slot; the ranking slot is shown separately.</li>
            <li>Address types come from facts only: off-curve addresses are program-controlled; on-curve system accounts are key-pair wallets. No address is named or attributed to a person, team or developer.</li>
            <li>Transfers: up to 10 recent finalized signatures per page for the selected token account; failed transactions are skipped; only decoded SPL Token instructions are listed, with their instruction numbers.</li>
            <li>Lines appear only for transfers you loaded. A line is not evidence of common ownership, insider status or wrongdoing.</li>
            <li>Not included yet: full transfer history, a complete wallet ranking, creator attribution, shared-funder analysis, related launches, historical ownership and market-wide statistics.</li>
          </ul>
        </details>
      )}
    </section>
  );
}
