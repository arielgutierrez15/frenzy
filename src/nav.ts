import { createContext, useContext } from 'react';
import type { Side } from './types';
import type { CardSpec } from './card/CardSheet';

export type Tab = 'home' | 'feed' | 'radar' | 'wallet' | 'leaders' | 'promote' | 'admin';
export interface Route { tab: Tab; coin?: string; trader?: string }
export interface TradeIntent { coinId: string; side: Side; usd?: number; via?: string }

export interface Nav {
  route: Route;
  go: (tab: Tab) => void;
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
