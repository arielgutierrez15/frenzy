import React, { useEffect, useRef, useState } from 'react';
import type { ActivityResponse, TokenEvent } from './types';
import { explain, InvestigateError, loadActivity, type Loaded } from './api';
import { ixLabel, readableUnits, shortAddr } from './units';
import { Icon } from '../ui';
import { ago } from '../format';

const solscanTx = (s: string) => `https://solscan.io/tx/${s}`;
const solscanAcct = (a: string) => `https://solscan.io/account/${a}`;

function Party({ owner, account, note, holderRank, label }: { owner: string | null; account: string | null; note: string | null; holderRank?: number; label: string }) {
  if (!account && note === 'minted') return <span className="muted">{label} new supply (mint)</span>;
  if (!account && note === 'burned') return <span className="muted">{label} burn</span>;
  if (owner) {
    return (
      <span>{label} <a className="link num" href={solscanAcct(owner)} target="_blank" rel="noopener noreferrer" title={owner}>{shortAddr(owner)}</a>{holderRank ? <span className="tag inv-tag">holder #{holderRank}</span> : null}</span>
    );
  }
  return (
    <span>{label} <span className="inv-unknown">unknown token account</span> {account ? <a className="link num" href={solscanAcct(account)} target="_blank" rel="noopener noreferrer" title={account}>{shortAddr(account)}</a> : null}
      <span className="muted small"> ({note === 'owner_changed_in_transaction' ? 'owner changed in this transaction' : 'owner not in the transaction’s token balances'})</span></span>
  );
}

function EventRow({ e, decimals, rankOf }: { e: TokenEvent; decimals: number | null; rankOf: (o: string | null) => number | undefined }) {
  const amt = decimals === null ? null : readableUnits(e.amount, decimals, 4);
  const when = e.blockTime !== null ? new Date(e.blockTime * 1000) : null;
  const dirLabel = e.direction === 'in' ? 'IN' : e.direction === 'out' ? 'OUT' : 'SELF';
  return (
    <li className="inv-ev">
      <div className="row gap-s wrap">
        <span className={`inv-dir inv-dir-${e.direction}`} aria-label={e.direction === 'in' ? 'Received' : e.direction === 'out' ? 'Sent' : 'Sent to itself'}>{e.direction === 'in' ? '↓' : e.direction === 'out' ? '↑' : '↺'} {dirLabel}</span>
        {e.kind !== 'transfer' && <span className="tag tag-plain">{e.kind}</span>}
        <b className="num">{amt ? `${amt.text}${amt.truncated ? '…' : ''}` : 'amount (decimals unknown)'}</b>
        <span className="muted small num" title="Raw integer amount in the token’s smallest unit">raw {e.amount}</span>
        {e.feeAmount && <span className="muted small num">transfer fee raw {e.feeAmount}</span>}
      </div>
      <div className="small">
        {e.direction === 'in'
          ? <Party label="from" owner={e.sourceOwner} account={e.sourceAccount} note={e.sourceOwnerNote} holderRank={rankOf(e.sourceOwner)} />
          : e.direction === 'out'
            ? <Party label="to" owner={e.destinationOwner} account={e.destinationAccount} note={e.destinationOwnerNote} holderRank={rankOf(e.destinationOwner)} />
            : <span className="muted">between this account and itself</span>}
      </div>
      <div className="small muted row gap-s wrap inv-ev-meta">
        <span>{when ? <time dateTime={when.toISOString()} title={when.toISOString()}>{when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time> : 'time not reported'}</span>
        <span className="num">slot {e.slot ?? 'unknown'}</span>
        <a className="link num" href={solscanTx(e.signature)} target="_blank" rel="noopener noreferrer" aria-label={`Transaction ${e.signature} on Solscan, instruction ${ixLabel(e.outerIndex, e.innerIndex)}`}>tx {shortAddr(e.signature, 5)} · {ixLabel(e.outerIndex, e.innerIndex)} <Icon.external size={11} /></a>
        <span>{e.context === 'top_level' ? 'top-level instruction' : `inside ${e.outerProgramLabel || (e.outerProgramId ? shortAddr(e.outerProgramId) : 'another program')}${e.invokedBy && e.invokedBy !== e.outerProgramId ? ` → ${e.invokedByLabel || shortAddr(e.invokedBy)}` : ''}`}</span>
      </div>
      <details className="inv-why small muted"><summary>What this shows</summary><p>{e.interpretation} Instruction numbers are 1-based, as explorers show them.</p></details>
    </li>
  );
}

/**
 * Recent token transfers of ONE token account, loaded on demand, 10 signatures per page. Successful transactions only.
 * Events from every loaded page are passed up (onEvents) so the map can draw verified transfer lines.
 */
export function TransferFeed({ mint, account, rankOf, onEvents }: { mint: string; account: string; rankOf: (o: string | null) => number | undefined; onEvents: (evs: TokenEvent[]) => void }) {
  const [pages, setPages] = useState<Loaded<ActivityResponse>[]>([]);
  const [state, setState] = useState<{ loading: boolean; error?: unknown; lastOkAt?: number }>({ loading: true });
  const ctrl = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const lastAsk = useRef<string | null>(null);

  const fetchPage = (before: string | null, force = false) => {
    lastAsk.current = before;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    loadActivity(mint, account, { signal: c.signal, before, force }).then((r) => {
      if (!alive.current || c.signal.aborted || r.data.account !== account || r.data.mint !== mint) return;
      setPages((p) => (before ? [...p.filter((x) => x.data.coverage.before !== before), r] : [r]));
      setState({ loading: false, lastOkAt: r.receivedAt });
      onEvents(r.data.transfers);
    }, (e) => {
      if (!alive.current || (e instanceof InvestigateError && e.code === 'aborted')) return;
      setState((s) => ({ ...s, loading: false, error: e }));
    });
  };
  useEffect(() => { alive.current = true; setPages([]); fetchPage(null); return () => { alive.current = false; ctrl.current?.abort(); }; }, [mint, account]);

  const first = pages[0]?.data;
  const last = pages[pages.length - 1]?.data;
  const events = pages.flatMap((p) => p.data.transfers);
  const decimals = first?.tokenAccount.decimals ?? null;
  const cov = pages.map((p) => p.data.coverage);
  const sum = (k: keyof ActivityResponse['coverage']) => cov.reduce((a, c) => a + (Number(c[k]) || 0), 0);
  const partial = cov.some((c) => !c.complete || c.missingTransactionBodies > 0 || c.transactionFetchErrors > 0);
  const err = state.error ? explain(state.error) : null;
  const stale = pages.some((p) => p.data.cache.stale);

  return (
    <div className="inv-feed" aria-busy={state.loading}>
      <div className="row gap-s wrap small inv-feed-head">
        <b>Recent transfers</b>
        <span className="muted">of token account <a className="link num" href={solscanAcct(account)} target="_blank" rel="noopener noreferrer" title={account}>{shortAddr(account)}</a></span>
        <span className="grow" />
        <button className="chip-btn" onClick={() => fetchPage(null, true)} disabled={state.loading}>{state.loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {first && (
        <p className="small muted inv-cov" role="status">
          Snapshot · {first.provider} · finalized · retrieved {new Date(first.retrievedAt).toLocaleTimeString()} ({ago(first.observedAt)} ago){first.cache.hit ? ` · server cache ${Math.round(first.cache.ageMs / 1000)}s old` : ''}.
          {' '}Scanned {sum('signaturesReturned')} signature{sum('signaturesReturned') === 1 ? '' : 's'}: {sum('successfulSignatures')} successful, {sum('failedSignaturesSkipped')} failed (skipped); {sum('transactionsParsed')} transaction{sum('transactionsParsed') === 1 ? '' : 's'} read; {events.length} event{events.length === 1 ? '' : 's'} for this account.
          {first.slots.newestSignature !== null && <> Slots {last?.slots.oldestSignature ?? '?'}–{first.slots.newestSignature}.</>}
        </p>
      )}
      {stale && <p className="banner banner-warn small" role="status"><Icon.warn size={16} />The Solana RPC failed just now, so this is an earlier answer from the server’s cache ({pages.find((p) => p.data.cache.stale)?.data.cache.staleReason}).</p>}
      {partial && <p className="banner banner-warn small"><Icon.warn size={16} />Partial sample: {sum('missingTransactionBodies')} transaction bod{sum('missingTransactionBodies') === 1 ? 'y was' : 'ies were'} missing, {sum('transactionFetchErrors')} could not be read{cov.some((c) => c.haltedBy) ? ', and reading stopped early because of rate limits' : ''}. Events in those transactions are not shown.</p>}
      {err && (
        <div className="banner banner-warn small" role="alert"><Icon.warn size={16} /><span><b>{err.title}.</b> {err.body}{pages.length ? ' Earlier results stay below.' : ''}</span>{err.retry && <button className="chip-btn" onClick={() => fetchPage(lastAsk.current, true)}>Retry</button>}</div>
      )}
      {!first && state.loading && <p className="muted small"><span className="spin" /> Loading the 10 most recent signatures for this token account…</p>}
      {first && events.length === 0 && !state.loading && <p className="muted small">No token transfers of this mint involving this account in the scanned signatures.{last?.coverage.nextBefore ? ' Older signatures may have some.' : ''}</p>}
      {events.length > 0 && <ol className="inv-events">{events.map((e) => <EventRow key={`${e.signature}#${e.path}`} e={e} decimals={decimals} rankOf={rankOf} />)}</ol>}
      {last?.coverage.nextBefore && (
        <button className="btn btn-ghost btn-sm inv-more" disabled={state.loading} onClick={() => fetchPage(last.coverage.nextBefore)}>Load 10 older signatures</button>
      )}
      {first && !last?.coverage.nextBefore && !state.loading && <p className="muted small">That is every signature the RPC returned for this account at finalized commitment.</p>}
      {first && <p className="muted small">{first.coverage.description}</p>}
    </div>
  );
}
