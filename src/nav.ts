import { createContext, useContext } from 'react';
import type { Side } from './types';
import type { CardSpec } from './card/CardSheet';

export type Tab = 'home' | 'feed' | 'radar' | 'cards' | 'wallet' | 'leaders' | 'ranks' | 'chats' | 'me' | 'promote' | 'admin' | 'vault';
export interface Route { tab: Tab; coin?: string; trader?: string; user?: string; chat?: string; section?: 'chats' | 'friends' }
export interface TradeIntent { coinId: string; side: Side; usd?: number; via?: string }

export interface Nav {
  route: Route;
  go: (tab: Tab, opts?: { section?: 'chats' | 'friends' }) => void;
  /** a BAGZ user's public profile */
  openUser: (username: string) => void;
  openChat: (id: string) => void;
  openCoin: (id: string) => void;
  openTrader: (id: string) => void;
  back: () => void;
  trade: (t: TradeIntent) => void;
  /** open a trading card: the paper wallet (default), an open position, or a closed trade */
  share: (card?: CardSpec) => void;
  toast: (tone: 'up' | 'down' | 'info' | 'gem', title: string, body?: string) => void;
}

export const NavCtx = createContext<Nav>(null as any);
export const useNav = () => useContext(NavCtx);
