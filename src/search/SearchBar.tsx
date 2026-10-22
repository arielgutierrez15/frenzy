/**
 * Global search at the top of every screen: coins (name, $symbol or contract address), BAGZ users (@username, with
 * their profile picture) and on-chain wallets (paste an address to open that trader). Coins already in BAGZ match
 * instantly; Jupiter is asked for the rest. Nothing is invented: if a source doesn't answer, that section says so.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNav } from '../nav';
import { getState, emit, useStore } from '../store';
import { searchTokens, short } from '../engine';
import { Avatar, CoinBadge, Icon } from '../ui';
import { compact, pct } from '../format';
import { haptic } from '../telegram';
import { useSession } from '../social/session';
import { UserAvatar } from '../social/ui';
import * as api from '../social/api';
import type { Coin } from '../types';
import type { UserSummary } from '../social/api';

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const USERNAME_Q = /^[a-z0-9_]{2,20}$/;

type Item =
  | { kind: 'coin'; key: string; coin: Coin }
  | { kind: 'user'; key: string; user: UserSummary }
  | { kind: 'wallet'; key: string; address: string; known: boolean };

/** local coin matches: exact address first, then symbol, then name */
function localCoins(coins: Record<string, Coin>, q: string): Coin[] {
  const s = q.toLowerCase().replace(/^\$/, '');
  if (!s) return [];
  const scored: { c: Coin; r: number }[] = [];
  for (const c of Object.values(coins)) {
    const sym = c.symbol.toLowerCase(), name = c.name.toLowerCase(), addr = c.address.toLowerCase();
    let r = 0;
    if (addr === s) r = 100;
    else if (sym === s) r = 80;
    else if (sym.startsWith(s)) r = 60;
    else if (name.startsWith(s)) r = 50;
    else if (s.length >= 3 && (sym.includes(s) || name.includes(s))) r = 30;
    else if (s.length >= 6 && addr.startsWith(s)) r = 25;
    if (r) scored.push({ c, r: r + Math.min(19, Math.log10(1 + (c.vol24 || 0) + (c.mcap || 0))) - (c.rugged ? 40 : 0) });
  }
  return scored.sort((a, b) => b.r - a.r).slice(0, 6).map((x) => x.c);
}

export function SearchBar() {
  const st = useStore();
  const nav = useNav();
  const ses = useSession();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [remote, setRemote] = useState<{ q: string; ids: string[]; done: boolean; failed: boolean }>({ q: '', ids: [], done: true, failed: false });
  const [users, setUsers] = useState<{ q: string; list: UserSummary[]; done: boolean; failed: boolean }>({ q: '', list: [], done: true, failed: false });
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = q.trim();
  const isAddr = SOL_ADDR.test(query) || EVM_ADDR.test(query);
  const userQ = query.replace(/^@/, '').toLowerCase();
  const wantsUsers = ses.status === 'ready' && USERNAME_Q.test(userQ) && !isAddr;
  const wantsCoins = !query.startsWith('@');

  // Jupiter search for coins BAGZ hasn't seen yet (Solana names, symbols and mints)
  useEffect(() => {
    if (!wantsCoins || query.length < 2 || EVM_ADDR.test(query)) { setRemote({ q: query, ids: [], done: true, failed: false }); return; }
    let live = true;
    setRemote((r) => ({ q: query, ids: r.q === query ? r.ids : [], done: false, failed: false }));
    const t = setTimeout(() => {
      searchTokens(getState(), query).then(
        (ids) => { if (!live) return; emit(); setRemote({ q: query, ids, done: true, failed: false }); },
        () => live && setRemote({ q: query, ids: [], done: true, failed: true }),
      );
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [query, wantsCoins]);

  // BAGZ users by username
  useEffect(() => {
    if (!wantsUsers) { setUsers({ q: userQ, list: [], done: true, failed: false }); return; }
    let live = true;
    setUsers((u) => ({ ...u, q: userQ, done: false }));
    const t = setTimeout(() => {
      api.searchUsers(userQ).then(
        (r) => live && setUsers({ q: userQ, list: r.users.slice(0, 5), done: true, failed: false }),
        () => live && setUsers({ q: userQ, list: [], done: true, failed: true }),
      );
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [userQ, wantsUsers]);

  const items: Item[] = useMemo(() => {
    if (!query) return [];
    const out: Item[] = [];
    if (wantsCoins) {
      const seen = new Set<string>();
      const coins = [...localCoins(st.coins, query), ...remote.ids.map((id) => st.coins[id]).filter(Boolean)];
      for (const c of coins) { if (seen.has(c.id) || seen.size >= 6) continue; seen.add(c.id); out.push({ kind: 'coin', key: 'c' + c.id, coin: c }); }
    }
    for (const u of users.list) out.push({ kind: 'user', key: 'u' + u.id, user: u });
    if (isAddr) {
      const known = !!st.wallets[query] || !!st.wallets[query.toLowerCase()];
      const isCoin = out.some((x) => x.kind === 'coin' && x.coin.address.toLowerCase() === query.toLowerCase());
      if (!isCoin || known) out.push({ kind: 'wallet', key: 'w' + query, address: st.wallets[query] ? query : st.wallets[query.toLowerCase()] ? query.toLowerCase() : query, known });
    }
    // on-chain wallets BAGZ has seen trading, by the start of their address
    if (!isAddr && query.length >= 4 && /^[1-9A-HJ-NP-Za-km-z]+$|^0x[0-9a-fA-F]+$/.test(query)) {
      const qs = query.toLowerCase();
      Object.keys(st.wallets).filter((a) => a.toLowerCase().startsWith(qs)).slice(0, 3).forEach((a) => out.push({ kind: 'wallet', key: 'w' + a, address: a, known: true }));
    }
    return out;
  }, [query, st, remote.ids, users.list, isAddr, wantsCoins]);

  useEffect(() => { setHi(0); }, [query]);

  // close when tapping outside; "/" focuses the bar on desktop
  useEffect(() => {
    const down = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '/' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) { e.preventDefault(); inputRef.current?.focus(); setOpen(true); }
    };
    document.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key); };
  }, []);

  const pick = (it: Item) => {
    haptic.tap();
    setOpen(false); setQ(''); inputRef.current?.blur();
    if (it.kind === 'coin') nav.openCoin(it.coin.id);
    else if (it.kind === 'user') nav.openUser(it.user.username);
    else nav.openTrader(it.address);
  };

  const onKey = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => (h + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.min(hi, items.length - 1)]); }
  };

  const coinItems = items.filter((x) => x.kind === 'coin') as Extract<Item, { kind: 'coin' }>[];
  const userItems = items.filter((x) => x.kind === 'user') as Extract<Item, { kind: 'user' }>[];
  const walletItems = items.filter((x) => x.kind === 'wallet') as Extract<Item, { kind: 'wallet' }>[];
  const idx = (it: Item) => items.indexOf(it);
  const searching = (!remote.done && remote.q === query) || (!users.done && wantsUsers);
  const showPanel = open && query.length > 0;

  const row = (it: Item, body: React.ReactNode) => (
    <li key={it.key} role="option" aria-selected={idx(it) === hi} id={`srch-${idx(it)}`}>
      <button type="button" className={`bare srch-row${idx(it) === hi ? ' on' : ''}`} onMouseEnter={() => setHi(idx(it))} onClick={() => pick(it)}>{body}</button>
    </li>
  );

  return (
    <div className="srch" ref={boxRef}>
      <label className="srch-field">
        <Icon.search size={18} />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder="Search coins, contract address, @users, wallets"
          aria-label="Search coins, addresses, users and wallets"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="srch-list"
          aria-activedescendant={showPanel && items.length ? `srch-${hi}` : undefined}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search"
        />
        {searching && <span className="spinner srch-spin" aria-hidden="true" />}
        {q && <button type="button" className="icon-btn icon-btn-sm" aria-label="Clear search" onClick={() => { setQ(''); inputRef.current?.focus(); }}><Icon.close size={16} /></button>}
        <kbd className="srch-kbd" aria-hidden="true">/</kbd>
      </label>

      {showPanel && (
        <div className="srch-panel" role="listbox" id="srch-list" aria-label="Search results">
          {coinItems.length > 0 && (
            <section>
              <h3 className="eyebrow">Coins</h3>
              <ul>
                {coinItems.map((it) => row(it, <>
                  <CoinBadge coin={it.coin} size={34} />
                  <span className="stack grow srch-main"><b>${it.coin.symbol} <span className="muted srch-name">{it.coin.name}</span></b><span className="muted small num">{short(it.coin.address)} · {it.coin.chain}</span></span>
                  <span className="stack r">
                    <span className="num small">{it.coin.mcap ? compact(it.coin.mcap) : '—'}</span>
                    {it.coin.change.h24 !== undefined && <span className={`num small ${it.coin.change.h24 >= 0 ? 'up' : 'down'}`}>{pct(it.coin.change.h24, Math.abs(it.coin.change.h24) < 10 ? 1 : 0)}</span>}
                  </span>
                </>))}
              </ul>
            </section>
          )}
          {userItems.length > 0 && (
            <section>
              <h3 className="eyebrow">BAGZ users</h3>
              <ul>
                {userItems.map((it) => row(it, <>
                  <UserAvatar u={it.user} size={34} />
                  <span className="stack grow srch-main"><b>@{it.user.username}</b><span className="muted small">Public profile</span></span>
                  <Icon.chevron size={16} />
                </>))}
              </ul>
            </section>
          )}
          {walletItems.length > 0 && (
            <section>
              <h3 className="eyebrow">Wallets</h3>
              <ul>
                {walletItems.map((it) => row(it, <>
                  <Avatar wallet={it.address} size={34} />
                  <span className="stack grow srch-main"><b className="num">{short(it.address)}</b><span className="muted small">{it.known ? `${(st.wallets[it.address]?.buys || 0) + (st.wallets[it.address]?.sells || 0)} swaps seen on BAGZ` : 'Open this wallet'}</span></span>
                  <Icon.chevron size={16} />
                </>))}
              </ul>
            </section>
          )}
          {!items.length && (searching
            ? <p className="muted small srch-note">Searching…</p>
            : <p className="muted small srch-note">{query.startsWith('@') ? (ses.status === 'ready' ? `No BAGZ users start with “${userQ}”.` : 'User search needs the BAGZ server, which isn’t connected.') : `Nothing matches “${query}”. Try a $symbol, a contract address or an @username.`}</p>)}
          {remote.failed && wantsCoins && <p className="muted small srch-note">Jupiter didn’t answer, so only coins already in BAGZ are shown.</p>}
          {users.failed && wantsUsers && <p className="muted small srch-note">User search is unavailable right now.</p>}
          {EVM_ADDR.test(query) && !coinItems.length && <p className="muted small srch-note">Ethereum, Base and BSC tokens show up here once BAGZ has seen them on the radar.</p>}
        </div>
      )}
    </div>
  );
}
