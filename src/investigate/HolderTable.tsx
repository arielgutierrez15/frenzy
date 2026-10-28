import React, { useMemo, useState } from 'react';
import type { Holder } from './types';
import { pctText, readableUnits, shortAddr } from './units';

type SortKey = 'rank' | 'accounts' | 'kind';

/** Accessible table alternative to the bubble map: every number in the map, sortable, each row selectable. */
export function HolderTable({ holders, decimals, selected, onSelect }: { holders: Holder[]; decimals: number; selected: string | null; onSelect: (owner: string) => void }) {
  const [sort, setSort] = useState<{ k: SortKey; asc: boolean }>({ k: 'rank', asc: true });
  const rows = useMemo(() => {
    const r = [...holders];
    const dir = sort.asc ? 1 : -1;
    r.sort((a, b) => {
      if (sort.k === 'accounts') return dir * (a.accounts.length - b.accounts.length) || a.rank - b.rank;
      if (sort.k === 'kind') return dir * a.ownerKind.label.localeCompare(b.ownerKind.label) || a.rank - b.rank;
      return dir * (a.rank - b.rank);
    });
    return r;
  }, [holders, sort]);
  const head = (k: SortKey, label: string, cls = '') => {
    const on = sort.k === k;
    return (
      <th scope="col" className={cls} aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
        <button className="inv-sort" onClick={() => setSort({ k, asc: on ? !sort.asc : true })}>{label}{on ? (sort.asc ? ' ▲' : ' ▼') : ''}</button>
      </th>
    );
  };
  return (
    <div className="table-wrap inv-table-wrap">
      <table className="mkt inv-table">
        <caption className="sr-only">Owners grouped from the largest token accounts. Balance is the sum of the listed token accounts only.</caption>
        <thead>
          <tr>
            {head('rank', 'Rank / balance')}
            <th scope="col">Owner</th>
            {head('kind', 'Address type')}
            <th scope="col" className="r">% of supply</th>
            {head('accounts', 'Accounts', 'r')}
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => {
            const amt = readableUnits(h.amount, decimals, 2);
            const isSel = selected === h.owner;
            return (
              <tr key={h.owner} className={isSel ? 'is-you' : ''} onClick={() => onSelect(h.owner)}>
                <td>
                  <button className="inv-rowbtn num" aria-pressed={isSel} onClick={(e) => { e.stopPropagation(); onSelect(h.owner); }} aria-label={`Select holder ${h.rank}, ${h.owner}`}>#{h.rank}</button>
                  <span className="num inv-bal" title={`${h.amount} raw units`}>{amt.text}{amt.truncated ? '…' : ''}</span>
                </td>
                <td className="num" title={h.owner}>{shortAddr(h.owner, 5)}</td>
                <td><span className={`tag ${h.ownerKind.kind === 'pda' || h.ownerKind.kind === 'program' ? 'tag-plain' : 'inv-tag'}`} title={h.ownerKind.detail}>{h.ownerKind.label}</span></td>
                <td className="r num">{pctText(h.percent, h.percentBelowDisplay)}</td>
                <td className="r num">{h.accounts.length}{h.accounts.some((a) => a.changedSinceRanking) ? <span className="warn" title="Balance changed between the ranking read and the balance read"> *</span> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
