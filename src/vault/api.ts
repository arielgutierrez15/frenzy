/** Client for the Vault API: BAGZ Coins, daily challenges, limited cards. */
import { apiCall } from '../trading/api';
import { getSession } from '../social/session';

export interface Challenge { id: string; title: string; reward: number; goal: number; progress: number; claimed: boolean }
export interface Owned { card: string; serial: number; t: number }
export interface VaultState {
  balance: number;
  welcome: number | null;
  day: string;
  resetsAt: number;
  challenges: Challenge[];
  supply: number;
  minted: Record<string, number>;
  mine: Owned[];
  realMoney: boolean;
}

const tok = () => getSession().token || undefined;
export const getVault = () => apiCall<VaultState>('/vault', { token: tok() });
export const claimReward = (id: string) => apiCall<VaultState>('/vault/claim', { body: { id }, token: tok() });
export const buyCard = (card: string) => apiCall<VaultState & { bought: Owned }>('/vault/buy', { body: { card, pay: 'coins' }, token: tok() });
