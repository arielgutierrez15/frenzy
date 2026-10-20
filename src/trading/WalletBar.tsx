import React from 'react';
import { useWallet, connect, disconnect, isMobile, walletBrowseLinks } from './walletStore';
import { short } from '../engine';
import { inTelegram, cleanPageUrl, openExternal } from '../telegram';

/** Connect / disconnect row shared by Live swap, Promote and Admin. Never asks for a seed phrase or private key. */
export function WalletBar({ compact = false }: { compact?: boolean }) {
  const ws = useWallet();
  // never put Telegram's launch data (the user's signed session) into a link
  const here = cleanPageUrl();
  const tgApp = inTelegram();
  return (
    <div className="stack gap-xs">
      <div className="row gap-s wrap">
        {ws.conn ? (
          <>
            {ws.conn.wallet.icon ? <img src={ws.conn.wallet.icon} alt="" width={18} height={18} className="wallet-ico" /> : null}
            <span className="tag tag-plain">{ws.conn.wallet.name}</span>
            <span className="num small" title={ws.conn.account.address}>{short(ws.conn.account.address)}</span>
            <button className="link small" onClick={() => disconnect()}>Disconnect</button>
          </>
        ) : ws.wallets.length ? ws.wallets.map((w) => (
          <button key={w.name} className="chip-btn" disabled={!!ws.connecting} onClick={() => connect(w)}>
            {w.icon ? <img src={w.icon} alt="" width={16} height={16} className="wallet-ico" /> : null}
            {ws.connecting === w.name ? 'Approve in wallet…' : `Connect ${w.name}`}
          </button>
        )) : tgApp ? (
          <span className="stack gap-xs">
            <span className="muted small">Wallets can’t connect inside Telegram. Open BAGZ in your wallet app, or in a browser that has your wallet extension:</span>
            <span className="row gap-s wrap">
              {walletBrowseLinks(here).map((l) => <button key={l.name} className="chip-btn" onClick={() => openExternal(l.url)}>Open in {l.name}</button>)}
              <button className="chip-btn" onClick={() => openExternal(here)}>Open in browser</button>
            </span>
            <span className="muted small">Paper trading, charts and Gem Radar work right here.</span>
          </span>
        ) : isMobile() ? (
          <span className="stack gap-xs">
            <span className="muted small">On a phone, open BAGZ inside your wallet app’s browser to connect:</span>
            <span className="row gap-s wrap">
              {walletBrowseLinks(here).map((l) => <a key={l.name} className="chip-btn" href={l.url}>Open in {l.name}</a>)}
            </span>
            <span className="muted small">Backpack: open the Backpack app, go to its browser and visit this page.</span>
          </span>
        ) : <span className="muted small">No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.</span>}
      </div>
      {ws.error && <p className="small warn">{ws.error}</p>}
      {!compact && <p className="muted small">BAGZ never asks for a seed phrase or private key. Your wallet signs inside its own app.</p>}
    </div>
  );
}
